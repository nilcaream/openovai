// The memory helper: one Claude Code process per question, answered here by the stand-in.
//
// What is worth checking is our side: the shape the process is started in, where it runs, what it
// is handed, what is done with what it answers, and how it is stopped. The stand-in records the
// call and answers what a check stages; no model runs. Every mutation in
// tests/mutations-helper.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { ask } from "../tools/helper.mjs";
import { alive, installed, readLog, remove, repo, scratch, writeStandIn } from "./helpers.mjs";

const root = scratch("helper-test");
const standIn = `${root}-stand-in`;
const log = path.join(standIn, "calls.txt");
const helperAnswer = path.join(standIn, "helper-answer.json");

// Where the helper's directory is made: a directory of this suite's own.
const above = `${root}-above`;
const inner = path.join(above, "inner");

process.on("exit", () => {
  remove(root, standIn, above);
});

remove(root, standIn, above);
writeStandIn(standIn);
installed({
  "--root": root,
  "--source": repo,
  "--user": "Mike",
  "--leader": "Superman",
  "--leader-model": "sonnet",
  "--worker-model": "sonnet",
  "--port": 0,
  "--auth": "login",
});
fs.mkdirSync(inner, { recursive: true });

// The helper takes its environment from this process, the way the chat's does from the chat's.
process.env.PATH = `${standIn}${path.delimiter}${process.env.PATH}`;
process.env.OPENOVAI_STAND_IN_LOG = log;
process.env.OPENOVAI_STAND_IN_HELPER = helperAnswer;
process.env.TMPDIR = inner;

const instance = { root, config: JSON.parse(fs.readFileSync(path.join(root, "openovai.json"), "utf8")) };

function stage(answer) {
  fs.writeFileSync(helperAnswer, typeof answer === "string" ? answer : JSON.stringify(answer));
}

// A log of the chat's kind, kept for the check to read.
function quietLog() {
  const warned = [];
  return { warned, warn: (line) => warned.push(line), log: () => {} };
}

function lines(prefix) {
  return readLog(log)
    .split("\n")
    .filter((line) => line.startsWith(`${prefix}: `))
    .map((line) => line.slice(prefix.length + 2));
}

function lastRun() {
  return {
    argv: JSON.parse(lines("helper-argv").at(-1)),
    cwd: lines("cwd").at(-1),
    home: lines("CLAUDE_CONFIG_DIR").at(-1),
    noMemory: lines("CLAUDE_CODE_DISABLE_AUTO_MEMORY").at(-1),
    holds: Number(lines("helper-cwd-holds").at(-1)),
    request: JSON.parse(lines("helper").at(-1)),
  };
}

function withKnob(name, act) {
  process.env[name] = "1";
  return act().finally(() => {
    delete process.env[name];
  });
}

const A_QUESTION = { question: "select", query: "the User's palette", records: [{ id: "m1", kind: "fact", text: "dark" }] };

describe("how the helper is run", () => {
  let said;
  let ran;

  before(async () => {
    stage({ ids: ["m1"] });
    said = await ask(instance, "select", A_QUESTION, { log: quietLog() });
    ran = lastRun();
  });

  it("answers the validated shape", () => {
    assert.deepEqual(said, { answer: { ids: ["m1"] } });
  });

  it("runs it in an empty directory outside the workspace that is gone afterwards", () => {
    assert.ok(ran.cwd.startsWith(`${inner}${path.sep}`), `ran in ${ran.cwd}, not under ${inner}`);
    assert.ok(!ran.cwd.startsWith(`${root}${path.sep}`), `ran inside the workspace: ${ran.cwd}`);
    assert.equal(ran.holds, 0);
    assert.equal(fs.existsSync(ran.cwd), false, `${ran.cwd} is still there`);
  });

  it("hands it the workspace's own home and auto-memory off", () => {
    assert.equal(ran.home, path.join(root, ".claude-home"));
    assert.equal(ran.noMemory, "1");
  });

  // Safe mode is what keeps the machine's own CLAUDE.md files, skills and hooks out of the run:
  // measured on 2.1.269 that a run under a planted CLAUDE.md quotes it back with --system-prompt
  // alone and does not see it with --safe-mode. Only the flag can be checked here.
  it("starts it in print mode with one JSON result, nothing persisted, in safe mode, no MCP server, no tools, sonnet at medium effort, and the question as the whole system prompt", () => {
    const prompt = ran.argv.at(-1);
    assert.deepEqual(ran.argv.slice(0, -1), [
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--safe-mode",
      "--strict-mcp-config",
      "--tools",
      "",
      "--model",
      "sonnet",
      "--effort",
      "medium",
      "--system-prompt",
    ]);
    assert.match(prompt, /^You answer one question about a small list of records\. You return JSON and nothing else\./);
    assert.match(prompt, /Do not invent an id/);
  });

  it("writes the request on stdin as JSON", () => {
    assert.deepEqual(ran.request, A_QUESTION);
  });
});

