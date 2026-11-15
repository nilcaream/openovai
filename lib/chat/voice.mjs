// Voice input on the Leader's panel: speech turned into text on this machine, for the User to read,
// edit and send as a line of their own.
//
// Off until the User asks the Leader for it, which sets `voice.on` in openovai.json with the
// `settings` tool; `voice.language` is the Whisper language spoken, English unless set. While it is
// on and the engine is not on the machine yet, the server's tick installs it (`sync`), once, into
// the XDG data directory beside the Node and Claude Code runtimes, so every instance on the machine
// shares one copy:
// - its own Python: one pinned python-build-standalone build of CPython for this platform, kept only
//   when its sha256 is the one below, so the machine's Python, or the lack of one, never matters;
// - in that Python, exactly the packages lib/voice/requirements.txt pins, installed as wheels with
//   no dependency resolution, from PyPI only and with the user's pip configuration ignored, so no
//   package runs code while it installs;
// - the model, each file fetched from the pinned revision of its Hugging Face repository and kept
//   only when its sha256 is the one below.
// The whole lands in a directory of its own and is renamed into place when complete, with the
// `installed` file written last, so a half install is never taken for one.
//
// Speech is turned into text by one Python process, lib/voice/stt.py, started on the first use and
// stopped after IDLE_STOP of none. The page sends it the samples it recorded, decoded by the browser
// to 16 kHz mono, which go to the process over a pipe and nowhere else: nothing is written to disk,
// no port is opened, and the process keeps the network off. Turning voice off stops the process and
// leaves the install where it is, so turning it on again is instant; the guide says where it is.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { dataDirectory } from "../runtime.mjs";
import { publish } from "./events.mjs";
import { log } from "./log.mjs";

const PAYLOAD = path.join(import.meta.dirname, "..", "voice");
export const REQUIREMENTS = path.join(PAYLOAD, "requirements.txt");
export const STT = path.join(PAYLOAD, "stt.py");

// The model: Whisper large-v3-turbo converted for faster-whisper, the conversion faster-whisper
// itself names for "turbo", at one revision, every file with its sha256.
export const MODEL = Object.freeze({
  repo: "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
  revision: "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
  files: Object.freeze({
    "config.json": "b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e",
    "preprocessor_config.json": "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
    "tokenizer.json": "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd",
    "vocabulary.json": "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1",
    "model.bin": "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da",
  }),
  size: "1.6 GB",
});

// The Python: CPython from python-build-standalone (github.com/astral-sh/python-build-standalone),
// one release, the stripped install-only archive per platform ovai runs on, with the sha256 its
// release's SHA256SUMS gives. The archive unpacks to `python/`, which runs from wherever it lands.
export const PYTHON = Object.freeze({
  version: "3.13.18",
  release: "20261110",
  archives: Object.freeze({
    "linux-x64": ["cpython-3.13.18+20261110-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz", "f2d2199eb25880e07863b391cf7124e7ffa1338b0d65600dfcec117c4223a7fb"],
    "linux-arm64": ["cpython-3.13.18+20261110-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz", "55c00325f7c1fddf325dfc621aabdfbbac4dc54adda224af88ec411dc12db239"],
    "darwin-arm64": ["cpython-3.13.18+20261110-aarch64-apple-darwin-install_only_stripped.tar.gz", "7a2384641584ab9984221fcb0fc9265df465922af71be71410529e2a9c3f0540"],
    "darwin-x64": ["cpython-3.13.18+20261110-x86_64-apple-darwin-install_only_stripped.tar.gz", "d27d59a722db9f69926eb6d9564071247221f45a04da920ea7f3001c97e32f9b"],
  }),
});

// One directory per set of pins, Python and model: a release that moves any pin installs anew
// beside it. The packages are named by the first 8 hex of requirements.txt's sha256.
export const PINS = crypto.createHash("sha256").update(fs.readFileSync(REQUIREMENTS)).digest("hex").slice(0, 8);
export const KEY = `faster-whisper-${PINS}-cpython-${PYTHON.version}-large-v3-turbo-${MODEL.revision.slice(0, 8)}`;

// The language codes Whisper knows (faster_whisper/tokenizer.py, _LANGUAGE_CODES), for the setting.
export const LANGUAGES = Object.freeze(
  "af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha haw he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo zh yue".split(" "),
);

