// The lifecycle, the seats: how seats are started — the Leader by whatever is addressed to it,
// Workers by hire and by their own restart; write_desk, restart_session and stop_session; the
// context events and sizes; the instance's own tools.
//
// The fixture is tests/lifecycle-helpers.mjs. Every mutation in
// tests/mutations-lifecycle.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { SERVER, read } from "../lib/chat/conversation.mjs";
import { userFrame } from "../lib/chat/frames.mjs";
import { BODY_CLOSING, BODY_CONTEXT_ERROR, BODY_CONTEXT_WARNING, BODY_CONTEXT_WORKER, BODY_RESTARTED } from "../lib/chat/lifecycle.mjs";
import { wallClock } from "../lib/chat/log.mjs";
import * as quota from "../lib/chat/quota.mjs";
import * as usage from "../lib/chat/usage.mjs";
import { home } from "../lib/claude.mjs";
import { end, endEvery, recordOf, running, runningSeats, tell } from "../lib/chat/session.mjs";
import { deskFile, deskTitle, hire } from "../lib/desks.mjs";
import { callsIn, childrenOf, heardIn, installed, post as postPlain, queuesHeardIn, readLog, remove, secretsIn, startChat, stopChat, waitFor, waitForAddress, writeStandIn } from "./helpers.mjs";

import { setup, LEADER, WORKER, OTHER, WORKER_MODEL, MINUTE, panel, base, instance, unexpected, options, reading, said, chat, server, seatUp, spawnedBy, page, call, tool, asked, told, besideBirth, gone, callsThen, writesDesk, deskOf, sessionsListed, settle, pair } from "./lifecycle-helpers.mjs";

let now = Date.now();
setup("lifecycle-test", () => now);

// ---------------------------------------------------------------------------------------------

describe("serving", () => {
  it("does not start the Leader with the server", () => {
    assert.deepEqual(runningSeats(), []);
    assert.equal(readLog(unexpected), "");
  });

  // Every window has a default threshold pair, the per-model one included, so an instance that
  // names none has nothing to be told about at start.
  it("says nothing about the quota windows at the start", () => {
    // A row about a window would name it first in its text, after the three columns.
    assert.deepEqual(said.filter((line) => /^\S+ \S+ \S+ (5h|7d|7d-fable)\b/.test(line)), []);
  });
});

