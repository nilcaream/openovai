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
// Only `GET /` and `GET /health` are open: the page has to be reachable at one plain address that
// survives a server restart, and `ovai status` has to be able to ask whether anything is running.
// Both are served on the loopback address only.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { THE_CHAT, append, read } from "./conversation.mjs";
import { HOST, record } from "./listening.mjs";
import { respond } from "./mcp.mjs";
import { allow, askedFor, answer as settle, giveUp, inside, park, parked, refuse, shapeOf } from "./permissions.mjs";
import { popped } from "./pop.mjs";
import { answerFrom } from "../plugins.mjs";
import { ask as askTheHelper } from "../helper.mjs";
import { recall, remember } from "../store.mjs";
import { allowAsked, isName } from "../desks.mjs";
import { LEADER, WORKER, end, isSeat, running, seats, start, tell, whileWaitingFor, wouldWaitForItself } from "./session.mjs";
import { messageFrame, neutralise, serverEvent, userFrame } from "./frames.mjs";
import { isPageSecret, pageSecret, resolve } from "./secrets.mjs";
import { version } from "../version.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "page.html");
const SECRET_TAG = '<meta name="openovai-secret" content="">';

const TOOLKIT = "openovai";

const LONGEST_MESSAGE = 100_000;

const UNKNOWN = { error: "unknown secret" };

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
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

// Who is calling: a session, from the secret in the MCP path; the page, from the secret in its
// Authorization header; or nobody. The two kinds never cross: the page's secret is not in the
// session map, so it resolves to nothing on the MCP path, and a session's secret is never the
// page's, so it is nothing as a bearer.
function whoIs(request, url) {
  const calling = TOOL_ROUTE.exec(url.pathname);
  if (calling !== null) {
    return resolve(calling[1]);
  }
  return isPageSecret(bearer(request.headers.authorization)) ? { page: true } : null;
}

// ------------------------------------------------------------------------------- starting a seat

// How a session's permission requests reach the page: parked on its panel, and the desktop told.
function asking(instance, seat) {
  return (request) => {
    const waiting = park(seat, request);
    popped(instance, { on: seat, why: `${seat} is stopped, waiting to be allowed to use ${request.tool}` });
    return waiting;
  };
}

// The one place a seat's process is started. Nothing in this slice calls it in production: the
// lifecycle that starts and ends seats is the next slice's, and it will go through here.
export function startSeat(instance, seat) {
  return start(instance, seat, { asked: asking(instance, seat), ended: () => giveUp(seat) });
}

export { end as endSeat };

// --------------------------------------------------------------------------------- delivering

// A reply arrives on the panel of whoever gave it, as its own row. A turn that ended without an
// answer is said so, as a failure.
function showTheReply(root, seat, answered) {
  answered.then((reply) => {
    if (reply.ended === true) {
      append(root, seat, { from: THE_CHAT, text: `${seat} stopped before answering: ${reply.text}`, failed: true });
      return;
    }
    append(root, seat, {
      from: seat,
      text: reply.text,
      ...(reply.failed ? { failed: true } : {}),
      ...(reply.silent ? { silent: true } : {}),
    });
  });
}

