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
// Leader's `hire` and its `restart_worker`, both through `startSeat` here; a message to a stopped
// Worker is refused, never a spawn.

import fs from "node:fs";
import path from "node:path";

import { forget, recorded } from "../admin.mjs";
import { LEADER, WORKER, deskHeader, isModel, modelFor } from "../desks.mjs";
import { configFile } from "../instance.mjs";
import { GOING, LOST, RUNS_HOURS, RUNS_MOST, STOPPED, allRuns, exitWord, lastLines, logOf, markTold, stopRun } from "../runs.mjs";
import { RuntimeError } from "../runtime.mjs";
import * as checkpoint from "./checkpoint.mjs";
import { SERVER, amend, append, cutAsSaid, failedAsSaid, read } from "./conversation.mjs";
import { publish } from "./events.mjs";
import { serverEvent } from "./frames.mjs";
import * as log from "./log.mjs";
import { expire, giveUp, park as parkRequest, refuse, rulesPending } from "./permissions.mjs";
import * as quota from "./quota.mjs";
import { refOf } from "./refs.mjs";
import * as status from "./status.mjs";
import { line } from "./lines.mjs";
import { LINE_RETRYING, LINE_WORKING } from "./panels.mjs";
import * as usage from "./usage.mjs";
import { TURN_PATIENCE, arrival, closedAs, end, interrupt, isClosing, recordOf, roleOf, running, runningSeats, seats, serverTurn, start, tell, unread } from "./session.mjs";

// ------------------------------------------------------------------------------------ settings

// Minutes idle at which the Leader is told about a Worker (fyi), at which any seat is told to write
// its desk and stop (force), and at which the Leader is told every Worker is (all); the context
// sizes in tokens — the size a session is first told it has passed, the step it is told again at,
// and the size from which it is told to wrap up; the park deadline the `park` tool uses when its
// caller gives none, and the one a server stop uses, both in seconds, and the margin `ovai stop`
// waits past the second for the sessions to go, in seconds too; and the typing hold, in seconds:
// how long after the last key in a seat's box on the page the User counts as typing there (quiet),
// and the longest a turn waits for them (cap), 0 in either turning it off — what the typing hold
// holds, for a person: NOTES.md, 0.18.0. And the desk limit, in bytes: a desk file that grows past
// it is saved whole beside itself and its seat is told, once per crossing (server.mjs, write_desk).
// And whether the server looks once a day for a newer release to name on the Leader's head
// (releases.mjs). And the long runs a seat starts with `ovai run` (lib/runs.mjs): how many may go
// at once per seat, and the hours one may go before the server stops it.
export const DEFAULTS = Object.freeze({
  idle: { fyi: [10, 50], force: 55, all: 1 },
  context: { warning: 200_000, step: 20_000, error: 300_000 },
  park: { deadline: 30 * 60, timeout: 20, margin: 15 },
  typing: { quiet: 10, cap: 30 },
  desk: { limit: 128 * 1024 },
  update: { check: true },
  runs: { most: RUNS_MOST, hours: RUNS_HOURS },
});

// A number of seconds for the typing hold: not a number, or below 0, is the default.
const seconds = (value, fallback) => (typeof value === "number" && value >= 0 ? value : fallback);

export function settingsIn(config) {
  const own = config ?? {};
  const fyi = Array.isArray(own.idle?.fyi) && own.idle.fyi.length === 2 ? own.idle.fyi : DEFAULTS.idle.fyi;
  return {
    idle: {
      fyi: [...fyi],
      force: typeof own.idle?.force === "number" ? own.idle.force : DEFAULTS.idle.force,
      all: typeof own.idle?.all === "number" ? own.idle.all : DEFAULTS.idle.all,
    },
    context: {
      warning: typeof own.context?.warning === "number" ? own.context.warning : DEFAULTS.context.warning,
      step: typeof own.context?.step === "number" ? own.context.step : DEFAULTS.context.step,
      error: typeof own.context?.error === "number" ? own.context.error : DEFAULTS.context.error,
    },
    park: {
      deadline: typeof own.park?.deadline === "number" ? own.park.deadline : DEFAULTS.park.deadline,
      timeout: typeof own.park?.timeout === "number" ? own.park.timeout : DEFAULTS.park.timeout,
      margin: typeof own.park?.margin === "number" ? own.park.margin : DEFAULTS.park.margin,
    },
    typing: { quiet: seconds(own.typing?.quiet, DEFAULTS.typing.quiet), cap: seconds(own.typing?.cap, DEFAULTS.typing.cap) },
    desk: { limit: typeof own.desk?.limit === "number" && own.desk.limit > 0 ? own.desk.limit : DEFAULTS.desk.limit },
    update: { check: typeof own.update?.check === "boolean" ? own.update.check : DEFAULTS.update.check },
    runs: {
      most: Number.isInteger(own.runs?.most) && own.runs.most > 0 ? own.runs.most : DEFAULTS.runs.most,
      hours: typeof own.runs?.hours === "number" && own.runs.hours > 0 ? own.runs.hours : DEFAULTS.runs.hours,
    },
  };
}

// openovai.json is read when the server starts (serve.mjs) and looked at again on the server's
// tick (server.mjs): a new modification time is read whole, and what changed is taken at once —
// every setting above is read through settingsIn where it is used, models where a seat starts, and
// the quota gate is configured again here. Four keys are the exception, kept as the server started
// with them until `ovai restart`: who the User and the Leader are and where the page listens are
// what the room IS, and a sign-in mode switched under running seats would leave them on two. A
// file that does not read as a JSON object changes nothing. Either way the Leader is told once per
// write, by key name: the file is the User's, and nothing in it is a secret, but its values are
// read from the file and not said twice.
export const RESTART_ONLY = Object.freeze(["user", "leader", "port", "auth"]);

const plainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const sameValue = (one, other) => JSON.stringify(one) === JSON.stringify(other);
const keysOf = (one, other) => [...new Set([...Object.keys(one ?? {}), ...Object.keys(other ?? {})])].sort();

// The keys that differ between two configurations, one level deep: `desk.limit`, `quota.5h`,
// `models.worker` — a key that is absent on one side counting as an empty object there, since a
// file that gains `desk` gains `desk.limit` — or the key alone where either side is a value.
export function changedKeys(before, after) {
  const changed = [];
  const nested = (value) => value === undefined || plainObject(value);
  for (const key of keysOf(before, after)) {
    if (sameValue(before[key], after[key])) {
      continue;
    }
    if (nested(before[key]) && nested(after[key])) {
      const [one, other] = [before[key] ?? {}, after[key] ?? {}];
      changed.push(...keysOf(one, other).filter((inner) => !sameValue(one[inner], other[inner])).map((inner) => `${key}.${inner}`));
    } else {
      changed.push(key);
    }
  }
  return changed;
}

export const BODY_CONFIG = (user, live, later) =>
  [
    "openovai.json changed.",
    live.length === 0 ? null : `Applied now, with no restart: ${live.join(", ")}.`,
    live.some((key) => key.startsWith("models.")) ? "A model applies from each seat's next start; a running seat keeps the one it started on." : null,
    later.length === 0 ? null : `Not applied: ${later.join(", ")} — who and where this instance is changes only when ${user} runs \`ovai restart\`.`,
    "Names only: what they hold is in the file.",
  ]
    .filter((line) => line !== null)
    .join(" ");
export const BODY_CONFIG_UNREADABLE = (user, reason) =>
  `openovai.json changed and does not read as a JSON object (${reason}), so nothing in it was taken: the server goes on with the settings it had. Tell ${user}, who edits the file.`;
export const BODY_CONFIG_MENDED = "openovai.json reads as JSON again and holds what the server already had: nothing changed.";

