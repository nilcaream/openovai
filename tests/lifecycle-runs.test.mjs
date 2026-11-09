// The lifecycle and long runs: who is told when a run ends, when nobody is, the hours a run may
// go, retire with a run going, and the runs the Leader's line is told of.
//
// The fixture is tests/lifecycle-helpers.mjs. A run that has ended is written by hand — run.json
// with a pid no process has, and an exit — since what is checked is the server's reading of the
// directory; a run that goes is a real `sleep`, started as `ovai run` starts one.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { subscribe } from "../lib/chat/events.mjs";
import { parkRoom, tick } from "../lib/chat/lifecycle.mjs";
import { endEvery, running } from "../lib/chat/session.mjs";
import { GOING, STOPPED, readRun, runDirectory, startRun, stopRun } from "../lib/runs.mjs";
import { heardIn, queuesHeardIn, waitFor } from "./helpers.mjs";

import { setup, LEADER, WORKER, OTHER, chat, instance, seatUp, spawnedBy, tool, told, settle } from "./lifecycle-helpers.mjs";

let now = Date.now();
setup("lifecycle-runs-test", () => now, { hired: [WORKER, OTHER] });

// A pid past the largest Linux gives: no process has it.
const NO_PROCESS = 2 ** 22 + 1;

function ended(seat, name, { code = 0, lines = ["one", "two"] } = {}) {
  const at = runDirectory(instance, seat, name);
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, "run.json"), JSON.stringify({ seat, name, command: ["sweep"], cwd: instance, started: new Date(now - 60_000).toISOString(), pid: NO_PROCESS, since: "1" }));
  fs.writeFileSync(path.join(at, "exit"), `${code} 2026-11-13T12:00:00Z\n`);
  fs.writeFileSync(path.join(at, "log"), lines.map((line) => `${line}\n`).join(""));
}

const frameOf = (seat, name, exit, body) => `<server-event type="run-ended" seat="${seat}" run="${name}" exit="${exit}">${body}</server-event>`;
// The run-ended frames a seat was told, each whole with its body of many lines, `at` dropped.
const runEnded = (log) =>
  queuesHeardIn(log)
    .flatMap((queue) => queue.replace(/ at="\d\d:\d\d"/g, "").split(/\n {2}(?=<)/))
    .map((one) => one.replace(/^<queue>\n {2}/, "").replace(/\n<\/queue>$/, ""))
    .filter((one) => one.startsWith('<server-event type="run-ended"'));

describe("a run that ended is told", () => {
  after(() => endEvery(500));

  it("to the seat that started it while it runs, once, its told written", async () => {
    await endEvery(500);
    await seatUp(LEADER);
    const paul = await seatUp(WORKER);
    ended(WORKER, "deals", { code: 3 });
    tick(chat);
    await told(paul.log, 1);
    assert.deepEqual(runEnded(paul.log), [frameOf(WORKER, "deals", "3", `Log: desks/${WORKER}/runs/deals/log, its last 2 lines:\none\ntwo`)]);
    assert.ok(await waitFor(() => (readRun(instance, WORKER, "deals").told ? true : null)), "told is written");
    tick(chat);
    await settle();
    assert.equal(runEnded(paul.log).length, 1, "never twice");
  });

  it("to the Leader, naming whose it was, when that seat is not running", async () => {
    await endEvery(500);
    const martin = await seatUp(LEADER);
    ended(OTHER, "tags", { lines: [] });
    tick(chat);
    assert.ok(await waitFor(() => (runEnded(martin.log).length === 1 ? true : null)), heardIn(martin.log).join("\n"));
    assert.deepEqual(runEnded(martin.log), [frameOf(OTHER, "tags", "0", `Log: desks/${OTHER}/runs/tags/log, empty.`)]);
  });

  it("starting a stopped Leader for it", async () => {
    await endEvery(500);
    ended(OTHER, "late");
    const martin = await spawnedBy(LEADER, async () => {
      tick(chat);
      await waitFor(() => (running(LEADER) ? true : null));
    });
    assert.ok(await waitFor(() => (runEnded(martin.log).length === 1 ? true : null)));
  });
});

describe("a parked room", () => {
  after(() => endEvery(500));

  it("starts nobody for a run that ends: the notice waits until the Leader is started by something else", async () => {
    await endEvery(500);
    await parkRoom(chat);
    ended(OTHER, "overnight");
    tick(chat);
    await settle(300);
    assert.equal(running(LEADER), false, "a park stays a park");
    assert.equal(readRun(instance, OTHER, "overnight").told, false, "the notice waits on disk");
    const martin = await seatUp(LEADER);
    tick(chat);
    assert.ok(await waitFor(() => (runEnded(martin.log).some((one) => one.includes('run="overnight"')) ? true : null)), heardIn(martin.log).join("\n"));
    // That start ended the park: a Leader that stops after it is started again by the next run.
    await endEvery(500);
    ended(OTHER, "after");
    const again = await spawnedBy(LEADER, async () => {
      tick(chat);
      await waitFor(() => (running(LEADER) ? true : null));
    });
    assert.ok(await waitFor(() => (runEnded(again.log).length === 1 ? true : null)));
  });
});

describe("a run that goes too long", () => {
  after(() => endEvery(500));

  it("is stopped at runs.hours and told as stopped, with the reason", async () => {
    await endEvery(500);
    const martin = await seatUp(LEADER);
    startRun(instance, OTHER, "forgotten", ["sleep", "30"], { now: new Date(now - 25 * 3_600_000) });
    tick(chat);
    assert.ok(await waitFor(() => (readRun(instance, OTHER, "forgotten").state === STOPPED ? true : null)), "stopped");
    tick(chat);
    const frames = await waitFor(() => {
      const found = runEnded(martin.log).filter((one) => one.includes('run="forgotten"'));
      return found.length > 0 ? found : null;
    });
    assert.match(frames[0], /exit="stopped">Stopped: it had gone 24 hours, the most a run may \(runs\.hours\)\.\nLog: /);
  });
});

describe("retire and the line", () => {
  const shown = [];
  let unsubscribe = null;

  before(() => {
    unsubscribe = subscribe((event) => {
      if (event.name === "runs") shown.push(event.data);
    });
  });

  after(async () => {
    unsubscribe();
    await endEvery(500);
  });

  it("refuses to retire a Worker with a run going, naming the run and how to stop it", async () => {
    await endEvery(500);
    const martin = await seatUp(LEADER);
    startRun(instance, OTHER, "sweep", ["sleep", "30"]);
    const refused = await tool(martin.secret, "retire", { name: OTHER });
    assert.equal(refused.refused, true);
    assert.equal(refused.text, `${OTHER} has a run going: sweep. Wait for its end, or stop it in a shell: ovai run --stop ${OTHER}/sweep`);
    tick(chat);
    const going = readRun(instance, OTHER, "sweep");
    assert.equal(going.state, GOING);
    assert.deepEqual(shown.at(-1), [{ seat: OTHER, name: "sweep", started: going.started }], "the page is told the runs going");
    await stopRun(instance, OTHER, "sweep", "test over", { grace: 200 });
    tick(chat);
    assert.deepEqual(shown.at(-1), []);
  });
});
