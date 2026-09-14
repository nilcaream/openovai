// What the page shows, decided without a document: where the panels go, when one appears, dims
// and goes, what takes input, what the heads, the title and the quota line carry.
// Every mutation in tests/mutations-panels.json names the check it was written to redden.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AMBER, CONNECTED, DISCONNECTED, GONE_AFTER, GREEN, RED, STOPPING, applyEvent, composersEnabled, dot, fresh, head, keyAction, place, prune, quotaLine, quotaTitle, stopEnabled, title } from "../lib/chat/panels.mjs";

const LEADER = "Leader";

function about(name, extra = {}) {
  return { name, role: name === LEADER ? "Leader" : "Worker", model: "opus", running: true, busy: false, title: "", status: "", rules: "", ...extra };
}

function snapshot(sessions, extra = {}) {
  return { name: "snapshot", data: { user: "Mike", leader: LEADER, chat: "the chat", sessions, standing: {}, ...extra } };
}

function seat(name, extra = {}) {
  return { name: "seat", data: about(name, extra) };
}

function names(state) {
  return Object.keys(state.panels);
}

describe("placement", () => {
  it("the Leader is the middle panel and the Workers alternate left and right in hire order", () => {
    const placed = place(["W1", "W2", LEADER, "W3", "W4"], LEADER, ["W1", "W2", LEADER, "W3", "W4"]);
    assert.deepEqual(placed, { left: ["W1", "W3"], mid: LEADER, right: ["W2", "W4"] });
    assert.deepEqual(place(["W1", "W2", LEADER, "W3", "W4", "W5"], LEADER, ["W1", "W2", LEADER, "W3", "W4", "W5"]).left, ["W1", "W3", "W5"]);
  });

  it("the order is the order the panels appeared, not the order of a later snapshot", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul")]), 0);
    applyEvent(state, seat("Ann"), 1);
    applyEvent(state, snapshot([about("Ann"), about(LEADER), about("Paul")]), 2);
    assert.deepEqual(state.order, [LEADER, "Paul", "Ann"]);
    assert.deepEqual(place(names(state), state.leader, state.order), { left: ["Paul"], mid: LEADER, right: ["Ann"] });
  });
});

describe("the keys", () => {
  it("Enter sends, Shift+Enter is a newline, anything else is nothing", () => {
    assert.equal(keyAction({ key: "Enter", shiftKey: false, isComposing: false }), "send");
    assert.equal(keyAction({ key: "Enter", shiftKey: true, isComposing: false }), "newline");
    assert.equal(keyAction({ key: "a", shiftKey: false, isComposing: false }), null);
    assert.equal(keyAction({ key: "Enter", shiftKey: false, isComposing: true }), null);
  });
});

describe("a Worker's panel lives with its process", () => {
  it("a restart of seconds keeps the panel: dimmed while the process is gone, back when it is up, rows and all", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul")]), 0);
    applyEvent(state, { name: "rows", data: { seat: "Paul", since: 0, rows: [{ from: "user", text: "a" }, { from: "Paul", text: "b" }, { from: "user", text: "c" }] } }, 0);
    applyEvent(state, seat("Paul", { running: false }), 0);
    assert.equal(state.panels.Paul.dimmed, true);
    assert.equal(composersEnabled(state, "Paul"), false);
    assert.equal(stopEnabled(state, "Paul"), false);
    assert.deepEqual(prune(state, 10_000), []);
    applyEvent(state, seat("Paul", { running: true }), 10_000);
    assert.equal(state.panels.Paul.dimmed, false);
    assert.equal(state.panels.Paul.rows.length, 3);
    assert.equal(composersEnabled(state, "Paul"), true);
    assert.deepEqual(prune(state, 100_000), []);
    assert.ok(names(state).includes("Paul"));
  });

  it("a process that stays gone takes its panel with it after a while", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul")]), 0);
    applyEvent(state, seat("Paul", { running: false }), 0);
    // 30 s is the design's number, so it is a literal here: a check that only read GONE_AFTER
    // back would hold whatever the constant became.
    assert.equal(GONE_AFTER, 30_000);
    assert.deepEqual(prune(state, 29_999), []);
    assert.deepEqual(prune(state, 31_000), ["Paul"]);
    assert.ok(!names(state).includes("Paul"));
  });

  it("a Worker not running in the snapshot gets no panel; one started later does, without rows until asked", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul", { running: false })]), 0);
    assert.deepEqual(names(state), [LEADER]);
    applyEvent(state, seat("Paul"), 5);
    assert.deepEqual(names(state), [LEADER, "Paul"]);
    assert.equal(state.panels.Paul.rows, null);
    applyEvent(state, { name: "rows", data: { seat: "Paul", since: 0, rows: [{ from: "user", text: "a" }] } }, 6);
    assert.equal(state.panels.Paul.rows.length, 1);
  });

  it("a row lands at its index once; a row at a past index replaces the one there", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER)]), 0);
    applyEvent(state, { name: "rows", data: { seat: LEADER, since: 0, rows: [{ from: "user", text: "a" }] } }, 0);
    applyEvent(state, { name: "row", data: { seat: LEADER, index: 1, row: { from: LEADER, text: "b" } } }, 0);
    assert.deepEqual(state.panels[LEADER].amended, []);
    applyEvent(state, { name: "row", data: { seat: LEADER, index: 1, row: { from: LEADER, text: "b" } } }, 0);
    assert.deepEqual(state.panels[LEADER].rows.map((row) => row.text), ["a", "b"]);
    // A tool line written again once its call failed: the entry at that index is the new one, and
    // the index is listed for the page to mark.
    applyEvent(state, { name: "row", data: { seat: LEADER, index: 0, row: { from: "user", text: "a", err: true } } }, 0);
    assert.deepEqual(state.panels[LEADER].rows[0], { from: "user", text: "a", err: true });
    assert.deepEqual(state.panels[LEADER].amended, [1, 0]);
    assert.equal(state.panels[LEADER].rows.length, 2);
  });
});

