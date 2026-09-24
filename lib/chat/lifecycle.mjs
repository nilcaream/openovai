// The lifecycle: how a seat's process is started, what the server says to it on its own account,
// and how it is ended.
//
// Three kinds of act exist in this server, and each feature below names its own: a write to a
// session's stdin (only session.mjs, one frame per turn), a tool call (over the MCP door, run by server.mjs), and a
// process act (start, end, an interrupt). Everything the server hands into a session is a frame
// built by frames.mjs, delivered through `deliver` here — the gate in front of every write, then
// the one spawn the server makes on its own (the Leader, by anything addressed to it), then the
// write. Nothing in the server reads a session's reply text to run any of this: the event frames
// in and the tool calls out are the whole protocol, and the clocks below handle a session that
// calls neither.
//
// The Leader is one permanent seat, started by whatever is addressed to it — a page message, a
// message from a Worker, a server event, the idle FYIs included. Workers are started only by the
// Leader's `hire` and by their own `restart_session`, both through `startSeat` here; a message to a
// stopped Worker is refused, never a spawn.

import { forget, recorded } from "../admin.mjs";
import { LEADER, WORKER, deskHeader, modelFor } from "../desks.mjs";
import { RuntimeError } from "../runtime.mjs";
import { SERVER, amend, append } from "./conversation.mjs";
import { publish } from "./events.mjs";
import { serverEvent } from "./frames.mjs";
import * as log from "./log.mjs";
import { giveUp, park as parkRequest, rulesPending, waitedLong } from "./permissions.mjs";
import * as quota from "./quota.mjs";
import { line } from "./lines.mjs";
import { arrival, end, interrupt, recordOf, roleOf, running, runningSeats, seats, serverTurn, start, tell } from "./session.mjs";

// ------------------------------------------------------------------------------------ settings

// Minutes idle at which the Leader is told about a Worker (fyi), and at which any seat is told to
// write its desk and stop (force); the context sizes in tokens — the size a session is first told
// it has passed, the step it is told again at, and the size from which it is told to wrap up; the
// park deadline the `park` tool uses when its caller gives none, and the one a server stop uses,
// both in seconds; and the minutes a Worker may wait on a permission button before the Leader is
// told.
export const DEFAULTS = Object.freeze({
  idle: { fyi: [10, 50], force: 55 },
  context: { warning: 200_000, step: 20_000, error: 300_000 },
  park: { deadline: 30 * 60, timeout: 20 },
  permission: { wait: 10 },
});

export function settingsIn(config) {
  const own = config ?? {};
  const fyi = Array.isArray(own.idle?.fyi) && own.idle.fyi.length === 2 ? own.idle.fyi : DEFAULTS.idle.fyi;
  return {
    idle: { fyi: [...fyi], force: typeof own.idle?.force === "number" ? own.idle.force : DEFAULTS.idle.force },
    context: {
      warning: typeof own.context?.warning === "number" ? own.context.warning : DEFAULTS.context.warning,
      step: typeof own.context?.step === "number" ? own.context.step : DEFAULTS.context.step,
      error: typeof own.context?.error === "number" ? own.context.error : DEFAULTS.context.error,
    },
    park: {
      deadline: typeof own.park?.deadline === "number" ? own.park.deadline : DEFAULTS.park.deadline,
      timeout: typeof own.park?.timeout === "number" ? own.park.timeout : DEFAULTS.park.timeout,
    },
    permission: { wait: typeof own.permission?.wait === "number" ? own.permission.wait : DEFAULTS.permission.wait },
  };
}

// When a session goes cold: the life of its prompt cache, in minutes. The 50-minute FYI says how
// long is left against this.
export const COLD_AT = 60;

// Minutes after the critical idle event before a seat that has not stopped itself is ended.
export const IDLE_GRACE = 5;

// How often the clocks are read.
const TICK = 60_000;

// How often a park looks at who has stopped.
const PARK_POLL = 200;

// What the server says, per (type, stage): fixed strings, never composed from anything a session
// wrote, and neutralised on the way into the frame anyway.
export const BODY_CONTEXT_WARNING =
  "This is how much of your context you have used; the size you wrap up at is in this event. Nothing is ended for you: carry on, keep your desk current with write_desk, and plan your own restart for a moment that suits the work. You are told again at every step from here.";
