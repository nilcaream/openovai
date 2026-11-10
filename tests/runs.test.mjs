// tests/runs.test.mjs — long runs: what `ovai run` starts, where it keeps it, how it is read back,
// stopped and started again, and that nothing that ends a seat's leftovers ends a run.
//
// Real processes, short ones: a run here is `sh -c` printing a line, or sleeping until it is
// stopped. The instance is the least a run needs — openovai.json and a desk — and the command is
// run as bin/ovai runs it, node on lib/ovai.mjs with --root.
//
// Run it with: node --test tests/runs.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { remove, repo, scratch } from "./helpers.mjs";
import { RUN_IN_ENVIRONMENT, SEAT_IN_ENVIRONMENT, home } from "../lib/claude.mjs";
import { endLeftovers, runningHere } from "../lib/running.mjs";
import { ENDED, GOING, LOST, RunError, STOPPED, allRuns, describeRuns, lastLines, logOf, markTold, readRun, runDirectory, startRun, stopRun } from "../lib/runs.mjs";

const here = scratch("runs-test");
const root = path.join(here, "instance");
const SEAT = "Axel";

before(() => {
  fs.mkdirSync(path.join(root, "desks", SEAT), { recursive: true });
  fs.writeFileSync(path.join(root, "desks", SEAT, "STATE.md"), "desk\n");
  fs.writeFileSync(path.join(root, "openovai.json"), `${JSON.stringify({ user: "User", leader: "Lead", runs: { most: 3 } })}\n`);
});
after(() => remove(here));

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, ms = 5000) {
  const began = Date.now();
  while (!check()) {
    if (Date.now() - began > ms) {
      throw new Error(`waited ${ms} ms for ${what}`);
    }
    await pause(20);
  }
}

// The shell of a seat, as a session hands it on: the instance's home and the seat.
const seatShell = { ...process.env, CLAUDE_CONFIG_DIR: home(root), [SEAT_IN_ENVIRONMENT]: SEAT };

function ovai(argv, env = seatShell) {
  return spawnSync("node", [path.join(repo, "lib", "ovai.mjs"), "--root", root, ...argv], { env, encoding: "utf8", cwd: here });
}

describe("a run started", () => {
  it("runs the command detached, in the shell's environment with the run in place of the seat, and writes its exit", async () => {
    const run = startRun(root, SEAT, "env", ["sh", "-c", 'echo "seat=${OPENOVAI_SEAT:-none} run=$OPENOVAI_RUN"; exit 3'], { env: seatShell });
    await until(() => readRun(root, SEAT, "env").state !== GOING, "the run to end");
    const read = readRun(root, SEAT, "env");
    assert.equal(read.state, ENDED);
    assert.equal(read.exit.code, 3);
    assert.equal(read.pid, run.pid);
    assert.deepEqual(lastLines(root, SEAT, "env"), [`seat=none run=${SEAT}/env`]);
  });

  it("is listed by the machine as a run, never as a session, and outlives the end of its seat's leftovers", async () => {
    startRun(root, SEAT, "sleeper", ["sleep", "30"], { env: seatShell });
    const found = runningHere(root).filter((one) => one.run === `${SEAT}/sleeper`);
    assert.ok(found.length > 0, "the run is found by its name");
    assert.ok(found.every((one) => one.session === false && one.seat === null));
    await endLeftovers(root, SEAT, 100);
    assert.equal(readRun(root, SEAT, "sleeper").state, GOING);
    await stopRun(root, SEAT, "sleeper", "test over", { grace: 200 });
  });

  it("is refused a name that is not one, a name still going, and more than the seat may have", async () => {
    assert.throws(() => startRun(root, SEAT, "../up", ["true"], { env: seatShell }), RunError);
    assert.throws(() => startRun(root, "Nobody", "x", ["true"], { env: seatShell }), /no desk/);
    startRun(root, SEAT, "one", ["sleep", "30"], { env: seatShell });
    assert.throws(() => startRun(root, SEAT, "one", ["sleep", "30"], { env: seatShell }), /going already/);
    startRun(root, SEAT, "two", ["sleep", "30"], { env: seatShell, most: 2 });
    assert.throws(() => startRun(root, SEAT, "three", ["sleep", "30"], { env: seatShell, most: 2 }), /2 runs going/);
    await stopRun(root, SEAT, "one", "test over", { grace: 200 });
    await stopRun(root, SEAT, "two", "test over", { grace: 200 });
  });
});