describe("starting a seat", () => {
  let superman = null;
  let paul = null;

  after(async () => {
    await endEvery(500);
  });

  it("starts a stopped Leader for a page message, the message its first line", async () => {
    assert.equal(running(LEADER), false);
    superman = await spawnedBy(LEADER, () => page("POST", `/sessions/${LEADER}/message`, { text: "hi" }));
    assert.deepEqual(JSON.parse(superman.result.body), { delivered: true });
    assert.equal(callsIn(superman.log).length, 1);
    assert.deepEqual(await told(superman.log, 1), ["<user>hi</user>"]);
  });

  it("never starts a Worker for a message", async () => {
    assert.equal(running(WORKER), false);
    const before_ = readLog(unexpected);
    const answered = await tool(superman.secret, "message", { to: WORKER, text: "wake up" });
    assert.deepEqual(answered, { text: `${WORKER} has no process`, refused: true, error: null });
    assert.equal(readLog(unexpected), before_);
    assert.equal(running(WORKER), false);
  });

  it("hire opens a desk once and starts; again is already running; after a stop it starts on the desk as it is", async () => {
    assert.equal(fs.existsSync(deskFile(instance, OTHER)), false);
    const ann = await spawnedBy(OTHER, () => tool(superman.secret, "hire", { name: OTHER }));
    assert.deepEqual(ann.result, { text: `${OTHER} started on the desk desks/${OTHER} (${WORKER_MODEL})`, refused: false, error: null });
    assert.ok(fs.existsSync(deskFile(instance, OTHER)));
    assert.equal(callsIn(ann.log).length, 1);
    assert.deepEqual(await tool(superman.secret, "hire", { name: OTHER }), { text: `${OTHER} is already running`, refused: true, error: null });
    // The desk as it was, below the header the server keeps.
    const body = deskOf(OTHER).split("\n").slice(1).join("\n");
    await end(OTHER, 500);
    const again = await spawnedBy(OTHER, () => tool(superman.secret, "hire", { name: OTHER }));
    assert.equal(again.result.refused, false);
    assert.equal(callsIn(again.log).length, 1);
    assert.equal(deskOf(OTHER).split("\n").slice(1).join("\n"), body);
    await end(OTHER, 500);
  });

  // Named nobody, a hire is called from the roster: the first free name of the pool, least
  // recently used first. Paul has a desk here, so the next is Jane. The Leader is told the name
  // in the answer, the way it is told a name it chose.
  it("hire without a name takes the next free name of the roster", async () => {
    assert.equal(fs.existsSync(deskFile(instance, "Jane")), false);
    assert.ok(fs.existsSync(deskFile(instance, WORKER)));
    const jane = await spawnedBy("Jane", () => tool(superman.secret, "hire", {}));
    assert.deepEqual(jane.result, { text: `Jane started on the desk desks/Jane (${WORKER_MODEL})`, refused: false, error: null });
    assert.ok(fs.existsSync(deskFile(instance, "Jane")));
    await end("Jane", 500);
  });

  it("hire refuses a name that is not one, and the Leader's own", async () => {
    assert.deepEqual(await tool(superman.secret, "hire", { name: "not a name" }), { text: '"not a name" is not a name here', refused: true, error: null });
    assert.deepEqual(await tool(superman.secret, "hire", { name: LEADER }), { text: `${LEADER} is the Leader`, refused: true, error: null });
  });

  it("hire is the Leader's: a Worker is refused and nothing is spawned", async () => {
    paul = await seatUp(WORKER);
    const before_ = readLog(unexpected);
    assert.deepEqual(await tool(paul.secret, "hire", { name: "Zed" }), { text: "hire is not offered to you", refused: true, error: null });
    assert.equal(readLog(unexpected), before_);
    assert.equal(fs.existsSync(deskFile(instance, "Zed")), false);
  });

  // The log had a seat's stop and never its start, so a day could not be read back. Two rows, and
  // the one fact that tells them apart — whether the desk was already there — is known where the
  // hire tests for it and nowhere afterwards. Kit is outside the roster, so this disturbs no name
  // the pool hands out.
  it("writes a hired row with the model and whether the desk was new or one the Worker had", async () => {
    try {
      assert.equal(fs.existsSync(deskFile(instance, "Kit")), false);
      const logged = said.length;
      const first = await spawnedBy("Kit", () => tool(superman.secret, "hire", { name: "Kit" }));
      assert.equal(first.result.refused, false, first.result.text);
      await end("Kit", 500);
      const back = await spawnedBy("Kit", () => tool(superman.secret, "hire", { name: "Kit" }));
      assert.equal(back.result.refused, false, back.result.text);
      assert.deepEqual(said.slice(logged).filter((line) => line.startsWith("hired ")), [
        `hired Kit - ${WORKER_MODEL} on a new desk`,
        `hired Kit - ${WORKER_MODEL} on the desk it had`,
      ]);
    } finally {
      await end("Kit", 500);
      remove(path.join(instance, "desks", "Kit"));
    }
  });

  // A model given to a hire on a desk that exists is the Leader's word now, and it outranks what
  // the desk was hired on before; left out, the desk's own stands.
  it("hire on a desk the Worker had: a given model replaces the desk's, and without one the desk's stands", async () => {
    const modelOf = () => fs.readFileSync(path.join(instance, "desks", "Lou", "MODEL"), "utf8");
    try {
      const first = await spawnedBy("Lou", () => tool(superman.secret, "hire", { name: "Lou", model: "model-a" }));
      assert.equal(first.result.refused, false, first.result.text);
      await end("Lou", 500);
      const moved = await spawnedBy("Lou", () => tool(superman.secret, "hire", { name: "Lou", model: "model-b" }));
      assert.equal(moved.result.text, "Lou started on the desk desks/Lou (model-b)");
      assert.equal(modelOf(), "model-b\n");
      await end("Lou", 500);
      const kept = await spawnedBy("Lou", () => tool(superman.secret, "hire", { name: "Lou" }));
      assert.equal(kept.result.text, "Lou started on the desk desks/Lou (model-b)");
      assert.equal(modelOf(), "model-b\n");
    } finally {
      await end("Lou", 500);
      remove(path.join(instance, "desks", "Lou"));
    }
  });

});

