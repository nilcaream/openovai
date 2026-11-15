// Voice input (lib/chat/voice.mjs): the glossary Whisper is given, the install with its pins and
// checksums, the state the page draws its button from, and the speech process. Nothing here
// installs anything or reaches the network: the installer's Python runs, its probe and its fetch
// are handed in, and the speech process is a stand-in.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";

import { subscribe } from "../lib/chat/events.mjs";
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

describe("the glossary", () => {
  it("names the team and the projects first, then ovai's own words, each once", () => {
    assert.equal(voice.glossary(["Mira", "Bobby", "Lucy", "", "openovai", "Bobby"]), `Glossary: Mira, Bobby, Lucy, openovai, ${voice.COMMON_WORDS.join(", ")}.`);
  });

  it("stops at sixty words, so a crowded instance cannot crowd out what Whisper hears", () => {
    const names = Array.from({ length: 80 }, (_, at) => `Name${at}`);
    assert.equal(voice.glossary(names).split(", ").length, 60);
  });
});

describe("the pins", () => {
  it("names every package at one exact version, and leaves the voice-activity filter's onnxruntime out", () => {
    const lines = fs.readFileSync(voice.REQUIREMENTS, "utf8").split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    assert.ok(lines.length >= 15, lines.join("\n"));
    for (const line of lines) assert.match(line, /^[a-z][a-z0-9-]*==\d[\w.]*$/, line);
    assert.ok(lines.includes("faster-whisper==1.2.1"));
    assert.ok(!lines.some((line) => line.startsWith("onnxruntime")));
  });

  it("pins the model to one revision with a sha256 for every file, and keys the install by both", () => {
    assert.match(voice.MODEL.revision, /^[0-9a-f]{40}$/);
    for (const sum of Object.values(voice.MODEL.files)) assert.match(sum, /^[0-9a-f]{64}$/);
    assert.ok(voice.KEY.endsWith(voice.MODEL.revision.slice(0, 8)));
    assert.equal(voice.home(env), path.join(data, "openovai", "voice", voice.KEY));
  });

  it("knows Whisper's languages, English among them", () => {
    assert.equal(voice.LANGUAGES.length, 100);
    for (const code of ["en", "de", "pl", "ja", "yue"]) assert.ok(voice.LANGUAGES.includes(code), code);
  });
});

describe("the install", () => {
  it("takes the first Python from 3.12 to 3.14 on the PATH, newest first", async () => {
    const versions = { "python3.14": null, "python3.13": 313, "python3.12": 312, python3: 314 };
    assert.deepEqual(await voice.findPython(async (command) => versions[command]), { command: "python3.13", version: 313 });
    assert.equal(await voice.findPython(async (command) => (command === "python3" ? 311 : null)), null, "3.11 is below the pinned wheels");
    assert.equal(await voice.findPython(async () => 315), null, "3.15 is past them");
  });

  it("runs a Python by name from the PATH, or the one in an install's environment", () => {
    assert.equal(voice.pythonCommand("python3.13"), "python3.13");
    assert.equal(voice.pythonCommand("/x/voice/k"), "/x/voice/k/venv/bin/python");
  });

  it("makes the environment, installs the pins as wheels with nothing resolved, fetches the pinned model, and marks it installed last", async () => {
    const runs = [];
    const run = async (where, args) => {
      runs.push([where, ...args]);
      if (args.includes("venv")) fs.mkdirSync(args.at(-1), { recursive: true });
    };
    const files = Object.fromEntries(Object.keys(voice.MODEL.files).map((name) => [name, `the ${name}`]));
    const sums = Object.fromEntries(Object.keys(files).map((name) => [name, sha(files[name])]));
    const { get, asked } = served((name) => files[name]);
    const said = [];
    await voice.installEngine({ env, run, probe: async (command) => (command === "python3.12" ? 312 : null), get, files: sums, at: (what) => said.push(what) });
    const part = runs[0].at(-1).replace(/\/venv$/, "");
    assert.deepEqual(runs[0], ["python3.12", "-I", "-m", "venv", path.join(part, "venv")]);
    assert.deepEqual(runs[1], [
      part, "-I", "-m", "pip", "install", "--isolated", "--disable-pip-version-check", "--no-input", "--require-virtualenv",
      "--index-url", "https://pypi.org/simple/", "--no-deps", "--only-binary=:all:", "-r", voice.REQUIREMENTS,
    ]);
    assert.deepEqual(asked, Object.keys(files).map((name) => `https://huggingface.co/${voice.MODEL.repo}/resolve/${voice.MODEL.revision}/${name}`));
    assert.equal(voice.isInstalled(env), true);
    assert.equal(fs.readFileSync(path.join(voice.home(env), "model", "model.bin"), "utf8"), "the model.bin");
    assert.equal(fs.existsSync(part), false, "the part was renamed into place");
    assert.ok(said.includes("downloading the model: 100% of 1.6 GB"), said.join("\n"));
  });

  it("keeps nothing of a model file whose sha256 is not the pinned one, and says so", async () => {
    const into = path.join(data, "into");
    fs.mkdirSync(into, { recursive: true });
    const { get } = served(() => "not the model");
    await assert.rejects(voice.fetchChecked({ name: "model.bin", sum: "0".repeat(64), into, get }), /^Error: model\.bin does not match its pinned sha256 \(got [0-9a-f]{64}\); the download is corrupt or not the pinned file$/);
    assert.equal(fs.existsSync(path.join(into, "model.bin")), false);
  });

  it("refuses with no Python it can use, and on a failed step leaves no part behind and names the log", async () => {
    await assert.rejects(voice.installEngine({ env, probe: async () => null }), /needs Python 3\.12, 3\.13 or 3\.14 on the PATH/);
    const run = async () => {
      throw new Error("pip ended with 1");
    };
    await assert.rejects(voice.installEngine({ env, run, probe: async () => 313 }), /^Error: pip ended with 1 \(log: .*\/voice\/install\.log\)$/);
    assert.deepEqual(fs.readdirSync(path.join(data, "openovai", "voice")), ["install.log"]);
    assert.equal(voice.isInstalled(env), false);
  });
});

