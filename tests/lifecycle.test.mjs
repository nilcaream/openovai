// The lifecycle: how seats are started, what the server says to them on its own account, and how
// they end — the Leader started by whatever is addressed to it, Workers by hire and by their own
// restart; the five tools; the server events (context-full, quota-low, idle, park, stopped, the
// hard-rule delta); the quota gate in front of every write; a server stop that parks first.
//
// Served in this process, with the clock injected: `chat.clock` is what every idle minute, reset
// and deadline is measured against, and `tick()` is called by hand where the server's own
// interval would call it. The stand-in (tests/helpers.mjs) is every process; what a seat was told
// is read from its log, never from what the server says it sent.
//
// Every mutation in tests/mutations-lifecycle.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { SERVER, read as panel } from "../lib/chat/conversation.mjs";
import { subscribe } from "../lib/chat/events.mjs";
import { messageFrame, serverEvent, userFrame } from "../lib/chat/frames.mjs";
import { BODY_CONTEXT_FULL, BODY_CRITICAL, BODY_IDLE, BODY_PARK, IDLE_GRACE, deliver, parkRoom, tick } from "../lib/chat/lifecycle.mjs";
import { sink } from "../lib/chat/log.mjs";
import * as quota from "../lib/chat/quota.mjs";
import { pageSecret } from "../lib/chat/secrets.mjs";
import { serve, startSeat, toolsFor } from "../lib/chat/server.mjs";
import { INTERRUPT_PATIENCE, end, endEvery, recordOf, running, runningSeats, tell } from "../lib/chat/session.mjs";
import { deskFile, deskHeader, deskTitle, hire } from "../lib/desks.mjs";
import { CONFIG_FILE } from "../lib/seed.mjs";
import { alive, arrivalsIn, callsIn, heardIn, installed, notesIn, pidsIn, post as postPlain, readLog, remove, repo, runToolLater, sansMoment, scratch, secretsIn, startChat, stopChat, waitFor, waitForAddress, writeStandIn } from "./helpers.mjs";

const USER = "Mike";
const LEADER = "Superman";
const WORKER = "Paul";
const OTHER = "Ann";
const LEADER_MODEL = "opus";
const WORKER_MODEL = "sonnet";

const MINUTE = 60_000;

const base = scratch("lifecycle-test");
const instance = `${base}-instance`;
const standIn = `${base}-stand-in`;
// Where a process nobody expected to be started writes: a check that asserts no spawn reads it.
const unexpected = path.join(standIn, "unexpected.txt");
// What the helper answers a hard-rule write asking whether the text restates a current rule: new.
const helperAnswer = path.join(standIn, "helper-answer.json");

process.on("exit", () => {
  remove(instance, standIn);
});

function options(root) {
  return {
    "--root": root,
    "--source": repo,
    "--user": USER,
    "--leader": LEADER,
    "--leader-model": LEADER_MODEL,
    "--worker-model": WORKER_MODEL,
    "--port": 0,
    "--auth": "login",
  };
}

function configOf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
}

// A reading the way the frame carries it: epoch seconds, each window its own reset.
function reading(fiveHour, { sevenDay = 0.5, resets = null, extra = {}, status = "allowed", type = "five_hour" } = {}) {
  const at = (resets ?? now + 3 * 60 * MINUTE) / 1000;
  const week = (now + 3 * 24 * 60 * MINUTE) / 1000;
  return {
    status,
    resetsAt: at,
    rateLimitType: type,
    unifiedWindows: {
      five_hour: { utilization: fiveHour, resetsAt: at },
      seven_day: { utilization: sevenDay, resetsAt: week },
      ...extra,
    },
  };
}

const said = [];
let chat = null;
let server = null;
let url = null;
let now = Date.now();
const realData = process.env.XDG_DATA_HOME;

remove(instance, standIn);
writeStandIn(standIn);
installed(options(instance));
hire(instance, WORKER);

before(async () => {
  chat = { root: instance, config: configOf(instance), plugins: [], clock: () => now };
  sink((row) => said.push(sansMoment(row)));
  // Any spawn the chat makes on its own finds the stand-in, and one nobody arranged a log for
  // writes to the one every "no spawn" check reads.
  process.env.XDG_DATA_HOME = standIn;
  process.env.OPENOVAI_STAND_IN_LOG = unexpected;
  fs.writeFileSync(helperAnswer, JSON.stringify({ replaces: null, reason: "new" }));
  process.env.OPENOVAI_STAND_IN_HELPER = helperAnswer;
  server = await serve(chat);
  url = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await endEvery(500);
  await new Promise((resolve) => server.close(resolve));
  sink(null);
  process.env.XDG_DATA_HOME = realData;
  delete process.env.OPENOVAI_STAND_IN_LOG;
  delete process.env.OPENOVAI_STAND_IN_HELPER;
});

// Start a seat through the one seam, with its own log and knobs on this process's environment for
// the spawn only.
let logs = 0;
function nextLog(seat) {
  logs += 1;
  return path.join(standIn, `${seat}-${logs}.txt`);
}

async function seatUp(seat, knobs = {}, { first = null } = {}) {
  const log = nextLog(seat);
  const before_ = { ...process.env };
  process.env.OPENOVAI_STAND_IN_LOG = log;
  Object.assign(process.env, knobs);
  let started;
  let asked = null;
  try {
    started = startSeat(chat, seat);
    if (first !== null) {
      asked = tell(seat, first);
    }
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in before_)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, before_);
  }
  assert.ok(await waitFor(() => secretsIn(log).length > 0), `${seat} never logged its secret`);
  return { ...started, log, secret: secretsIn(log)[0], asked };
}

// Let the chat start a seat of its own accord inside `act` — the Leader for something addressed
// to it, a hired Worker, a successor — with the knobs on the environment for as long as `act`
// runs. Answers what `act` answered, the new log and the new secret.
async function spawnedBy(seat, act, knobs = {}) {
  const log = nextLog(seat);
  const before_ = { ...process.env };
  process.env.OPENOVAI_STAND_IN_LOG = log;
  Object.assign(process.env, knobs);
  let result;
  try {
    result = await act();
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in before_)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, before_);
  }
  assert.ok(await waitFor(() => secretsIn(log).length > 0), `${seat} was never started`);
  return { seat, result, log, secret: secretsIn(log)[0] };
}

