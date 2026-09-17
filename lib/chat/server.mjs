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

import { THE_CHAT, append, delivered, read } from "./conversation.mjs";
import { subscribe } from "./events.mjs";
import { HOST, record } from "./runtime.mjs";
import { respond } from "./mcp.mjs";
import { acceptRule, allow, answerRule, askedFor, answer as settle, inside, parkRule, parked, refuse, ruleAskedFor, rulesPending, shapeOf } from "./permissions.mjs";
import { answerFrom } from "../plugins.mjs";
import { ask as askTheHelper } from "../helper.mjs";
import { recall, remember } from "../store.mjs";
import { DeskError, LEDGER, LISTS, allowAsked, deskFile, hire as openDesk, isModel, isName, modelFor, nextName, ruleAsked, writeDeskWhole } from "../desks.mjs";
import { LEADER, WORKER, TURN_PATIENCE, end, interrupt, isSeat, recordOf, running, seats } from "./session.mjs";
import { aboutSeat, arm, deliver, isParking, parkRoom, showRules, startSeat } from "./lifecycle.mjs";
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
// answered, a run that failed, a turn the page stopped, a turn that said nothing at all.
function showTheEnding(root, seat, answered) {
  answered.then((reply) => {
    if (reply.ended === true) {
      append(root, seat, { from: THE_CHAT, text: `${seat} stopped before answering: ${reply.text}`, failed: true });
    } else if (reply.failed) {
      append(root, seat, { from: seat, text: reply.text, failed: true });
    } else if (reply.interrupted) {
      // A turn the page stopped is not words the seat said: shown as stopped, not as a reply.
      append(root, seat, { from: seat, text: reply.text, interrupted: true });
    } else if (reply.silent) {
      append(root, seat, { from: seat, text: reply.text, silent: true });
    }
  });
}

// What the User typed onto a panel. The words are the User's own turn to that seat, and when the
// seat is a Worker the Leader is told the fact — once, as a server event — so nothing has to be
// reported by hand.
// A frame held by the quota gate is said so on the panel, once, with when the window resets;
// the reply lands when it eventually goes.
function heldLine(held) {
  return `limit exhausted (${held.window} window), reset at ${quota.hhmm(held.resets)}, your message is waiting`;
}

function typed(instance, seat, text) {
  const root = instance.root;
  // The row waits on the panel until the frame it became is written to the process — behind the
  // turn under way, or a closed window — and reads delivered from then on.
  const index = append(root, seat, { from: "user", text });
  const told = deliver(instance, seat, userFrame(text), { written: () => delivered(root, seat, index) });
  if (told.refused !== undefined) {
    append(root, seat, { from: THE_CHAT, text: `${seat} has no process`, failed: true });
  } else {
    if (told.held !== undefined) {
      append(root, seat, { from: THE_CHAT, text: heldLine(told.held) });
    }
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
  recall: [LEADER, WORKER],
  remember: [LEADER, WORKER],
  write_desk: [LEADER, WORKER],
  restart_session: [LEADER, WORKER],
  stop_session: [LEADER, WORKER],
  park: [LEADER],
  hire: [LEADER],
  permission: [LEADER],
};

// What write_desk takes: a title and a status short enough for one header line, a body under a
// size a desk has no business exceeding.
const LONGEST_TITLE = 120;
const LONGEST_STATUS = 80;
const LONGEST_BODY = 64 * 1024;

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
  record.ending = ending === "stop" ? (record.askedWhy === "restart" ? "stop" : (record.askedWhy ?? "stop")) : ending;
  // After this answer has gone back: the tool result travels its own connection, but a process
  // whose stdin closed first could end before reading it.
  setImmediate(() => {
    end(caller.seat, TURN_PATIENCE);
  });
  return { text: answer };
}