describe("the Leader's panel", () => {
  it("is there whether or not the Leader runs, never dimmed, never pruned, its composer open", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { running: false })]), 0);
    assert.deepEqual(names(state), [LEADER]);
    assert.equal(state.panels[LEADER].dimmed, false);
    assert.deepEqual(prune(state, 60_000), []);
    assert.equal(composersEnabled(state, LEADER), true);
    applyEvent(state, seat(LEADER, { running: true }), 1);
    applyEvent(state, seat(LEADER, { running: false }), 2);
    assert.equal(state.panels[LEADER].dimmed, false);
    assert.deepEqual(prune(state, 200_000), []);
    assert.deepEqual(names(state), [LEADER]);
  });
});

describe("marks and controls", () => {
  it("the title is the product and the instance as the snapshot names it, marked while any panel asks", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER)], { instance: "~/work/inst" }), 0);
    assert.equal(title(state), "OpenOv AI ~/work/inst");
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [{ id: "r1", tool: "Bash", input: { command: "ls" } }] } }, 0);
    assert.equal(title(state), "● OpenOv AI ~/work/inst");
    assert.equal(title(fresh()), "OpenOv AI");
  });

  it("the panel that asks carries the mark, the title carries it while any panel asks", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul")], { instance: "~/inst" }), 0);
    assert.equal(title(state), "OpenOv AI ~/inst");
    applyEvent(state, { name: "asking", data: { seat: "Paul", pending: [{ id: "r1", tool: "Bash", input: { command: "ls" } }] } }, 0);
    assert.equal(title(state), "● OpenOv AI ~/inst");
    assert.equal(head(state, "Paul").state, "waiting for you");
    assert.equal(head(state, LEADER).state, "listening");
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [{ id: "u1", kind: "rule", rule: "Bash(git:*)", why: "w", from: LEADER }] } }, 0);
    assert.equal(head(state, LEADER).state, "waiting for you");
    applyEvent(state, { name: "asking", data: { seat: "Paul", pending: [] } }, 0);
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [] } }, 0);
    assert.equal(title(state), "OpenOv AI ~/inst");
    assert.equal(head(state, "Paul").state, "listening");
  });

  it("the head is the name, the model and the context in k, in parts", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { model: "opus", context: 41_200 }), about("Paul", { model: "" }), about("Ann", { model: "sonnet" })]), 0);
    assert.deepEqual(head(state, LEADER), { name: "Leader", info: "opus 41k", state: "listening" });
    assert.deepEqual(head(state, "Paul"), { name: "Paul", info: "", state: "listening" });
    assert.deepEqual(head(state, "Ann"), { name: "Ann", info: "sonnet", state: "listening" });
    applyEvent(state, seat("Ann", { model: "sonnet", context: 2_600 }), 1);
    assert.equal(head(state, "Ann").info, "sonnet 3k");
  });

  // The word follows the turn: a seat event with busy flips it, an ask outranks it, and a dimmed
  // panel says nothing — the fade and the red dot are its mark.
  it("the state word is listening between turns, working while one runs, waiting for you over both, and nothing on a dimmed panel", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { busy: true }), about("Paul")]), 0);
    assert.equal(head(state, LEADER).state, "working");
    assert.equal(head(state, "Paul").state, "listening");
    applyEvent(state, seat("Paul", { busy: true }), 0);
    assert.equal(head(state, "Paul").state, "working");
    applyEvent(state, { name: "asking", data: { seat: "Paul", pending: [{ id: "r1", tool: "Bash", input: { command: "ls" } }] } }, 0);
    assert.equal(head(state, "Paul").state, "waiting for you");
    applyEvent(state, { name: "asking", data: { seat: "Paul", pending: [] } }, 0);
    applyEvent(state, seat("Paul", { busy: false }), 0);
    assert.equal(head(state, "Paul").state, "listening");
    applyEvent(state, seat("Paul", { running: false, busy: true }), 0);
    assert.equal(state.panels.Paul.dimmed, true);
    assert.equal(head(state, "Paul").state, "");
  });

  // The dot follows the turn, and a gone process outranks it: red whatever its last turn was doing.
  it("the dot is green between turns, amber while one runs, red once the process is gone", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { busy: true }), about("Paul")]), 0);
    assert.equal(dot(state, LEADER), AMBER);
    assert.equal(dot(state, "Paul"), GREEN);
    applyEvent(state, seat("Paul", { running: false, busy: true }), 0);
    assert.equal(dot(state, "Paul"), RED);
  });

  it("the stop glyph is there while a turn runs and nowhere else", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul", { busy: true })]), 0);
    assert.equal(stopEnabled(state, LEADER), false);
    assert.equal(stopEnabled(state, "Paul"), true);
    applyEvent(state, seat("Paul", { busy: false }), 0);
    assert.equal(stopEnabled(state, "Paul"), false);
    applyEvent(state, seat("Paul", { running: false, busy: true }), 0);
    assert.equal(stopEnabled(state, "Paul"), false, "a gone process has no turn to stop");
  });

  it("nothing is typed into an instance that is stopping", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul", { busy: true })]), 0);
    assert.equal(state.connection, CONNECTED);
    applyEvent(state, { name: "stopping", data: {} }, 0);
    assert.equal(state.connection, STOPPING);
    assert.equal(composersEnabled(state, LEADER), false);
    assert.equal(composersEnabled(state, "Paul"), false);
    assert.equal(stopEnabled(state, "Paul"), false);
    assert.equal(head(state, LEADER).state, "listening", "a stopping server is still there: the word stays");
  });

  // Without a stream the page cannot know what any session is doing: every dot is red, no head
  // carries a state word, nothing takes input — and it all comes back with the stream.
  it("without a stream every dot is red, no head has a state word and nothing takes input", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { busy: true }), about("Paul")]), 0);
    state.connection = DISCONNECTED;
    assert.equal(dot(state, LEADER), RED);
    assert.equal(dot(state, "Paul"), RED);
    assert.equal(head(state, LEADER).state, "");
    assert.equal(head(state, "Paul").state, "");
    assert.equal(composersEnabled(state, LEADER), false);
    assert.equal(stopEnabled(state, LEADER), false);
    state.connection = CONNECTED;
    assert.equal(dot(state, LEADER), AMBER);
    assert.equal(head(state, "Paul").state, "listening");
    assert.equal(stopEnabled(state, LEADER), true);
  });
});

