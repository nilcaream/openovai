// The lifecycle, the endings: the page's STOP, a call stop that waits, park, retire, a signal to
// the chat — a server stop that parks first — and what admin mode left behind.
//
// The fixture is tests/lifecycle-helpers.mjs. Every mutation in
// tests/mutations-lifecycle-stop.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { SERVER, read } from "../lib/chat/conversation.mjs";
import { subscribe } from "../lib/chat/events.mjs";
import { userFrame } from "../lib/chat/frames.mjs";
import { ADMIN_FILE } from "../lib/admin.mjs";
import { BODY_PARK, adminTold, deliver, parkRoom, tick } from "../lib/chat/lifecycle.mjs";
import * as quota from "../lib/chat/quota.mjs";
import { INTERRUPT_PATIENCE, end, endEvery, recordOf, running, tell } from "../lib/chat/session.mjs";
import { deskFile, hire } from "../lib/desks.mjs";
import { CONFIG_FILE } from "../lib/seed.mjs";
import { alive, heardIn, installed, notesIn, pidsIn, post as postPlain, readLog, remove, runToolLater, secretsIn, startChat, stopChat, waitFor, waitForAddress, writeStandIn } from "./helpers.mjs";

import { setup, LEADER, WORKER, OTHER, WORKER_MODEL, MINUTE, panel, base, instance, standIn, unexpected, options, configOf, said, chat, server, seatUp, spawnedBy, page, call, tool, asked, told, stillRunning, gone, callsThen, deskOf, sessionsListed, settle, pair, awake } from "./lifecycle-helpers.mjs";

let now = Date.now();
// Ann is hired before the first check: these checks start her without a hire of their own, as
// they did when they ran after the ones that hire her.
setup("lifecycle-stop-test", () => now, { hired: [WORKER, OTHER] });

// ---------------------------------------------------------------------------------------------

