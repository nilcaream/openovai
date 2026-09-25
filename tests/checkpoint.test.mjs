// A Worker's checkpoint: the Leader sets a number of tool calls on its order, the server counts the
// Worker's own calls and, when they reach it, tells the Worker to report and carry on and tells
// the Leader it did. And an urgent message: the Leader's word into a Worker's turn under way.
// Driven through the real chat with stand-ins for both seats.

import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import fs from "node:fs";
import { serverEvent } from "../lib/chat/frames.mjs";
import { BODY_CHECKPOINT, BODY_CHECKPOINT_LEADER } from "../lib/chat/lifecycle.mjs";
import { sink } from "../lib/chat/log.mjs";
import { serve, startSeat, toolsFor } from "../lib/chat/server.mjs";
import { endEvery } from "../lib/chat/session.mjs";
import { LEADER as LEADER_ROLE, WORKER as WORKER_ROLE, hire } from "../lib/desks.mjs";
import { CONFIG_FILE } from "../lib/seed.mjs";
import { heardIn, installed, notesIn, post as postPlain, remove, repo, sansMoment, scratch, secretsIn, waitFor, writeStandIn } from "./helpers.mjs";

const USER = "Mike";
const LEADER = "Superman";
const WORKER = "Paul";

const base = scratch("checkpoint-test");
const instance = `${base}-instance`;
const standIn = `${base}-stand-in`;

process.on("exit", () => {
  remove(instance, standIn);
});

const said = [];
let chat = null;
let server = null;
let url = null;
const realData = process.env.XDG_DATA_HOME;

remove(instance, standIn);
writeStandIn(standIn);
installed({
  "--root": instance,
  "--source": repo,
  "--user": USER,
  "--leader": LEADER,
  "--leader-model": "opus",
  "--worker-model": "sonnet",
  "--port": 0,
  "--auth": "login",
});
hire(instance, WORKER);

before(async () => {
  chat = { root: instance, config: JSON.parse(fs.readFileSync(path.join(instance, CONFIG_FILE), "utf8")), plugins: [] };
  sink((row) => said.push(sansMoment(row)));
  process.env.XDG_DATA_HOME = standIn;
  process.env.OPENOVAI_STAND_IN_LOG = path.join(standIn, "unexpected.txt");
  server = await serve(chat);
  url = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await endEvery(500);
  await new Promise((resolve) => server.close(resolve));
  sink(null);
  process.env.XDG_DATA_HOME = realData;
  delete process.env.OPENOVAI_STAND_IN_LOG;
});

// A seat started through the one seam, with its own log and knobs on the environment for the spawn.
async function seatUp(seat, knobs = {}, logName = seat) {
  const log = path.join(standIn, `${logName}.txt`);
  const before_ = { ...process.env };
  process.env.OPENOVAI_STAND_IN_LOG = log;
  Object.assign(process.env, knobs);
  try {
    startSeat(chat, seat);
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in before_)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, before_);
  }
  assert.ok(await waitFor(() => secretsIn(log).length > 0), `${seat} never logged its secret`);
  return { log, secret: secretsIn(log)[0] };
}

