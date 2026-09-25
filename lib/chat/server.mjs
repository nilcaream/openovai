// The server: one process that hosts every session, serves the page and serves the tools.
//
// Everything that reaches a session goes through here and is framed here. The page's words
// become `<user>` frames; what one session says to another becomes `<message from="Name">`; what
// the server itself has to say becomes `<server-event>`. The server is the only writer to any
// session's stdin (session.mjs) and the only thing that frames, so a session always knows who is
// speaking and nothing inside a body can pose as a frame (frames.mjs).
//
// Every caller is known by a secret and nothing else. A session calls its tools at
// `/mcp/<secret>`, where the secret was minted for its process at spawn and dies with it; the
// server resolves it to a seat and a role and never reads a name out of a path, a body or an
// argument. The page carries a secret of its own on every call. A call with a secret the server
// does not know — never issued, revoked with a dead process, the page's on the MCP path or a
// session's on a page route — is answered with one uniform 401 and nothing else happens.
//
// Only `GET /`, the page's own assets (`GET /dialog.mjs` and its siblings, the manifest, the icons)
// and `GET /health` are open: the page and what it imports have to be reachable at one plain
// address that survives a server restart, and `ovai status` has to be able to ask whether anything
// is running. All are served on the loopback address only.
//
// The page is told what happens as it happens, on one stream (`GET /events`, events.mjs): a row
// appended, a question parked or answered, a seat started or gone, a quota reading, the
// instance stopping. The stream is the one route whose secret rides on the query, because the
// browser's EventSource carries no header; that URL is never logged.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as checkpoint from "./checkpoint.mjs";
import { SERVER, append, delivered, failedAsSaid, read } from "./conversation.mjs";
import { publish, subscribe } from "./events.mjs";
import { HOST, record } from "./runtime.mjs";
import { respond } from "./mcp.mjs";
import { answeredInput } from "./dialog.mjs";
import { acceptRule, allow, answerRule, askedFor, answer as settle, inside, parkRule, parked, refuse, ruleAskedFor, rulesPending, shapeOf } from "./permissions.mjs";
import { answerFrom } from "../plugins.mjs";
import { index as knowledgeIndex, validate as knowledgeValidate } from "../knowledge.mjs";
import { DeskError, LEADER, LEDGER, LISTS, WORKER, allowAsked, archiveFor, deskFile, hire as openDesk, isModel, isName, modelFor, nextName, retire as closeDesk, ruleAsked, headerFields, writeDeskHeader, writeModel } from "../desks.mjs";
import { TURN_PATIENCE, closedAs, end, interrupt, isClosing, isSeat, keystroke, recordOf, resume, running, runningSeats, seats, waiting } from "./session.mjs";
import { aboutSeat, adminTold, arm, closeWorker, deliver, heldLine, isParking, parkRoom, showRules, startSeat } from "./lifecycle.mjs";
import { fullName, log, tool as toolRow } from "./log.mjs";
import * as quota from "./quota.mjs";
import * as usage from "./usage.mjs";
import { messageFrame, serverEvent, userFrame } from "./frames.mjs";
import { isPageSecret, pageSecret, resolve } from "./secrets.mjs";
import { readSettings } from "../settings.mjs";
import { version } from "../version.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "page.html");
// What the page imports and links, served open beside it, since a module import carries no
// bearer: the three modules that decide what is drawn (a dialog, the panels, a row), the markdown
// parser, the manifest and its icons. Each holds nothing but a rendering; none reads the instance.
const ASSETS = Object.freeze({
  "/dialog.mjs": { file: path.join(HERE, "dialog.mjs"), type: "text/javascript; charset=utf-8" },
  "/panels.mjs": { file: path.join(HERE, "panels.mjs"), type: "text/javascript; charset=utf-8" },
  "/render.mjs": { file: path.join(HERE, "render.mjs"), type: "text/javascript; charset=utf-8" },
  "/marked.mjs": { file: path.join(HERE, "marked.mjs"), type: "text/javascript; charset=utf-8" },
  "/manifest.webmanifest": { file: path.join(HERE, "manifest.webmanifest"), type: "application/manifest+json; charset=utf-8" },
  "/icons/192.png": { file: path.join(HERE, "icons", "192.png"), type: "image/png" },
  "/icons/192-asking.png": { file: path.join(HERE, "icons", "192-asking.png"), type: "image/png" },
  "/icons/512.png": { file: path.join(HERE, "icons", "512.png"), type: "image/png" },
  "/icons/512-maskable.png": { file: path.join(HERE, "icons", "512-maskable.png"), type: "image/png" },
});
const SECRET_TAG = '<meta name="openovai-secret" content="">';

const TOOLKIT = "openovai";

const LONGEST_MESSAGE = 100_000;

const UNKNOWN = { error: "unknown secret" };

function sendJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

// The page, with its secret written into the one tag that holds it. Read on every request rather
// than once, so that an updated toolkit serves its updated page.
function sendPage(response) {
  const template = fs.readFileSync(PAGE, "utf8");
  if (!template.includes(SECRET_TAG)) {
    throw new Error("the page has nowhere to carry its secret");
  }
  const page = Buffer.from(template.replace(SECRET_TAG, `<meta name="openovai-secret" content="${pageSecret()}">`));
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": page.length,
  });
  response.end(page);
}

