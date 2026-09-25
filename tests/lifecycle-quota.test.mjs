// The lifecycle, the quota gate in front of every write: quota-low, what is held at the write, and
// what is released at the reset.
//
// The fixture is tests/lifecycle-helpers.mjs. Every mutation in
// tests/mutations-lifecycle-quota.json names the check it was written to redden.

import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { SERVER } from "../lib/chat/conversation.mjs";
import { messageFrame, userFrame } from "../lib/chat/frames.mjs";
import { BODY_CLOSING, IDLE_GRACE, tick } from "../lib/chat/lifecycle.mjs";
import * as quota from "../lib/chat/quota.mjs";
import { INTERRUPT_PATIENCE, end, endEvery, running, tell } from "../lib/chat/session.mjs";
import { deskTitle, hire } from "../lib/desks.mjs";
import { callsIn, childrenOf, heardIn, notesIn, queuesHeardIn, readLog, remove, waitFor } from "./helpers.mjs";

import { setup, LEADER, WORKER, OTHER, MINUTE, panel, instance, unexpected, reading, said, chat, server, seatUp, spawnedBy, page, call, tool, asked, told, readIn, gone, callsThen, writesDesk, settle } from "./lifecycle-helpers.mjs";

let now = Date.now();
// Ann is hired before the first check: these checks start her without a hire of their own, as
// they did when they ran after the ones that hire her.
setup("lifecycle-quota-test", () => now, { hired: [WORKER, OTHER] });

// ---------------------------------------------------------------------------------------------