function page(method, route, body) {
  return fetch(`${url}${route}`, {
    method,
    headers: { authorization: `Bearer ${pageSecret()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (answered) => ({ status: answered.status, body: await answered.text() }));
}

function call(secret, method, params) {
  return postPlain(`${url}/mcp/${secret}`, { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
}

function answerOf(answered) {
  const body = JSON.parse(answered.body);
  return { text: body.result?.content?.[0]?.text, refused: body.result?.isError === true, error: body.error ?? null };
}

async function tool(secret, name, args = {}) {
  return answerOf(await call(secret, "tools/call", { name, arguments: args }));
}

// A message from one seat to another, and what the addressee then said at the end of its turn,
// read off its panel: the call itself comes back the moment the message is taken. `reply` is the
// text of the first row the addressee wrote on its own panel after the message, null when it
// wrote none before patience ran out or the call was refused.
async function asked(secret, seat, text) {
  const at = panel(instance, seat).length;
  const said_ = await tool(secret, "message", { to: seat, text });
  if (said_.refused) {
    return { ...said_, reply: null };
  }
  const row = await waitFor(() => panel(instance, seat).slice(at).find((one) => one.from === seat && one.to === undefined && one.line === undefined) ?? null);
  return { ...said_, reply: row === null ? null : row.text };
}

async function told(log, count) {
  await waitFor(() => (heardIn(log).length >= count ? true : null));
  return heardIn(log);
}

// Every frame the run has been handed so far, as it arrived — before the run got round to it.
function readIn(log) {
  return notesIn(log)
    .filter(([label]) => label === "read")
    .map(([, rest]) => rest);
}

async function gone(seat) {
  return waitFor(() => (running(seat) ? null : true));
}

// The tool calls a stand-in is to make on the frame naming `on`: write its desk, then the tool.
function callsThen(name, on) {
  return {
    OPENOVAI_STAND_IN_TOOL: JSON.stringify([
      { name: "write_desk", arguments: { title: `${name} by the stand-in`, status: "leaving", body: "## State\nwritten by the stand-in\n" } },
      { name, arguments: {} },
    ]),
    ...(on === undefined ? {} : { OPENOVAI_STAND_IN_TOOL_ON: on }),
  };
}

function deskOf(seat) {
  return fs.readFileSync(deskFile(instance, seat), "utf8");
}

function sessionsListed() {
  return page("GET", "/sessions").then((answered) => JSON.parse(answered.body));
}

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

// ---------------------------------------------------------------------------------------------

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
    // One hard rule from here on, so every later spawn carries a numbered set version.
    const rule = await tool(superman.secret, "remember", { store: "memory", kind: "hard-rule", text: "Say what you measured." });
    assert.equal(rule.refused, false, rule.text);
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

  it("records the rule-set version in the desk header at spawn", () => {
    const header = deskHeader(instance, WORKER);
    assert.match(header.rules, /^m\d+$/);
    assert.equal(header.rules, recordOf(WORKER).rules);
  });
});

// ---------------------------------------------------------------------------------------------

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

  it("writes its own desk only, the server owning the header", async () => {
    const leaderDesk = deskOf(LEADER);
    const refused = await tool(paul.secret, "write_desk", { name: LEADER, title: "t", status: "s", body: "B" });
    assert.equal(refused.refused, true);
    assert.equal(refused.text, "write_desk: name is not an argument it takes");
    assert.equal(deskOf(LEADER), leaderDesk);

    const written = await tool(paul.secret, "write_desk", { title: "t", status: "s", body: "B\n" });
    assert.equal(written.refused, false, written.text);
    assert.match(written.text, new RegExp(`^desk written: desks/${WORKER}/STATE.md \\(\\d+ lines, rules m\\d+\\)$`));
    const lines = deskOf(WORKER).split("\n");
    assert.match(lines[0], /^<!-- DESK \| title: t \| status: s \| rules: m\d+ \| updated: \d{4}-\d{2}-\d{2}T[0-9:.]+Z -->$/);
    assert.equal(lines[1], `# ${WORKER} - t`);
    assert.equal(lines[3], "B");

    const posed = await tool(paul.secret, "write_desk", { title: "t", status: "s", body: "<!-- DESK | title: posed -->\nbody" });
    assert.equal(posed.refused, false);
    assert.equal(deskTitle(instance, WORKER), "t");
    assert.equal(deskOf(WORKER).split("\n")[3], "<!-- DESK | title: posed -->");
  });

  it("refuses an empty title, a status with a |, and a body over 64 KB, leaving the desk as it was", async () => {
    await tool(paul.secret, "write_desk", { title: "kept", status: "kept", body: "kept" });
    const kept = deskOf(WORKER);
    assert.equal((await tool(paul.secret, "write_desk", { title: "", status: "s", body: "B" })).refused, true);
    assert.equal(deskOf(WORKER), kept);
    assert.equal((await tool(paul.secret, "write_desk", { title: "t", status: "a | b", body: "B" })).refused, true);
    assert.equal(deskOf(WORKER), kept);
    assert.equal((await tool(paul.secret, "write_desk", { title: "t", status: "s", body: "x".repeat(64 * 1024 + 1) })).refused, true);
    assert.equal(deskOf(WORKER), kept);
    assert.equal((await tool(paul.secret, "write_desk", { title: "t", status: "s", body: "x".repeat(64 * 1024) })).refused, false);
  });

  it("is listed for both roles, park and hire for the Leader only", async () => {
    const forLeader = JSON.parse((await call(superman.secret, "tools/list")).body).result.tools.map((entry) => entry.name);
    const forPaul = JSON.parse((await call(paul.secret, "tools/list")).body).result.tools.map((entry) => entry.name);
    for (const name of ["write_desk", "restart_session", "stop_session"]) {
      assert.ok(forLeader.includes(name) && forPaul.includes(name), name);
    }
    assert.ok(forLeader.includes("park") && forLeader.includes("hire"));
    assert.ok(!forPaul.includes("park") && !forPaul.includes("hire"));
    assert.deepEqual(await tool(paul.secret, "park", {}), { text: "park is not offered to you", refused: true, error: null });
  });
});

