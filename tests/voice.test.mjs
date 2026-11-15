// Voice input (lib/chat/voice.mjs): the words Whisper is given, the install with its pins and
// checksums, the state the page draws its button from, and the speech process. Nothing here
// installs anything or reaches the network: the installer's Python runs, its unpacking and its
// fetch are handed in, and the speech process is a stand-in.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";

import { subscribe } from "../lib/chat/events.mjs";
import { panelFile, readTail } from "../lib/chat/conversation.mjs";
import * as voice from "../lib/chat/voice.mjs";
import { remove, repo, scratch } from "./helpers.mjs";

const data = scratch("voice");
const env = { ...process.env, XDG_DATA_HOME: data };
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

afterEach(() => {
  voice.reset();
  remove(data);
});

// A fetch answering every model file with `body(name)`.
function served(body) {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    const name = url.split("/").at(-1);
    const bytes = Buffer.from(body(name));
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  };
  return { get, asked };
}

describe("the glossary's words", () => {
  it("takes from a text the words a general model would spell wrong, in the order they stand", () => {
    const text = [
      "Ask Theo about the Radiolarian level. The fix is in `lib/chat/voice.mjs:120` and server.mjs, see InvalidDNSError.",
      "- **Waiting** on faster-whisper, r28 and the `hotwords` flag; leaderCli, S08E01 and AWS too.",
      "Plain words, a time 12:50, 1722/1722, a hash 3e6cb46, mail ovai@example.com, I think, Mira's call, e.g. this.",
    ].join("\n");
    assert.deepEqual(voice.wordsIn(text), ["Theo", "Radiolarian", "voice.mjs", "server.mjs", "InvalidDNSError", "faster-whisper", "r28", "hotwords", "leaderCli", "S08E01", "AWS", "Mira"]);
  });

  it("puts the fixed words first, then ovai's own, the idle desks, the newest lines, the room and the status, each once", () => {
    const words = voice.wordList({
      fixed: ["Mira", "Bobby", "", "openovai"],
      idle: ["Theo", "bobby"],
      said: ["Use faster-whisper now.", "Older line about Radiolarian."],
      room: ["Paper Kite 351–360 merged"],
      status: "- Waiting for you: OE2 design",
    });
    assert.deepEqual(words, ["Mira", "Bobby", "openovai", ...voice.COMMON_WORDS, "Theo", "faster-whisper", "Radiolarian", "Kite", "OE2"]);
  });

  it("stops at three hundred words, which bounds the request and not what Whisper hears", () => {
    const fixed = Array.from({ length: 400 }, (_, at) => `Name${at}`);
    assert.equal(voice.wordList({ fixed }).length, 300);
  });

  it("reads the newest lines on the Leader's panel: the User's and the Leader's own, newest first", () => {
    const rows = [
      { from: "user", text: "u1" },
      { from: "Bobby", text: "b1" },
      { from: "Bobby", text: "to a Worker", to: "Lucy", msg: true },
      { from: "Bobby", text: "<noop/>", noop: true },
      { from: "Bobby", text: "cut short", failed: true },
      { from: "Lucy", text: "a Worker's message", to: "Bobby", msg: true },
      { from: "user", text: "u2" },
      { from: "Bobby", text: "b2" },
      { from: "user", text: "u3" },
    ];
    assert.deepEqual(voice.lastSaid(rows, "Bobby", 2), ["u3", "b2", "u2", "b1"]);
    assert.deepEqual(voice.lastSaid(rows, "Bobby"), ["u3", "b2", "u2", "b1", "u1"]);
  });
});

describe("the tail of a panel", () => {
  it("reads only the last bytes of a long panel file and gives the same last rows as the whole file", () => {
    const root = scratch("voice-panel");
    try {
      const rows = Array.from({ length: 200 }, (_, at) => ({ at: `t${at}`, from: at % 2 ? "Bobby" : "user", text: `line ${at}: “quoted”, ünïcode, {braces}\n  {` }));
      fs.mkdirSync(path.dirname(panelFile(root, "Bobby")), { recursive: true });
      fs.writeFileSync(panelFile(root, "Bobby"), `${JSON.stringify(rows, null, 2)}\n`);
      const tail = readTail(root, "Bobby", 2000);
      assert.ok(tail.length > 3 && tail.length < 200, `${tail.length} rows`);
      assert.deepEqual(tail, rows.slice(-tail.length));
      assert.deepEqual(readTail(root, "Bobby", 10_000_000), rows);
      assert.deepEqual(readTail(root, "Nobody"), []);
    } finally {
      remove(root);
    }
  });
});