describe("write_desk", () => {
  let superman = null;
  let paul = null;

  before(async () => {
    superman = await seatUp(LEADER);
    paul = await seatUp(WORKER);
  });

  after(async () => {
    await endEvery(500);
  });

  it("writes its own desk's header only, the body below it exactly as it stands", async () => {
    const leaderDesk = deskOf(LEADER);
    const refused = await tool(paul.secret, "write_desk", { name: LEADER, title: "t", status: "s" });
    assert.equal(refused.refused, true);
    assert.equal(refused.text, "write_desk: name is not an argument it takes");
    assert.equal(deskOf(LEADER), leaderDesk);
    assert.equal((await tool(paul.secret, "write_desk", { title: "t", status: "s", body: "B" })).text, "write_desk: body is not an argument it takes");

    // The body is edited in place, like any file: a line changed with a file tool is what the
    // next write_desk keeps, byte for byte, below a header that is the server's alone.
    const before = deskOf(WORKER).split("\n");
    const edited = [before[0], ...before.slice(1), "## State", "edited in place, <!-- DESK | title: posed --> and all", ""].join("\n");
    fs.writeFileSync(deskFile(instance, WORKER), edited);
    const written = await tool(paul.secret, "write_desk", { title: " t ", status: "s" });
    assert.equal(written.refused, false, written.text);
    assert.match(written.text, new RegExp(`^desk header written: desks/${WORKER}/STATE.md \\(title and status; the body as it stands\\)$`));
    const lines = deskOf(WORKER).split("\n");
    assert.match(lines[0], /^<!-- DESK \| title: t \| status: s \| updated: \d{4}-\d{2}-\d{2}T[0-9:.]+Z -->$/);
    assert.equal(lines.slice(1).join("\n"), edited.split("\n").slice(1).join("\n"));
    assert.equal(lines[1], `# ${WORKER}`);
    assert.equal(deskTitle(instance, WORKER), "t");
  });

  it("puts the header back in front of a body that lost it, losing no line", async () => {
    fs.writeFileSync(deskFile(instance, WORKER), `# ${WORKER}\n\n## State\nthe header went\n`);
    assert.equal(deskTitle(instance, WORKER), "");
    const written = await tool(paul.secret, "write_desk", { title: "healed", status: "s" });
    assert.equal(written.refused, false, written.text);
    const lines = deskOf(WORKER).split("\n");
    assert.match(lines[0], /^<!-- DESK \| title: healed \| status: s \| updated: /);
    assert.deepEqual(lines.slice(1), [`# ${WORKER}`, "", "## State", "the header went", ""]);
  });

  it("refuses an empty title and a status with a |, leaving the desk as it was", async () => {
    await tool(paul.secret, "write_desk", { title: "kept", status: "kept" });
    const kept = deskOf(WORKER);
    assert.deepEqual(await tool(paul.secret, "write_desk", { title: "", status: "s" }), { text: "title is empty", refused: true, error: null });
    assert.equal(deskOf(WORKER), kept);
    assert.deepEqual(await tool(paul.secret, "write_desk", { title: "t", status: "a | b" }), { text: "status has a | in it; the header uses | between its fields", refused: true, error: null });
    assert.equal(deskOf(WORKER), kept);
  });

  it("is listed for both roles; a session's own ending and the orders to end one are the Leader's, done the Worker's", async () => {
    const forLeader = JSON.parse((await call(superman.secret, "tools/list")).body).result.tools.map((entry) => entry.name);
    const forPaul = JSON.parse((await call(paul.secret, "tools/list")).body).result.tools.map((entry) => entry.name);
    assert.ok(forLeader.includes("write_desk") && forPaul.includes("write_desk"));
    for (const name of ["restart_session", "stop_session", "stop_worker", "restart_worker", "park", "hire"]) {
      assert.ok(forLeader.includes(name) && !forPaul.includes(name), name);
    }
    assert.ok(forPaul.includes("done") && !forLeader.includes("done"));
    for (const name of ["park", "stop_session", "restart_session", "stop_worker"]) {
      assert.deepEqual(await tool(paul.secret, name, name === "stop_worker" ? { name: OTHER } : {}), { text: `${name} is not offered to you`, refused: true, error: null });
    }
    assert.deepEqual(await tool(superman.secret, "done", {}), { text: "done is not offered to you", refused: true, error: null });
  });
});