// The longest recording taken, in seconds, and what it is in bytes of 16-bit samples at 16 kHz.
export const LONGEST_SECONDS = 120;
export const LONGEST_BYTES = LONGEST_SECONDS * 16_000 * 2;

// A recording whose loudest 30 ms is quieter than this, as RMS in dBFS, is not sent to Whisper: it
// heard nothing. Whisper turns silence into confident text ("Closed Captioning by …", "Thank you."),
// and large-v3-turbo's no-speech probability is 0 on silence as on speech, so this is the one check.
// Measured: a muted microphone is digital zero; speech at -50 dBFS RMS, which Whisper still
// transcribes word for word, has its loudest 30 ms at -41.5; ordinary speech at -8.
export const SILENCE_DBFS = -50;
const WINDOW = 480;

// The loudest 30 ms of 16-bit samples at 16 kHz, as RMS in dBFS; -Infinity for digital silence.
export function loudest(pcm) {
  let most = 0;
  for (let start = 0; start + 1 < pcm.length; start += WINDOW * 2) {
    const end = Math.min(pcm.length - 1, start + WINDOW * 2);
    let sum = 0;
    let count = 0;
    for (let at = start; at < end; at += 2) {
      const sample = pcm.readInt16LE(at) / 32768;
      sum += sample * sample;
      count += 1;
    }
    most = Math.max(most, sum / count);
  }
  return 10 * Math.log10(most);
}

export function heardNothing(pcm) {
  return loudest(pcm) < SILENCE_DBFS;
}

// How long the speech process is kept after its last answer, in milliseconds.
export const IDLE_STOP = 10 * 60_000;

// Words Whisper is told to expect, whatever the language: the team's names and the ones ovai and its
// work use, which a general model hears as something else. A glossary in the prompt brings most of
// them back.
export const COMMON_WORDS = Object.freeze(["ovai", "Leader", "Worker", "desk", "worktree", "knowledge", "commit", "merge", "rebase", "push", "npm test", "Claude", "Opus", "Sonnet", "Haiku"]);

// The words of one recording's glossary, the ones that matter most first: the fixed words (the
// User, the Leader, the seats running, the projects, ovai's own words, then the desks not running),
// then the words of the newest lines said on the Leader's panel, of the room's desk titles and of
// the Leader's status. Each word once; stt.py keeps as many from the front as fit in Whisper's
// prompt, counted in the model's own tokens, so on a crowded instance the idle desks' names are the
// first fixed words to go. The cap here only bounds the request.
const MOST_WORDS = 300;

export function wordList({ fixed = [], idle = [], said = [], room = [], status = "" }) {
  const seen = new Set();
  const words = [];
  for (const word of [...fixed, ...COMMON_WORDS, ...idle, ...said.flatMap(wordsIn), ...room.flatMap(wordsIn), ...wordsIn(status)]) {
    const key = typeof word === "string" ? word.trim().toLowerCase() : "";
    if (key !== "" && !seen.has(key) && words.length < MOST_WORDS) {
      seen.add(key);
      words.push(word.trim());
    }
  }
  return words;
}

// The newest lines said on the Leader's panel, newest first: the User's last few and the Leader's
// last few of its own text (not a message to a Worker, a <noop/> turn or a failed one).
export const SAID_EACH = 4;

export function lastSaid(rows, leader, each = SAID_EACH) {
  const user = [];
  const own = [];
  for (let at = rows.length - 1; at >= 0 && (user.length < each || own.length < each); at -= 1) {
    const row = rows[at];
    if (typeof row?.text !== "string") continue;
    if (row.from === "user" && user.length < each) user.push(at);
    else if (row.from === leader && row.to === undefined && !row.noop && !row.failed && own.length < each) own.push(at);
  }
  return [...user, ...own].sort((a, b) => b - a).map((at) => rows[at].text);
}

// The words of a text a general model would spell wrong, in the order they stand: a word with a
// digit, a hyphen, a dot or an underscore inside it, with a capital after its first letter, in
// backticks, or capitalised in the middle of a sentence. A path counts as its parts, each judged as
// a plain word (so `desks/` and `lib/` give nothing). Never a word with no letter in it (a number,
// a time), an address, a short hex hash, or one longer than a word is.
const STOP = new Set(["i", "ok", "e.g", "i.e", "etc", "vs"]);