describe("the pins", () => {
  it("names every package at one exact version, with the voice-activity filter's onnxruntime everywhere but an Intel Mac", () => {
    const lines = fs.readFileSync(voice.REQUIREMENTS, "utf8").split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    assert.ok(lines.length >= 15, lines.join("\n"));
    for (const line of lines.filter((line) => !line.startsWith("onnxruntime"))) assert.match(line, /^[a-z][a-z0-9-]*==\d[\w.]*$/, line);
    assert.ok(lines.includes("faster-whisper==1.2.1"));
    assert.deepEqual(lines.filter((line) => line.startsWith("onnxruntime")), ['onnxruntime==1.32.0 ; sys_platform != "darwin" or platform_machine != "x86_64"']);
  });

  it("pins the model to one revision with a sha256 for every file, and keys the install by it and by the packages' pins", () => {
    assert.match(voice.MODEL.revision, /^[0-9a-f]{40}$/);
    for (const sum of Object.values(voice.MODEL.files)) assert.match(sum, /^[0-9a-f]{64}$/);
    assert.ok(voice.KEY.endsWith(voice.MODEL.revision.slice(0, 8)));
    assert.ok(voice.KEY.startsWith(`faster-whisper-${sha(fs.readFileSync(voice.REQUIREMENTS)).slice(0, 8)}-`), voice.KEY);
    assert.equal(voice.home(env), path.join(data, "openovai", "voice", voice.KEY));
  });

  it("knows Whisper's languages, English among them", () => {
    assert.equal(voice.LANGUAGES.length, 100);
    for (const code of ["en", "de", "pl", "ja", "yue"]) assert.ok(voice.LANGUAGES.includes(code), code);
  });
});

describe("the silence gate", () => {
  // 16-bit samples at 16 kHz: `seconds` of silence with a 30 ms sine burst at `dbfs` RMS in the middle.
  function burst(dbfs, seconds = 2) {
    const pcm = Buffer.alloc(seconds * 16_000 * 2);
    const amplitude = Math.round(Math.SQRT2 * 32768 * 10 ** (dbfs / 20));
    const from = 480 * Math.floor((seconds * 16_000) / 2 / 480);
    for (let i = 0; i < 480; i += 1) pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 16_000)), (from + i) * 2);
    return pcm;
  }

  it("reads a recording's loudest 30 ms in dBFS, and digital silence as -Infinity", () => {
    assert.equal(voice.loudest(Buffer.alloc(32_000)), -Infinity);
    assert.ok(Math.abs(voice.loudest(burst(-20)) - -20) < 1, String(voice.loudest(burst(-20))));
  });

  it("heard nothing below SILENCE_DBFS, and something above it, however short", () => {
    assert.equal(voice.heardNothing(Buffer.alloc(32_000)), true, "a muted microphone");
    assert.equal(voice.heardNothing(burst(voice.SILENCE_DBFS - 3)), true);
    assert.equal(voice.heardNothing(burst(voice.SILENCE_DBFS + 3)), false);
    assert.equal(voice.heardNothing(Buffer.from([0x00, 0x40])), false, "one loud sample is a recording");
  });
});