export const BODY_CONTEXT_ERROR =
  "Your context is past the size you wrap up at. Finish what is in your hands, write your desk with write_desk, then call restart_session; your successor starts from the desk.";
export const BODY_CRITICAL =
  "The server interrupted your turn for this reason. Do not resume, do not investigate: write your desk with write_desk and call stop_session now.";
export const BODY_CRITICAL_LEADER =
  "The window is exhausted: your further turns are held until it resets. Write your desk with write_desk.";
export const BODY_IDLE = (force) =>
  `You have been idle ${force} minutes and go cold at ${COLD_AT}. Write your desk with write_desk and call stop_session.`;
export const BODY_PARK =
  "The server interrupted your turn: the room is parking. Do not resume: write your desk with write_desk and call stop_session within the deadline.";
// The one body composed from anything: the names of the files that changed, which `ovai claude`
// wrote down and no session did. They are file names from a closed list and nothing a model said.
export const BODY_ADMIN_CLOSED = (changed) =>
  `Admin mode was open on this instance — a person at a terminal, using Claude Code's own commands against this instance's configuration — and it has closed. ${changed.length === 0 ? "None of the configuration files this instance watches changed." : `These changed: ${changed.join(", ")}.`} That is the whole of what is known: not what is in them, and not what it means. Every seat started from now on reads them as they are, so read the ones that matter before you hand work out — a permission rule that moved changes what a Worker may do.`;
export const BODY_RESTARTED =
  "You are the session after a restart on this desk, and this is your first turn. Your desk is the whole of what the session before you left: its conversation is gone and cannot be asked for. Read the desk, go on from what it says to do next, and never redo what it says is done. Do not announce the restart — finish the work and report as that work asks. With nothing left in flight, say nothing and do nothing.";

function clockOf(instance) {
  return instance.clock ?? Date.now;
}

// The row that says when: one on the panel when a session starts and one when it ends, whatever
// started or ended it, so a panel kept across a stop shows where the break was and how long it
// lasted. The moment and nothing else — which of the two it is, its place says. Both are always
// written; the page draws only the first of two less than a minute apart (render.mjs).
function stampRow(instance, seat) {
  const now = new Date(clockOf(instance)());
  append(instance.root, seat, { at: now.toISOString(), from: SERVER, stamp: true, text: log.wallClock(now) });
}

function leaderOf(instance) {
  return instance.config.leader;
}

// ------------------------------------------------------------------------------- what a seat is

// The header, idle time and context of a seat, for the room and the page: what the server knows
// about a desk and its process, beside who it is. `busy` is whether a turn is running — the one
// thing the page's stop glyph needs to know; `doing`, there while the Leader is on a turn, is
// what it is at (below).
export function aboutSeat(instance, seat) {
  const header = deskHeader(instance.root, seat.name);
  const record = recordOf(seat.name);
  const idle = idleOf(seat.name, clockOf(instance)());
  return {
    ...seat,
    running: running(seat.name),
    busy: record !== undefined && record.turn !== null,
    title: header?.title ?? "",
    status: header?.status ?? "",
    ...(record === undefined ? {} : { idle, context: record.context, ending: record.ending }),
    ...(record === undefined || record.doing === null ? {} : { doing: record.doing }),
  };
}

// The page is told about a seat whenever what the server knows about it changes: its process
// started or gone, a turn taken or over, what it is at on the turn. One event, the same object
// the snapshot lists.
function seatChanged(instance, name) {
  const seat = seats(instance).find((one) => one.name === name);
  if (seat !== undefined) {
    publish("seat", aboutSeat(instance, seat));
  }
}

// ------------------------------------------------------------------------------ starting a seat

// A call as the log names it: the tool, and the command or the path it was given when it was
// given one — whole, since the log is where somebody goes to see exactly what was asked.
function named(tool, input) {
  if (typeof input?.command === "string") {
    return `${tool}: ${input.command}`;
  }
  if (typeof input?.file_path === "string") {
    return `${tool} ${input.file_path}`;
  }
  return tool;
}