export function wordsIn(text) {
  const words = [];
  for (const line of String(text ?? "").split("\n")) {
    let sentenceStart = true;
    for (const raw of line.split(/\s+/)) {
      if (!/[\p{L}\p{N}]/u.test(raw)) continue;
      const parts = raw.replace(/:\d+(-\d+)?\W*$/, "").split("/");
      const inCode = raw.includes("`") && parts.length === 1;
      for (const part of parts) {
        const word = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['’]s$/u, "");
        if (picked(word, inCode, sentenceStart)) words.push(word);
      }
      sentenceStart = /[.!?:]["'”)*_`]*$/.test(raw);
    }
  }
  return words;
}

function picked(word, inCode, sentenceStart) {
  if (word.length < 2 || word.length > 32 || !/\p{L}/u.test(word) || word.includes("@") || STOP.has(word.toLowerCase()) || /^I['’]/u.test(word)) return false;
  if (/^[0-9a-f]{7,}$/.test(word)) return false;
  if (inCode || /[\p{N}_.-]/u.test(word) || /\p{Ll}\p{Lu}/u.test(word) || /^\p{Lu}{2,}/u.test(word)) return true;
  return /^\p{Lu}/u.test(word) && !sentenceStart;
}

export function home(env = process.env) {
  return path.join(dataDirectory(env), "voice", KEY);
}

export function isInstalled(env = process.env) {
  return fs.existsSync(path.join(home(env), "installed"));
}

// ------------------------------------------------------------------------------------------ state

// What the page is told: whether it is on, and then installing (with what it is at), ready, or
// failed (with why, and that a click on the button tries again).
let shown = { on: false, state: "off", detail: "", language: "en" };
let installing = null;
let failed = null;
let worker = null;
// What the last tick asked for, so an install that ends between ticks is shown as it now stands.
let wanted = { on: false, language: "en" };

export function reset() {
  stopWorker();
  shown = { on: false, state: "off", detail: "", language: "en" };
  installing = null;
  failed = null;
  wanted = { on: false, language: "en" };
}

export function state() {
  return shown;
}

function show(next) {
  if (JSON.stringify(next) !== JSON.stringify(shown)) {
    shown = next;
    publish("voice", next);
  }
}

// Called on every tick with the instance's settings. `install` is the installer, which the suites
// hand in.
export function sync({ on, language, env = process.env, install = installEngine }) {
  wanted = { on, language };
  if (!on) {
    stopWorker();
    show({ on: false, state: "off", detail: "", language });
    return;
  }
  if (installing !== null) {
    show({ on: true, state: "installing", detail: installing, language });
    return;
  }
  if (isInstalled(env)) {
    failed = null;
    show({ on: true, state: "ready", detail: "", language });
    return;
  }
  if (failed !== null) {
    show({ on: true, state: "failed", detail: failed, language });
    return;
  }
  installing = "starting";
  show({ on: true, state: "installing", detail: installing, language });
  install({
    env,
    at: (what) => {
      installing = what;
      if (wanted.on) show({ ...shown, detail: what });
    },
  })
    .then(() => {
      installing = null;
      log("voice", null, null, `installed in ${home(env)}`);
      show(wanted.on ? { on: true, state: "ready", detail: "", language: wanted.language } : shown);
    })
    .catch((error) => {
      installing = null;
      failed = error.message;
      log("voice", null, null, `install failed: ${error.message}`);
      if (wanted.on) show({ on: true, state: "failed", detail: failed, language: wanted.language });
    });
}

// The button's click on a failed install: the next tick tries again.
export function retry() {
  failed = null;
}

// ---------------------------------------------------------------------------------------- install

// The Python voice input runs, for pip and for the speech process: the one unpacked into `where`,
// an install's directory or the part it is built in.
export function pythonCommand(where) {
  return path.join(where, "python", "bin", "python3");
}

// Runs a Python to its end, its output appended to the install log; refused with the log's last
// lines when it ends with anything but 0.
export function runLogged(logFile) {
  return (where, args) =>
    new Promise((resolve, reject) => {
      const command = pythonCommand(where);
      fs.appendFileSync(logFile, `$ ${[command, ...args].join(" ")}\n`);
      const out = fs.openSync(logFile, "a");
      let open = true;
      const close = () => {
        if (open) fs.closeSync(out);
        open = false;
      };
      let child;
      try {
        child = spawn(pythonCommand(where), args, { stdio: ["ignore", out, out] });
      } catch (error) {
        close();
        reject(error);
        return;
      }
      child.on("error", (error) => {
        close();
        reject(error);
      });
      child.on("exit", (code) => {
        close();
        if (code === 0) resolve();
        else reject(new Error(`${path.basename(command)} ended with ${code}: ${lastLines(logFile)}`));
      });
    });
}

function lastLines(file, count = 3) {
  return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-count).join(" / ");
}

// The Python archive for a platform, as `{ name, sum, url }`; null for a platform it has none for.
export function pythonArchive(platform) {
  const archive = Object.hasOwn(PYTHON.archives, platform) ? PYTHON.archives[platform] : null;
  if (archive === null) return null;
  const [name, sum] = archive;
  return { name, sum, url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON.release}/${encodeURIComponent(name)}` };
}

export function modelUrl(name) {
  return `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${name}`;
}

// Unpacks a .tar.gz into a directory with the system's tar, as lib/runtime.sh does Node's.
export function untar(archive, into) {
  return new Promise((resolve, reject) => {
    let said = "";
    const child = spawn("tar", ["-xzf", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => {
      said += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(archive)} could not be unpacked: tar ended with ${code}: ${said.trim()}`))));
  });
}

