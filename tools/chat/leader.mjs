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

// Who the leader is, written out at install. It is appended to Claude Code's own system prompt
// rather than replacing it, so the leader gains a name and a desk without losing the
// instructions that make its tools work.
const PERSONA_FILE = "leader.md";

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

// The persona is passed on every run, resumed ones included. Claude Code does keep it with the
// conversation, so a resume would carry it anyway — but a resume that fails is asked again as a
// new conversation, and that one has no history to carry it. Passing it always means there is no
// path through here where the leader forgets who it is.
//
// An instance installed before the persona existed has no such file. Claude Code refuses to
// start at all when pointed at a file that is not there, so the flag is left off instead: a
// leader without a name still answers, and a chat that will not answer helps nobody.
function persona(root) {
  const file = path.join(root, PERSONA_FILE);
  return fs.existsSync(file) ? file : null;
}

function run(instance, text, resume) {
  const args = ["-p", text, "--output-format", "json", "--model", instance.config.models.leader];
  const who = persona(instance.root);
  if (who !== null) {
    args.push("--append-system-prompt-file", who);
  }
  if (resume !== null) {
    args.push("--resume", resume);
  }

  return new Promise((resolve) => {
    let child;
    try {
      // The question is already in the arguments, so there is nothing to send on stdin. Left as a
      // pipe, Claude Code cannot know that: it waits three seconds for input that is never coming
      // and says so on stderr. Closing stdin says it up front, and every answer arrives sooner.
      child = spawn("claude", args, {
        cwd: instance.root,
        env: environment(instance.root, instance.config.auth),
        stdio: ["ignore", "pipe", "pipe"],
      });
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