// How a session's permission requests reach the page: parked on its panel, and the desktop told
// — the tool and the command, the session's own words on one line; the reason it gave is on the
// panel, not on a toast. The wait is written down at both ends: the log says what was asked and,
// once it is answered, what the answer was and how long it took; the panel gets one line of the
// chat's with the wait, since a card that was answered leaves no row of its own and a turn that
// stood still for minutes would otherwise read as a run that took that long. The row is there to
// explain a gap, so a card answered inside ten seconds draws none: the log still has both ends.
const WAIT_SAID_FROM = 10;
function asking(instance, seat) {
  return (request) => {
    const clock = clockOf(instance);
    const began = clock();
    const waiting = parkRequest(seat, request, began);
    const what = named(request.tool, request.input);
    log.log("asked", seat, null, what);
    waiting.then((decision) => {
      const seconds = Math.round((clock() - began) / 1000);
      log.log("answered", seat, null, `${decision.behavior} after ${seconds} s`);
      if (seconds >= WAIT_SAID_FROM) append(instance.root, seat, { from: SERVER, text: `waited ${seconds} s for permission: ${what}` });
    });
    // No row for the call itself here: a Worker's was drawn when it was made, and the Leader's
    // calls have no rows at all — the tool line says this one while the card stands, and the
    // wait row names it once answered. A row would stay on the panel after the turn.
    return waiting;
  };
}

// The rule requests a seat has raised through the `permission` tool reach the page once the turn
// that raised them has ended — the reply lands on the panel before its dialogs. Called after every
// turn, and by the tool itself for a seat that is not on one.
export function showRules(instance, seat) {
  const record = recordOf(seat);
  if (record !== undefined && record.turn !== null) {
    return;
  }
  // A rule dialog is listed only off a turn: what the page shows for this seat changed with the
  // turn's end when any is pending.
  if (rulesPending(seat).length > 0) {
    publish("asking", { seat });
  }
}

// The one place a seat's process is started. `queue` is what a predecessor left for it. The gate
// is the process's own, read by session.mjs at every write; what it holds goes on the held list.
export function startSeat(instance, seat, { queue = [] } = {}) {
  const started = start(instance, seat, {
    asked: asking(instance, seat),
    turned: (record) => turned(instance, record),
    // What a seat says is a row on its panel the moment it is said. A Worker's calls are drawn
    // there too, as lines, one per call, marked once the call failed; the Leader's own calls
    // are not — its panel is the User's conversation — only the one it is at, said by the seat
    // while the turn runs (doingBy), and gone with the turn.
    // Every seat's calls go to the log, the Leader's included: a turn that stood still is read
    // there, by what it was calling.
    said: ({ text }) => append(instance.root, seat, { from: seat, text }),
    called: logged(instance, seat, roleOf(instance, seat) === WORKER ? calledBy(instance, seat) : doingBy(instance, seat)),
    returned: backFrom(seat, roleOf(instance, seat) === WORKER ? () => {} : returnedBy(instance, seat)),
    failed: ({ id, why }) => {
      log.failed(seat, { id, why });
      if (roleOf(instance, seat) === WORKER) {
        amend(instance.root, seat, id, why);
      }
    },
    // The row that says the seat is gone names what it was ending as — the one word the record
    // holds, stop, restart, idle, park, idle-forced, park-deadline — and, for a process that ended
    // on its own, how: its exit code or signal.
    ended: (closed) => {
      log.ended(seat, closed.ending ?? closed.exit);
      stampRow(instance, seat);
      giveUp(seat);
      afterClose(instance, closed);
    },
    queue,
    gate: (frame) => gateOn(instance, seat, frame),
    held: (entries) => {
      for (const { turn, holding } of entries) {
        holdTurn(instance, seat, turn, holding);
      }
    },
    changed: (record) => {
      if (roleOf(instance, seat) !== WORKER) {
        atTurn(record);
      }
      seatChanged(instance, seat);
    },
  });
  stampRow(instance, seat);
  seatChanged(instance, seat);
  return started;
}

