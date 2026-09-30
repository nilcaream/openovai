// What the page shows, decided without a document: where the panels go, when one appears, dims
// and goes, what takes input, what the heads, the title and the quota line carry.
// Every mutation in tests/mutations-panels.json names the check it was written to redden.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AMBER, CARD, CONNECTED, DELIVERED, DELIVERED_GLYPH, DISCONNECTED, GONE_AFTER, GREEN, GREY, LATE_AFTER, RED, REPLY, SENDING, SHOWN_FOR, LINE_DISCONNECTED, LINE_LEFT, LINE_WAITING, LINE_WORKING, WINDOW, advance, anyAsking, applyEvent, composersEnabled, delivery, dot, following, fresh, head, keyAction, loadsOlder, noticed, pillLine, place, prune, quotaLine, quotaTitle, insertRef, stopEnabled, title, typingBeat, windowStart, TYPING_BEAT } from "../lib/chat/panels.mjs";
import { localAt, refTo, references } from "../lib/chat/refs.mjs";

const LEADER = "Leader";

describe("following the newest row", () => {
  it("a hand that moved the rows away lets the panel go, wherever the rows stand now", () => {
    assert.equal(following(true, false, true), false);
    assert.equal(following(true, true, true), false, "the wheel turned up, the rows have not moved yet: let go, the rows are on their way");
    assert.equal(following(false, true, true), false);
    assert.equal(following(false, false, true), false);
  });
  it("a scroll of the page's own never lets a following panel go: a tall row that moves the bottom away is no word from the reader", () => {
    assert.equal(following(true, false, false), true);
    assert.equal(following(true, true, false), true);
  });
  it("at the newest again, however the rows got there, a panel follows; away from it, with no hand, it stays as it was", () => {
    assert.equal(following(false, true, false), true);
    assert.equal(following(false, false, false), false);
  });
});

describe("the Leader's window of rows", () => {
  it("is a hundred rows", () => {
    assert.equal(WINDOW, 100);
  });
  it("starts at the oldest of the newest rows counted back from the end", () => {
    const all = () => true;
    assert.equal(windowStart(1000, 100, all), 900);
    assert.equal(windowStart(100, 100, all), 0);
    assert.equal(windowStart(50, 100, all), 0, "fewer than a window: from the first row");
    assert.equal(windowStart(0, 100, all), 0);
    assert.equal(windowStart(300, 100, all), 200, "the window before the first row drawn ends where that row begins");
  });
  it("counts only the rows the reader sees, whichever way the comms switch is", () => {
    const rows = Array.from({ length: 400 }, (_, index) => ({ index, talks: index % 2 === 0 }));
    assert.equal(windowStart(400, 100, () => true), 300, "the switch on: every row counts");
    assert.equal(windowStart(400, 100, (index) => !rows[index].talks), 201, "the switch off: the hundred newest rows that are not messages, with those between them drawn too");
    assert.equal(windowStart(400, 100, (index) => index % 10 === 0), 0, "fewer rows seen than a window: everything");
  });
  it("loads older rows for a reader who let go near the top, and for no other", () => {
    assert.equal(loadsOlder(false, 100, 800, 500), true);
    assert.equal(loadsOlder(false, 799, 800, 500), true, "within a screen of the top");
    assert.equal(loadsOlder(false, 800, 800, 500), false, "a screen away is not near");
    assert.equal(loadsOlder(true, 0, 800, 500), false, "a panel that follows never loads: it shows its newest");
    assert.equal(loadsOlder(false, 0, 800, 0), false, "nothing older exists");
  });
});

function about(name, extra = {}) {
  return { name, role: name === LEADER ? "Leader" : "Worker", model: "opus", running: true, busy: false, title: "", status: "", rules: "", ...extra };
}

