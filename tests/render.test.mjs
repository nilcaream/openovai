// A row of a panel, as the page shows it: markdown for a reply and words for everything else.
// Every mutation in tests/mutations-render.json names the check it was written to redden.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INTERRUPTED, SILENT, html, row } from "../tools/chat/render.mjs";

const names = { chat: "the chat" };

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
});