// ---------------------------------------------------------------------------------------------

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
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_USAGE: JSON.stringify({ iterations: [{ input_tokens: 2, cache_read_input_tokens: 171_202 }] }) });
    // The desk written before the event does not count.
    assert.equal((await tool(paul.secret, "write_desk", { title: "early", status: "s", body: "B" })).refused, false);
    now += 1000;
    const asked = tell(WORKER, userFrame("fill up"));
    await asked.answered;
    assert.equal((await told(paul.log, 2)).at(-1), `<server-event type="context-full" context="171204" ceiling="160000">${BODY_CONTEXT_FULL}</server-event>`);
    assert.deepEqual(await tool(paul.secret, "restart_session", {}), { text: "write your desk first (write_desk)", refused: true, error: null });
    assert.equal(running(WORKER), true);
    now += 1000;
    assert.equal((await tool(paul.secret, "write_desk", { title: "late", status: "s", body: "B" })).refused, false);
    const successor = await spawnedBy(WORKER, async () => {
      const answered = await tool(paul.secret, "restart_session", {});
      assert.ok(await gone(WORKER) !== null || running(WORKER));
      return answered;
    });
    assert.deepEqual(successor.result, { text: "restarting; your successor starts from your desk", refused: false, error: null });
    assert.notEqual(successor.secret, paul.secret);
    await end(WORKER, 500);
  });

  it("a restart is a new process on the same desk, the queue carried, the successor started from the desk", async () => {
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_SLOW: "400", ...callsThen("restart_session", "restart please") });
    tell(WORKER, userFrame("restart please"));
    await told(paul.log, 1);
    const successor = await spawnedBy(WORKER, () => asked(superman.secret, WORKER, "after the restart"));
    assert.deepEqual(successor.result, { text: `sent to ${WORKER}`, refused: false, error: null, reply: "a reply" });
    assert.notEqual(successor.secret, paul.secret);
    assert.equal(callsIn(successor.log).length, 1);
    assert.deepEqual(await told(successor.log, 1), [`<message from="${LEADER}">after the restart</message>`]);
    // The secret dies with the process that held it.
    assert.equal((await call(paul.secret, "tools/list")).status, 401);
    // The successor starts from the desk the predecessor wrote.
    const argv = callsIn(successor.log)[0];
    const file = /--append-system-prompt-file (\S+)/.exec(argv)[1];
    const prompt = fs.readFileSync(file, "utf8");
    assert.ok(prompt.includes(`Your desk, desks/${WORKER}/STATE.md, as it stands at this start:`), prompt.slice(-400));
    assert.ok(prompt.includes("written by the stand-in"), prompt.slice(-400));
    // The message landed on the panel as it was taken, before the predecessor's own last words;
    // the successor's answer to it is the last row.
    const rows = panel(instance, WORKER).slice(-3);
    assert.deepEqual(rows.map((row) => [row.from, row.text]), [[LEADER, "after the restart"], [WORKER, "a reply"], [WORKER, "a reply"]]);
    await end(WORKER, 500);
  });

  // The Leader's restart is a successor on the same desk, like a Worker's: no row says it left,
  // because it has not — the row is for a process gone for good, before a fresh session.
  it("a Leader's restart leaves no row on its panel: the successor is the same session going on", async () => {
    await end(LEADER, 500);
    superman = await seatUp(LEADER, { OPENOVAI_STAND_IN_SLOW: "400", ...callsThen("restart_session", "restart please") });
    paul = await seatUp(WORKER);
    const rows = panel(instance, LEADER).length;
    tell(LEADER, userFrame("restart please"));
    await told(superman.log, 1);
    const successor = await spawnedBy(LEADER, () => asked(paul.secret, LEADER, "after the restart"));
    assert.equal(successor.result.reply, "a reply");
    assert.notEqual(successor.secret, superman.secret);
    assert.deepEqual(await told(successor.log, 1), [`<message from="${WORKER}">after the restart</message>`]);
    assert.deepEqual(
      panel(instance, LEADER).slice(rows).map((row) => [row.from, row.text, row.divider]),
      [[WORKER, "after the restart", undefined], [LEADER, "a reply", undefined], [LEADER, "a reply", undefined]],
    );
    superman = successor;
    await end(WORKER, 500);
  });

  it("stop_session ends the process and its panel; the desk and the log stay; hire brings it back appending", async () => {
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_REPLY: "before the stop" });
    assert.equal((await asked(superman.secret, WORKER, "one")).reply, "before the stop");
    const rows = panel(instance, WORKER).length;
    assert.equal((await tool(paul.secret, "write_desk", { title: "stopping", status: "s", body: "B" })).refused, false);
    const spawns = readLog(unexpected);
    const logged = said.length;
    assert.deepEqual(await tool(paul.secret, "stop_session", {}), { text: "stopping; your desk stays", refused: false, error: null });
    assert.ok(await gone(WORKER));
    assert.equal(readLog(unexpected), spawns);
    // One `stopped` row in the log, the ending word the record holds, after the seat's own tool row.
    const since = said.slice(logged);
    assert.deepEqual(since.filter((line) => line.startsWith("stopped ")), [`stopped ${WORKER} - stop`]);
    assert.ok(since.findIndex((line) => line.startsWith("stopped ")) > since.findIndex((line) => line.startsWith(`tool ${WORKER} `) && line.includes("mcp__openovai__stop_session ")), since.join("\n"));
    const listed = (await sessionsListed()).sessions.find((seat) => seat.name === WORKER);
    assert.equal(listed.running, false);
    assert.equal(listed.title, "stopping");
    assert.ok(fs.existsSync(deskFile(instance, WORKER)));
    assert.equal(panel(instance, WORKER).length, rows);
    const back = await spawnedBy(WORKER, () => tool(superman.secret, "hire", { name: WORKER }), { OPENOVAI_STAND_IN_REPLY: "after the stop" });
    assert.equal(back.result.refused, false, back.result.text);
    assert.equal((await asked(superman.secret, WORKER, "two")).reply, "after the stop");
    const messages = JSON.parse((await page("GET", `/sessions/${WORKER}/messages`)).body).messages;
    assert.deepEqual(messages.slice(rows - 2).map((row) => [row.from, row.text]), [
      [LEADER, "one"],
      [WORKER, "before the stop"],
      [LEADER, "two"],
      [WORKER, "after the stop"],
    ]);
    await end(WORKER, 500);
  });

  it("stop_session refuses without a desk written this turn, and a second ending", async () => {
    paul = await seatUp(WORKER);
    assert.deepEqual(await tool(paul.secret, "stop_session", {}), { text: "write your desk first (write_desk)", refused: true, error: null });
    assert.equal((await tool(paul.secret, "write_desk", { title: "t", status: "s", body: "B" })).refused, false);
    assert.equal((await tool(paul.secret, "stop_session", {})).refused, false);
    const again = await tool(paul.secret, "restart_session", {});
    assert.ok(again.refused && (again.text === "already ending" || again.error !== null || (await call(paul.secret, "tools/list")).status === 401));
    await gone(WORKER);
  });
});

// ---------------------------------------------------------------------------------------------

