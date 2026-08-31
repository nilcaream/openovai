// Asking the leader something.
//
// One Claude Code run per message: the process starts, answers, and exits. The conversation
// survives in a session id rather than in a running process, so the server can be stopped and
// started again in the middle of one without losing it. The cost is that a reply cannot appear
// a word at a time, which is a trade worth making until streaming is what is wanted.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { environment } from "../claude.mjs";

// Where the thread lives between runs. One id, written after every answer: it is the whole
// reason a per-message run can still be a conversation.
const SESSION_FILE = path.join("chat", "session.json");

function sessionFile(root) {
  return path.join(root, SESSION_FILE);
}

function remembered(root) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(root), "utf8")).sessionId ?? null;
  } catch {
    return null;
  }
}

function remember(root, sessionId) {
  const target = sessionFile(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ sessionId }, null, 2)}\n`);
}

function forget(root) {
  fs.rmSync(sessionFile(root), { force: true });
}

function run(instance, text, resume) {
  const args = ["-p", text, "--output-format", "json", "--model", instance.config.models.leader];
  if (resume !== null) {
    args.push("--resume", resume);
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("claude", args, { cwd: instance.root, env: environment(instance.root, instance.config.auth) });
    } catch (error) {
      resolve({ failed: true, text: `Claude Code could not be started: ${error.message}` });
      return;
    }

    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });

    child.on("error", (error) => {
      const why =
        error.code === "ENOENT"
          ? "Claude Code is not on the PATH of the process serving this page"
          : error.message;
      resolve({ failed: true, text: why });
    });

    child.on("close", () => resolve(interpret(out, err)));
  });
}

function interpret(out, err) {
  let result;
  try {
    result = JSON.parse(out);
  } catch {
    const said = err.trim() || out.trim();
    return { failed: true, text: said === "" ? "Claude Code said nothing at all" : said };
  }

  return {
    failed: result.is_error === true,
    text: typeof result.result === "string" ? result.result : JSON.stringify(result),
    sessionId: result.session_id ?? null,
  };
}

export async function ask(instance, text) {
  const resume = remembered(instance.root);
  let answer = await run(instance, text, resume);

  // A remembered thread can go away — the Claude Code home was cleared, or the conversation
  // was never written. Rather than leave the chat permanently broken, drop the id and ask
  // again as a new conversation. Losing the history beats losing the chat.
  if (answer.failed && resume !== null) {
    forget(instance.root);
    answer = await run(instance, text, null);
  }

  if (typeof answer.sessionId === "string" && answer.sessionId !== "") {
    remember(instance.root, answer.sessionId);
  }

  return answer;
}
