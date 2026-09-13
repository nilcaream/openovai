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

import { modelFor } from "../desks.mjs";
import { onHardRulesChanged } from "../store.mjs";
import { rulesUpdateFrame, serverEvent } from "./frames.mjs";
import { giveUp, park as parkRequest, rulesToPop, waitedLong } from "./permissions.mjs";
import { popped } from "./pop.mjs";
import * as quota from "./quota.mjs";
import { LEADER, WORKER, arrival, end, interrupt, prefix, recordOf, running, runningSeats, start, tell } from "./session.mjs";

// ------------------------------------------------------------------------------------ settings

// Minutes idle at which the Leader is told about a Worker (fyi), and at which any seat is told to
// write its desk and stop (force); the context ceiling in tokens; the park deadline the `park`
// tool uses when its caller gives none, and the one a server stop uses, both in seconds; and the
// minutes a Worker may wait on a permission button before the Leader is told.
export const DEFAULTS = Object.freeze({
  idle: { fyi: [10, 50], force: 55 },
  context: { ceiling: 160_000 },
  park: { deadline: 30 * 60, timeout: 20 },
  permission: { wait: 10 },
});

export function settingsIn(config) {
  const own = config ?? {};
  const fyi = Array.isArray(own.idle?.fyi) && own.idle.fyi.length === 2 ? own.idle.fyi : DEFAULTS.idle.fyi;
  return {
    idle: { fyi: [...fyi], force: typeof own.idle?.force === "number" ? own.idle.force : DEFAULTS.idle.force },
    context: { ceiling: typeof own.context?.ceiling === "number" ? own.context.ceiling : DEFAULTS.context.ceiling },
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
export const BODY_CONTEXT_FULL =
  "Your context is above the ceiling. Write your desk with write_desk, then call restart_session; your successor starts from the desk.";
export const BODY_CRITICAL =
  "The server interrupted your turn for this reason. Do not resume, do not investigate: write your desk with write_desk and call stop_session now.";
export const BODY_CRITICAL_LEADER =
  "The window is exhausted: your further turns are held until it resets. Write your desk with write_desk.";
export const BODY_IDLE = (force) =>
  `You have been idle ${force} minutes and go cold at ${COLD_AT}. Write your desk with write_desk and call stop_session.`;
export const BODY_PARK =
  "The server interrupted your turn: the room is parking. Do not resume: write your desk with write_desk and call stop_session within the deadline.";

function clockOf(instance) {
  return instance.clock ?? Date.now;
}

function leaderOf(instance) {
  return instance.config.leader;
}

// ------------------------------------------------------------------------------ starting a seat

// How a session's permission requests reach the page: parked on its panel, and the desktop told
// — the tool and the command, the session's own words on one line; the reason it gave is on the
// panel, not on a toast.
function asking(instance, seat) {
  return (request) => {
    const waiting = parkRequest(seat, request, clockOf(instance)());
    const command = typeof request.input?.command === "string" ? `: ${request.input.command}` : "";
    popped(instance, { on: seat, why: `${seat} is stopped, waiting to be allowed to use ${request.tool}${command}` });
    return waiting;
  };
}

// The rule requests a seat has raised through the `permission` tool reach the page once the turn
// that raised them has ended — the reply lands on the panel before its dialogs — and the desktop
// is told then, once per request, the way a call stop tells it. Called after every turn, and by
// the tool itself for a seat that is not on one.
export function showRules(instance, seat) {
  const record = recordOf(seat);
  if (record !== undefined && record.turn !== null) {
    return;
  }
  for (const { rule } of rulesToPop(seat)) {
    popped(instance, { on: seat, why: `${seat} asks you to settle ${rule}` });
  }
}

// The one place a seat's process is started. `queue` is what a predecessor left for it. The gate
// is the process's own, read by session.mjs at every write; what it holds goes on the held list.
export function startSeat(instance, seat, { queue = [] } = {}) {
  return start(instance, seat, {
    asked: asking(instance, seat),
    turned: (record) => turned(instance, record),
    ended: (closed) => {
      giveUp(seat);
      afterClose(instance, closed);
    },
    queue,
    gate: (frame) => gateOn(instance, seat, frame),
    held: (entries) => {
      for (const { turn, holding } of entries) {
        holdTurn(seat, turn, holding);
      }
    },
  });
}

// Successors waiting for a window: a seat that restarted while the gate was closed, with the turns
// its predecessor left, started at the first tick after the reset.
const successors = new Map();

function startSuccessor(instance, seat, carried) {
  try {
    startSeat(instance, seat, { queue: carried });
  } catch (error) {
    console.log(`no successor for ${seat}: ${error.message}`);
    for (const turn of carried) {
      turn.resolve({ ended: true, text: `${seat} could not be restarted: ${error.message}` });
    }
  }
}

// What follows a process closing: a successor for one that was restarting, with the turns it left
// — now, or once the window that would hold its first write has reset; and, after every idle stop
// of a Worker, the FYI to the Leader.
function afterClose(instance, { seat, role, ending, carried }) {
  if (ending === "restart") {
    const holding = quota.mayStart(modelFor(instance.root, seat, instance.config));
    if (holding === null) {
      startSuccessor(instance, seat, carried);
    } else {
      console.log(`successor held: ${seat} until ${holding.window} resets ${holding.resets}`);
      successors.set(seat, carried);
    }
    return;
  }
  if (role === WORKER && (ending === "idle" || ending === "idle-forced")) {
    deliver(instance, leaderOf(instance), serverEvent("stopped", { who: seat, why: ending }));
  }
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

// One turn the gate held, on the held list with the arrival it was told with.
function holdTurn(seat, turn, holding) {
  quota.hold(seat, { frame: turn.frame, ahead: turn.ahead, ask: turn.ask, resolve: turn.resolve, window: holding.window, order: turn.order });
  console.log(`held: ${seat} (${turn.frame.kind}) until ${holding.window} resets ${holding.resets}`);
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
// eventually written and answered. `ask` names what an event asks of the seat, for the clocks.
export function deliver(instance, seat, frame, { ahead = false, ask = null } = {}) {
  const holding = passesAClosedGate(frame) ? null : quota.mayWrite(seat, modelFor(instance.root, seat, instance.config));
  if (!running(seat)) {
    if (seat !== leaderOf(instance)) {
      return tell(seat, frame, { ahead, ask });
    }
    if (holding !== null) {
      let resolve;
      const answered = new Promise((done) => {
        resolve = done;
      });
      holdTurn(seat, { frame, ahead, ask, resolve, order: arrival() }, holding);
      return { delivered: false, held: holding, answered };
    }
    startSeat(instance, seat);
  }
  const told = tell(seat, frame, { ahead, ask });
  return holding === null || told.refused !== undefined ? told : { delivered: false, held: holding, answered: told.answered };
}

// The successors whose window has reset, started now — the Leader's first — and the held frames
// whose window has reset, written now: the Leader's first, then the Workers', each in arrival
// order — the server decides what resumes and in what order.
export function releaseHeld(instance) {
  const leader = leaderOf(instance);
  for (const seat of [...successors.keys()].sort((a, b) => (a === leader ? -1 : b === leader ? 1 : 0))) {
    if (quota.mayStart(modelFor(instance.root, seat, instance.config)) === null) {
      const carried = successors.get(seat);
      successors.delete(seat);
      startSuccessor(instance, seat, carried);
    }
  }
  const released = quota.releasedBy();
  const ordered = [...released.filter((entry) => entry.seat === leader), ...released.filter((entry) => entry.seat !== leader)];
  for (const entry of ordered) {
    console.log(`released: ${entry.seat} (${entry.frame.kind})`);
    const told = deliver(instance, entry.seat, entry.frame, { ahead: entry.ahead, ask: entry.ask });
    if (told.refused !== undefined) {
      entry.resolve({ ended: true, text: `${entry.seat} has no process` });
    } else {
      told.answered.then(entry.resolve);
    }
  }
  return ordered.length;
}

// ------------------------------------------------------------------------------ the quota stages

// Stage one: every running seat the window applies to is told, ahead of its queue, and nobody is
// interrupted. Stage two: every running Worker the window applies to is interrupted and then told,
// ahead, with the body that says so; the Leader is told once and not interrupted — its turns are
// held by the gate from here.
export async function stageReached(instance, window, stage, resets, model) {
  const leader = leaderOf(instance);
  const attrs = { stage, window, resets, ...(model === null ? {} : { model }) };
  const seats = runningSeats().filter((seat) => quota.appliesTo(recordOf(seat)?.model, window));
  if (stage === quota.WARNING) {
    for (const seat of seats) {
      deliver(instance, seat, serverEvent("quota-low", attrs), { ahead: true });
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
        deliver(instance, seat, serverEvent("quota-low", attrs, BODY_CRITICAL_LEADER), { ahead: true });
        return;
      }
      await interrupt(seat, { thenDrain: false });
      deliver(instance, seat, serverEvent("quota-low", { ...attrs, interrupted: "true" }, BODY_CRITICAL), { ahead: true, ask: "stop" });
    }),
  );
}

// --------------------------------------------------------------------------------- context full

// After every turn: the rule dialogs the turn raised, shown now that its reply is on the panel;
// and once, ahead of whatever is queued, when the last request took more of the context than
// the ceiling allows.
function turned(instance, record) {
  showRules(instance, record.seat);
  const { context } = settingsIn(instance.config);
  if (record.context === null || record.context <= context.ceiling || record.contextFullTold) {
    return;
  }
  record.contextFullTold = true;
  deliver(
    instance,
    record.seat,
    serverEvent("context-full", { context: String(record.context), ceiling: String(context.ceiling) }, BODY_CONTEXT_FULL),
    { ahead: true, ask: "stop" },
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
    deliver(instance, leader, serverEvent("permission", { who: seat, waiting: String(permission.wait) }, `${request.tool}: ${call}`));
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
      deliver(instance, seat, serverEvent("idle", { stage: "critical", minutes: String(idle.force) }, BODY_IDLE(idle.force)), {
        ahead: true,
        ask: "idle",
      });
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
// is interrupted when asked and told the park event ahead of its queue; then this waits until
// every Worker has called stop_session or the deadline (seconds; the instance's `park.deadline`
// when none is given) has passed, ends at the deadline whoever has not, with its desk as it is,
// and says who did what. The Leader is told and not waited for. One park at a time; the flag
// clears on every exit, so one failed park never locks the tool.
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
    const waitedFor = told.filter((seat) => seat !== leader);
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
        deliver(instance, seat, interruptFirst ? serverEvent("park", attrs, BODY_PARK) : serverEvent("park", attrs), { ahead: true, ask: "park" });
      }),
    );

    // Stopped: the process that was told is ending or gone (a successor started under the park
    // is a process the park never told, and is not waited for).
    const stopped = (seat) => recordOf(seat) !== records.get(seat) || records.get(seat).ending !== null;
    while (clock() < until && !waitedFor.every(stopped)) {
      await new Promise((resolve) => setTimeout(resolve, PARK_POLL));
    }

    const said = [];
    for (const seat of waitedFor) {
      const record = records.get(seat);
      if (stopped(seat)) {
        said.push(`${seat} stopped (${hhmm(record.deskWrittenAt)})`);
        continue;
      }
      record.ending = "park-deadline";
      console.log(`parked at the deadline: ${seat}, ${hhmm(record.deskWrittenAt)}`);
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
// the stage fan-out, the hard-rule delta, and the clocks. Answers what stops it.
export function arm(instance) {
  quota.configure({ config: instance.config, clock: clockOf(instance) });
  if (quota.fableWindowName() === null) {
    console.log(`${quota.FABLE_WINDOW.key}: no window of that scope is on the rate_limit_event frame; not gated (set quota.windows in openovai.json when one is)`);
  }
  const offStage = quota.onStage((window, stage, resets, model) => {
    stageReached(instance, window, stage, resets, model).catch((error) => console.log(`quota stage ${stage} on ${window}: ${error.message}`));
  });
  const offRules = onHardRulesChanged((version, renderFor) => {
    for (const seat of runningSeats()) {
      const text = renderFor(recordOf(seat).role);
      if (text !== null) {
        prefix(seat, rulesUpdateFrame(version, text), version);
      }
    }
  });
  const ticking = setInterval(() => tick(instance), TICK);
  ticking.unref();
  return () => {
    offStage();
    offRules();
    clearInterval(ticking);
  };
}

export { LEADER, WORKER };
