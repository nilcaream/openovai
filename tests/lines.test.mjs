// What a tool call is drawn as: the line the summary composes from the call's input, for every
// tool the harness and the instance offer. Every mutation in tests/mutations-lines.json names the
// check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { line } from "../lib/chat/lines.mjs";
import { repo } from "./helpers.mjs";

const home = os.homedir();
// The instance root every call here is drawn for.
const ROOT = path.join(home, "work", "inst");

// One call of every tool the summary knows, with the input the real one gives it.
const CALLS = [
  ["Bash", { command: "npm test", description: "Run the suite" }],
  ["Bash", { command: "git status --porcelain" }],
  ["Read", { file_path: `${ROOT}/projects/app/lib/chat/session.mjs` }],
  ["Write", { file_path: "/etc/hosts" }],
  ["Edit", { file_path: `${ROOT}/desks/Paul/notes.md` }],
  ["NotebookEdit", { notebook_path: `${ROOT}/temp/book.ipynb` }],
  ["Grep", { pattern: "tool_use", path: `${ROOT}/projects` }],
  ["Glob", { pattern: "**/*.mjs" }],
  ["SendMessage", { to: "Paul", message: "hello" }],
  ["ListAgents", {}],
  ["Agent", { description: "Find every caller of append", subagent_type: "Explore" }],
  ["TaskOutput", { task_id: "t1" }],
  ["TaskStop", { task_id: "t1" }],
  ["Skill", { skill: "verify" }],
  ["ToolSearch", { query: "select:Monitor" }],
  ["Monitor", { command: "tail -f log", description: "Follow the log" }],
  ["ScheduleWakeup", { delaySeconds: 1200 }],
  ["CronCreate", {}],
  ["CronList", {}],
  ["CronDelete", {}],
  ["WebFetch", { url: "https://example.org/a/b?c=d" }],
  ["WebSearch", { query: "node test runner" }],
  ["Artifact", { action: "read", url: "https://x.y/z" }],
  ["Artifact", { file_path: "page.html" }],
  ["AskUserQuestion", { questions: [{ question: "Which one?" }] }],
  ["EnterPlanMode", {}],
  ["ExitPlanMode", {}],
  ["EndConversation", {}],
  ["mcp__openovai__message", { to: "Paul", text: "hello" }],
  ["mcp__openovai__room", {}],
  ["mcp__openovai__write_desk", { title: "t", status: "s" }],
  ["mcp__openovai__restart_session", {}],
  ["mcp__openovai__stop_session", {}],
  ["mcp__openovai__park", { name: "Paul" }],
  ["mcp__openovai__hire", { name: "Paul" }],
  ["mcp__openovai__permission", { id: "p1" }],
  ["mcp__openovai__later", {}],
  ["mcp__other__thing", { a: 1 }],
  ["Unknown", {}],
  ["Read", undefined],
];

describe("what a tool call is drawn as", () => {
  it("names each tool by what it does, from the call and never its result", () => {
    assert.deepEqual(CALLS.map(([name, input]) => line(name, input, ROOT)), [
      "Run the suite",
      "git status --porcelain",
      "Reading projects/app/lib/chat/session.mjs",
      "Writing /etc/hosts",
      "Editing desks/Paul/notes.md",
      "Editing notebook temp/book.ipynb",
      "Searching tool_use in projects",
      "Searching **/*.mjs",
      "Writing a message to Paul",
      "Looking around the room",
      "Delegating: Find every caller of append (Explore)",
      "Checking a background task",
      "Stopping a background task",
      "Using skill verify",
      null,
      "Watching: Follow the log",
      "Scheduling a wake-up",
      "Scheduling a wake-up",
      "Scheduling a wake-up",
      "Scheduling a wake-up",
      "Fetching example.org",
      "Searching the web: node test runner",
      "Artifact: read",
      "Publishing an artifact",
      "Asking: Which one?",
      "Planning",
      "Plan ready",
      "Closing the conversation",
      null,
      "Looking around the room",
      "Writing the desk",
      null,
      null,
      null,
      null,
      null,
      "Calling openovai: later",
      "Calling other: thing",
      "Using Unknown",
      "Reading ?",
    ]);
  });

  it("says what a command does when the call says it, else the command", () => {
    assert.equal(line("Bash", { command: "npm test", description: "Run the suite" }), "Run the suite");
    assert.equal(line("Bash", { command: "npm test" }), "npm test");
    assert.equal(line("Bash", { command: "npm test", description: "" }), "npm test");
    const long = "x".repeat(200);
    assert.equal(line("Bash", { command: long }), `${"x".repeat(79)}…`, "a command is cut at 80");
    assert.equal(line("Bash", { command: "c", description: long }), `${"x".repeat(119)}…`, "a description is cut at 120");
    assert.equal(line("Bash", { command: "  ls   -la\n  | wc  " }), "ls -la | wc", "whitespace is collapsed");
  });

  it("writes a path under the instance root from the root, and every other path as it came", () => {
    assert.equal(line("Read", { file_path: `${ROOT}/desks/Paul/notes.md` }, ROOT), "Reading desks/Paul/notes.md");
    assert.equal(line("Grep", { pattern: "x", path: `${ROOT}/projects` }, ROOT), "Searching x in projects");
    assert.equal(line("Read", { file_path: `${home}/a/b.mjs` }, ROOT), `Reading ${home}/a/b.mjs`, "home is not written as a tilde");
    assert.equal(line("Grep", { pattern: "x", path: ROOT }, ROOT), `Searching x in ${ROOT}`, "the root itself is written whole");
    assert.equal(line("Read", { file_path: `${ROOT}-old/x.md` }, ROOT), `Reading ${ROOT}-old/x.md`, "a sibling that shares the name is not under it");
    assert.equal(line("Read", { file_path: "lib/x.mjs" }, ROOT), "Reading lib/x.mjs", "a relative path is already from the root");
    assert.equal(line("Write", { file_path: "/var/tmp/x" }, ROOT), "Writing /var/tmp/x", "another path is written whole");
  });

  it("draws nothing for a search of the tool list or a session's own stop", () => {
    assert.equal(line("ToolSearch", { query: "x" }), null);
    assert.equal(line("mcp__openovai__stop_session", {}), null);
    assert.equal(line("mcp__openovai__restart_session", {}), null);
    // A message to another seat is recorded by the server itself, with its outcome: a line for
    // the call would draw the same message twice.
    assert.equal(line("mcp__openovai__message", { to: "Paul", text: "hello" }), null);
  });

  it("carries no forbidden word in anything it can say", () => {
    const { words } = JSON.parse(fs.readFileSync(path.join(repo, "tests", "forbidden-words.json"), "utf8"));
    const said = CALLS.map(([name, input]) => line(name, input, ROOT)).filter((text) => text !== null);
    assert.ok(said.length >= 30, `only ${said.length} lines, so this check read almost nothing`);
    for (const text of said) {
      for (const word of words) {
        assert.doesNotMatch(text, new RegExp(`\\b${word.replace(/ /g, "\\s+")}`, "i"), `a line says "${word}": ${text}`);
      }
    }
  });
});