describe("context-full", () => {
  let paul = null;

  after(async () => {
    await endEvery(500);
  });

  it("fires once, ahead of what was queued, from the last request of the turn", async () => {
    paul = await seatUp(WORKER, {
      OPENOVAI_STAND_IN_SLOW: "300",
      OPENOVAI_STAND_IN_USAGE: JSON.stringify([
        { input_tokens: 250_000, iterations: [{ input_tokens: 130_000 }, { input_tokens: 120_000 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 100 }, { input_tokens: 171_204 }] },
        { input_tokens: 2, iterations: [{ input_tokens: 171_204 }] },
      ]),
    });
    // A top-level sum over the ceiling with a last request under it: nothing.
    await tell(WORKER, userFrame("one")).answered;
    assert.deepEqual(await told(paul.log, 1), ["<user>one</user>"]);
    tell(WORKER, userFrame("two"));
    tell(WORKER, userFrame("three"));
    await told(paul.log, 4);
    assert.deepEqual(heardIn(paul.log), [
      "<user>one</user>",
      "<user>two</user>",
      `<server-event type="context-full" context="171204" ceiling="160000">${BODY_CONTEXT_FULL}</server-event>`,
      "<user>three</user>",
    ]);
    // A further turn over the ceiling says nothing more.
    await tell(WORKER, userFrame("four")).answered;
    await tell(WORKER, userFrame("five")).answered;
    assert.deepEqual(heardIn(paul.log).slice(4), ["<user>four</user>", "<user>five</user>"]);
  });

  it("is what the page and the room report as the seat's context", async () => {
    const listed = (await sessionsListed()).sessions.find((seat) => seat.name === WORKER);
    assert.equal(listed.context, 171_204);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the page's STOP", () => {
  let paul = null;

  after(async () => {
    await endEvery(500);
  });

  it("interrupts the turn and nothing else: the process stays, the next frame goes in", async () => {
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_SLOW: "5000" });
    const first = tell(WORKER, userFrame("slow"));
    tell(WORKER, userFrame("next"));
    await told(paul.log, 1);
    const stopped = await page("POST", `/sessions/${WORKER}/stop`);
    assert.deepEqual(JSON.parse(stopped.body), { interrupted: true });
    assert.deepEqual(await first.answered, { interrupted: true, text: "interrupted" });
    assert.ok(alive(pidsIn(paul.log)[0]));
    assert.equal(running(WORKER), true);
    assert.deepEqual(await told(paul.log, 2), ["<user>slow</user>", "<user>next</user>"]);
    assert.ok(notesIn(paul.log).some(([label]) => label === "interrupt"));
    assert.ok(notesIn(paul.log).some(([label, rest]) => label === "interrupted" && rest === "<user>slow</user>"));
    // Not ending either: the same process answers what comes after.
    assert.equal(recordOf(WORKER).ending, null);
    assert.equal((await tell(WORKER, userFrame("after")).answered).text, "a reply");
    assert.equal(pidsIn(paul.log).length, 1);
    assert.ok(alive(pidsIn(paul.log)[0]));
  });

  it("answers false when nothing was running", async () => {
    await told(paul.log, 2);
    await waitFor(() => (recordOf(WORKER).turn === null ? true : null));
    assert.deepEqual(JSON.parse((await page("POST", `/sessions/${WORKER}/stop`)).body), { interrupted: false });
  });
});

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

  it("keeps the newest reading per window from one turn, and stage one tells every seat ahead, nobody interrupted", async () => {
    const resets = RESETS();
    await fresh({ OPENOVAI_STAND_IN_SLOW: "600", ...readings([reading(0.5, { resets }), reading(0.91, { resets })]) });
    tell(WORKER, userFrame("first"));
    tell(WORKER, userFrame("queued"));
    await told(paul.log, 3);
    assert.equal(quota.standing().five_hour.utilization, 0.91);
    const warning = `<server-event type="quota-low" stage="warning" window="5h" resets="${new Date(resets).toISOString()}"/>`;
    assert.deepEqual(heardIn(paul.log), ["<user>first</user>", warning, "<user>queued</user>"]);
    assert.deepEqual(await told(superman.log, 1), [warning]);
    assert.ok(!notesIn(paul.log).some(([label]) => label === "interrupt"));
    assert.ok(!notesIn(superman.log).some(([label]) => label === "interrupt"));
  });

  it("stage two interrupts a Worker mid-turn and tells it critical; the Leader is told, not interrupted", async () => {
    const resets = RESETS();
    await fresh({ OPENOVAI_STAND_IN_SLOW: "3000", ...readings(reading(0.96, { resets })) });
    const first = tell(WORKER, userFrame("busy"));
    assert.deepEqual(await first.answered, { interrupted: true, text: "interrupted" });
    const critical = `<server-event type="quota-low" stage="critical" window="5h" resets="${new Date(resets).toISOString()}" interrupted="true">${BODY_CRITICAL}</server-event>`;
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

  it("holds the helper at stage two only", async () => {
    const resets = RESETS();
    await fresh(readings(reading(0.91, { resets }), reading(0.96, { resets })));
    await tell(WORKER, userFrame("one")).answered;
    const helperRuns = () => readLog(unexpected).split("\n").filter((line) => line.startsWith("helper-argv: ")).length;
    const before_ = helperRuns();
    const atOne = await tool(superman.secret, "recall", { store: "memory", query: "anything at all" });
    assert.notEqual(atOne.text, "the helper is held: quota");
    assert.equal(helperRuns(), before_ + 1);
    await tell(WORKER, userFrame("two")).answered;
    assert.deepEqual(await tool(superman.secret, "recall", { store: "memory", query: "anything at all" }), { text: "the helper is held: quota", refused: true, error: null });
    assert.equal(helperRuns(), before_ + 1);
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
    assert.match(frames.at(-1), /^<server-event type="quota-low" stage="critical" window="7d" resets="[^"]+" interrupted="true">/);
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
    assert.match(readIn(paul.log)[1], /^<server-event type="quota-low" stage="critical"/);
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
    assert.deepEqual(await told(superman.log, 1), ["<user>wake up</user>"]);
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
    assert.equal((await told(paul.log, 2)).at(-1).startsWith('<server-event type="quota-low" stage="critical"'), true);
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
    assert.equal((await told(superman.log, 3)).at(-1), "<user>behind</user>");
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
    assert.equal((await told(paul.log, 2)).at(-1).startsWith('<server-event type="quota-low" stage="critical"'), true);
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
    assert.equal((await told(superman.log, 4)).at(-1), `<message from="${WORKER}">a note</message>`);
  });

  it("a restart while the window is closed is a stop: no successor is queued, the carried turns are answered so, and the Leader hears of it after the reset", async () => {
    const resets = RESETS();
    await fresh({ OPENOVAI_STAND_IN_SLOW: "400", ...readings(reading(0.96, { resets })), ...callsThen("restart_session", 'stage="critical"') });
    const spawns = readLog(unexpected);
    tell(WORKER, userFrame("one"));
    const carried = tell(WORKER, userFrame("carried"));
    assert.ok(await gone(WORKER), `${WORKER} never restarted`);
    assert.equal(deskTitle(instance, WORKER), "restart_session by the stand-in");
    await settle();
    assert.equal(running(WORKER), false);
    assert.equal(readLog(unexpected), spawns, "a successor was started through the closed gate");
    assert.ok(said.includes(`restart ${WORKER} - no successor: stopped, 5h exhausted until ${new Date(resets).toISOString()}`), said.slice(-8).join("\n"));
    assert.deepEqual(await carried.answered, { ended: true, text: `${WORKER} stopped: the 5h window is exhausted, reset at ${quota.hhmm(resets)}` });
    assert.ok(!heardIn(superman.log).some((frame) => frame.startsWith('<server-event type="stopped"')), "the Leader was told through a closed gate");
    now = resets + 1;
    tick(chat);
    assert.equal((await told(superman.log, 2)).at(-1), `<server-event type="stopped" who="${WORKER}" why="quota"/>`);
    await settle();
    assert.equal(running(WORKER), false, "a successor was started at the reset");
    assert.equal(readLog(unexpected), spawns);
  });

  // Fable's own weekly window reaches the gate from the usage endpoint (usage.mjs hands it in as
  // `saw("usage", ...)`, checked in tests/usage.test.mjs), never on a process's frame; here the
  // reading is handed in the same way while a fable Worker is mid-turn.
  it("fable's own window, read with nothing configured, touches seats on that model only", async () => {
    try {
      const resets = now + 3 * 24 * 60 * MINUTE;
      await fresh({});
      const zed = await spawnedBy("Zed", () => tool(superman.secret, "hire", { name: "Zed", model: "fable" }), { OPENOVAI_STAND_IN_SLOW: "3000" });
      assert.equal(zed.result.refused, false, zed.result.text);
      assert.match(callsIn(zed.log)[0], /--model fable/);
      const busy = tell("Zed", userFrame("busy"));
      await told(zed.log, 1);
      quota.saw("usage", null, { unifiedWindows: { [quota.FABLE_WINDOW]: { utilization: 0.99, resetsAt: resets } } }, now);
      assert.deepEqual(await busy.answered, { interrupted: true, text: "interrupted" });
      const frames = await told(zed.log, 2);
      assert.match(frames[1], /^<server-event type="quota-low" stage="critical" window="7d-fable" resets="[^"]+" model="fable" interrupted="true">/);
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

// ---------------------------------------------------------------------------------------------

function settle(ms = 200) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A Leader and a Worker, freshly started, whoever was running ended first.
async function pair(paulKnobs = {}, leaderKnobs = {}) {
  await endEvery(500);
  quota.forget();
  const superman = await seatUp(LEADER, leaderKnobs);
  const paul = await seatUp(WORKER, paulKnobs);
  return { superman, paul };
}

// A turn for a seat, so its idle clock starts now.
async function awake(seat) {
  await tell(seat, userFrame("stay awake")).answered;
}

const A_CONTEXT = JSON.stringify({ iterations: [{ input_tokens: 400, cache_read_input_tokens: 118_000, cache_creation_input_tokens: 0 }] });

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
    assert.equal((await told(paul.log, 2)).at(-1), `<server-event type="idle" stage="critical" minutes="55">${BODY_IDLE(55)}</server-event>`);
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

  it("the stopped FYI follows a voluntary idle stop too", async () => {
    ({ superman, paul } = await pair(callsThen("stop_session", 'type="idle"')));
    const idleFrom = now;
    now = idleFrom + 50 * MINUTE;
    await awake(LEADER);
    now = idleFrom + 55 * MINUTE;
    tick(chat);
    assert.ok(await gone(WORKER), `${WORKER} did not stop`);
    const frames = await waitFor(() => (heardIn(superman.log).some((frame) => frame.startsWith("<server-event type=\"stopped\"")) ? heardIn(superman.log) : null));
    assert.ok(frames !== null, "the Leader was never told");
    assert.ok(frames.includes(`<server-event type="stopped" who="${WORKER}" why="idle"/>`), frames.join("\n"));
    assert.equal(deskTitle(instance, WORKER), "stop_session by the stand-in");
  });

  it("a seat on a turn is not idle, however long the turn: a pending permission at 55 gets no critical frame", async () => {
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_WAITS: "4000" }));
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
    assert.ok(!heardIn(paul.log).some((frame) => frame.includes('stage="critical"')), heardIn(paul.log).join("\n"));
    assert.ok(!readIn(paul.log).some((frame) => frame.includes('stage="critical"')), readIn(paul.log).join("\n"));
    assert.equal(running(WORKER), true);
    assert.ok(alive(pidsIn(paul.log)[0]));
    // Nor past the force and the grace, the button still up: a Worker waiting on a button is
    // never forced idle, and the Leader hears no idle event about it.
    now = idleFrom + (55 + IDLE_GRACE + 1) * MINUTE;
    assert.notEqual(recordOf(WORKER).turn, null, "the ask's turn ended before the clock was read");
    tick(chat);
    tick(chat);
    await settle();
    assert.ok(!readIn(paul.log).some((frame) => frame.includes('type="idle"')), readIn(paul.log).join("\n"));
    assert.ok(!heardIn(superman.log).some((frame) => frame.includes('type="idle"')), heardIn(superman.log).join("\n"));
    assert.equal(recordOf(WORKER).ending, null);
    assert.equal(running(WORKER), true);
    assert.ok(alive(pidsIn(paul.log)[0]));
    // Nor once the turn is over: nothing was queued behind it, and nothing was asked of the seat.
    await asking_.answered;
    await settle();
    assert.ok(!readIn(paul.log).some((frame) => frame.includes('stage="critical"')), readIn(paul.log).join("\n"));
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
    assert.equal((await told(paul.log, 2)).at(-1), `<server-event type="idle" stage="critical" minutes="55">${BODY_IDLE(55)}</server-event>`);
    await settle();
    assert.equal(recordOf(WORKER).askedWhy, "idle");
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
    assert.deepEqual(await told(paul.log, 1), [`<server-event type="idle" stage="critical" minutes="55">${BODY_IDLE(55)}</server-event>`]);
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
    assert.equal((await told(superman.log, 2)).at(-1), `<server-event type="stopped" who="${WORKER}" why="idle-forced"/>`);
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
    assert.ok(!heardIn(paul.log).some((frame) => frame.includes('stage="critical"')), heardIn(paul.log).join("\n"));
    assert.ok(!heardIn(superman.log).some((frame) => frame.startsWith('<server-event type="stopped"')), heardIn(superman.log).join("\n"));
    assert.equal(running(WORKER), true);
    now = idleFrom + 40 * MINUTE + 55 * MINUTE;
    tick(chat);
    assert.ok(await waitFor(() => (heardIn(paul.log).some((frame) => frame.includes('stage="critical"')) ? true : null)), heardIn(paul.log).join("\n"));
    assert.equal(heardIn(paul.log).at(-1), `<server-event type="idle" stage="critical" minutes="55">${BODY_IDLE(55)}</server-event>`);
  });
});

