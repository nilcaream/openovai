// One process per seat, and the one writer of its stdin.
//
// A seat is a desk with a name. When a seat starts, this module spawns one Claude Code process for
// it and keeps it: the process reads turn after turn from its stdin, in one conversation, until
// the seat is ended. Nothing else in the toolkit holds a child or writes to one. Text reaches a
// session in exactly one way — `tell(seat, frame)` — and only with a frame built by
// `frames.mjs`, so a body is neutralised before it can get anywhere near a process.
//
// Identity travels with the process. Before the child exists a secret is minted and issued for the
// seat and its role (`secrets.mjs`); the child is spawned with the secret in its environment and
// an MCP address that names it, and the server knows every call from that process by the secret
// alone. When the child ends, the secret is revoked with it.
//
// A turn is one frame written as one line, answered by one `result` line. A seat has a queue of
// frames; the next one is written only when the previous turn has ended, so a session never has
// two questions in flight and every answer belongs to the question before it.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { environment } from "../claude.mjs";
import { listening } from "./listening.mjs";
import { desks, modelFor, persona } from "../desks.mjs";
import { LEADER, WORKER, withHardRules } from "../store.mjs";
import { ownInstructions } from "../instructions.mjs";
import { isFrame } from "./frames.mjs";
import { issue, revoke } from "./secrets.mjs";

const PERSONA_FILE = "persona.md";

// The one thing a session is handed that says who it is, and the only place it is said: the MCP
// address in the child's arguments refers to this variable rather than carrying the value, so the
// secret is in the process environment and nowhere a wider audience can read it.
export const SECRET_IN_ENVIRONMENT = "OPENOVAI_SESSION_SECRET";

// The role words are the store's: what a tool is refused and what a hard rule is scoped to are
// said in the same two words as who is calling.
export { LEADER, WORKER } from "../store.mjs";

// How long a session may wait on another session's answer over the MCP connection. A turn can
// be long; Claude Code's own default would give up on a colleague who was merely thinking.
export const A_WHOLE_TURN = 30 * 60 * 1000;

export function roleOf(instance, seat) {
  return seat === instance.config.leader ? LEADER : WORKER;
}

// The role a seat is: the one its process was issued, for as long as that process runs, and
// otherwise the one the configuration would issue it now. A process is one role for its whole
// life; what the configuration says is what its next process will be.
function roleNow(instance, seat) {
  return processes.get(seat)?.role ?? roleOf(instance, seat);
}

// Everybody who works here: the Leader first, then every desk. Read from work/ each time it is
// asked, so a desk opened while the server runs is a seat from that moment on. The Leader is a
// seat whether or not a desk exists for it.
export function seats(instance) {
  const leader = instance.config.leader;
  const rest = desks(instance.root).filter((name) => name !== leader);
  return [leader, ...rest].map((name) => ({
    name,
    role: roleNow(instance, name),
    model: modelFor(instance.root, name, instance.config),
  }));
}

export function isSeat(instance, seat) {
  return seats(instance).some((one) => one.name === seat);
}

export function personaFile(root, seat) {
  return path.join(root, "chat", seat, PERSONA_FILE);
}

// Rendered on every start: a process is one conversation, and the persona it opens with is the
// one the instance renders now — the persona, and after it the hard rules as they stand for this
// seat's role, so a new conversation is told the current numbered set verbatim.
function personaFor(instance, seat) {
  const file = personaFile(instance.root, seat);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { text } = withHardRules(persona(instance.root, seat, instance.config), instance.root, roleOf(instance, seat));
  fs.writeFileSync(file, text);
  return file;
}

// The MCP server a session reaches the toolkit through. The address names the process by its
// secret, and it does so by referring to the environment variable: Claude Code expands `${VAR}`
// in a server's url from the process environment, so the literal secret is never in argv.
function toolsIn(root) {
  const chat = listening(root);
  if (chat === null) {
    return null;
  }
  return JSON.stringify({
    mcpServers: {
      openovai: {
        type: "http",
        url: `${chat}/mcp/\${${SECRET_IN_ENVIRONMENT}}`,
        timeout: A_WHOLE_TURN,
      },
    },
  });
}

// ------------------------------------------------------------------------------ what a child says

// Everything Claude Code says comes back one JSON object per line. A line that is not JSON is
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