// One pinned file, saved in `into` as `name` and kept only when its sha256 matches. `get` is fetch.
export async function fetchChecked({ url, name, sum, into, get = fetch, at = () => {} }) {
  const answered = await get(url, { redirect: "follow" });
  if (!answered.ok || answered.body === null) {
    throw new Error(`${name} could not be downloaded from ${url}: HTTP ${answered.status}`);
  }
  const total = Number(answered.headers.get("content-length")) || 0;
  const target = path.join(into, name);
  const out = fs.createWriteStream(target);
  const hash = crypto.createHash("sha256");
  let got = 0;
  let percent = -1;
  for await (const chunk of answered.body) {
    hash.update(chunk);
    got += chunk.length;
    if (!out.write(chunk)) await once(out, "drain");
    const now = total > 0 ? Math.floor((got * 100) / total) : -1;
    if (now !== percent) {
      percent = now;
      at(percent);
    }
  }
  out.end();
  await finished(out);
  const found = hash.digest("hex");
  if (found !== sum) {
    fs.rmSync(target, { force: true });
    throw new Error(`${name} does not match its pinned sha256 (got ${found}); the download is corrupt or not the pinned file`);
  }
}

// The whole install. `at` is told what it is at, in words for the button; `platform`, `run`,
// `unpack`, `get`, `python` and `files` are the suites' to replace.
export async function installEngine({
  env = process.env,
  at = () => {},
  platform = `${process.platform}-${process.arch}`,
  run,
  unpack = untar,
  get,
  python = pythonArchive(platform),
  files = MODEL.files,
} = {}) {
  if (python === null) {
    throw new Error(`voice input has no Python build for ${platform}; it runs on ${Object.keys(PYTHON.archives).join(", ")}`);
  }
  const base = path.join(dataDirectory(env), "voice");
  fs.mkdirSync(base, { recursive: true });
  const logFile = path.join(base, "install.log");
  fs.writeFileSync(logFile, `${new Date().toISOString()} installing ${KEY}\n`);
  const runs = run ?? runLogged(logFile);

  const part = `${home(env)}.part-${process.pid}`;
  fs.rmSync(part, { recursive: true, force: true });
  fs.mkdirSync(path.join(part, "model"), { recursive: true });
  try {
    at(`downloading Python ${PYTHON.version}`);
    await fetchChecked({ url: python.url, name: python.name, sum: python.sum, into: part, get });
    await unpack(path.join(part, python.name), part);
    fs.rmSync(path.join(part, python.name));
    at("installing the pinned packages (about 480 MB)");
    await runs(part, [
      "-I", "-m", "pip", "install", "--isolated", "--disable-pip-version-check", "--no-input",
      "--index-url", "https://pypi.org/simple/", "--no-deps", "--only-binary=:all:", "-r", REQUIREMENTS,
    ]);
    for (const [name, sum] of Object.entries(files)) {
      await fetchChecked({
        url: modelUrl(name),
        name,
        sum,
        into: path.join(part, "model"),
        get,
        at: (percent) => at(name === "model.bin" && percent >= 0 ? `downloading the model: ${percent}% of ${MODEL.size}` : "downloading the model"),
      });
    }
    fs.writeFileSync(path.join(part, "installed"), `${JSON.stringify({ at: new Date().toISOString(), python: PYTHON.version, key: KEY })}\n`);
    try {
      fs.renameSync(part, home(env));
    } catch (error) {
      // Another instance on this machine finished the same install first: theirs is kept.
      if (!isInstalled(env)) throw error;
      fs.rmSync(part, { recursive: true, force: true });
    }
  } catch (error) {
    fs.rmSync(part, { recursive: true, force: true });
    throw new Error(`${error.message} (log: ${logFile})`);
  }
}

