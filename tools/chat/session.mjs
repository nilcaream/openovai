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
import { desks, modelFor, persona, readDesk, writeDeskHeader } from "../desks.mjs";
import { LEADER, WORKER, withHardRules } from "../store.mjs";
import { ownInstructions } from "../instructions.mjs";
import { isFrame } from "./frames.mjs";
import { issue, revoke } from "./secrets.mjs";
import { saw as sawQuota } from "./quota.mjs";

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

// How long an interrupted turn is given to say so. Measured 2026-09-12 on claude 2.1.270: the
// control_response came 5 ms after the interrupt and the turn's `result` (subtype
// error_during_execution) 13 ms after it, and the run went on answering the next question. The
// bound is a net over that, not a stopwatch: with or without the result the turn is over when it
// runs out.
export const INTERRUPT_PATIENCE = 2000;

// How long a session that asked to restart or stop is given to end its own turn once its stdin
// is closed, before it is taken down. Long enough for a closing sentence to stream, short enough
// that nothing else gets done — a guess, not a measurement: no real restart has been timed yet.
export const TURN_PATIENCE = 10_000;

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
// one the instance renders now — the persona, after it the hard rules as they stand for this
// seat's role, so a new conversation is told the current numbered set verbatim, and after those
// the seat's desk as it stands, so a successor starts from it without spending a turn reading it.
// Answers the file and the rule-set version the render carried.
export const DESK_OPENS = (seat) => `Your desk, work/${seat}/STATE.md, as it stands at this start:`;

function personaFor(instance, seat) {
  const file = personaFile(instance.root, seat);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { text, version } = withHardRules(persona(instance.root, seat, instance.config), instance.root, roleOf(instance, seat));
  const desk = readDesk(instance.root, seat);
  fs.writeFileSync(file, desk === null ? text : `${text}\n${DESK_OPENS(seat)}\n\n${desk}\n`);
  return { file, version };
}