// Answers null when there is nothing new to say, or what was found: `{ live, later }` or
// `{ unreadable }`. The first look at an instance only notes the file as it is. With tell false
// the Leader hears nothing: the Leader's own `settings` call answers it instead.
export function rereadConfig(instance, { tell = true } = {}) {
  const tellConfig = tell ? tellLeader : () => {};
  const file = configFile(instance.root);
  let stamp;
  try {
    stamp = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (instance.configRead === undefined) {
    instance.configRead = { stamp, config: instance.config };
    return null;
  }
  if (stamp === instance.configRead.stamp) {
    return null;
  }

  let fresh;
  try {
    fresh = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!plainObject(fresh)) {
      throw new Error("it is not an object");
    }
  } catch (error) {
    instance.configRead = { stamp, config: instance.configRead.config, unreadable: true };
    log.log("config", null, null, `unreadable, kept as it was: ${error.message}`);
    tellConfig(instance, BODY_CONFIG_UNREADABLE(instance.config.user, error.message));
    return { unreadable: error.message };
  }

  const changed = changedKeys(instance.configRead.config, fresh);
  const mended = instance.configRead.unreadable === true;
  instance.configRead = { stamp, config: fresh };
  if (changed.length === 0) {
    // A Leader told the file was broken is told it is not any more, or it goes on saying so.
    if (mended) {
      log.log("config", null, null, "readable again, nothing changed");
      tellConfig(instance, BODY_CONFIG_MENDED);
      return { live: [], later: [] };
    }
    return null;
  }
  // Each restart-only key exactly as the server started with it: present with its value, or absent.
  const merged = { ...fresh };
  for (const key of RESTART_ONLY) {
    if (Object.hasOwn(instance.config, key)) {
      merged[key] = instance.config[key];
    } else {
      delete merged[key];
    }
  }
  instance.config = merged;
  quota.configure({ config: instance.config, clock: clockOf(instance) });

  const later = changed.filter((key) => RESTART_ONLY.includes(key.split(".")[0]));
  const live = changed.filter((key) => !later.includes(key));
  log.log("config", null, null, `applied: ${live.join(", ") || "nothing"}; at restart: ${later.join(", ") || "nothing"}`);
  tellConfig(instance, BODY_CONFIG(instance.config.user, live, later));
  return { live, later };
}

// The Leader alone, as for admin mode, and not while the room parks: a Leader started now would be
// stopped a moment later, and the file says the same thing after the next start.
function tellLeader(instance, body) {
  if (isParking()) {
    return;
  }
  const told = deliver(instance, leaderOf(instance), serverEvent("config", {}, body));
  if (told.refused !== undefined) {
    log.log("untold", null, null, `config: ${told.refused}`);
  }
}

// What the Leader's `settings` tool writes, named one level deep as the config event names them,
// each with what it takes, said the way a refusal says it, and whether the key may be taken out
// of the file for its default: a model has none, and a seat would start on nothing. The four
// restart-only keys are not here: who and where the instance is changes with the User's own hand.
const above = (floor) => (value) => typeof value === "number" && Number.isFinite(value) && value > floor;
const atLeast = (floor) => (value) => typeof value === "number" && Number.isFinite(value) && value >= floor;
const rising = (each) => (value) => Array.isArray(value) && value.length === 2 && value.every(each) && value[0] <= value[1];
const percent = (value) => atLeast(0)(value) && value <= 100;
const SETTING = (valid, takes, removable = true) => ({ valid, takes, removable });
export const SETTINGS = Object.freeze({
  "desk.limit": SETTING(above(0), "a number of bytes above 0"),
  "idle.fyi": SETTING(rising(above(0)), "two numbers of minutes above 0, the first not past the second"),
  "idle.force": SETTING(above(0), "a number of minutes above 0"),
  "idle.all": SETTING(above(0), "a number of minutes above 0"),
  "context.warning": SETTING(above(0), "a number of tokens above 0"),
  "context.step": SETTING(above(0), "a number of tokens above 0"),
  "context.error": SETTING(above(0), "a number of tokens above 0"),
  "park.deadline": SETTING(above(0), "a number of seconds above 0"),
  "park.timeout": SETTING(above(0), "a number of seconds above 0"),
  "park.margin": SETTING(atLeast(0), "a number of seconds, 0 or more"),
  "typing.quiet": SETTING(atLeast(0), "a number of seconds, 0 or more; 0 turns it off"),
  "typing.cap": SETTING(atLeast(0), "a number of seconds, 0 or more; 0 turns it off"),
  "quota.5h": SETTING(rising(percent), "two percentages from 0 to 100, warning then critical"),
  "quota.7d": SETTING(rising(percent), "two percentages from 0 to 100, warning then critical"),
  "models.leader": SETTING(isModel, "a model as a hire takes it, such as opus or opus/high", false),
  "models.worker": SETTING(isModel, "a model as a hire takes it, such as opus or opus/high", false),
  "update.check": SETTING((value) => typeof value === "boolean", "true or false; false stops the daily look for a newer release"),
  "runs.most": SETTING((value) => Number.isInteger(value) && value > 0, "a whole number of runs above 0: how many one seat may have going at once"),
  "runs.hours": SETTING(above(0), "a number of hours above 0: how long a run may go before the server stops it"),
});

// Each setting as the server holds it now, with its default marked where the file says nothing.
export function settingsNow(instance) {
  const config = instance.config;
  const held = { ...settingsIn(config), quota: quota.thresholdsIn(config), models: config.models ?? {} };
  const lines = Object.keys(SETTINGS).map((key) => {
    const [group, inner] = key.split(".");
    const own = plainObject(config[group]) && Object.hasOwn(config[group], inner);
    return `${key}: ${JSON.stringify(held[group][inner])}${own ? "" : " (default)"}`;
  });
  return [
    "Applied the moment they are written, with no restart; a model from each seat's next start:",
    ...lines,
    `At \`ovai restart\` only, and changed by ${config.user} in the file, never by this tool: ${RESTART_ONLY.map((key) => `${key}: ${JSON.stringify(config[key] ?? null)}`).join(", ")}.`,
  ].join("\n");
}

// The Leader's change, checked whole before anything is written, then written over openovai.json
// in one rename — a reader never sees half a file — and taken at once by the same reread the tick
// makes. Answers `{ refused }` with the file untouched, or `{ text }` with what applied.
export function changeSettings(instance, change) {
  if (!plainObject(change) || Object.keys(change).length === 0) {
    return { refused: "change is an object of settings to their new values, such as {\"idle.force\": 40}; null takes one back to its default" };
  }
  for (const [key, value] of Object.entries(change)) {
    if (RESTART_ONLY.includes(key.split(".")[0])) {
      return { refused: `${key} is who and where this instance is: ${instance.config.user} changes it in openovai.json by hand, and it applies at \`ovai restart\`` };
    }
    const setting = SETTINGS[key];
    if (setting === undefined) {
      return { refused: `${key} is not a setting this tool writes; called with no change, it lists them` };
    }
    if (value === null ? !setting.removable : !setting.valid(value)) {
      return { refused: `${key} takes ${setting.takes}${setting.removable ? ", or null for its default" : ""} (got ${JSON.stringify(value)})` };
    }
  }

  const file = configFile(instance.root);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!plainObject(config)) {
      throw new Error("it is not an object");
    }
  } catch (error) {
    return { refused: `openovai.json does not read as a JSON object now (${error.message}): ${instance.config.user} mends it by hand first` };
  }
  // A save by hand the tick has not seen yet is told as its own change, before this one is made.
  rereadConfig(instance);

  const before = JSON.stringify(config);
  for (const [key, value] of Object.entries(change)) {
    const [group, inner] = key.split(".");
    if (value === null) {
      if (plainObject(config[group])) {
        delete config[group][inner];
        if (Object.keys(config[group]).length === 0) {
          delete config[group];
        }
      }
    } else {
      config[group] = { ...(plainObject(config[group]) ? config[group] : {}), [inner]: value };
    }
  }
  if (JSON.stringify(config) === before) {
    return { text: "Nothing to write: openovai.json already holds that." };
  }
  const written = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(written, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(written, file);

  const { live = [] } = rereadConfig(instance, { tell: false }) ?? {};
  return {
    text: [
      `Written to openovai.json and applied now, with no restart: ${live.join(", ") || "nothing"}.`,
      live.some((key) => key.startsWith("models.")) ? "A model applies from each seat's next start; a running seat keeps the one it started on." : null,
    ]
      .filter((line) => line !== null)
      .join(" "),
  };
}

// When a session goes cold: the life of its prompt cache, in minutes. The 50-minute FYI says how
// long is left against this.
export const COLD_AT = 60;

// Minutes after the critical idle event before a seat that has not stopped itself is ended.
export const IDLE_GRACE = 5;

// How often the clocks are read.
const TICK = 60_000;