describe("the state the button is drawn from", () => {
  it("is off while the setting is, installs once when it is turned on, and is ready after", async () => {
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
      assert.equal(installs, 1, "a second tick while it installs starts nothing");
      assert.deepEqual(voice.state(), { on: true, state: "installing", detail: "installing the pinned packages", language: "de" });
      fs.mkdirSync(voice.home(env), { recursive: true });
      fs.writeFileSync(path.join(voice.home(env), "installed"), "{}\n");
      finish();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(voice.state(), { on: true, state: "ready", detail: "", language: "de" });
      voice.sync({ on: false, language: "de", env, install });
      assert.equal(voice.state().state, "off");
      assert.deepEqual(heard.map((one) => one.state), ["installing", "installing", "ready", "off"]);
    } finally {
      stop();
    }
  });

  it("says why an install failed, starts no other until the button asks again, then tries again", async () => {
    let installs = 0;
    const install = async () => {
      installs += 1;
      throw new Error("no Python");
    };
    voice.sync({ on: true, language: "en", env, install });
    await new Promise((resolve) => setImmediate(resolve));
    voice.sync({ on: true, language: "en", env, install });
    assert.deepEqual(voice.state(), { on: true, state: "failed", detail: "no Python", language: "en" });
    assert.equal(installs, 1);
    voice.retry();
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
    await assert.rejects(voice.transcribe({ pcm: Buffer.alloc(4), language: "en", prompt: "", env, spawner }), /^Error: voice input is off$/);
    assert.equal(started.length, 0);
  });

  it("is started once, isolated, on the installed model, and hands it each recording with its language and glossary", async () => {
    ready();
    const seen = [];
    const { spawner, started } = standIn((asked) => {
      seen.push(asked);
      return { text: `heard ${Buffer.from(asked.pcm, "base64").length} bytes` };
    });
    assert.equal(await voice.transcribe({ pcm: Buffer.alloc(32), language: "pl", prompt: "Glossary: ovai.", env, spawner }), "heard 32 bytes");
    assert.equal(await voice.transcribe({ pcm: Buffer.alloc(8), language: "pl", prompt: "Glossary: ovai.", env, spawner }), "heard 8 bytes");
    assert.equal(started.length, 1, "kept warm between recordings");
    assert.equal(started[0].command, path.join(voice.home(env), "venv", "bin", "python"));
    assert.deepEqual(started[0].args, ["-I", voice.STT, path.join(voice.home(env), "model")]);
    assert.deepEqual(seen.map(({ language, prompt }) => [language, prompt]), [["pl", "Glossary: ovai."], ["pl", "Glossary: ovai."]]);
    assert.ok(fs.existsSync(voice.STT));
  });

  it("passes on what the process says went wrong, and starts afresh once it is gone", async () => {
    ready();
    const failing = standIn(() => ({ error: "ValueError: bad samples" }));
    await assert.rejects(voice.transcribe({ pcm: Buffer.alloc(4), language: "en", prompt: "", env, spawner: failing.spawner }), /^Error: ValueError: bad samples$/);
    failing.started[0].child.emit("exit", 1, null);
    const unloaded = standIn(() => ({ text: "x" }), { ready: { error: "no model" } });
    await assert.rejects(voice.transcribe({ pcm: Buffer.alloc(4), language: "en", prompt: "", env, spawner: unloaded.spawner }), /^Error: no model$/);
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
});