function snapshot(sessions, extra = {}) {
  return { name: "snapshot", data: { user: "Mike", leader: LEADER, chat: "Server", sessions, standing: {}, ...extra } };
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

  it("in a window too narrow for two columns of Workers they are all on the left, in hire order, and the right has none", () => {
    const seats = ["W1", "W2", LEADER, "W3", "W4", "W5"];
    assert.deepEqual(place(seats, LEADER, seats, true), { left: ["W1", "W2", "W3", "W4", "W5"], mid: LEADER, right: [] });
    assert.deepEqual(place(seats, LEADER, seats, false), { left: ["W1", "W3", "W5"], mid: LEADER, right: ["W2", "W4"] }, "wide again: every panel is back on the side it had, nothing was remembered");
    assert.deepEqual(place(seats, LEADER, seats), place(seats, LEADER, seats, false), "two columns unless told otherwise");
  });

  it("the order is the order the panels appeared, not the order of a later snapshot", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul")]), 0);
    applyEvent(state, seat("Ann"), 1);
    applyEvent(state, snapshot([about("Ann"), about(LEADER), about("Paul")]), 2);
    assert.deepEqual(state.order, [LEADER, "Paul", "Ann"]);
    assert.deepEqual(place(names(state), state.leader, state.order), { left: ["Paul"], mid: LEADER, right: ["Ann"] });
  });

  it("a panel that went and came back is placed once, as the newest: never on both sides", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul"), about("Ann"), about("Max")]), 0);
    for (const name of ["Paul", "Ann", "Max"]) applyEvent(state, seat(name, { running: false }), 0);
    assert.deepEqual(prune(state, 31_000), ["Paul", "Ann", "Max"]);
    // Hired back one by one after the reset: three Workers, three panels, two sides.
    for (const name of ["Paul", "Ann", "Max"]) applyEvent(state, seat(name), 40_000);
    assert.deepEqual(state.order, [LEADER, "Paul", "Ann", "Max"]);
    assert.deepEqual(place(names(state), state.leader, state.order), { left: ["Paul", "Max"], mid: LEADER, right: ["Ann"] });
    // Gone from a snapshot — retired — and back under the same name: the same, one panel, one side.
    applyEvent(state, snapshot([about(LEADER), about("Ann"), about("Max")]), 50_000);
    applyEvent(state, seat("Paul"), 60_000);
    assert.deepEqual(state.order, [LEADER, "Ann", "Max", "Paul"]);
    assert.deepEqual(place(names(state), state.leader, state.order), { left: ["Ann", "Paul"], mid: LEADER, right: ["Max"] });
  });
});

describe("the desk title", () => {
  // The seat's `about` carries the desk title for whoever asks the server; the panel never
  // showed it but as a tooltip, and a tooltip on a whole panel is in the way. So it is not
  // carried onto the panel at all: nothing on the page has it to show.
  it("is not carried onto the panel, from the snapshot or from a later seat event", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { title: "On the release" }), about("Paul", { title: "Idle" })]), 0);
    applyEvent(state, seat("Paul", { title: "On the tests" }), 1);
    assert.equal("title" in state.panels[LEADER], false);
    assert.equal("title" in state.panels.Paul, false);
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

  // A park is no fault: the dot is grey, the word says there is no process, the bottom line says
  // the Leader has left. The next message starts a process: amber with the turn, green after.
  it("with no process its dot is grey and its bottom line says it has left; its head has no word", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { running: false }), about("Paul")]), 0);
    assert.equal(dot(state, LEADER), GREY);
    assert.equal(head(state, LEADER).state, "");
    assert.equal(pillLine(state, LEADER), "Leader has left — the next message starts a fresh session");
    assert.equal(pillLine(state, LEADER), LINE_LEFT(LEADER));
    assert.equal(dot(state, "Paul"), GREEN, "a Worker's dot is its own");
    assert.equal(head(state, "Paul").state, "listening");
    applyEvent(state, seat(LEADER, { running: true, busy: true, doing: LINE_WORKING }), 1);
    assert.equal(dot(state, LEADER), AMBER);
    assert.equal(head(state, LEADER).state, "");
    assert.equal(pillLine(state, LEADER), LINE_WORKING);
    applyEvent(state, seat(LEADER, { running: true, busy: false }), 2);
    assert.equal(dot(state, LEADER), GREEN);
    assert.equal(pillLine(state, LEADER), LINE_WAITING);
    applyEvent(state, seat(LEADER, { running: false }), 3);
    assert.equal(dot(state, LEADER), GREY);
  });

  // The Leader's bottom line is the one place the page says it has lost the server, and says it
  // over every other word, capitalized.
  it("the Leader's bottom line says Disconnected while the page has no stream, over the other words", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { running: false }), about("Paul")]), 0);
    state.connection = DISCONNECTED;
    assert.equal(pillLine(state, LEADER), "Disconnected");
    assert.equal(pillLine(state, LEADER), LINE_DISCONNECTED);
    state.connection = CONNECTED;
    assert.equal(pillLine(state, LEADER), LINE_LEFT(LEADER));
    applyEvent(state, seat(LEADER, { running: true, busy: true, doing: LINE_WORKING }), 1);
    state.connection = DISCONNECTED;
    assert.equal(pillLine(state, LEADER), LINE_DISCONNECTED);
    applyEvent(state, { name: "stopping", data: {} }, 2);
    assert.equal(pillLine(state, LEADER), LINE_DISCONNECTED, "a server that says it is stopping is as good as gone");
  });

  it("with no process, a page without a stream still says red and nothing, and a Worker gone is still red", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { running: false }), about("Paul")]), 0);
    state.connection = DISCONNECTED;
    assert.equal(dot(state, LEADER), RED);
    assert.equal(head(state, LEADER).state, "");
    state.connection = CONNECTED;
    applyEvent(state, seat("Paul", { running: false }), 1);
    assert.equal(dot(state, "Paul"), RED);
    assert.equal(head(state, "Paul").state, "");
  });
});