describe("restart_session and stop_session", () => {
  let superman = null;
  let paul = null;

  before(async () => {
    superman = await seatUp(LEADER);
  });

  after(async () => {
    await endEvery(500);
  });

  it("restart_session wants the desk written since the event that asked", async () => {
    await end(LEADER, 500);
    superman = await seatUp(LEADER, { OPENOVAI_STAND_IN_USAGE: JSON.stringify({ iterations: [{ input_tokens: 2, cache_read_input_tokens: 371_202 }] }) });
    // The desk written before the event does not count.
    assert.equal((await tool(superman.secret, "write_desk", { title: "early", status: "s" })).refused, false);
    now += 1000;
    const asked = tell(LEADER, userFrame("fill up"));
    await asked.answered;
    assert.equal(
      (await told(superman.log, 2)).at(-1),
      `<server-event type="context" stage="error" context="371204" warning="200000" step="20000" error="300000">${BODY_CONTEXT_ERROR}</server-event>`,
    );
    assert.deepEqual(await tool(superman.secret, "restart_session", {}), { text: "write your desk first (write_desk)", refused: true, error: null });
    assert.equal(running(LEADER), true);
    now += 1000;
    assert.equal((await tool(superman.secret, "write_desk", { title: "late", status: "s" })).refused, false);
    const successor = await spawnedBy(LEADER, async () => {
      const answered = await tool(superman.secret, "restart_session", {});
      assert.ok(await gone(LEADER) !== null || running(LEADER));
      return answered;
    });
    assert.deepEqual(successor.result, { text: "restarting; your successor starts from your desk", refused: false, error: null });
    assert.notEqual(successor.secret, superman.secret);
    superman = successor;
  });

  it("a restart is a new process on the same desk, the queue carried, the successor started from the desk", async () => {
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_SLOW: "400", ...writesDesk('type="closing"') });
    // The seat is freed whatever the check finds: a restart check that leaves a process behind
    // fails every check after it, and a mutation sweep then reads as five findings and one bug.
    try {
      // The predecessor's body, edited in place with a file tool before its write_desk.
      fs.appendFileSync(deskFile(instance, WORKER), "## State\nedited in place by the predecessor\n");
      assert.equal((await tool(superman.secret, "restart_worker", { name: WORKER })).refused, false);
      await told(paul.log, 1);
      const successor = await spawnedBy(WORKER, () => asked(superman.secret, WORKER, "after the restart"));
      assert.deepEqual(successor.result, { text: `sent to ${WORKER}`, refused: false, error: null, reply: "a reply" });
      assert.notEqual(successor.secret, paul.secret);
      assert.equal(callsIn(successor.log).length, 1);
      assert.deepEqual(besideBirth(await told(successor.log, 2)), [`<message from="${LEADER}">after the restart</message>`]);
      // The secret dies with the process that held it.
      assert.equal((await call(paul.secret, "tools/list")).status, 401);
      // The successor starts from the desk the predecessor wrote.
      const argv = callsIn(successor.log)[0];
      const file = /--append-system-prompt-file (\S+)/.exec(argv)[1];
      const prompt = fs.readFileSync(file, "utf8");
      assert.ok(prompt.includes(`Your desk, desks/${WORKER}/STATE.md, as it stands at this start:`), prompt.slice(-400));
      assert.ok(prompt.includes("edited in place by the predecessor"), prompt.slice(-400));
      assert.ok(prompt.includes("| title: a desk by the stand-in |"), prompt.slice(-400));
      // The message landed on the panel as it was taken, before the predecessor's own last words;
      // the successor's answer to it is the last row.
      const rows = panel(instance, WORKER).slice(-3);
      assert.deepEqual(rows.map((row) => [row.from, row.text]), [[LEADER, "after the restart"], [WORKER, "a reply"], [WORKER, "a reply"]]);
    } finally {
      await end(WORKER, 500);
    }
  });

  it("a start and an end each leave a row that says when, and nothing else", async () => {
    const from = read(instance, WORKER).length;
    paul = await seatUp(WORKER);
    const started = now;
    now += 5 * MINUTE;
    await end(WORKER, 500);
    const stamps = read(instance, WORKER).slice(from).filter((row) => row.stamp === true);
    assert.deepEqual(
      stamps.map((row) => [row.from, row.at, row.text]),
      [started, now].map((at) => [SERVER, new Date(at).toISOString(), wallClock(new Date(at))]),
    );
    assert.match(stamps[0].text, /^\d{4}\.\d{2}\.\d{2} (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day \d{2}:\d{2}:\d{2}$/);
  });

  // A session is moved by a frame and by nothing else, and a restart is the one start with
  // nobody standing over it to write one: a hired Worker turns because the Leader speaks to it,
  // the Leader turns because something was addressed to it, a successor has neither. So the
  // server writes the successor's first turn itself, and a successor nobody speaks to works.
  it("a successor nobody speaks to is handed a turn of its own: the birth event", async () => {
    paul = await seatUp(WORKER, writesDesk('type="closing"'));
    try {
      const before_ = recordOf(WORKER);
      const successor = await spawnedBy(WORKER, async () => {
        const answered = await tool(superman.secret, "restart_worker", { name: WORKER });
        assert.equal(answered.refused, false, answered.text);
        await waitFor(() => (running(WORKER) && recordOf(WORKER) !== before_ && recordOf(WORKER).ending === null ? true : null));
        return answered;
      });
      assert.notEqual(successor.secret, paul.secret);
      assert.deepEqual(await told(successor.log, 1), [`<server-event type="restarted">${BODY_RESTARTED}</server-event>`]);
    } finally {
      await end(WORKER, 500);
    }
  });

  // The birth event is the newest thing in that turn and never ahead of what was already waiting:
  // a successor reads what came for its seat in the order it came, and the server's own word last.
  it("what the predecessor left comes first in the successor's turn, the birth event behind it", async () => {
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_SLOW: "400", ...writesDesk('type="closing"') });
    try {
      assert.equal((await tool(superman.secret, "restart_worker", { name: WORKER })).refused, false);
      await told(paul.log, 1);
      const successor = await spawnedBy(WORKER, () => asked(superman.secret, WORKER, "carried over"));
      const carried = `<message from="${LEADER}">carried over</message>`;
      await told(successor.log, 2);
      const children = childrenOf(queuesHeardIn(successor.log).find((one) => one.includes("carried over")));
      assert.equal(children[0], carried, children.join("\n"));
      assert.deepEqual(children.filter((one) => one.startsWith("<message")), [carried]);
    } finally {
      await end(WORKER, 500);
    }
  });

  // "It filled up" is a fact somebody can check afterwards or it is a story, so the restart row
  // carries the number: what the predecessor's last request measured, taken off the record that
  // measured it, and after the row that says its process is gone.
  it("writes a restart row carrying the context the session that restarted was at", async () => {
    const context = JSON.stringify([{ iterations: [{ input_tokens: 150_000 }] }, { iterations: [{ input_tokens: 150_000 }] }]);
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_SLOW: "400", OPENOVAI_STAND_IN_USAGE: context, ...writesDesk('type="closing"') });
    try {
      await tell(WORKER, userFrame("one")).answered;
      const logged = said.length;
      assert.equal((await tool(superman.secret, "restart_worker", { name: WORKER })).refused, false);
      await told(paul.log, 2);
      const successor = await spawnedBy(WORKER, () => asked(superman.secret, WORKER, "after the restart"));
      assert.notEqual(successor.secret, paul.secret);
      const since = said.slice(logged);
      assert.deepEqual(since.filter((line) => line.startsWith("restart ")), [`restart ${WORKER} - successor started, 150000 tokens of context`]);
      assert.ok(since.indexOf(`restart ${WORKER} - successor started, 150000 tokens of context`) > since.indexOf(`stopped ${WORKER} - restart`), since.join("\n"));
    } finally {
      await end(WORKER, 500);
    }
  });

  // The Leader's restart is a successor on the same desk, like a Worker's: no row says it left,
  // because it has not — the row is for a process gone for good, before a fresh session.
  it("a Leader's restart leaves no row on its panel: the successor is the same session going on", async () => {
    await end(LEADER, 500);
    superman = await seatUp(LEADER, { OPENOVAI_STAND_IN_SLOW: "400", ...callsThen("restart_session", "restart please") });
    paul = await seatUp(WORKER);
    try {
      const rows = panel(instance, LEADER).length;
      tell(LEADER, userFrame("restart please"));
      await told(superman.log, 1);
      const successor = await spawnedBy(LEADER, () => asked(paul.secret, LEADER, "after the restart"));
      assert.equal(successor.result.reply, "a reply");
      assert.notEqual(successor.secret, superman.secret);
      assert.deepEqual(besideBirth(await told(successor.log, 2)), [`<message from="${WORKER}">after the restart</message>`]);
      assert.deepEqual(
        panel(instance, LEADER).slice(rows).map((row) => [row.from, row.text, row.divider]),
        [[WORKER, "after the restart", undefined], [LEADER, "a reply", undefined], [LEADER, "a reply", undefined]],
      );
      superman = successor;
    } finally {
      await end(WORKER, 500);
    }
  });

  it("stop_worker ends the process once its desk is written; the desk and the log stay; hire brings it back appending", async () => {
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_REPLY: "before the stop", ...writesDesk('type="closing"') });
    try {
      assert.equal((await asked(superman.secret, WORKER, "one")).reply, "before the stop");
      const spawns = readLog(unexpected);
      const logged = said.length;
      const ordered = await tool(superman.secret, "stop_worker", { name: WORKER });
      assert.equal(ordered.refused, false, ordered.text);
      assert.match(ordered.text, new RegExp(`^${WORKER} is told to write its desk and goes when that turn is over; its desk stays\\. .* You are told with a stopped event\\.$`));
      assert.ok(await gone(WORKER));
      const rows = panel(instance, WORKER).length;
      assert.equal(readLog(unexpected), spawns);
      // One `stopped` row in the log, the ending word the record holds, after the seat's desk row.
      const since = said.slice(logged);
      assert.deepEqual(since.filter((line) => line.startsWith("stopped ")), [`stopped ${WORKER} - stop`]);
      assert.ok(since.findIndex((line) => line.startsWith("stopped ")) > since.findIndex((line) => line.startsWith(`tool ${WORKER} `) && line.includes("mcp__openovai__write_desk ")), since.join("\n"));
      assert.ok(await waitFor(() => (heardIn(superman.log).includes(`<server-event type="stopped" who="${WORKER}" why="stop"/>`) ? true : null)), heardIn(superman.log).join("\n"));
      const listed = (await sessionsListed()).sessions.find((seat) => seat.name === WORKER);
      assert.equal(listed.running, false);
      assert.equal(listed.title, "a desk by the stand-in");
      assert.ok(fs.existsSync(deskFile(instance, WORKER)));
      const back = await spawnedBy(WORKER, () => tool(superman.secret, "hire", { name: WORKER }), { OPENOVAI_STAND_IN_REPLY: "after the stop" });
      assert.equal(back.result.refused, false, back.result.text);
      assert.equal((await asked(superman.secret, WORKER, "two")).reply, "after the stop");
      const messages = JSON.parse((await page("GET", `/sessions/${WORKER}/messages`)).body).messages;
      // The Worker's answer to the close is its last row before the stop.
      assert.deepEqual(messages.filter((row) => row.stamp !== true).slice(rows - 3).map((row) => [row.from, row.text]), [
        [LEADER, "one"],
        [WORKER, "before the stop"],
        [WORKER, "before the stop"],
        [LEADER, "two"],
        [WORKER, "after the stop"],
      ]);
    } finally {
      await end(WORKER, 500);
    }
  });

  it("stop_worker and restart_worker refuse what cannot be closed, and answer at once for what can", async () => {
    await endEvery(500);
    superman = await seatUp(LEADER);
    const order = (name, args = {}) => tool(superman.secret, "stop_worker", { name, ...args });
    assert.deepEqual(await order("not a name"), { text: '"not a name" is not a name here', refused: true, error: null });
    assert.deepEqual(await order(LEADER), { text: `${LEADER} is the Leader`, refused: true, error: null });
    assert.deepEqual(await order("Nobody"), { text: "Nobody has no desk here", refused: true, error: null });
    assert.deepEqual(await order(WORKER), { text: `${WORKER} is not running`, refused: true, error: null });
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_SLOW: "400" });
    try {
      assert.deepEqual(await order(WORKER, { deadline: 4 }), { text: "deadline is a whole number of seconds, at least 5", refused: true, error: null });
      const restarting = await tool(superman.secret, "restart_worker", { name: WORKER, interrupt: true });
      assert.equal(restarting.refused, false, restarting.text);
      assert.match(restarting.text, /a successor starts on its desk\. With no desk written within 300 s of reading this/);
      assert.equal((await told(paul.log, 1))[0].startsWith('<server-event type="closing" why="restart" interrupted="true" deadline="300">'), true, heardIn(paul.log).join("\n"));
      // A stop replaces the restart, with the instance's park deadline when none is given.
      const stopping = await order(WORKER);
      assert.equal(stopping.refused, false, stopping.text);
      assert.match(stopping.text, / within 1800 s /);
      assert.equal((await told(paul.log, 2))[1], `<server-event type="closing" why="stop" deadline="1800">${BODY_CLOSING("stop", false, 1800)}</server-event>`);
      assert.equal(recordOf(WORKER).askedWhy, "close:stop");
    } finally {
      await end(WORKER, 500);
    }
  });

  it("stop_session refuses the Leader without a desk written this turn, and a second ending", async () => {
    await endEvery(500);
    superman = await seatUp(LEADER);
    assert.deepEqual(await tool(superman.secret, "stop_session", {}), { text: "write your desk first (write_desk)", refused: true, error: null });
    assert.equal((await tool(superman.secret, "write_desk", { title: "t", status: "s" })).refused, false);
    assert.equal((await tool(superman.secret, "stop_session", {})).refused, false);
    const again = await tool(superman.secret, "restart_session", {});
    assert.ok(again.refused && (again.text === "already ending" || again.error !== null || (await call(superman.secret, "tools/list")).status === 401));
    await gone(LEADER);
  });
});

