// Old runtimes, removed once no instance of this user uses them.
//
// Every instance a user has shares one data directory (lib/runtime.mjs): one directory per Claude
// Code version under claude/, per Node.js version under node/, per voice install under voice/
// (lib/chat/voice.mjs). A release that moves a pin fetches the new one beside the old, and the old
// stays: a Claude Code version is about 260 MB, a voice install about 2.1 GB. Which of them is
// still wanted is not this instance's to say alone, because the instances beside it may not be
// updated yet. So an entry stays when any of these keeps it:
//
// - an instance's record: `instances/<id>.json` in the data directory, `{ root, voice }`, written
//   by every server when it starts (`record`). The record names the instance; its node and claude
//   are read from its lib/RUNTIME as it stands now, so an instance updated and not started yet
//   keeps what it will start on, and the voice install is the one its server named. A record whose
//   root is no instance any more (no openovai.json) is an instance that was deleted, and goes;
// - a process of the user's that names the entry in its command line: a session still running the
//   Claude Code it started on, a server on its node, voice input's speech process;
// - a process of the user's started with `--root <dir>`, as bin/ovai starts every command and
//   every server: the pins in that directory's lib/RUNTIME. That is what keeps an instance that is
//   running and has written no record, one from before records were written.
//
// Everything else under the three directories is removed: a directory at a time, renamed into the
// data directory's tmp/ first, so no instance ever finds half a runtime where it looks, and deleted
// there. Files are not entries and stay (voice/install.log), and so does a voice install still
// being built (`.part-<pid>`). Whatever cannot be read — an instance's lib/RUNTIME, a record —
// stops the sweep before anything is removed: what nobody can say is unused is kept.
//
// What no record and no process names is a stopped instance from before records: what only it
// pins may go, and its next `ovai start` fetches it again (bin/ovai runs `runtime.sh ensure` first).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { processes } from "./processes.mjs";
import { dataDirectory, pins } from "./runtime.mjs";

export const KINDS = Object.freeze(["claude", "node", "voice"]);

const INSTANCES = "instances";

// Where the record of the instance at ROOT is: named by its root, so a moved instance is a new one
// and the old record goes with the root it names.
export function recordFile(root, env = process.env) {
  const id = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(dataDirectory(env), INSTANCES, `${id}.json`);
}

// Write this instance's record: its root and the voice install it uses. Written whole and renamed
// into place, so a sweep never reads half of one.
export function record(root, { voice }, env = process.env) {
  const file = recordFile(root, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}`;
  fs.writeFileSync(part, `${JSON.stringify({ root, voice })}\n`);
  fs.renameSync(part, file);
}

function isInstance(root) {
  return fs.existsSync(path.join(root, "openovai.json"));
}

function keep(kept, root) {
  const pinned = pins(root);
  kept.node.add(pinned.node);
  kept.claude.add(pinned.claude);
}

// The directory a process was started on with `--root`, or null. A Mac gives the arguments back as
// one line, where the directory is read up to the next space.
function rootOf(one) {
  const args = one.arguments();
  if (args === null) {
    return /(?:^| )--root (\S+)/.exec(one.command())?.[1] ?? null;
  }
  const at = args.indexOf("--root");
  return at === -1 || at + 1 >= args.length ? null : args[at + 1];
}

function escaped(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// What is in use, as `{ claude, node, voice }`, each a Set of entry names. `listed` is the
// machine's process table unless a check hands it another. Throws when anything that would say
// what is in use cannot be read.
export function inUse(env = process.env, listed = processes()) {
  const data = dataDirectory(env);
  const kept = { claude: new Set(), node: new Set(), voice: new Set() };

  const records = path.join(data, INSTANCES);
  let names = [];
  try {
    names = fs.readdirSync(records).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const file = path.join(records, name);
    const { root, voice } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isInstance(root)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    keep(kept, root);
    if (typeof voice === "string" && voice !== "") kept.voice.add(voice);
  }

  const named = new RegExp(`${escaped(data + path.sep)}(${KINDS.join("|")})${escaped(path.sep)}([^${escaped(path.sep)}\\s]+)`, "g");
  for (const one of listed) {
    // Only the user's own processes: another user's are not running from this data directory, and
    // their instance's files are not this user's to read.
    if (one.environment() === null) continue;
    for (const [, kind, name] of one.command().matchAll(named)) kept[kind].add(name);
    const root = rootOf(one);
    if (root !== null && isInstance(root)) keep(kept, root);
  }
  return kept;
}

// What no instance uses, as `[{ kind, name }]`.
export function unused(env = process.env, listed = processes()) {
  const kept = inUse(env, listed);
  const data = dataDirectory(env);
  const found = [];
  for (const kind of KINDS) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(data, kind), { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.includes(".part-") && !kept[kind].has(entry.name)) found.push({ kind, name: entry.name });
    }
  }
  return found;
}

// Record this instance, then remove what no instance uses; resolves to what was removed. Two
// instances sweeping at once each rename what they found; whoever comes second finds it gone.
export async function sweep(root, { voice }, { env = process.env, listed = processes() } = {}) {
  record(root, { voice }, env);
  const data = dataDirectory(env);
  const removed = [];
  for (const { kind, name } of unused(env, listed)) {
    const gone = path.join(data, "tmp", `gone-${kind}-${name}.${process.pid}`);
    fs.mkdirSync(path.dirname(gone), { recursive: true });
    try {
      fs.renameSync(path.join(data, kind, name), gone);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    await fs.promises.rm(gone, { recursive: true, force: true });
    removed.push({ kind, name });
  }
  return removed;
}