async function tool(secret, name, args) {
  const answered = await postPlain(`${url}/mcp/${secret}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const body = JSON.parse(answered.body);
  return { text: body.result?.content?.[0]?.text, refused: body.result?.isError === true };
}

async function toldUntil(log, frame) {
  await waitFor(() => (heardIn(log).includes(frame) ? true : null));
  return heardIn(log);
}

const call = (command) => ({ name: "Bash", input: { command } });

describe("a checkpoint", () => {
  let leader = null;
  let worker = null;

  before(async () => {
    leader = await seatUp(LEADER);
    // The order's turn: two calls of its own and one of a subagent's, which is not the Worker's
    // and is not counted. The second message's turn: one more, the third.
    worker = await seatUp(WORKER, {
      OPENOVAI_STAND_IN_CALLS: JSON.stringify([[call("ls"), { ...call("sub"), parent: "agent-1" }, call("pwd")], [call("date")], []]),
    });
  });

  it("is offered to the Leader only", () => {
    const schemaFor = (seat, role) => toolsFor(chat, { seat, role }).find((one) => one.name === "message").inputSchema.properties;
    assert.ok("checkpoint" in schemaFor(LEADER, LEADER_ROLE));
    assert.ok(!("checkpoint" in schemaFor(WORKER, WORKER_ROLE)));
  });

  it("refuses a Worker's and one that is no number of calls", async () => {
    assert.equal((await tool(worker.secret, "message", { to: LEADER, text: "hi", checkpoint: 3 })).text, "a checkpoint is the Leader's to set");
    assert.equal((await tool(leader.secret, "message", { to: WORKER, text: "hi", checkpoint: 0 })).text, "a checkpoint is a whole number of calls, at least 1");
  });

  it("tells both when the Worker's own calls reach it, once", async () => {
    assert.equal((await tool(leader.secret, "message", { to: WORKER, text: "the order", checkpoint: 3 })).refused, false);
    await waitFor(() => (heardIn(worker.log).length >= 1 ? true : null));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!said.some((row) => row.includes("checkpoint")), "reached before the third call of the Worker's own");
    assert.equal((await tool(leader.secret, "message", { to: WORKER, text: "and then" })).refused, false);
    const toWorker = serverEvent("checkpoint", { calls: "3" }, BODY_CHECKPOINT(3)).text;
    const toLeader = serverEvent("checkpoint", { who: WORKER, calls: "3" }, BODY_CHECKPOINT_LEADER(WORKER, 3)).text;
    assert.ok((await toldUntil(worker.log, toWorker)).includes(toWorker), heardIn(worker.log).join("\n"));
    assert.ok((await toldUntil(leader.log, toLeader)).includes(toLeader), heardIn(leader.log).join("\n"));
    assert.equal(said.filter((row) => /^checkpoint\s+Paul\s+-\s+3 calls$/.test(row.trim())).length, 1, said.join("\n"));
  });
});

// An urgent message does not wait for the Worker's turn to end: it goes in at the Worker's next
// call, as a line the User types does, with whatever was queued ahead of it, and the turn's one
// result answers them all. A message that is not urgent waits for the turn's end.
describe("an urgent message", () => {
  let leader = null;
  let worker = null;
  const from = (text, urgent = false) => `<message from="${LEADER}"${urgent ? ` urgent="true"` : ""}>${text}</message>`;
  const noted = (label) => notesIn(worker.log).filter(([one]) => one === label).map(([, rest]) => rest);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 300));

  before(async () => {
    await endEvery(500);
    leader = await seatUp(LEADER, {}, "urgent-leader");
    // Each of the first two turns holds a call out for three seconds; the third makes none.
    worker = await seatUp(WORKER, { OPENOVAI_STAND_IN_CALLS: JSON.stringify([[call("ls")], [call("pwd")], []]), OPENOVAI_STAND_IN_CALL_HOLDS: "3000" }, "urgent-worker");
  });

  it("is offered to the Leader only", () => {
    const schemaFor = (seat, role) => toolsFor(chat, { seat, role }).find((one) => one.name === "message").inputSchema.properties;
    assert.ok("urgent" in schemaFor(LEADER, LEADER_ROLE));
    assert.ok(!("urgent" in schemaFor(WORKER, WORKER_ROLE)));
  });

  it("refuses a Worker's and one that is not true or false", async () => {
    assert.equal((await tool(worker.secret, "message", { to: LEADER, text: "hi", urgent: true })).text, "urgent is the Leader's to set");
    assert.equal((await tool(leader.secret, "message", { to: WORKER, text: "hi", urgent: "yes" })).text, "message: urgent is not true or false");
  });

  it("joins the Worker's turn at its call, with what was queued ahead of it, and one result answers them all", async () => {
    assert.equal((await tool(leader.secret, "message", { to: WORKER, text: "first" })).refused, false);
    await waitFor(() => (heardIn(worker.log).length >= 1 ? true : null));
    await settled();
    assert.equal((await tool(leader.secret, "message", { to: WORKER, text: "queued" })).refused, false);
    assert.equal((await tool(leader.secret, "message", { to: WORKER, text: "now", urgent: true })).refused, false);
    await waitFor(() => (noted("answered").length >= 1 ? true : null));
    await settled();
    assert.deepEqual(noted("joined"), [from("queued"), from("now", true)]);
    const order = notesIn(worker.log).map(([label]) => label);
    assert.ok(order.indexOf("joined") < order.indexOf("answered"), order.join(" "));
    assert.deepEqual(heardIn(worker.log), [from("first")]);
    assert.equal(noted("answered").length, 1);
  });

  it("waits for the turn's end when it is not urgent", async () => {
    assert.equal((await tool(leader.secret, "message", { to: WORKER, text: "second" })).refused, false);
    await waitFor(() => (heardIn(worker.log).length >= 2 ? true : null));
    await settled();
    assert.equal((await tool(leader.secret, "message", { to: WORKER, text: "plain" })).refused, false);
    await waitFor(() => (noted("answered").length >= 3 ? true : null));
    assert.equal(noted("joined").length, 2, "a message that is not urgent joined a turn under way");
    assert.deepEqual(heardIn(worker.log), [from("first"), from("second"), from("plain")]);
  });
});