function sendAsset(response, { file, type }) {
  const bytes = fs.readFileSync(file);
  response.writeHead(200, {
    "content-type": type,
    "content-length": bytes.length,
  });
  response.end(bytes);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > LONGEST_MESSAGE) {
        reject(new Error("that message is too long"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

// ------------------------------------------------------------------------------------- the gate

const TOOL_ROUTE = /^\/mcp\/([^/]+)$/;

function bearer(header) {
  if (typeof header !== "string") {
    return null;
  }
  const found = /^Bearer\s+(\S+)\s*$/.exec(header);
  return found === null ? null : found[1];
}

const EVENTS_ROUTE = "/events";

// How often the server looks at the account's usage while a page is looking, in milliseconds.
export const USAGE_TICK = 5_000;

// Who is calling: a session, from the secret in the MCP path; the page, from the secret in its
// Authorization header — or, on the event stream alone, on its query, since the browser's
// EventSource sends no header; or nobody. The two kinds never cross: the page's secret is not in
// the session map, so it resolves to nothing on the MCP path, and a session's secret is never the
// page's, so it is nothing as a bearer.
function whoIs(request, url) {
  const calling = TOOL_ROUTE.exec(url.pathname);
  if (calling !== null) {
    return resolve(calling[1]);
  }
  const carried = url.pathname === EVENTS_ROUTE ? url.searchParams.get("page") : bearer(request.headers.authorization);
  return isPageSecret(carried) ? { page: true } : null;
}

// ------------------------------------------------------------------------------- starting a seat

// A seat's process is started in lifecycle.mjs and nowhere else: the Leader by whatever is
// addressed to it, a Worker by `hire` and by its own restart. Re-exported for the suite.
export { startSeat };

export { end as endSeat };

// --------------------------------------------------------------------------------- delivering

// What a seat says lands on its panel as it says it (lifecycle.mjs, `said`); what is left for
// the end of the turn is how it ended when that was not with words: a process gone before it
// answered, a run that failed, a turn the page stopped, a turn that said nothing at all. A turn
// that held several frames answers every one of them with the one reply, and that is one row.
const shownEndings = new WeakSet();

function showTheEnding(root, seat, answered) {
  answered.then((reply) => {
    if (shownEndings.has(reply)) {
      return;
    }
    shownEndings.add(reply);
    if (reply.unread === true) {
      // The process ended before the frame was ever written: what the panel shows as waiting was
      // never read, and the row says so.
      append(root, seat, { from: SERVER, text: undelivered(seat), failed: true });
    } else if (reply.ended === true) {
      append(root, seat, { from: SERVER, text: reply.err === "" ? `${seat} stopped before answering` : `${seat} stopped before answering: ${reply.err}`, failed: true });
    } else if (reply.failed) {
      // A run that cannot go on says why and then fails in the same words: one row, marked.
      if (failedAsSaid(root, seat, reply.text) === null) {
        append(root, seat, { from: seat, text: reply.text, failed: true });
      }
    } else if (reply.interrupted) {
      // A turn the page stopped is not words the seat said: shown as stopped, not as a reply.
      append(root, seat, { from: seat, text: reply.text, interrupted: true });
    } else if (reply.silent) {
      append(root, seat, { from: seat, text: reply.text, silent: true });
    }
  });
}

// The words of the row for a frame whose session ended before reading it.
export function undelivered(seat) {
  return `Not delivered: ${seat} stopped before reading it`;
}

// After a stop: how many frames wait and what they are — the User's own line, a message from a
// seat, or an event of the chat's — each with the time it was told, so a seat that is busy again
// at once is seen to be busy with something older than the press. One goes in as itself; more go
// in as one turn, named in the order they go in.
function stoppedLine(waits) {
  if (waits.length === 0) {
    return "Stopped; nothing waiting";
  }
  const named = waits.map(
    (next) =>
      `${
        next.kind === "message" ? `message from ${next.from}`
        : next.kind === "user" ? "line from the User"
        : `${next.event} event from the Server`
      } (${quota.hhmm(next.at)})`,
  );
  return waits.length === 1 ? `Stopped; 1 waiting, next: ${named[0]}` : `Stopped; ${waits.length} waiting, going in as one: ${named.join(", ")}`;
}

// What the User typed onto a panel. The words are the User's own turn to that seat, and when the
// seat is a Worker the Leader is told the fact — once, as a server event — so nothing has to be
// reported by hand. A frame held by the quota gate is said so on the panel, once, with when the
// window resets; the reply lands when it eventually goes.
//
// The User's line goes in with what waits on the seat — messages, events — in the order it all
// arrived, and the whole of it in one turn the moment the seat is free: a seat with a backlog
// reads the User's line in the same write as the backlog, never after working through it.
function typed(instance, seat, text) {
  const root = instance.root;
  // The row waits on the panel until the frame it became is written to the process — behind the
  // turn under way, or a closed window — and reads delivered from then on.
  const index = append(root, seat, { from: "user", text });
  const told = deliver(instance, seat, userFrame(text), { written: () => delivered(root, seat, index) });
  if (told.refused !== undefined) {
    // A seat with no process, or a Leader the chat could not spawn: the second is refused in a
    // sentence of its own, saying what fetches the claude it runs on, and that is the row.
    append(root, seat, { from: SERVER, text: told.refused === "no process" ? `${seat} has no process` : told.refused, failed: true });
  } else {
    showTheEnding(root, seat, told.answered);
  }

  let leaderTold = false;
  if (seat !== instance.config.leader) {
    const leader = instance.config.leader;
    append(root, leader, { from: "user", typedTo: seat, text });
    const woken = deliver(instance, leader, serverEvent("user-typed", { who: seat }, text));
    leaderTold = woken.refused === undefined;
    if (leaderTold) {
      showTheEnding(root, leader, woken.answered);
    }
  }

  return {
    delivered: told.delivered === true,
    ...(told.held === undefined ? {} : { held: told.held }),
    ...(seat === instance.config.leader ? {} : { leaderTold }),
  };
}

// --------------------------------------------------------------------------------------- tools

// Which roles each tool is offered to. A tool not offered to the caller's role is not listed and
// answers a call with its refusal, which is what keeps a session from reaching for what is not
// its to use.
const OFFERED_TO = {
  message: [LEADER, WORKER],
  room: [LEADER, WORKER],
  index: [LEADER, WORKER],
  validate: [LEADER, WORKER],
  write_desk: [LEADER, WORKER],
  done: [WORKER],
  restart_session: [LEADER],
  stop_session: [LEADER],
  stop_worker: [LEADER],
  restart_worker: [LEADER],
  park: [LEADER],
  hire: [LEADER],
  retire: [LEADER],
  permission: [LEADER],
};

// The completion of a restart or a stop: the desk must have been written since the server asked,
// or since this turn began; then the process is marked, answered, and ended on the server's clock
// — stdin closed, so the harness ends after the running turn, taken down after TURN_PATIENCE.
function endOwn(instance, caller, ending, answer) {
  const record = recordOf(caller.seat);
  if (record === undefined) {
    return { refused: "you have no process" };
  }
  if (record.ending !== null) {
    return { refused: "already ending" };
  }
  const since = Math.max(record.askedAt ?? 0, record.turnBegan ?? 0);
  if (record.deskWrittenAt === null || record.deskWrittenAt < since) {
    return { refused: "write your desk first (write_desk)" };
  }
  const asked = isClosing(record.askedWhy) ? closedAs(record.askedWhy) : record.askedWhy;
  record.ending = ending === "stop" ? (asked === "restart" ? "stop" : (asked ?? "stop")) : ending;
  // After this answer has gone back: the tool result travels its own connection, but a process
  // whose stdin closed first could end before reading it.
  setImmediate(() => {
    end(caller.seat, TURN_PATIENCE);
  });
  return { text: answer };
}

// The Leader's order to close one Worker: refused as a value in the order the tool says, else the
// close is under way and the answer says what happens next.
function closeOrder(instance, args, why) {
  const name = args?.name;
  if (!isName(name)) {
    return { refused: `${JSON.stringify(name)} is not a name here` };
  }
  if (name === instance.config.leader) {
    return { refused: `${name} is the Leader` };
  }
  if (!fs.existsSync(deskFile(instance.root, name))) {
    return { refused: `${name} has no desk here` };
  }
  if (!running(name)) {
    return { refused: `${name} is not running` };
  }
  if (instance.stopping === true) {
    return { refused: "the server is stopping" };
  }
  if (isParking()) {
    return { refused: "the room is parking" };
  }
  if (recordOf(name).ending !== null) {
    return { refused: `${name} is already ending` };
  }
  const deadline = args?.deadline;
  if (deadline !== undefined && (!Number.isInteger(deadline) || deadline < 5)) {
    return { refused: "deadline is a whole number of seconds, at least 5" };
  }
  const given = closeWorker(instance, name, why, { interrupt: args?.interrupt === true, deadline: deadline ?? null });
  const then = why === "restart" ? "a successor starts on its desk" : "its desk stays";
  return {
    text: `${name} is told to write its desk and goes when that turn is over; ${then}. With no desk written within ${given} s of reading this, it goes with the desk as it is. You are told with a stopped event.`,
  };
}

// What a closing order takes: the Worker, and how hard.
const CLOSE_ORDER = {
  type: "object",
  properties: {
    name: { type: "string", description: "The Worker, running." },
    interrupt: { type: "boolean", description: "Interrupt its turn first. Default false: it is told when the turn it is on is over." },
    deadline: { type: "integer", minimum: 5, description: "Seconds its desk may take, counted from when it reads the order. Default: 300 with interrupt, the instance's park.deadline without." },
  },
  required: ["name"],
  additionalProperties: false,
};

// The tools a caller is served, with the caller bound into every one of them: a tool never reads
// who is calling from its arguments, because the server already knows.
export function toolsFor(instance, caller) {
  const offered = (name) => OFFERED_TO[name].includes(caller.role);
  const root = instance.root;

  return [
    {
      name: "message",
      description:
        "Say something to another session here. Give it who to say it to and what to say; it comes back as soon as they have it, and whatever they say back arrives later as a message from them.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "who to say it to" },
          text: { type: "string", description: "what to say" },
          ...(caller.role === LEADER
            ? {
                checkpoint: {
                  type: "integer",
                  minimum: 1,
                  description:
                    "for an order to a Worker: after this many tool calls the server tells the Worker to report where it stands and carry on, and tells you; replaces a checkpoint still pending",
                },
                urgent: {
                  type: "boolean",
                  description:
                    "for special cases only: the message reaches the Worker in the middle of its turn, at its next tool call, as a line the User types does; without it a message waits for the turn to end",
                },
              }
            : {}),
        },
        required: ["to", "text"],
      },
      offered: offered("message"),
      async run(args) {
        if (!offered("message")) {
          return { refused: "message is not offered to you" };
        }
        const to = args?.to;
        const text = args?.text;
        const calls = args?.checkpoint;
        const urgent = args?.urgent;
        if (!isName(to)) {
          return { refused: `nobody called ${to} works here` };
        }
        if (typeof text !== "string" || text.trim() === "") {
          return { refused: "a message needs some text" };
        }
        // A checkpoint is the Leader's to set, on an order to a Worker — the one seat that is not
        // the Leader's own, which is refused below as it is for any message.
        if (calls !== undefined && caller.role !== LEADER) {
          return { refused: "a checkpoint is the Leader's to set" };
        }
        if (calls !== undefined && !(Number.isInteger(calls) && calls >= 1)) {
          return { refused: "a checkpoint is a whole number of calls, at least 1" };
        }
        // So is urgent: a word into a Worker's turn under way, which no Worker may put into
        // another's, nor into the Leader's.
        if (urgent !== undefined && caller.role !== LEADER) {
          return { refused: "urgent is the Leader's to set" };
        }
        // The call is a row on the caller's own log — who it went to, the words, and what
        // became of it — written once, as soon as that is known: `refused` when a rule stopped
        // it before anything was attempted, `not sent` when it was attempted and nobody could
        // take it, `sent` once the seat has it. A message with no name to go to, or nothing in
        // it, is no message and leaves no row.
        if (!isSeat(instance, to)) {
          append(root, caller.seat, { from: caller.seat, to, text, outcome: "not sent", why: `nobody called ${to} works here` });
          return { refused: `nobody called ${to} works here` };
        }
        if (to === caller.seat) {
          append(root, caller.seat, { from: caller.seat, to, text, outcome: "refused", why: "that is you" });
          return { refused: "that is you" };
        }
        const told = deliver(instance, to, messageFrame(caller.seat, text, { urgent: urgent === true }));
        if (told.refused !== undefined) {
          append(root, caller.seat, { from: caller.seat, to, text, outcome: "not sent", why: `${to} has no process` });
          return { refused: `${to} has no process` };
        }
        // A message that went is one thing on two logs, under one id: the page takes a click on
        // the line the Worker's panel draws for it to the row the Leader's panel draws for it.
        if (calls !== undefined) {
          checkpoint.set(to, calls);
        }
        const msg = crypto.randomUUID();
        const marked = urgent === true ? { urgent: true } : {};
        append(root, caller.seat, { from: caller.seat, to, text, outcome: "sent", msg, ...marked });
        append(root, to, { from: caller.seat, to, text, msg, ...marked });
        // A word between two Workers is heard by the Leader the way a line the User types on a
        // Worker's panel is: a row on the Leader's panel — `<sender> → <addressee>` and the words,
        // under the same id, so a click on either Worker's line finds it — and a server event on
        // the Leader's next turn. Told, not asked: nothing waits on the Leader, and the addressee
        // has its message already. A message to or from the Leader is heard already.
        const leader = instance.config.leader;
        if (caller.seat !== leader && to !== leader) {
          append(root, leader, { from: caller.seat, to, text, msg, overheard: true });
          const woken = deliver(instance, leader, serverEvent("overheard", { from: caller.seat, to }, text));
          if (woken.refused === undefined) {
            showTheEnding(root, leader, woken.answered);
          }
        }
        // The call comes back the moment the seat has the message: the caller's turn goes on,
        // and what the addressee says at the end of its own turn is its own — on its panel, and
        // for whoever it wants to reach, a message the other way. Nobody's turn is held for
        // anybody else's. A message held by the quota gate goes when the window resets.
        showTheEnding(root, to, told.answered);
        // A message whose session ended before reading it goes back to whoever sent it: a row on
        // the sender's panel, and the words as they were, in an event on its next turn. A Leader
        // that is not running is started by it; a Worker with none is not, and `deliver` drops the
        // event with a row in the log.
        told.answered.then((reply) => {
          if (reply.unread !== true) {
            return;
          }
          append(root, caller.seat, { from: SERVER, text: undelivered(to), failed: true });
          const back = deliver(instance, caller.seat, serverEvent("undelivered", { to }, text));
          if (back.refused === undefined) {
            showTheEnding(root, caller.seat, back.answered);
          }
        });
        if (told.held !== undefined) {
          return { text: `${to} has it. ${heldLine(told.held)}` };
        }
        return { text: `sent to ${to}` };
      },
    },
    {
      name: "room",
      description: "Who works here: every seat, its role, what it runs on, whether it is running, and which one is you.",
      inputSchema: { type: "object", properties: {} },
      offered: offered("room"),
      run() {
        if (!offered("room")) {
          return { refused: "room is not offered to you" };
        }
        return {
          text: JSON.stringify({
            seats: seats(instance).map((seat) => ({ ...aboutSeat(instance, seat), you: seat.name === caller.seat })),
            standing: quota.standing(),
          }),
        };
      },
    },
    // Knowledge: the notes under `knowledge/`, read through these two and written with the file
    // tools every seat already has. Neither holds anything between calls — both read the directory
    // as it stands, so a note edited a moment ago is a note the next call sees. `index` says what
    // is there and judges none of it; `validate` judges all of it and says what to fix.
    {
      name: "index",
      description:
        "`index()` — the header: how many notes, when the directory last changed, every tag with its count, and files that could not be read. Call it first, to learn which tags exist before you search or write.\n`index(tags)` — matches on tags only: a note is returned when it carries at least one of the given tags. Each result is one note: filename, its tags, its summary. Notes carrying more of the given tags come first. Filenames and summaries are not searched; for words, grep `knowledge/`.",
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" }, description: "Tags to match: a note carrying any one of them is returned. Left out, the header." },
        },
        additionalProperties: false,
      },
      offered: offered("index"),
      run(args) {
        if (!offered("index")) {
          return { refused: "index is not offered to you" };
        }
        return { text: knowledgeIndex(root, args?.tags) };
      },
    },
    {
      name: "validate",
      description:
        "Check every note under `knowledge/` against the contract: the head's four fields and nothing else, a summary, at least three lowercase hyphenated tags with no duplicates, sources that are paths from the instance root or URLs or `<user>`, a date that is not in the future, and a lowercase hyphenated filename. One line per problem, saying the rule it breaks, and a count at the end; when there is nothing to fix, the count alone. It checks the whole directory rather than one note, and it changes nothing. Call it after you write or edit a note, and fix what it reports before you go on.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      offered: offered("validate"),
      run() {
        if (!offered("validate")) {
          return { refused: "validate is not offered to you" };
        }
        return { text: knowledgeValidate(root) };
      },
    },
    {
      name: "write_desk",
      description: `Write the header of your own desk, desks/<you>/STATE.md: title (one line, up to 120 characters — what you are on) and status (one line, up to 80 characters, no |). The header is line 1 and the server's; everything below it is yours, edited in place with the file tools like any other file, and this call leaves it exactly as it stands. Edit the body first, then call this: it is what says the desk is current, and ${
        caller.role === WORKER
          ? "when your session is closing, it is what lets it close: the session ends when the turn you called this in is over"
          : "restart_session and stop_session refuse until it was called since the event that asked, or since this turn"
      }. Refused: an empty title or status, a newline in either, a | in status, any other key.`,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "What you are on, one line, up to 120 characters." },
          status: { type: "string", description: "Where it stands, one line, up to 80 characters, no |." },
        },
        required: ["title", "status"],
        additionalProperties: false,
      },
      offered: offered("write_desk"),
      run(args) {
        if (!offered("write_desk")) {
          return { refused: "write_desk is not offered to you" };
        }
        const fields = headerFields(args ?? {});
        if (fields.refused !== undefined) {
          return fields;
        }
        const record = recordOf(caller.seat);
        const written = writeDeskHeader(root, caller.seat, fields);
        if (written === null) {
          return { refused: `you have no desk file at desks/${caller.seat}/STATE.md` };
        }
        if (record !== undefined) {
          record.deskWrittenAt = (instance.clock ?? Date.now)();
        }
        return { text: `desk header written: desks/${caller.seat}/STATE.md (title and status; the body as it stands)` };
      },
    },
    {
      name: "restart_session",
      description:
        "End your process and start a successor on your desk. Write your desk with write_desk first: this refuses until the desk was written since the event that asked (context) or since this turn began. Whatever is queued for you goes to the successor, which starts from the desk. After it answers, nothing you say changes what happens.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      offered: offered("restart_session"),
      run() {
        if (!offered("restart_session")) {
          return { refused: "restart_session is not offered to you" };
        }
        return endOwn(instance, caller, "restart", "restarting; your successor starts from your desk");
      },
    },
    {
      name: "stop_session",
      description:
        "End your process and its panel; your desk stays. Write your desk with write_desk first: this refuses until the desk was written since the event that asked (quota-low, idle, park) or since this turn began. After it answers, nothing you say changes what happens.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      offered: offered("stop_session"),
      run() {
        if (!offered("stop_session")) {
          return { refused: "stop_session is not offered to you" };
        }
        return endOwn(instance, caller, "stop", "stopping; your desk stays");
      },
    },
    {
      name: "done",
      description:
        "Say that the work you were given is done and you are ready to close: the Leader is told, with the note if you give one, and decides whether you stop. It is not the report — that still goes as a message — and it ends nothing: keep your desk current, and when you are told your session is closing, write it once more.",
      inputSchema: {
        type: "object",
        properties: {
          note: { type: "string", description: "One line, up to 200 characters: what is done." },
        },
        additionalProperties: false,
      },
      offered: offered("done"),
      run(args) {
        if (!offered("done")) {
          return { refused: "done is not offered to you" };
        }
        const note = args?.note ?? "";
        if (typeof note !== "string" || note.includes("\n") || note.length > 200) {
          return { refused: "note is one line, up to 200 characters" };
        }
        const leader = instance.config.leader;
        const told = deliver(instance, leader, serverEvent("done", { who: caller.seat }, note === "" ? undefined : note));
        if (told.refused === undefined) {
          showTheEnding(root, leader, told.answered);
        }
        return { text: `${leader} is told you are done` };
      },
    },
    {
      name: "stop_worker",
      description:
        "Stop one Worker: it is told its session is closing, writes its desk, and goes when that turn is over — never in the middle of one, unless interrupt is true, which cuts the turn it is on first. It goes with its desk as it is when the deadline passes with no desk written. Answers at once; you are told with a stopped event when it has gone. Refused: a name that is not one; the Leader's own name; a name with no desk; a Worker not running or already ending; while the room is parking; while the server is stopping.",
      inputSchema: CLOSE_ORDER,
      offered: offered("stop_worker"),
      run(args) {
        if (!offered("stop_worker")) {
          return { refused: "stop_worker is not offered to you" };
        }
        return closeOrder(instance, args, "stop");
      },
    },
    {
      name: "restart_worker",
      description:
        "Restart one Worker on its desk: as stop_worker, and then a successor starts from the desk, with whatever was queued for the Worker. For a Worker whose context is past the wrap-up size, at a moment that suits its work. Answers at once; you are told with a stopped event when the successor has started. Refused as stop_worker is.",
      inputSchema: CLOSE_ORDER,
      offered: offered("restart_worker"),
      run(args) {
        if (!offered("restart_worker")) {
          return { refused: "restart_worker is not offered to you" };
        }
        return closeOrder(instance, args, "restart");
      },
    },
    {
      name: "park",
      description:
        "Park the room: every running Worker is told its session is closing and writes its desk (interrupted first when interrupt is true), and this waits until each has gone or the deadline (seconds, at least 5; the instance's park.deadline when not given) passes, ending at the deadline whoever has not. Answers who stopped and who was ended, with when each desk was written. Then write your own desk and call stop_session. Refused: while a park is under way; while the server is stopping.",
      inputSchema: {
        type: "object",
        properties: {
          interrupt: { type: "boolean", description: "Interrupt every Worker's turn before telling it. Default false." },
          deadline: { type: "integer", minimum: 5, description: "Seconds to wait before ending whoever has not stopped." },
        },
        additionalProperties: false,
      },
      offered: offered("park"),
      async run(args) {
        if (!offered("park")) {
          return { refused: "park is not offered to you" };
        }
        if (instance.stopping === true) {
          return { refused: "the server is stopping" };
        }
        if (isParking()) {
          return { refused: "already parking" };
        }
        const interruptFirst = args?.interrupt === true;
        const deadline = args?.deadline;
        if (deadline !== undefined && (!Number.isInteger(deadline) || deadline < 5)) {
          return { refused: "deadline is a whole number of seconds, at least 5" };
        }
        return parkRoom(instance, { interrupt: interruptFirst, deadline: deadline ?? null });
      },
    },
    {
      name: "hire",
      description:
        "Start a Worker on a desk. Called with no name, the Worker is called by the next free name of the roster; a name is for starting somebody who has a desk again — somebody who stopped — on it, panel log kept. Model when not the usual one; on a desk somebody had, a model given replaces the desk's, and left out, the desk's stands. Refused: a name that is not one (a letter, then up to 31 letters, digits, _ or -); already running; while the quota gate holds hires (from the first stage of a window, until it resets); while the server is stopping; a name whose panel log exists without a desk.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Who to start again, when somebody who has a desk. Left out, the roster says who the new Worker is." },
          model: { type: "string", description: "The model, when not the usual one. On a desk somebody had, it replaces the desk's model." },
        },
        additionalProperties: false,
      },
      offered: offered("hire"),
      run(args) {
        if (!offered("hire")) {
          return { refused: "hire is not offered to you" };
        }
        const model = args?.model ?? null;
        // Named nobody, the roster names the Worker: the least recently used free name.
        let name = args?.name;
        if (name === undefined) {
          try {
            name = nextName(root);
          } catch (error) {
            if (error instanceof DeskError) {
              return { refused: error.message };
            }
            throw error;
          }
        } else if (!isName(name)) {
          return { refused: `${JSON.stringify(name)} is not a name here` };
        }
        if (model !== null && !isModel(model)) {
          return { refused: `${JSON.stringify(model)} is not a model identifier` };
        }
        if (name === instance.config.leader) {
          return { refused: `${name} is the Leader` };
        }
        if (running(name)) {
          return { refused: `${name} is already running` };
        }
        if (instance.stopping === true) {
          return { refused: "the server is stopping" };
        }
        const held = quota.holdsHire(model ?? modelFor(root, name, instance.config));
        if (held !== null) {
          return { refused: `held: quota (${held.window} resets ${held.resets})` };
        }
        const hadDesk = fs.existsSync(deskFile(root, name));
        if (!hadDesk) {
          try {
            openDesk(root, name, model);
          } catch (error) {
            if (error instanceof DeskError) {
              return { refused: error.message };
            }
            throw error;
          }
        } else if (model !== null) {
          // Back on the desk it had, on the model given now: the Leader's word replaces the one
          // the desk was hired on before. Left out, the desk's own stands.
          writeModel(root, name, model);
        }
        startSeat(instance, name);
        const runs = modelFor(root, name, instance.config);
        // The row that says a session began — the log had the stop and not the start. What the
        // Worker runs on, and whether this is a new desk or somebody back on the one they had,
        // which is the question the desk was tested for a line above. After the process is
        // started, so a hire that refused writes none.
        log("hired", name, null, `${runs} on ${hadDesk ? "the desk it had" : "a new desk"}`);
        return { text: `${name} started on the desk desks/${name} (${runs})` };
      },
    },
    // The other end of a hire: a Worker whose round is done leaves the room, and its name goes
    // back to the roster. The desk is filed, never deleted — desks.mjs moves the directory whole
    // — and the seat is gone from the room and the page the moment it is, since both read desks/.
    {
      name: "retire",
      description:
        "File a stopped Worker's desk away: desks/<Name>/ is moved whole — the desk, the conversation, the persona, the model when one was named — under archive/<day>-<Name>-<slug of the final title>/, the rule that let the Worker write there is withdrawn, the seat leaves the room and the page, and the name is free for the roster again. For a Worker whose round is done; one that may be wanted back on the same desk is stopped, not retired. Refused: a name that is not one; the Leader's own name; a name with no desk; a Worker still running (stop it first: stop_worker, or park); while the server is stopping.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Whose desk to file away: a Worker that has stopped." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      offered: offered("retire"),
      run(args) {
        if (!offered("retire")) {
          return { refused: "retire is not offered to you" };
        }
        const name = args?.name;
        if (!isName(name)) {
          return { refused: `${JSON.stringify(name)} is not a name here` };
        }
        if (name === instance.config.leader) {
          return { refused: `${name} is the Leader` };
        }
        if (!fs.existsSync(deskFile(root, name))) {
          return { refused: `${name} has no desk here` };
        }
        if (running(name)) {
          return { refused: `${name} is running; stop it first` };
        }
        if (instance.stopping === true) {
          return { refused: "the server is stopping" };
        }
        // What it ran on, read while the desk is still there: the model a desk names is the
        // desk's, and once it is filed the name answers with the workspace's default instead.
        const ran = modelFor(root, name, instance.config);
        const { at, where } = archiveFor(root, name);
        closeDesk(root, name, at);
        log("retired", name, null, `${ran}, filed under ${where}`);
        // A frame the quota gate held for the seat would be written to a panel that no longer
        // exists when the window resets — and a row on it would open desks/<Name>/ again, a
        // conversation left behind under a name just freed.
        quota.drop(name);
        // The page draws the seats the snapshot lists and drops the rest, so the panel goes now
        // rather than at the next reload.
        publish("snapshot", snapshot(instance));
        return { text: `${name} filed under ${where}` };
      },
    },
    // What the instance may do is settled in words, and the words are the User's: the Leader asks
    // with this, the User presses, the press is written for every session by the one writer
    // (postPermission below) and reaches the Leader as an event. The tool never writes a rule.
    {
      name: "permission",
      description:
        "Ask the User, on your panel, to settle one rule for the whole instance: rule is a Claude Code permission rule as its reference spells it - Bash(word:*) or Bash(git push:*) for a command by prefix, Bash(the whole command) for one command exactly (a program by its path, env, a pipe side or find -exec each need that), Edit(/dir/**) or Read(/dir/**) for a directory under the instance root, Read(//dir/**) for a directory outside it, WebFetch(domain:host) for a host, WebSearch, mcp__server__tool or mcp__server__* for a server's tools, Agent(Name) for a subagent, or a bare tool name for every use of it - and why is what the User reads beside it. The card has Allow, Deny and Ask; the press is written for every session, current and future, and reaches you as a server-event of type permission. Called with no rule, answers every rule the instance holds and every card still pending. Refused: a rule without why; a rule Claude Code would not read (a path on Write, Glob or NotebookEdit, mcp__* or any glob before the server's name, a star in the middle of a command, a path outside the instance for anything but Read); a rule already held or already pending.",
      inputSchema: {
        type: "object",
        properties: {
          rule: { type: "string", description: "The rule, as Claude Code's reference spells it: Bash(word:*), Bash(the whole command), Edit(/dir/**), Read(/dir/**), Edit(/dir/file) or Read(/dir/file) for one file, Read(//dir/**), WebFetch(domain:host), WebSearch, mcp__server__tool, Agent(Name), or a bare tool name." },
          why: { type: "string", description: "What the User reads beside it." },
        },
        additionalProperties: false,
      },
      offered: offered("permission"),
      run(args) {
        if (!offered("permission")) {
          return { refused: "permission is not offered to you" };
        }
        const rule = args?.rule;
        const why = args?.why;
        if (rule === undefined && why === undefined) {
          return { text: JSON.stringify(rulesHeld(instance, caller.seat)) };
        }
        if (typeof rule !== "string" || rule.trim() === "") {
          return { refused: "rule is the rule to settle, in Claude Code's shape" };
        }
        if (typeof why !== "string" || why.trim() === "") {
          return { refused: "say why: the User reads it on the button" };
        }
        const accepted = acceptRule(rule.trim(), root);
        if (accepted === null) {
          return { refused: `${rule} is not a rule Claude Code reads: Bash(word:*) or Bash(the whole command), Edit(/dir/**) or Read(/dir/**) under the instance root, Edit(/dir/file) or Read(/dir/file) for one file there, Read(//dir/**) outside it, WebFetch(domain:host), WebSearch, mcp__server__tool, Agent(Name), or a bare tool name` };
        }
        const permissions = readSettings(root).permissions ?? {};
        const held = LISTS.find((list) => Array.isArray(permissions[list]) && permissions[list].includes(accepted));
        if (held !== undefined) {
          return { refused: `${accepted} is already ${SETTLED_AS[held]} - say it to the User` };
        }
        if (rulesPending(caller.seat).some((pending) => pending.rule === accepted)) {
          return { refused: `${accepted} is already asked on your panel` };
        }
        const id = parkRule(caller.seat, { rule: accepted, why: why.trim(), from: caller.seat, turn: turnOf(caller.seat) }, (instance.clock ?? Date.now)());
        showRules(instance, caller.seat);
        return { text: `asked on your panel: ${accepted} (${id})` };
      },
    },
    ...instance.plugins.map((plugin) => ({
      name: plugin.name,
      description: plugin.description,
      inputSchema: plugin.inputSchema,
      async run(args) {
        return answerFrom(plugin.name, await plugin.run(args, { seat: caller.seat, role: caller.role, root, config: instance.config }));
      },
    })),
  ];
}

