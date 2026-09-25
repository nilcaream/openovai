// The lifecycle, idle: what the Leader is told about an idle Worker, the ask to write the desk and
// stop, the forced ending, and an advisory beside a pending ask.
//
// The fixture is tests/lifecycle-helpers.mjs. Every mutation in
// tests/mutations-lifecycle-idle.json names the check it was written to redden.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { serverEvent, userFrame } from "../lib/chat/frames.mjs";
import { BODY_CLOSING, BODY_CONTEXT_WARNING, BODY_IDLE, IDLE_GRACE, deliver, idleOf, tick } from "../lib/chat/lifecycle.mjs";
import { endEvery, recordOf, running, tell } from "../lib/chat/session.mjs";
import { deskTitle } from "../lib/desks.mjs";
import { alive, callsIn, heardIn, pidsIn, readLog, waitFor } from "./helpers.mjs";

import { setup, LEADER, WORKER, OTHER, MINUTE, instance, unexpected, said, chat, server, seatUp, asked, told, toldUntil, readIn, gone, callsThen, writesDesk, settle, pair, awake, A_CONTEXT } from "./lifecycle-helpers.mjs";

let now = Date.now();
// What a Worker idle for 55 minutes is told: its session is closing, its desk given the grace.
const IDLE_CLOSING = `<server-event type="closing" why="idle" deadline="${IDLE_GRACE * 60}">${BODY_CLOSING("idle", false, IDLE_GRACE * 60)}</server-event>`;
// Ann is hired before the first check: these checks start her without a hire of their own, as
// they did when they ran after the ones that hire her.
setup("lifecycle-idle-test", () => now, { hired: [WORKER, OTHER] });

// ---------------------------------------------------------------------------------------------

// An event that asks nothing is the server talking to a seat it may already be waiting on, so it
// must not cancel the server's own ending: the ask it finds is the ask it leaves. A turn of the
// User's or a message still reprieves — that is the check in `idle` below, and the two rules live
// side by side.
describe("an advisory and a pending ask", () => {
  let superman = null;
  let paul = null;

  after(async () => {
    await endEvery(500);
  });

  it("a context warning behind the critical idle ask does not spare the seat", async () => {
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_USAGE: A_CONTEXT }));
    await awake(WORKER);
    const idleFrom = now;
    now = idleFrom + 50 * MINUTE;
    await awake(LEADER);
    now = idleFrom + 55 * MINUTE;
    tick(chat);
    assert.equal((await told(paul.log, 2)).at(-1), IDLE_CLOSING);
    // The advisory, delivered the way `turned` delivers it: no ask at all.
    const warning = serverEvent(
      "context",
      { stage: "warning", context: "211204", warning: "200000", step: "20000", error: "300000" },
      BODY_CONTEXT_WARNING,
    );
    await deliver(chat, WORKER, warning).answered;
    assert.equal((await told(paul.log, 3)).at(-1), warning.text);
    now = idleFrom + (55 + IDLE_GRACE + 1) * MINUTE;
    tick(chat);
    assert.ok(await gone(WORKER), `${WORKER} was spared by an event that asks nothing`);
    // The Leader is woken at 50 so that only the Worker ages to the forced ending; it has its own
    // turn and the two FYIs about the Worker behind it, so the ending is waited for, not counted.
    const stopped = `<server-event type="stopped" who="${WORKER}" why="idle-forced"/>`;
    const frames = await toldUntil(superman.log, stopped);
    assert.ok(frames.includes(stopped), frames.join("\n"));
  });
});

