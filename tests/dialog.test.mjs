// What a dialog on a panel shows, decided in lib/chat/dialog.mjs and drawn by the page: the
// words of the request and nothing else, and the three buttons each kind of question has.
//
// Every mutation in tests/mutations-dialog.json names the check it was written to redden.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dialogOf } from "../lib/chat/dialog.mjs";

const line = (dialog, kind) => dialog.lines.filter((held) => held.kind === kind).map((held) => held.text);
const decisions = (dialog) => dialog.buttons.map((button) => button.decision);

describe("a call stop", () => {
  const push = dialogOf({ id: "r1", tool: "Bash", input: { command: "git push", description: "push the branch" }, shape: ["Bash(git push:*)"] }, "Paul");

  it("heads a call stop with who wants which tool", () => {
    assert.equal(push.kind, "call");
    assert.equal(push.heading, "Paul wants to use Bash");
  });

  it("shows the command as the session wrote it", () => {
    assert.deepEqual(line(push, "command"), ["git push"]);
  });

  it("carries the reason the session gave, verbatim, or none", () => {
    assert.deepEqual(line(push, "reason"), ["push the branch"]);
    const bare = dialogOf({ id: "r2", tool: "Bash", input: { command: "ls" } }, "Paul");
    assert.deepEqual(line(bare, "reason"), []);
    const blank = dialogOf({ id: "r3", tool: "Bash", input: { command: "ls", description: "   " } }, "Paul");
    assert.deepEqual(line(blank, "reason"), []);
  });

  it("shows the path of a write, and no reason line for it", () => {
    const write = dialogOf({ id: "r4", tool: "Write", input: { file_path: "projects/Paul/notes.md", content: "x" }, shape: ["Edit(/projects/Paul/**)"] }, "Paul");
    assert.deepEqual(line(write, "path"), ["projects/Paul/notes.md"]);
    assert.deepEqual(line(write, "reason"), []);
    assert.deepEqual(line(write, "input"), []);
  });

  it("shows another tool's input whole, as the request made it", () => {
    const fetch_ = dialogOf({ id: "r5", tool: "WebFetch", input: { url: "https://x" } }, "Paul");
    assert.deepEqual(line(fetch_, "input"), ['{"url":"https://x"}']);
    assert.deepEqual(line(fetch_, "reason"), []);
    assert.deepEqual(line(fetch_, "command"), []);
  });

  it("offers Always only where a rule was composed", () => {
    assert.deepEqual(decisions(push), ["allow", "always", "deny"]);
    assert.equal(push.buttons[1].label, "Always allow Bash(git push:*)");
    const compound = dialogOf({ id: "r8", tool: "Bash", input: { command: "npm test && make build" }, shape: ["Bash(npm:*)", "Bash(make:*)"] }, "Paul");
    assert.equal(compound.buttons[1].label, "Always allow Bash(npm:*) and Bash(make:*)");
    const bare = dialogOf({ id: "r6", tool: "WebFetch", input: { url: "https://x" } }, "Paul");
    assert.deepEqual(decisions(bare), ["allow", "deny"]);
  });
});

describe("a rule request", () => {
  const rule = dialogOf({ id: "q1", kind: "rule", rule: "Bash(git push:*)", why: "the User asked to push without asking", from: "Superman" }, "Superman");

  it("heads a rule request with who asks", () => {
    assert.equal(rule.kind, "rule");
    assert.equal(rule.heading, "Superman asks you to settle a rule");
  });

  it("shows the rule", () => {
    assert.deepEqual(line(rule, "rule"), ["Bash(git push:*)"]);
  });

  it("shows why the rule was asked", () => {
    assert.deepEqual(line(rule, "why"), ["the User asked to push without asking"]);
  });

  it("gives a call stop and a rule request their own three buttons", () => {
    assert.deepEqual(decisions(rule), ["allow", "deny", "ask"]);
    assert.equal(rule.buttons[2].label, "Ask every time");
    const call = dialogOf({ id: "r7", tool: "Bash", input: { command: "git push" }, shape: ["Bash(git push:*)"] }, "Paul");
    assert.deepEqual(decisions(call), ["allow", "always", "deny"]);
    assert.ok(!decisions(call).includes("ask"));
    assert.ok(!decisions(rule).includes("always"));
  });
});