// What the Leader is at, for its panel, while it is on a turn — kept on its record and told to
// the page as the seat, never written to its conversation, since it is what is happening and not
// what was said: "Thinking…" from the turn's start; the call it has out, worded as a Worker's
// line would be, from the moment it is made (a call the summary says nothing about leaves the
// words as they were); "Thinking…" again from the moment that call's result is back until the
// next call; nothing once the turn is over, however it ended. A page opened mid-turn draws it
// from the snapshot, which lists the same object. A Worker's panel draws its calls as rows and
// has no such word.
const THINKING = "Thinking…";

function atTurn(record) {
  if (record.turn === null) {
    record.doing = null;
    record.lastCall = null;
  } else if (record.doing === null) {
    record.doing = THINKING;
  }
}

function doingBy(instance, seat) {
  return ({ id, name, input }) => {
    const record = recordOf(seat);
    if (record === undefined) {
      return;
    }
    record.lastCall = id;
    const text = line(name, input);
    if (text !== null) {
      record.doing = text;
      seatChanged(instance, seat);
    }
  };
}

function returnedBy(instance, seat) {
  return ({ id }) => {
    const record = recordOf(seat);
    if (record !== undefined && record.lastCall === id && record.doing !== THINKING) {
      record.doing = THINKING;
      seatChanged(instance, seat);
    }
  };
}

// One line per call on the caller's own conversation, written the moment the call is made; a
// call the summary says nothing about writes nothing.
function calledBy(instance, seat) {
  return ({ id, name, input }) => {
    const text = line(name, input);
    if (text !== null) {
      append(instance.root, seat, { from: seat, line: text, call: id });
    }
  };
}

// A call in the log, whatever else is done with it — and its coming back told to the log, which
// is keeping the call until then.
function logged(instance, seat, then) {
  return (call) => {
    log.called(seat, { id: call.id, name: call.name, what: named(call.name, call.input) });
    then(call);
  };
}

function backFrom(seat, then) {
  return (back) => {
    log.returned(back.id);
    then(back);
  };
}

// A session is only ever moved by a frame, and a restart is the one start with nobody standing
// over it to write one: a hired Worker turns because the Leader speaks to it, a Leader turns
// because something was addressed to it, and a successor has neither. So the server says the one
// thing it knows — that this is a session after a restart and its desk is where the work is —
// and the successor's first turn is that frame. Behind whatever the predecessor left, newest
// last as every queue is, so the carried turns keep the order they arrived in and go in with it
// as one turn.
function startSuccessor(instance, seat, carried, context) {
  try {
    const born = serverTurn(serverEvent("restarted", {}, BODY_RESTARTED), clockOf(instance)());
    startSeat(instance, seat, { queue: [...carried, born] });
    // How full the session that restarted was, so "it filled up" is a number somebody can check
    // afterwards. It is what the predecessor's last result frame measured and nothing worked out
    // here; a session that restarted before a turn of its own came back has no reading, and the
    // row says that rather than carrying a zero.
    log.log("restart", seat, null, context === null ? "successor started, no context measured" : `successor started, ${context} tokens of context`);
  } catch (error) {
    log.log("restart", seat, null, `no successor: ${error.message}`);
    for (const turn of carried) {
      turn.resolve({ ended: true, text: `${seat} could not be restarted: ${error.message}` });
    }
  }
}

// What follows a process closing: the page told; a successor for one that was restarting, with
// the turns it left — unless the window that would hold its first write is exhausted, in which
// case there is no successor: a panel is a process, and a process that could not work until a
// window resets, minutes or hours away, is not kept for it. The restart is a stop then: the turns
// it carried are answered so, and the Leader is told the way it is told of every stop of a
// Worker — through the gate, so it hears it once the window has reset and decides whether to
// hire again; a Leader whose own successor would be held is simply not running, and the next
// thing addressed to it starts it after the reset. And, after every idle stop of a Worker, the
// FYI to the Leader.
//
// A Leader whose process is gone for good — it stopped itself, was stopped with the instance, or
// died — leaves one row on its panel saying so, between what that session said and what the next
// one will: the next thing typed there starts a fresh session, with nothing of this one's context.
function afterClose(instance, { seat, role, ending, carried, context = null }) {
  seatChanged(instance, seat);
  if (role === LEADER && ending !== "restart") {
    append(instance.root, seat, { from: SERVER, divider: true, text: hasLeft(seat) });
  }
  if (ending === "restart") {
    const holding = quota.mayStart(modelFor(instance.root, seat, instance.config));
    if (holding === null) {
      startSuccessor(instance, seat, carried, context);
      return;
    }
    log.log("restart", seat, null, `no successor: stopped, ${holding.window} exhausted until ${holding.resets}`);
    for (const turn of carried) {
      turn.resolve({ ended: true, text: `${seat} stopped: the ${holding.window} window is exhausted, reset at ${quota.hhmm(holding.resets)}` });
    }
    if (role === WORKER) {
      deliver(instance, leaderOf(instance), serverEvent("stopped", { who: seat, why: "quota" }));
    }
    return;
  }
  if (role === WORKER && (ending === "idle" || ending === "idle-forced")) {
    deliver(instance, leaderOf(instance), serverEvent("stopped", { who: seat, why: ending }));
  }
}