// How a settled rule is said: the list it is in, as a word the Leader can repeat to the User.
const SETTLED_AS = { allow: "allowed", deny: "denied", ask: "asked every time" };

// What the instance holds, for the tool called with no rule: the three lists as the settings
// hold them, each rule with its ledger line when the ledger has one, and the dialogs still
// pending on the caller's panel. A tool answer, never a procedure: nothing is tripped and no
// settings file is read by a session.
function rulesHeld(instance, seat) {
  const permissions = readSettings(instance.root).permissions ?? {};
  let ledger = [];
  try {
    ledger = fs.readFileSync(path.join(instance.root, LEDGER), "utf8").split("\n");
  } catch {
    ledger = [];
  }
  const lineFor = (rule, list) => ledger.find((line) => line.startsWith(`- \`${rule}\` (${list}) `)) ?? null;
  const listed = Object.fromEntries(
    LISTS.map((list) => [list, (Array.isArray(permissions[list]) ? permissions[list] : []).map((rule) => ({ rule, ...(lineFor(rule, list) === null ? {} : { line: lineFor(rule, list) }) }))]),
  );
  return { ...listed, pending: rulesPending(seat).map(({ rule, why }) => ({ rule, why })) };
}

// Every call of the instance's own tools is timed here, at the one place they are dispatched, so
// a slow call and a stuck seat can be told apart while watching: the log gets a `tool` row —
// the tool's full name, `in N ms`, or `failed in N ms: <why>` when it threw — under the id of the
// `called` row it answers, and the seat's panel gets a row
// of the chat's once a call took ten seconds or more, the same threshold as the wait on a card,
// in the milliseconds the log counts in. A call under that draws nothing: the row explains a gap,
// and there is none.
export const SLOW_SAID_FROM = 10000;
function timed(instance, seat, tools) {
  const clock = instance.clock ?? Date.now;
  return tools.map((tool) => ({
    ...tool,
    async run(args) {
      const began = clock();
      let failed = null;
      try {
        return await tool.run(args);
      } catch (error) {
        failed = error;
        throw error;
      } finally {
        const ms = clock() - began;
        toolRow(seat, fullName(TOOLKIT, tool.name), ms, failed);
        if (ms >= SLOW_SAID_FROM) {
          append(instance.root, seat, { from: SERVER, text: `The ${tool.name} tool took ${(ms / 1000).toFixed(1)} seconds` });
        }
      }
    },
  }));
}