// The gate reads what the children say about the account's windows. Every check here starts from
// no reading at all and ends with none, so what one measured never stands in for the next.
describe("the quota gate", () => {
  // A window about to reset: close enough that jumping the clock past it wakes no idle clock.
  const RESETS = () => now + 5 * MINUTE;
  let superman = null;
  let paul = null;

  function readings(...perTurn) {
    return { OPENOVAI_STAND_IN_RATE_LIMIT: JSON.stringify(perTurn) };
  }

  before(() => {
    quota.forget();
  });

  after(async () => {
    await endEvery(500);
    quota.forget();
  });

  async function fresh(paulKnobs, leaderKnobs = {}) {
    await endEvery(500);
    quota.forget();
    superman = await seatUp(LEADER, leaderKnobs);
    paul = await seatUp(WORKER, paulKnobs);
  }

  // A check that jumps to the reset also passes the deadline of the Worker's close for the spent
  // window: the Worker goes at that tick and the Leader is told. Waited for here, so the event is
  // not left to start a Leader in the middle of the next check's setup.
  async function closedAtTheReset() {
    assert.ok(await gone(WORKER), `${WORKER} was not closed at its deadline`);
    const stopped = `<server-event type="stopped" who="${WORKER}" why="quota"/>`;
    assert.ok(await waitFor(() => (heardIn(superman.log).includes(stopped) ? true : null)), heardIn(superman.log).join("\n"));
  }

  it("keeps the newest reading per window from one turn, and stage one tells every seat, behind its queue, nobody interrupted", async () => {
    const resets = RESETS();
    await fresh({ OPENOVAI_STAND_IN_SLOW: "600", ...readings([reading(0.5, { resets }), reading(0.91, { resets })]) });
    tell(WORKER, userFrame("first"));
    const queued = tell(WORKER, userFrame("queued"));
    await queued.answered;
    assert.equal(quota.standing().five_hour.utilization, 0.91);
    const warning = `<server-event type="quota-low" stage="warning" window="5h" resets="${new Date(resets).toISOString()}"/>`;
    assert.deepEqual(heardIn(paul.log).slice(0, 1), ["<user>first</user>"]);
    const queues = queuesHeardIn(paul.log);
    assert.equal(queues.length, 2, heardIn(paul.log).join("\n"));
    assert.deepEqual(childrenOf(queues[1]), ["<user>queued</user>", warning]);
    assert.deepEqual(await told(superman.log, 1), [warning]);
    assert.ok(!notesIn(paul.log).some(([label]) => label === "interrupt"));
    assert.ok(!notesIn(superman.log).some(([label]) => label === "interrupt"));
  });

  // What the gate learned, written where it learned it: the stage was told to the seats and never
  // to the log, so a day's quota could not be read back. The percentage is the reading's own —
  // quota.mjs keeps the readings, and it is the only place the number exists.
  it("writes a quota row at each crossing: the stage, the percentage, the reset, and the model when the window is one model's own", async () => {
    const resets = RESETS();
    const week = now + 3 * 24 * 60 * MINUTE;
    await fresh(readings(reading(0.91, { resets }), reading(0.96, { resets })));
    const logged = said.length;
    await tell(WORKER, userFrame("one")).answered;
    await tell(WORKER, userFrame("two")).answered;
    // Fable's own weekly window reaches the gate from the usage endpoint, not from a process.
    quota.saw("usage", null, { unifiedWindows: { [quota.FABLE_WINDOW]: { utilization: 0.995, resetsAt: week } } }, now);
    assert.deepEqual(said.slice(logged).filter((line) => line.startsWith("quota ")), [
      `quota - - warning on 5h at 91%, resets ${new Date(resets).toISOString()}`,
      `quota - - critical on 5h at 96%, resets ${new Date(resets).toISOString()}`,
      `quota - - critical on 7d-fable (fable) at 99.5%, resets ${new Date(week).toISOString()}`,
    ]);
  });

  it("stage two interrupts a Worker mid-turn and closes it; the Leader is told, not interrupted", async () => {
    const resets = RESETS();
    // The gate acts on the reading this turn's own first request carries, so the turn has the
    // gate's handling to outlast and nothing more.
    await fresh({ OPENOVAI_STAND_IN_SLOW: "1200", ...readings(reading(0.96, { resets })) });
    const first = tell(WORKER, userFrame("busy"));
    assert.deepEqual(await first.answered, { interrupted: true, text: "interrupted" });
    const critical = `<server-event type="closing" why="quota" window="5h" resets="${new Date(resets).toISOString()}" interrupted="true" deadline="${IDLE_GRACE * 60}">${BODY_CLOSING("quota", true, IDLE_GRACE * 60)}</server-event>`;
    assert.deepEqual(await told(paul.log, 2), ["<user>busy</user>", critical]);
    const labels = notesIn(paul.log).map(([label]) => label);
    assert.ok(labels.indexOf("interrupt") < labels.lastIndexOf("heard"), labels.join(","));
    assert.ok(labels.includes("interrupted"));
    const toLeader = await told(superman.log, 1);
    assert.equal(toLeader.length, 1);
    assert.match(toLeader[0], /^<server-event type="quota-low" stage="critical" window="5h" resets="[^"]+">/);
    assert.ok(!toLeader[0].includes("interrupted="));
    assert.ok(!notesIn(superman.log).some(([label]) => label === "interrupt"));
  });

  it("passes a page message at stage one, holds it at stage two, and writes it once the window has reset", async () => {
    const resets = RESETS();
    await fresh(readings(reading(0.91, { resets }), reading(0.96, { resets })));
    await tell(WORKER, userFrame("one")).answered;
    const passed = await page("POST", `/sessions/${LEADER}/message`, { text: "at one" });
    assert.deepEqual(JSON.parse(passed.body), { delivered: true });
    assert.equal((await told(superman.log, 2)).at(-1), "<user>at one</user>");
    await tell(WORKER, userFrame("two")).answered;
    const held = await page("POST", `/sessions/${LEADER}/message`, { text: "at two" });
    assert.deepEqual(JSON.parse(held.body), { delivered: false, held: { window: "5h", resets: new Date(resets).toISOString() } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(heardIn(superman.log).filter((frame) => frame === "<user>at two</user>").length, 0);
    assert.deepEqual(panel(instance, LEADER).at(-1).text, `limit exhausted (5h window), reset at ${quota.hhmm(resets)}, your message is waiting`);
    now = resets + 1;
    tick(chat);
    assert.equal((await told(superman.log, 4)).at(-1), "<user>at two</user>");
    // The reply is waited for on the panel, not read off the moment the run logged the frame: the
    // log and the pipe are two channels, and the run on its own core can note "heard" before the
    // result it wrote right after has been read here.
    await waitFor(() => (panel(instance, LEADER).at(-1).from === LEADER ? true : null));
    assert.deepEqual(panel(instance, LEADER).slice(-1).map((row) => [row.from, row.text]), [[LEADER, "a reply"]]);
    await closedAtTheReset();
  });

  it("holds a hire from stage one, until the reset", async () => {
    const resets = RESETS();
    await fresh(readings(reading(0.91, { resets })));
    await tell(WORKER, userFrame("one")).answered;
    assert.deepEqual(await tool(superman.secret, "hire", { name: OTHER }), {
      text: `held: quota (5h resets ${new Date(resets).toISOString()})`,
      refused: true,
      error: null,
    });
    assert.equal(running(OTHER), false);
    now = resets + 1;
    const ann = await spawnedBy(OTHER, () => tool(superman.secret, "hire", { name: OTHER }));
    assert.equal(ann.result.refused, false);
    await end(OTHER, 500);
  });

  it("a rejected status closes the window whatever the number, until its reset", async () => {
    const resets = RESETS();
    await fresh(readings(reading(0.8, { resets, status: "rejected" })));
    await tell(WORKER, userFrame("one")).answered;
    const held = await page("POST", `/sessions/${LEADER}/message`, { text: "rejected" });
    assert.equal(JSON.parse(held.body).delivered, false);
    assert.equal(JSON.parse(held.body).held.window, "5h");
    now = resets + 1;
    tick(chat);
    assert.equal((await told(superman.log, 2)).at(-1), "<user>rejected</user>");
    await closedAtTheReset();
  });

  it("applies the 7d thresholds to the 7d window: nothing at 0.91, warning at 0.98, interrupt and critical at 0.99", async () => {
    // The 7d window's own reset, three days out — never the frame's outer one, which is the 5h's.
    const week = new Date(now + 3 * 24 * 60 * MINUTE).toISOString();
    await fresh({ OPENOVAI_STAND_IN_SLOW: "400", ...readings(reading(0.5, { sevenDay: 0.91 }), reading(0.5, { sevenDay: 0.98 }), reading(0.5, { sevenDay: 0.99 })) });
    await tell(WORKER, userFrame("one")).answered;
    assert.deepEqual(heardIn(superman.log), []);
    await tell(WORKER, userFrame("two")).answered;
    assert.deepEqual(await told(superman.log, 1), [`<server-event type="quota-low" stage="warning" window="7d" resets="${week}"/>`]);
    const third = tell(WORKER, userFrame("three"));
    assert.deepEqual(await third.answered, { interrupted: true, text: "interrupted" });
    const frames = await told(paul.log, 5);
    assert.match(frames.at(-1), /^<server-event type="closing" why="quota" window="7d" resets="[^"]+" interrupted="true" deadline="\d+">/);
  });

  it("a stage fires once per crossing and again after the reset", async () => {
    const resets = RESETS();
    const later = resets + 5 * 60 * MINUTE;
    await fresh(readings(reading(0.91, { resets }), reading(0.92, { resets }), reading(0.91, { resets: later })));
    await tell(WORKER, userFrame("one")).answered;
    await tell(WORKER, userFrame("two")).answered;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(heardIn(superman.log).filter((frame) => frame.includes('stage="warning"')).length, 1);
    now = resets + 1;
    await tell(WORKER, userFrame("three")).answered;
    await told(superman.log, 2);
    assert.equal(heardIn(superman.log).filter((frame) => frame.includes('stage="warning"')).length, 2);
  });

  it("releases held frames the Leader's first, then the Workers', each in arrival order", async () => {
    const resets = RESETS();
    await fresh(readings(reading(0.96, { resets })));
    const ann = await seatUp(OTHER);
    await tell(WORKER, userFrame("one")).answered;
    for (const [seat, text] of [
      [WORKER, "to paul"],
      [LEADER, "to the leader"],
      [OTHER, "to ann"],
    ]) {
      assert.equal(JSON.parse((await page("POST", `/sessions/${seat}/message`, { text })).body).delivered, false);
    }
    // A held row waits on its panel, and reads delivered only once the release wrote it.
    const typedRows = () => [WORKER, LEADER, OTHER].map((seat) => panel(instance, seat).findLast((row) => row.from === "user" && row.typedTo === undefined).delivered);
    assert.deepEqual(typedRows(), [undefined, undefined, undefined], "a held row reads delivered before its frame went in");
    now = resets + 1;
    const before_ = said.length;
    tick(chat);
    // The order the writes were made in is the server's own act, read as it made them: three
    // processes reading three pipes cannot be ordered by their own clocks at this distance.
    assert.deepEqual(
      // The user-typed events to the Leader were held beside the messages; the messages are the order asked about.
      said.slice(before_).filter((line) => line.startsWith("released ") && line.endsWith(" - user")),
      [`released ${LEADER} - user`, `released ${WORKER} - user`, `released ${OTHER} - user`],
    );
    assert.ok((await told(superman.log, 3)).includes("<user>to the leader</user>"));
    assert.equal((await told(paul.log, 2)).at(-1), "<user>to paul</user>");
    assert.equal((await told(ann.log, 1)).at(-1), "<user>to ann</user>");
    assert.deepEqual(typedRows(), [true, true, true], "a released row is not marked delivered");
  });

  it("the interrupt patience bounds the wait: a run that ignores the interrupt still gets the critical frame", async () => {
    const resets = RESETS();
    await fresh({ OPENOVAI_STAND_IN_SLOW: "12000", OPENOVAI_STAND_IN_IGNORES_INTERRUPT: "1", ...readings(reading(0.96, { resets })) });
    const began = Date.now();
    tell(WORKER, userFrame("deaf"));
    const arrived = await waitFor(() => (readIn(paul.log).length >= 2 ? Date.now() - began : null));
    assert.ok(arrived !== null, "the critical frame was never written");
    assert.ok(arrived >= INTERRUPT_PATIENCE - 50, `written after ${arrived} ms, before the patience ran out`);
    assert.match(readIn(paul.log)[1], /^<server-event type="closing" why="quota"/);
  });

  it("holds a message to a stopped Leader before spawning it, and spawns once when the window resets", async () => {
    const resets = RESETS();
    await fresh(readings(reading(0.96, { resets })));
    await tell(WORKER, userFrame("one")).answered;
    await end(LEADER, 500);
    const spawns = readLog(unexpected);
    const held = await page("POST", `/sessions/${LEADER}/message`, { text: "wake up" });
    assert.equal(JSON.parse(held.body).delivered, false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(running(LEADER), false);
    assert.equal(readLog(unexpected), spawns);
    const woke = () => panel(instance, LEADER).findLast((row) => row.text === "wake up").delivered;
    assert.equal(woke(), undefined, "a row held before the spawn reads delivered");
    now = resets + 1;
    superman = await spawnedBy(LEADER, async () => {
      tick(chat);
      await waitFor(() => (running(LEADER) ? true : null));
    });
    assert.equal(callsIn(superman.log).length, 1);
    // The Worker's close for the spent window ended at its deadline meanwhile, and that is told too.
    assert.equal((await told(superman.log, 1))[0], "<user>wake up</user>");
    assert.equal(woke(), true, "the row is not marked delivered once the spawn took its frame");
  });

  it("holds at the write what was queued behind a turn before the window closed, and releases it in arrival order", async () => {
    const resets = RESETS();
    await fresh({ OPENOVAI_STAND_IN_SLOW: "1500", ...readings(reading(0.96, { resets })) }, { OPENOVAI_STAND_IN_SLOW: "1500" });
    const ann = await spawnedBy(OTHER, () => tool(superman.secret, "hire", { name: OTHER }));
    assert.equal(ann.result.refused, false, ann.result.text);
    const long = tell(LEADER, userFrame("long"));
    // Queued behind the Leader's turn while the window was open: the page was told it went in.
    assert.deepEqual(JSON.parse((await page("POST", `/sessions/${LEADER}/message`, { text: "behind" })).body), { delivered: true });
    tell(WORKER, userFrame("one"));
    assert.equal((await told(paul.log, 2)).at(-1).startsWith('<server-event type="closing" why="quota"'), true);
    // Told after the window closed: one behind the Worker's critical turn, one to an idle seat.
    assert.equal(JSON.parse((await page("POST", `/sessions/${WORKER}/message`, { text: "to paul" })).body).delivered, false);
    assert.equal(JSON.parse((await page("POST", `/sessions/${OTHER}/message`, { text: "to ann" })).body).delivered, false);
    assert.equal((await long.answered).text, "a reply");
    assert.equal((await told(superman.log, 2)).at(-1).startsWith('<server-event type="quota-low" stage="critical"'), true);
    // The Leader's critical turn over, "behind" is next — and held at the write, not written.
    // (The page's own events to the Leader about the two messages are held beside it.)
    const heldUser = (seat) => quota.held(seat).filter((entry) => entry.frame.kind === "user").length;
    assert.ok(await waitFor(() => (heldUser(LEADER) === 1 ? true : null)), "behind was not held at the write");
    assert.ok(await waitFor(() => (heldUser(WORKER) === 1 ? true : null)), "to paul was not held at the write");
    await settle();
    assert.ok(!heardIn(superman.log).includes("<user>behind</user>"), heardIn(superman.log).join("\n"));
    assert.ok(!heardIn(paul.log).includes("<user>to paul</user>"), heardIn(paul.log).join("\n"));
    assert.ok(!heardIn(ann.log).includes("<user>to ann</user>"), heardIn(ann.log).join("\n"));
    now = resets + 1;
    const before_ = said.length;
    tick(chat);
    // Arrival order, not the order the gate got to them: "to paul" was told before "to ann" and
    // held after it, behind a turn.
    assert.deepEqual(
      said.slice(before_).filter((line) => line.startsWith("released ") && line.endsWith(" - user")),
      [`released ${LEADER} - user`, `released ${WORKER} - user`, `released ${OTHER} - user`],
    );
    // The Leader's release is one queue in arrival order: "behind", then the page's two events.
    assert.deepEqual((await told(superman.log, 3)).slice(2), [
      "<user>behind</user>",
      `<server-event type="user-typed" who="${WORKER}">to paul</server-event>`,
      `<server-event type="user-typed" who="${OTHER}">to ann</server-event>`,
    ]);
    assert.equal((await told(paul.log, 3)).at(-1), "<user>to paul</user>");
    assert.equal((await told(ann.log, 2)).at(-1), "<user>to ann</user>");
    await end(OTHER, 500);
  });

  // A frame queued while the window was open drew nothing when it went in; held when its turn
  // came, it is said on the panel then, with what it is — or the seat reads as busy or ignoring.
  it("says on the panel what was held at the write, and what it is", async () => {
    const resets = RESETS();
    await fresh(readings(reading(0.96, { resets })), { OPENOVAI_STAND_IN_SLOW: "1500" });
    const rows = panel(instance, LEADER).length;
    const long = tell(LEADER, userFrame("long"));
    assert.deepEqual(JSON.parse((await page("POST", `/sessions/${LEADER}/message`, { text: "behind" })).body), { delivered: true });
    tell(LEADER, messageFrame(WORKER, "a note"));
    tell(WORKER, userFrame("one"));
    assert.equal((await told(paul.log, 2)).at(-1).startsWith('<server-event type="closing" why="quota"'), true);
    assert.equal((await long.answered).text, "a reply");
    const heldOnLeader = () => quota.held(LEADER).filter((entry) => entry.frame.kind !== "server-event").length;
    assert.ok(await waitFor(() => (heldOnLeader() === 2 ? true : null)), "behind and the note were not held at the write");
    const since = panel(instance, LEADER).slice(rows);
    const lines = since.filter((row) => row.from === SERVER && row.text.startsWith("limit exhausted"));
    assert.deepEqual(lines.map((row) => row.text), [
      `limit exhausted (5h window), reset at ${quota.hhmm(resets)}, your message is waiting`,
      `limit exhausted (5h window), reset at ${quota.hhmm(resets)}, the message from ${WORKER} is waiting`,
    ]);
    assert.ok(since.findIndex((row) => row.text === "behind") < since.indexOf(lines[0]), "the line came before the row it is about");
    now = resets + 1;
    tick(chat);
    assert.ok(await waitFor(() => (heardIn(superman.log).includes(`<message from="${WORKER}">a note</message>`) ? true : null)), heardIn(superman.log).join("\n"));
    await closedAtTheReset();
  });

  // A spent window holds every start until it resets, a successor's too: the Leader restarting
  // itself then is stopped instead. What arrived during its last turn is still on the queue when
  // the process ends, and is answered so; the next thing addressed to it after the reset starts it.
  it("a Leader's restart while the window is closed is a stop: no successor, the carried turns answered so", async () => {
    const resets = RESETS();
    await fresh({}, { OPENOVAI_STAND_IN_SLOW: "400", ...readings(reading(0.96, { resets })), ...callsThen("restart_session", 'stage="critical"') });
    const spawns = readLog(unexpected);
    tell(LEADER, userFrame("one"));
    assert.match((await told(superman.log, 2)).at(-1), /^<server-event type="quota-low" stage="critical"/);
    const carried = tell(LEADER, userFrame("carried"));
    assert.ok(await gone(LEADER), said.slice(-12).join("\n"));
    assert.equal(deskTitle(instance, LEADER), "restart_session by the stand-in");
    await settle();
    assert.equal(running(LEADER), false);
    assert.equal(readLog(unexpected), spawns, "a successor was started through the closed gate");
    assert.ok(said.includes(`restart ${LEADER} - no successor: stopped, 5h exhausted until ${new Date(resets).toISOString()}`), said.slice(-8).join("\n"));
    assert.deepEqual(await carried.answered, { ended: true, unread: true, text: `${LEADER} stopped: the 5h window is exhausted, reset at ${quota.hhmm(resets)}` });
  });

  // Fable's own weekly window reaches the gate from the usage endpoint (usage.mjs hands it in as
  // `saw("usage", ...)`, checked in tests/usage.test.mjs), never on a process's frame; here the
  // reading is handed in the same way while a fable Worker is mid-turn.
  it("fable's own window, read with nothing configured, touches seats on that model only", async () => {
    try {
      const resets = now + 3 * 24 * 60 * MINUTE;
      await fresh({});
      // The reading below is handed over in-process once the turn is heard, so what the turn has
      // to outlast is a synchronous call.
      const zed = await spawnedBy("Zed", () => tool(superman.secret, "hire", { name: "Zed", model: "fable" }), { OPENOVAI_STAND_IN_SLOW: "1200" });
      assert.equal(zed.result.refused, false, zed.result.text);
      assert.match(callsIn(zed.log)[0], /--model fable/);
      const busy = tell("Zed", userFrame("busy"));
      await told(zed.log, 1);
      quota.saw("usage", null, { unifiedWindows: { [quota.FABLE_WINDOW]: { utilization: 0.99, resetsAt: resets } } }, now);
      assert.deepEqual(await busy.answered, { interrupted: true, text: "interrupted" });
      const frames = await told(zed.log, 2);
      assert.match(frames[1], /^<server-event type="closing" why="quota" window="7d-fable" resets="[^"]+" model="fable" interrupted="true" deadline="\d+">/);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(heardIn(paul.log), []);
      assert.deepEqual(heardIn(superman.log), []);
      assert.equal(JSON.parse((await page("POST", `/sessions/${LEADER}/message`, { text: "opus goes" })).body).delivered, true);
      assert.deepEqual(await tool(superman.secret, "message", { to: "Zed", text: "fable is held" }), {
        text: `Zed has it; limit exhausted (7d-fable window), reset at ${quota.hhmm(resets)}, your message is waiting`,
        refused: false,
        error: null,
      });
      const bo = await spawnedBy("Bo", () => tool(superman.secret, "hire", { name: "Bo", model: "opus" }));
      assert.equal(bo.result.refused, false, bo.result.text);
      assert.match((await tool(superman.secret, "hire", { name: "Cy", model: "fable" })).text, /^held: quota \(7d-fable resets /);
      assert.equal(running("Cy"), false);
    } finally {
      await endEvery(500);
      quota.forget();
      for (const name of ["Zed", "Bo"]) {
        remove(path.join(instance, "desks", name), path.join(instance, "desks", name));
      }
    }
  });
});