describe("the install", () => {
  it("pins one python-build-standalone CPython per platform ovai runs on, each with a sha256, and keys the install by it", () => {
    assert.deepEqual(Object.keys(voice.PYTHON.archives), ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]);
    for (const [name, sum] of Object.values(voice.PYTHON.archives)) {
      assert.match(name, new RegExp(`^cpython-${voice.PYTHON.version.replaceAll(".", "\\.")}\\+${voice.PYTHON.release}-[a-z0-9_]+-[a-z-]+-install_only_stripped\\.tar\\.gz$`));
      assert.match(sum, /^[0-9a-f]{64}$/);
    }
    assert.ok(voice.KEY.includes(`cpython-${voice.PYTHON.version}`));
    assert.deepEqual(voice.pythonArchive("linux-x64"), {
      name: voice.PYTHON.archives["linux-x64"][0],
      sum: voice.PYTHON.archives["linux-x64"][1],
      url: `https://github.com/astral-sh/python-build-standalone/releases/download/${voice.PYTHON.release}/cpython-${voice.PYTHON.version}%2B${voice.PYTHON.release}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
    });
    assert.equal(voice.pythonArchive("win32-x64"), null);
    assert.equal(voice.pythonArchive("toString"), null);
  });

  it("runs the Python unpacked into an install or its part", () => {
    assert.equal(voice.pythonCommand("/x/voice/k"), "/x/voice/k/python/bin/python3");
  });

  it("fetches and unpacks its own Python, installs the pins into it as wheels with nothing resolved, fetches the pinned model, and marks it installed last", async () => {
    const runs = [];
    const run = async (where, args) => {
      runs.push([where, ...args]);
    };
    const unpacked = [];
    const unpack = async (archive, into) => {
      unpacked.push([archive, into, fs.readFileSync(archive, "utf8")]);
      fs.mkdirSync(path.join(into, "python", "bin"), { recursive: true });
    };
    const files = Object.fromEntries(Object.keys(voice.MODEL.files).map((name) => [name, `the ${name}`]));
    const sums = Object.fromEntries(Object.keys(files).map((name) => [name, sha(files[name])]));
    const { get, asked } = served((name) => files[name] ?? "the python");
    const python = { name: "cpython.tar.gz", sum: sha("the python"), url: "https://example.invalid/cpython.tar.gz" };
    const said = [];
    await voice.installEngine({ env, run, unpack, get, python, files: sums, at: (what) => said.push(what) });
    const part = runs[0][0];
    assert.match(part, new RegExp(`${voice.KEY}\\.part-${process.pid}$`));
    assert.deepEqual(unpacked, [[path.join(part, "cpython.tar.gz"), part, "the python"]]);
    assert.deepEqual(runs, [[
      part, "-I", "-m", "pip", "install", "--isolated", "--disable-pip-version-check", "--no-input",
      "--index-url", "https://pypi.org/simple/", "--no-deps", "--only-binary=:all:", "-r", voice.REQUIREMENTS,
    ]]);
    assert.deepEqual(asked, [python.url, ...Object.keys(files).map((name) => `https://huggingface.co/${voice.MODEL.repo}/resolve/${voice.MODEL.revision}/${name}`)]);
    assert.equal(voice.isInstalled(env), true);
    assert.equal(fs.readFileSync(path.join(voice.home(env), "model", "model.bin"), "utf8"), "the model.bin");
    assert.equal(fs.existsSync(path.join(voice.home(env), "cpython.tar.gz")), false, "the archive is not kept");
    assert.equal(fs.existsSync(part), false, "the part was renamed into place");
    // The voice pill's words, character for character.
    const small = Object.keys(files).length - 1;
    assert.deepEqual(said.slice(0, 3 + small), ["Voice 1/4: runtime...", "Voice 2/4: dependencies...", ...Array(small).fill("Voice 3/4: model files..."), "Voice 4/4: model..."]);
    assert.ok(said.slice(3 + small).every((one) => /^Voice 4\/4: model \d{1,3}%$/.test(one)) && said.at(-1) === "Voice 4/4: model 100%", said.join("\n"));
    assert.equal(voice.step(4, 42), "Voice 4/4: model 42%");
  });

  it("keeps nothing of a file whose sha256 is not the pinned one, and says so", async () => {
    const into = path.join(data, "into");
    fs.mkdirSync(into, { recursive: true });
    const { get } = served(() => "not the model");
    await assert.rejects(voice.fetchChecked({ url: voice.modelUrl("model.bin"), name: "model.bin", sum: "0".repeat(64), into, get }), /^Error: model\.bin does not match its pinned sha256 \(got [0-9a-f]{64}\); the download is corrupt or not the pinned file$/);
    assert.equal(fs.existsSync(path.join(into, "model.bin")), false);
  });

  it("unpacks a .tar.gz with the system's tar, and names the archive when it cannot", async () => {
    const from = path.join(data, "from");
    const into = path.join(data, "into");
    fs.mkdirSync(path.join(from, "python", "bin"), { recursive: true });
    fs.mkdirSync(into, { recursive: true });
    fs.writeFileSync(path.join(from, "python", "bin", "python3"), "a python");
    const archive = path.join(data, "python.tar.gz");
    assert.equal(spawnSync("tar", ["-czf", archive, "-C", from, "python"]).status, 0);
    await voice.untar(archive, into);
    assert.equal(fs.readFileSync(path.join(into, "python", "bin", "python3"), "utf8"), "a python");
    fs.writeFileSync(archive, "not an archive");
    await assert.rejects(voice.untar(archive, into), /^Error: python\.tar\.gz could not be unpacked: tar ended with \d+: /);
  });

  it("refuses on a platform with no Python build, and on a failed step leaves no part behind and names the log", async () => {
    await assert.rejects(voice.installEngine({ env, platform: "win32-x64" }), /^Error: voice input has no Python build for win32-x64; it runs on linux-x64, linux-arm64, darwin-arm64, darwin-x64$/);
    const { get } = served(() => "the python");
    const python = { name: "cpython.tar.gz", sum: sha("the python"), url: "https://example.invalid/cpython.tar.gz" };
    const run = async () => {
      throw new Error("pip ended with 1");
    };
    await assert.rejects(voice.installEngine({ env, run, unpack: async () => {}, get, python }), /^Error: pip ended with 1 \(log: .*\/voice\/install\.log\)$/);
    assert.deepEqual(fs.readdirSync(path.join(data, "openovai", "voice")), ["install.log"]);
    assert.equal(voice.isInstalled(env), false);
  });
});

describe("the state the button is drawn from", () => {
  // The setting shows the button; the User's click on it, or Tab, starts the install.
  it("is off while the setting is, uninstalled when it is turned on, installs once when asked, and is ready after", async () => {
    const heard = [];
    const stop = subscribe((event) => event.name === "voice" && heard.push(event.data));
    let finish;
    let installs = 0;
    const install = ({ at }) => {
      installs += 1;
      at("installing the pinned packages");
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    try {
      voice.sync({ on: false, language: "en", env, install });
      assert.deepEqual(voice.state(), { on: false, state: "off", detail: "", language: "en" });
      voice.sync({ on: true, language: "de", env, install });
      voice.sync({ on: true, language: "de", env, install });
      assert.equal(installs, 0, "the setting on starts no install");
      assert.deepEqual(voice.state(), { on: true, state: "uninstalled", detail: "", language: "de" });
      voice.askInstall();
      voice.sync({ on: true, language: "de", env, install });
      voice.sync({ on: true, language: "de", env, install });
      assert.equal(installs, 1, "a second tick while it installs starts nothing");
      assert.deepEqual(voice.state(), { on: true, state: "installing", detail: "installing the pinned packages", language: "de" });
      fs.mkdirSync(voice.home(env), { recursive: true });
      fs.writeFileSync(path.join(voice.home(env), "installed"), "{}\n");
      finish();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(voice.state(), { on: true, state: "ready", detail: "", language: "de" });
      voice.sync({ on: false, language: "de", env, install });
      assert.equal(voice.state().state, "off");
      assert.deepEqual(heard.map((one) => one.state), ["uninstalled", "installing", "installing", "ready", "off"]);
      assert.equal(heard[1].detail, "Voice 1/4: runtime...", "no starting text: straight to the first step");
    } finally {
      stop();
    }
  });

  it("is ready at once with an install already on this machine, asking for none", () => {
    fs.mkdirSync(voice.home(env), { recursive: true });
    fs.writeFileSync(path.join(voice.home(env), "installed"), "{}\n");
    const install = () => assert.fail("no install with one already there");
    voice.sync({ on: true, language: "en", env, install });
    assert.deepEqual(voice.state(), { on: true, state: "ready", detail: "", language: "en" });
  });

  it("forgets an install asked for once the setting is off, so turning it on again starts none", () => {
    let installs = 0;
    const install = () => {
      installs += 1;
      return new Promise(() => {});
    };
    voice.askInstall();
    voice.sync({ on: false, language: "en", env, install });
    voice.sync({ on: true, language: "en", env, install });
    assert.equal(installs, 0);
    assert.equal(voice.state().state, "uninstalled");
  });

  it("says why an install failed, starts no other until the pill asks again, then tries again", async () => {
    let installs = 0;
    const install = async () => {
      installs += 1;
      throw new Error("no Python");
    };
    voice.askInstall();
    voice.sync({ on: true, language: "en", env, install });
    await new Promise((resolve) => setImmediate(resolve));
    voice.sync({ on: true, language: "en", env, install });
    assert.deepEqual(voice.state(), { on: true, state: "failed", detail: "no Python", language: "en" });
    assert.equal(installs, 1);
    voice.askInstall();
    voice.sync({ on: true, language: "en", env, install });
    assert.equal(installs, 2);
  });
});

// A stand-in for the speech process: it says ready, then answers every request with what `answer`
// makes of it.
function standIn(answer, { ready = { ready: true } } = {}) {
  const started = [];
  const spawner = (command, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    started.push({ command, args, child });
    setImmediate(() => child.stdout.write(`${JSON.stringify(ready)}\n`));
    let buffered = "";
    child.stdin.on("data", (chunk) => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const asked = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        child.stdout.write(`${JSON.stringify(answer(asked))}\n`);
      }
    });
    return child;
  };
  return { spawner, started };
}