// The instance is stopping: the page is told, and every page route answers 503 from here on
// (server.mjs) while the tool route stays open for the desks and stops the park takes.
// The words of that row.
export function hasLeft(seat) {
  return `${seat} has left — the next message starts a fresh session`;
}

export function stopping(instance) {
  instance.stopping = true;
  publish("stopping", {});
}

// --------------------------------------------------------------------------------- delivering

// Which events go through a closed gate: the ones that make a seat write its desk and stop, once
// each per process. Nothing else does.
function passesAClosedGate(frame) {
  const event = frame.event;
  if (event === null) {
    return false;
  }
  return event.type === "park" || ((event.type === "quota-low" || event.type === "idle") && event.attrs.stage === "critical");
}

// The gate a process reads at every write: the frame passes when it is one of the events that
// pass a closed gate and this process has not had that one yet; anything else is held while the
// seat's model window is at the second stage or rejected.
function gateOn(instance, seat, frame) {
  const record = recordOf(seat);
  if (record !== undefined && passesAClosedGate(frame) && !record.passedClosedGate.has(frame.event.type)) {
    record.passedClosedGate.add(frame.event.type);
    return null;
  }
  return quota.mayWrite(seat, modelFor(instance.root, seat, instance.config));
}

// A frame held by the quota gate, said on the panel: once, with when the window resets and what
// is waiting for it — the User's own line unless said otherwise.
export function heldLine({ window, resets }, what = "your message") {
  return `limit exhausted (${window} window), reset at ${quota.hhmm(resets)}, ${what} is waiting`;
}

// What a held frame is, for the panel: the User's line, a seat's message, an event of the chat's.
function whatWaits(frame) {
  return frame.kind === "message" ? `the message from ${frame.from}` : frame.kind === "server-event" ? `a ${frame.event.type} event` : "your message";
}

// One turn the gate held, on the held list with the arrival it was told with. Said on the seat's
// panel here, where every hold passes — the one at the write as much as the one at the door — so
// a frame queued while the window was still open and held when its turn came is said too, and a
// seat that stops answering reads as held rather than as busy or ignoring.
function holdTurn(instance, seat, turn, holding) {
  quota.hold(seat, { frame: turn.frame, ask: turn.ask, resolve: turn.resolve, written: turn.written, window: holding.window, order: turn.order });
  log.log("held", seat, null, `${turn.frame.kind} until ${holding.window} resets ${holding.resets}`);
  append(instance.root, seat, { from: SERVER, text: heldLine(holding, whatWaits(turn.frame)) });
}

