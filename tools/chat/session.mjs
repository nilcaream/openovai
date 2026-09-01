// Asking a session something.
//
// One Claude Code run per message: the process starts, answers, and is closed. It need not be —
// held open, a run answers question after question in one conversation — and it is closed anyway,
// because the conversation surviving in a session id rather than in a running process is what lets
// the server be stopped and started again in the middle of one without losing it. Keeping a
// process per session would trade that away and make this the place that supervises them. The
// price of the trade is a start-up per message, and it is knowingly paid.
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

// What a session is told its own name in. `ow say` reads it, so a message one session sends
// another arrives under the name of whoever sent it — and a message nobody signed is the human's,
// which is the whole of how a session tells the two apart.
export const NAME_IN_ENVIRONMENT = "OW_SESSION_NAME";

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

// The frame a question is sent as. Claude Code reads one JSON object per line on stdin; a user
// message is the smallest of them, and `content` is allowed to be the plain string rather than a
// list of blocks, which is all a question from a page ever is.
function question(text) {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

// Everything Claude Code says comes back one JSON object per line, and only the `result` line is
// an answer. The rest is read and handed over all the same — the assistant's own turns,
// `keep_alive` every thirty seconds while a long one runs, `system` notices — because what a frame
// is worth is the caller's business and not the reader's. A line that is not JSON at all is
// skipped rather than fatal: stdout is the protocol, but a stray warning on it should not lose an
// answer that arrived beside it.
function frames(chunk, rest, saw) {
  const lines = (rest + chunk).split("\n");
  const left = lines.pop();

  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    try {
      saw(JSON.parse(line));
    } catch {
      // Not a frame. Nothing on this line is ours to act on.
    }
  }
  return left;
}

// One run, one question, one answer.
//
// The question goes in on stdin rather than in the arguments: with --input-format stream-json a
// prompt argument is read past in silence, so passing one would look right and ask nothing. Stdin
// then stays open until the answer arrives, because a run that is waiting to be told whether it
// may use a tool has to be able to hear the reply, which is what this format is for. Closing it
// once the answer is in is what ends the run: the child would otherwise sit
// there waiting for another question, which is a conversation the chat keeps in a session id
// instead, so that stopping the server never costs one.
function run(instance, name, text, resume) {
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model(instance, name),
  ];
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
      child = spawn("claude", args, {
        cwd: instance.root,
        env: { ...environment(instance.root, instance.config.auth), [NAME_IN_ENVIRONMENT]: name },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ failed: true, text: `Claude Code could not be started: ${error.message}` });
      return;
    }

    let answer = null;
    let rest = "";
    let out = "";
    let err = "";

    child.stdout.on("data", (chunk) => {
      out += chunk;
      rest = frames(String(chunk), rest, (frame) => {
        if (frame.type !== "result" || answer !== null) {
          return;
        }
        answer = frame;
        child.stdin.end();
      });
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });

    // Writing to a child that is already gone is an error on the pipe, not a throw, and there is
    // nothing to do about it here: the close handler is about to say what happened.
    child.stdin.on("error", () => {});

    child.on("error", (error) => {
      const why =
        error.code === "ENOENT"
          ? "Claude Code is not on the PATH of the process serving this page"
          : error.message;
      resolve({ failed: true, text: why });
    });

    child.on("close", () => resolve(interpret(answer, out, err)));

    child.stdin.write(question(text));
  });
}

// What the run amounted to. The result frame carries the answer as a plain string in `result`,
// which is the same field and the same string the older whole-of-stdout JSON put it in, so what
// the chat does with an answer did not have to change with how it arrives.
function interpret(answer, out, err) {
  // No result frame at all. Whatever went wrong was said in prose rather than in the protocol, so
  // what it said is the answer — stdout included, because a run that fell over before it could
  // frame anything may well have put the reason there.
  if (answer === null) {
    const said = err.trim() || out.trim();
    return { failed: true, text: said === "" ? "Claude Code said nothing at all" : said };
  }

  return {
    failed: answer.is_error === true,
    text: typeof answer.result === "string" ? answer.result : JSON.stringify(answer),
    sessionId: answer.session_id ?? null,
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