describe("the context on a head", () => {
  it("is the running session's own: gone when the session ends, and never the last one's before the new one's first request", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { context: 46_000 })]), 0);
    assert.equal(head(state, LEADER).info, "opus 46k");
    applyEvent(state, seat(LEADER, { running: false }), 1);
    assert.equal(head(state, LEADER).info, "opus", "the old session's figure stayed after it ended");
    applyEvent(state, seat(LEADER, { running: true, context: null }), 2);
    assert.equal(head(state, LEADER).info, "opus", "the old session's figure showed between the spawn and the first request");
    applyEvent(state, seat(LEADER, { running: true, busy: true, context: 47_034 }), 3);
    assert.equal(head(state, LEADER).info, "opus 47k");
    applyEvent(state, seat(LEADER, { running: true, busy: false }), 4);
    assert.equal(head(state, LEADER).info, "opus", "a figure the server does not give is not kept");
  });

  it("is gone from a Worker's head while it is dimmed, and shows nothing for one not known", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul", { context: 40_400 })]), 0);
    assert.equal(head(state, "Paul").info, "opus 40k");
    applyEvent(state, seat("Paul", { running: false }), 1);
    assert.equal(state.panels.Paul.dimmed, true);
    assert.equal(head(state, "Paul").info, "opus");
    assert.equal(head(state, LEADER).info, "opus", "a figure not known is no placeholder");
  });
});