// Minutes a card that holds a session's call waits before it is answered as a Deny: a person who
// has not answered in that long is not at the panel, and the session is better off told so and
// trying something else than held. A subagent's card goes sooner: a subagent is not built to be
// stopped, and the session's prompt cache lives 5 minutes, so the wait has to end well inside
// that, tick included. Read on the clock's tick, so a card goes within a tick of its time.
export const CARD_TIMEOUT = 10;
export const SUBAGENT_CARD_TIMEOUT = 2;

// A request a subagent made carries the subagent (session.mjs).
const timeoutOf = (request) => (request.agent === undefined ? CARD_TIMEOUT : SUBAGENT_CARD_TIMEOUT);

// The error the session gets for a card that timed out: the User's name, the way a Deny from the
// panel carries it (server.mjs), so it is never taken for the call's own output, and who that is,
// since a subagent was never told.
export const TIMED_OUT = (user, minutes) => `${user}, the person who answers permission cards on the ovai page, did not answer this card within ${minutes} minutes, so it was denied: try something else.`;

// How often a park looks at who has stopped.
const PARK_POLL = 200;

// What the server says, per (type, stage): fixed strings, never composed from anything a session
// wrote, and neutralised on the way into the frame anyway.
export const BODY_CONTEXT_WARNING =
  "This is how much of your context you have used; the size you wrap up at is in this event. Nothing is ended for you: carry on, keep your desk current with write_desk, and plan your own restart for a moment that suits the work. You are told again at every step from here.";
export const BODY_CONTEXT_WORKER =
  "This Worker's context is past the size a session wraps up at. Restart it with restart_worker at a moment that suits its work — between two steps, or after the report it owes you: it writes its desk, and its successor starts from it.";
export const BODY_CONTEXT_ERROR =
  "Your context is past the size you wrap up at. Finish what is in your hands, write your desk with write_desk, then call restart_session; your successor starts from the desk.";
// The one instruction a Worker is given when its session closes, whatever the reason: its desk,
// written last in this turn. The session ends when the turn is over, so nothing else is asked.
const CLOSING_FOR = {
  stop: "the Leader is stopping you",
  restart: "the Leader is restarting you on this desk",
  idle: "you have been idle and nobody has spoken to you",
  quota: "the usage window your model runs on is spent",
  park: "the room is parking",
};
export const BODY_CLOSING = (why, interrupted, deadline) =>
  `${interrupted ? "The server interrupted your turn for this. Do not resume the work. " : ""}This session is closing: ${CLOSING_FOR[why]}. Write your desk with write_desk — what the task is, what is true now, what to do next — as the last thing you do in this turn. The session ends when this turn is over, with the desk as you wrote it, and ${why === "restart" ? "your successor starts from it" : "whoever takes the work up starts from it"}.${deadline === null ? "" : ` With no desk written within ${Math.round(deadline / 60)} minutes of this, it ends with the desk as it was last written.`}`;
export const BODY_UNANSWERED = (user, at) =>
  `${user}'s line of ${at} got no words on your panel in the turn before this one: nothing, only a noop, or only calls. Answer that line now, in words, in this reply.`;
export const BODY_CRITICAL_LEADER =
  "The window is exhausted: your further turns are held until it resets. Write your desk with write_desk.";
export const BODY_IDLE = (force) =>
  `You have been idle ${force} minutes and go cold at ${COLD_AT}. Write your desk with write_desk and call stop_session.`;
export const BODY_PARK =
  "The server interrupted your turn: the room is parking. Do not resume: write your desk with write_desk and call stop_session within the deadline.";
// The one body composed from anything: the names of the files that changed, which `ovai claude`
// wrote down and no session did. They are file names from a closed list and nothing a model said.
export const BODY_ADMIN_CLOSED = (changed, moved) =>
  `Admin mode was open on this instance — a person at a terminal, using Claude Code's own commands against this instance's configuration — and it has closed. ${moved.length === 0 ? "Nothing this instance reads changed that can be named." : `What changed: ${moved.join("; ")}.`} ${changed.length === 0 ? "No configuration file this instance watches changed." : `Files: ${changed.join(", ")}.`} Names only, nothing of what is in them: read the ones that matter before you hand work out — a permission rule that moved changes what a Worker may do. A permission rule in .claude/settings.json applies at each seat's next call. The rest is not live yet: a seat reads it when it starts, so it reaches no seat until the User runs \`ovai restart\`.`;
// The two composed from a number the server counted and a seat's name, which is a name.
export const BODY_CHECKPOINT = (calls) =>
  `You have made ${calls} tool calls since the Leader's order. Send the Leader a report now: where the work stands, done or not, what is left, and how many more calls you expect. Then carry on unless the Leader says otherwise.`;
export const BODY_CHECKPOINT_LEADER = (seat, calls) =>
  `${seat} has made ${calls} tool calls since your order and has been told to report where it stands and carry on.`;
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

// The row for a call the classifier refused: its category and the call, the call cut where a
// command would fill the panel — the log has it whole. A call auto mode's check could not judge
// comes in the same frame with one of NO_VERDICT as its reason (the first measured on the Leader's
// panel, both read in the 2.1.322 binary): that is no refusal, and the row does not call it one.
const BLOCKED_SHOWS = 300;
const NO_VERDICT = new Set(["Classifier unavailable", "Auto mode unavailable — stopped after repeated responses with no safety verdict"]);