describe("done", () => {
  after(async () => {
    await endEvery(500);
  });

  it("tells the Leader the Worker is done, with its note, and ends nothing", async () => {
    await endEvery(500);
    const superman = await seatUp(LEADER);
    const paul = await seatUp(WORKER);
    assert.deepEqual(await tool(paul.secret, "done", { note: "two\nlines" }), { text: "note is one line, up to 200 characters", refused: true, error: null });
    assert.deepEqual(await tool(paul.secret, "done", { note: "the design is on the desk" }), { text: `${LEADER} is told you are done`, refused: false, error: null });
    assert.deepEqual(await told(superman.log, 1), [`<server-event type="done" who="${WORKER}">the design is on the desk</server-event>`]);
    assert.deepEqual(await tool(paul.secret, "done", {}), { text: `${LEADER} is told you are done`, refused: false, error: null });
    assert.equal((await told(superman.log, 2))[1], `<server-event type="done" who="${WORKER}"/>`);
    assert.equal(running(WORKER), true);
  });
});

describe("the account's usage", () => {
  const credentials = () => path.join(home(instance), usage.CREDENTIALS_FILE);
  const realFetch = globalThis.fetch;

  after(async () => {
    globalThis.fetch = realFetch;
    fs.rmSync(credentials(), { force: true });
    usage.reset();
    await endEvery(500);
  });

  it("is asked at a turn's end, with no page open", async () => {
    await endEvery(500);
    fs.mkdirSync(home(instance), { recursive: true });
    fs.writeFileSync(credentials(), JSON.stringify({ claudeAiOauth: { accessToken: "token-own" } }));
    const requests = [];
    globalThis.fetch = async (url, options) => {
      if (url !== usage.USAGE_URL) return realFetch(url, options);
      requests.push(url);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ limits: [] }) };
    };
    await seatUp(LEADER);
    // A reading a minute old: too young for the clock, old enough for a turn's end.
    usage.reset();
    await usage.refresh(chat, { now: () => Date.now() - usage.SPACING });
    assert.equal(requests.length, 1);
    await tell(LEADER, userFrame("hello")).answered;
    assert.ok(await waitFor(() => requests.length === 2), "not asked at the turn's end");
  });
});