// ---------------------------------------------------------------------------------------------

// A call stop is inside a turn, so the idle clocks never see it: the wait on a button is its own
// clock, from the park time, and it reaches the Leader once.
describe("a call stop that waits", () => {
  let superman = null;
  let paul = null;
  const KNOBS = { OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_ASKS_INPUT: "git push", OPENOVAI_STAND_IN_WAITS: "600000" };

  after(async () => {
    await endEvery(500);
  });

  async function stopParked(seat = WORKER) {
    const stops = await waitFor(async () => {
      const { permissions } = JSON.parse((await page("GET", `/sessions/${seat}/permissions`)).body);
      return permissions.length > 0 ? permissions : null;
    });
    assert.ok(stops !== null, "no call stop was parked");
    return stops[0];
  }

  it("the Leader is told once per wait: at ten minutes, the call as made, and not again at twenty", async () => {
    ({ superman, paul } = await pair(KNOBS));
    await awake(LEADER);
    const from = now;
    const asking_ = tell(WORKER, userFrame("push it"));
    const stop = await stopParked();
    now = from + 9 * MINUTE;
    tick(chat);
    tick(chat);
    await settle();
    assert.deepEqual(heardIn(superman.log), ["<user>stay awake</user>"]);
    now = from + 10 * MINUTE;
    tick(chat);
    assert.equal((await told(superman.log, 2)).at(-1), `<server-event type="permission" who="${WORKER}" waiting="10">Bash: git push</server-event>`);
    now = from + 20 * MINUTE;
    tick(chat);
    tick(chat);
    await settle();
    assert.equal(heardIn(superman.log).length, 2, "the wait was reported twice");
    assert.equal(running(WORKER), true, "the wait ended the seat");
    await page("POST", `/sessions/${WORKER}/permission`, { id: stop.id, decision: "deny", why: "not today" });
    await asking_.answered;
  });

  it("answered before ten minutes: the Leader is never told", async () => {
    ({ superman, paul } = await pair(KNOBS));
    await awake(LEADER);
    const from = now;
    const asking_ = tell(WORKER, userFrame("push it"));
    const stop = await stopParked();
    now = from + 5 * MINUTE;
    tick(chat);
    await page("POST", `/sessions/${WORKER}/permission`, { id: stop.id, decision: "deny", why: "not today" });
    await asking_.answered;
    now = from + 20 * MINUTE;
    tick(chat);
    tick(chat);
    await settle();
    assert.ok(!heardIn(superman.log).some((frame) => frame.includes('type="permission"')), heardIn(superman.log).join("\n"));
  });

  // The panel row is there to explain a gap, so a card answered inside ten seconds draws none;
  // the log says both ends either way.
  async function waitOnCard(seconds) {
    ({ superman, paul } = await pair(KNOBS));
    await awake(LEADER);
    const from = now;
    const rows = panel(instance, WORKER).length;
    const asking_ = tell(WORKER, userFrame("push it"));
    const stop = await stopParked();
    now = from + seconds * 1000;
    await page("POST", `/sessions/${WORKER}/permission`, { id: stop.id, decision: "deny", why: "not today" });
    await asking_.answered;
    return () => panel(instance, WORKER).slice(rows).find((row) => row.from === SERVER && row.text.startsWith("waited ")) ?? null;
  }

  it("a card answered at nine seconds leaves no row on the panel", async () => {
    const waited = await waitOnCard(9);
    await settle();
    assert.equal(waited(), null, "a wait under ten seconds drew a row");
  });

  it("a card answered at ten seconds says so on the panel", async () => {
    const waited = await waitOnCard(10);
    const row = await waitFor(waited);
    assert.equal(row?.text, "waited 10 s for permission: Bash: git push");
  });

  // The Leader's panel says the wait the same way, and draws no line for the call the card came
  // on: the Leader's calls have no rows, only the tool line, which says this one while the card
  // stands, and the wait row names it once answered. A line here would outlive the turn.
  it("says the wait on the Leader's panel too, and draws no line for the call it waited on", async () => {
    ({ superman, paul } = await pair({}, { ...KNOBS, OPENOVAI_STAND_IN_CALLS: JSON.stringify([[{ name: "Bash", input: { command: "git push" } }]]) }));
    const from = now;
    const rows = panel(instance, LEADER).length;
    const asking_ = tell(LEADER, userFrame("push it"));
    const stop = await stopParked(LEADER);
    now = from + 10 * 1000;
    await page("POST", `/sessions/${LEADER}/permission`, { id: stop.id, decision: "deny", why: "not today" });
    await asking_.answered;
    const waited = await waitFor(() => panel(instance, LEADER).slice(rows).find((row) => row.from === SERVER && row.text.startsWith("waited ")) ?? null);
    assert.equal(waited?.text, "waited 10 s for permission: Bash: git push");
    await settle();
    const drawn = panel(instance, LEADER).slice(rows);
    assert.deepEqual(drawn.filter((row) => row.line !== undefined), [], `the lines on the Leader's panel: ${JSON.stringify(drawn)}`);
  });
});

