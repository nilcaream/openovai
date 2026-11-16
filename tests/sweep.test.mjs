import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FRESH, inUse, record, recordFile, sweep } from "../lib/sweep.mjs";
import { remove, scratch } from "./helpers.mjs";

// A sweep run two hours from now, when every entry the suite lays out is old enough to go.
const later = Date.now() + 2 * FRESH;

const base = scratch("sweep");
const data = path.join(base, "data", "openovai");
const env = { XDG_DATA_HOME: path.join(base, "data") };

// An instance at base/NAME pinning node and claude in its lib/RUNTIME.
function instance(name, node, claude) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "openovai.json"), "{}\n");
  fs.writeFileSync(path.join(root, "lib", "RUNTIME"), `# notes\nnode ${node}\nclaude ${claude}\n`);
  return root;
}

// The entries a data directory holds, as `kind/name`, laid out as runtime.sh and voice.mjs do.
function entries(...names) {
  for (const name of names) fs.mkdirSync(path.join(data, name, "bin"), { recursive: true });
}

function left() {
  return ["claude", "node", "voice"].flatMap((kind) => fs.readdirSync(path.join(data, kind)).map((name) => `${kind}/${name}`)).sort();
}

// A process as lib/processes.mjs lists it: on Linux with its arguments, on a Mac with the line only.
function linux(...args) {
  return { pid: 1, environment: () => new Map(), arguments: () => args, command: () => args.join(" ") };
}
function mac(line) {
  return { pid: 1, environment: () => new Map(), arguments: () => null, command: () => line };
}

beforeEach(() => {
  remove(base);
  entries("claude/2.1.300", "claude/2.1.323", "claude/2.1.329", "node/24.20.0", "node/24.21.0", "voice/faster-whisper-old", "voice/faster-whisper-new", "voice/faster-whisper-new.part-77");
  fs.writeFileSync(path.join(data, "voice", "install.log"), "");
});
afterEach(() => remove(base));