describe("context", () => {
  let superman = null;

  after(async () => {
    await endEvery(500);
  });

  // The event goes in with what was queued behind the turn that passed the size — behind it,
  // since it arrived when that turn ended and a queue is in arrival order — and the seat decides
  // for itself what to do about it.
  it("fires once, behind what was queued, from the last request of the turn", async () => {
    superman = await seatUp(LEADER, {
      OPENOVAI_STAND_IN_SLOW: "300",
      OPENOVAI_STAND_IN_USAGE: JSON.stringify([
        { input_tokens: 250_000, iterations: [{ input_tokens: 130_000 }, { input_tokens: 120_000 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 100 }, { input_tokens: 211_204 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 211_204 }] },
      ]),
    });
    // A top-level sum over the warning size with a last request under it: nothing.
    await tell(LEADER, userFrame("one")).answered;
    assert.deepEqual(await told(superman.log, 1), ["<user>one</user>"]);
    tell(LEADER, userFrame("two"));
    const three = tell(LEADER, userFrame("three"));
    await three.answered;
    assert.deepEqual(heardIn(superman.log).slice(0, 2), ["<user>one</user>", "<user>two</user>"]);
    const queues = queuesHeardIn(superman.log);
    assert.equal(queues.length, 3, heardIn(superman.log).join("\n"));
    assert.deepEqual(childrenOf(queues[2]), [
      "<user>three</user>",
      `<server-event type="context" stage="warning" context="211204" warning="200000" step="20000" error="300000">${BODY_CONTEXT_WARNING}</server-event>`,
    ]);
    // A further turn at the same size says nothing more.
    await tell(LEADER, userFrame("four")).answered;
    await tell(LEADER, userFrame("five")).answered;
    assert.deepEqual(heardIn(superman.log).slice(4), ["<user>four</user>", "<user>five</user>"]);
  });

  it("is what the page and the room report as the seat's context", async () => {
    const listed = (await sessionsListed()).sessions.find((seat) => seat.name === LEADER);
    assert.equal(listed.context, 211_204);
  });
});

