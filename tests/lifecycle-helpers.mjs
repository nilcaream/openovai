// The fixture the lifecycle suites share (tests/lifecycle*.test.mjs). Each suite file calls
// setup() once, with its own scratch name and its own clock, and runs as its own process: its own
// instance, stand-in and server, so node --test runs the files side by side.
//
// Served in the suite's process, with the clock injected: `chat.clock` is what every idle minute,
// reset and deadline is measured against, and `tick()` is called by hand where the server's own
// interval would call it. The stand-in (tests/helpers.mjs) is every process; what a seat was told
// is read from its log, never from what the server says it sent.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, it } from "node:test";

import { read } from "../lib/chat/conversation.mjs";
import { userFrame } from "../lib/chat/frames.mjs";
import { sink } from "../lib/chat/log.mjs";
import * as quota from "../lib/chat/quota.mjs";
import { pageSecret } from "../lib/chat/secrets.mjs";
import { serve, startSeat } from "../lib/chat/server.mjs";
import { end, endEvery, running, tell } from "../lib/chat/session.mjs";
import { deskFile, hire } from "../lib/desks.mjs";
import { CONFIG_FILE } from "../lib/seed.mjs";
import { heardIn, installed, notesIn, post as postPlain, remove, repo, sansMoment, scratch, secretsIn, waitFor, writeStandIn } from "./helpers.mjs";

export const USER = "Mike";
export const LEADER = "Superman";
export const WORKER = "Paul";
export const OTHER = "Ann";
export const LEADER_MODEL = "opus";
export const WORKER_MODEL = "sonnet";

export const MINUTE = 60_000;

// What was said on a panel: every row but the ones that say when a session started or ended,
// which one check of their own reads whole (`read`), so no other check counts them.
export function panel(root, seat) {
  return read(root, seat).filter((row) => row.stamp !== true);
}

// Set by setup(): every suite file is its own process with its own instance, stand-in and server.
export let base = null;
export let instance = null;
export let standIn = null;
// Where a process nobody expected to be started writes: a check that asserts no spawn reads it.
export let unexpected = null;

export function options(root) {
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

export function configOf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
}