// Everything the server hands into a session goes through here, in this order: the Leader's spawn
// when it is the Leader and it is not running — gated, so a stopped Leader is started when the
// hold drains, never before, and the gate never pays an initial prompt at the stage it exists to
// stop — then the queue, where the process's own gate is read at the write itself. A held frame
// is kept per seat until its window resets; nothing is spawned for it.
//
// Answers `{ delivered: true, answered }` (the turn's reply, as `tell` does), `{ refused }` when
// the seat has no process and is not the Leader, or `{ delivered: false, held: { window, resets },
// answered }` when the gate is closed to the frame now — `answered` resolving when the frame is
// eventually written and answered. `ask` names what an event asks of the seat, for the clocks;
// `written` is called the moment the frame goes to the process, as `tell` says, however long the
// gate held it first.
// Admin mode ran while this server was not running, and the Leader is told at the start that
// follows it — the one moment the configuration a person changed begins to reach the seats. Only
// the Leader: it is the one that decides what the change costs the work, and a Worker told the
// same thing has nothing to do with it. Nothing is asked of it; there is no `ask` here, so a seat
// that owes the server an answer still owes it.
//
// The record is removed when the frame has really reached the Leader's process — `written`, which
// is called however long the quota gate held it — and never before: a notice lost is lost for
// ever, and a notice repeated is only repeated. Answers whether there was one to pass on.
export function adminTold(instance) {
  const left = recorded(instance.root);
  if (left === null) {
    return false;
  }
  const frame = serverEvent("admin-closed", { ended: left.ended, changed: String(left.changed.length) }, BODY_ADMIN_CLOSED(left.changed));
  return deliver(instance, leaderOf(instance), frame, { written: () => forget(instance.root) }).refused === undefined;
}

export function deliver(instance, seat, frame, { ask = null, written = () => {} } = {}) {
  const holding = passesAClosedGate(frame) ? null : quota.mayWrite(seat, modelFor(instance.root, seat, instance.config));
  if (!running(seat)) {
    if (seat !== leaderOf(instance)) {
      // A Worker with no process refuses the frame: nothing is written, so nothing is said.
      return tell(seat, frame, { ask });
    }
    if (holding !== null) {
      let resolve;
      const answered = new Promise((done) => {
        resolve = done;
      });
      holdTurn(instance, seat, { frame, ask, resolve, written, order: arrival() }, holding);
      return { delivered: false, held: holding, answered };
    }
    // The claude the instance runs on is not there: the frame is refused with the sentence that
    // says what fetches it, and nothing is spawned.
    try {
      startSeat(instance, seat);
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      return { refused: error.message };
    }
  }
  const told = tell(seat, frame, { ask, written });
  return holding === null || told.refused !== undefined ? told : { delivered: false, held: holding, answered: told.answered };
}

// The held frames whose window has reset, written now: the Leader's first, then the Workers',
// each in arrival order — the server decides what resumes and in what order.
export function releaseHeld(instance) {
  const leader = leaderOf(instance);
  const released = quota.releasedBy();
  const ordered = [...released.filter((entry) => entry.seat === leader), ...released.filter((entry) => entry.seat !== leader)];
  for (const entry of ordered) {
    log.log("released", entry.seat, null, entry.frame.kind);
    const told = deliver(instance, entry.seat, entry.frame, { ask: entry.ask, written: entry.written });
    if (told.refused !== undefined) {
      entry.resolve({ ended: true, text: `${entry.seat} has no process` });
    } else {
      told.answered.then(entry.resolve);
    }
  }
  return ordered.length;
}

// ------------------------------------------------------------------------------ the quota stages

// Stage one: every running seat the window applies to is told, and nobody is interrupted. Stage
// two: every running Worker the window applies to is interrupted and then told, with the body
// that says so; the Leader is told once and not interrupted — its turns are held by the gate
// from here. Told, on a busy seat, means in the queue that goes in whole when its turn ends.
export async function stageReached(instance, window, stage, resets, model) {
  const leader = leaderOf(instance);
  const attrs = { stage, window, resets, ...(model === null ? {} : { model }) };
  const seats = runningSeats().filter((seat) => quota.appliesTo(recordOf(seat)?.model, window));
  if (stage === quota.WARNING) {
    for (const seat of seats) {
      deliver(instance, seat, serverEvent("quota-low", attrs));
    }
    return;
  }
  await Promise.all(
    seats.map(async (seat) => {
      const record = recordOf(seat);
      if (record === undefined) {
        return;
      }
      if (seat === leader) {
        deliver(instance, seat, serverEvent("quota-low", attrs, BODY_CRITICAL_LEADER));
        return;
      }
      await interrupt(seat, { thenDrain: false });
      deliver(instance, seat, serverEvent("quota-low", { ...attrs, interrupted: "true" }, BODY_CRITICAL), { ask: "stop" });
    }),
  );
}

// -------------------------------------------------------------------------------------- context

