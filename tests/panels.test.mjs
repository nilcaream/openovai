// What the page shows, decided without a document: where the panels go, when one appears, dims
// and goes, what takes input, what the heads, the title and the quota line carry.
// Every mutation in tests/mutations-panels.json names the check it was written to redden.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AMBER, CARD, CONNECTED, DELIVERED, DELIVERED_GLYPH, DISCONNECTED, GONE_AFTER, GREEN, LATE_AFTER, RED, REPLY, LINE_QUEUE, SENDING, SHOWN_FOR, advance, anyAsking, applyEvent, composersEnabled, delivery, dot, following, fresh, head, keyAction, noticed, place, prune, quotaLine, quotaTitle, insertRef, stopEnabled, title, typingBeat, TYPING_BEAT } from "../lib/chat/panels.mjs";
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
});

describe("marks and controls", () => {
  it("the title is the product and the instance as the snapshot names it, and never changes with asking", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER)], { instance: "~/work/inst" }), 0);
    assert.equal(title(state), "OpenOv AI ~/work/inst");
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [{ id: "r1", tool: "Bash", input: { command: "ls" } }] } }, 0);
    assert.equal(title(state), "OpenOv AI ~/work/inst", "the title is the same while a panel asks");
    assert.equal(title(fresh()), "OpenOv AI");
  });

  it("the panel that asks carries the mark, and anyAsking says whether any panel does", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER), about("Paul")], { instance: "~/inst" }), 0);
    assert.equal(anyAsking(state), false);
    applyEvent(state, { name: "asking", data: { seat: "Paul", pending: [{ id: "r1", tool: "Bash", input: { command: "ls" } }] } }, 0);
    assert.equal(anyAsking(state), true);
    assert.equal(head(state, "Paul").state, "waiting for you");
    assert.equal(head(state, LEADER).state, "listening");
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [{ id: "u1", kind: "rule", rule: "Bash(git:*)", why: "w", from: LEADER }] } }, 0);
    assert.equal(head(state, LEADER).state, "waiting for you");
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
    assert.deepEqual(head(state, LEADER), { name: "Leader", info: "opus 41k", state: "listening" });
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
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [ask("r1")] } }, 0);
    assert.equal(head(state, LEADER).state, "waiting for you");
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [ask("r1"), ask("r2")] } }, 0);
    assert.equal(head(state, LEADER).state, "waiting for you · 2 prompts");
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [ask("r1"), ask("r2"), ask("r3"), ask("r4"), ask("r5"), ask("r6"), ask("r7")] } }, 0);
    assert.equal(head(state, LEADER).state, "waiting for you · 7 prompts");
    assert.equal(head(state, "Paul").state, "listening");
    applyEvent(state, { name: "asking", data: { seat: LEADER, pending: [] } }, 0);
    assert.equal(head(state, LEADER).state, "listening");
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

  // What a seat is at is the server's word on the seat — from the snapshot, for a page opened
  // mid-turn, and from every seat event after — and null once a seat event comes without it,
  // since the server says it only while there is one. Each word, once up, has SHOWN_FOR.
  it("what a seat is at comes with the snapshot and every seat event, and is null once the word is gone", () => {
    const state = fresh();
    applyEvent(state, snapshot([about(LEADER, { busy: true, doing: "Thinking…" }), about("Paul", { busy: true })]), 0);
    assert.equal(state.panels[LEADER].doing, "Thinking…");
    assert.equal(state.panels.Paul.doing, null);
    applyEvent(state, seat(LEADER, { busy: true, doing: "Reading lib/chat/page.html" }), SHOWN_FOR);
    assert.equal(state.panels[LEADER].doing, "Reading lib/chat/page.html");
    applyEvent(state, seat(LEADER, { busy: false }), 2 * SHOWN_FOR);
    assert.equal(state.panels[LEADER].doing, null);
    applyEvent(state, seat(LEADER, { busy: true, doing: 7 }), 3 * SHOWN_FOR);
    assert.equal(state.panels[LEADER].doing, null, "a word that is not a string is no word");
  });

  // The tool line, at the pace a reader can follow: a word up stays SHOWN_FOR; a word said while
  // the one showing is younger waits, and goes up the moment it is due — from the event that
  // finds it due, or from `advance`, which says when to come back.
  describe("the tool line", () => {
    const at = (state, now, doing) => applyEvent(state, seat(LEADER, { busy: true, doing }), now);
    const shows = (state) => state.panels[LEADER].doing;
    const opened = () => {
      const state = fresh();
      applyEvent(state, snapshot([about(LEADER, { busy: true, doing: "Thinking…" })]), 0);
      return state;
    };

    it("a word said while the one showing is younger than SHOWN_FOR waits, and goes up when it is due", () => {
      const state = opened();
      at(state, 10, "Reading a");
      assert.equal(shows(state), "Thinking…", "Thinking… has had 10 ms of its 500");
      assert.equal(advance(state, 499), SHOWN_FOR, "not due yet, and the page is told when it is");
      assert.equal(shows(state), "Thinking…");
      assert.equal(advance(state, SHOWN_FOR), null, "due, up, and nothing waits behind it");
      assert.equal(shows(state), "Reading a");
      at(state, 2 * SHOWN_FOR, "Reading b");
      assert.equal(shows(state), "Reading b", "a word said once the one showing has had its time goes up at once");
    });

    it("a word that repeats the newest one known is not queued", () => {
      const state = opened();
      at(state, 10, "Thinking…");
      assert.deepEqual(state.panels[LEADER].waiting, [], "Thinking… again is the Thinking… showing");
      at(state, 20, "Reading a");
      at(state, 30, "Reading a");
      assert.deepEqual(state.panels[LEADER].waiting, ["Reading a"], "said twice, waits once");
      at(state, 40, "Thinking…");
      assert.deepEqual(state.panels[LEADER].waiting, ["Reading a", "Thinking…"], "not the newest known: queued, whatever the line shows");
    });

    it("the turn's end drains the line at its pace and only then takes it down", () => {
      const state = opened();
      at(state, 10, "Reading a");
      at(state, 20, null);
      assert.equal(shows(state), "Thinking…");
      assert.equal(advance(state, SHOWN_FOR), 2 * SHOWN_FOR);
      assert.equal(shows(state), "Reading a", "the call goes up though the turn is over");
      assert.equal(advance(state, 2 * SHOWN_FOR), null);
      assert.equal(shows(state), null, "and the line goes once it has had its time");
      assert.deepEqual(state.panels[LEADER].waiting, [], "nothing stale behind it");
      at(state, 2 * SHOWN_FOR + 10, "Thinking…");
      assert.equal(shows(state), "Thinking…", "an empty line has nothing to read: the next turn's word goes up at once");
    });

    it("no more than LINE_QUEUE words wait, the oldest dropped first", () => {
      const state = opened();
      for (const word of ["a", "b", "c", "d", "e"]) at(state, 10, word);
      assert.deepEqual(state.panels[LEADER].waiting, ["c", "d", "e"]);
      assert.equal(state.panels[LEADER].waiting.length, LINE_QUEUE);
      assert.equal(shows(state), "Thinking…");
      assert.equal(advance(state, SHOWN_FOR), 2 * SHOWN_FOR);
      assert.equal(shows(state), "c");
    });

    it("advance answers the soonest due moment over every panel", () => {
      const state = opened();
      at(state, 10, "Reading a");
      applyEvent(state, seat("Paul", { busy: true, doing: "Thinking…" }), 200);
      applyEvent(state, seat("Paul", { busy: true, doing: "Reading b" }), 300);
      assert.equal(advance(state, 300), 500, "Paul's is due at 700, the Leader's at 500");
      assert.equal(advance(state, 500), 700);
      assert.equal(advance(state, 700), null);
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
  // and says so the one way it says that — red dots, no state word, "disconnected" on the head.
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
  const reading = { session: "8%", reset: "3h", all: "86%", allReset: "6d", fable: "20%", fableReset: "6d", resets: { "5h": local(25, 12, 12), "7d": local(28, 13, 41), "7d fable": local(26, 23, 11) } };

  it("is the session window with its reset, then all with its reset, then fable with its reset", () => {
    assert.equal(quotaLine(reading), "8% (3h) · all 86% (6d) · fable 20% (6d)");
    assert.equal(quotaLine({ ...reading, allReset: null, fable: "-", fableReset: null }), "8% (3h) · all 86% · fable -");
    assert.equal(quotaLine(null), "");
  });

  it("says in the tooltip when each window resets, each at its own moment on the page's clock, and nothing else", () => {
    assert.equal(quotaTitle(reading, now), "5h resets today at 12:12, 7d on Monday at 13:41, 7d fable tomorrow at 23:11");
    assert.equal(quotaTitle({ ...reading, resets: { "5h": local(25, 9, 5), "7d": local(26, 0, 0), "7d fable": local(32, 7, 30) } }, now), "5h resets today at 09:05, 7d tomorrow at 00:00, 7d fable on Friday at 07:30");
    assert.equal(quotaTitle({ ...reading, resets: { ...reading.resets, "7d fable": null } }, now), "5h resets today at 12:12, 7d on Monday at 13:41", "a window with no reset is left out");
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

  it("says when a row that waited went in and how long after it was typed, and nothing of a wait under LATE_AFTER", () => {
    assert.deepEqual(delivery(true, false, "Bob", { clock: "19:22:36", seconds: 40 }), { text: "delivered 19:22:36 ✓ — 40 seconds after", glyph: "✓", wait: false });
    assert.deepEqual(delivery(true, false, "Bob", { clock: "19:22:36", seconds: LATE_AFTER }), { text: `delivered 19:22:36 ✓ — ${LATE_AFTER} seconds after`, glyph: "✓", wait: false });
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
