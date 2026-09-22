// The server's log: one writer, one row shape.
//
// Whatever the server has to say about the room goes through here and comes out as one row of
// `runtime.log` (its stdout, when `ovai start` ran it), in fixed columns a person can read down and
// grep across:
//
//   <moment> <event> <seat> <id> <text…>
//
// moment  ISO 8601 in the machine's own zone, to the millisecond, with the offset — the clock the
//         page shows, and the desks and the store stamp with.
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

import { stamp, zoneOf } from "../store.mjs";

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
  "queued", // a frame waits for a session's turn
  "wrote", // a frame was written to a session
  "unwritten", // a frame could not be written now, and why
  "interrupt", // a session was interrupted
  "dropped", // a frame for a session with no process
  "asked", // a session waits on a permission card
  "answered", // the card was answered
  "restart", // a session restarted: the context it had, or that it could not be given a successor
  "held", // a turn held for a quota window
  "released", // a held turn let go
  "quota", // a usage window reached a stage: the percentage, the reset, the model it is one of
  "untold", // a stage could not be told to the seats
  "store", // a store write asked the model
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

// The moment, to the millisecond: the store's stamp — ISO with the zone's offset — with the
// milliseconds inside it, since two rows of one call can be that close.
export function moment(date = new Date()) {
  const whole = stamp(date, zoneOf());
  return `${whole.slice(0, 19)}.${String(date.getMilliseconds()).padStart(3, "0")}${whole.slice(19)}`;
}

// One row, as a string, for one line of text. The columns take `-` for what a row has not got.
export function row(date, event, seat, id, text) {
  if (!EVENTS.has(event)) {
    throw new Error(`not a log event: ${event}`);
  }
  return `${moment(date)} ${event} ${seat ?? "-"} ${id ?? "-"} ${text}`;
}

export function log(event, seat, id, text) {
  const at = new Date();
  for (const line of String(text).split("\n")) {
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