// The sizes a session is told about: the warning, every step above it, and the error size, which
// is a size of its own even when no step lands on it. Null below the warning, and the highest one
// passed when a turn passed several — a session that jumps four steps at once is told once, for
// where it is now, and not four times for where it has been.
function contextPassed(context, { warning, step, error }) {
  if (context === null || context < warning) {
    return null;
  }
  const stepped = step > 0 ? warning + Math.floor((context - warning) / step) * step : warning;
  return context >= error ? Math.max(stepped, error) : stepped;
}

// After every turn: the rule dialogs the turn raised, shown now that its reply is on the panel;
// and, with whatever is queued, the size the last request passed — once per size, never again for
// one already told. The stepping carries on above the error size; what changes there is the
// instruction inside the event and the ask it carries, never the delivery. Nothing is enforced at
// any size: the session decides when it restarts.
function turned(instance, record) {
  showRules(instance, record.seat);
  const { context } = settingsIn(instance.config);
  const passed = contextPassed(record.context, context);
  if (passed === null || (record.contextTold !== null && passed <= record.contextTold)) {
    return;
  }
  record.contextTold = passed;
  const stage = passed >= context.error ? "error" : "warning";
  deliver(
    instance,
    record.seat,
    serverEvent(
      "context",
      { stage, context: String(record.context), warning: String(context.warning), step: String(context.step), error: String(context.error) },
      stage === "error" ? BODY_CONTEXT_ERROR : BODY_CONTEXT_WARNING,
    ),
    stage === "error" ? { ask: "stop" } : {},
  );
}

// ---------------------------------------------------------------------------------------- idle

// Minutes since a seat last turned; null while it is on a turn — a seat working is not idle,
// however long the turn.
export function idleOf(seat, now) {
  const record = recordOf(seat);
  if (record === undefined || record.turn !== null) {
    return null;
  }
  return Math.floor((now - record.idleSince) / 60_000);
}

// One reading of the clocks: the held frames whose window reset, every seat's idle time, and
// every call stop that has waited long.
export function tick(instance) {
  releaseHeld(instance);
  const now = clockOf(instance)();
  const { idle, permission } = settingsIn(instance.config);
  const leader = leaderOf(instance);
  // A stop is inside a turn, so no idle clock sees it: this is its own clock, from the park time.
  // Once per stop, the call as made and never the reason (one line on the Leader's turn). Not for
  // the Leader's own stops: the Leader is who would be told, and it is stopped.
  for (const { seat, request } of waitedLong(now, permission.wait)) {
    if (seat === leader) {
      continue;
    }
    const call = request.input?.command ?? request.input?.file_path ?? "";
    deliver(instance, leader, serverEvent("permission", { who: seat, minutes: String(permission.wait) }, `${request.tool}: ${call}`));
  }
  for (const seat of runningSeats()) {
    const record = recordOf(seat);
    if (record.ending !== null) {
      continue;
    }
    // Asked to stop for idling and still here when the grace ran out: ended, with the desk as it
    // was last written. Measured from the ask, not from the idle clock — the ask is a turn and
    // a turn resets that clock. Never while it is on a turn: the ask's own turn runs to its end
    // (a permission it is waiting on included), and any later turn has cleared the ask.
    if (record.askedWhy === "idle" && record.turn === null && now - record.askedAt >= IDLE_GRACE * 60_000) {
      record.ending = "idle-forced";
      end(seat);
      continue;
    }
    const minutes = idleOf(seat, now);
    if (minutes === null || record.idleTold >= idle.force) {
      continue;
    }
    if (seat !== leader && minutes >= idle.fyi[0] && record.idleTold < idle.fyi[0]) {
      record.idleTold = idle.fyi[0];
      deliver(instance, leader, serverEvent("idle", { who: seat, minutes: String(idle.fyi[0]) }));
    }
    if (seat !== leader && minutes >= idle.fyi[1] && record.idleTold < idle.fyi[1]) {
      record.idleTold = idle.fyi[1];
      deliver(
        instance,
        leader,
        serverEvent("idle", {
          who: seat,
          minutes: String(idle.fyi[1]),
          "cold-in": String(COLD_AT - idle.fyi[1]),
          context: String(record.context ?? 0),
        }),
      );
    }
    if (minutes >= idle.force) {
      record.idleTold = idle.force;
      deliver(instance, seat, serverEvent("idle", { stage: "critical", minutes: String(idle.force) }, BODY_IDLE(idle.force)), { ask: "idle" });
    }
  }
}

