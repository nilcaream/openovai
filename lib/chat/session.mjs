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
// A turn is one write of one line, answered by one `result` line. A seat has a queue of frames;
// it is written only when the previous turn has ended, and then the whole of it at once — one
// frame as itself, several inside one queue frame — so a session never has two turns in flight,
// every answer belongs to the writes of its turn, and a seat that was busy reads everything that
// came while it was, together and in order, rather than one turn at a time. The one exception is
// the User's words: they go into the turn under way while one of its calls is out, and that
// turn's `result` answers them too (`joined`).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { environment } from "../claude.mjs";
import { endLeftovers } from "../running.mjs";
import { claudeCommand } from "../runtime.mjs";
import { listening } from "./runtime.mjs";
import { LEADER, WORKER, desks, modelFor, persona, personaFile, readDesk } from "../desks.mjs";
import { ownInstructions } from "../instructions.mjs";
import { isFrame, queueFrame } from "./frames.mjs";
import { log } from "./log.mjs";
import { issue, revoke } from "./secrets.mjs";
import { saw as sawQuota } from "./quota.mjs";

// The one thing a session is handed that says who it is, and the only place it is said: the MCP
// address in the child's arguments refers to this variable rather than carrying the value, so the
// secret is in the process environment and nowhere a wider audience can read it.
export const SECRET_IN_ENVIRONMENT = "OPENOVAI_SESSION_SECRET";

// How long a tool call may take over the MCP connection. The park waits for every Worker to end
// its turn, which Claude Code's own default would give up on.
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

// Everybody who works here: the Leader first, then every desk. Read from desks/ each time it is
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

// Rendered on every start: a process is one conversation, and the persona it opens with is the one
// the instance renders now, and after it the seat's desk as it stands, so a successor starts from
// it without spending a turn reading it. Answers the file.
export const DESK_OPENS = (seat) => `Your desk, desks/${seat}/STATE.md, as it stands at this start:`;