describe("the context sizes", () => {
  let superman = null;

  after(async () => {
    await endEvery(500);
  });

  const event = (context, stage) =>
    `<server-event type="context" stage="${stage}" context="${context}" warning="200000" step="20000" error="300000">${
      stage === "error" ? BODY_CONTEXT_ERROR : BODY_CONTEXT_WARNING
    }</server-event>`;

  // Six turns and a reading each — the stand-in's list is per turn of the User's, not per turn:
  // just under the warning size, on it, between it and the first step, two steps at once, the
  // error size, and a step above the error size. Nothing is ended at any of them: the seat is
  // still running when the last event has gone in.
  it("tells the warning at the warning size and at every step, once each, and the error stage from the error size", async () => {
    superman = await seatUp(LEADER, {
      OPENOVAI_STAND_IN_USAGE: JSON.stringify([
        { input_tokens: 2, iterations: [{ input_tokens: 199_999 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 200_000 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 219_999 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 240_500 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 300_000 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 321_000 }] },
      ]),
    });
    for (const said of ["one", "two", "three", "four", "five", "six"]) {
      await tell(LEADER, userFrame(said)).answered;
    }
    assert.deepEqual(await told(superman.log, 10), [
      "<user>one</user>",
      "<user>two</user>",
      event("200000", "warning"),
      "<user>three</user>",
      "<user>four</user>",
      event("240500", "warning"),
      "<user>five</user>",
      event("300000", "error"),
      "<user>six</user>",
      event("321000", "error"),
    ]);
    assert.equal(running(LEADER), true, "a size ended the seat");
  });

  // A Worker's context is the Leader's to act on: told twice, at the warning and at the error size,
  // each a turn of the Leader's; the Worker is told nothing of it.
  it("tells the Leader of a Worker's context at the warning and the error size only, and the Worker nothing", async () => {
    await endEvery(500);
    const leader = await seatUp(LEADER);
    const paul = await seatUp(WORKER, {
      OPENOVAI_STAND_IN_USAGE: JSON.stringify([
        { input_tokens: 2, iterations: [{ input_tokens: 199_999 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 200_000 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 240_500 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 300_000 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 321_000 }] },
      ]),
    });
    for (const said of ["one", "two", "three", "four", "five"]) {
      await tell(WORKER, userFrame(said)).answered;
    }
    const about = (context, stage) =>
      `<server-event type=\"context\" who=\"${WORKER}\" stage=\"${stage}\" context=\"${context}\" error=\"300000\"${stage === "error" ? `>${BODY_CONTEXT_WORKER}</server-event>` : "/>"}`;
    assert.deepEqual(await told(leader.log, 2), [about("200000", "warning"), about("300000", "error")]);
    await settle();
    assert.equal(heardIn(leader.log).length, 2, heardIn(leader.log).join("\n"));
    assert.deepEqual(heardIn(paul.log), ["one", "two", "three", "four", "five"].map((said) => `<user>${said}</user>`));
    assert.equal(running(WORKER), true);
  });

  // Every request of a turn says what it took, so a size passed in the middle of a long turn is
  // told at that request and not held until the turn is over; the turn's result, at the same size,
  // tells nothing more.
  it("tells the Leader of a Worker's context at the request that passed the size, before the turn's result, and not again at it", async () => {
    await endEvery(500);
    const leader = await seatUp(LEADER);
    const request = { input_tokens: 2, cache_read_input_tokens: 239_998, cache_creation_input_tokens: 500 };
    await seatUp(WORKER, {
      OPENOVAI_STAND_IN_CALLS: JSON.stringify([[{ name: "Bash", input: { command: "ls" }, usage: request }]]),
      OPENOVAI_STAND_IN_CALL_HOLDS: "3000",
      OPENOVAI_STAND_IN_USAGE: JSON.stringify([{ input_tokens: 2, iterations: [request] }]),
    });
    let over = false;
    const turn = tell(WORKER, userFrame("one"));
    turn.answered.then(() => {
      over = true;
    });
    const about = `<server-event type="context" who="${WORKER}" stage="warning" context="240500" error="300000"/>`;
    assert.deepEqual(await told(leader.log, 1), [about]);
    assert.equal(over, false, "the size was told only once the turn was over");
    await turn.answered;
    await settle();
    assert.deepEqual(heardIn(leader.log), [about]);
  });
});