describe("the quota line", () => {
  const reading = { session: "8%", reset: "3h", all: "86%", allReset: "6d", fable: "20%", fableReset: "6d", updated: "2026-09-14T18:00:00.000Z" };

  it("is the session window with its reset, then all with its reset, then fable with its reset", () => {
    assert.equal(quotaLine(reading), "8% (3h) · all 86% (6d) · fable 20% (6d)");
    assert.equal(quotaLine({ ...reading, allReset: null, fable: "-", fableReset: null }), "8% (3h) · all 86% · fable -");
    assert.equal(quotaLine(null), "");
  });

  it("spells the same out for the tooltip, with when the reading was taken", () => {
    assert.equal(quotaTitle(reading, (iso) => `at ${iso}`), "session 8%, resets in 3h · all models 86%, resets in 6d · Fable 20%, resets in 6d\nasked of the Anthropic usage API at at 2026-09-14T18:00:00.000Z");
    assert.equal(quotaTitle({ ...reading, allReset: null, fableReset: null }), "session 8%, resets in 3h · all models 86% · Fable 20%\nasked of the Anthropic usage API at 2026-09-14T18:00:00.000Z");
    assert.equal(quotaTitle(null), "");
  });

  it("comes with the snapshot and moves with the quota event", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER)], { quota: reading }), 0);
    assert.equal(quotaLine(state.quota), "8% (3h) · all 86% (6d) · fable 20% (6d)");
    applyEvent(state, { name: "quota", data: { ...reading, reset: "2h" } }, 0);
    assert.equal(state.quota.reset, "2h");
    applyEvent(state, { name: "quota", data: null }, 0);
    assert.equal(quotaLine(state.quota), "");
    applyEvent(state, snapshot([about(LEADER)], { quota: reading }), 0);
    assert.equal(state.quota.session, "8%");
    applyEvent(state, snapshot([about(LEADER)]), 0);
    assert.equal(state.quota, null, "a snapshot without a reading is a server that has none");
  });
});