function ready() {
  fs.mkdirSync(voice.home(env), { recursive: true });
  fs.writeFileSync(path.join(voice.home(env), "installed"), "{}\n");
  voice.sync({ on: true, language: "en", env, install: async () => {} });
}

describe("the speech process", () => {
  it("refuses a recording while voice input is off", async () => {
    const { spawner, started } = standIn(() => ({ text: "x" }));
    await assert.rejects(voice.transcribe({ pcm: Buffer.alloc(4), language: "en", words: [], env, spawner }), /^Error: voice input is off$/);
    assert.equal(started.length, 0);
  });

  it("is started once, isolated, on the installed model, and hands it each recording with its language and glossary", async () => {
    ready();
    const seen = [];
    const { spawner, started } = standIn((asked) => {
      seen.push(asked);
      return { text: `heard ${Buffer.from(asked.pcm, "base64").length} bytes` };
    });
    assert.equal(await voice.transcribe({ pcm: Buffer.alloc(32), language: "pl", words: ["ovai"], env, spawner }), "heard 32 bytes");
    assert.equal(await voice.transcribe({ pcm: Buffer.alloc(8), language: "pl", words: ["ovai"], env, spawner }), "heard 8 bytes");
    assert.equal(started.length, 1, "kept warm between recordings");
    assert.equal(started[0].command, path.join(voice.home(env), "python", "bin", "python3"));
    assert.deepEqual(started[0].args, ["-I", voice.STT, path.join(voice.home(env), "model")]);
    assert.deepEqual(seen.map(({ language, words }) => [language, words]), [["pl", ["ovai"]], ["pl", ["ovai"]]]);
    assert.ok(fs.existsSync(voice.STT));
  });

  it("passes on what the process says went wrong, and starts afresh once it is gone", async () => {
    ready();
    const failing = standIn(() => ({ error: "ValueError: bad samples" }));
    await assert.rejects(voice.transcribe({ pcm: Buffer.alloc(4), language: "en", words: [], env, spawner: failing.spawner }), /^Error: ValueError: bad samples$/);
    failing.started[0].child.emit("exit", 1, null);
    const unloaded = standIn(() => ({ text: "x" }), { ready: { error: "no model" } });
    await assert.rejects(voice.transcribe({ pcm: Buffer.alloc(4), language: "en", words: [], env, spawner: unloaded.spawner }), /^Error: no model$/);
    assert.equal(unloaded.started.length, 1);
  });

  it("is warmed only when voice input is ready", () => {
    const { spawner, started } = standIn(() => ({ text: "x" }));
    assert.equal(voice.warm({ env, spawner }), false);
    ready();
    assert.equal(voice.warm({ env, spawner }), true);
    assert.equal(voice.warm({ env, spawner }), true);
    assert.equal(started.length, 1);
  });
});