function personaFor(instance, seat) {
  const file = personaFile(instance.root, seat);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = persona(instance.root, seat, instance.config);
  const desk = readDesk(instance.root, seat);
  fs.writeFileSync(file, desk === null ? text : `${text}\n${DESK_OPENS(seat)}\n\n${desk}\n`);
  return { file };
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

// The content blocks of a message frame; a message whose content is a string has none.
function blocksOf(frame) {
  const content = frame.message?.content;
  return Array.isArray(content) ? content.filter((block) => block !== null && typeof block === "object") : [];
}

// The one line a failed call is explained by: the first line with anything on it of what its
// result said — the words of a tool result come as a string or as text blocks — cut to fit a
// tooltip. A result that said nothing explains nothing.
const WHY_WIDTH = 200;

function firstLineOf(content) {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n") : "";
  const line = text.split("\n").map((one) => one.trim()).find((one) => one !== "") ?? "";
  return line.length > WHY_WIDTH ? `${line.slice(0, WHY_WIDTH - 1)}…` : line;
}

// Being asked whether the run may use a tool, and saying. Only tool calls the instance's own
// settings leave undecided ever get here. The request id goes back exactly as it came, nothing
// else about the tool is named beside it, and one request is answered once: get any of that
// wrong and the run hangs for good. Beside the tool and its input, the frame carries the rules
// Claude Code would itself save for "don't ask again" on this call, as `permission_suggestions`
// (measured: a list, one entry per rule, beside a mode and a directory for the session); they
// go along as `suggestions`, for the button permissions.mjs composes when it has nothing of its own.
function permission(child, frame, asked) {
  const suggestions = frame.request.permission_suggestions;
  const request = { id: frame.request_id, tool: frame.request.tool_name, input: frame.request.input, ...(suggestions === undefined ? {} : { suggestions }) };
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
// that failed carries `errors` instead. A turn is silent when it said nothing at all — no text
// block in the whole of it — and not merely when its last words were none.
function answerIn(frame, said) {
  const failed = frame.is_error === true || typeof frame.result !== "string";
  const text =
    typeof frame.result === "string"
      ? frame.result
      : Array.isArray(frame.errors)
        ? frame.errors.join("\n")
        : JSON.stringify(frame);
  return { text, failed, silent: !failed && said === 0 };
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
// closed, with what it was ending as, how the process went (`exit 0`, `SIGKILL`, `ENOENT`) and the
// turns it had not got to — so whoever started the seat can let go of what it was holding for it,
// or hand the turns to a successor. `queue` is turns a
// predecessor left, drained into this process from its first moment. `gate` is asked before every
// write, with the frame about to go in: null lets it through, anything else says why not (a
// window and when it resets); what it holds leaves the queue through `held`, each turn beside
// the answer that held it, for whoever gates to keep and bring back. `changed` is called whenever
// what the server knows about the process changes while it lives — a turn taken, a turn over —
// for whoever shows the process to the page. `called` is called with every tool the process
// itself calls — `{ id, name, input }`, the moment the call is made, and never a call a subagent
// of its makes — `failed` with `{ id, why }` once a call's result comes back as an error, `why`
// being the first line the result said (an exit code, a file that is not there), and then
// `returned` with `{ id }` once a call's result comes back, whatever it says. `said` is
// called with every text the process says, `{ text }`, the moment it is said — one call per text
// block, a block under a parent call being a subagent's and not this process's — so what a
// session says is on its panel as it says it, and not only once its turn is over.
export function start(instance, seat, { asked = nobodyToAsk, ended = nothing, turned = nothing, queue = [], gate = () => null, held = nothing, changed = nothing, called = nothing, returned = nothing, failed = nothing, said = nothing } = {}) {
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
  const child = spawn(claudeCommand(instance.root), args, {
    cwd: instance.root,
    env: { ...environment(instance.root, instance.config.auth, seat), [SECRET_IN_ENVIRONMENT]: secret },
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
    changed,
    // What the lifecycle knows about this process: when it last wrote its desk, what the turn it
    // is on asks of it and since when (an ask is an event that wants a stop for a reason; any
    // later turn is a reprieve and clears it), what it is ending as, when it last turned, what
    // it was told, and what it is at on the turn it is on — the call it has out, by id, and the
    // words its panel says for it.
    deskWrittenAt: null,
    askedAt: null,
    askedWhy: null,
    turnBegan: null,
    ending: null,
    doing: null,
    lastCall: null,
    // How many texts the running turn has said so far: a turn that said none is silent.
    said: 0,
    // The calls of the turn that are out: ids of top-level tool_use blocks not yet back.
    open: new Set(),
    idleSince: now,
    idleTold: 0,
    context: null,
    // The highest context size this session has been told it passed; null until the first one.
    contextTold: null,
    interrupting: null,
    passedClosedGate: new Set(),
    // What the process left running, being ended: set when it closes, awaited by `end`.
    leftovers: null,
  };
  processes.set(seat, record);

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
      // What the process says and does: one assistant frame per content block, a text or a tool
      // call; a frame under a parent call is a subagent's own and is not this process's doing.
      // The result of a call comes back as the user's turn of the protocol, and what is read off
      // it is that the call is back, whether it failed and, then, the first line of what it said.
      if (frame.type === "assistant") {
        if ((frame.parent_tool_use_id ?? null) === null) {
          for (const block of blocksOf(frame)) {
            if (block.type === "tool_use") {
              record.open.add(block.id);
              called({ id: block.id, name: block.name, input: block.input });
              drain(record);
            } else if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
              record.said += 1;
              said({ text: block.text });
            }
          }
        }
        return;
      }
      if (frame.type === "user") {
        for (const block of blocksOf(frame)) {
          if (block.type === "tool_result") {
            record.open.delete(block.tool_use_id);
            // failed before returned: the failed row is one of the call's, and returned is what
            // lets the call go.
            if (block.is_error === true) {
              failed({ id: block.tool_use_id, why: firstLineOf(block.content) });
            }
            returned({ id: block.tool_use_id });
          }
        }
        return;
      }
      if (frame.type === "result" && record.turn !== null) {
        const turn = record.turn;
        const said_ = record.said;
        record.turn = null;
        record.said = 0;
        record.open.clear();
        record.idleSince = clock();
        record.idleTold = 0;
        const context = contextOf(frame.usage);
        if (context !== null) {
          record.context = context;
        }
        changed(record);
        if (record.interrupting !== null) {
          // The turn was interrupted from here; this is its ending, not an answer.
          turn.resolve({ interrupted: true, text: "interrupted" });
          record.interrupting();
          return;
        }
        turn.resolve(answerIn(frame, said_));
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
  const gone = (why, exit) => {
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
    // `context` is what the last result frame of this process measured, carried out with it: the
    // record goes when the process does, and the restart row is written after that.
    ended({ seat, role, ending: record.ending, exit, carried, why, context: record.context });
  };

  // The command was there when it was resolved, a moment ago; gone between that and the spawn is
  // said with what brings it back, the same way it is said before the spawn.
  child.on("error", (error) => {
    gone(error.code === "ENOENT" ? `${error.path} is not there any more: run ${path.join(instance.root, "bin", "ovai")} start, which fetches it` : error.message, error.code ?? error.message);
  });
  child.on("close", (code, signal) => {
    // What the session started and did not end goes with it, whatever ended the session: listed
    // before anybody is told the seat is free, so a successor is never in the list, and awaited
    // by `end`, so a server that is parking is still there to take it down.
    record.leftovers = endLeftovers(instance.root, seat).then((found) => {
      if (found.length > 0) {
        log("leftovers", seat, null, `ended ${found.map(({ pid, command }) => `${command} (pid ${pid})`).join("; ")}`);
      }
    });
    gone(
      record.ending === "restart"
        ? `${seat} restarted`
        : record.err.trim() === ""
          ? `${seat} ended before answering`
          : record.err.trim(),
      signal ?? `exit ${code}`,
    );
  });

  drain(record);
  return { seat, role, pid: child.pid };
}

// Everything waiting goes in as one turn, and only when no turn is running: a queue frame, the
// envelope around every frame waiting, one or more, in arrival order and nothing else, so a seat
// that was busy reads all of what came while it was, at once, and decides for itself. The gate
// is read at the write, for every frame waiting, so a frame queued behind a turn before a window
// closed is held when its turn comes and not written into the closed window; what the gate holds
// leaves the queue in order, each turn keeping its arrival, and what it passes goes in.
//
// Every call with something waiting says in the log what it did with it — wrote, or why not —
// so a seat that stays busy reads there as what it is: one turn open since when, with what
// behind it. Nothing is said when nothing is waiting.
function drain(record) {
  if (record.queue.length === 0) {
    return;
  }
  // A process on its way out takes no new turn: what is queued waits for the successor, or is
  // answered ended when the process closes.
  if (record.turn !== null) {
    if (joined(record)) {
      return;
    }
    log("unwritten", record.seat, null, `turn open since ${new Date(record.turnBegan).toISOString()}, ${record.queue.length} waiting`);
    return;
  }
  if (record.ending !== null) {
    log("unwritten", record.seat, null, `ending=${record.ending}, ${record.queue.length} waiting`);
    return;
  }
  const held = [];
  const passing = [];
  for (const turn of record.queue) {
    const holding = record.gate(turn.frame);
    if (holding === null) {
      passing.push(turn);
    } else {
      held.push({ turn, holding });
    }
  }
  record.queue = [];
  if (held.length > 0) {
    record.held(held);
  }
  if (passing.length === 0) {
    return;
  }
  record.turn = queueOf(passing);
  record.turnBegan = record.clock();
  // What this turn asks of the seat, if it is an ask; a turn that asks nothing is a reprieve, the
  // ask before it is over and the seat is not ended for it. A turn that says nothing either way —
  // an advisory the server delivered — leaves a pending ask exactly as it found it, so the
  // server's own advisory cannot cancel the server's own ending.
  if (record.turn.ask !== undefined) {
    record.askedWhy = record.turn.ask;
    record.askedAt = record.turn.ask === null ? null : record.turnBegan;
  }
  writeFrame(record, record.turn.frame);
  log("wrote", record.seat, null, `${describe(record.turn)}, ${record.queue.length} waiting`);
  record.turn.written();
  record.changed(record);
}

// The User's words do not wait for the turn to end: while a call of the turn is out, the run is
// sure to ask the model again once it is back, and a line written now goes in with that ask. With
// no call out there may be no ask left in the turn, and a line written then is not read in it —
// the run ends the turn without it and starts a turn of its own for it (measured on Claude Code
// 2.1.280), one the server did not open and whose `result` it would not pair with anything. So an
// open call is what makes the write correct, not only quick: without one the frame waits for the
// next call, or for the turn's end. The queue goes in up to and including its last User frame, in
// arrival order, as one queue frame; the turn grows by it and its one `result` answers them all.
// A queue with no User frame in it waits for the turn's end, as ever. Answers whether it wrote.
function joined(record) {
  if (record.open.size === 0 || record.ending !== null || record.interrupting !== null) {
    return false;
  }
  const last = record.queue.findLastIndex((turn) => turn.frame.kind === "user");
  const held = [];
  const passing = [];
  for (const turn of record.queue.slice(0, last + 1)) {
    const holding = record.gate(turn.frame);
    if (holding === null) {
      passing.push(turn);
    } else {
      held.push({ turn, holding });
    }
  }
  if (passing.length === 0) {
    return false;
  }
  record.queue = record.queue.slice(last + 1);
  if (held.length > 0) {
    record.held(held);
  }
  const joining = queueOf(passing);
  record.turn.turns.push(...passing);
  record.turn.last = joining.last;
  if (joining.ask !== undefined) {
    record.askedWhy = joining.ask;
    record.askedAt = joining.ask === null ? null : record.clock();
  }
  writeFrame(record, joining.frame);
  log("wrote", record.seat, null, `${describe(joining)} into the turn open since ${new Date(record.turnBegan).toISOString()}, ${record.queue.length} waiting`);
  joining.written();
  record.changed(record);
  return true;
}

// The frame writer: a frame goes to the process as one stream-json user line.
function writeFrame(record, frame) {
  record.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: frame.text } })}\n`);
}

// The waiting turns as the one turn they go in as: the queue frame around their frames, in the
// order they arrived, with when each arrived — answered as one: every turn in it resolves with
// the same reply and is told written at the same write, and the whole is numbered by the first
// and the last to arrive. What it asks of the seat is what the last frame to arrive that speaks to
// an ask asks: a frame of the User's, a message and an event that asks something all speak, so an
// ask with any of those after it is over and that turn is a reprieve. An event that asks nothing
// speaks to no ask — it is the server talking to a seat it may already be waiting on — and a queue
// of nothing else says nothing either way: `undefined`, which is not `null`.
function queueOf(turns) {
  const speaking = turns.filter((turn) => turn.ask !== null || turn.frame.kind !== "server-event").at(-1);
  return {
    frame: queueFrame(turns.map((turn) => ({ frame: turn.frame, at: turn.at }))),
    turns,
    order: turns[0].order,
    last: turns.at(-1).order,
    ask: speaking === undefined ? undefined : speaking.ask,
    at: turns[0].at,
    resolve: (reply) => turns.forEach((turn) => turn.resolve(reply)),
    written: () => turns.forEach((turn) => turn.written()),
  };
}

// A turn in the log: `queue x1 (#12: user)`, or `queue x3 (#12..#14: message, user, idle event)`.
function describe(turn) {
  const kinds = turn.turns.map((one) => (one.frame.kind === "server-event" ? `${one.frame.event.type} event` : one.frame.kind)).join(", ");
  const numbers = turn.turns.length === 1 ? `#${turn.order}` : `#${turn.order}..#${turn.last}`;
  return `queue x${turn.turns.length} (${numbers}: ${kinds})`;
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
  log("interrupt", seat, null, `written, turn ${describe(turn)}`);
  const written = Date.now();
  let waited = null;
  let heard = false;
  await Promise.race([said.then(() => { heard = true; }), new Promise((resolve) => { waited = setTimeout(resolve, patience); })]);
  clearTimeout(waited);
  record.interrupting = null;
  // Said either way: a run that did not stop is the one the next frame goes into, and the log is
  // the only place that shows.
  log("interrupt", seat, null, heard ? `result in ${Date.now() - written} ms` : `no result after ${patience} ms — seat freed`);
  if (record.turn === turn) {
    record.turn = null;
    turn.resolve({ interrupted: true, text: "interrupted" });
    record.changed(record);
  }
  record.idleSince = record.clock();
  if (thenDrain) {
    drain(record);
  }
  return true;
}

// What waits for a seat, in the order it goes in — all of it at once, as it arrived: each frame's
// kind, who it is from when it is a message, its event type when it is one, and when it was
// told. Empty when nothing waits. For saying, after a stop, what the seat is about to be busy
// with.
export function waiting(seat) {
  const queue = processes.get(seat)?.queue ?? [];
  return queue.map((turn) => ({ kind: turn.frame.kind, from: turn.frame.from, event: turn.frame.event?.type ?? null, at: turn.at }));
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

// A turn the server puts in a seat's queue on its own account, with nobody waiting on the answer:
// what a successor is born holding, beside the turns its predecessor left. The shape `tell` makes,
// without the promise — nothing is going to read the reply, and the frame is numbered like any
// other so it takes its place in arrival order.
export function serverTurn(frame, at) {
  if (!isFrame(frame)) {
    throw new Error("a session is told frames built by frames.mjs, and nothing else");
  }
  return { frame, resolve: nothing, ask: null, written: nothing, order: arrival(), at };
}

// Put one frame on one seat's queue, behind everything waiting: nothing jumps the queue, since
// everything waiting goes in together, in the order it arrived, the moment the seat is free.
//
// Answers at once with whether it was taken: `{ delivered: true, answered }` where `answered`
// resolves when that turn ends — with the reply, or with `ended: true` if the process closed
// before it could answer — or `{ refused: "no process" }` when the seat has none, in which case
// nothing is queued. `ask` names what the frame asks of the seat (a stop, for a reason) when it
// is an event that does. `written` is called once, the moment the frame goes to the process —
// after whatever turn is under way, after whatever the gate holds it for — and never when the
// process ends first; a caller that shows the frame as waiting is told here that it is not. A
// frame is accepted by provenance and not by shape: a string that reproduces a frame byte for
// byte is refused.
export function tell(seat, frame, { ask = null, written = nothing } = {}) {
  if (!isFrame(frame)) {
    throw new Error("a session is told frames built by frames.mjs, and nothing else");
  }
  const record = processes.get(seat);
  if (record === undefined) {
    log("dropped", seat, null, `${frame.kind}, no process`);
    return { refused: "no process" };
  }
  let order;
  const answered = new Promise((resolve) => {
    const turn = { frame, resolve, ask, written, order: arrival(), at: record.clock() };
    order = turn.order;
    record.queue.push(turn);
  });
  log("queued", seat, null, `${frame.kind} #${order}, ${record.queue.length} waiting`);
  drain(record);
  return { delivered: true, answered };
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
  await record.leftovers;
  return true;
}

export function endEvery(patience = PATIENCE) {
  return Promise.all(runningSeats().map((seat) => end(seat, patience)));
}
