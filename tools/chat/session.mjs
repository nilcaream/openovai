// Asking a session something.
//
// One Claude Code run per message: the process starts, answers, and exits. The conversation
// survives in a session id rather than in a running process, so the server can be stopped and
// started again in the middle of one without losing it. The cost is that a reply cannot appear
// a word at a time, which is a trade worth making until streaming is what is wanted.
//
// Every session in the instance is run through here, the lead included. A session differs from
// another only in its name, the model it runs on and the persona it is given; nothing else about
// the run is anybody's in particular, so there is one way to run one rather than one per kind.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { environment } from "../claude.mjs";
import { desks } from "../desks.mjs";

// Where a thread lives between runs, under the name of the session having it. One id, written
// after every answer: it is the whole reason a per-message run can still be a conversation.
const SESSION_FILE = "session.json";

// Who a session is, written out when it is opened. A persona is appended to Claude Code's own
// system prompt rather than replacing it, so a session gains a name and a desk without losing
// the instructions that make its tools work.
const PERSONAS = "personas";

function sessionFile(root, name) {
  return path.join(root, "chat", name, SESSION_FILE);
}

function remembered(root, name) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(root, name), "utf8")).sessionId ?? null;
  } catch {
    return null;
  }
}

function remember(root, name, sessionId) {
  const target = sessionFile(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ sessionId }, null, 2)}\n`);
}

function forget(root, name) {
  fs.rmSync(sessionFile(root, name), { force: true });
}

// Which model a session runs on. The instance was installed with one model for the session that
// leads and one for everybody else, and a session's own name is enough to say which it is, so
// there is nothing to record and nothing that can disagree with ow.json.
function model(instance, name) {
  const models = instance.config.models;
  return name === instance.config.leader ? models.leader : models.worker;
}

// The persona is passed on every run, resumed ones included. Claude Code does keep it with the
// conversation, so a resume would carry it anyway — but a resume that fails is asked again as a
// new conversation, and that one has no history to carry it. Passing it always means there is no
// path through here where a session forgets who it is.
//
// A session may have no persona file: an instance installed before personas were written out has
// none for its lead. Claude Code refuses to start at all when pointed at a file that is not
// there, so the flag is left off instead: a nameless session still answers, and a chat that will
// not answer helps nobody.
function persona(root, name) {
  const file = path.join(root, PERSONAS, `${name}.md`);
  return fs.existsSync(file) ? file : null;
}

// Everybody the chat can host, the lead first and the rest as the desks come. A desk is a
// person, so this is read from work/ every time it is asked for rather than kept anywhere: a desk
// opened while the chat is running is somebody the chat can host from that moment on.
//
// The lead is named whether or not it has a desk. An instance has a lead by definition, and a
// chat that dropped it because a directory went missing would be a chat nobody can reach.
export function sessions(instance) {
  const leader = instance.config.leader;
  const rest = desks(instance.root).filter((name) => name !== leader);

  return [leader, ...rest].map((name) => ({
    name,
    role: name === leader ? "lead" : "worker",
    model: model(instance, name),
  }));
}

function run(instance, name, text, resume) {
  const args = ["-p", text, "--output-format", "json", "--model", model(instance, name)];
  const who = persona(instance.root, name);
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

export async function ask(instance, name, text) {
  const resume = remembered(instance.root, name);
  let answer = await run(instance, name, text, resume);

  // A remembered thread can go away — the Claude Code home was cleared, or the conversation
  // was never written. Rather than leave the chat permanently broken, drop the id and ask
  // again as a new conversation. Losing the history beats losing the chat.
  if (answer.failed && resume !== null) {
    forget(instance.root, name);
    answer = await run(instance, name, text, null);
  }

  if (typeof answer.sessionId === "string" && answer.sessionId !== "") {
    remember(instance.root, name, answer.sessionId);
  }

  return answer;
}
