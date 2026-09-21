// The memory helper: one question about a small list of records, answered by a model.
//
// Called inside a store tool where a request needs understanding rather than a grep — which of
// these records answer a query, whether a new text restates one of them, what moment "for today"
// means. It is Claude Code run once in print mode on the workspace's own account, the same
// credentials every session runs on; there is no API key in a workspace and none is introduced.
//
// STATELESS AND EMPTY-HANDED. One process per question, ended when it answers. It has no tools,
// no MCP server, nothing persisted and nothing resumed; its system prompt is the question and
// nothing else; it runs in Claude Code's safe mode, which is what keeps every instruction file,
// skill, hook and plugin of the machine out of it; its working directory is a fresh empty
// directory outside the workspace, made for the call and removed after it; and Claude Code's own
// memory is off in its environment. What comes back is a strict JSON shape parsed and validated
// here — only ids it was sent and moments that parse are ever used — so whatever it could still
// be told can colour an answer and never act.
//
// Why safe mode and not the directory alone — measured on 2.1.269. Claude Code walks up from its
// working directory and reads every CLAUDE.md on the way, and `--system-prompt` does not stop it:
// a run under a directory with a planted CLAUDE.md above it quoted that file back when asked what
// it had been told (810 input tokens against 608 for the same run with nothing planted). The same
// run with `--safe-mode` had not seen it (609 tokens). A temporary directory sits under whatever
// the machine's TMPDIR is, which can be a home with a CLAUDE.md in it, so the directory is where
// the run works and safe mode is what it does not read.
//
// ONE REQUEST ON THE ACCOUNT per call. Everything a grep can serve — a record by id, the list, an
// absolute `until`, a retire — never comes here, so the store answers those without spending one.
//
// NO RETRY. A process that does not answer inside the clock is killed and the tool call is refused;
// one that answers badly is refused the same way, with the model's output in the chat's log and
// never in the answer. The session can ask again. A loop that retries a model is a loop nobody
// bounded.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mayStart } from "./chat/quota.mjs";
import { environment } from "./claude.mjs";
import { RuntimeError, claudeCommand } from "./runtime.mjs";

export const HELPER_MODEL = "sonnet";
export const HELPER_EFFORT = "medium";

// How long a question may take before the process is killed and the call refused.
export const HELPER_CLOCK = 60 * 1000;

// The three questions, and the system prompt for each: fixed text, no per-call variation, so its
// prefix caches. The request itself arrives as JSON on stdin.
const RULES =
  "Return JSON and nothing else: no prose before or after it, no code fence. Do not rewrite, shorten or merge any text. Do not invent an id: use only ids from the records you were given. Do not explain outside the JSON.";

export const QUESTIONS = Object.freeze({
  select: {
    prompt:
      "You answer one question about a small list of records. You return JSON and nothing else.\n\n" +
      "The request is JSON with a query and a list of records, each { id, kind, text }. Answer which records answer the query by meaning, most relevant first, as { \"ids\": [\"m3\", \"m17\"] }; answer { \"ids\": [] } when none does.\n\n" +
      RULES,
    // The ids are checked where they are looked up: the store answers only records it sent.
    validate: (answer) => {
      if (!Array.isArray(answer?.ids) || !answer.ids.every((id) => typeof id === "string")) {
        return null;
      }
      return { ids: answer.ids };
    },
  },
  replaces: {
    prompt:
      "You answer one question about a small list of records. You return JSON and nothing else.\n\n" +
      "The request is JSON with a new text, its kind, and the current records of that kind, each { id, text }. Answer whether the new text is the same rule or fact as exactly one of them — restated, widened, narrowed or reversed — and therefore replaces it, as { \"replaces\": \"m9\", \"reason\": \"<one sentence>\" }; answer { \"replaces\": null, \"reason\": \"<one sentence>\" } when it is new.\n\n" +
      RULES,
    validate: (answer, request) => {
      if (answer === null || typeof answer !== "object" || !("replaces" in answer)) {
        return null;
      }
      if (answer.replaces !== null && typeof answer.replaces !== "string") {
        return null;
      }
      // An id it was not sent is an answer about a record nobody named: refused, never guessed at.
      const sent = new Set(request.records.map((record) => record.id));
      if (answer.replaces !== null && !sent.has(answer.replaces)) {
        return null;
      }
      const reason = typeof answer.reason === "string" && answer.reason.trim() !== "" ? answer.reason.trim() : "as the helper judged";
      return { replaces: answer.replaces, reason };
    },
  },
  absolute: {
    prompt:
      "You answer one question about a moment in time. You return JSON and nothing else.\n\n" +
      "The request is JSON with words naming a moment relative to now, the current moment as ISO 8601 with its offset, the time zone's name and today's weekday. Answer the absolute moment the words mean, in that zone, as { \"until\": \"2026-09-14T23:59:59+02:00\" }. \"for today\" is the end of today; \"until Monday\" is the end of the next Monday; a bare date is the end of that day. Answer { \"until\": null } when the words do not name a moment.\n\n" +
      RULES,
    validate: (answer) => {
      if (answer === null || typeof answer !== "object" || !("until" in answer)) {
        return null;
      }
      if (answer.until === null) {
        return { until: null };
      }
      if (typeof answer.until !== "string" || !WITH_OFFSET.test(answer.until) || Number.isNaN(Date.parse(answer.until))) {
        return null;
      }
      return { until: answer.until };
    },
  },
});