// What the User typed onto a panel. The words are the User's own turn to that seat, and when the
// seat is a Worker the Leader is told the fact — once, as a server event — so nothing has to be
// reported by hand.
function typed(instance, seat, text) {
  const root = instance.root;
  append(root, seat, { from: "user", text });
  const told = tell(seat, userFrame(text));
  if (told.refused !== undefined) {
    append(root, seat, { from: THE_CHAT, text: `${seat} has no process`, failed: true });
  } else {
    showTheReply(root, seat, told.answered);
  }

  let leaderTold = false;
  if (seat !== instance.config.leader) {
    const leader = instance.config.leader;
    append(root, leader, { from: "user", typedTo: seat, text });
    const woken = tell(leader, serverEvent("user-typed", { who: seat }, text));
    leaderTold = woken.refused === undefined;
    if (leaderTold) {
      showTheReply(root, leader, woken.answered);
    }
  }

  return { delivered: told.refused === undefined, ...(seat === instance.config.leader ? {} : { leaderTold }) };
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
};

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
        "Say something to another session here and wait for its reply. Give it who to say it to and what to say; it comes back with what they answered.",
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
        if (!isName(to) || !isSeat(instance, to)) {
          return { refused: `nobody called ${to} works here` };
        }
        if (to === caller.seat) {
          return { refused: "that is you" };
        }
        if (typeof text !== "string" || text.trim() === "") {
          return { refused: "a message needs some text" };
        }
        if (wouldWaitForItself(caller.seat, to)) {
          return {
            refused: `${to} is waiting for your answer, so it cannot take a message until you have given it — say this in your reply instead`,
          };
        }
        const told = tell(to, messageFrame(caller.seat, text));
        if (told.refused !== undefined) {
          return { refused: `${to} has no process` };
        }
        append(root, to, { from: caller.seat, text });
        const reply = await whileWaitingFor(caller.seat, to, () => told.answered);
        if (reply.ended === true) {
          append(root, to, { from: THE_CHAT, text: `${to} stopped before answering: ${reply.text}`, failed: true });
          return { refused: `${to} stopped before answering` };
        }
        append(root, to, {
          from: to,
          text: reply.text,
          ...(reply.failed ? { failed: true } : {}),
          ...(reply.silent ? { silent: true } : {}),
        });
        // A reply is a thing the server hands into a session, so it is neutralised like a body:
        // no session can pose as the User through a tool result.
        return { text: neutralise(reply.text) };
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
          text: JSON.stringify(
            seats(instance).map((seat) => ({ ...seat, running: running(seat.name), you: seat.name === caller.seat })),
          ),
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

const SESSION_ROUTE = /^\/sessions\/([^/]+)\/(messages|message|permissions|permission)$/;

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
  if (decision !== "allow" && decision !== "deny" && decision !== "always") {
    sendJson(response, 400, { error: "a decision is allow, deny or always" });
    return;
  }

  // "Always" writes the rule that would let a call like this one through, instance-wide, before
  // it allows this one.
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
    allowAsked(instance.root, {
      rule: granted,
      session: seat,
      call: asked.input?.command ?? inside(asked.input?.file_path, instance.root),
      day: new Date().toISOString().slice(0, 10),
    });
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

// ------------------------------------------------------------------------------------- routing

// The request log names the route and never a secret: the segment after /mcp/ is printed as
// the word, whatever was there.
function shownAs(pathname) {
  return TOOL_ROUTE.test(pathname) ? "/mcp/<secret>" : pathname;
}

async function handle(instance, port, request, response) {
  const url = new URL(request.url, `http://${HOST}`);

  if (request.method === "GET" && url.pathname === "/") {
    sendPage(response);
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

  if (request.method === "POST" && TOOL_ROUTE.test(url.pathname)) {
    await postTool(instance, who, request, response);
    return;
  }

  if (who.page !== true) {
    sendJson(response, 401, UNKNOWN);
    return;
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    sendJson(response, 200, {
      user: instance.config.user,
      leader: instance.config.leader,
      sessions: seats(instance).map((seat) => ({ ...seat, running: running(seat.name) })),
    });
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
      sendJson(response, 200, { messages: read(instance.root, seat) });
      return;
    }
    if (request.method === "POST" && what === "message") {
      await postMessage(instance, seat, request, response);
      return;
    }
    if (request.method === "GET" && what === "permissions") {
      sendJson(response, 200, { permissions: parked(seat, instance.root) });
      return;
    }
    if (request.method === "POST" && what === "permission") {
      await postPermission(instance, seat, request, response);
      return;
    }
  }

  sendJson(response, 404, { error: `nothing at ${request.method} ${shownAs(url.pathname)}` });
}

// Serve one instance. `instance` is { root, config, plugins, pop }.
export function serve(instance) {
  let port = null;
  const server = http.createServer((request, response) => {
    response.once("finish", () => {
      console.log(`${request.method} ${shownAs(new URL(request.url, `http://${HOST}`).pathname)} ${response.statusCode}`);
    });
    handle(instance, port, request, response).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(instance.config.port, HOST, () => {
      port = server.address().port;
      record(instance.root, port);
      resolve(server);
    });
  });
}
