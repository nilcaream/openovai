// A row of a panel, as the page shows it: markdown for a reply and words for everything else.
// Every mutation in tests/mutations-render.json names the check it was written to redden.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INTERRUPTED, SILENT, html, row } from "../lib/chat/render.mjs";

// The Leader's panel, and a Worker's: the same rows drawn from two seats.
const names = { chat: "the chat", seat: "Leader", leader: "Leader" };
const worker = { chat: "the chat", seat: "Paul", leader: "Leader" };

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
  it("the User's own words are `you`, plain", () => {
    assert.deepEqual(row({ from: "user", text: "**not** markdown" }, names), { who: "you", kind: "user", text: "**not** markdown" });
  });

  it("a word typed to a Worker says where it went on the Leader's panel", () => {
    assert.deepEqual(row({ from: "user", typedTo: "Paul", text: "check the repo" }, names), { who: "you → Paul", kind: "user", text: "check the repo" });
  });

  it("the chat's own lines are muted words", () => {
    assert.deepEqual(row({ from: "the chat", text: "Paul has no process" }, names), { who: "the chat", kind: "chat", text: "Paul has no process" });
  });

  it("a failed turn is shown failed", () => {
    assert.deepEqual(row({ from: "the chat", text: "Paul stopped before answering: x", failed: true }, names), {
      who: "the chat",
      kind: "failed",
      text: "Paul stopped before answering: x",
    });
    assert.equal(row({ from: "Paul", text: "", failed: true }, names).kind, "failed");
  });

  it("a silent turn is said so", () => {
    assert.deepEqual(row({ from: "Paul", text: "", silent: true }, names), { who: "Paul", kind: "silent", text: SILENT });
  });

  it("an interrupted turn is shown as interrupted, not as a reply", () => {
    assert.deepEqual(row({ from: "Paul", text: "interrupted", interrupted: true }, names), { who: "the chat", kind: "interrupted", text: INTERRUPTED });
  });

  // A tool call is what the server summarised it as, as text — never markdown, never a reply —
  // and stays a line whatever else the entry carries; red once its call failed.
  it("a tool call is a line: the summary as text, its kind line, red once the call failed", () => {
    assert.deepEqual(row({ at: "2026-09-14T09:00:00.000Z", from: "Paul", line: "Reading ~/x/y.mjs", call: "toolu_1" }, names), { who: "Paul", kind: "line", text: "Reading ~/x/y.mjs", err: false });
    assert.deepEqual(row({ from: "Paul", line: "Run the suite", call: "toolu_2", err: true }, names), { who: "Paul", kind: "line", text: "Run the suite", err: true });
    assert.equal(row({ from: "Paul", line: "Searching **x**", call: "toolu_3", interrupted: true }, names).kind, "line");
    assert.equal(row({ from: "Paul", line: "Searching **x**", call: "toolu_3" }, names).html, undefined, "a line is never markdown");
  });
});

// A message between two sessions carries `to`. The Leader's panel draws its whole text, compact,
// `To` on the way out with what became of it, `From` on the way in; a Worker's panel draws one
// line for a call it made or a message it got, and its own answer as its reply.
describe("a message between two sessions", () => {
  it("a message the Leader sent is To its addressee, compact, with its outcome", () => {
    assert.deepEqual(row({ from: "Leader", to: "Paul", text: "go", outcome: "sent" }, names), {
      who: "To Paul",
      kind: "peer-out",
      html: "<p>go</p>\n",
      tight: true,
      status: { text: "sent ✓", bad: false, title: "" },
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
    assert.deepEqual(row({ from: "Leader", to: "Paul", text: "the answer" }, names), { who: "To Paul", kind: "peer-out", html: "<p>the answer</p>\n", tight: true });
  });

  it("a message the Leader received is From its sender", () => {
    assert.deepEqual(row({ from: "Paul", to: "Leader", text: "- one\n- two" }, names), {
      who: "From Paul",
      kind: "peer-in",
      html: "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n",
      tight: true,
    });
  });

  it("on a Worker's panel a message is a line, red when it did not go", () => {
    assert.deepEqual(row({ from: "Paul", to: "Leader", text: "go", outcome: "sent" }, worker), { who: "Paul", kind: "line", text: "Writing a message to Leader", err: false });
    assert.deepEqual(row({ from: "Paul", to: "Nobody", text: "go", outcome: "not sent", why: "nobody called Nobody works here" }, worker), {
      who: "Paul",
      kind: "line",
      text: "Writing a message to Nobody",
      err: true,
    });
    assert.deepEqual(row({ from: "Paul", to: "Paul", text: "go", outcome: "refused", why: "that is you" }, worker), { who: "Paul", kind: "line", text: "Writing a message to Paul", err: true });
    assert.deepEqual(row({ from: "Leader", to: "Paul", text: "**go**" }, worker), { who: "Leader", kind: "line", text: "Received a message from Leader", err: false });
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