// Being asked whether the run may use a tool, and saying. Only tool calls the instance's own
// settings leave undecided ever get here. The request id goes back exactly as it came, nothing
// else about the tool is named beside it, and one request is answered once: get any of that
// wrong and the run hangs for good.
function permission(child, frame, asked) {
  const request = { id: frame.request_id, tool: frame.request.tool_name, input: frame.request.input };
  asked(request).then(
    (decision) => {
      child.stdin.write(
        `${JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: frame.request_id, response: decision },
        })}\n`,
      );
    },
    (error) => {
      // Nobody could be asked. Saying so is an answer; saying nothing leaves the run waiting for
      // one that is never coming.
      child.stdin.write(
        `${JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: frame.request_id,
            response: { behavior: "deny", message: `nobody could be asked: ${error.message}` },
          },
        })}\n`,
      );
    },
  );
}

// What a turn came to, read off its result line. `result` is a plain string on success; a run
// that failed carries `errors` instead.
function answerIn(frame) {
  const failed = frame.is_error === true || typeof frame.result !== "string";
  const text =
    typeof frame.result === "string"
      ? frame.result
      : Array.isArray(frame.errors)
        ? frame.errors.join("\n")
        : JSON.stringify(frame);
  return { text, failed, silent: !failed && text.trim() === "" };
}

// ------------------------------------------------------------------------------------ processes

// Every seat with a process, by name. A seat is in here from the moment its child is spawned to
// the moment the child closes.
const processes = new Map();

function nobodyToAsk() {
  return Promise.reject(new Error("no way to ask anybody"));
}

function nothing() {}

export function running(seat) {
  return processes.has(seat);
}

export function runningSeats() {
  return [...processes.keys()];
}

