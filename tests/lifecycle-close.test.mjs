// The lifecycle, close: a Worker's session ended on somebody's word. The Worker is told `closing`,
// writes its desk in the turn that reads it, and the session ends when that turn is over — never
// in the middle of one: a close does not join a turn under way, it completes at a turn's end and
// not at the desk write, and its deadline runs from the turn that read it and waits for a turn to
// end.
//
// The fixture is tests/lifecycle-helpers.mjs. Every mutation in
// tests/mutations-lifecycle-close.json names the check it was written to redden.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { userFrame } from "../lib/chat/frames.mjs";
import { BODY_CLOSING, BODY_RESTARTED, close, tick } from "../lib/chat/lifecycle.mjs";
import { endEvery, recordOf, running, tell } from "../lib/chat/session.mjs";
import { deskTitle } from "../lib/desks.mjs";
import { heardIn, notesIn, readLog, waitFor } from "./helpers.mjs";

import { setup, LEADER, WORKER, OTHER, instance, said, chat, asked, told, gone, spawnedBy, writesDesk, settle, pair } from "./lifecycle-helpers.mjs";

let now = Date.now();
setup("lifecycle-close-test", () => now, { hired: [WORKER, OTHER] });

// A stand-in that, told it is closing, writes its desk and then does one thing more in the turn.
const DESK_THEN_MORE = {
  OPENOVAI_STAND_IN_TOOL: JSON.stringify([
    { name: "write_desk", arguments: { title: "a desk by the stand-in", status: "leaving" } },
    { name: "room", arguments: {} },
  ]),
  OPENOVAI_STAND_IN_TOOL_ON: 'type="closing"',
};

describe("close", () => {
  let superman = null;
  let paul = null;

  after(async () => {
    await endEvery(500);
  });

  it("completes when the turn that wrote the desk is over, after everything that turn did", async () => {
    ({ superman, paul } = await pair(DESK_THEN_MORE));
    const from = said.length;
    await close(chat, WORKER, "stop");
    assert.ok(await gone(WORKER), `${WORKER} was not closed`);
    assert.deepEqual(heardIn(paul.log), [`<server-event type="closing" why="stop">${BODY_CLOSING("stop", false, null)}</server-event>`]);
    const tools = notesIn(paul.log).filter(([label]) => label === "tool").map(([, rest]) => rest.split(" ")[0]);
    assert.deepEqual(tools, ["write_desk", "room"], readLog(paul.log));
    assert.ok(said.slice(from).includes(`stopped ${WORKER} - stop`), said.slice(from).join("\n"));
    assert.equal(deskTitle(instance, WORKER), "a desk by the stand-in");
  });

  it("to restart, hands the seat to a successor that starts on the desk", async () => {
    ({ superman, paul } = await pair(writesDesk('type="closing"')));
    const before_ = recordOf(WORKER);
    const successor = await spawnedBy(WORKER, async () => {
      await close(chat, WORKER, "restart");
      await waitFor(() => (recordOf(WORKER) !== undefined && recordOf(WORKER) !== before_ ? true : null));
    });
    assert.deepEqual(await told(successor.log, 1), [`<server-event type="restarted">${BODY_RESTARTED}</server-event>`]);
    assert.ok(said.includes(`stopped ${WORKER} - restart`), said.slice(-8).join("\n"));
    assert.equal(deskTitle(instance, WORKER), "a desk by the stand-in");
  });

  it("never joins a turn under way: a line typed after it waits with it, and the close is what that turn asks", async () => {
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_CALLS: JSON.stringify([[{ name: "Bash", input: { command: "make" } }]]), OPENOVAI_STAND_IN_CALL_HOLDS: "600" }));
    const busy = tell(WORKER, userFrame("busy"));
    assert.ok(await waitFor(() => (recordOf(WORKER)?.open.size > 0 ? true : null)), "the call never went out");
    const from = said.length;
    await close(chat, WORKER, "stop");
    tell(WORKER, userFrame("typed"));
    await busy.answered;
    assert.deepEqual((await told(paul.log, 3)).slice(1), [`<server-event type="closing" why="stop">${BODY_CLOSING("stop", false, null)}</server-event>`, "<user>typed</user>"]);
    assert.ok(!readLog(paul.log).includes("joined:"), readLog(paul.log));
    assert.ok(said.slice(from).some((row) => /^wrote Paul - queue x2 \(#\d+\.\.#\d+: closing event, user\), 0 waiting$/.test(row)), said.slice(from).join("\n"));
    await settle();
    assert.equal(recordOf(WORKER).askedWhy, "close:stop");
    assert.equal(running(WORKER), true);
  });

  it("holds through a message, and completes at the later turn that writes the desk", async () => {
    ({ superman, paul } = await pair(writesDesk("wrap up")));
    await close(chat, WORKER, "stop");
    await told(paul.log, 1);
    await settle();
    assert.equal(recordOf(WORKER).askedWhy, "close:stop");
    assert.equal(running(WORKER), true, "closed with no desk written");
    const from = said.length;
    await asked(superman.secret, WORKER, "wrap up");
    assert.ok(await gone(WORKER), `${WORKER} was not closed once its desk was written`);
    assert.ok(said.slice(from).includes(`stopped ${WORKER} - stop`), said.slice(from).join("\n"));
  });

  it("completes at once, the desk as it was, when the turn that reads it dies at the service", async () => {
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_FAILS: "[false, true]" }));
    await asked(superman.secret, WORKER, "go");
    await asked(superman.secret, WORKER, "again");
    assert.ok(await waitFor(() => (heardIn(superman.log).some((frame) => frame.startsWith('<server-event type="died"')) ? true : null)), heardIn(superman.log).join("\n"));
    const from = said.length;
    await close(chat, WORKER, "stop");
    assert.ok(await gone(WORKER), `${WORKER} was left running on a close whose turn died`);
    assert.ok(said.slice(from).includes(`stopped ${WORKER} - stop`), said.slice(from).join("\n"));
    assert.equal(heardIn(superman.log).filter((frame) => frame.startsWith('<server-event type="died"')).length, 1, "the closing turn's death was told as a death");
  });

  it("has a deadline that runs from the turn that read it and waits for a turn to end", async () => {
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_WAITS: "1500" }));
    const busy = tell(WORKER, userFrame("busy"));
    await told(paul.log, 1);
    const ordered = now;
    await close(chat, WORKER, "stop", { deadline: 60 });
    // Past the deadline from the order, the close not read yet: nothing to end.
    now = ordered + 61_000;
    tick(chat);
    await settle();
    assert.equal(running(WORKER), true, "ended before the close was read");
    await busy.answered;
    // The close is read now, and its own turn waits on a button for a while.
    assert.ok(await waitFor(() => (recordOf(WORKER).askedWhy === "close:stop" && recordOf(WORKER).turn !== null ? true : null)), "the close was never read");
    now += 61_000;
    tick(chat);
    await settle();
    assert.equal(running(WORKER), true, "the deadline cut the turn that read the close");
    assert.ok(await waitFor(() => (recordOf(WORKER).turn === null ? true : null)), "the closing turn never ended");
    const from = said.length;
    tick(chat);
    assert.ok(await gone(WORKER), `${WORKER} was not ended at the deadline`);
    assert.ok(said.slice(from).includes(`closed ${WORKER} - stop at the deadline, no desk written`), said.slice(from).join("\n"));
    assert.ok(said.slice(from).includes(`stopped ${WORKER} - stop-deadline`), said.slice(from).join("\n"));
    assert.equal(running(LEADER), true);
  });
});