// The tools a caller is served, with the caller bound into every one of them: a tool never reads
// who is calling from its arguments, because the server already knows.
export function toolsFor(instance, caller) {
  const offered = (name) => OFFERED_TO[name].includes(caller.role);
  const root = instance.root;
  // What the store is handed about who is calling: the seat and its role, as the server knows
  // them. The store applies every rule on its own side.
  const storeContext = () => ({
    caller: { name: caller.seat, role: caller.role },
    now: new Date(),
    config: instance.config,
    helper: (question, request) => askTheHelper(instance, question, request),
  });

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
        if (!isName(to)) {
          return { refused: `nobody called ${to} works here` };
        }
        if (typeof text !== "string" || text.trim() === "") {
          return { refused: "a message needs some text" };
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
        const told = deliver(instance, to, messageFrame(caller.seat, text));
        if (told.refused !== undefined) {
          append(root, caller.seat, { from: caller.seat, to, text, outcome: "not sent", why: `${to} has no process` });
          return { refused: `${to} has no process` };
        }
        // A message that went is one thing on two logs, under one id: the page takes a click on
        // the line the Worker's panel draws for it to the row the Leader's panel draws for it.
        const msg = crypto.randomUUID();
        append(root, caller.seat, { from: caller.seat, to, text, outcome: "sent", msg });
        append(root, to, { from: caller.seat, to, text, msg });
        // The call comes back the moment the seat has the message: the caller's turn goes on,
        // and what the addressee says at the end of its own turn is its own — on its panel, and
        // for whoever it wants to reach, a message the other way. Nobody's turn is held for
        // anybody else's. A message held by the quota gate goes when the window resets.
        showTheEnding(root, to, told.answered);
        if (told.held !== undefined) {
          append(root, to, { from: THE_CHAT, text: heldLine(told.held) });
          return { text: `${to} has it; ${heldLine(told.held)}` };
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
    // The store: what this workspace knows, behind two tools and reached no other way. Both are
    // everybody's; what differs by role is what a call is refused, and the description says so —
    // a session that can read why it would be refused does not go hunting for another way round.
    {
      name: "recall",
      description:
        "Read what this workspace knows. store is memory (about us: hard rules, facts, traps) or knowledge (about the project). Give exactly one of: query (words — what you are looking for, found by meaning, not by grep), id (one record, such as m17), all (every current record of the store, or of one kind) — or kind hard-rule on its own for the numbered rule set exactly as every session is given it, with the set version. kind narrows to hard-rule, fact or trap; expired true adds records whose until has passed, marked. Answers each record as written: its id, kind, source, until, the text, who wrote it and when, and what it replaced. A record that was replaced is reachable by id only, marked with what replaced it. Refused: two of query, id and all, or none; kind hard-rule with store knowledge (hard rules are memory). A rule scoped to the Leader is not in a Worker's answer by any of these.",
      inputSchema: {
        type: "object",
        properties: {
          store: { type: "string", enum: ["memory", "knowledge"], description: "memory or knowledge." },
          query: { type: "string", description: "Words: what you are looking for, found by meaning." },
          kind: { type: "string", enum: ["hard-rule", "fact", "trap"], description: "Narrow to one kind." },
          id: { type: "string", description: "One record by id." },
          all: { type: "boolean", description: "Every current record of the store, or of the kind given." },
          expired: { type: "boolean", description: "Include records whose until has passed, marked. Default false." },
        },
        required: ["store"],
        additionalProperties: false,
      },
      offered: offered("recall"),
      run: (args) => (offered("recall") ? recall(root, args, storeContext()) : { refused: "recall is not offered to you" }),
    },
    {
      name: "remember",
      description:
        "Write one record of what this workspace knows. store is memory or knowledge; kind is hard-rule, fact or trap in memory and fact or trap in knowledge; text is the record — a hard rule is ONE line under the workspace's length cap, stored as written, never shortened. Supersede, never accumulate: replaces names the current record this one replaces (reason says why); left out, the store asks whether the text restates a current record of the same store and kind and replaces that one. until makes a record run out — an absolute ISO 8601 moment with an offset, words such as 'for today' or 'until Monday' (turned into an absolute moment before anything is stored), or now, which retires the record it replaces; an expired record stays visible with expired true and can be renewed by a write that replaces it with a later until. source user says the User said it (default team); scope leader keeps a User's hard rule from Workers. Refused, in this order: kind hard-rule from a Worker (say it to the Leader as a proposal); source user or scope leader from a Worker; scope leader on anything but a hard-rule with source user; a kind the store has not got; a hard rule with a newline or over the length cap (the cap is in the refusal); an until that cannot be placed, or that has already passed (except now); replaces naming a record that is missing, of another store or kind, or already replaced (the current one is named); a team write over the User's record, the Leader included; a hard rule over the count cap (the numbered set is in the refusal, so one can be retired or merged). A hard-rule write answers with the rule's number, the set version and the update line every running session gets.",
      inputSchema: {
        type: "object",
        properties: {
          store: { type: "string", enum: ["memory", "knowledge"], description: "memory or knowledge." },
          kind: { type: "string", enum: ["hard-rule", "fact", "trap"], description: "hard-rule, fact or trap; knowledge has fact and trap." },
          text: { type: "string", description: "The record, stored as written. A hard rule is one line." },
          source: { type: "string", enum: ["user", "team"], description: "user when the User said it. Default team. Leader only." },
          scope: { type: "string", enum: ["team", "leader"], description: "leader keeps a User's hard rule from Workers. Default team. Leader only." },
          until: { type: "string", description: "When it runs out: an absolute ISO 8601 moment with an offset, words such as 'for today', or now to retire." },
          replaces: { type: "string", description: "The id of the current record this one replaces." },
          reason: { type: "string", description: "Why it replaces what it replaces." },
        },
        required: ["store", "kind", "text"],
        additionalProperties: false,
      },
      offered: offered("remember"),
      run: (args) => (offered("remember") ? remember(root, args, storeContext()) : { refused: "remember is not offered to you" }),
    },
    {
      name: "write_desk",
      description:
        "Write your own desk, desks/<you>/STATE.md: title (one line, up to 120 characters — what you are on), status (one line, up to 80 characters, no |) and body (the sections, as markdown). The server writes the header line and the heading; the body is yours, as given. Call it before restart_session or stop_session — both refuse until the desk was written since the event that asked, or since this turn. Refused: an empty title or status, a newline in either, a | in status, a body over 64 KB, any other key.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "What you are on, one line, up to 120 characters." },
          status: { type: "string", description: "Where it stands, one line, up to 80 characters, no |." },
          body: { type: "string", description: "The sections, as markdown, up to 64 KB." },
        },
        required: ["title", "status", "body"],
        additionalProperties: false,
      },
      offered: offered("write_desk"),
      run(args) {
        if (!offered("write_desk")) {
          return { refused: "write_desk is not offered to you" };
        }
        const keys = Object.keys(args ?? {});
        const unknown = keys.filter((key) => !["title", "status", "body"].includes(key));
        if (unknown.length > 0) {
          return { refused: `write_desk takes title, status and body, not ${unknown.join(", ")}` };
        }
        const { title, status, body } = args ?? {};
        if (typeof title !== "string" || title.trim() === "" || title.length > LONGEST_TITLE || title.includes("\n")) {
          return { refused: `title is one line of 1 to ${LONGEST_TITLE} characters` };
        }
        if (typeof status !== "string" || status.trim() === "" || status.length > LONGEST_STATUS || status.includes("\n") || status.includes("|")) {
          return { refused: `status is one line of 1 to ${LONGEST_STATUS} characters, without |` };
        }
        if (typeof body !== "string" || Buffer.byteLength(body) > LONGEST_BODY) {
          return { refused: `body is markdown of at most ${LONGEST_BODY} bytes` };
        }
        const record = recordOf(caller.seat);
        const written = writeDeskWhole(root, caller.seat, { title: title.trim(), status: status.trim(), rules: record?.rules, body });
        if (record !== undefined) {
          record.deskWrittenAt = (instance.clock ?? Date.now)();
        }
        const lines = written.split("\n").length - 1;
        return { text: `desk written: desks/${caller.seat}/STATE.md (${lines} lines, rules ${record?.rules ?? ""})` };
      },
    },
    {
      name: "restart_session",
      description:
        "End your process and start a successor on your desk. Write your desk with write_desk first: this refuses until the desk was written since the event that asked (context-full) or since this turn began. Whatever is queued for you goes to the successor, which starts from the desk. After it answers, nothing you say changes what happens.",
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
      name: "park",
      description:
        "Park the room: every running Worker is told to write its desk and stop (interrupted first when interrupt is true), and this waits until each has called stop_session or the deadline (seconds, at least 5; the instance's park.deadline when not given) passes, ending at the deadline whoever has not. Answers who stopped and who was ended, with when each desk was written. Then write your own desk and call stop_session. Refused: while a park is under way; while the server is stopping.",
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
        "Start a Worker on a desk. Called with no name, the Worker is called by the next free name of the roster; a name is for starting somebody who has a desk again — somebody who stopped — on it, panel log kept. Model when not the usual one. Refused: a name that is not one (a letter, then up to 31 letters, digits, _ or -); already running; while the quota gate holds hires (from the first stage of a window, until it resets); while the server is stopping; a name whose panel log exists without a desk.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Who to start again, when somebody who has a desk. Left out, the roster says who the new Worker is." },
          model: { type: "string", description: "The model, when not the usual one." },
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
        if (!fs.existsSync(deskFile(root, name))) {
          try {
            openDesk(root, name, model);
          } catch (error) {
            if (error instanceof DeskError) {
              return { refused: error.message };
            }
            throw error;
          }
        }
        startSeat(instance, name);
        return { text: `${name} started on the desk desks/${name} (${modelFor(root, name, instance.config)})` };
      },
    },
    // What the instance may do is settled in words, and the words are the User's: the Leader asks
    // with this, the User presses, the press is written for every session by the one writer
    // (postPermission below) and reaches the Leader as an event. The tool never writes a rule.
    {
      name: "permission",
      description:
        "Ask the User, on your panel, to settle one rule for the whole instance: rule is a Claude Code permission rule - Bash(word:*) for a command by its first word and prefix, Edit(/dir/**) for writes under a directory - and why is what the User reads beside it. The dialog has Allow, Deny and Ask; the click is written for every session, current and future, and reaches you as a server-event of type permission. Called with no rule, answers every rule the instance holds and every dialog still pending. Refused: a rule without why; a shape the checker does not accept (Bash(word:*) and Edit(/dir/**) only); a rule already held or already pending.",
      inputSchema: {
        type: "object",
        properties: {
          rule: { type: "string", description: "The rule, in Claude Code's shape: Bash(word:*) or Edit(/dir/**)." },
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
          return { refused: `${rule} is not a rule this workspace settles: Bash(word:*) for a command by its first word and prefix, Edit(/dir/**) for writes under a directory inside the instance` };
        }
        const permissions = readSettings(root).permissions ?? {};
        const held = LISTS.find((list) => Array.isArray(permissions[list]) && permissions[list].includes(accepted));
        if (held !== undefined) {
          return { refused: `${accepted} is already ${SETTLED_AS[held]} - say it to the User` };
        }
        if (rulesPending(caller.seat).some((pending) => pending.rule === accepted)) {
          return { refused: `${accepted} is already asked on your panel` };
        }
        const id = parkRule(caller.seat, { rule: accepted, why: why.trim(), from: caller.seat }, (instance.clock ?? Date.now)());
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
    tools: toolsFor(instance, caller),
  });
  if (body === null) {
    response.writeHead(status).end();
    return;
  }
  sendJson(response, status, body);
}