describe("a run stopped, lost, and started again", () => {
  it("stops the whole process group and says who stopped it", async () => {
    startRun(root, SEAT, "group", ["sh", "-c", "sleep 30 & sleep 30; wait"], { env: seatShell });
    const pid = readRun(root, SEAT, "group").pid;
    const stopped = await stopRun(root, SEAT, "group", "by hand", { grace: 500 });
    assert.equal(stopped.state, STOPPED);
    assert.equal(stopped.stopped.why, "by hand");
    assert.throws(() => process.kill(-pid, 0), "nothing of the group is left");
  });

  it("goes on while its command does after the wrapper was killed alone: refused a second start, and stopped with its group", async () => {
    // The wrapper is killed only once its command is up: killed before `sh` forks it, there is
    // nothing left of the group, and the run is rightly lost.
    const up = path.join(here, "orphan-up");
    startRun(root, SEAT, "orphan", ["sh", "-c", `: > "${up}"; exec sleep 30`], { env: seatShell });
    const pid = readRun(root, SEAT, "orphan").pid;
    await until(() => fs.existsSync(up), "the command to be up");
    process.kill(pid, "SIGKILL");
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "the wrapper to be gone");
    assert.equal(readRun(root, SEAT, "orphan").state, GOING);
    assert.throws(() => startRun(root, SEAT, "orphan", ["sleep", "30"], { env: seatShell }), /going already/);
    const stopped = await stopRun(root, SEAT, "orphan", "by hand", { grace: 500 });
    assert.equal(stopped.state, STOPPED);
    assert.throws(() => process.kill(-pid, 0), "nothing of the group is left");
  });

  it("reads a run whose process is gone with no exit as lost", () => {
    const at = runDirectory(root, SEAT, "rebooted");
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, "run.json"), JSON.stringify({ seat: SEAT, name: "rebooted", command: ["x"], cwd: here, started: new Date().toISOString(), pid: 2 ** 22 + 1, since: "1" }));
    assert.equal(readRun(root, SEAT, "rebooted").state, LOST);
  });

  it("starts the same name again in the same directory, its end and telling gone, its log kept", async () => {
    startRun(root, SEAT, "again", ["echo", "first"], { env: seatShell });
    await until(() => readRun(root, SEAT, "again").state === ENDED, "the first run to end");
    markTold(root, SEAT, "again");
    assert.equal(readRun(root, SEAT, "again").told, true);
    startRun(root, SEAT, "again", ["echo", "second"], { env: seatShell });
    assert.equal(readRun(root, SEAT, "again").told, false);
    await until(() => readRun(root, SEAT, "again").state === ENDED, "the second run to end");
    const log = fs.readFileSync(logOf(root, SEAT, "again"), "utf8").split("\n");
    assert.equal(log[0], "first");
    assert.match(log[1], /^--- started again \d{4}-/);
    assert.equal(log[2], "second");
  });
});

describe("what is read back", () => {
  it("reads the last lines from the end of a log of any size", () => {
    const at = runDirectory(root, SEAT, "big");
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, "log"), Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    assert.deepEqual(lastLines(root, SEAT, "big", 2), ["line 19998", "line 19999"]);
  });

  it("lists every seat's runs, each with where it stands and its log", () => {
    const said = describeRuns(root, allRuns(root));
    assert.match(said, /Axel\/env — ended with exit 3/);
    assert.match(said, /log: desks\/Axel\/runs\/env\/log/);
    assert.match(said, /Axel\/rebooted — lost/);
  });
});

describe("ovai run and ovai runs", () => {
  it("starts a run from a seat's shell and names its log", async () => {
    const started = ovai(["run", "cli", "--", "echo", "from the command"]);
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /^Run cli started \(pid \d+\)/);
    assert.match(started.stdout, /Log: desks\/Axel\/runs\/cli\/log/);
    await until(() => readRun(root, SEAT, "cli")?.state === ENDED, "the run to end");
    assert.equal(readRun(root, SEAT, "cli").cwd, here, "in the shell's own directory");
    assert.match(ovai(["runs"]).stdout, /Axel\/cli — ended with exit 0[^]*last: from the command/);
  });

  it("refuses a terminal that is no seat's, and a line with no command", () => {
    const { [SEAT_IN_ENVIRONMENT]: _, ...noSeat } = seatShell;
    const refused = ovai(["run", "x", "--", "true"], noSeat);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /no seat's/);
    assert.equal(ovai(["run", "x", "true"]).status, 2);
  });

  it("takes the limit from openovai.json", async () => {
    for (const name of ["l1", "l2", "l3"]) {
      assert.equal(ovai(["run", name, "--", "sleep", "30"]).status, 0);
    }
    const refused = ovai(["run", "l4", "--", "sleep", "30"]);
    assert.match(refused.stderr, /3 runs going/);
    const stopped = ovai(["run", "--stop", `${SEAT}/l1`], { ...process.env, [RUN_IN_ENVIRONMENT]: "" });
    assert.match(stopped.stdout, /Axel\/l1 stopped/);
    for (const name of ["l2", "l3"]) {
      await stopRun(root, SEAT, name, "test over", { grace: 200 });
    }
  });
});