describe("the speech script", () => {
  it("keeps the hub offline, opens no port, and parses no audio format", () => {
    const script = fs.readFileSync(path.join(repo, "lib", "voice", "stt.py"), "utf8");
    assert.match(script, /os\.environ\["HF_HUB_OFFLINE"\] = "1"\n\nimport numpy/, "set before faster_whisper is imported");
    assert.match(script, /local_files_only=True/);
    assert.doesNotMatch(script, /\bsocket\b|decode_audio|import av\b/);
  });

  it("filters out what is not speech wherever onnxruntime is installed", () => {
    const script = fs.readFileSync(path.join(repo, "lib", "voice", "stt.py"), "utf8");
    assert.match(script, /^VAD = importlib\.util\.find_spec\("onnxruntime"\) is not None$/m);
    assert.match(script, /model\.transcribe\([^\n]*, vad_filter=VAD\)/);
  });

  it("keeps as many words from the front as fit in 223 of the model's tokens, and writes the first one last", (t) => {
    const script = fs.readFileSync(path.join(repo, "lib", "voice", "stt.py"), "utf8");
    assert.match(script, /^PROMPT_TOKENS = 223$/m, "faster-whisper keeps the last max_length // 2 - 1 tokens of a prompt");
    assert.match(script, /initial_prompt=glossary\(asked\.get\("words"\) or \[\], count\)/);
    const glossary = /^def glossary\(.*?(?=\n\n)/ms.exec(script)?.[0];
    assert.ok(glossary, "stt.py has a glossary function");
    // Counted here in characters: " Glossary: A." is 13, " Glossary: B, A." 16, " Glossary: C, B, A." 19.
    const probe = `PROMPT_TOKENS = 223\n${glossary}\nprint(repr(glossary(["A", "B", "C"], len, 16)), repr(glossary(["A", "B"], len, 12)), repr(glossary([], len)))`;
    const run = spawnSync("python3", ["-I", "-c", probe], { encoding: "utf8" });
    if (run.error?.code === "ENOENT") {
      t.skip("no python3 here");
      return;
    }
    assert.equal(run.stderr, "");
    assert.equal(run.stdout.trim(), "'Glossary: B, A.' None None");
  });
});