// Start a seat: one process, one secret, one conversation.
//
// `asked` is called with every permission request the run makes and answers with a decision;
// `ended` is called once, when the process has closed, so whoever started the seat can let go of
// what it was holding for it.
export function start(instance, seat, { asked = nobodyToAsk, ended = nothing } = {}) {
  if (!isSeat(instance, seat)) {
    throw new Error(`nobody called ${seat} works here`);
  }
  if (processes.has(seat)) {
    throw new Error(`${seat} is already running`);
  }

  const role = roleOf(instance, seat);
  const secret = issue(seat, role);

  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // Ask us rather than refusing on the spot. The literal is reserved: it means "over the pipes
    // to whoever started me".
    "--permission-prompt-tool",
    "stdio",
    "--model",
    modelFor(instance.root, seat, instance.config),
  ];
  const tools = toolsIn(instance.root);
  if (tools !== null) {
    args.push("--mcp-config", tools);
  }
  // What is NOT to be read: the instructions of every directory above the instance.
  args.push("--settings", ownInstructions(instance.root));
  args.push("--append-system-prompt-file", personaFor(instance, seat));

  // --print is load-bearing: it makes this a run rather than a conversation held on a terminal,
  // and it keeps Claude Code from arming its background-shell reaper, which is armed only for a
  // session it judged interactive. Every way this toolkit starts Claude Code is held to that
  // shape by a check in tests/ovai.test.mjs.
  const child = spawn("claude", args, {
    cwd: instance.root,
    env: { ...environment(instance.root, instance.config.auth), [SECRET_IN_ENVIRONMENT]: secret },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const record = { seat, role, secret, child, queue: [], turn: null, rest: "", err: "" };
  processes.set(seat, record);

  child.stdout.on("data", (chunk) => {
    record.rest = frames(String(chunk), record.rest, (frame) => {
      if (frame.type === "control_request" && frame.request?.subtype === "can_use_tool") {
        permission(child, frame, asked);
        return;
      }
      if (frame.type === "result" && record.turn !== null) {
        const turn = record.turn;
        record.turn = null;
        turn.resolve(answerIn(frame));
        drain(record);
      }
    });
  });
  child.stderr.on("data", (chunk) => {
    record.err += chunk;
  });
  child.stdin.on("error", () => {});

  let closed = false;
  const gone = (why) => {
    if (closed) {
      return;
    }
    closed = true;
    processes.delete(seat);
    revoke(secret);
    const left = [record.turn, ...record.queue].filter((turn) => turn !== null);
    record.turn = null;
    record.queue = [];
    for (const turn of left) {
      turn.resolve({ ended: true, text: why });
    }
    ended();
  };

  child.on("error", (error) => {
    gone(error.code === "ENOENT" ? "Claude Code is not on the PATH of the process serving this page" : error.message);
  });
  child.on("close", () => {
    gone(record.err.trim() === "" ? `${seat} ended before answering` : record.err.trim());
  });

  return { seat, role, pid: child.pid };
}

// The next frame goes in only when no turn is running.
function drain(record) {
  if (record.turn !== null || record.queue.length === 0) {
    return;
  }
  record.turn = record.queue.shift();
  record.child.stdin.write(
    `${JSON.stringify({ type: "user", message: { role: "user", content: record.turn.frame.text } })}\n`,
  );
}

// Put one frame on one seat's queue.
//
// Answers at once with whether it was taken: `{ delivered: true, answered }` where `answered`
// resolves when that turn ends — with the reply, or with `ended: true` if the process closed
// before it could answer — or `{ refused: "no process" }` when the seat has none, in which case
// nothing is queued. A frame is accepted by provenance and not by shape: a string that reproduces
// a frame byte for byte is refused.
export function tell(seat, frame, { ahead = false } = {}) {
  if (!isFrame(frame)) {
    throw new Error("a session is told frames built by frames.mjs, and nothing else");
  }
  const record = processes.get(seat);
  if (record === undefined) {
    console.log(`no process: ${seat} (${frame.kind})`);
    return { refused: "no process" };
  }
  const answered = new Promise((resolve) => {
    const turn = { frame, resolve };
    if (ahead) {
      record.queue.unshift(turn);
    } else {
      record.queue.push(turn);
    }
  });
  drain(record);
  return { delivered: true, answered };
}

// ------------------------------------------------------------------------------- waiting on each other

// Who each seat's turn is waiting for an answer FROM. A seat runs one turn at a time, so one seat
// is waiting on at most one other, which makes this a map and the walk below a walk rather than
// a search.
const waitingOn = new Map();

// Would waiting for this seat mean waiting for ourselves?
//
// The Leader's turn asks Paul something; Paul's turn, before answering, messages the Leader. The
// Leader cannot take it, because the Leader is holding its own turn open until Paul answers — and
// Paul cannot answer until the Leader takes it. Nothing times out, so that is both sessions
// stopped for good. A message that would close a circle is refused at once instead.
export function wouldWaitForItself(sender, addressee) {
  let ahead = addressee;
  for (let step = 0; step <= waitingOn.size; step += 1) {
    if (ahead === sender) {
      return true;
    }
    const next = waitingOn.get(ahead);
    if (next === undefined) {
      return false;
    }
    ahead = next;
  }
  return false;
}

export async function whileWaitingFor(sender, addressee, wait) {
  waitingOn.set(sender, addressee);
  try {
    return await wait();
  } finally {
    waitingOn.delete(sender);
  }
}

// --------------------------------------------------------------------------------------- ending

const PATIENCE = 2000;

// Every process under this one, read from the process table. Claude Code runs tools in shells of
// its own, and a run that will not go quietly has to be taken down with everything under it.
function descendants(pid) {
  const asked = spawnSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" });
  if (asked.status !== 0 || typeof asked.stdout !== "string") {
    return [];
  }
  const below = new Map();
  for (const line of asked.stdout.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/);
    const one = Number(child);
    const above = Number(parent);
    if (child !== "" && Number.isInteger(one) && Number.isInteger(above)) {
      below.set(above, [...(below.get(above) ?? []), one]);
    }
  }
  const found = [];
  const left = [pid];
  while (left.length > 0) {
    for (const under of below.get(left.pop()) ?? []) {
      found.push(under);
      left.push(under);
    }
  }
  return found;
}

// End a seat's process: close its stdin, which is what ends a run that is between turns, and
// take it down if it is still there once patience has run out. Resolves when the process has
// closed and its secret is gone; false if the seat had no process.
export async function end(seat, patience = PATIENCE) {
  const record = processes.get(seat);
  if (record === undefined) {
    return false;
  }
  const { child } = record;
  const gone = new Promise((resolve) => child.once("close", resolve));
  child.stdin.end();
  const made = setTimeout(() => {
    const under = descendants(child.pid);
    child.kill("SIGKILL");
    for (const pid of under) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, patience);
  await gone;
  clearTimeout(made);
  return true;
}

export function endEvery(patience = PATIENCE) {
  return Promise.all(runningSeats().map((seat) => end(seat, patience)));
}
