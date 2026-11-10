// Long runs: a command a seat starts with `ovai run <name> -- <command>` that outlives the seat's
// session, the server and an update, and that the server tells somebody about when it ends.
//
// What ends a seat's leftovers is the seat in their environment (lib/running.mjs, `endLeftovers`),
// and a seat's end walks its own process tree too (lib/chat/session.mjs). A run carries neither:
// its environment is the shell's with the seat taken out and the run's name put in, and it is
// started detached — a session of its own, nobody's child once `ovai run` has answered. So a
// seat's stop, restart, idle close or quota close passes it by, and so does a server stop. A
// reboot does not, and nothing here pretends otherwise: a run whose process is gone with no exit
// written is lost, and told as lost.
//
// Everything about a run is a directory on the desk of the seat that started it,
// `desks/<seat>/runs/<run>/`, and nothing about it is in the server's memory: `ovai run` needs no
// server, and a server started later finds what ended while it was down. In it:
// - run.json — the seat, the name, the command, where it was started, when, and its pid with the
//   pid's own start, so a pid the machine has given to something else since is not taken for it;
// - log — the command's output and errors, appended to, never cut;
// - exit — the exit code and the time, written by the wrapper the moment the command ends;
// - stopped — who stopped it and why, written before it is signalled;
// - told — written by the server once the end has reached a session (lifecycle.mjs).
// The directory goes to archive/ with the desk; retire refuses a desk with a run going.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { lasted } from "./chat/panels.mjs";
import { RUN_IN_ENVIRONMENT, SEAT_IN_ENVIRONMENT } from "./claude.mjs";
import { deskDirectory, deskFile, desks } from "./desks.mjs";
import { startOf } from "./processes.mjs";
import { GRACE } from "./running.mjs";

export const RUNS = "runs";
const RUN_FILE = "run.json";
export const LOG_FILE = "log";
const EXIT_FILE = "exit";
const STOPPED_FILE = "stopped";
const TOLD_FILE = "told";

// Where a run stands: its process is there (going), it ended by itself with an exit code (ended),
// it was stopped (stopped), or its process is gone with no exit written — a reboot, a kill -9 of
// the wrapper (lost).
export const GOING = "going";
export const ENDED = "ended";
export const STOPPED = "stopped";
export const LOST = "lost";

// A run's name: a word a path, an event attribute and a command line all take as it is.
export const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The defaults of the two settings (lifecycle.mjs `runs`): live runs a seat may have at once, and
// the hours a run may go before the server stops it.
export const RUNS_MOST = 8;
export const RUNS_HOURS = 24;

// The wrapper the command runs in: $0 is the exit file, the command is the rest. The exit is
// written to a file beside it and renamed over, so a reader never sees half of it.
const WRAPPER = `"$@"; code=$?; printf '%s %s\\n' "$code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$0.tmp" && mv "$0.tmp" "$0"`;

// A run refused or not found: said to whoever typed the command, as it is.
export class RunError extends Error {}

export function runsDirectory(root, seat) {
  return path.join(deskDirectory(root, seat), RUNS);
}

export function runDirectory(root, seat, name) {
  return path.join(runsDirectory(root, seat), name);
}