describe("the page's STOP", () => {
  let paul = null;

  after(async () => {
    await endEvery(500);
  });

  it("interrupts the turn and nothing else: the process stays, the next frame goes in", async () => {
    // Only long enough that the turn is still running when the stop lands. The check waits for
    // the turn below before it posts, so this has one localhost POST to outlast, not five seconds
    // of guessing.
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_SLOW: "1000" });
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
    assert.equal((await told(superman.log, 2)).at(-1), `<server-event type="permission" who="${WORKER}" minutes="10">Bash: git push</server-event>`);
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

// A message queued behind a Worker's last turn, before it stops itself, is never read: the sender
// is told, with the words, and its panel says so.
describe("a message to a Worker that stops before reading it", () => {
  after(async () => {
    await endEvery(500);
  });

  it("goes back to the sender as an undelivered event with the words, and a row on its panel", async () => {
    const { superman } = await pair({ OPENOVAI_STAND_IN_SLOW: "1500", ...callsThen("stop_session", "wrap up") });
    const paulTurn = tell(WORKER, userFrame("wrap up"));
    await waitFor(() => (recordOf(WORKER)?.turn !== null ? true : null));
    const sent = await tool(superman.secret, "message", { to: WORKER, text: "one more order" });
    assert.equal(sent.text, `sent to ${WORKER}`);
    assert.equal(recordOf(WORKER).ending, null, "the Worker was already ending: not the case measured");
    await paulTurn.answered;
    assert.ok(await gone(WORKER), `${WORKER} did not stop`);
    const frame = `<server-event type="undelivered" to="${WORKER}">one more order</server-event>`;
    assert.ok(await waitFor(() => (heardIn(superman.log).includes(frame) ? true : null)), heardIn(superman.log).join("\n"));
    const row = panel(instance, LEADER).find((one) => one.from === SERVER && one.text === `not delivered: ${WORKER} stopped before reading it`);
    assert.ok(row !== undefined, JSON.stringify(panel(instance, LEADER).slice(-5)));
  });
});

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
    ({ superman, paul } = await pair({ OPENOVAI_STAND_IN_SLOW: "1000", ...callsThen("stop_session", 'type="park"') }, { OPENOVAI_STAND_IN_SLOW: "3500" }));
    const ann = await seatUp(OTHER);
    const leaderTurn = tell(LEADER, userFrame("thinking"));
    const leaderBusy = stillRunning(leaderTurn);
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
    assert.equal(leaderBusy(), true, "the Leader's turn ended before the park did, so nothing below proves it was left alone");
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
    fs.appendFileSync(deskFile(instance, OTHER), "## State\nround done\n");
    const written = await tool(ann.secret, "write_desk", { title: "Ann by the stand-in", status: "done" });
    assert.equal(written.refused, false, written.text);
    // A row on the panel, so there is a conversation to file with the desk.
    const typed = await page("POST", `/sessions/${OTHER}/message`, { text: "well done" });
    assert.equal(typed.status, 200, typed.body);
    await end(OTHER, 500);
    assert.ok((await sessionsListed()).sessions.some((seat) => seat.name === OTHER));
    const rows = read(instance, OTHER);
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

  // The other end of the hired row: what the Worker ran on, read while the desk is still there to
  // say so, and where the desk went, so the filed round can be found from the log.
  it("writes a retired row with the model it ran on and where the desk went", async () => {
    // On a model of its own, not the workspace's, which is why the desk has to be a new one: the
    // desk is where the model is written down, and a row that reads it once the desk is filed
    // says the workspace's default instead and is wrong.
    assert.notEqual("opus", WORKER_MODEL);
    assert.equal(fs.existsSync(deskFile(instance, "Kit")), false);
    const kit = await spawnedBy("Kit", () => tool(superman.secret, "hire", { name: "Kit", model: "opus" }));
    assert.equal(kit.result.refused, false, kit.result.text);
    await end("Kit", 500);
    const logged = said.length;
    const filed = await tool(superman.secret, "retire", { name: "Kit" });
    assert.equal(filed.refused, false, filed.text);
    const where = filed.text.slice("Kit filed under ".length);
    assert.match(where, /^archive\/\d{4}-\d{2}-\d{2}-Kit/);
    assert.deepEqual(said.slice(logged).filter((line) => line.startsWith("retired ")), [`retired Kit - opus, filed under ${where}`]);
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

  // Start the chat with the Leader and the Workers named running, the stand-ins answering the park
  // frame with write_desk and stop_session after `slow` ms.
  async function roomUp(extra, workers = [WORKER, OTHER]) {
    // A chat a failed check left running would hold this process open through its pipes.
    await stopChat(child);
    // Each room counts its own sessions: the log starts empty.
    fs.rmSync(ownLog, { force: true });
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
    for (const name of workers) {
      const hired = await postPlain(`${address}/mcp/${leader}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hire", arguments: { name } } });
      assert.equal(JSON.parse(hired.body).result?.isError, undefined, hired.body);
    }
    assert.ok(await waitFor(() => secretsIn(ownLog).length === 1 + workers.length), "the Workers were never started");
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

  // The Leader alone, slower than the patience a session is ended with: the park waits for it as
  // for any other session, so it writes its desk and stops itself rather than being taken down.
  it("SIGTERM waits for the Leader to write its desk and stop, when it is the only one running", async () => {
    await roomUp({ OPENOVAI_STAND_IN_SLOW: "2500", ...callsThen("stop_session", 'type="park"') }, []);
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    assert.equal(await closed, 0, child.output);
    assert.match(child.output, new RegExp(`^\\S+ parked - - ${LEADER} stopped \\(desk \\d\\d:\\d\\d\\)$`, "m"));
    assert.match(child.output, new RegExp(`^\\S+ stopped ${LEADER} - park$`, "m"));
    const notes = notesIn(ownLog);
    assert.equal(notes.filter(([label, rest]) => label === "tool" && rest.startsWith("write_desk -> ")).length, 1, readLog(ownLog));
    assert.equal(notes.filter(([label, rest]) => label === "tool" && rest.startsWith("stop_session -> stopping")).length, 1, readLog(ownLog));
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

// What `ovai claude` left at the root, and the one thing the server says on its own account at a
// start. The Leader alone is told; a Worker running at the time hears nothing of it. And the
// record is taken away when the frame has really reached the Leader and not before — the two
// failure modes are a notice lost for ever and a notice every future session hears again.
describe("what admin mode left behind", () => {
  const left = path.join(instance, ADMIN_FILE);
  const ended = "2026-09-23T10:20:00.000Z";

  before(async () => {
    // Nothing running, so a process started inside a check is the one that check caused.
    await endEvery(500);
  });

  it("says nothing and starts nobody when there is no record", async () => {
    assert.equal(fs.existsSync(left), false);
    const spawns = secretsIn(unexpected).length;
    assert.equal(adminTold(chat), false);
    assert.equal(secretsIn(unexpected).length, spawns, "something was started for a record that is not there");
    assert.ok(!running(LEADER));
  });

  it("keeps the record when the Leader cannot be started, so the next start still tells it", async () => {
    fs.writeFileSync(left, `${JSON.stringify({ ended, changed: [".mcp.json"] }, null, 2)}\n`);
    const real = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(standIn, "nothing-installed-here");
    try {
      assert.equal(adminTold(chat), false);
      assert.equal(fs.existsSync(left), true, "the notice was thrown away by a telling that never happened");
    } finally {
      process.env.XDG_DATA_HOME = real;
      // Not left for the running server's own look, which would start the Leader between checks.
      fs.rmSync(left, { force: true });
    }
  });

  it("tells the Leader what moved at the next start, tells no Worker, and takes the record away", async () => {
    const paul = await seatUp(WORKER);
    const moved = ["plugins installed: lint@corp (enabled)", "MCP servers added: linear (user scope)"];
    fs.writeFileSync(left, `${JSON.stringify({ ended, changed: [".claude/settings.json", ".mcp.json"], moved }, null, 2)}\n`);
    const born = await spawnedBy(LEADER, async () => adminTold(chat));
    assert.equal(born.result, true);
    const [heard] = await told(born.log, 1);
    assert.match(heard, /<server-event type="admin-closed" ended="2026-09-23T10:20:00\.000Z" changed="2"/);
    assert.match(heard, /What changed: plugins installed: lint@corp \(enabled\); MCP servers added: linear \(user scope\)\./);
    assert.match(heard, /Files: \.claude\/settings\.json, \.mcp\.json\./);
    assert.match(heard, /until the User runs `ovai restart`/);
    assert.ok(await waitFor(() => (fs.existsSync(left) ? null : true)), "the record is still at the instance root");
    assert.deepEqual(
      heardIn(paul.log).filter((one) => one.includes("admin-closed")),
      [],
    );
  });

  it("hands a notice on its way over once, however often the server looks", async () => {
    await endEvery(500);
    // The Leader mid-turn, so the notice waits in its queue and the record stays while it does.
    const leader = await seatUp(LEADER, { OPENOVAI_STAND_IN_SLOW: "1500" });
    deliver(chat, LEADER, userFrame("a turn that takes a while"));
    fs.writeFileSync(left, `${JSON.stringify({ ended: "2026-09-23T10:30:00.000Z", changed: [], moved: [] }, null, 2)}\n`);
    assert.deepEqual([adminTold(chat), adminTold(chat)], [true, false]);
    assert.ok(await waitFor(() => (fs.existsSync(left) ? null : true)), "the record is still at the instance root");
    await told(leader.log, 2);
    assert.equal(heardIn(leader.log).filter((one) => one.includes("admin-closed")).length, 1);
  });

  it("tells a running Leader within seconds of the door closing, with no restart", async () => {
    await endEvery(500);
    const leader = await seatUp(LEADER);
    fs.writeFileSync(left, `${JSON.stringify({ ended: "2026-09-23T10:40:00.000Z", changed: [".mcp.json"], moved: ["MCP servers added: linear (project scope)"] }, null, 2)}\n`);
    // Nothing here calls adminTold: the served instance's own tick is what has to notice.
    // One wait is 5 s, the tick's own period, so three are two ticks and a margin.
    let heard = null;
    for (let wait = 0; heard === null && wait < 3; wait += 1) {
      heard = await waitFor(() => heardIn(leader.log).find((one) => one.includes('ended="2026-09-23T10:40:00.000Z"')) ?? null);
    }
    assert.ok(heard, "the running server never told the Leader that admin mode closed");
    assert.match(heard, /MCP servers added: linear \(project scope\)/);
    assert.ok(await waitFor(() => (fs.existsSync(left) ? null : true)), "the record is still at the instance root");
  });
});