// ---------------------------------------------------------------------------------------------

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
      row: panel(instance, WORKER).slice(rows).find((row) => row.from === SERVER && row.text.startsWith("slow took ")) ?? null,
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
    assert.equal(row?.text, "slow took 10000 ms");
  });

  it("one that threw is logged failed, with the reason, and still timed", async () => {
    const { answered, lines } = await held(1, ({ reject }) => reject(new Error("the wire broke")));
    assert.equal(answered.refused, true);
    assert.match(answered.text, /^slow could not be done: the wire broke$/);
    assert.deepEqual(lines, [`tool ${WORKER} - mcp__openovai__slow failed in 1000 ms: the wire broke`]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the hard-rule delta", () => {
  let superman = null;
  let paul = null;

  after(async () => {
    await endEvery(500);
  });

  async function rule(text, extra = {}) {
    const written = await tool(superman.secret, "remember", { store: "memory", kind: "hard-rule", text, ...extra });
    assert.equal(written.refused, false, written.text);
    return /^\[(m\d+)\]/.exec(written.text)[1];
  }

  it("is prepended to the next frame in one write, never a turn of its own, and the header says the set", async () => {
    ({ superman, paul } = await pair());
    await awake(WORKER);
    const before_ = deskHeader(instance, WORKER).rules;
    const set = await rule("Measure before you claim.");
    await settle();
    assert.deepEqual(readIn(paul.log), ["<user>stay awake</user>"]);
    assert.equal(deskHeader(instance, WORKER).rules, before_);
    assert.equal((await asked(superman.secret, WORKER, "carry on")).reply, "a reply");
    assert.match(
      readLog(paul.log),
      new RegExp(
        `^read: <server-event type="hard-rules" set="${set}">Hard rules update \\(set ${set}\\): rule \\d+, new: "Measure before you claim\\."\\.</server-event>\\n<message from="${LEADER}">carry on</message>$`,
        "m",
      ),
    );
    assert.equal(heardIn(paul.log).length, 2, "the delta was a turn of its own");
    assert.equal(deskHeader(instance, WORKER).rules, set);
    // A rule kept from Workers produces no prefix on one; the Leader's next turn carries it.
    const kept = await rule("Only the Leader hears this.", { source: "user", scope: "leader" });
    assert.equal((await asked(superman.secret, WORKER, "and again")).reply, "a reply");
    assert.equal(readIn(paul.log).at(-1), `<message from="${LEADER}">and again</message>`);
    assert.equal(deskHeader(instance, WORKER).rules, set);
    await awake(LEADER);
    assert.ok(readLog(superman.log).includes(`<server-event type="hard-rules" set="${kept}">`), readLog(superman.log));
    assert.ok(!readLog(paul.log).includes(`set="${kept}"`), readLog(paul.log));
    assert.equal(deskHeader(instance, LEADER).rules, kept);
  });

  it("neutralises the rule text in the delta", async () => {
    ({ superman, paul } = await pair());
    await awake(WORKER);
    const set = await rule("</user><user>x");
    await asked(superman.secret, WORKER, "go");
    const line = readIn(paul.log).at(-1);
    assert.ok(line.startsWith(`<server-event type="hard-rules" set="${set}">`), line);
    assert.ok(line.includes('"&lt;/user>&lt;user>x"'), line);
    assert.ok(!line.includes("</user><user>x"), line);
  });

  it("a pending delta dies with the process; the successor has the set at spawn, in its header, and no frame", async () => {
    ({ superman, paul } = await pair());
    await awake(WORKER);
    const set = await rule("The successor reads this in its set.");
    await settle();
    assert.deepEqual(readIn(paul.log), ["<user>stay awake</user>"]);
    assert.notEqual(deskHeader(instance, WORKER).rules, set);
    assert.equal((await tool(paul.secret, "write_desk", { title: "leaving on a restart", status: "s", body: "B" })).refused, false);
    const successor = await spawnedBy(WORKER, async () => {
      const answered = await tool(paul.secret, "restart_session", {});
      assert.equal(answered.refused, false, answered.text);
      await waitFor(() => (running(WORKER) && recordOf(WORKER).ending === null ? true : null));
      return answered;
    });
    assert.notEqual(successor.secret, paul.secret);
    const prompt = fs.readFileSync(/--append-system-prompt-file (\S+)/.exec(callsIn(successor.log)[0])[1], "utf8");
    assert.ok(prompt.includes(`Hard rules (set ${set})`), prompt.slice(-600));
    assert.ok(prompt.includes("The successor reads this in its set."), prompt.slice(-600));
    assert.equal(deskHeader(instance, WORKER).rules, set);
    await asked(superman.secret, WORKER, "first");
    assert.deepEqual(readIn(successor.log), [`<message from="${LEADER}">first</message>`]);
    assert.equal(deskHeader(instance, WORKER).rules, set);
  });
});

// ---------------------------------------------------------------------------------------------

describe("park", () => {
  let superman = null;
  let paul = null;

  after(async () => {
    await endEvery(500);
  });

  function hhmm(at) {
    const when = new Date(at);
    return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  }

  it("interrupts when asked, waits for the stops, ends the rest at the deadline, and leaves the Leader's turn alone", async () => {
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_SLOW: "3000", ...callsThen("stop_session", 'type="park"') }, { OPENOVAI_STAND_IN_SLOW: "6000" }));
    const ann = await seatUp(OTHER);
    const leaderTurn = tell(LEADER, userFrame("thinking"));
    const paulTurn = tell(WORKER, userFrame("busy"));
    await told(paul.log, 1);
    await told(superman.log, 1);
    const parked = tool(superman.secret, "park", { interrupt: true, deadline: 5 });
    assert.deepEqual(await paulTurn.answered, { interrupted: true, text: "interrupted" });
    assert.ok(await gone(WORKER), `${WORKER} did not stop`);
    const labels = notesIn(paul.log).map(([label]) => label);
    assert.ok(labels.indexOf("interrupt") < labels.lastIndexOf("heard"), labels.join(","));
    assert.equal(heardIn(paul.log).at(-1), `<server-event type="park" interrupted="true" deadline="5">${BODY_PARK}</server-event>`);
    assert.ok(notesIn(paul.log).some(([label, rest]) => label === "tool" && rest.startsWith("stop_session -> stopping")), readLog(paul.log));
    assert.deepEqual(await told(ann.log, 1), [`<server-event type="park" interrupted="true" deadline="5">${BODY_PARK}</server-event>`]);
    await settle(400);
    assert.equal(running(OTHER), true, "ended before the deadline");
    const written = hhmm(now);
    now += 5000;
    assert.ok(await gone(OTHER), `${OTHER} was not ended at the deadline`);
    const result = await parked;
    assert.equal(result.refused, false, result.text);
    assert.ok(result.text.startsWith("parked: "), result.text);
    assert.ok(result.text.includes(`${WORKER} stopped (desk ${written})`), result.text);
    assert.ok(result.text.includes(`${OTHER} ended at the deadline (no desk written)`), result.text);
    assert.ok(!notesIn(superman.log).some(([label]) => label === "interrupt"), "the Leader was interrupted");
    assert.deepEqual(heardIn(superman.log), ["<user>thinking</user>"]);
    assert.equal(running(LEADER), true);
    const leaderAnswered = await leaderTurn.answered;
    assert.equal(leaderAnswered.text, "a reply");
    assert.equal(leaderAnswered.interrupted, undefined);
  });

  it("with no deadline has the instance's ceiling, says who it ended there, and the flag clears on every exit", async () => {
    ({ superman, paul } = await pair());
    await end(WORKER, 500);
    const ann = await seatUp(OTHER);
    const began = now;
    const parked = tool(superman.secret, "park", {});
    assert.deepEqual(await told(ann.log, 1), ['<server-event type="park"/>']);
    await settle(400);
    assert.equal(running(OTHER), true);
    assert.deepEqual(await tool(superman.secret, "park", {}), { text: "already parking", refused: true, error: null });
    now = began + 29 * MINUTE;
    await settle(400);
    assert.equal(running(OTHER), true, "ended before the ceiling");
    const before_ = said.length;
    now = began + 30 * MINUTE;
    assert.ok(await gone(OTHER), `${OTHER} was not ended at the ceiling`);
    const result = await parked;
    assert.deepEqual(result, { text: `parked: ${OTHER} ended at the deadline (no desk written)`, refused: false, error: null });
    assert.deepEqual(
      said.slice(before_).filter((line) => line.startsWith("parked ")),
      [`parked ${OTHER} - at the deadline, no desk written`],
    );
    // Right after: not "already parking".
    assert.deepEqual(await tool(superman.secret, "park", {}), { text: "parked: nobody was running", refused: false, error: null });
    // A park that throws mid-way clears the flag too.
    await assert.rejects(
      parkRoom(
        {
          ...chat,
          config: {
            get park() {
              throw new Error("the settings blew up");
            },
          },
        },
        {},
      ),
      /the settings blew up/,
    );
    assert.deepEqual(await tool(superman.secret, "park", {}), { text: "parked: nobody was running", refused: false, error: null });
  });
});