describe("what the helper answers is checked", () => {
  it("refuses an answer outside the shape, in its own words", async () => {
    stage({ ids: "m1" });
    const chatLog = quietLog();
    assert.deepEqual(await ask(instance, "select", A_QUESTION, { log: chatLog }), { refused: "the helper answered badly" });
  });

  it("refuses a moment without an offset", async () => {
    stage({ until: "2026-09-14T23:59:59" });
    const request = { question: "absolute", words: "until Monday", now: "2026-09-12T19:04:11+02:00", zone: "Europe/Warsaw", weekday: "Saturday" };
    assert.deepEqual(await ask(instance, "absolute", request, { log: quietLog() }), { refused: "the helper answered badly" });
    stage({ until: "2026-09-14T23:59:59+02:00" });
    assert.deepEqual(await ask(instance, "absolute", request, { log: quietLog() }), { answer: { until: "2026-09-14T23:59:59+02:00" } });
  });

  it("keeps the model's words in the chat's log and out of the answer", async () => {
    stage("the model wrote PLUM-CRUMBLE here");
    const chatLog = quietLog();
    const said = await ask(instance, "select", A_QUESTION, { log: chatLog });
    assert.deepEqual(said, { refused: "the helper answered badly" });
    assert.match(chatLog.warned.join("\n"), /the helper answered badly to select: the model wrote PLUM-CRUMBLE here/);
  });

  it("refuses a process that was turned away by the service", async () => {
    stage({ ids: [] });
    const said = await withKnob("OPENOVAI_STAND_IN_REFUSED", () => ask(instance, "select", A_QUESTION, { log: quietLog() }));
    assert.deepEqual(said, { refused: "the helper did not answer" });
  });

  it("refuses a process that fell over, logging why", async () => {
    const chatLog = quietLog();
    const said = await withKnob("OPENOVAI_STAND_IN_BROKEN", () => ask(instance, "select", A_QUESTION, { log: chatLog }));
    assert.deepEqual(said, { refused: "the helper did not answer" });
    assert.match(chatLog.warned.join("\n"), /the helper exited 1: a model was never reached/);
  });
});

describe("a helper that does not answer", () => {
  // The pid comes from the log, not from a variable set after ask() settles: a
  // helper that is never killed keeps ask() pending, the check times out, and
  // this hook is what stops the child from holding the whole suite open.
  after(() => {
    delete process.env.OPENOVAI_STAND_IN_STUCK;
    const pid = Number(lines("pid").at(-1));
    if (pid > 0 && alive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  });

  it("is killed at the clock and the call refused", { timeout: 10000 }, async () => {
    const said = await withKnob("OPENOVAI_STAND_IN_STUCK", () => ask(instance, "select", A_QUESTION, { clock: 400, log: quietLog() }));
    const pid = Number(lines("pid").at(-1));
    assert.deepEqual(said, { refused: "the helper did not answer" });
    assert.ok(pid > 0, "no pid was logged");
    assert.equal(alive(pid), false, `${pid} is still running`);
  });
});
