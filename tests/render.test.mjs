// A row of a panel, as the page shows it: markdown for a reply and words for everything else.
// Every mutation in tests/mutations-render.json names the check it was written to redden.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INTERRUPTED, SILENT, html, row } from "../lib/chat/render.mjs";

// The Leader's panel, and a Worker's: the same rows drawn from two seats, for one User.
const names = { chat: "Server", seat: "Leader", leader: "Leader", user: "Mike" };
const worker = { chat: "Server", seat: "Paul", leader: "Leader", user: "Mike" };

describe("a reply", () => {
  it("renders markdown and escapes raw HTML in it", () => {
    const shown = html("**a** <script>x</script>");
    assert.match(shown, /<strong>a<\/strong>/);
    assert.match(shown, /&lt;script&gt;x&lt;\/script&gt;/);
    assert.ok(!shown.includes("<script>"));
  });

  it("opens a link in a new tab, on a scheme a page can follow", () => {
    assert.match(html("[l](https://x.y/z)"), /<a href="https:\/\/x\.y\/z" target="_blank" rel="noopener">l<\/a>/);
    assert.match(html("[m](mailto:a@b.c)"), /<a href="mailto:a@b\.c" target="_blank"/);
    const shown = html("[j](javascript:alert(1))");
    assert.ok(!shown.includes("javascript:"), shown);
    assert.match(shown, /<p>j<\/p>/);
  });

  it("shows an image as a link, never as a fetch", () => {
    const shown = html("![alt](https://x.y/i.png)");
    assert.ok(!shown.includes("<img"), shown);
    assert.match(shown, /<a href="https:\/\/x\.y\/i\.png" target="_blank" rel="noopener">alt<\/a>/);
  });

  it("is a row with html and no text", () => {
    const shown = row({ from: "Paul", text: "*hi*" }, names);
    assert.equal(shown.who, "Paul");
    assert.equal(shown.kind, "reply");
    assert.match(shown.html, /<em>hi<\/em>/);
    assert.equal(shown.text, undefined);
  });
});

describe("every other row", () => {
  it("the User's own words carry the User's name, plain, and whether they have reached the process", () => {
    assert.deepEqual(row({ from: "user", text: "**not** markdown" }, names), { who: "Mike", kind: "user", text: "**not** markdown", delivered: false });
    assert.deepEqual(row({ from: "user", text: "check the repo" }, worker), { who: "Mike", kind: "user", text: "check the repo", delivered: false }, "typed to a Worker, it is a prompt on the Worker's panel");
    assert.deepEqual(row({ from: "user", text: "check the repo", delivered: true }, worker), { who: "Mike", kind: "user", text: "check the repo", delivered: true });
    assert.equal(row({ from: "user", text: "x", delivered: "yes" }, names).delivered, false, "delivered is the mark itself, not any word in its place");
  });

  // What the User typed to a Worker is on the Leader's panel too, as the User's name, an arrow and
  // the Worker's, on a ground of its own: it is not a prompt to the Leader.
  it("a word typed to a Worker says where it went on the Leader's panel, on its own ground", () => {
    assert.deepEqual(row({ from: "user", typedTo: "Paul", text: "check the repo" }, names), { who: "Mike → Paul", kind: "typed", text: "check the repo" });
  });

  // What one Worker said to another is on the Leader's panel too, sender, arrow, addressee, on the
  // same ground as the User's typed line — not a prompt to the Leader either — under the id both
  // Workers' lines carry.
  it("a word one Worker said to another reads sender → addressee on the Leader's panel, on the overheard ground, with its id", () => {
    assert.deepEqual(row({ from: "Paul", to: "Sam", text: "**the** fixture", msg: "m-1", overheard: true }, names), { who: "Paul → Sam", kind: "overheard", text: "**the** fixture", msg: "m-1" });
  });

  it("the chat's own lines are muted words", () => {
    assert.deepEqual(row({ from: "Server", text: "Paul has no process" }, names), { who: "Server", kind: "chat", text: "Paul has no process" });
  });

  it("a failed turn is shown failed", () => {
    assert.deepEqual(row({ from: "Server", text: "Paul stopped before answering: x", failed: true }, names), {
      who: "Server",
      kind: "failed",
      text: "Paul stopped before answering: x",
    });
    assert.equal(row({ from: "Paul", text: "", failed: true }, names).kind, "failed");
  });

  it("a silent turn is said so", () => {
    assert.deepEqual(row({ from: "Paul", text: "", silent: true }, names), { who: "Paul", kind: "silent", text: SILENT });
  });

  it("an interrupted turn is shown as interrupted, not as a reply", () => {
    assert.deepEqual(row({ from: "Paul", text: "interrupted", interrupted: true }, names), { who: "Server", kind: "interrupted", text: INTERRUPTED });
  });

  // The row between two sessions on one panel — the Leader's process gone, the next row a fresh
  // one's — is a divider with its words as text, whatever else the entry carries.
  it("a word between two sessions is a divider, its words as text", () => {
    assert.deepEqual(row({ from: "Server", divider: true, text: "Superman has left — the next message starts a fresh session" }, names), {
      who: "Server",
      kind: "divider",
      text: "Superman has left — the next message starts a fresh session",
    });
    assert.equal(row({ from: "Server", divider: true, text: "x", failed: true }, names).kind, "divider");
  });

  // A tool call is what the server summarised it as, as text — never markdown, never a reply —
  // and stays a line whatever else the entry carries; red once its call failed, with the reason
  // the result gave, for a tooltip, and nothing where it gave none.
  it("a tool call is a line: the summary as text, its kind line, red once the call failed", () => {
    assert.deepEqual(row({ at: "2026-09-14T09:00:00.000Z", from: "Paul", line: "Reading ~/x/y.mjs", call: "toolu_1" }, names), { who: "Paul", kind: "line", text: "Reading ~/x/y.mjs", err: false, why: "" });
    assert.deepEqual(row({ from: "Paul", line: "Run the suite", call: "toolu_2", err: true, why: "Exit code 1" }, names), { who: "Paul", kind: "line", text: "Run the suite", err: true, why: "Exit code 1" });
    assert.deepEqual(row({ from: "Paul", line: "Run the suite", call: "toolu_2", err: true }, names).why, "", "a failed call with no reason carries no words");
    assert.equal(row({ from: "Paul", line: "Searching **x**", call: "toolu_3", interrupted: true }, names).kind, "line");
    assert.equal(row({ from: "Paul", line: "Searching **x**", call: "toolu_3" }, names).html, undefined, "a line is never markdown");
  });
});