async function postTool(instance, caller, request, response) {
  let asked;
  try {
    asked = JSON.parse(await readBody(request));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }
  const { status, body } = await respond(asked, {
    name: TOOLKIT,
    version: version(instance.root) ?? "unknown",
    tools: timed(instance, caller.seat, toolsFor(instance, caller)),
  });
  if (body === null) {
    response.writeHead(status).end();
    return;
  }
  sendJson(response, status, body);
}

// --------------------------------------------------------------------------------- page routes

const SESSION_ROUTE = /^\/sessions\/([^/]+)\/(messages|message|permissions|permission|stop|typing)$/;

async function postMessage(instance, seat, request, response) {
  let text;
  try {
    ({ text } = JSON.parse(await readBody(request)));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }
  if (typeof text !== "string" || text.trim() === "") {
    sendJson(response, 400, { error: "a message needs some text" });
    return;
  }
  sendJson(response, 200, typed(instance, seat, text));
}

async function postPermission(instance, seat, request, response) {
  let id;
  let decision;
  let why;
  let answers;
  try {
    ({ id, decision, why, answers } = JSON.parse(await readBody(request)));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }
  if (typeof id !== "string" || id.trim() === "") {
    sendJson(response, 400, { error: "which request is being answered" });
    return;
  }

  // A rule request: the id is one the tool parked. The press is the User's last word on that
  // rule — written for every session, current and future, by the one writer — and the Leader is
  // told what was pressed, as an event, which starts it if it has stopped.
  const asked = ruleAskedFor(seat, id);
  if (asked !== undefined) {
    if (!LISTS.includes(decision)) {
      sendJson(response, 400, { error: "a decision on a rule is allow, deny or ask" });
      return;
    }
    ruleAsked(instance.root, {
      rule: asked.rule,
      list: decision,
      session: asked.from,
      call: asked.why,
      day: new Date().toISOString().slice(0, 10),
    });
    answerRule(seat, id);
    const leader = instance.config.leader;
    const woken = deliver(instance, leader, serverEvent("permission", { decision, who: seat }, asked.rule));
    if (woken.refused === undefined) {
      showTheEnding(instance.root, leader, woken.answered);
    }
    sendJson(response, 200, { answered: id, decision, settled: asked.rule });
    return;
  }

  if (decision !== "allow" && decision !== "deny" && decision !== "always" && decision !== "answer") {
    sendJson(response, 400, { error: "a decision on a call is allow, deny, always or answer" });
    return;
  }

  // An answer: the question goes ahead carrying what the User said. A plain allow would run it
  // with no answers, which the tool reports to the session as the User not answering.
  if (decision === "answer") {
    const asked = askedFor(seat, id);
    if (asked === undefined) {
      sendJson(response, 409, { error: "nothing is waiting on that any more" });
      return;
    }
    const updated = answeredInput(asked, answers);
    if (updated === null) {
      sendJson(response, 400, { error: "an answer is for a question, and names an answer for every question it asked" });
      return;
    }
    if (!settle(seat, id, allow(updated))) {
      sendJson(response, 409, { error: "nothing is waiting on that any more" });
      return;
    }
    sendJson(response, 200, { answered: id, decision });
    return;
  }

  // "Always" writes the rules that would let a call like this one through, instance-wide, before
  // it allows this one: one, or one per side of a compound command, each with its own line in the
  // ledger naming the same call — the command, the path, the URL or the search, and for a tool
  // whose input nobody here reads, the tool's name.
  let granted;
  if (decision === "always") {
    const asked = askedFor(seat, id);
    if (asked === undefined) {
      sendJson(response, 409, { error: "nothing is waiting on that any more" });
      return;
    }
    granted = shapeOf(asked, instance.root);
    if (granted === null) {
      sendJson(response, 400, { error: "there is no rule that would allow that call" });
      return;
    }
    for (const rule of granted) {
      allowAsked(instance.root, {
        rule,
        session: seat,
        call: asked.input?.command ?? inside(asked.input?.file_path, instance.root) ?? asked.input?.url ?? asked.input?.query ?? asked.tool,
        day: new Date().toISOString().slice(0, 10),
      });
    }
  }

  const said =
    decision === "deny"
      ? refuse(typeof why === "string" && why.trim() !== "" ? why.trim() : "not allowed by the Server")
      : allow();
  if (!settle(seat, id, said)) {
    sendJson(response, 409, { error: "nothing is waiting on that any more" });
    return;
  }
  sendJson(response, 200, { answered: id, decision, ...(granted === undefined ? {} : { granted }) });
}