// Every call of the instance's own tools is timed where it is dispatched: the log says how long
// each took, and the panel says so once it was ten seconds — so a slow call and a stuck seat can
// be told apart while watching. A plugin the suite holds open is the tool: it answers when told.
describe("a call of the instance's own tools", () => {
  let paul = null;
  let open = null;

  before(async () => {
    chat.plugins.push({
      name: "slow",
      description: "answers when the suite lets it",
      inputSchema: { type: "object", properties: {} },
      run: () => open,
    });
    paul = await seatUp(WORKER);
  });

  after(async () => {
    chat.plugins.length = 0;
    await endEvery(500);
  });

  // A call held open for `seconds` on the clock, then answered — or thrown — as the suite says.
  async function held(seconds, answer) {
    const from = now;
    const rows = panel(instance, WORKER).length;
    const logged = said.length;
    let settle_;
    open = new Promise((resolve, reject) => { settle_ = { resolve, reject }; });
    const calling = tool(paul.secret, "slow");
    await new Promise((resolve) => setTimeout(resolve, 50));
    now = from + seconds * 1000;
    answer(settle_);
    const answered = await calling;
    return {
      answered,
      lines: said.slice(logged).filter((line) => line.startsWith("tool ")),
      row: panel(instance, WORKER).slice(rows).find((row) => row.from === SERVER && row.text.startsWith("The slow tool took ")) ?? null,
    };
  }

  // Under the tool's full name, as Claude Code says it — and with no id, since this call came over
  // the MCP door alone, with no session stream announcing it first.
  it("is logged with how long it took under the tool's full name, and one of nine seconds draws no row", async () => {
    const { answered, lines, row } = await held(9, ({ resolve }) => resolve({ text: "done" }));
    assert.equal(answered.text, "done");
    assert.deepEqual(lines, [`tool ${WORKER} - mcp__openovai__slow in 9000 ms`]);
    assert.equal(row, null, "a call under ten seconds drew a row");
  });

  it("one of ten seconds says so on the panel", async () => {
    const { row } = await held(10, ({ resolve }) => resolve({ text: "done" }));
    assert.equal(row?.text, "The slow tool took 10.0 seconds");
  });

  it("one that threw is logged failed, with the reason, and still timed", async () => {
    const { answered, lines } = await held(1, ({ reject }) => reject(new Error("the wire broke")));
    assert.equal(answered.refused, true);
    assert.match(answered.text, /^slow could not be done: the wire broke$/);
    assert.deepEqual(lines, [`tool ${WORKER} - mcp__openovai__slow failed in 1000 ms: the wire broke`]);
  });
});

// A tool of the instance's own is a file, plugins/<name>.mjs, read by the chat as it starts — so
// this goes the whole way round through the very process `ovai start` runs: the file is found and
// said in the log, listed to a seat, and answered by its own code with the caller named.
describe("a tool of the instance's own, from its file", () => {
  const own = `${base}-plugin`;
  const ownStandIn = `${base}-plugin-stand-in`;
  const ownLog = path.join(ownStandIn, "all.txt");
  let child;

  before(() => {
    remove(own, ownStandIn);
    writeStandIn(ownStandIn);
    installed(options(own));
    fs.mkdirSync(path.join(own, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(own, "plugins", "echo.mjs"),
      [
        'export const description = "says back what it was given, and by whom";',
        'export const inputSchema = { type: "object", properties: { what: { type: "string" } } };',
        "export function run(args, caller) {",
        "  return { text: `${args.what}, said ${caller.seat}` };",
        "}",
        "",
      ].join("\n"),
    );
  });

  after(async () => {
    await stopChat(child);
    remove(own, ownStandIn);
  });

  it("is found at the start, listed to a seat and answered by its own code", async () => {
    child = startChat(own, { ...process.env, XDG_DATA_HOME: ownStandIn, OPENOVAI_STAND_IN_LOG: ownLog });
    const address = await waitForAddress(child);
    assert.ok(address, `the chat never said where it was listening:\n${child.output}`);
    assert.match(child.output, /^\S+ plugins - - This instance serves a tool of its own: echo$/m);
    const page_ = await fetch(`${address}/`).then((answered) => answered.text());
    const pageSecret_ = /<meta name="openovai-secret" content="([^"]*)">/.exec(page_)[1];
    const woken = await fetch(`${address}/sessions/${LEADER}/message`, {
      method: "POST",
      headers: { authorization: `Bearer ${pageSecret_}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(woken.status, 200, await woken.text());
    assert.ok(await waitFor(() => secretsIn(ownLog).length > 0), "the Leader was never started");
    const leader = secretsIn(ownLog)[0];
    const listed = await postPlain(`${address}/mcp/${leader}`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.ok(JSON.parse(listed.body).result.tools.some((tool) => tool.name === "echo"), listed.body);
    const answered = await postPlain(`${address}/mcp/${leader}`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { what: "hello" } } });
    const result = JSON.parse(answered.body).result;
    assert.equal(result.isError, undefined, answered.body);
    assert.equal(result.content[0].text, `hello, said ${LEADER}`);
  });
});