// A message between two sessions carries `to` and the id its two ends share. The Leader's panel
// draws its whole text, compact, `To` on the way out with what became of it, `From` on the way
// in, the id on both; a Worker's panel draws one line for a call it made or a message it got, the
// id on it for the click that finds the message, and its own answer as its reply.
describe("a message between two sessions", () => {
  it("a message the Leader sent is To its addressee, compact, with its outcome", () => {
    assert.deepEqual(row({ from: "Leader", to: "Paul", text: "go", outcome: "sent", msg: "m-1" }, names), {
      who: "To Paul",
      kind: "peer-out",
      html: "<p>go</p>\n",
      tight: true,
      status: { text: "sent ✓", bad: false, title: "" },
      msg: "m-1",
    });
    assert.deepEqual(row({ from: "Leader", to: "Paul", text: "go", outcome: "not sent", why: "Paul has no process" }, names).status, {
      text: "not sent ✗",
      bad: true,
      title: "Paul has no process",
    });
    assert.deepEqual(row({ from: "Leader", to: "Paul", text: "go", outcome: "refused", why: "that is you" }, names).status, {
      text: "refused ✗",
      bad: true,
      title: "that is you",
    });
    assert.deepEqual(row({ from: "Leader", to: "Paul", text: "the answer", msg: "m-2" }, names), { who: "To Paul", kind: "peer-out", html: "<p>the answer</p>\n", tight: true, msg: "m-2" });
    assert.deepEqual(row({ from: "Leader", to: "Paul", text: "go", outcome: "refused", why: "that is you" }, names).msg, undefined, "a message that did not go is one end of nothing");
  });

  it("a message the Leader received is From its sender", () => {
    assert.deepEqual(row({ from: "Paul", to: "Leader", text: "- one\n- two", msg: "m-3" }, names), {
      who: "From Paul",
      kind: "peer-in",
      html: "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n",
      tight: true,
      msg: "m-3",
    });
  });

  // One line per message on a Worker's panel, and the id on the line: `Sent` for a call of its
  // own that went, `Received` for one that reached it; a call that did not go is `Writing`, red,
  // with the reason it did not for a tooltip, and no id since it is nowhere on the Leader's panel.
  it("on a Worker's panel a message is a line with the message's id, red with the reason when it did not go", () => {
    assert.deepEqual(row({ from: "Paul", to: "Leader", text: "go", outcome: "sent", msg: "m-4" }, worker), { who: "Paul", kind: "line", text: "Sent a message to Leader", err: false, why: "", msg: "m-4" });
    assert.deepEqual(row({ from: "Paul", to: "Nobody", text: "go", outcome: "not sent", why: "nobody called Nobody works here" }, worker), {
      who: "Paul",
      kind: "line",
      text: "Writing a message to Nobody",
      err: true,
      why: "nobody called Nobody works here",
    });
    assert.deepEqual(row({ from: "Paul", to: "Paul", text: "go", outcome: "refused", why: "that is you" }, worker), { who: "Paul", kind: "line", text: "Writing a message to Paul", err: true, why: "that is you" });
    assert.deepEqual(row({ from: "Leader", to: "Paul", text: "**go**", msg: "m-5" }, worker), { who: "Leader", kind: "line", text: "Received a message from Leader", err: false, why: "", msg: "m-5" });
  });

  it("a Worker's answer stays its own reply", () => {
    const shown = row({ from: "Paul", to: "Leader", text: "pong" }, worker);
    assert.equal(shown.who, "Paul");
    assert.equal(shown.kind, "reply");
    assert.match(shown.html, /<p>pong<\/p>/);
    assert.equal(shown.tight, undefined);
    assert.equal(row({ from: "Paul", to: "Leader", text: "", failed: true }, worker).kind, "failed");
    assert.equal(row({ from: "Paul", to: "Leader", text: "", failed: true }, names).kind, "failed", "a failed answer stays red on the Leader's panel too");
  });
});
