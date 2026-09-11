// Which of this instance's sessions are running right now, asked of the machine rather than of
// the chat.
//
// The chat knows what it started, in memory, and only while it is up. That is not the question an
// update has to answer. A run that outlived a chat killed with -9 is still holding the model open,
// reparented to init; a session somebody started by hand with this instance's Claude Code home is
// nobody's child; a sign-in in progress is a Claude Code process too. All of them are running the
// code and the persona an update is about to replace, and each of them would go on running the old
// version — from memory — while the instance on disk says the new one is installed. None of them is
// in any file, so the file is not asked: the processes are.
//
// What makes a process ours is one thing, and the chat puts it there on every session it starts
// (tools/claude.mjs): CLAUDE_CONFIG_DIR, set to this instance's own Claude Code home. Another
// instance on the same machine has another home. A Claude Code the person runs in the instance's
// directory with their own config is not ours, and correctly so — it is not reading this
// instance's settings and will not be running its persona. The seat name travels beside it, when
// there is one; a sign-in has none.
//
// Read from /proc, which is where Linux keeps a process's environment and which this toolkit
// already reads for sockets (tools/port.mjs). Only the person's own processes are readable there,
// and every session of theirs is one, so a process that refuses to be read is not ours and is
// passed over rather than reported. No registry, so nothing in it can be stale: a process that
// has ended is not there to be found.

import fs from "node:fs";
import path from "node:path";

import { home } from "./claude.mjs";
import { NAME_IN_ENVIRONMENT } from "./chat/session.mjs";

const PROCESSES = "/proc";

// The variable the chat sets on every session it starts, and the one a session's own tools
// inherit — a shell a run started carries it too, and a shell a run started is that run's work
// in flight, which is the right answer.
const CONFIG_DIR = "CLAUDE_CONFIG_DIR";

function environmentOf(pid) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(PROCESSES, String(pid), "environ"));
  } catch {
    // Gone since the directory was listed, not ours to read, or a zombie with nothing left to
    // read. Each of those is "not one of ours" for the purpose here.
    return null;
  }

  const found = new Map();
  for (const entry of raw.toString("utf8").split("\0")) {
    const at = entry.indexOf("=");
    if (at > 0) {
      found.set(entry.slice(0, at), entry.slice(at + 1));
    }
  }
  return found;
}

// Every process of this instance's that is running, as `{ pid, seat }` — the seat null where the
// process carries no name, which a sign-in does not. The caller's own process is never among them:
// a command run from inside a session inherits the session's environment, and telling the person
// to kill the very command that is telling them is not an answer, where the session it runs under
// is and is listed. The root is compared as a canonical path, which is what bin/ovai hands over.
export function runningHere(root) {
  const ours = path.resolve(home(root));

  let listed;
  try {
    listed = fs.readdirSync(PROCESSES);
  } catch {
    return [];
  }

  const found = [];
  for (const name of listed) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number(name);
    if (pid === process.pid) {
      continue;
    }
    const environment = environmentOf(pid);
    if (environment === null || environment.get(CONFIG_DIR) !== ours) {
      continue;
    }
    found.push({ pid, seat: environment.get(NAME_IN_ENVIRONMENT) ?? null });
  }
  return found;
}

// The refusal, as the person reads it: one line per process saying exactly what ends it, because
// with the chat down — and it is down, or the chat's own check refused first — nobody else can.
// A run parked on a permission prompt never ends by itself.
export function describeRunning(running) {
  return [
    "a session of this instance is running — an update would replace, on disk, what it is running from memory, and it would go on running the old version:",
    ...running.map(({ pid, seat }) => `  kill ${pid}  ${seat ?? "(no seat name)"}`),
    "End them, or let them finish, and run this again.",
  ].join("\n");
}