// The clocks are the instance's: `now` is jumped and `tick` is called by hand. The server's own
// ticker runs on the same frozen clock, so a tick of its own in between changes nothing.
describe("idle", () => {
  let superman = null;
  let paul = null;

  after(async () => {
    await endEvery(500);
  });

  it("tells the Leader at 10 and at 50, the seat at 55, and ends it at 60 with the Leader told why", async () => {
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_USAGE: A_CONTEXT }));
    await awake(WORKER);
    const idleFrom = now;
    now = idleFrom + 10 * MINUTE;
    tick(chat);
    tick(chat);
    assert.deepEqual(await told(superman.log, 1), [`<server-event type="idle" who="${WORKER}" minutes="10"/>`]);
    await settle();
    assert.equal(heardIn(superman.log).length, 1, "the 10-minute FYI was repeated");
    now = idleFrom + 50 * MINUTE;
    tick(chat);
    tick(chat);
    assert.equal((await told(superman.log, 2)).at(-1), `<server-event type="idle" who="${WORKER}" minutes="50" cold-in="10" context="118400"/>`);
    await settle();
    assert.equal(heardIn(superman.log).length, 2, "the 50-minute FYI was repeated");
    assert.deepEqual(heardIn(paul.log), ["<user>stay awake</user>"]);
    now = idleFrom + 55 * MINUTE;
    tick(chat);
    tick(chat);
    assert.equal((await told(paul.log, 2)).at(-1), IDLE_CLOSING);
    await settle();
    assert.equal(heardIn(paul.log).length, 2, "the critical frame was repeated");
    assert.equal(running(WORKER), true);
    now = idleFrom + 60 * MINUTE;
    tick(chat);
    assert.ok(await gone(WORKER), `${WORKER} was not ended`);
    assert.ok(await waitFor(() => !alive(pidsIn(paul.log)[0])), "the process is still alive");
    assert.equal((await told(superman.log, 3)).at(-1), `<server-event type="stopped" who="${WORKER}" why="idle-forced"/>`);
    assert.ok(said.includes(`stopped ${WORKER} - idle-forced`), said.slice(-6).join("\n"));
  });

  it("the Leader hears a Worker's forced stop when both are ended in one tick, the Worker first", async () => {
    // The Leader does not close on its stdin, so it is still ending — taken down once patience
    // has run out — when the Worker's stop is delivered to it: the order in which the FYI was lost.
    ({ superman, paul } = await pair({}, { OPENOVAI_STAND_IN_STUCK: "1" }));
    await awake(WORKER);
    await awake(LEADER);
    const from = said.length;
    const idleFrom = now;
    now = idleFrom + 55 * MINUTE;
    tick(chat);
    await told(paul.log, 2);
    await told(superman.log, 2);
    await settle();
    now = idleFrom + (55 + IDLE_GRACE + 1) * MINUTE;
    tick(chat);
    assert.ok(await gone(WORKER), `${WORKER} was not ended`);
    const rows = () => said.slice(from);
    const heard = await waitFor(() => rows().some((row) => row.startsWith(`wrote ${LEADER} `) && row.includes("stopped event")));
    assert.ok(heard, rows().join("\n"));
    assert.ok(rows().includes(`redelivered ${LEADER} - stopped event, unread by the session that ended`), rows().join("\n"));
    assert.ok(rows().indexOf(`stopped ${WORKER} - idle-forced`) < rows().indexOf(`stopped ${LEADER} - idle-forced`), rows().join("\n"));
  });

  it("the stopped FYI follows a voluntary idle stop too", async () => {
    ({ superman, paul } = await pair(writesDesk('type="closing"')));
    const idleFrom = now;
    now = idleFrom + 50 * MINUTE;
    await awake(LEADER);
    now = idleFrom + 55 * MINUTE;
    tick(chat);
    assert.ok(await gone(WORKER), `${WORKER} did not stop`);
    const frames = await waitFor(() => (heardIn(superman.log).some((frame) => frame.startsWith("<server-event type=\"stopped\"")) ? heardIn(superman.log) : null));
    assert.ok(frames !== null, "the Leader was never told");
    assert.ok(frames.includes(`<server-event type="stopped" who="${WORKER}" why="idle"/>`), frames.join("\n"));
    assert.equal(deskTitle(instance, WORKER), "a desk by the stand-in");
  });

  // What the service says when it will not take a turn at all, as Claude Code passes it on: the
  // sentence is the only thing that names what to do about it.
  const DEAD = "There's an issue with the selected model (claude-opus-9-9). It may not exist or you may not have access to it.";

  // A seat whose first turn dies has never worked and never will: it is ended, and the Leader
  // learns it through the event it already knows, the service's sentence as the body.
  it("tells the Leader a Worker stopped when its first turn came back an error, in the service's own words", async () => {
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_FAILS: "1", OPENOVAI_STAND_IN_REPLY: DEAD }));
    const going = asked(superman.secret, WORKER, "go").catch(() => null);
    assert.ok(await gone(WORKER), `${WORKER} was not ended`);
    assert.deepEqual(await told(superman.log, 1), [`<server-event type="stopped" who="${WORKER}" why="first-turn-failed">${DEAD}</server-event>`]);
    assert.ok(said.includes(`died ${WORKER} - ${DEAD}`), said.slice(-6).join("\n"));
    await going;
  });

  // A seat that has worked may be over a failure that passes: it lives, and the Leader is told
  // once for a run of dead turns and decides. The idle clock stays where the last answered turn
  // left it, so a seat whose turns all die still drifts to the idle ending.
  it("keeps a Worker whose later turns die, tells the Leader once for the run, and leaves the idle clock alone", async () => {
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_FAILS: "[false, true, true]", OPENOVAI_STAND_IN_REPLY: DEAD }));
    assert.equal((await asked(superman.secret, WORKER, "go")).reply, DEAD);
    const idleSince = recordOf(WORKER).idleSince;
    const from = said.length;
    now = now + 20 * MINUTE;
    await asked(superman.secret, WORKER, "again").catch(() => null);
    assert.ok(await waitFor(() => (said.slice(from).includes(`died ${WORKER} - ${DEAD}`) ? true : null)), said.slice(from).join("\n"));
    assert.deepEqual(await told(superman.log, 1), [`<server-event type="died" who="${WORKER}">${DEAD}</server-event>`]);
    await asked(superman.secret, WORKER, "once more").catch(() => null);
    assert.ok(await waitFor(() => (said.slice(from).filter((row) => row === `died ${WORKER} - ${DEAD}`).length === 2 ? true : null)), said.slice(from).join("\n"));
    await settle();
    assert.equal(heardIn(superman.log).length, 1, "the Leader was told again within one run of dead turns");
    assert.equal(recordOf(WORKER).idleSince, idleSince, "a dead turn put the idle clock back to now");
    assert.equal(running(WORKER), true);
  });

  // A turn the run begins itself — a CronCreate tick is one: its own system/init and result with
  // nothing written to stdin (measured on 2.1.280) — is activity like any other, so the idle clock
  // counts from its result, and a Leader kept busy by its own ticks never reaches the idle ending.
  it("counts a turn the Leader began itself as activity: the idle clock starts again at its result", async () => {
    await endEvery(500);
    await seatUp(LEADER, { OPENOVAI_STAND_IN_SELF_STARTS: "400" });
    await awake(LEADER);
    const idleFrom = now;
    // The tick's turn ends 50 minutes after the last turn anybody wrote.
    now = idleFrom + 50 * MINUTE;
    assert.ok(await waitFor(() => (recordOf(LEADER).idleSince !== idleFrom ? true : null)), "the self-started turn did not move the idle clock");
    assert.equal(recordOf(LEADER).idleSince, idleFrom + 50 * MINUTE);
    now = idleFrom + 60 * MINUTE;
    assert.equal(idleOf(LEADER, now), 10);
    tick(chat);
    await settle();
    assert.equal(running(LEADER), true, "the Leader was ended idle, counted from before its own turn");
  });

  it("a seat on a turn is not idle, however long the turn: a pending permission at 55 gets no critical frame", async () => {
    // The ask stays pending for as long as the checks below need it: two clock jumps, two ticks
    // and a settle. Waiting longer than that proves nothing further.
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_WAITS: "2000" }));
    await awake(WORKER);
    const idleFrom = now;
    now = idleFrom + 50 * MINUTE;
    await awake(LEADER);
    const asking_ = tell(WORKER, userFrame("may I"));
    assert.ok(await waitFor(() => (heardIn(paul.log).length === 2 ? true : null)));
    now = idleFrom + 55 * MINUTE;
    tick(chat);
    tick(chat);
    await settle();
    assert.ok(!heardIn(paul.log).some((frame) => frame.includes('type="closing"')), heardIn(paul.log).join("\n"));
    assert.ok(!readIn(paul.log).some((frame) => frame.includes('type="closing"')), readIn(paul.log).join("\n"));
    assert.equal(running(WORKER), true);
    assert.ok(alive(pidsIn(paul.log)[0]));
    // Nor past the force and the grace, the button still up: a Worker waiting on a button is
    // never forced idle, and the Leader hears no idle event about it.
    now = idleFrom + (55 + IDLE_GRACE + 1) * MINUTE;
    assert.notEqual(recordOf(WORKER).turn, null, "the ask's turn ended before the clock was read");
    tick(chat);
    tick(chat);
    await settle();
    assert.ok(!readIn(paul.log).some((frame) => frame.includes('type="closing"')), readIn(paul.log).join("\n"));
    assert.ok(!heardIn(superman.log).some((frame) => frame.includes('type="idle"')), heardIn(superman.log).join("\n"));
    assert.equal(recordOf(WORKER).ending, null);
    assert.equal(running(WORKER), true);
    assert.ok(alive(pidsIn(paul.log)[0]));
    // Nor once the turn is over: nothing was queued behind it, and nothing was asked of the seat.
    await asking_.answered;
    await settle();
    assert.ok(!readIn(paul.log).some((frame) => frame.includes('type="closing"')), readIn(paul.log).join("\n"));
    assert.equal(recordOf(WORKER).askedWhy, null);
  });

  it("a turn after the ask is a reprieve: asked at 55, given work at 57, alive at 60 with the ask gone", async () => {
    ({ superman, paul } = await pair());
    await awake(WORKER);
    const idleFrom = now;
    now = idleFrom + 50 * MINUTE;
    await awake(LEADER);
    now = idleFrom + 55 * MINUTE;
    tick(chat);
    assert.equal((await told(paul.log, 2)).at(-1), IDLE_CLOSING);
    await settle();
    assert.equal(recordOf(WORKER).askedWhy, "close:idle");
    now = idleFrom + 57 * MINUTE;
    assert.equal((await asked(superman.secret, WORKER, "one more thing")).reply, "a reply");
    assert.equal(recordOf(WORKER).askedWhy, null);
    assert.equal(recordOf(WORKER).askedAt, null);
    now = idleFrom + 60 * MINUTE;
    tick(chat);
    tick(chat);
    await settle();
    assert.equal(running(WORKER), true);
    assert.equal(recordOf(WORKER).ending, null);
    assert.ok(alive(pidsIn(paul.log)[0]));
    assert.ok(!heardIn(superman.log).some((frame) => frame.startsWith('<server-event type="stopped"')), heardIn(superman.log).join("\n"));
  });

  it("the ask's own turn is never cut short: a permission pending at 60 keeps the seat, ended once the turn is over", async () => {
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_WAITS: "2500" }));
    const idleFrom = now;
    now = idleFrom + 50 * MINUTE;
    await awake(LEADER);
    now = idleFrom + 55 * MINUTE;
    tick(chat);
    assert.deepEqual(await told(paul.log, 1), [IDLE_CLOSING]);
    assert.ok(await waitFor(() => (callsIn(paul.log).length > 0 && recordOf(WORKER).turn !== null ? true : null)), "no turn on the ask");
    now = idleFrom + 60 * MINUTE;
    tick(chat);
    tick(chat);
    await settle();
    assert.equal(running(WORKER), true);
    assert.equal(recordOf(WORKER).ending, null);
    assert.notEqual(recordOf(WORKER).turn, null);
    assert.ok(alive(pidsIn(paul.log)[0]));
    // The turn over — the permission given up on — and the ask still standing: ended.
    assert.ok(await waitFor(() => (recordOf(WORKER).turn === null ? true : null)), "the ask's turn never ended");
    tick(chat);
    assert.ok(await gone(WORKER), `${WORKER} was not ended once its turn was over`);
    // The Leader has its own turn and the two FYIs about the Worker behind it, so the ending is
    // waited for, not counted.
    const stopped = `<server-event type="stopped" who="${WORKER}" why="idle-forced"/>`;
    const frames = await toldUntil(superman.log, stopped);
    assert.ok(frames.includes(stopped), frames.join("\n"));
  });

  // The Leader is still asked and ended the old way, and the same holds for it: its own turn on the
  // ask runs to its end.
  it("the Leader's idle ask never cuts its own turn short: a permission pending at 60 keeps it, ended once the turn is over", async () => {
    await endEvery(500);
    superman = await seatUp(LEADER, { OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_WAITS: "2500" });
    const idleFrom = now;
    now = idleFrom + 55 * MINUTE;
    tick(chat);
    assert.deepEqual(await told(superman.log, 1), [`<server-event type="idle" stage="critical" minutes="55">${BODY_IDLE(55)}</server-event>`]);
    assert.ok(await waitFor(() => (callsIn(superman.log).length > 0 && recordOf(LEADER).turn !== null ? true : null)), "no turn on the ask");
    now = idleFrom + 60 * MINUTE;
    tick(chat);
    tick(chat);
    await settle();
    assert.equal(running(LEADER), true);
    assert.equal(recordOf(LEADER).ending, null);
    assert.ok(await waitFor(() => (recordOf(LEADER).turn === null ? true : null)), "the ask's turn never ended");
    tick(chat);
    assert.ok(await gone(LEADER), `${LEADER} was not ended once its turn was over`);
  });

  it("the Leader has no 10 and no 50, and the critical frame at 55", async () => {
    await endEvery(500);
    superman = await seatUp(LEADER);
    const idleFrom = now;
    now = idleFrom + 50 * MINUTE;
    tick(chat);
    tick(chat);
    await settle();
    assert.deepEqual(heardIn(superman.log), []);
    assert.equal(readLog(unexpected).includes(`who="${LEADER}"`), false);
    now = idleFrom + 55 * MINUTE;
    tick(chat);
    assert.deepEqual(await told(superman.log, 1), [`<server-event type="idle" stage="critical" minutes="55">${BODY_IDLE(55)}</server-event>`]);
  });

  it("a message resets the idle clock", async () => {
    ({ superman, paul } = await pair());
    await awake(WORKER);
    const idleFrom = now;
    now = idleFrom + 40 * MINUTE;
    tick(chat);
    await told(superman.log, 1);
    assert.equal((await asked(superman.secret, WORKER, "still there?")).reply, "a reply");
    now = idleFrom + 60 * MINUTE;
    await awake(LEADER);
    tick(chat);
    tick(chat);
    await settle();
    assert.ok(!heardIn(paul.log).some((frame) => frame.includes('type="closing"')), heardIn(paul.log).join("\n"));
    assert.ok(!heardIn(superman.log).some((frame) => frame.startsWith('<server-event type="stopped"')), heardIn(superman.log).join("\n"));
    assert.equal(running(WORKER), true);
    now = idleFrom + 40 * MINUTE + 55 * MINUTE;
    tick(chat);
    assert.ok(await waitFor(() => (heardIn(paul.log).some((frame) => frame.includes('type="closing"')) ? true : null)), heardIn(paul.log).join("\n"));
    assert.equal(heardIn(paul.log).at(-1), IDLE_CLOSING);
  });
});
