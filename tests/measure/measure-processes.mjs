// What lib/processes.mjs, lib/running.mjs and lib/port.mjs assume about a machine's process table,
// asked of the machine: real processes started here, found again by the code the server runs.
//
//   node tests/measure/measure-processes.mjs
//
// Run by the macOS and Windows workflows, which are started by hand. tests/processes.test.mjs
// reads the text a stand-in `ps` and `lsof` print; whether a Mac's `ps -A -ww -E` prints the
// environment of a process after its command, and whether `lsof` names the holder of a port, is
// only answered here. XDG_DATA_HOME is the caller's, as for measure-runtime.sh, and the pinned
// node runs this.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { home } from "../../lib/claude.mjs";
import { holderOf } from "../../lib/port.mjs";
import { commandOf, processes } from "../../lib/processes.mjs";
import { endLeftovers, runningHere } from "../../lib/running.mjs";
import { dataDirectory } from "../../lib/runtime.mjs";

const SEAT = "Eva";
const STAYS = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";
const children = [];

// A directory with a space in its name, as a Mac's home often has, so an environment value has to be
// read whole.
const base = fs.mkdtempSync(path.join(os.tmpdir(), "ovai-measure-"));
const root = path.join(base, "an instance");
const ours = home(root);
const another = path.join(base, "another instance", ".local");

// A process that says `ready` once it runs and then stays.
function start(command, args, env) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  children.push(child);
  const ready = new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("ready\n")) {
        resolve(text);
      }
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`${command} ${args.join(" ")} ended before it was ready`)));
  });
  return { child, ready, exited, pid: child.pid };
}

// The line a Mac's `ps -E` prints for one process, for the failure message: it is what to look at.
function rawPs(pid) {
  if (process.platform !== "darwin") {
    return "";
  }
  const asked = spawnSync("ps", ["-ww", "-E", "-p", String(pid), "-o", "pid=,command="], { encoding: "utf8" });
  return `\n  ps -ww -E -p ${pid}: ${asked.stdout.trim() || `(nothing, status ${asked.status}, ${asked.stderr.trim()})`}`;
}

async function main() {
  console.log(`platform: ${process.platform} ${os.arch()}, node ${process.version}, ${base}`);

  // A claude-like command line: a script at the path the toolkit's own Claude Code has, so `node
  // <that path> --print …` is what the table shows, as it shows the real one. The version in the
  // path is not the pinned one: any version under the data directory is a session.
  const fake = path.join(dataDirectory(), "claude", "0.0.0", "bin", "claude");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, `#!/usr/bin/env node\n${STAYS}\n`, { mode: 0o755 });
  const onPath = { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  const aSeat = { CLAUDE_CONFIG_DIR: ours, OPENOVAI_SEAT: SEAT, ...onPath };

  const session = start(fake, ["--print", "--output-format", "stream-json"], aSeat);
  const leftover = start(process.execPath, ["-e", STAYS, "left-by-a-seat"], aSeat);
  const stranger = start(fake, ["--print"], { CLAUDE_CONFIG_DIR: another, OPENOVAI_SEAT: "", ...onPath });
  const listener = start(
    process.execPath,
    ["-e", "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { process.stdout.write(s.address().port + '\\nready\\n'); }); setInterval(() => {}, 1000);"],
    onPath,
  );
  const [, , , listening] = await Promise.all([session.ready, leftover.ready, stranger.ready, listener.ready]);
  const port = Number(listening.split("\n")[0]);

  // 1. The table lists a process, its environment and its command line.
  const table = new Map(processes().map((one) => [one.pid, one]));
  assert.ok(table.has(session.pid), `processes() does not list pid ${session.pid}, a child started a moment ago${rawPs(session.pid)}`);
  const found = table.get(session.pid);
  const environment = found.environment();
  assert.notEqual(environment, null, `processes() lists pid ${session.pid} with no environment: this machine's table does not show the environment of a process of the person's own${rawPs(session.pid)}`);
  assert.equal(
    environment.get("CLAUDE_CONFIG_DIR"),
    ours,
    `the environment read back for pid ${session.pid} has CLAUDE_CONFIG_DIR=${JSON.stringify(environment.get("CLAUDE_CONFIG_DIR"))}, not ${JSON.stringify(ours)}${rawPs(session.pid)}`,
  );
  assert.equal(environment.get("OPENOVAI_SEAT"), SEAT, `OPENOVAI_SEAT read back is ${JSON.stringify(environment.get("OPENOVAI_SEAT"))}`);
  assert.ok(found.command().includes(fake), `the command read back is ${JSON.stringify(found.command())}, which does not hold ${fake}`);
  assert.ok(!table.has(process.pid), "processes() lists the caller's own process");
  assert.ok(commandOf(session.pid)?.includes(fake), `commandOf(${session.pid}) is ${JSON.stringify(commandOf(session.pid))}`);
  console.log(`processes(): finds pid ${session.pid} with CLAUDE_CONFIG_DIR (a value with a space in it) and OPENOVAI_SEAT, and its command line`);

  // 2. What makes a process an instance's, and a session rather than a leftover.
  const running = runningHere(root);
  const byPid = new Map(running.map((one) => [one.pid, one]));
  assert.deepEqual(byPid.get(session.pid), { pid: session.pid, seat: SEAT, session: true }, `runningHere() on the session: ${JSON.stringify(byPid.get(session.pid))}${rawPs(session.pid)}`);
  assert.deepEqual(byPid.get(leftover.pid), { pid: leftover.pid, seat: SEAT, session: false }, `runningHere() on the leftover: ${JSON.stringify(byPid.get(leftover.pid))}${rawPs(leftover.pid)}`);
  assert.ok(!byPid.has(stranger.pid), "runningHere() reports a session of another instance");
  assert.ok(!byPid.has(listener.pid), "runningHere() reports a process with no instance environment");
  console.log("runningHere(): the session is a session, the seat's other process a leftover, another instance's session and a bare process are not listed");

  // 3. The holder of a port.
  const holder = holderOf(port);
  assert.ok(holder !== null, `holderOf(${port}) names nobody, and pid ${listener.pid} is listening on 127.0.0.1:${port}`);
  assert.equal(String(holder.pid), String(listener.pid), `holderOf(${port}) names pid ${holder.pid}, not ${listener.pid}`);
  assert.ok(holder.command?.includes("node"), `holderOf(${port}) gives the command ${JSON.stringify(holder.command)}`);
  console.log(`holderOf(${port}): pid ${holder.pid}, ${holder.command}`);
  listener.child.kill("SIGTERM");
  await listener.exited;
  assert.equal(holderOf(port), null, `holderOf(${port}) still names a holder after the listener ended`);
  console.log("holderOf(): null once the listener is gone");

  // 4. Ending what a seat left: the seat's two processes go, the stranger stays.
  const ended = await endLeftovers(root, SEAT, 3000);
  assert.deepEqual(ended.map(({ pid }) => pid).sort(), [session.pid, leftover.pid].sort(), "endLeftovers() did not name the seat's two processes");
  await Promise.race([
    Promise.all([session.exited, leftover.exited]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("the seat's processes are still running after endLeftovers()")), 5000)),
  ]);
  assert.equal(stranger.child.exitCode, null, "endLeftovers() ended another instance's session");
  console.log("endLeftovers(): ended the seat's processes and left the other instance's");
}

try {
  await main();
} catch (error) {
  console.error(`MEASURED WRONG: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  fs.rmSync(base, { recursive: true, force: true });
}