describe("marks and controls", () => {
  it("the title is the product and the instance as the snapshot names it, and never changes with asking", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER)], { instance: "~/openovai" }), 0);
    assert.equal(title(state), "OpenOv AI ~/openovai");
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [{ id: "r1", tool: "Bash", input: { command: "ls" } }] } }, 0);
    assert.equal(title(state), "OpenOv AI ~/openovai", "the title is the same while a panel asks");
    assert.equal(title(fresh()), "OpenOv AI");
  });

  it("the version on the Leader's head is the one the snapshot names, and nothing before it", () => {
    const state = fresh();
    assert.equal(state.version, "");
    applyEvent(state, snapshot([about(LEADER)], { version: "12345678" }), 0);
    assert.equal(state.version, "12345678");
  });

  it("the panel that asks carries the mark, and anyAsking says whether any panel does", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul")], { instance: "~/inst" }), 0);
    assert.equal(anyAsking(state), false);
    applyEvent(state, { name: "asking", data: { seat: "Paul", pending: [{ id: "r1", tool: "Bash", input: { command: "ls" } }] } }, 0);
    assert.equal(anyAsking(state), true);
    assert.equal(head(state, "Paul").state, "waiting for you");
    assert.equal(head(state, LEADER).state, "");
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [{ id: "u1", kind: "rule", rule: "Bash(git:*)", why: "w", from: LEADER }] } }, 0);
    assert.equal(head(state, LEADER).state, "", "the Leader's head has no state word, a card on its panel or not");
    applyEvent(state, { name: "asking", data: { seat: "Paul", pending: [] } }, 0);
    assert.equal(anyAsking(state), true, "one panel still asks");
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [] } }, 0);
    assert.equal(anyAsking(state), false);
    assert.equal(head(state, "Paul").state, "listening");
    assert.equal(anyAsking(fresh()), false);
  });

  it("the head is the name, the model and the context in k, in parts", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { model: "opus", context: 41_200 }), about("Paul", { model: "" }), about("Ann", { model: "sonnet" })]), 0);
    assert.deepEqual(head(state, LEADER), { name: "Leader", info: "opus 41k", state: "" });
    assert.deepEqual(head(state, "Paul"), { name: "Paul", info: "", state: "listening" });
    assert.deepEqual(head(state, "Ann"), { name: "Ann", info: "sonnet", state: "listening" });
    applyEvent(state, seat("Ann", { model: "sonnet", context: 2_600 }), 1);
    assert.equal(head(state, "Ann").info, "sonnet 3k");
  });

  // Several questions at once: the word counts them, so the head says how many cards are waiting
  // below before the reader scrolls to them. One question is the word alone.
  it("the state word counts the questions waiting when there is more than one", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul")]), 0);
    const ask = (id) => ({ id, tool: "Bash", input: { command: "ls" } });
    applyEvent(state, { name: "asking", data: { seat: "Paul", pending: [ask("r1")] } }, 0);
    assert.equal(head(state, "Paul").state, "waiting for you");
    applyEvent(state, { name: "asking", data: { seat: "Paul", pending: [ask("r1"), ask("r2")] } }, 0);
    assert.equal(head(state, "Paul").state, "waiting for you · 2 prompts");
    applyEvent(state, { name: "asking", data: { seat: "Paul", pending: [ask("r1"), ask("r2"), ask("r3"), ask("r4"), ask("r5"), ask("r6"), ask("r7")] } }, 0);
    assert.equal(head(state, "Paul").state, "waiting for you · 7 prompts");
    assert.equal(head(state, LEADER).state, "", "the Leader's head counts nothing");
    applyEvent(state, { name: "asking", data: { seat: "Paul", pending: [] } }, 0);
    assert.equal(head(state, "Paul").state, "listening");
  });

  // The word follows the turn: a seat event with busy flips it, an ask outranks it, and a dimmed
  // panel says nothing — the fade and the red dot are its mark.
  it("the state word is listening between turns, working while one runs, waiting for you over both, and nothing on a dimmed panel", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { busy: true }), about("Paul")]), 0);
    assert.equal(head(state, LEADER).state, "", "the Leader's head has no state word");
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

  // What a seat is at is the server's word on the seat — from the snapshot, for a page opened
  // mid-turn, and from every seat event after — and null once a seat event comes without it,
  // since the server says it only while there is one. A call, once up, has SHOWN_FOR.
  it("what a seat is at comes with the snapshot and every seat event, and is null once the word is gone", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { busy: true, doing: LINE_WORKING }), about("Paul", { busy: true })]), 0);
    assert.equal(state.panels[LEADER].doing, LINE_WORKING);
    assert.equal(state.panels.Paul.doing, null);
    applyEvent(state, seat(LEADER, { busy: true, doing: "Reading lib/chat/page.html" }), SHOWN_FOR);
    assert.equal(state.panels[LEADER].doing, "Reading lib/chat/page.html");
    applyEvent(state, seat(LEADER, { busy: false }), 2 * SHOWN_FOR);
    assert.equal(state.panels[LEADER].doing, null);
    applyEvent(state, seat(LEADER, { busy: true, doing: 7 }), 3 * SHOWN_FOR);
    assert.equal(state.panels[LEADER].doing, null, "a word that is not a string is no word");
  });

  // The tool line, at the pace a reader can follow: a call up stays SHOWN_FOR; a word said while
  // it holds waits in the one place there is, and goes up the moment the call has had its time —
  // from the event that finds it due, or from `advance`, which says when to come back.
  describe("the tool line", () => {
    const at = (state, now, doing) => applyEvent(state, seat(LEADER, { busy: true, doing }), now);
    const shows = (state) => state.panels[LEADER].doing;
    const opened = () => {
      const state = fresh();
      applyEvent(state, snapshot([about(LEADER, { busy: true, doing: LINE_WORKING })]), 0);
      return state;
    };

    // The User's own words, so they are literals here: a check that only read the constants back
    // would hold whatever they became.
    it("says Working… on a turn with no call showing, and Waiting for instructions off one", () => {
      assert.equal(LINE_WORKING, "Working…");
      assert.equal(LINE_WAITING, "Waiting for instructions");
    });

    it("a call stays up SHOWN_FOR, and what was said meanwhile goes up when it is due", () => {
      assert.equal(SHOWN_FOR, 1000, "a call is up a second at least");
      const state = opened();
      at(state, 10, "Reading a");
      at(state, 20, "Reading b");
      assert.equal(shows(state), "Reading a", "Reading a has had 10 ms of its second");
      assert.equal(advance(state, 10 + SHOWN_FOR - 1), 10 + SHOWN_FOR, "not due yet, and the page is told when it is");
      assert.equal(shows(state), "Reading a");
      assert.equal(advance(state, 10 + SHOWN_FOR), null, "due, up, and nothing waits behind it");
      assert.equal(shows(state), "Reading b");
      at(state, 10 + 2 * SHOWN_FOR - 1, "Reading c");
      assert.equal(shows(state), "Reading b", "a call again once up: it holds its own second");
      at(state, 10 + 2 * SHOWN_FOR, "Reading c");
      assert.equal(shows(state), "Reading c", "a word said once the call showing has had its time goes up at once");
    });

    it("Working… holds nothing: the call after it goes up at once", () => {
      const state = opened();
      at(state, 1, "Reading a");
      assert.equal(shows(state), "Reading a");
      at(state, 1 + SHOWN_FOR, LINE_WORKING);
      at(state, 2 + SHOWN_FOR, "Reading b");
      assert.equal(shows(state), "Reading b", "Working… had 1 ms, and no call waits for it");
    });

    it("nothing queues: ten calls of 10 ms show the first for SHOWN_FOR, then the newest word only", () => {
      const tenCalls = () => {
        const state = opened();
        for (let call = 0; call < 10; call += 1) {
          at(state, 20 * call, `Reading ${call}`);
          at(state, 20 * call + 10, LINE_WORKING);
        }
        return state;
      };
      const done = tenCalls();
      assert.equal(shows(done), "Reading 0");
      assert.equal(done.panels[LEADER].next, LINE_WORKING, "one word waits, the newest");
      assert.equal(advance(done, SHOWN_FOR), null, "and once it is up nothing waits behind it");
      assert.equal(shows(done), LINE_WORKING, "nothing runs any more, and none of the calls in between is shown");
      const running = tenCalls();
      at(running, 200, "Reading 10");
      assert.equal(running.panels[LEADER].next, "Reading 10", "the newest word, not the first that waited");
      advance(running, SHOWN_FOR);
      assert.equal(shows(running), "Reading 10", "the call out now is the one shown");
    });

    it("a word that is the one showing leaves nothing waiting", () => {
      const state = opened();
      at(state, 10, "Reading a");
      at(state, 20, LINE_WORKING);
      assert.equal(state.panels[LEADER].next, LINE_WORKING);
      at(state, 30, "Reading a");
      assert.equal(state.panels[LEADER].next, null, "the line already says it");
      assert.equal(advance(state, 30), null);
    });

    it("the turn's end takes the line down at once, whatever holds it, and the next turn starts clean", () => {
      const state = opened();
      at(state, 10, "Reading a");
      at(state, 20, "Reading b");
      at(state, 30, null);
      assert.equal(shows(state), null, "the call had 20 ms of its second");
      assert.equal(state.panels[LEADER].next, null, "nothing stale behind it");
      assert.equal(advance(state, 10 + SHOWN_FOR), null);
      assert.equal(shows(state), null);
      at(state, 40, LINE_WORKING);
      assert.equal(shows(state), LINE_WORKING, "an empty line has nothing to read: the next turn's word goes up at once");
    });

    it("advance answers the soonest due moment over every panel", () => {
      const state = opened();
      at(state, 10, "Reading a");
      at(state, 20, LINE_WORKING);
      applyEvent(state, seat("Paul", { busy: true, doing: "Reading b" }), 200);
      applyEvent(state, seat("Paul", { busy: true, doing: LINE_WORKING }), 300);
      assert.equal(advance(state, 300), 10 + SHOWN_FOR, "Paul's is due at 1200, the Leader's at 1010");
      assert.equal(advance(state, 10 + SHOWN_FOR), 200 + SHOWN_FOR);
      assert.equal(advance(state, 200 + SHOWN_FOR), null);
    });
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

  // A server that said it is stopping is as good as gone: the page has no server to type into,
  // and says so the one way it says that — red dots, no state word, "Disconnected" on the Leader's pill.
  it("a server that is stopping is disconnected: nothing is typed, every dot is red, no head has a word", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul", { busy: true })]), 0);
    assert.equal(state.connection, CONNECTED);
    applyEvent(state, { name: "stopping", data: {} }, 0);
    assert.equal(state.connection, DISCONNECTED);
    assert.equal(composersEnabled(state, LEADER), false);
    assert.equal(composersEnabled(state, "Paul"), false);
    assert.equal(stopEnabled(state, "Paul"), false);
    assert.equal(dot(state, LEADER), RED);
    assert.equal(dot(state, "Paul"), RED);
    assert.equal(head(state, LEADER).state, "");
    assert.equal(head(state, "Paul").state, "");
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
  // Moments on the local clock, as the page's own: Friday 25 September 2026, 10:00.
  const local = (day, hours, minutes) => new Date(2026, 8, day, hours, minutes).toISOString();
  const now = new Date(2026, 8, 25, 10, 0);
  const reading = { session: "8%", reset: "3h", all: "86%", allReset: "6d", fable: "20%", fableReset: "6d", resets: { "5h": local(25, 12, 12), "7d": local(28, 13, 41), "7d fable": local(26, 23, 11) }, at: local(25, 9, 41), old: false };

  it("is the session window with its reset, then all with its reset, then fable with its reset", () => {
    assert.equal(quotaLine(reading), "8% (3h) · all 86% (6d) · fable 20% (6d)");
    assert.equal(quotaLine({ ...reading, allReset: null, fable: "-", fableReset: null }), "8% (3h) · all 86% · fable -");
    assert.equal(quotaLine(null), "");
  });

  it("says in the tooltip when each window resets, each at its own moment on the page's clock, and nothing else", () => {
    assert.equal(quotaTitle(reading, now), "5h resets today at 12:12, 7d on Monday at 13:41, 7d fable tomorrow at 23:11, updated at 09:41");
    assert.equal(quotaTitle({ ...reading, resets: { "5h": local(25, 9, 5), "7d": local(26, 0, 0), "7d fable": local(32, 7, 30) } }, now), "5h resets today at 09:05, 7d tomorrow at 00:00, 7d fable on Friday at 07:30, updated at 09:41");
    assert.equal(quotaTitle({ ...reading, resets: { ...reading.resets, "7d fable": null } }, now), "5h resets today at 12:12, 7d on Monday at 13:41, updated at 09:41", "a window with no reset is left out");
    assert.equal(quotaTitle({ ...reading, resets: { "5h": null, "7d": null, "7d fable": null }, at: local(25, 0, 5) }, now), "updated at 00:05", "a reading whose resets have all passed still says when it was taken");
    assert.equal(quotaTitle(null, now), "");
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

describe("the User's own row", () => {
  it("waits as sending on an idle seat, as queued behind the turn on a busy one, and reads delivered once the frame went in, with the glyph alone for a narrow row", () => {
    assert.deepEqual(delivery(false, false, "Bob"), { text: "sending…", wait: true });
    assert.deepEqual(delivery(false, true, "Bob"), { text: "queued — Bob reads it at its next step", wait: true });
    assert.deepEqual(delivery(true, false, "Bob"), { text: "delivered ✓", glyph: "✓", wait: false });
    assert.deepEqual(delivery(true, true, "Bob"), { text: "delivered ✓", glyph: "✓", wait: false }, "delivered is delivered, busy or not");
    assert.equal(SENDING, "sending…");
    assert.equal(DELIVERED, "delivered ✓");
    assert.equal(DELIVERED_GLYPH, "✓");
  });

  it("says when a row that waited went in and nothing more, and nothing of a wait under LATE_AFTER", () => {
    assert.deepEqual(delivery(true, false, "Bob", { clock: "19:22:36", seconds: 40 }), { text: "delivered 19:22:36 ✓", glyph: "✓", wait: false });
    assert.deepEqual(delivery(true, false, "Bob", { clock: "19:22:36", seconds: LATE_AFTER }), { text: "delivered 19:22:36 ✓", glyph: "✓", wait: false });
    assert.deepEqual(delivery(true, false, "Bob", { clock: "19:22:36", seconds: LATE_AFTER - 1 }), { text: "delivered ✓", glyph: "✓", wait: false });
    assert.deepEqual(delivery(false, true, "Bob", { clock: "19:22:36", seconds: 40 }), { text: "queued — Bob reads it at its next step", wait: true }, "not yet written is waiting, whatever the time");
  });
});

describe("telling the server a key went into the box", () => {
  it("tells the first key, none within a beat of the last told, and the next one after it", () => {
    assert.equal(typingBeat(null, 1000), true);
    assert.equal(typingBeat(1000, 1000 + TYPING_BEAT - 1), false);
    assert.equal(typingBeat(1000, 1000 + TYPING_BEAT), true);
  });
});

describe("a reference going into the box", () => {
  it("goes in at the cursor with a space on either side, the cursor after it", () => {
    assert.deepEqual(insertRef("", 0, 0, "(ref/15:08:11/123)"), { value: "(ref/15:08:11/123) ", caret: 19 });
    assert.deepEqual(insertRef("I agree. more", 8, 8, "(ref/15:08:11/123)"), { value: "I agree. (ref/15:08:11/123) more", caret: 28 }, "a space follows already: none added, the cursor after it");
    assert.deepEqual(insertRef("ab", 1, 1, "(ref/15:08:11/123)"), { value: "a (ref/15:08:11/123) b", caret: 21 });
    assert.deepEqual(insertRef("I agree", 7, 7, "(ref/15:08:11/123)"), { value: "I agree (ref/15:08:11/123) ", caret: 27 });
  });

  it("takes the place of what is selected", () => {
    assert.deepEqual(insertRef("see XX now", 4, 6, "(ref/15:08:11/123)"), { value: "see (ref/15:08:11/123) now", caret: 23 });
  });
});

describe("a reference to a row", () => {
  // Local times, so the checks read the same on any machine's zone.
  const at = (h, m, s, ms, day = 25) => new Date(2026, 8, day, h, m, s, ms).toISOString();

  it("is the local time to the millisecond, zero-padded to one length", () => {
    assert.equal(refTo(at(15, 8, 11, 123)), "(ref/15:08:11/123)");
    assert.equal(refTo(at(1, 2, 3, 4)), "(ref/01:02:03/004)");
    assert.equal(localAt(at(15, 8, 11, 123)), "2026-09-25T15:08:11.123");
  });

  it("names the nearest earlier row with that time, over midnight too, and nothing for a time no row has", () => {
    const rows = [
      { at: at(23, 59, 1, 500, 24), from: "Anna", text: "yesterday" },
      { at: at(15, 8, 11, 123), from: "Anna", text: "first" },
      { at: at(15, 8, 11, 123), from: "Bobby", text: "same millisecond" },
      { at: at(0, 1, 0, 0), from: "user", text: "(ref/23:59:01/500) and (ref/15:08:11/123) and (ref/09:00:00/000)" },
    ];
    const found = references(rows, 3, rows[3].text);
    assert.deepEqual(found.map(({ to, index }) => ({ to, index })), [
      { to: "23:59:01/500", index: 0 },
      { to: "15:08:11/123", index: 2 },
      { to: "09:00:00/000", index: null },
    ]);
    assert.deepEqual(found.map(({ start, end }) => rows[3].text.slice(start, end)), ["(ref/23:59:01/500)", "(ref/15:08:11/123)", "(ref/09:00:00/000)"]);
  });

  it("never names a later row, a tool line or a divider, and reads only the one form", () => {
    const rows = [
      { at: at(15, 8, 11, 123), from: "Ivy", line: "Read x" },
      { at: at(15, 8, 11, 124), divider: true, text: "started" },
      { at: at(15, 8, 11, 125), from: "Bobby", text: "later" },
    ];
    assert.deepEqual(references(rows, 2, "(ref/15:08:11/123) (ref/15:08:11/124) (ref/15:08:11/125)").map(({ index }) => index), [null, null, null]);
    assert.deepEqual(references(rows, 3, "(ref/15:08:11/12) (ref:15:08:11/125) (ref/5:08:11/125)"), []);
  });
});

// What is worth telling a reader who is not at the page, read off an event against the state as
// it stands before the event is applied: a card that was not on its panel, and the end of the
// Leader's turn. Nothing else — a Worker's turn, a row, a seat coming or going is a record.
describe("what the page notifies about", () => {
  function pending(seat, ids) {
    return { name: "asking", data: { seat, pending: ids.map((id) => ({ id, tool: "Bash", input: { command: "ls" } })) } };
  }

  it("a card that was not on its panel, on any panel, once", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul")]), 0);
    assert.deepEqual(noticed(state, pending("Paul", ["r1"])), { seat: "Paul", kind: CARD });
    applyEvent(state, pending("Paul", ["r1"]), 0);
    assert.equal(noticed(state, pending("Paul", ["r1"])), null, "the same card listed again");
    assert.deepEqual(noticed(state, pending("Paul", ["r1", "r2"])), { seat: "Paul", kind: CARD }, "a second card beside the first");
    assert.equal(noticed(state, pending("Paul", [])), null, "a card taken down");
    assert.deepEqual(noticed(state, { name: "asking", data: { seat: LEADER, pending: [{ id: "u1", kind: "rule", rule: "Bash(git:*)", why: "w", from: LEADER }] } }), { seat: LEADER, kind: CARD }, "a rule dialog is a card");
    assert.equal(noticed(state, pending("Nobody", ["r9"])), null, "a panel the page has not got");
  });

  it("the end of the Leader's turn, however it ended, and no Worker's", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { busy: true }), about("Paul", { busy: true })]), 0);
    assert.equal(noticed(state, seat(LEADER, { busy: true })), null, "a turn still running");
    assert.deepEqual(noticed(state, seat(LEADER, { busy: false })), { seat: LEADER, kind: REPLY });
    assert.deepEqual(noticed(state, seat(LEADER, { running: false, busy: false })), { seat: LEADER, kind: REPLY }, "a turn ended by the process going");
    applyEvent(state, seat(LEADER, { busy: false }), 0);
    assert.equal(noticed(state, seat(LEADER, { busy: false })), null, "listening already");
    assert.equal(noticed(state, seat("Paul", { busy: false })), null, "a Worker's turn");
    assert.equal(noticed(state, { name: "row", data: { seat: LEADER, index: 0, row: { from: LEADER, text: "b" } } }), null, "a row");
  });
});
