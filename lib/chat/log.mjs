// The server's log: one writer, one row shape.
//
// Whatever the server has to say about the room goes through here and comes out as one row of
// `runtime.log` (its stdout, when `ovai start` ran it), in fixed columns a person can read down and
// grep across:
//
//   <moment> <event> <seat> <id> <text…>
//
// moment  ISO 8601 in the machine's own zone, to the millisecond, with the offset — the clock the
//         page shows and the desks stamp with.
// event   one word, from the set below: what kind of thing happened. There are no levels; the
//         event is the level.
// seat    the session it is about, or `-` for the server itself.
// id      the tool-use id when the row is one call's — `called`, `tool` and `failed` — else `-`.
//         Fixed in place, so `grep toolu_01X` finds a call's whole life on aligned rows.
// text    the rest, free. For a call: the tool's full name as Claude Code says it
//         (`mcp__openovai__write_desk`, never the bare `write_desk`), then the command or path.
//
// Nothing that repeats: the pid, the host, the user and the version are said once, in the
// `started` row, and on no other. A text with newlines in it is as many rows, each with the same
// four columns, so every row of the file reads the same way.

import os from "node:os";

import { mask } from "../mask.mjs";

// The set, named once. A row with an event outside it is a mistake in the code, not a new kind of
// thing, and it is refused here rather than read as a fifth column later.
export const EVENTS = new Set([
  "started", // the server is up: address, pid, host, user, version
  "error", // the server could not start, or died: the reason
  "plugins", // what the instance's plugins directory yielded
  "parking", // the server is stopping and parks the room
  "parked", // how the park went
  "hired", // a Worker was started on a desk: the model, and whether the desk was new
  "retired", // a Worker's desk was filed away: the model it ran on, and where the desk went
  "called", // a session called a tool
  "tool", // the server ran one of its own tools for a session
  "failed", // a call came back as an error
  "checkpoint", // a Worker reached the number of calls the Leader set: the number
  "queued", // a frame waits for a session's turn
  "wrote", // a frame was written to a session
  "unwritten", // a frame could not be written now, and why
  "self-started", // a session began a turn the server did not write
  "unpaired", // a result came with no turn open
  "interrupt", // a session was interrupted
  "dropped", // a frame for a session with no process
  "asked", // a session waits on a permission card
  "answered", // the card was answered
  "restart", // a session restarted: the context it had, or that it could not be given a successor
  "held", // a turn held for a quota window
  "released", // a held turn let go
  "quota", // a usage window reached a stage: the percentage, the reset, the model it is one of
  "untold", // a stage could not be told to the seats
  "stop", // a stop that found no turn
  "stopped", // a session's process is gone: what it ended as; the server's own, on its way out
  "leftovers", // what a seat left running was ended with its session
  "usage", // the usage endpoint answered badly, or not at all
]);

// Where a row goes: stdout, unless a suite is listening instead. The suites run the server in
// their own process, whose stdout is the test reporter's.
let write = (row) => process.stdout.write(`${row}\n`);
export function sink(listener) {
  write = listener ?? ((row) => process.stdout.write(`${row}\n`));
}

// ---------------------------------------------------------------------------------------------
// Moments, in the machine's own zone. A row is the only thing here that carries one, so they live
// beside the row rather than in a module of their own.

function zoneOf() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function partsOf(date, zone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);
  const read = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  // A midnight is "24" in this locale's 2-digit hour; a stamp wants "00".
  read.hour = read.hour === "24" ? "00" : read.hour;
  return read;
}

// A moment written out: ISO 8601 with the offset of the machine's zone at that moment.
function stamp(date, zone) {
  const p = partsOf(date, zone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offset = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offset < 0 ? "-" : "+";
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

// The moment, to the millisecond: the stamp above — ISO with the zone's offset — with the
// milliseconds inside it, since two rows of one call can be that close.
export function moment(date = new Date()) {
  const whole = stamp(date, zoneOf());
  return `${whole.slice(0, 19)}.${String(date.getMilliseconds()).padStart(3, "0")}${whole.slice(19)}`;
}

// The moment as a panel shows it between two sessions, to the second, in the machine's zone:
// `2026.09.23 Wednesday 16:03:40` — the date, the weekday whole, the 24-hour clock, nothing else.
export function wallClock(date = new Date(), zone = zoneOf()) {
  const p = partsOf(date, zone);
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long" }).format(date);
  return `${p.year}.${p.month}.${p.day} ${weekday} ${p.hour}:${p.minute}:${p.second}`;
}

// One row, as a string, for one line of text. The columns take `-` for what a row has not got.
export function row(date, event, seat, id, text) {
  if (!EVENTS.has(event)) {
    throw new Error(`not a log event: ${event}`);
  }
  return `${moment(date)} ${event} ${seat ?? "-"} ${id ?? "-"} ${text}`;
}

// Every row masked (`../mask.mjs`): a call's row is the session's own command, a card's is what it
// asks, a failure's and a leftover's echo either, and a token in any of them would be kept here.
export function log(event, seat, id, text) {
  const at = new Date();
  for (const line of mask(text).split("\n")) {
    write(row(at, event, seat, id, line));
  }
}

// ------------------------------------------------------------------------------------ a call

// A call's rows carry one name and one id from `called` to `tool` and `failed`. The session's
// stream says the id and the full name when the call is made, and the id alone when it comes
// back; the server's own tools are run over MCP, where the request carries the bare name and no
// id at all. So the calls out are kept here, by id, from `called` until they come back, and a
// `tool` row takes the oldest one of that seat and name not yet served.
//
// Assumes the stream line saying a call was made reaches the server before the tool's MCP
// request does — it is written before Claude Code makes the request, and both come over the
// loopback. A `tool` row with nothing to pair with says `-`.
const out = new Map();

// The bare name of one of the server's own tools, as Claude Code says it.
export function fullName(toolkit, bare) {
  return `mcp__${toolkit}__${bare}`;
}

export function called(seat, { id, name, what }) {
  out.set(id, { seat, name, served: false });
  log("called", seat, id, what);
}

export function returned(id) {
  out.delete(id);
}

export function failed(seat, { id, why }) {
  const call = out.get(id);
  out.delete(id);
  log("failed", seat, id, `${call?.name ?? "-"}: ${why}`);
}

export function tool(seat, name, ms, error) {
  let id = null;
  for (const [each, call] of out) {
    if (call.seat === seat && call.name === name && !call.served) {
      id = each;
      call.served = true;
      break;
    }
  }
  log("tool", seat, id, error === null ? `${name} in ${ms} ms` : `${name} failed in ${ms} ms: ${error.message}`);
}

// A process gone takes its calls out with it: nothing will come back for them. Then the one row
// that says so, after the seat's last `tool` and `failed` rows: what it ended as, in the caller's
// word — `stop`, `restart`, `idle`, `park`, `exit 1`, `SIGKILL`.
export function ended(seat, why) {
  for (const [id, call] of out) {
    if (call.seat === seat) {
      out.delete(id);
    }
  }
  log("stopped", seat, null, why);
}

// The one row that names the process: written when the address is known.
export function started(root, url, version) {
  log("started", null, null, `serving ${root} at ${url} pid ${process.pid} host ${os.hostname()} user ${os.userInfo().username} version ${version}`);
}