// How much of the model's context the last request of a turn took: the last iteration's input,
// cached and fresh, as the `usage` on a result frame says it. Null when the frame did not say —
// a refused turn carries `iterations: null`.
export function contextOf(usage) {
  const last = Array.isArray(usage?.iterations) ? usage.iterations.at(-1) : undefined;
  if (last === undefined || last === null) {
    return null;
  }
  return (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0);
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

// The process record of a seat, for whoever runs its lifecycle: what it is ending as, when it
// last turned, what it was asked. Undefined when the seat has no process.
export function recordOf(seat) {
  return processes.get(seat);
}

// Start a seat: one process, one secret, one conversation.
//
// `asked` is called with every permission request the run makes and answers with a decision;
// `turned` after every turn the process ends, with the record; `ended` once, when the process has
// closed, with what it was ending as and the turns it had not got to — so whoever started the seat
// can let go of what it was holding for it, or hand the turns to a successor. `queue` is turns a
// predecessor left, drained into this process from its first moment. `gate` is asked before every
// write, with the frame about to go in: null lets it through, anything else says why not (a
// window and when it resets); what it holds leaves the queue through `held`, each turn beside
// the answer that held it, for whoever gates to keep and bring back.
export function start(instance, seat, { asked = nobodyToAsk, ended = nothing, turned = nothing, queue = [], gate = () => null, held = nothing } = {}) {
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
  const rendered = personaFor(instance, seat);
  args.push("--append-system-prompt-file", rendered.file);

  // --print is load-bearing: it makes this a run rather than a conversation held on a terminal,
  // and it keeps Claude Code from arming its background-shell reaper, which is armed only for a
  // session it judged interactive. Every way this toolkit starts Claude Code is held to that
  // shape by a check in tests/ovai.test.mjs.
  const child = spawn("claude", args, {
    cwd: instance.root,
    env: { ...environment(instance.root, instance.config.auth), [SECRET_IN_ENVIRONMENT]: secret },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const clock = instance.clock ?? Date.now;
  const now = clock();
  const record = {
    seat,
    role,
    secret,
    child,
    queue: [...queue],
    turn: null,
    rest: "",
    err: "",
    root: instance.root,
    model: modelFor(instance.root, seat, instance.config),
    clock,
    startedAt: now,
    gate,
    held,
    // Frames to go in front of the next turn, never as a turn of their own (the hard-rule delta).
    prefix: [],
    // The rule-set version this process was told, at spawn and after every delta delivered.
    rules: rendered.version ?? "none",
    // What the lifecycle knows about this process: when it last wrote its desk, what the turn it
    // is on asks of it and since when (an ask is an event that wants a stop for a reason; any
    // later turn is a reprieve and clears it), what it is ending as, when it last turned and
    // what it was told.
    deskWrittenAt: null,
    askedAt: null,
    askedWhy: null,
    turnBegan: null,
    ending: null,
    idleSince: now,
    idleTold: 0,
    context: null,
    contextFullTold: false,
    interrupting: null,
    passedClosedGate: new Set(),
  };
  processes.set(seat, record);
  // The desk records the rule-set version its process was told (a desk that exists; a header is
  // a desk's and never a way to make one).
  writeDeskHeader(instance.root, seat, { rules: record.rules });

  child.stdout.on("data", (chunk) => {
    record.rest = frames(String(chunk), record.rest, (frame) => {
      if (frame.type === "control_request" && frame.request?.subtype === "can_use_tool") {
        permission(child, frame, asked);
        return;
      }
      if (frame.type === "rate_limit_event") {
        sawQuota(seat, record.model, frame.rate_limit_info);
        return;
      }
      if (frame.type === "result" && record.turn !== null) {
        const turn = record.turn;
        record.turn = null;
        record.idleSince = clock();
        record.idleTold = 0;
        const context = contextOf(frame.usage);
        if (context !== null) {
          record.context = context;
        }
        if (record.interrupting !== null) {
          // The turn was interrupted from here; this is its ending, not an answer.
          turn.resolve({ interrupted: true, text: "interrupted" });
          record.interrupting();
          return;
        }
        turn.resolve(answerIn(frame));
        turned(record);
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
    // A process ending to restart hands the turns it had not got to on to its successor, which
    // whoever started this one spawns; any other ending answers them ended. The turn that was
    // running is answered ended either way: its process is gone.
    const carried = record.ending === "restart" ? record.queue : [];
    const left = [record.turn, ...(record.ending === "restart" ? [] : record.queue)].filter((turn) => turn !== null);
    record.turn = null;
    record.queue = [];
    if (record.interrupting !== null) {
      record.interrupting();
    }
    for (const turn of left) {
      turn.resolve({ ended: true, text: why });
    }
    ended({ seat, role, ending: record.ending, carried, why });
  };

  child.on("error", (error) => {
    gone(error.code === "ENOENT" ? "Claude Code is not on the PATH of the process serving this page" : error.message);
  });
  child.on("close", () => {
    gone(
      record.ending === "restart"
        ? `${seat} restarted`
        : record.err.trim() === ""
          ? `${seat} ended before answering`
          : record.err.trim(),
    );
  });

  drain(record);
  return { seat, role, pid: child.pid };
}

// The next frame goes in only when no turn is running, and only when the gate lets it: the gate
// is read at the write, so a frame queued behind a turn before a window closed is held when its
// turn comes and not written into the closed window. What the gate holds leaves the queue in
// order, each turn keeping its arrival, and a frame the gate passes goes in ahead of them.
// Whatever was waiting to go in front of the write — a hard-rule delta — goes in the same write,
// one line, frames only, and the desk header says which set this process has now been told.
function drain(record) {
  // A process on its way out takes no new turn: what is queued waits for the successor, or is
  // answered ended when the process closes.
  if (record.turn !== null || record.queue.length === 0 || record.ending !== null) {
    return;
  }
  const held = [];
  while (record.queue.length > 0) {
    const holding = record.gate(record.queue[0].frame);
    if (holding === null) {
      break;
    }
    held.push({ turn: record.queue.shift(), holding });
  }
  if (held.length > 0) {
    record.held(held);
  }
  if (record.queue.length === 0) {
    return;
  }
  record.turn = record.queue.shift();
  record.turnBegan = record.clock();
  // What this turn asks of the seat, if it is an ask. Any other turn is a reprieve: the ask
  // before it is over, and the seat is not ended for it.
  record.askedWhy = record.turn.ask;
  record.askedAt = record.turn.ask === null ? null : record.turnBegan;
  const prefix = record.prefix;
  record.prefix = [];
  const content = [...prefix.map((entry) => entry.frame), record.turn.frame].map((frame) => frame.text).join("\n");
  record.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
  if (prefix.length > 0) {
    record.rules = prefix.at(-1).version;
    writeDeskHeader(record.root, record.seat, { rules: record.rules });
  }
}

// Put a frame in front of a seat's next turn, never as a turn of its own. It is written with the
// next frame the seat is told; if the process ends first, it dies with it — the successor gets
// the whole set at spawn.
export function prefix(seat, frame, version) {
  if (!isFrame(frame)) {
    throw new Error("a session is told frames built by frames.mjs, and nothing else");
  }
  const record = processes.get(seat);
  if (record === undefined) {
    return false;
  }
  record.prefix.push({ frame, version });
  return true;
}

// Cancel the turn a seat is on, and wait — up to `patience` — for the run to say the turn is over.
// With or without that word the turn is answered `interrupted` and the seat is free for the next
// frame; the queue is drained again unless the caller is about to put something in front of it.
// False when no turn was running.
export async function interrupt(seat, { patience = INTERRUPT_PATIENCE, thenDrain = true } = {}) {
  const record = processes.get(seat);
  if (record === undefined || record.turn === null || record.interrupting !== null) {
    return false;
  }
  const turn = record.turn;
  let acknowledged;
  const said = new Promise((resolve) => {
    acknowledged = resolve;
  });
  record.interrupting = acknowledged;
  record.child.stdin.write(
    `${JSON.stringify({ type: "control_request", request_id: `interrupt-${Date.now()}`, request: { subtype: "interrupt" } })}\n`,
  );
  let waited = null;
  await Promise.race([said, new Promise((resolve) => { waited = setTimeout(resolve, patience); })]);
  clearTimeout(waited);
  record.interrupting = null;
  if (record.turn === turn) {
    record.turn = null;
    turn.resolve({ interrupted: true, text: "interrupted" });
  }
  record.idleSince = record.clock();
  if (thenDrain) {
    drain(record);
  }
  return true;
}

// Write whatever is next for a seat, if nothing is running: for after an interrupt that was told
// not to.
export function resume(seat) {
  const record = processes.get(seat);
  if (record !== undefined) {
    drain(record);
  }
}

// Every frame told to any seat is numbered as it arrives, so what is held and brought back later
// comes back in the order it was told, whichever seat it was told to.
let arrivals = 0;

export function arrival() {
  arrivals += 1;
  return arrivals;
}

// Put one frame on one seat's queue.
//
// Answers at once with whether it was taken: `{ delivered: true, answered }` where `answered`
// resolves when that turn ends — with the reply, or with `ended: true` if the process closed
// before it could answer — or `{ refused: "no process" }` when the seat has none, in which case
// nothing is queued. `ask` names what the frame asks of the seat (a stop, for a reason) when it
// is an event that does. A frame is accepted by provenance and not by shape: a string that
// reproduces a frame byte for byte is refused.
export function tell(seat, frame, { ahead = false, ask = null } = {}) {
  if (!isFrame(frame)) {
    throw new Error("a session is told frames built by frames.mjs, and nothing else");
  }
  const record = processes.get(seat);
  if (record === undefined) {
    console.log(`no process: ${seat} (${frame.kind})`);
    return { refused: "no process" };
  }
  const answered = new Promise((resolve) => {
    const turn = { frame, resolve, ahead, ask, order: arrival() };
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