// ---------------------------------------------------------------------------------------- park

let parking = false;

export function isParking() {
  return parking;
}

function hhmm(at) {
  if (at === null || at === undefined) {
    return "no desk written";
  }
  const when = new Date(at);
  return `desk ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
}

// Park the room: every running Worker — and the Leader too when asked, which a server stop does —
// is interrupted when asked and told the park event, with its queue; then this waits until
// every session told has called stop_session or the deadline (seconds; the instance's
// `park.deadline` when none is given) has passed, ends at the deadline whoever has not, with its
// desk as it is, and says who did what. A Leader told is waited for like any other session: a
// server stop ends whoever is left the moment this returns. One park at a time; the flag clears
// on every exit, so one failed park never locks the tool.
export async function parkRoom(instance, { interrupt: interruptFirst = false, deadline = null, leaderToo = false } = {}) {
  if (parking) {
    return { refused: "already parking" };
  }
  parking = true;
  try {
    const clock = clockOf(instance);
    const leader = leaderOf(instance);
    const seconds = deadline ?? settingsIn(instance.config).park.deadline;
    const told = runningSeats().filter((seat) => leaderToo || seat !== leader);
    // The records as they are now: a seat that stops itself is gone from the running set by the
    // time this reports, and when its desk was written is read from the record it had.
    const records = new Map(told.map((seat) => [seat, recordOf(seat)]));
    const attrs = { ...(interruptFirst ? { interrupted: "true" } : {}), ...(deadline === null ? {} : { deadline: String(deadline) }) };
    const began = clock();
    const until = began + seconds * 1000;

    await Promise.all(
      told.map(async (seat) => {
        if (interruptFirst) {
          await interrupt(seat, { thenDrain: false });
        }
        deliver(instance, seat, interruptFirst ? serverEvent("park", attrs, BODY_PARK) : serverEvent("park", attrs), { ask: "park" });
      }),
    );

    // Stopped: the process that was told is ending or gone (a successor started under the park
    // is a process the park never told, and is not waited for).
    const stopped = (seat) => recordOf(seat) !== records.get(seat) || records.get(seat).ending !== null;
    while (clock() < until && !told.every(stopped)) {
      await new Promise((resolve) => setTimeout(resolve, PARK_POLL));
    }

    const said = [];
    for (const seat of told) {
      const record = records.get(seat);
      if (stopped(seat)) {
        said.push(`${seat} stopped (${hhmm(record.deskWrittenAt)})`);
        continue;
      }
      record.ending = "park-deadline";
      log.log("parked", seat, null, `at the deadline, ${hhmm(record.deskWrittenAt)}`);
      said.push(`${seat} ended at the deadline (${hhmm(record.deskWrittenAt)})`);
      end(seat);
    }
    return { text: `parked: ${said.length === 0 ? "nobody was running" : said.join("; ")}` };
  } finally {
    parking = false;
  }
}

// ---------------------------------------------------------------------------------- the wiring

// Arm the lifecycle for a served instance: the quota gate on the instance's thresholds and clock,
// the stage fan-out, and the clocks. Answers what stops it.
export function arm(instance) {
  quota.configure({ config: instance.config, clock: clockOf(instance) });
  const offStage = quota.onStage((window, stage, resets, model, percent) => {
    // What the gate learned, written before anything is done about it: which window, where it
    // stands, when it resets — and the model when the window is one model's own rather than the
    // whole account's, since a warning on one model's week says nothing about the others.
    log.log("quota", null, null, `${stage} on ${window}${model === null ? "" : ` (${model})`} at ${percent}%, resets ${resets}`);
    stageReached(instance, window, stage, resets, model).catch((error) => log.log("untold", null, null, `stage ${stage} on ${window}: ${error.message}`));
  });
  const ticking = setInterval(() => tick(instance), TICK);
  ticking.unref();
  return () => {
    offStage();
    clearInterval(ticking);
  };
}
