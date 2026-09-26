// The machine's processes, each with its environment and its command line: what lib/running.mjs
// tells this instance's processes apart by, and lib/port.mjs names a port's holder with.
//
// Linux keeps both in /proc, one file each per process, exactly as the process was started: the
// environment as NUL-separated NAME=value entries, the arguments as NUL-separated words. A Mac
// has no /proc. Its `ps` prints the same two things as one line of text: `-o command=` the
// arguments joined by spaces, and with `-E` the environment after them, joined by spaces too.
// So on a Mac the listing is taken twice, without the environment and with it, and what the
// second line has beyond the first is the environment. That is read as NAME=value entries, each
// beginning where a space is followed by a name and an `=`, so a value with a space in it — a path
// under a directory with a space — reads whole. What a Mac cannot give back is where one argument
// ends and the next begins: the arguments are one line, and are read as one.
//
// Only the person's own processes can be read either way; one that refuses is passed over, as a
// process that is not ours.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const ON_A_MAC = process.platform === "darwin";

const PROCESSES = "/proc";

// An environment entry starts at a name followed by `=`; a space before one ends the entry
// before it.
const NEXT_ENTRY = / (?=[A-Za-z_][A-Za-z0-9_]*=)/;

function environmentIn(pid) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(PROCESSES, String(pid), "environ"));
  } catch {
    // Gone since the directory was listed, not ours to read, or a zombie with nothing left to
    // read. Each of those is "not one of ours" for the purpose here.
    return null;
  }
  return entries(raw.toString("utf8").split("\0"));
}

function entries(list) {
  const found = new Map();
  for (const entry of list) {
    const at = entry.indexOf("=");
    if (at > 0) {
      found.set(entry.slice(0, at), entry.slice(at + 1));
    }
  }
  return found;
}

// The arguments a process was started with, as /proc keeps them; empty when they cannot be read —
// gone since it was found, most likely.
function argumentsIn(pid) {
  try {
    // Every argument ends in a NUL, the last one included.
    return fs.readFileSync(path.join(PROCESSES, String(pid), "cmdline")).toString("utf8").replace(/\0$/, "").split("\0");
  } catch {
    return [];
  }
}

// Every process /proc lists, the caller's own left out. Read lazily: the environment is read when
// it is asked for, and the arguments only of a process that is asked about.
function fromProc() {
  let listed;
  try {
    listed = fs.readdirSync(PROCESSES);
  } catch {
    return [];
  }
  return listed
    .filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
    .map((name) => {
      const pid = Number(name);
      return { pid, environment: () => environmentIn(pid), arguments: () => argumentsIn(pid), command: () => argumentsIn(pid).join(" ") };
    });
}

// `ps` on a Mac: `pid command` per line, for every process, as wide as it runs. Null when it could
// not be run.
function listing(withEnvironment) {
  const asked = spawnSync("ps", ["-A", "-ww", ...(withEnvironment ? ["-E"] : []), "-o", "pid=,command="], { encoding: "utf8" });
  if (asked.status !== 0 || typeof asked.stdout !== "string") {
    return null;
  }
  const lines = new Map();
  for (const line of asked.stdout.split("\n")) {
    const found = /^\s*(\d+) (.*)$/.exec(line);
    if (found !== null) {
      lines.set(Number(found[1]), found[2]);
    }
  }
  return lines;
}

// Every process `ps` lists, the caller's own left out. A process that is not in both listings, or
// whose line with its environment does not begin with its line without it, started or ended
// between the two and is passed over — each `ps` among them, since each lists itself and is gone
// before the other runs. One with nothing beyond its command has an environment nobody could read.
export function fromPs() {
  const bare = listing(false);
  const full = listing(true);
  if (bare === null || full === null) {
    return [];
  }
  const found = [];
  for (const [pid, command] of bare) {
    const line = full.get(pid);
    if (pid === process.pid || line === undefined || !line.startsWith(command)) {
      continue;
    }
    const rest = line.slice(command.length);
    const environment = rest.startsWith(" ") ? entries(rest.slice(1).split(NEXT_ENTRY)) : null;
    found.push({ pid, environment: () => environment, arguments: () => null, command: () => command });
  }
  return found;
}

// Every process on this machine, the caller's own left out, as `{ pid, environment, arguments,
// command }`: the environment a Map (null when it cannot be read), the arguments one word each
// (null on a Mac, which cannot tell them apart), the command the arguments joined by spaces.
// Each is a function, so nothing is read that is not asked for.
export function processes() {
  return ON_A_MAC ? fromPs() : fromProc();
}

// What one process is running, its arguments joined by spaces; null when it cannot be read — gone
// since it was found, most likely.
export function commandOf(pid) {
  if (!ON_A_MAC) {
    const found = argumentsIn(pid);
    return found.length === 0 ? null : found.join(" ");
  }
  return commandInPs(pid);
}

// The same, as a Mac's `ps` gives it.
export function commandInPs(pid) {
  const asked = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
  const command = asked.status === 0 && typeof asked.stdout === "string" ? asked.stdout.trim() : "";
  return command === "" ? null : command;
}