describe("old runtimes", () => {
  it("removes every directory no instance and no process uses, and keeps the instance's own, a part install and the files", async () => {
    const own = instance("own", "24.21.0", "2.1.329");
    const removed = await sweep(own, { voice: "faster-whisper-new" }, { env, listed: [], now: later });
    assert.deepEqual(left(), ["claude/2.1.329", "node/24.21.0", "voice/faster-whisper-new", "voice/faster-whisper-new.part-77", "voice/install.log"]);
    assert.deepEqual(
      removed.map(({ kind, name }) => `${kind}/${name}`),
      ["claude/2.1.300", "claude/2.1.323", "node/24.20.0", "voice/faster-whisper-old"],
    );
    assert.deepEqual(fs.readdirSync(path.join(data, "tmp")), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(recordFile(own, env), "utf8")), { root: own, voice: "faster-whisper-new" });
  });

  // The lab not updated yet: its record keeps what its lib/RUNTIME says now, and its voice install.
  it("keeps what another instance's record names, its pins read from its lib/RUNTIME as it stands now", async () => {
    const lab = instance("lab", "24.20.0", "2.1.300");
    record(lab, { voice: "faster-whisper-old" }, env);
    fs.writeFileSync(path.join(lab, "lib", "RUNTIME"), "node 24.20.0\nclaude 2.1.323\n");
    await sweep(instance("own", "24.21.0", "2.1.329"), { voice: "faster-whisper-new" }, { env, listed: [], now: later });
    assert.deepEqual(left(), ["claude/2.1.323", "claude/2.1.329", "node/24.20.0", "node/24.21.0", "voice/faster-whisper-new", "voice/faster-whisper-new.part-77", "voice/faster-whisper-old", "voice/install.log"]);
  });

  it("drops the record of an instance that is gone, and what only it used", async () => {
    const gone = instance("gone", "24.20.0", "2.1.300");
    record(gone, { voice: "faster-whisper-old" }, env);
    fs.rmSync(gone, { recursive: true });
    await sweep(instance("own", "24.21.0", "2.1.329"), { voice: "faster-whisper-new" }, { env, listed: [], now: later });
    assert.ok(!fs.existsSync(recordFile(gone, env)));
    assert.ok(!left().includes("claude/2.1.300") && !left().includes("voice/faster-whisper-old"));
  });

  // A session still on the version before an update; voice input's speech process; and a server of
  // an instance from before records, on a Mac and on Linux, which keeps its lib/RUNTIME's pins.
  it("keeps what a running process names, and the pins of the instance a process was started on with --root", async () => {
    const old = instance("old", "24.20.0", "2.1.300");
    const listed = [
      linux(path.join(data, "claude", "2.1.323", "bin", "claude"), "--print"),
      mac(`${path.join(data, "voice", "faster-whisper-old", "python", "bin", "python3")} -I stt.py`),
      linux("node", path.join(old, "lib", "serve.mjs"), "--root", old),
    ];
    await sweep(instance("own", "24.21.0", "2.1.329"), { voice: "faster-whisper-new" }, { env, listed, now: later });
    assert.deepEqual(left(), ["claude/2.1.300", "claude/2.1.323", "claude/2.1.329", "node/24.20.0", "node/24.21.0", "voice/faster-whisper-new", "voice/faster-whisper-new.part-77", "voice/faster-whisper-old", "voice/install.log"]);
    assert.deepEqual([...inUse(env, [mac(`/x/node ${path.join(old, "lib", "ovai.mjs")} --root ${old} status`)]).claude].sort(), ["2.1.300", "2.1.329"]);
  });

  // A long run's sh wrapper: the node it reports the end with sits in quotes inside its script.
  it("keeps what a command line names inside an argument, quoted in an sh -c script", async () => {
    const node = path.join(data, "node", "24.20.0", "bin", "node");
    const listed = [linux("sh", "-c", `npm test; '${node}' '/x/lib/run-ended.mjs' "$?"`, "wrapper")];
    await sweep(instance("own", "24.21.0", "2.1.329"), { voice: "faster-whisper-new" }, { env, listed, now: later });
    assert.ok(left().includes("node/24.20.0"), left().join(" "));
    assert.ok(!left().includes("claude/2.1.300"));
  });

  // An `ovai update` fetches what its new lib/RUNTIME pins before that file is in place.
  it("keeps every entry put in place within the hour, by the newer of its mtime and ctime", async () => {
    const own = instance("own", "24.21.0", "2.1.329");
    // What tar leaves an unpacked Node.js: the archive's mtime, while the ctime is the fetch's.
    const months = new Date(Date.now() - 90 * 24 * 3_600_000);
    fs.utimesSync(path.join(data, "node", "24.20.0"), months, months);
    assert.deepEqual(await sweep(own, { voice: "faster-whisper-new" }, { env, listed: [] }), []);
    assert.deepEqual(await sweep(own, { voice: "faster-whisper-new" }, { env, listed: [], now: Date.now() + FRESH - 60_000 }), []);
    assert.equal((await sweep(own, { voice: "faster-whisper-new" }, { env, listed: [], now: later })).length, 4);
  });

  it("passes over another user's process, whose environment cannot be read", async () => {
    const theirs = { ...linux(path.join(data, "claude", "2.1.323", "bin", "claude")), environment: () => null };
    await sweep(instance("own", "24.21.0", "2.1.329"), { voice: "faster-whisper-new" }, { env, listed: [theirs], now: later });
    assert.ok(!left().includes("claude/2.1.323"));
  });

  it("removes nothing when an instance's lib/RUNTIME cannot be read", async () => {
    const broken = instance("broken", "24.20.0", "2.1.300");
    record(broken, { voice: "" }, env);
    fs.writeFileSync(path.join(broken, "lib", "RUNTIME"), "node 24\n");
    const before = left();
    await assert.rejects(sweep(instance("own", "24.21.0", "2.1.329"), { voice: "faster-whisper-new" }, { env, listed: [], now: later }), /RUNTIME/);
    assert.deepEqual(left(), before);
  });
});