// --------------------------------------------------------------------------------- page routes

const SESSION_ROUTE = /^\/sessions\/([^/]+)\/(messages|message|permissions|permission|stop)$/;

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
  try {
    ({ id, decision, why } = JSON.parse(await readBody(request)));
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

  if (decision !== "allow" && decision !== "deny" && decision !== "always") {
    sendJson(response, 400, { error: "a decision on a call is allow, deny or always" });
    return;
  }

  // "Always" writes the rules that would let a call like this one through, instance-wide, before
  // it allows this one: one, or one per side of a compound command, each with its own line in the
  // ledger naming the same call.
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
        call: asked.input?.command ?? inside(asked.input?.file_path, instance.root),
        day: new Date().toISOString().slice(0, 10),
      });
    }
  }

  const said =
    decision === "deny"
      ? refuse(typeof why === "string" && why.trim() !== "" ? why.trim() : "not allowed from the chat")
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
    chat: THE_CHAT,
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
  const record = recordOf(seat);
  return parked(seat, instance.root, { onTurn: record !== undefined && record.turn !== null });
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
// kept for it here.
// How many pages hold a stream open: the account's usage is asked for only while one does.
let pages = 0;

function stream(instance, url, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  pages += 1;
  response.once("close", () => {
    pages -= 1;
  });
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
    // frame queued for it is written.
    if (request.method === "POST" && what === "stop") {
      const interrupted = await interrupt(seat);
      sendJson(response, 200, { interrupted });
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
      // The account's usage windows, for the head: asked for while a page is looking, at the
      // pace usage.mjs sets; the tick itself is cheap and stops with the server.
      const ticking = setInterval(() => usage.tick(instance, pages, { version: version(instance.root) ?? "unknown" }), USAGE_TICK);
      ticking.unref();
      server.once("close", () => clearInterval(ticking));
      resolve(server);
    });
  });
}