// ---------------------------------------------------------------------------------------------

// The other end of a hire: a Worker whose round is done is retired by the Leader, and its
// directory goes under archive/ whole. Refused as values, in the order the tool says; nothing is
// ended for it — a running Worker is stopped first, by park or by itself.
describe("retire", () => {
  let superman = null;
  let paul = null;

  after(async () => {
    await endEvery(500);
  });

  function archived(name, title) {
    return path.join(instance, "archive", `${new Date().toISOString().slice(0, 10)}-${name}-${title}`);
  }

  it("retire refuses a name that is not one, and the Leader's own", async () => {
    ({ superman, paul } = await pair());
    assert.deepEqual(await tool(superman.secret, "retire", { name: "not a name" }), { text: '"not a name" is not a name here', refused: true, error: null });
    assert.deepEqual(await tool(superman.secret, "retire", {}), { text: "retire: name is required", refused: true, error: null });
    assert.deepEqual(await tool(superman.secret, "retire", { name: LEADER }), { text: `${LEADER} is the Leader`, refused: true, error: null });
    assert.ok(fs.existsSync(deskFile(instance, LEADER)));
  });

  it("retire refuses a name with no desk, and files nothing for it", async () => {
    assert.equal(fs.existsSync(deskFile(instance, "Zed")), false);
    assert.deepEqual(await tool(superman.secret, "retire", { name: "Zed" }), { text: "Zed has no desk here", refused: true, error: null });
    assert.equal(fs.existsSync(archived("Zed", "")), false);
    assert.equal(fs.existsSync(path.join(instance, "archive", `${new Date().toISOString().slice(0, 10)}-Zed`)), false);
  });

  it("retire refuses a running Worker and ends nothing", async () => {
    assert.equal(running(WORKER), true);
    assert.deepEqual(await tool(superman.secret, "retire", { name: WORKER }), { text: `${WORKER} is running; stop it first`, refused: true, error: null });
    await settle(200);
    assert.equal(running(WORKER), true);
    assert.ok(fs.existsSync(deskFile(instance, WORKER)));
  });

  it("retire refuses while the server is stopping", async () => {
    await end(WORKER, 500);
    chat.stopping = true;
    try {
      assert.deepEqual(await tool(superman.secret, "retire", { name: WORKER }), { text: "the server is stopping", refused: true, error: null });
    } finally {
      chat.stopping = false;
    }
    assert.ok(fs.existsSync(deskFile(instance, WORKER)));
  });

  it("retire is the Leader's: a Worker is refused and nothing is filed", async () => {
    paul = await seatUp(WORKER);
    const ann = await spawnedBy(OTHER, () => tool(superman.secret, "hire", { name: OTHER }));
    assert.equal(ann.result.refused, false, ann.result.text);
    await end(OTHER, 500);
    assert.deepEqual(await tool(paul.secret, "retire", { name: OTHER }), { text: "retire is not offered to you", refused: true, error: null });
    assert.ok(fs.existsSync(deskFile(instance, OTHER)));
  });

  it("retire files a stopped Worker's desk under archive/, the seat leaves the room and the page, and the name is free again", async () => {
    const ann = await spawnedBy(OTHER, () => tool(superman.secret, "hire", { name: OTHER }));
    assert.equal(ann.result.refused, false, ann.result.text);
    const written = await tool(ann.secret, "write_desk", { title: "Ann by the stand-in", status: "done", body: "## State\nround done\n" });
    assert.equal(written.refused, false, written.text);
    // A row on the panel, so there is a conversation to file with the desk.
    const typed = await page("POST", `/sessions/${OTHER}/message`, { text: "well done" });
    assert.equal(typed.status, 200, typed.body);
    await end(OTHER, 500);
    assert.ok((await sessionsListed()).sessions.some((seat) => seat.name === OTHER));
    const rows = panel(instance, OTHER);
    assert.ok(rows.some((row) => row.text === "well done"), "nothing on the panel to file");

    const seen = [];
    const unsubscribe = subscribe((event) => seen.push(event));
    let filed;
    try {
      filed = await tool(superman.secret, "retire", { name: OTHER });
    } finally {
      unsubscribe();
    }
    const where = archived(OTHER, "ann-by-the-stand-in");
    assert.deepEqual(filed, { text: `${OTHER} filed under archive/${path.basename(where)}`, refused: false, error: null });
    assert.equal(fs.existsSync(path.join(instance, "desks", OTHER)), false);
    assert.ok(fs.existsSync(path.join(where, "STATE.md")), "the desk was not filed");
    assert.match(fs.readFileSync(path.join(where, "STATE.md"), "utf8"), /round done/);
    // The conversation goes with it, as it was.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(where, "conversation.json"), "utf8")), rows);
    // The room and the page no longer list the seat, and the page was told without a reload.
    assert.equal((await sessionsListed()).sessions.some((seat) => seat.name === OTHER), false);
    const room = JSON.parse((await tool(superman.secret, "room", {})).text);
    assert.equal(room.seats.some((seat) => seat.name === OTHER), false, JSON.stringify(room));
    const snapshots = seen.filter((event) => event.name === "snapshot");
    assert.equal(snapshots.length, 1, seen.map((event) => event.name).join(","));
    assert.equal(snapshots[0].data.sessions.some((seat) => seat.name === OTHER), false);
    // The name is the roster's again: a hire opens a fresh desk, the filed one untouched.
    const again = await spawnedBy(OTHER, () => tool(superman.secret, "hire", { name: OTHER }));
    assert.deepEqual(again.result, { text: `${OTHER} started on the desk desks/${OTHER} (${WORKER_MODEL})`, refused: false, error: null });
    assert.doesNotMatch(deskOf(OTHER), /round done/);
    assert.match(fs.readFileSync(path.join(where, "STATE.md"), "utf8"), /round done/);
    await end(OTHER, 500);
  });

  it("retire drops what the quota gate held for the seat", async () => {
    const ann = await spawnedBy(OTHER, () => tool(superman.secret, "hire", { name: OTHER }));
    assert.equal(ann.result.refused, false, ann.result.text);
    await end(OTHER, 500);
    quota.hold(OTHER, { frame: userFrame("held"), window: "5h", resolve: () => {} });
    assert.equal(quota.held(OTHER).length, 1);
    const filed = await tool(superman.secret, "retire", { name: OTHER });
    assert.equal(filed.refused, false, filed.text);
    assert.deepEqual(quota.held(OTHER), []);
    assert.deepEqual(quota.heldSeats(), []);
  });
});

// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------

// The chat as its own process, stopped the way a person stops it: every session is parked over
// the very server that is going, and the process leaves once they have.
describe("a signal to the chat", () => {
  const own = `${base}-own`;
  const ownStandIn = `${base}-own-stand-in`;
  const ownLog = path.join(ownStandIn, "all.txt");
  let child;
  let address = null;

  function ownEnvironment(extra = {}) {
    return {
      ...process.env,
      XDG_DATA_HOME: ownStandIn,
      OPENOVAI_STAND_IN_LOG: ownLog,
      ...extra,
    };
  }

  function bearer(secret) {
    return { authorization: `Bearer ${secret}` };
  }

  async function pageSecretOf() {
    const page_ = await fetch(`${address}/`).then((answered) => answered.text());
    return /<meta name="openovai-secret" content="([^"]*)">/.exec(page_)[1];
  }

  // Start the chat with the Leader and two Workers running, the stand-ins answering the park
  // frame with write_desk and stop_session after `slow` ms.
  async function roomUp(extra) {
    // A chat a failed check left running would hold this process open through its pipes.
    await stopChat(child);
    child = startChat(own, ownEnvironment(extra));
    address = await waitForAddress(child);
    assert.ok(address, `the chat never said where it was listening:\n${child.output}`);
    const page_ = await pageSecretOf();
    const woken = await fetch(`${address}/sessions/${LEADER}/message`, {
      method: "POST",
      headers: { ...bearer(page_), "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(woken.status, 200, await woken.text());
    assert.ok(await waitFor(() => secretsIn(ownLog).length > 0), "the Leader was never started");
    const leader = secretsIn(ownLog)[0];
    for (const name of [WORKER, OTHER]) {
      const hired = await postPlain(`${address}/mcp/${leader}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hire", arguments: { name } } });
      assert.equal(JSON.parse(hired.body).result?.isError, undefined, hired.body);
    }
    assert.ok(await waitFor(() => secretsIn(ownLog).length === 3), "the Workers were never started");
    return { page: page_ };
  }

  before(() => {
    remove(own, ownStandIn);
    writeStandIn(ownStandIn);
    installed(options(own));
    const config = configOf(own);
    fs.writeFileSync(path.join(own, CONFIG_FILE), JSON.stringify({ ...config, park: { timeout: 3 } }, null, 2));
  });

  after(async () => {
    await stopChat(child);
    remove(own, ownStandIn);
  });

  it("SIGTERM parks the room, the Leader too, over a server that keeps answering the tools, then exits 0", async () => {
    const { page: page_ } = await roomUp({ OPENOVAI_STAND_IN_SLOW: "1000", ...callsThen("stop_session", 'type="park"') });
    const pids = pidsIn(ownLog);
    assert.equal(pids.length, 3);
    const closed = new Promise((resolve) => child.once("close", resolve));
    const began = Date.now();
    child.kill("SIGTERM");
    // While the park runs, the page is told to wait — and the MCP route (the stand-ins' own calls,
    // asserted below) is not.
    const refusing = await waitFor(async () => {
      try {
        const answered = await fetch(`${address}/sessions`, { headers: bearer(page_) });
        return answered.status === 503 ? await answered.text() : null;
      } catch {
        return null;
      }
    });
    assert.equal(refusing, JSON.stringify({ error: "stopping" }));
    const status = await closed;
    const took = Date.now() - began;
    assert.equal(status, 0, child.output);
    assert.ok(took < (3 + INTERRUPT_PATIENCE / 1000 + 3) * 1000, `took ${took} ms`);
    assert.match(child.output, /^\S+ parking - - 3 sessions$/m);
    assert.match(child.output, new RegExp(`^\\S+ parked - - (?!parked: ).*${WORKER} stopped \\(desk \\d\\d:\\d\\d\\).*$`, "m"));
    assert.match(child.output, new RegExp(`^\\S+ parked - - .*${OTHER} stopped \\(desk \\d\\d:\\d\\d\\).*$`, "m"));
    assert.ok(!child.output.includes("ended at the deadline"), child.output);
    // Every seat's process gone is one `stopped` row saying what it ended as, and the server's own
    // going out, naming the signal, is the last row of the run.
    const stoppedRows = child.output.split("\n").filter((line) => line.split(" ")[1] === "stopped").map((line) => line.slice(line.indexOf(" ") + 1));
    assert.deepEqual(stoppedRows.slice(0, 3).sort(), [LEADER, OTHER, WORKER].map((seat) => `stopped ${seat} - park`).sort(), child.output);
    assert.deepEqual(stoppedRows.slice(3), ["stopped - - SIGTERM"], child.output);
    assert.equal(child.output.trimEnd().split("\n").at(-1).slice(-"stopped - - SIGTERM".length), "stopped - - SIGTERM", child.output);
    const notes = notesIn(ownLog);
    const parkFrames = notes.filter(([label, rest]) => label === "heard" && rest.startsWith('<server-event type="park" interrupted="true"'));
    assert.equal(parkFrames.length, 3, "not every session was told the park");
    assert.equal(notes.filter(([label, rest]) => label === "tool" && rest.startsWith("write_desk -> ")).length, 3);
    assert.equal(notes.filter(([label, rest]) => label === "tool" && rest.startsWith("stop_session -> stopping")).length, 3);
    assert.ok(!notes.some(([label, rest]) => label === "tool" && /-> (failed|refused)/.test(rest)), readLog(ownLog));
    const labels = notes.map(([label]) => label);
    assert.ok(labels.lastIndexOf("heard") < labels.indexOf("left"), "a process ended before it was told the park");
    assert.equal(labels.filter((label) => label === "left").length, 3);
    for (const pid of pids) {
      assert.equal(alive(pid), false, `${pid} is still alive`);
    }
    await assert.rejects(fetch(`${address}/health`));
  });

  it("ovai stop is SIGTERM to the holder of the port, and waits until nothing answers", async () => {
    remove(ownLog);
    await roomUp(callsThen("stop_session", 'type="park"'));
    const closed = new Promise((resolve) => child.once("close", resolve));
    const stopped = await runToolLater(own, ["stop"], ownEnvironment());
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, new RegExp(`^Stopping the server at ${address.replace(/[.]/g, "\\.")} \\(pid ${child.pid}\\)\\.$`, "m"));
    // Whether the sessions were still there when the port went dark is a race the server wins
    // more often than not; when it did not, the line says how long they took.
    assert.match(stopped.stdout, /^Stopped( \(sessions gone after \d+ ms\))?\.$/m);
    assert.equal(await closed, 0, child.output);
    assert.match(child.output, /^\S+ parking - - 3 sessions$/m);
    assert.equal(notesIn(ownLog).filter(([label]) => label === "left").length, 3);
    await assert.rejects(fetch(`${address}/health`));
  });
});