// ----------------------------------------------------------------------------------- the stream

// The instance's root as the page's title says it: the home directory as `~`, since the title
// is read at a glance and the home is the one part of it that says nothing.
export function shownRoot(root, home = os.homedir()) {
  return root === home || root.startsWith(`${home}${path.sep}`) ? `~${root.slice(home.length)}` : root;
}

// What GET /sessions answers, and what the stream sends first.
function snapshot(instance) {
  return {
    user: instance.config.user,
    leader: instance.config.leader,
    instance: shownRoot(instance.root),
    // Who a row is from when it is from nobody: the page tells such a row apart by this.
    chat: SERVER,
    sessions: seats(instance).map((seat) => aboutSeat(instance, seat)),
    quota: usage.reading(),
  };
}

// A seat's rows from an index on: everything when none is given, so a page that has some asks
// for the rest and a page that has none asks for all.
function rowsSince(instance, seat, since) {
  const rows = read(instance.root, seat);
  const from = Number.parseInt(since ?? "0", 10);
  return Number.isInteger(from) && from > 0 ? rows.slice(from) : rows;
}

// What a seat's panel asks the User now: the call stops, and the rule requests once the turn
// that raised them has ended.
function pending(instance, seat) {
  return parked(seat, instance.root, { turn: turnOf(seat) });
}

