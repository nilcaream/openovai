// Which of this instance's processes are running right now, asked of the machine rather than of
// the chat.
//
// The chat knows what it started, in memory, and only while it is up. That is not the question an
// update has to answer. A run that outlived a chat killed with -9 is still holding the model open,
// reparented to init; a session somebody started by hand with this instance's Claude Code home is
// nobody's child; a sign-in in progress is a Claude Code process too. All of them are running the
// code and the persona an update is about to replace, and each of them would go on running the superseded
// version — from memory — while the instance on disk says the new one is installed. None of them is
// in any file, so the file is not asked: the processes are.
//
// What makes a process ours is one thing, and the chat puts it there on every session it starts
// (lib/claude.mjs): CLAUDE_CONFIG_DIR, set to this instance's own Claude Code home. Another
// instance on the same machine has another home. A Claude Code the person runs in the instance's
// directory with their own config is not ours, and correctly so — it is not reading this
// instance's settings and will not be running its persona.
//
// Beside it, on a session and on everything a session starts, the seat (lib/claude.mjs): a
// browser a Worker drove, a server it left serving a preview, a shell parked on a prompt — each
// carries the name of the seat it was started under, whoever its parent is by now. Two things
// carry a seat, and they are told apart by what they run: the seat's session is the one running
// the toolkit's own Claude Code command, and anything else is a leftover — something the session
// started and did not end. A leftover is not running the code an update replaces; it is named by
// its seat so it can be ended, and it is ended by the server the moment its session is gone
// (`endLeftovers`).
//
// Read from /proc, which is where Linux keeps a process's environment and which this toolkit
// already reads for sockets (lib/port.mjs). Only the person's own processes are readable there,
// and every session of theirs is one, so a process that refuses to be read is not ours and is
// passed over rather than reported. No registry, so nothing in it can be stale: a process that
// has ended is not there to be found.

import fs from "node:fs";
import path from "node:path";

import { SEAT_IN_ENVIRONMENT, home } from "./claude.mjs";
import { dataDirectory } from "./runtime.mjs";

const PROCESSES = "/proc";

// The variable the chat sets on every session it starts, and the one a session's own tools
// inherit — a shell a run started carries it too, and a shell a run started is that run's work
// in flight, which is the right answer.
const CONFIG_DIR = "CLAUDE_CONFIG_DIR";

// How long a leftover is given to end on its own once told to, before it is taken down.
export const GRACE = 2000;

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

// The arguments a process was started with, as the machine keeps them; empty when they cannot be
// read — gone since it was found, most likely.
function argumentsOf(pid) {
  try {
    // Every argument ends in a NUL, the last one included.
    return fs.readFileSync(path.join(PROCESSES, String(pid), "cmdline")).toString("utf8").replace(/\0$/, "").split("\0");
  } catch {
    return [];
  }
}

// Whether a process is running the toolkit's own Claude Code: the one under the data directory,
// whatever version it is pinned at — a session started before an update ran is running the
// version before, and is a session all the same. It is the command itself, or the script an
// interpreter was handed, which is where a command that begins `#!/usr/bin/env` ends up.
function runsClaude(args) {
  const claude = `${path.join(dataDirectory(), "claude")}${path.sep}`;
  return args.slice(0, 2).some((one) => one.startsWith(claude) && one.endsWith(`${path.sep}bin${path.sep}claude`));
}

// Every process of this instance's that is running, as `{ pid, seat, session }`: `seat` the seat
// it carries, or null; `session` whether it is a Claude Code process — a seat's session, or a run
// with this instance's home and no seat — rather than a leftover of its seat. The caller's own
// process is never among them: a command run from inside a session inherits the session's
// environment, and telling the person to kill the very command that is telling them is not an
// answer, where the session it runs under is and is listed. The root is compared as a canonical
// path, which is what bin/ovai hands over.
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
    const seat = environment.get(SEAT_IN_ENVIRONMENT) ?? null;
    found.push({ pid, seat, session: seat === null || runsClaude(argumentsOf(pid)) });
  }
  return found;
}

// What a process is running, as the machine keeps it: its command line, one argument after
// another. "?" when it cannot be read — gone since it was found, most likely — because the line
// it goes on is about ending the process by its pid and stands without it.
export function commandOf(pid) {
  const found = argumentsOf(pid);
  return found.length === 0 ? "?" : found.join(" ");
}

// The refusal, as the person reads it: one line per session saying exactly what ends it, because
// with the chat down — and it is down, or the chat's own check refused first — nobody else can.
// A run parked on a permission prompt never ends by itself. Each with what it is running, since a
// pid alone leaves the person to look every one up before ending it, and the process that is
// not a session of theirs at all is told apart by its command; as a comment, so the line pastes.
// After the sessions, what the seats left running (`describeLeftovers`).
export function describeRunning(running) {
  const sessions = running.filter(({ session }) => session !== false);
  const lines = [];
  if (sessions.length > 0) {
    lines.push(
      "a session of this instance is running — an update would replace, on disk, what it is running from memory, and it would go on running the superseded version:",
      ...sessions.map(({ pid }) => `  kill ${pid}   # ${commandOf(pid)}`),
      "End them, or let them finish, and run this again.",
    );
  }
  const leftovers = describeLeftovers(running);
  if (leftovers !== null) {
    lines.push(leftovers);
  }
  return lines.join("\n");
}

// What the seats left running, one line per process naming the seat that started it, and one
// line that ends all of them, to paste. Null when nothing was left.
export function describeLeftovers(running) {
  const leftovers = running.filter(({ session }) => session === false);
  if (leftovers.length === 0) {
    return null;
  }
  return [
    ...leftovers.map(({ pid, seat }) => `${seat} left this running: ${commandOf(pid)} (pid ${pid})`),
    `  kill ${leftovers.map(({ pid }) => pid).join(" ")}`,
  ].join("\n");
}

function alive(pid) {
  try {
    // Signal 0 asks whether a process exists without touching it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// End what a seat left running, once its session is gone: every process of this instance's
// carrying the seat — told to end, given `grace` to do it, then taken down. The list is taken
// once, before anything is signalled, and never again: a successor started on the seat while
// its predecessor's leftovers are being ended carries the same seat, and is not a leftover.
// Resolves with what was ended, `{ pid, command }` each, once none of it is left.
export async function endLeftovers(root, seat, grace = GRACE) {
  const found = runningHere(root)
    .filter((one) => one.seat === seat)
    .map(({ pid }) => ({ pid, command: commandOf(pid) }));
  if (found.length === 0) {
    return [];
  }
  for (const { pid } of found) {
    signal(pid, "SIGTERM");
  }
  const began = Date.now();
  while (found.some(({ pid }) => alive(pid)) && Date.now() - began < grace) {
    await pause(50);
  }
  for (const { pid } of found) {
    if (alive(pid)) {
      signal(pid, "SIGKILL");
    }
  }
  return found;
}
