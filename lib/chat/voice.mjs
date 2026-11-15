// Voice input on the Leader's panel: speech turned into text on this machine, for the User to read,
// edit and send as a line of their own.
//
// Off until the User asks the Leader for it, which sets `voice.on` in openovai.json with the
// `settings` tool; `voice.language` is the Whisper language spoken, English unless set. While it is
// on and the engine is not on the machine yet, the server's tick installs it (`sync`), once, into
// the XDG data directory beside the Node and Claude Code runtimes, so every instance on the machine
// shares one copy:
// - a Python environment holding exactly the packages lib/voice/requirements.txt pins, installed as
//   wheels with no dependency resolution, from PyPI only and with the user's pip configuration
//   ignored, so no package runs code while it installs;
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

// One directory per pinned engine and model: a release that moves either pin installs anew beside it.
export const KEY = `faster-whisper-1.2.1-large-v3-turbo-${MODEL.revision.slice(0, 8)}`;

// The Pythons the pinned wheels are built for, newest first, then whatever python3 is.
export const PYTHONS = ["python3.14", "python3.13", "python3.12", "python3"];
const PYTHON_FLOOR = 312;
const PYTHON_CEILING = 314;

// The language codes Whisper knows (faster_whisper/tokenizer.py, _LANGUAGE_CODES), for the setting.
export const LANGUAGES = Object.freeze(
  "af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha haw he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo zh yue".split(" "),
);

// The longest recording taken, in seconds, and what it is in bytes of 16-bit samples at 16 kHz.
export const LONGEST_SECONDS = 120;
export const LONGEST_BYTES = LONGEST_SECONDS * 16_000 * 2;

// How long the speech process is kept after its last answer, in milliseconds.
export const IDLE_STOP = 10 * 60_000;

// Words Whisper is told to expect, whatever the language: the team's names and the ones ovai and its
// work use, which a general model hears as something else. A glossary in the prompt costs nothing
// in time and brings most of them back.
export const COMMON_WORDS = Object.freeze(["ovai", "Leader", "Worker", "desk", "worktree", "knowledge", "commit", "merge", "rebase", "push", "npm test", "Claude", "Opus", "Sonnet", "Haiku"]);
const MOST_WORDS = 60;

export function glossary(names) {
  const words = [...new Set([...names.filter((name) => typeof name === "string" && name.trim() !== ""), ...COMMON_WORDS])].slice(0, MOST_WORDS);
  return `Glossary: ${words.join(", ")}.`;
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

// Every process voice input starts is a Python, named here: `where` is either a name from PYTHONS,
// the interpreter on the PATH that makes the environment, or a directory holding one, whose own
// `venv/bin/python` runs pip and the speech process.
export function pythonCommand(where) {
  return PYTHONS.includes(where) ? where : path.join(where, "venv", "bin", "python");
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

// The first Python on the PATH that the pinned wheels are built for, as `{ command, version }`; null
// when there is none. `probe` answers a command's version as 312 for 3.12, or null.
export async function findPython(probe = pythonVersion) {
  for (const command of PYTHONS) {
    const version = await probe(command);
    if (version !== null && version >= PYTHON_FLOOR && version <= PYTHON_CEILING) {
      return { command, version };
    }
  }
  return null;
}

function pythonVersion(command) {
  return new Promise((resolve) => {
    let said = "";
    let child;
    try {
      child = spawn(pythonCommand(command), ["-I", "-c", "import sys; print(sys.version_info[0] * 100 + sys.version_info[1])"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    child.stdout.on("data", (chunk) => {
      said += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 && /^\d+\s*$/.test(said) ? Number(said) : null));
  });
}

// One model file from the pinned revision, kept only when its sha256 matches. `get` is fetch.
export async function fetchChecked({ name, sum, into, get = fetch, at = () => {} }) {
  const url = `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${name}`;
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

// The whole install. `at` is told what it is at, in words for the button; `run`, `probe`, `get`
// and `files` are the suites' to replace.
export async function installEngine({ env = process.env, at = () => {}, run, probe, get, files = MODEL.files } = {}) {
  const base = path.join(dataDirectory(env), "voice");
  fs.mkdirSync(base, { recursive: true });
  const logFile = path.join(base, "install.log");
  fs.writeFileSync(logFile, `${new Date().toISOString()} installing ${KEY}\n`);
  const runs = run ?? runLogged(logFile);

  at("looking for Python 3.12 to 3.14");
  const python = await findPython(probe);
  if (python === null) {
    throw new Error(`voice input needs Python 3.12, 3.13 or 3.14 on the PATH, as ${PYTHONS.join(", ")}; none was found`);
  }
  const part = `${home(env)}.part-${process.pid}`;
  fs.rmSync(part, { recursive: true, force: true });
  fs.mkdirSync(path.join(part, "model"), { recursive: true });
  try {
    at("making its Python environment");
    await runs(python.command, ["-I", "-m", "venv", path.join(part, "venv")]);
    at("installing the pinned packages (about 400 MB)");
    await runs(part, [
      "-I", "-m", "pip", "install", "--isolated", "--disable-pip-version-check", "--no-input", "--require-virtualenv",
      "--index-url", "https://pypi.org/simple/", "--no-deps", "--only-binary=:all:", "-r", REQUIREMENTS,
    ]);
    for (const [name, sum] of Object.entries(files)) {
      await fetchChecked({
        name,
        sum,
        into: path.join(part, "model"),
        get,
        at: (percent) => at(name === "model.bin" && percent >= 0 ? `downloading the model: ${percent}% of ${MODEL.size}` : "downloading the model"),
      });
    }
    fs.writeFileSync(path.join(part, "installed"), `${JSON.stringify({ at: new Date().toISOString(), python: python.command, key: KEY })}\n`);
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

// The text of one recording: `pcm` the 16-bit samples at 16 kHz, `language` a Whisper code, `prompt`
// the glossary. Refused while voice is not ready.
export async function transcribe({ pcm, language, prompt, env = process.env, spawner = spawn }) {
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
    own.child.stdin.write(`${JSON.stringify({ pcm: pcm.toString("base64"), language, prompt })}\n`);
  });
  idleLater(own);
  if (typeof answer.text !== "string") {
    throw new Error(answer.error ?? "the speech process gave no text");
  }
  return answer.text;
}