// ------------------------------------------------------------------------------------ the process

// The speech process, started when there is none; `spawner` is the suites'.
function startWorker(env, spawner) {
  const where = home(env);
  const child = spawner(pythonCommand(where), ["-I", STT, path.join(where, "model")], { stdio: ["pipe", "pipe", "pipe"] });
  const own = { child, waiting: [], ready: null, timer: null, said: "" };
  own.ready = new Promise((resolve, reject) => {
    own.waiting.push({ resolve, reject });
  });
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const next = own.waiting.shift();
      if (next === undefined) continue;
      try {
        next.resolve(JSON.parse(line));
      } catch (error) {
        next.reject(new Error(`the speech process said something that is not JSON: ${line.slice(0, 200)}`));
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    own.said = `${own.said}${chunk}`.slice(-2000);
  });
  const gone = (why) => {
    for (const next of own.waiting.splice(0)) next.reject(new Error(why));
    if (worker === own) {
      clearTimeout(own.timer);
      worker = null;
    }
  };
  child.on("error", (error) => gone(`the speech process could not start: ${error.message}`));
  child.on("exit", (code, signal) => {
    const last = own.said.trim().split("\n").slice(-1)[0] ?? "";
    gone(`the speech process ended (${signal ?? code})${last === "" ? "" : `: ${last}`}`);
  });
  child.stdin.on("error", () => {});
  return own;
}

function stopWorker() {
  if (worker !== null) {
    clearTimeout(worker.timer);
    worker.child.kill();
    worker = null;
  }
}

export function stop() {
  stopWorker();
}

function idleLater(own) {
  clearTimeout(own.timer);
  own.timer = setTimeout(() => {
    if (worker === own) stopWorker();
  }, IDLE_STOP);
  own.timer.unref?.();
}

// The process started now, so the model is loaded while the User is still speaking.
export function warm({ env = process.env, spawner = spawn } = {}) {
  if (shown.state !== "ready") return false;
  if (worker === null) {
    worker = startWorker(env, spawner);
    worker.ready.catch(() => {});
    idleLater(worker);
  }
  return true;
}

// The text of one recording: `pcm` the 16-bit samples at 16 kHz, `language` a Whisper code, `words`
// the glossary's words, the ones that matter most first (wordList). Refused while voice is not ready.
export async function transcribe({ pcm, language, words, env = process.env, spawner = spawn }) {
  if (shown.state !== "ready") {
    throw new Error(shown.on ? `voice input is not ready: ${shown.state}` : "voice input is off");
  }
  warm({ env, spawner });
  const own = worker;
  const ready = await own.ready;
  if (ready.ready !== true) {
    stopWorker();
    throw new Error(ready.error ?? "the speech process did not load its model");
  }
  const answer = await new Promise((resolve, reject) => {
    own.waiting.push({ resolve, reject });
    own.child.stdin.write(`${JSON.stringify({ pcm: pcm.toString("base64"), language, words })}\n`);
  });
  idleLater(own);
  if (typeof answer.text !== "string") {
    throw new Error(answer.error ?? "the speech process gave no text");
  }
  return answer.text;
}