export function logOf(root, seat, name) {
  return path.join(runDirectory(root, seat, name), LOG_FILE);
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function writeWhole(file, text) {
  const written = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(written, text);
  fs.renameSync(written, file);
}

// Whether a run is still going. While the wrapper is there, it is the run when it started when the
// run did; a pid taken by another process since is not the run. With the wrapper gone, killed
// alone, the run is the command it started, which goes on in its group: a group of that number
// cannot be anyone else's while any of it lives, since the number stays taken until the last of it
// ends.
function aliveAs(pid, since) {
  try {
    process.kill(pid, 0);
  } catch {
    return groupAlive(pid);
  }
  const now = startOf(pid);
  return since === null || now === null || now === since;
}

// Whether anything of a run's process group is left: the wrapper, or a command that outlived it.
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

// One run as its directory says it, with where it stands: `{ seat, name, command, cwd, started,
// pid, since, state, exit: { code, at } | null, stopped: { at, why } | null, told }`. Null when
// there is no run.json — no such run, or one being started again this very moment.
export function readRun(root, seat, name) {
  const at = runDirectory(root, seat, name);
  let run;
  try {
    run = JSON.parse(fs.readFileSync(path.join(at, RUN_FILE), "utf8"));
  } catch {
    return null;
  }
  const exitText = readText(path.join(at, EXIT_FILE));
  const [code, ended] = exitText === null ? [] : exitText.trim().split(" ");
  const exit = exitText === null ? null : { code: Number(code), at: ended ?? null };
  let stopped = null;
  try {
    stopped = JSON.parse(fs.readFileSync(path.join(at, STOPPED_FILE), "utf8"));
  } catch {
    // Not stopped.
  }
  const live = exit === null && aliveAs(run.pid, run.since ?? null);
  const state = live ? GOING : stopped !== null ? STOPPED : exit !== null ? ENDED : LOST;
  return { ...run, state, exit, stopped, told: fs.existsSync(path.join(at, TOLD_FILE)) };
}

// A seat's runs, oldest first.
export function runsOf(root, seat) {
  let names;
  try {
    names = fs.readdirSync(runsDirectory(root, seat), { withFileTypes: true }).filter((entry) => entry.isDirectory() && RUN_NAME.test(entry.name));
  } catch {
    return [];
  }
  return names
    .map((entry) => readRun(root, seat, entry.name))
    .filter((run) => run !== null)
    .sort((one, other) => one.started.localeCompare(other.started));
}

// Every seat's runs, oldest first.
export function allRuns(root) {
  return desks(root)
    .flatMap((seat) => runsOf(root, seat))
    .sort((one, other) => one.started.localeCompare(other.started));
}

// Start a run for a seat: refused for a seat with no desk, a name that is not one, a run of that
// name still going, and a seat with `most` runs going. A name used before is started again in the
// same directory — the resume: its end and its telling go, its log is kept and a line marks where
// the new start begins. `command` is the words to run, as given; `env` the shell's environment,
// which the run gets whole but for the seat. Answers the run as run.json holds it, with its log.
export function startRun(root, seat, name, command, { cwd = process.cwd(), env = process.env, most = RUNS_MOST, now = new Date() } = {}) {
  if (!fs.existsSync(deskFile(root, seat))) {
    throw new RunError(`${seat} has no desk here, and a run is kept on the desk of the seat that starts it`);
  }
  if (typeof name !== "string" || !RUN_NAME.test(name)) {
    throw new RunError(`${JSON.stringify(name)} is not a run name: letters, digits, dot, dash and underscore, starting with a letter or digit, up to 64`);
  }
  if (!Array.isArray(command) || command.length === 0) {
    throw new RunError("no command to run: ovai run <name> -- <command>");
  }
  const had = readRun(root, seat, name);
  if (had?.state === GOING) {
    throw new RunError(`${name} is going already (pid ${had.pid}); ovai run --stop ${name} stops it`);
  }
  const going = runsOf(root, seat).filter((run) => run.state === GOING).length;
  if (going >= most) {
    throw new RunError(`${seat} has ${going} runs going, the most a seat may have (runs.most): one ends or is stopped first`);
  }

  const at = runDirectory(root, seat, name);
  fs.mkdirSync(at, { recursive: true });
  // run.json first: a server reading the directory between these lines finds no run to tell,
  // rather than the old pid with no exit, which would read as lost.
  for (const file of [RUN_FILE, EXIT_FILE, STOPPED_FILE, TOLD_FILE]) {
    fs.rmSync(path.join(at, file), { force: true });
  }
  const log = path.join(at, LOG_FILE);
  if (had !== null) {
    fs.appendFileSync(log, `--- started again ${now.toISOString()}\n`);
  }
  const environment = { ...env, [RUN_IN_ENVIRONMENT]: `${seat}/${name}` };
  delete environment[SEAT_IN_ENVIRONMENT];
  const output = fs.openSync(log, "a");
  let child;
  try {
    child = spawn("sh", ["-c", WRAPPER, path.join(at, EXIT_FILE), ...command], { cwd, env: environment, detached: true, stdio: ["ignore", output, output] });
  } finally {
    fs.closeSync(output);
  }
  child.unref();
  const run = { seat, name, command, cwd, started: now.toISOString(), pid: child.pid, since: startOf(child.pid) };
  writeWhole(path.join(at, RUN_FILE), `${JSON.stringify(run, null, 2)}\n`);
  return { ...run, log };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stop a run that is going: `stopped` written with who and why first, so it is never read as lost,
// then its whole process group told to end, given `grace`, and taken down. Answers the run as it
// stands after. Refused for no such run; a run that is not going is answered as it is.
export async function stopRun(root, seat, name, why, { grace = GRACE, now = new Date() } = {}) {
  const run = readRun(root, seat, name);
  if (run === null) {
    throw new RunError(`${seat} has no run named ${name}`);
  }
  if (run.state !== GOING) {
    return run;
  }
  writeWhole(path.join(runDirectory(root, seat, name), STOPPED_FILE), `${JSON.stringify({ at: now.toISOString(), why })}\n`);
  const signal = (name_) => {
    try {
      process.kill(-run.pid, name_);
    } catch {
      // Gone already.
    }
  };
  signal("SIGTERM");
  const began = Date.now();
  while (groupAlive(run.pid) && Date.now() - began < grace) {
    await pause(50);
  }
  if (groupAlive(run.pid)) {
    signal("SIGKILL");
  }
  return readRun(root, seat, name);
}

// The end has reached a session: the run is not told again, by this server or the next.
export function markTold(root, seat, name, now = new Date()) {
  writeWhole(path.join(runDirectory(root, seat, name), TOLD_FILE), `${now.toISOString()}\n`);
}

// The last `count` lines of a run's log, read from its end so a log of any size costs the same.
export function lastLines(root, seat, name, count = 20) {
  const file = logOf(root, seat, name);
  let handle;
  try {
    handle = fs.openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    // A read that began mid-file began mid-line too: that first piece is not a line.
    if (length < size) {
      lines.shift();
    }
    return lines.slice(-count);
  } finally {
    fs.closeSync(handle);
  }
}

// What a run's end is, as the event says it: the exit code, or the word for how else it ended.
export function exitWord(run) {
  if (run.state === STOPPED) return "stopped";
  if (run.state === LOST) return "lost";
  return String(run.exit.code);
}

// `ovai runs`, a seat's or every seat's: one entry per run, where it stands, its log and the
// log's last line.
export function describeRuns(root, runs, now = new Date()) {
  if (runs.length === 0) {
    return "No runs.";
  }
  return runs
    .map((run) => {
      const started = new Date(run.started);
      const how =
        run.state === GOING ? `going, ${lasted(started, now)} (pid ${run.pid})`
        : run.state === ENDED ? `ended with exit ${run.exit.code}${run.exit.at === null ? "" : ` at ${run.exit.at}`}`
        : run.state === STOPPED ? `stopped at ${run.stopped.at}: ${run.stopped.why}`
        : "lost: its process is gone and it wrote no exit (a reboot, or a kill); start it again to resume";
      const last = lastLines(root, run.seat, run.name, 1)[0];
      return [
        `${run.seat}/${run.name} — ${how}`,
        `  started ${run.started}: ${run.command.join(" ")}`,
        `  log: ${path.relative(root, logOf(root, run.seat, run.name))}`,
        ...(last === undefined ? [] : [`  last: ${last}`]),
      ].join("\n");
    })
    .join("\n");
}