// A reading the way the frame carries it: epoch seconds, each window its own reset.
export function reading(fiveHour, { sevenDay = 0.5, resets = null, extra = {}, status = "allowed", type = "five_hour" } = {}) {
  const at = (resets ?? clock() + 3 * 60 * MINUTE) / 1000;
  const week = (clock() + 3 * 24 * 60 * MINUTE) / 1000;
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

export const said = [];
export let chat = null;
export let server = null;
export let url = null;
let clock = () => Date.now();
const realData = process.env.XDG_DATA_HOME;

// The instance a suite file runs against, under its own scratch name, and the hooks that serve it
// in this process. `now` is the suite's clock: it reads the suite's own `now`, which its checks move
// by hand. `hired` is who has a desk before the first check: a suite whose checks start a seat
// without hiring it names that seat here.
export function setup(name, now, { hired = [WORKER] } = {}) {
  clock = now;
  base = scratch(name);
  instance = `${base}-instance`;
  standIn = `${base}-stand-in`;
  unexpected = path.join(standIn, "unexpected.txt");

  process.on("exit", () => {
    remove(instance, standIn);
  });

  remove(instance, standIn);
  writeStandIn(standIn);
  installed(options(instance));
  for (const seat of hired) {
    hire(instance, seat);
  }

  before(async () => {
    chat = { root: instance, config: configOf(instance), plugins: [], clock: () => clock() };
    sink((row) => said.push(sansMoment(row)));
    // Any spawn the chat makes on its own finds the stand-in, and one nobody arranged a log for
    // writes to the one every "no spawn" check reads.
    process.env.XDG_DATA_HOME = standIn;
    process.env.OPENOVAI_STAND_IN_LOG = unexpected;
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
}

// Start a seat through the one seam, with its own log and knobs on this process's environment for
// the spawn only.
let logs = 0;
export function nextLog(seat) {
  logs += 1;
  return path.join(standIn, `${seat}-${logs}.txt`);
}

export async function seatUp(seat, knobs = {}, { first = null } = {}) {
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
export async function spawnedBy(seat, act, knobs = {}) {
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

export function page(method, route, body) {
  return fetch(`${url}${route}`, {
    method,
    headers: { authorization: `Bearer ${pageSecret()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (answered) => ({ status: answered.status, body: await answered.text() }));
}

export function call(secret, method, params) {
  return postPlain(`${url}/mcp/${secret}`, { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
}

export function answerOf(answered) {
  const body = JSON.parse(answered.body);
  return { text: body.result?.content?.[0]?.text, refused: body.result?.isError === true, error: body.error ?? null };
}

export async function tool(secret, name, args = {}) {
  return answerOf(await call(secret, "tools/call", { name, arguments: args }));
}

// A message from one seat to another, and what the addressee then said at the end of its turn,
// read off its panel: the call itself comes back the moment the message is taken. `reply` is the
// text of the first row the addressee wrote on its own panel after the message, null when it
// wrote none before patience ran out or the call was refused.
export async function asked(secret, seat, text) {
  const at = panel(instance, seat).length;
  const said_ = await tool(secret, "message", { to: seat, text });
  if (said_.refused) {
    return { ...said_, reply: null };
  }
  const row = await waitFor(() => panel(instance, seat).slice(at).find((one) => one.from === seat && one.to === undefined && one.line === undefined) ?? null);
  return { ...said_, reply: row === null ? null : row.text };
}

// The frames a seat was told, once there are `count` of them — a queue frame counted as its
// items, since these checks are about what reached the seat and in what order.
export async function told(log, count) {
  await waitFor(() => (heardIn(log).length >= count ? true : null));
  return heardIn(log);
}

// The frames a seat was told, once `frame` is among them — for a frame that lands behind others
// the seat may already have, where a count would be met before it arrives.
export async function toldUntil(log, frame) {
  await waitFor(() => (heardIn(log).includes(frame) ? true : null));
  return heardIn(log);
}

// The same, without the turn the server hands a successor at birth: for the checks about what
// somebody else sent. That event has checks of its own, so no other check asserts it.
export function besideBirth(items) {
  return items.filter((one) => !one.startsWith('<server-event type="restarted"'));
}

// Every frame the run has been handed so far, as it arrived — before the run got round to it.
export function readIn(log) {
  return notesIn(log)
    .filter(([label]) => label === "read")
    .map(([, rest]) => rest);
}

// Whether a turn is still running, read without waiting on it. A stand-in's SLOW turn is the
// window a check needs something to land in; kept short, the check says so when it was too short
// rather than passing on a seat that had gone idle.
export function stillRunning(turn) {
  let open = true;
  turn.answered.finally(() => {
    open = false;
  });
  return () => open;
}

export async function gone(seat) {
  return waitFor(() => (running(seat) ? null : true));
}

// The tool calls a stand-in is to make on the frame naming `on`: write its desk, then the tool.
export function callsThen(name, on) {
  return {
    OPENOVAI_STAND_IN_TOOL: JSON.stringify([
      { name: "write_desk", arguments: { title: `${name} by the stand-in`, status: "leaving" } },
      { name, arguments: {} },
    ]),
    ...(on === undefined ? {} : { OPENOVAI_STAND_IN_TOOL_ON: on }),
  };
}

// A stand-in that writes its desk on a frame holding `on`, and does nothing else: a Worker told
// its session is closing does exactly this, and the close completes when the turn is over.
export function writesDesk(on) {
  return {
    OPENOVAI_STAND_IN_TOOL: JSON.stringify([{ name: "write_desk", arguments: { title: "a desk by the stand-in", status: "leaving" } }]),
    OPENOVAI_STAND_IN_TOOL_ON: on,
  };
}

export function deskOf(seat) {
  return fs.readFileSync(deskFile(instance, seat), "utf8");
}

export function sessionsListed() {
  return page("GET", "/sessions").then((answered) => JSON.parse(answered.body));
}

export function settle(ms = 200) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A Leader and a Worker, freshly started, whoever was running ended first.
export async function pair(paulKnobs = {}, leaderKnobs = {}) {
  await endEvery(500);
  quota.forget();
  const superman = await seatUp(LEADER, leaderKnobs);
  const paul = await seatUp(WORKER, paulKnobs);
  return { superman, paul };
}

// A turn for a seat, so its idle clock starts now.
export async function awake(seat) {
  await tell(seat, userFrame("stay awake")).answered;
}

export const A_CONTEXT = JSON.stringify({ iterations: [{ input_tokens: 400, cache_read_input_tokens: 118_000, cache_creation_input_tokens: 0 }] });