const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// Auto-memory off in the environment, beside being off in the workspace's home settings.
const NO_MEMORY = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

// Ask one question. Answers { answer } with the validated shape, or { refused } in the tool's own
// words. `clock` is the wall clock in milliseconds; `log` is where a warning or the model's output
// goes, and is the chat's own log by default.
export async function ask(instance, question, request, { clock = HELPER_CLOCK, log = console } = {}) {
  const asked = QUESTIONS[question];
  if (asked === undefined) {
    throw new Error(`the helper has no question called ${question}`);
  }

  // The quota gate, before anything is spawned: a helper run at the second stage of a window
  // would spend what the gate exists to keep.
  const held = mayStart(HELPER_MODEL);
  if (held !== null) {
    return { refused: "the helper is held: quota" };
  }

  const env = { ...environment(instance.root, instance.config.auth), [NO_MEMORY]: "1" };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openovai-helper-"));

  try {
    const ran = await run(instance.root, cwd, env, asked.prompt, JSON.stringify(request), clock);
    if (ran.timedOut) {
      return { refused: "the helper did not answer" };
    }
    // A process turned away by the service — a usage limit, no credential — exits 1 with its
    // refusal in the result, the same way one that fell over does, so the exit status is what
    // tells both apart from an answer.
    if (ran.status !== 0) {
      log.warn(`the helper exited ${ran.status}${ran.stderr.trim() === "" ? "" : `: ${ran.stderr.trim()}`}`);
      return { refused: "the helper did not answer" };
    }
    const envelope = asJson(ran.stdout);
    if (envelope === null || typeof envelope.result !== "string") {
      log.warn(`the helper answered outside the envelope: ${ran.stdout.trim()}`);
      return { refused: "the helper did not answer" };
    }
    const answer = asked.validate(asJson(envelope.result), request);
    if (answer === null) {
      log.warn(`the helper answered badly to ${question}: ${envelope.result}`);
      return { refused: "the helper answered badly" };
    }
    return { answer };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function asJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function run(root, cwd, env, prompt, stdin, clock) {
  return new Promise((resolve) => {
    // Print mode, one JSON result, no persistence, safe mode, no MCP server, no built-in tool at
    // all, and the question as the whole system prompt. Written out here, at the spawn, where the
    // shape is read.
    const args = [
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--safe-mode",
      "--strict-mcp-config",
      "--tools",
      "",
      "--model",
      HELPER_MODEL,
      "--effort",
      HELPER_EFFORT,
      "--system-prompt",
      prompt,
    ];
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(claudeCommand(root), args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      // A claude that was never fetched is a run that did not answer, said in the log the way a
      // process that could not start is.
      if (!(error instanceof RuntimeError)) throw error;
      resolve({ status: null, stdout, stderr: error.message, timedOut: false });
      return;
    }
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, clock);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}