// The turn a seat is on, or null: what a rule request is parked with, and what parked() reads.
function turnOf(seat) {
  const record = recordOf(seat);
  return record === undefined ? null : record.turn;
}

// The counts a page connects with: `since=<seat>:<count>`, one per panel it has rows on.
function countsIn(url) {
  const counts = new Map();
  for (const entry of url.searchParams.getAll("since")) {
    const at = entry.lastIndexOf(":");
    const count = Number.parseInt(entry.slice(at + 1), 10);
    if (at > 0 && Number.isInteger(count) && count >= 0) {
      counts.set(entry.slice(0, at), count);
    }
  }
  return counts;
}

function eventLine({ id, name, data }) {
  return `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

// One page, one stream. First what the page needs to draw — the snapshot, every seat's rows
// after the count the page came with, what every seat asks — then everything as it happens.
// The stream is subscribed before the first write, so nothing that happens while the opening is
// composed is lost; the page connects again with its counts if the stream drops, so nothing is
// kept for it here. A page opening is also somebody looking at the account's usage: it is asked
// for, and the page told when the answer is in.
function stream(instance, url, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  usage.pageOpened(instance);
  let sent = 0;
  const write = (event) => {
    sent += 1;
    response.write(eventLine({ id: sent, ...event }));
  };
  const unsubscribe = subscribe((event) => {
    write(event.name === "asking" ? { name: "asking", data: { seat: event.data.seat, pending: pending(instance, event.data.seat) } } : event);
  });
  response.once("close", unsubscribe);

  const counts = countsIn(url);
  const opening = snapshot(instance);
  write({ name: "snapshot", data: opening });
  for (const { name } of opening.sessions) {
    const since = counts.get(name) ?? 0;
    write({ name: "rows", data: { seat: name, since, rows: rowsSince(instance, name, String(since)) } });
  }
  for (const { name } of opening.sessions) {
    write({ name: "asking", data: { seat: name, pending: pending(instance, name) } });
  }
}

// ------------------------------------------------------------------------------------- routing

// A refusal names the route and never a secret: the segment after /mcp/ is written as the word,
// whatever was there and wherever it sits — a caller that goes looking for a login appends the
// whole tool path to a discovery route.
const SECRET_IN_PATH = /\/mcp\/[^/]+/g;

function shownAs(pathname) {
  return pathname.replace(SECRET_IN_PATH, "/mcp/<secret>");
}

async function handle(instance, port, request, response) {
  const url = new URL(request.url, `http://${HOST}`);

  if (request.method === "GET" && url.pathname === "/") {
    sendPage(response);
    return;
  }

  if (request.method === "GET" && Object.hasOwn(ASSETS, url.pathname)) {
    sendAsset(response, ASSETS[url.pathname]);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { instance: instance.root, port, version: version(instance.root) ?? "unknown" });
    return;
  }

  const who = whoIs(request, url);
  if (who === null) {
    sendJson(response, 401, UNKNOWN);
    return;
  }

  if (TOOL_ROUTE.test(url.pathname)) {
    if (request.method === "POST") {
      await postTool(instance, who, request, response);
      return;
    }
    // A session opens GET on its own door to listen for a stream the server does not offer.
    // The answer is the one the protocol reserves for that, and nothing else: a 401 here would
    // read as "log in first" and send the caller looking for a login that does not exist.
    sendJson(response, 405, { error: "method not allowed" }, { allow: "POST" });
    return;
  }

  if (who.page !== true) {
    sendJson(response, 401, UNKNOWN);
    return;
  }

  // A server that is stopping is parking its seats, and the MCP route above stays open for the
  // desks and stops that takes; the page is told to wait.
  if (instance.stopping === true) {
    sendJson(response, 503, { error: "stopping" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    sendJson(response, 200, snapshot(instance));
    return;
  }

  if (request.method === "GET" && url.pathname === EVENTS_ROUTE) {
    stream(instance, url, response);
    return;
  }

  const onSession = SESSION_ROUTE.exec(url.pathname);
  if (onSession !== null) {
    const seat = decodeURIComponent(onSession[1]);
    const what = onSession[2];
    if (!isSeat(instance, seat)) {
      sendJson(response, 404, { error: `nobody called ${seat} works here` });
      return;
    }
    if (request.method === "GET" && what === "messages") {
      sendJson(response, 200, { messages: rowsSince(instance, seat, url.searchParams.get("since")) });
      return;
    }
    if (request.method === "POST" && what === "message") {
      await postMessage(instance, seat, request, response);
      return;
    }
    if (request.method === "GET" && what === "permissions") {
      sendJson(response, 200, { permissions: pending(instance, seat) });
      return;
    }
    if (request.method === "POST" && what === "permission") {
      await postPermission(instance, seat, request, response);
      return;
    }
    // The page's STOP: the turn is interrupted and nothing else — the process stays, the next
    // frame queued for it is written. Said on the panel either way: what the seat goes on to
    // when there is a queue, since a seat busy again the moment it was stopped reads as a stop
    // that did nothing; and that there was nothing to stop, since a press is never silent.
    if (request.method === "POST" && what === "stop") {
      const interrupted = await interrupt(seat, { thenDrain: false });
      if (interrupted) {
        append(instance.root, seat, { from: SERVER, text: stoppedLine(waiting(seat)) });
        resume(seat);
      } else {
        log("stop", seat, null, "No turn to stop");
        append(instance.root, seat, { from: SERVER, text: "No turn to stop" });
      }
      sendJson(response, 200, { interrupted });
      return;
    }
    // A key went into the seat's box: a turn about to begin with none of the User's words in it
    // waits a little for them (the typing hold, session.mjs). Nothing is answered but that it came.
    if (request.method === "POST" && what === "typing") {
      keystroke(seat);
      response.writeHead(204);
      response.end();
      return;
    }
  }

  sendJson(response, 404, { error: `nothing at ${request.method} ${shownAs(url.pathname)}` });
}

// Serve one instance. `instance` is { root, config, plugins, pop }.
export function serve(instance) {
  let port = null;
  const server = http.createServer((request, response) => {
    handle(instance, port, request, response).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(instance.config.port, HOST, () => {
      port = server.address().port;
      record(instance.root, port);
      const disarm = arm(instance);
      server.once("close", disarm);
      // What admin mode left at the root, if it left anything: the Leader is told it now, armed
      // and before anything else is served.
      adminTold(instance);
      // The account's usage windows, for the head: asked for while any session runs, at the
      // pace usage.mjs sets; the tick itself is cheap and stops with the server. And admin mode
      // closing while this server runs: the Leader is told within one tick of it, not at the
      // next start.
      usage.configure({ version: version(instance.root) ?? "unknown" });
      const ticking = setInterval(() => {
        adminTold(instance);
        usage.tick(instance, runningSeats().length);
      }, USAGE_TICK);
      ticking.unref();
      server.once("close", () => clearInterval(ticking));
      resolve(server);
    });
  });
}