export function blockedLine(category, what) {
  const shown = what.length > BLOCKED_SHOWS ? `${what.slice(0, BLOCKED_SHOWS - 1)}…` : what;
  if (NO_VERDICT.has(category)) return `Not run — auto mode's check gave no verdict — ${shown}`;
  return `Blocked by auto mode${category === "" ? "" : `: ${category}`} — ${shown}`;
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
      const timedOut = decision.message === TIMED_OUT(instance.config.user, timeoutOf(request));
      log.log("answered", seat, null, `${decision.behavior} after ${seconds} s${timedOut ? " (timed out)" : ""}`);
      if (timedOut) {
        append(instance.root, seat, { from: SERVER, text: `Waited ${seconds} seconds for permission, timed out: ${what}` });
      } else if (seconds >= WAIT_SAID_FROM) {
        append(instance.root, seat, { from: SERVER, text: `Waited ${seconds} seconds for permission: ${what}` });
      }
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

// The Leader's confirm_status call as its process says it is out and back, so that what is written
// to it while the call is out stays counted against the status the call confirms (status.mjs).
const CONFIRM_CALL = "mcp__openovai__confirm_status";

function confirmingOn(instance, seat, called) {
  return (call) => {
    if (seat === leaderOf(instance) && call.name === CONFIRM_CALL) {
      status.calling(instance.root, call.id);
    }
    called(call);
  };
}

function confirmedOn(instance, seat, returned) {
  return (call) => {
    if (seat === leaderOf(instance)) {
      status.back(instance.root, call.id);
    }
    returned(call);
  };
}

// The one place a seat's process is started. `queue` is what a predecessor left for it, and
// `spoke` whether that predecessor ever answered a turn — both carried across a restart. The gate
// is the process's own, read by session.mjs at every write; what it holds goes on the held list.
export function startSeat(instance, seat, { queue = [], spoke = false } = {}) {
  if (seat === leaderOf(instance)) {
    instance.parked = false;
  }
  const started = start(instance, seat, {
    asked: asking(instance, seat),
    turned: (record) => turned(instance, record),
    // What a seat says is a row on its panel the moment it is said. A Worker's calls are drawn
    // there too, as lines, one per call, marked once the call failed; the Leader's own calls
    // are not — its panel is the User's conversation — only the one it is at, said by the seat
    // while the turn runs (doingBy), and gone with the turn.
    // Every seat's calls go to the log, the Leader's included: a turn that stood still is read
    // there, by what it was calling.
    said: ({ text, noop = false }) => append(instance.root, seat, noop ? { from: seat, text, noop: true } : { from: seat, text }),
    called: confirmingOn(instance, seat, logged(instance, seat, roleOf(instance, seat) === WORKER ? calledBy(instance, seat) : doingBy(instance, seat))),
    returned: confirmedOn(instance, seat, backFrom(seat, roleOf(instance, seat) === WORKER ? () => {} : returnedBy(instance, seat))),
    retrying: roleOf(instance, seat) === WORKER ? () => {} : retryingBy(instance, seat),
    failed: ({ id, why }) => {
      log.failed(seat, { id, why });
      if (roleOf(instance, seat) === WORKER) {
        amend(instance.root, seat, id, why);
      }
    },
    // A call auto mode's classifier refused: no card was raised and the session was only told the
    // call failed, so this row is how the page learns of it — the one record the Leader's panel
    // has of a call, since its calls have no rows.
    blocked: ({ tool, input, category }) => {
      const what = named(tool, input);
      log.log("blocked", seat, null, `${category === "" ? "-" : category}: ${what}`);
      append(instance.root, seat, { from: SERVER, text: blockedLine(category, what) });
    },
    // A Worker that has worked and whose turn came back an error from the service lives: the
    // Leader is told, in the service's own words, and decides whether to send again or stop it.
    died: ({ text }) => {
      if (roleOf(instance, seat) === WORKER) {
        deliver(instance, leaderOf(instance), serverEvent("died", { who: seat }, text));
      }
    },
    // The row that says the seat is gone names what it was ending as — the one word the record
    // holds, stop, restart, idle, park, idle-forced, park-deadline, first-turn-failed — and, for a
    // process that ended on its own, how: its exit code or signal.
    ended: (closed) => {
      if (seat === leaderOf(instance)) {
        status.gone(instance.root);
      }
      log.ended(seat, closed.ending ?? closed.exit);
      stampRow(instance, seat);
      giveUp(seat);
      afterClose(instance, closed);
    },
    queue,
    spoke,
    gate: (frame) => gateOn(instance, seat, frame),
    held: (entries) => {
      for (const { turn, holding } of entries) {
        holdTurn(instance, seat, turn, holding);
      }
    },
    typing: () => settingsIn(instance.config).typing,
    measured: (record) => {
      toldContext(instance, record);
      seatChanged(instance, seat);
    },
    changed: (record) => {
      if (roleOf(instance, seat) !== WORKER) {
        atTurn(record);
      }
      seatChanged(instance, seat);
    },
    // What reached the Leader is counted against its status, one for each child of the queue.
    wrote: (frames) => {
      if (seat === leaderOf(instance)) {
        status.delivered(instance.root, seat, frames);
      }
    },
  });
  stampRow(instance, seat);
  seatChanged(instance, seat);
  return started;
}

// What the Leader is at, for its panel, while it is on a turn — kept on its record and told to
// the page as the seat, never written to its conversation, since it is what is happening and not
// what was said: LINE_WORKING from the turn's start; the call it has out, worded as a Worker's
// line would be, from the moment it is made (a call the summary says nothing about leaves the
// words as they were); LINE_WORKING again from the moment that call's result is back until the
// next call; nothing once the turn is over, however it ended. A page opened mid-turn draws it
// from the snapshot, which lists the same object. A Worker's panel draws its calls as rows and
// has no such word.
function atTurn(record) {
  if (record.turn === null) {
    record.doing = null;
    record.lastCall = null;
  } else if (record.doing === null) {
    record.doing = LINE_WORKING;
  }
}

function doingBy(instance, seat) {
  return ({ id, name, input }) => {
    const record = recordOf(seat);
    if (record === undefined) {
      return;
    }
    record.lastCall = id;
    const text = line(name, input, instance.root);
    if (text !== null) {
      record.doing = text;
      seatChanged(instance, seat);
    }
  };
}

// Claude Code trying a failed request again: the line says which try, in place of what the seat
// was at, until a frame shows the turn moving, when it says what it said before the first try.
function retryingBy(instance, seat) {
  return (retry) => {
    const record = recordOf(seat);
    if (record === undefined || record.turn === null) {
      return;
    }
    if (retry === null) {
      record.doing = record.beforeRetry ?? LINE_WORKING;
      record.beforeRetry = null;
    } else {
      record.beforeRetry ??= record.doing;
      record.doing = LINE_RETRYING(retry.attempt, retry.of);
    }
    seatChanged(instance, seat);
  };
}

function returnedBy(instance, seat) {
  return ({ id }) => {
    const record = recordOf(seat);
    if (record !== undefined && record.lastCall === id && record.doing !== LINE_WORKING) {
      record.doing = LINE_WORKING;
      seatChanged(instance, seat);
    }
  };
}

// One line per call on the caller's own conversation, written the moment the call is made; a
// call the summary says nothing about writes nothing.
function calledBy(instance, seat) {
  return ({ id, name, input }) => {
    const text = line(name, input, instance.root);
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
    const calls = checkpoint.counted(seat);
    if (calls !== null) {
      reached(instance, seat, calls);
    }
  };
}

// A Worker's checkpoint is reached: the Worker is told to report and carry on, and the Leader is
// told it was — the count is the server's, and the row sits in the log beside the calls it counted.
function reached(instance, seat, calls) {
  log.log("checkpoint", seat, null, `${calls} calls`);
  deliver(instance, seat, serverEvent("checkpoint", { calls: String(calls) }, BODY_CHECKPOINT(calls)));
  deliver(instance, leaderOf(instance), serverEvent("checkpoint", { who: seat, calls: String(calls) }, BODY_CHECKPOINT_LEADER(seat, calls)));
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
// as one turn. What it answers is why no successor started, or null when one did.
function startSuccessor(instance, seat, carried, context, spoke) {
  try {
    const born = serverTurn(serverEvent("restarted", {}, BODY_RESTARTED), clockOf(instance)());
    startSeat(instance, seat, { queue: [...carried, born], spoke });
    showTheEnding(instance.root, seat, born.answered);
    // How full the session that restarted was, so "it filled up" is a number somebody can check
    // afterwards. It is what the predecessor's last result frame measured and nothing worked out
    // here; a session that restarted before a turn of its own came back has no reading, and the
    // row says that rather than carrying a zero.
    log.log("restart", seat, null, context === null ? "successor started, no context measured" : `successor started, ${context} tokens of context`);
    return null;
  } catch (error) {
    log.log("restart", seat, null, `no successor: ${error.message}`);
    for (const turn of carried) {
      turn.resolve(unread(seat, turn, `${seat} could not be restarted: ${error.message}`));
    }
    return error.message;
  }
}

// What follows a process closing: the page told; a successor for one that was restarting, with
// the turns it left — unless the window that would hold its first write is exhausted, in which
// case there is no successor: a panel is a process, and a process that could not work until a
// window resets, minutes or hours away, is not kept for it. The restart is a stop then: the turns
// it carried are answered so, and the Leader is told the way it is told of every stop of a
// Worker — through the gate, so it hears it once the window has reset and decides whether to
// hire again; a Leader whose own successor would be held is simply not running, and the next
// thing addressed to it starts it after the reset. And, after every close of a Worker but a park's,
// the `stopped` event to the Leader: a restart once its successor has started.
//
// A Leader whose process is gone for good — it stopped itself, was stopped with the instance, or
// died — has its panel say so in the head and on its bottom line (panels.mjs), not in a row: the
// next thing typed there starts a fresh session, with nothing of this one's context.
const STOPPED_TOLD = ["stop", "stop-deadline", "idle", "idle-forced", "quota"];

function afterClose(instance, { seat, role, ending, own = false, carried, context = null, why = "", spoke = false }) {
  seatChanged(instance, seat);
  if (ending !== "restart") {
    checkpoint.clear(seat);
  }
  if (ending === "restart") {
    const holding = quota.mayStart(modelFor(instance.root, seat, instance.config));
    if (holding === null) {
      const failed = startSuccessor(instance, seat, carried, context, spoke);
      // A Worker restarts only on the Leader's order now, and the order's outcome is this: the
      // successor running, or the reason there is none.
      if (role === WORKER) {
        deliver(instance, leaderOf(instance), failed === null ? serverEvent("stopped", { who: seat, why: "restart" }) : serverEvent("stopped", { who: seat, why: "restart-failed" }, failed));
      }
      return;
    }
    log.log("restart", seat, null, `no successor: stopped, ${holding.window} exhausted until ${holding.resets}`);
    for (const turn of carried) {
      turn.resolve(unread(seat, turn, `${seat} stopped: the ${holding.window} window is exhausted, reset at ${quota.hhmm(holding.resets)}`));
    }
    if (role === WORKER) {
      deliver(instance, leaderOf(instance), serverEvent("stopped", { who: seat, why: "quota" }));
    }
    return;
  }
  // Every other close of a Worker the Leader hears of the same way: its own stop, and the ones the
  // server made on its own. A park answers in its own tool result instead.
  if (role === WORKER && STOPPED_TOLD.includes(ending)) {
    deliver(instance, leaderOf(instance), serverEvent("stopped", { who: seat, why: ending }));
  }
  // A hire whose first turn died at the service: the same event, with the service's sentence as
  // the body. The body and not an attribute because an attribute value is a plain token
  // (frames.mjs) and a sentence is not one; verbatim because those words are the only thing that
  // says which version to move to, and nothing here could work that out.
  if (role === WORKER && ending === "first-turn-failed") {
    deliver(instance, leaderOf(instance), serverEvent("stopped", { who: seat, why: ending }, why));
  }
  // A process that ended on its own — a crash, a kill from outside, a close pending or none —
  // ends with no word of its own, and the Leader would otherwise wait for one; what it said on
  // stderr, or that it ended before answering, is the body. Not while the instance stops or the
  // room parks: no Leader is to be started then.
  if (role === WORKER && own && instance.stopping !== true && !isParking()) {
    deliver(instance, leaderOf(instance), serverEvent("stopped", { who: seat, why: "exited" }, why));
  }
}

// The instance is stopping: the page is told, and every page route answers 503 from here on
// (server.mjs) while the tool route stays open for the desks and stops the park takes.
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
  if (event.type === "closing") {
    // A close the server makes on its own passes; one somebody ordered waits for the window.
    return event.attrs.why === "idle" || event.attrs.why === "quota" || event.attrs.why === "park";
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
// is waiting for it — the User's own line unless said otherwise. The window is named in words; a
// window the gate has no words for goes by its key.
const WINDOW_WORDS = { "5h": "5-hour", "7d": "7-day", "7d-fable": "7-day fable" };

export function heldLine({ window, resets }, what = "your message") {
  return `Limit exhausted (${WINDOW_WORDS[window] ?? window} window), reset at ${quota.hhmm(resets)}, ${what} is waiting`;
}

// What a held frame is, for the panel: the User's line, a seat's message, an event of the chat's,
// with the article its name takes: an idle event, a done event.
function whatWaits(frame) {
  if (frame.kind === "server-event") {
    return `${/^[aeiou]/.test(frame.event.type) ? "an" : "a"} ${frame.event.type} event`;
  }
  return frame.kind === "message" ? `the message from ${frame.from}` : "your message";
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
// Admin mode closed, and the Leader is told: by the server's periodic look while it runs, within
// seconds of the door closing, and at the start that follows when it did not run. Only the Leader:
// it is the one that decides what the change costs the work, and a Worker told the same thing has
// nothing to do with it. Nothing is asked of it; there is no `ask` here, so a seat that owes the
// server an answer still owes it. Not while the room parks: a Leader started now would be stopped
// a moment later, and the record waits for the start that follows.
//
// The record is removed when the frame has really reached the Leader's process — `written`, which
// is called however long the quota gate held it — and never before: a notice lost is lost for
// ever, and a notice repeated is only repeated. A notice on its way, held by the gate, is not
// handed over again by the next look; one refused is looked at again. Answers whether there was
// one to pass on.
const telling = new Map();

export function adminTold(instance) {
  const left = recorded(instance.root);
  if (left === null || telling.get(instance.root) === left.ended || isParking()) {
    return false;
  }
  const frame = serverEvent("admin-closed", { ended: left.ended, changed: String(left.changed.length) }, BODY_ADMIN_CLOSED(left.changed, left.moved));
  telling.set(instance.root, left.ended);
  const told = deliver(instance, leaderOf(instance), frame, {
    written: () => {
      forget(instance.root, left.ended);
      if (telling.get(instance.root) === left.ended) {
        telling.delete(instance.root);
      }
    },
  });
  if (told.refused !== undefined) {
    telling.delete(instance.root);
    return false;
  }
  return true;
}

// What a seat says lands on its panel as it says it (`said`); what is left for the end of the turn
// is how it ended when that was not with words: a process gone before it answered, a run that
// failed, a turn the page stopped, a turn that said nothing at all. It is drawn for every turn,
// whatever started it — a line, a message, an event, a restart. A turn that held several frames
// answers every one of them with the one reply, and that is one row.
const shownEndings = new WeakSet();

// Claude Code's sentence for a claude.ai sign-in it could not renew, word for word as its errors
// page gives it for a run that is not interactive (https://code.claude.com/docs/en/errors#login-expired).
// Only a new sign-in ends it, and the service's words do not say how an instance gets one, so the
// panel is told in plain words after them. A row of the server's is plain text, so the command is
// written bare; it is marked failed like the row it follows, which draws it whole, never folded.
export const SIGN_IN_EXPIRED = "Failed to authenticate: OAuth session expired and could not be refreshed";
export const SIGN_IN_ROW = "The sign-in has expired. Run ovai login in a terminal, then type here again.";

// The row a turn the service cut becomes: the server's own words, in the User's terms, for what
// reached the seat, what it did and what to send, in markdown like any reply; its last paragraph
// ends with the service's own words (`why`) and the service's status page. `cut` is what the
// session kept of the turn: the frames it held (`of`), the calls it
// made, each with its time, and whether the seat stopped over it (`stopped`: its first turn, so it
// is ended and the next line reaches a fresh session). What the next line gets was measured on
// 2.1.322: the turn's frames and call results stay in a session that lives, so "go on" is answered
// with them. It is drawn only for a turn the service failed, which Claude Code says as `API
// Error: …` — measured: `Failed to authenticate. API Error: 403 Attention Required! | Cloudflare`,
// `API Error: 500 Internal server error. …`, `API Error: 529 Overloaded. …`, `API Error: Connection
// dropped (ECONNRESET). …`, `API Error: Connection to the API was lost (ECONNRESET). …` — or, for a
// request that got no answer in time, as the bare `Request timed out`. A run that cannot go on —
// not signed in, a sign-in that expired — fails in words of its own, and sending again does not
// help it.
const SERVICE_ERROR = "API Error";
const SERVICE_TIMEOUT = "Request timed out";
const STATUS_PAGE = "https://status.claude.com/";

export function cutWords(seat, cut, root, why) {
  const source = ` Source: ${why}${why.endsWith(".") ? "" : "."} See [${new URL(STATUS_PAGE).host}](${STATUS_PAGE}).`;
  const done = cut.calls.map((call) => ({ text: doneAs(call, root), at: call.at })).filter((call) => call.text !== null);
  const self = cut.of.length === 0;
  const opening = self ? `${seat} was working on its own` : `${seat} got ${gotWhat(cut.of)}`;
  const them = cut.of.length > 1 ? "them" : "it";
  // Only the User can send their own line again; a seat that stopped over anything else is told
  // to whoever started it, as the death of a hire is.
  const again = cut.of.some((frame) => frame.kind === "user") ? " Send your message again." : "";
  if (done.length === 0) {
    if (self) {
      return cut.stopped === true
        ? `Claude's service failed while ${seat} was working on its own, and ${seat} stopped. Nothing was done.${source}`
        : `Claude's service failed while ${seat} was working on its own. Nothing was done. Send "go on" and ${seat} carries on.${source}`;
    }
    return cut.stopped === true
      ? `${opening}, but Claude's service failed before ${seat} could act on ${them}, and ${seat} stopped.${again}${source}`
      : `${opening}, but Claude's service failed before ${seat} could act on ${them}. Nothing was done and there is no reply yet. Send "go on" and ${seat} answers ${them}.${source}`;
  }
  const things = done.length === 1 ? "1 thing" : `${done.length} things`;
  const these = done.length === 1 ? "That thing is done" : `Those ${things} are done`;
  return [
    `${opening} and did ${things}:`,
    ...done.map((call) => `- ${call.text} (${refOf(call.at).slice(0, 8)})`),
    "",
    cut.stopped === true
      ? `Then Claude's service failed and ${seat} stopped, so ${seat} could not reply. ${these}.${again}${source}`
      : `Then Claude's service failed, so ${seat} could not reply. ${these} and ${seat} remembers ${done.length === 1 ? "it" : "them"}. Nothing needs repeating: send "go on" to get the reply.${source}`,
  ].join("\n");
}

// A call as the cut row lists it: the line the panel's bottom line gives it; for ovai's own calls
// that have none because a row of their own shows them, a line all the same — a message sent is
// something done. A tool search only loads a tool, and is left out.
function doneAs(call, root) {
  const text = line(call.name, call.input, root);
  if (text !== null || call.name === "ToolSearch") {
    return text;
  }
  return call.name === "mcp__openovai__message" ? `Sent a message to ${call.input?.to ?? "?"}` : `Calling openovai: ${call.name.split("__").at(-1)}`;
}

// What a cut turn held, as the User says it: their own line, a seat's message, the server's notice.
function gotWhat(of) {
  const names = of.map((frame) => (frame.kind === "user" ? "your message" : frame.kind === "message" ? `${frame.from}'s message` : "a notice from ovai"));
  const each = [...new Set(names)].map((name) => {
    const times = names.filter((one) => one === name).length;
    return times === 1 ? name : name === "a notice from ovai" ? "notices from ovai" : `${name}s`;
  });
  return each.length === 1 ? each[0] : `${each.slice(0, -1).join(", ")} and ${each.at(-1)}`;
}

// Whether the panel has said TEXT since the seat last answered: a run of failures is told once, and
// the next turn the seat answers in words ends the run. Read off the panel rather than kept on the
// session, because a seat whose first turn fails is ended, and the next line typed starts a new one.
// A call's line and a message sent are not answers: a turn can make both and still fail.
function toldSinceAnswered(root, seat, text) {
  for (const row of read(root, seat).toReversed()) {
    if (row.from === SERVER && row.text === text) {
      return true;
    }
    if (row.from === seat && row.call === undefined && row.to === undefined && row.failed !== true && row.interrupted !== true) {
      return false;
    }
  }
  return false;
}

function showTheEnding(root, seat, answered) {
  answered.then((reply) => {
    if (shownEndings.has(reply)) {
      return;
    }
    shownEndings.add(reply);
    if (reply.unread === true) {
      // The process ended before the frame was ever written: what the panel shows as waiting was
      // never read, and the row says so.
      append(root, seat, { from: SERVER, text: undelivered(seat, reply.of), failed: true });
    } else if (reply.ended === true) {
      append(root, seat, { from: SERVER, text: reply.err === "" ? `${seat} stopped before answering` : `${seat} stopped before answering: ${reply.err}`, failed: true });
    } else if (reply.failed && reply.cut !== undefined && (reply.text.includes(SERVICE_ERROR) || reply.text === SERVICE_TIMEOUT)) {
      // A turn the service cut, in a seat that lives through it: the server's row in place of the
      // service's words, which the session said as if they were its own.
      const cut = { from: SERVER, text: cutWords(seat, reply.cut, root, reply.text), cut: true };
      if (cutAsSaid(root, seat, reply.text, cut) === null) {
        append(root, seat, cut);
      }
    } else if (reply.failed) {
      // A run that cannot go on says why and then fails in the same words: one row, marked.
      if (failedAsSaid(root, seat, reply.text) === null) {
        append(root, seat, { from: seat, text: reply.text, failed: true });
      }
      if (reply.text.includes(SIGN_IN_EXPIRED) && !toldSinceAnswered(root, seat, SIGN_IN_ROW)) {
        append(root, seat, { from: SERVER, text: SIGN_IN_ROW, failed: true });
      }
    } else if (reply.interrupted) {
      // A turn the page stopped is not words the seat said: shown as stopped, not as a reply.
      append(root, seat, { from: seat, text: reply.text, interrupted: true });
    } else if (reply.silent) {
      append(root, seat, { from: seat, text: reply.text, silent: true });
    }
  });
}

// The words of the row for a frame whose session ended before reading it, naming what it was:
// a seat's message, the User's own line (the person who reads the row), or an event of the chat's.
export function undelivered(seat, of = null) {
  const what =
    of === null ? "it"
    : of.kind === "message" ? `${of.from}'s message`
    : of.kind === "user" ? "your line"
    : `the ${of.event} event`;
  return `Not delivered: ${seat} stopped before reading ${what}`;
}

// A server event for the Leader that asks nothing and that the session it went to ended before
// reading — the Leader was ending when it was queued — is delivered once more, to whatever Leader
// comes next: started now, or held with the gate, as if it had been sent a moment later. Once, so
// a Leader that dies at start is not a loop; never while the instance stops or the room parks,
// when no Leader is to be started. An event that asks something asked the session that ended.
// The ending drawn is the one the frame finally came to: an event delivered again was late, not
// lost, so it gets no Not delivered row unless it could not be delivered again either.
export function deliver(instance, seat, frame, { ask = null, written = () => {} } = {}) {
  const sent = deliverOnce(instance, seat, frame, { ask, written });
  if (sent.answered === undefined) {
    return sent;
  }
  const again = seat === leaderOf(instance) && frame.kind === "server-event" && ask === null;
  showTheEnding(
    instance.root,
    seat,
    sent.answered.then((answer) => {
      if (!again || answer?.unread !== true || instance.stopping === true || parking) {
        return answer;
      }
      log.log("redelivered", seat, null, `${frame.event.type} event, unread by the session that ended`);
      return deliverOnce(instance, seat, frame, { ask, written }).answered ?? answer;
    }),
  );
  return sent;
}

function deliverOnce(instance, seat, frame, { ask, written }) {
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
// each in arrival order — the server decides what resumes and in what order. Written once, the
// way the hold took them: whoever held a frame chained its ending and any delivery again on the
// held reply, which the release resolves, so a second chain here would write it twice more.
export function releaseHeld(instance) {
  const leader = leaderOf(instance);
  const released = quota.releasedBy();
  const ordered = [...released.filter((entry) => entry.seat === leader), ...released.filter((entry) => entry.seat !== leader)];
  for (const entry of ordered) {
    log.log("released", entry.seat, null, entry.frame.kind);
    const told = deliverOnce(instance, entry.seat, entry.frame, { ask: entry.ask, written: entry.written });
    if (told.refused !== undefined) {
      entry.resolve(unread(entry.seat, entry, `${entry.seat} has no process`));
    } else {
      told.answered.then(entry.resolve);
    }
  }
  return ordered.length;
}

// Every window that reached a stage and has reset since, told to the Leader — started for it when
// it is stopped, so work held on the window can come back. Not while the instance stops or the
// room parks: no Leader is to be started then.
export function toldResets(instance) {
  if (instance.stopping === true || isParking()) {
    return 0;
  }
  const passed = quota.resetsPassed(clockOf(instance)());
  for (const { window, model } of passed) {
    deliver(instance, leaderOf(instance), serverEvent("quota-reset", { window, ...(model === null ? {} : { model }) }));
  }
  return passed.length;
}

// ------------------------------------------------------------------------------ the wake-up call

// The Leader asks to be woken at a time, for a reason it gives: one wake-up at a time, a new one
// replacing it, held in memory as `instance.wake` = { at (ms), why }. A server stop forgets it, as
// it forgets a pending quota reset, and a park forgets both: a parked room stays parked. A Worker
// is never woken by the server; the Leader hires it again.
export const WHY_MOST = 60;
export const WAKE_REASON_RESET = "quota reset";

const clockTime = (at) => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

// When `at` says, on the server's clock: hh:mm for its next coming, a date and time for a day
// further on, or a window's key (5h, 7d, 7d-fable) for that window's reset as last read. Null when
// it says none of them.
function wakeTime(at, now) {
  if (/^\d{1,2}:\d{2}$/.test(at)) {
    const [hours, minutes] = at.split(":").map(Number);
    if (hours > 23 || minutes > 59) {
      return null;
    }
    const day = new Date(now);
    day.setHours(hours, minutes, 0, 0);
    if (day.getTime() <= now) {
      day.setDate(day.getDate() + 1);
    }
    return day.getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(at)) {
    const parsed = Date.parse(at.replace(" ", "T"));
    return Number.isNaN(parsed) ? null : parsed;
  }
  return quota.resetOf(at, now);
}

// The Leader's call: { at, why } sets, { cancel: true } takes it back, nothing answers what is set.
export function setWake(instance, { at, why, cancel } = {}) {
  const now = clockOf(instance)();
  const had = instance.wake ?? null;
  const said = (wake) => `${new Date(wake.at).toDateString()} at ${clockTime(new Date(wake.at))}, for: ${wake.why}`;
  if (cancel === true) {
    instance.wake = null;
    showWake(instance);
    return { text: had === null ? "No wake-up was set." : `Cancelled the wake-up of ${said(had)}.` };
  }
  if (at === undefined && why === undefined) {
    const reset = quota.nextReset();
    return {
      text: [
        had === null ? "No wake-up is set." : `Set: ${said(had)}.`,
        reset === null ? null : `A quota reset starts you as well, ${new Date(reset.at).toDateString()} at ${clockTime(new Date(reset.at))}.`,
      ]
        .filter((line) => line !== null)
        .join(" "),
    };
  }
  if (typeof why !== "string" || why.trim() === "") {
    return { refused: "say why: it is what you are woken with, and it shows on your panel line" };
  }
  if (why.trim().length > WHY_MOST) {
    return { refused: `why shows on your panel line: say it in ${WHY_MOST} characters or fewer` };
  }
  const when = typeof at === "string" ? wakeTime(at.trim(), now) : null;
  if (when === null) {
    return { refused: `at is hh:mm, a date and time as YYYY-MM-DD hh:mm, or a quota window's key (5h, 7d) once its reset has been read (got ${JSON.stringify(at)})` };
  }
  if (when <= now) {
    return { refused: `${new Date(when).toISOString()} has passed` };
  }
  instance.wake = { at: when, why: why.trim() };
  log.log("wake", leaderOf(instance), null, `set for ${new Date(when).toISOString()}: ${instance.wake.why}`);
  showWake(instance);
  return { text: `You will be woken ${said(instance.wake)}.${had === null ? "" : ` It replaces the one of ${said(had)}.`}` };
}

// The wake-up the Leader's panel line names: the earlier of its own call and a quota reset still
// to be answered, as { at (ISO-8601), why }, or null; a reset carries its window in words too.
export function wakeOf(instance) {
  const own = instance.wake ?? null;
  const reset = quota.nextReset();
  if (own !== null && (reset === null || own.at <= reset.at)) {
    return { at: new Date(own.at).toISOString(), why: own.why };
  }
  return reset === null ? null : { at: new Date(reset.at).toISOString(), why: WAKE_REASON_RESET, window: WINDOW_WORDS[reset.window] ?? reset.window };
}

// The page is told when what the line names changes, and only then.
export function showWake(instance) {
  const now = wakeOf(instance);
  if (JSON.stringify(now) !== JSON.stringify(instance.wakeShown ?? null)) {
    instance.wakeShown = now;
    publish("wake", now);
  }
}

// The time has come: the Leader is told why, started for it when it is stopped. Not while the
// instance stops or the room parks, as for a quota reset.
export function wakeLeader(instance) {
  const wake = instance.wake ?? null;
  if (wake === null || wake.at > clockOf(instance)() || instance.stopping === true || isParking()) {
    return false;
  }
  instance.wake = null;
  log.log("wake", leaderOf(instance), null, `woken: ${wake.why}`);
  deliver(instance, leaderOf(instance), serverEvent("wake", {}, wake.why));
  return true;
}

// ------------------------------------------------------------------------------------ long runs

// A run a seat started with `ovai run` (lib/runs.mjs) that has ended — by itself, stopped, or lost
// with its process — is told once, as `run-ended`, with the last lines of its log: to the seat
// that started it while that seat runs and is not closing, and to the Leader otherwise, started
// for it when stopped. Not while the room is parked: from a park until the Leader is next started
// by anything else, the notice waits on disk, and a Leader that needs to be up when a run ends
// parks with a wake-up set. Not while the instance stops or the room parks, either.
//
// The run's `told` is written when the frame has really reached the session — `written`, however
// long the quota gate held it — so a server restart neither loses a notice nor repeats one; a run
// that ended while the server was down is told on its first tick. One on its way is not handed
// over again; one a Worker stopped before reading is told again, to whoever runs then. The Leader's
// own unread one is delivered again by `deliver`.
//
// A run that has gone `runs.hours` is stopped here, with that reason, and told as stopped.
export const RUN_LINES = 20;

const tellingRuns = new Set();
const stoppingRuns = new Set();

export const BODY_RUN_ENDED = (run, lines, root) =>
  [
    run.state === STOPPED ? `Stopped: ${run.stopped.why}.` : null,
    run.state === LOST ? `Its process is gone and it wrote no exit: a reboot, or a kill. The same name started again resumes it: ovai run ${run.name} -- ${run.command.join(" ")}` : null,
    `Log: ${path.relative(root, logOf(root, run.seat, run.name))}${lines.length === 0 ? ", empty." : `, its last ${lines.length === 1 ? "line" : `${lines.length} lines`}:`}`,
    ...lines,
  ]
    .filter((line) => line !== null)
    .join("\n");

export function toldRuns(instance) {
  if (instance.stopping === true || isParking()) {
    return 0;
  }
  const now = clockOf(instance)();
  const { hours } = settingsIn(instance.config).runs;
  const leader = leaderOf(instance);
  let told = 0;
  for (const run of allRuns(instance.root)) {
    const key = `${instance.root}\0${run.seat}\0${run.name}`;
    if (run.state === GOING) {
      if (now - Date.parse(run.started) >= hours * 3_600_000 && !stoppingRuns.has(key)) {
        stoppingRuns.add(key);
        log.log("run", run.seat, null, `${run.name} stopped after ${hours} h`);
        stopRun(instance.root, run.seat, run.name, `it had gone ${hours} hours, the most a run may (runs.hours)`)
          .catch((error) => log.log("untold", run.seat, null, `stop run ${run.name}: ${error.message}`))
          .finally(() => stoppingRuns.delete(key));
      }
      continue;
    }
    if (run.told || tellingRuns.has(key)) {
      continue;
    }
    const record = recordOf(run.seat);
    const own = running(run.seat) && record.ending === null && !isClosing(record.askedWhy);
    const to = own ? run.seat : leader;
    if (to === leader && !running(leader) && instance.parked === true) {
      continue;
    }
    const frame = serverEvent("run-ended", { seat: run.seat, run: run.name, exit: exitWord(run) }, BODY_RUN_ENDED(run, lastLines(instance.root, run.seat, run.name, RUN_LINES), instance.root));
    tellingRuns.add(key);
    const sent = deliver(instance, to, frame, {
      written: () => {
        markTold(instance.root, run.seat, run.name);
        tellingRuns.delete(key);
      },
    });
    if (sent.refused !== undefined) {
      tellingRuns.delete(key);
      log.log("untold", to, null, `run-ended ${run.seat}/${run.name}: ${sent.refused}`);
      continue;
    }
    if (to !== leader) {
      sent.answered.then((answer) => {
        if (answer?.unread === true) {
          tellingRuns.delete(key);
        }
      });
    }
    log.log("run", to, null, `${run.seat}/${run.name} ended (${exitWord(run)}), told`);
    told += 1;
  }
  return told;
}

// The runs going, for the Leader's panel line: `{ seat, name, started }` each, oldest first. The
// page is told when the list changes, and only then.
export function runsGoing(instance) {
  return allRuns(instance.root)
    .filter((run) => run.state === GOING)
    .map(({ seat, name, started }) => ({ seat, name, started }));
}

export function showRuns(instance) {
  const now = runsGoing(instance);
  if (JSON.stringify(now) !== JSON.stringify(instance.runsShown ?? [])) {
    instance.runsShown = now;
    publish("runs", now);
  }
}

// ------------------------------------------------------------------------------ the quota stages

// Stage one: every running seat the window applies to is told, and nobody is interrupted. Stage
// two: every running Worker the window applies to is interrupted and closed, its desk given
// IDLE_GRACE minutes; the Leader is told once and not interrupted — its turns are held by the gate
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
      await close(instance, seat, "quota", { interrupt: true, deadline: IDLE_GRACE * 60, about: { window, resets, ...(model === null ? {} : { model }) } });
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
// the size the last request passed; the account's usage, which the turn has just spent; and, to
// the Leader, a line of the User's the turn put no words on the panel for. A Worker's is not told
// it: the User's line on a Worker's panel reaches the Leader already, as `user-typed`. Not by a
// turn that ends its own session: the event would be queued on a process that closes, and handed
// to whatever Leader comes next, which never read the line.
function turned(instance, record) {
  showRules(instance, record.seat);
  toldContext(instance, record);
  usage.turnEnded(instance);
  // A run the turn started, or stopped, is on the Leader's line when the turn is over.
  showRuns(instance);
  if (record.unanswered !== null && record.ending === null && roleOf(instance, record.seat) === LEADER) {
    deliver(instance, record.seat, serverEvent("unanswered", {}, BODY_UNANSWERED(instance.config.user, quota.hhmm(record.unanswered))));
  }
}

// The size the seat's last request passed, told the moment it is known — at a request of a turn
// under way or at a turn's end — once per size, never again for one already told. The stepping
// carries on above the error size; what changes there is the instruction inside the event and the
// ask it carries, never the delivery. Nothing is enforced at any size: the Leader decides when it
// restarts, and when a Worker restarts.
function toldContext(instance, record) {
  const { context } = settingsIn(instance.config);
  const passed = contextPassed(record.context, context);
  if (passed === null || (record.contextTold !== null && passed <= record.contextTold)) {
    return;
  }
  const stage = passed >= context.error ? "error" : "warning";
  // A Worker's context is the Leader's to act on, and only twice: at the warning and at the error
  // size, since each is a turn of the Leader's. The Worker is told nothing of it.
  if (roleOf(instance, record.seat) === WORKER) {
    const toldStage = record.contextTold === null ? null : record.contextTold >= context.error ? "error" : "warning";
    record.contextTold = passed;
    if (toldStage === stage) {
      return;
    }
    deliver(
      instance,
      leaderOf(instance),
      serverEvent("context", { who: record.seat, stage, context: String(record.context), error: String(context.error) }, stage === "error" ? BODY_CONTEXT_WORKER : undefined),
    );
    return;
  }
  record.contextTold = passed;
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

// One reading of the clocks: the held frames whose window reset, the resets the Leader is told, its wake-up, every seat's idle time, and
// every call stop that has timed out.
export function tick(instance) {
  releaseHeld(instance);
  toldResets(instance);
  wakeLeader(instance);
  showWake(instance);
  toldRuns(instance);
  showRuns(instance);
  const now = clockOf(instance)();
  const { idle } = settingsIn(instance.config);
  const leader = leaderOf(instance);
  // A stop is inside a turn, so no idle clock sees it: this is its own clock, from the park time.
  // A Worker's card that timed out reaches the Leader once, the call as made and never the reason
  // (one line on the Leader's turn). Not the Leader's own: the Deny has already told it.
  for (const { seat, request } of expire(now, timeoutOf, (asked) => refuse(TIMED_OUT(instance.config.user, timeoutOf(asked))))) {
    if (seat === leader) {
      continue;
    }
    const call = request.input?.command ?? request.input?.file_path ?? "";
    deliver(instance, leader, serverEvent("permission", { who: seat, minutes: String(timeoutOf(request)) }, `${request.tool}: ${call}`));
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
    // A close whose desk never came: ended at its deadline with the desk as it was last written.
    // Counted from the turn that read it, and never while a turn runs, so the deadline never cuts
    // a step; a close for idling that ends this way is the forced idle ending.
    if (isClosing(record.askedWhy) && record.closeDeadline !== null && record.turn === null && now - record.askedAt >= record.closeDeadline) {
      const why = closedAs(record.askedWhy);
      record.ending = why === "idle" ? "idle-forced" : why === "stop" ? "stop-deadline" : why;
      log.log("closed", seat, null, `${why} at the deadline, ${hhmm(record.deskWrittenAt)}`);
      end(seat, TURN_PATIENCE);
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
      if (seat === leader) {
        deliver(instance, seat, serverEvent("idle", { stage: "critical", minutes: String(idle.force) }, BODY_IDLE(idle.force)), { ask: "idle" });
      } else {
        close(instance, seat, "idle", { deadline: IDLE_GRACE * 60 }).catch((error) => log.log("untold", seat, null, `close idle: ${error.message}`));
      }
    }
  }
  allIdle(instance, leader, now, idle.all);
}

// Nobody doing anything: every Worker running, and not closing, off a turn with nothing waiting
// and idle `minutes`, and the Leader off a turn too. Told to the Leader once. It is told again only
// after a Worker has taken a turn since, which each Worker's mark says: its idle clock at the last
// telling. The Leader's own turns leave the marks alone, so the turn that reads this cannot bring
// it back a minute later. A card is on a turn. No Worker running is the Leader's resting state, and
// is told nothing: with no Worker, there is no mark that has moved.
function allIdle(instance, leader, now, minutes) {
  const workers = runningSeats()
    .filter((seat) => seat !== leader)
    .map((seat) => [seat, recordOf(seat)])
    .filter(([, record]) => record.ending === null);
  if ((recordOf(leader)?.turn ?? null) !== null) {
    return;
  }
  const quiet = ([seat, record]) => record.queue.length === 0 && (idleOf(seat, now) ?? -1) >= minutes;
  if (!workers.every(quiet) || workers.every(([, record]) => record.allIdleMark === record.idleSince)) {
    return;
  }
  for (const [, record] of workers) {
    record.allIdleMark = record.idleSince;
  }
  const names = workers.map(([seat]) => seat);
  deliver(instance, leader, serverEvent("all-idle", { workers: String(names.length) }, names.join(", ")));
}

// --------------------------------------------------------------------------------------- close

// Close a Worker: interrupted first when asked, then told `closing` with the ask `close:<why>`,
// behind what it was already given. What completes it is the Worker's own turn ending with its
// desk written since (session.mjs); what bounds it is `deadline`, in seconds counted from the turn
// that reads it, which the tick applies between turns only. Null: no deadline of its own. `about`
// is what the event says of the reason, after why: the window and its reset, for a spent one.
export async function close(instance, seat, why, { interrupt: first = false, deadline = null, about = {} } = {}) {
  if (first) {
    await interrupt(seat, { thenDrain: false });
  }
  const record = recordOf(seat);
  if (record !== undefined) {
    record.closeDeadline = deadline === null ? null : deadline * 1000;
  }
  const attrs = { why, ...about, ...(first ? { interrupted: "true" } : {}), ...(deadline === null ? {} : { deadline: String(deadline) }) };
  return deliver(instance, seat, serverEvent("closing", attrs, BODY_CLOSING(why, first, deadline)), { ask: `close:${why}` });
}

// The Leader's order to close one Worker, to stop or to restart. It answers at once with the
// deadline the close was given — the order's own, else 5 minutes after an interrupt and the park
// deadline without one — and the outcome reaches the Leader as `stopped` once the Worker has gone.
export function closeWorker(instance, seat, why, { interrupt: first = false, deadline = null } = {}) {
  const given = deadline ?? (first ? IDLE_GRACE * 60 : settingsIn(instance.config).park.deadline);
  close(instance, seat, why, { interrupt: first, deadline: given }).catch((error) => log.log("untold", seat, null, `close ${why}: ${error.message}`));
  return given;
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
    log.log("parked", null, null, "refused: already parking");
    return { refused: "already parking" };
  }
  parking = true;
  // A parked room stays parked: no reset to come starts its Leader again, and no wake-up it set,
  // and no run that ends (toldRuns) until the Leader is started by something else.
  quota.forgetResets();
  instance.wake = null;
  instance.parked = true;
  showWake(instance);
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
    log.log("parking", null, null, `${told.length} ${told.length === 1 ? "session" : "sessions"}${told.length === 0 ? "" : `: ${told.join(", ")} told`}, deadline ${seconds} s${interruptFirst ? ", interrupt" : ""}`);

    await Promise.all(
      told.map(async (seat) => {
        // A Worker is closed like any other; the park keeps its own deadline, which cuts a turn
        // where a close's never does, so the close is given none and only says the park's.
        if (seat !== leader) {
          await close(instance, seat, "park", { interrupt: interruptFirst, about: deadline === null ? {} : { deadline: String(deadline) } });
          return;
        }
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
    const result = said.length === 0 ? "nobody was running" : said.join("; ");
    log.log("parked", null, null, result);
    return { text: `parked: ${result}` };
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
    // A window that reached a stage starts the Leader at its reset, and its line says so.
    showWake(instance);
  });
  const ticking = setInterval(() => tick(instance), TICK);
  ticking.unref();
  return () => {
    offStage();
    clearInterval(ticking);
  };
}
