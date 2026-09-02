// The instance's chat server: one page, and one panel for each session in the instance.
//
// It listens on 127.0.0.1 only. A workspace is one person's machine, and a chat that can
// drive a Claude Code session is not something to put on a network by accident.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { append, read } from "./conversation.mjs";
import { HOST, record } from "./listening.mjs";
import { carry, overhear } from "./overheard.mjs";
import { allow, answer as settle, giveUp, park, parked, refuse } from "./permissions.mjs";
import { ask, sessions } from "./session.mjs";
import { inTurn, midTurn, whileWaitingFor, wouldWaitForItself } from "./turns.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "page.html");

// Enough for anything a person types, small enough that a runaway client cannot fill memory.
const LONGEST_MESSAGE = 100_000;

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function sendPage(response) {
  const page = fs.readFileSync(PAGE);
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

// A message from another session is handed over wrapped, under the name of whoever sent it and
// what they are. So a turn that arrives with no wrapper is the human's, by construction: a session
// does not have to be told who it is talking to, it can see it, and the one case it must never get
// wrong — the human typing on its own panel — is the one that needs nothing to go right.
//
// It is wrapped only on the way to the session. What is kept is what was said, under the name of
// who said it, so the transcript reads as a conversation rather than as a protocol.
function wrap(from, role, text) {
  return `<from-session name="${from}" role="${role}">${text}</from-session>`;
}

// Who a line in a transcript is from when it is not from anybody: the chat saying what became of
// a message. It has a space in it, so no session can ever be called this — a name is a directory
// under work/ and cannot hold one.
const THE_CHAT = "the chat";

// What the lead is told when the human types on somebody else's panel.
//
// The chat is the only party that can know it happened: the human's message arrives unsigned, and
// the lead is not in the exchange at all. Before this the worker was told to pass it on itself,
// which cost a whole turn of the lead's nested inside the worker's — so the lead heard it late and
// only if a model remembered to.
//
// It reads as what it is, in the words that were typed rather than in what the worker made of
// them, and it is written under `the chat` because nobody said it to anybody.
function overheardLine(human, on, text) {
  return `${human} said to ${on}: ${text}`;
}

// The same thing said to the lead's model rather than to the person reading its panel.
//
// A wrapper, for the reason `wrap` above is one: the server is the only thing that writes one, so
// what is left OUTSIDE every wrapper is the human speaking on this session's own panel, still by
// construction. This is what a turn is handed in front of the message it is actually about.
function overheardWrapper(human, on, text) {
  return `<overheard on="${on}" from="${human}">${text}</overheard>`;
}

// What a session is handed: everything it overheard while it was not running, then the message
// this turn is about. Blank lines between them, because they are separate things said by
// different people and a wall of text invites a model to read them as one.
function withWhatWasOverheard(lines, message) {
  return [...lines, message].join("\n\n");
}

// Everything a session is asked or answers is under its own name, so one route shape serves
// every panel and there is no path through here that only the lead can take.
const SESSION_ROUTE = /^\/sessions\/([^/]+)\/(messages|message|permissions|permission)$/;

async function postMessage(instance, name, request, response) {
  let text;
  let from;
  try {
    ({ text, from } = JSON.parse(await readBody(request)));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  if (typeof text !== "string" || text.trim() === "") {
    sendJson(response, 400, { error: "a message needs some text" });
    return;
  }

  // The page signs nothing, so an unsigned message is the person at the page or the person at a
  // terminal — either way, the human. A signature naming nobody who works here is refused rather
  // than passed on as the human's: a message arriving as somebody it is not is the one mistake
  // this whole arrangement exists to prevent.
  const signed = typeof from === "string" && from.trim() !== "" ? from.trim() : null;
  const sender = signed === null ? null : (sessions(instance).find((session) => session.name === signed) ?? null);
  if (signed !== null && sender === null) {
    sendJson(response, 400, { error: `nobody called ${signed} works here` });
    return;
  }

  // A message that would close a circle is answered now rather than queued: the sender's own turn
  // is what the addressee is waiting for, so joining the queue would stop both of them for good.
  // The refusal is written into the sender's own transcript as well as returned, so somebody
  // reading that panel can see why nothing was delivered.
  if (sender !== null && wouldWaitForItself(sender.name, name)) {
    const why = `${name} is waiting for your answer, so it cannot take a message until you have given it — say this in your reply instead`;
    append(instance.root, sender.name, { from: THE_CHAT, text: `not delivered to ${name}: ${why}`, failed: true });
    sendJson(response, 409, { error: why });
    return;
  }

  // The lead hears what was said on a panel it was not on, at the moment it is said.
  //
  // Deliberately OUTSIDE the turn below: a session answers one message at a time, so a line put
  // through that queue would reach the lead only after the addressee had finished — which on a busy
  // one is long after the thing it was about. Overhearing that waits is not overhearing.
  //
  // Only an unsigned message, and only on somebody else's panel. A signed one is a session
  // speaking, and the lead either sent it or is the one being spoken to; a message on the lead's
  // own panel is not overheard, it is heard.
  if (sender === null && name !== instance.config.leader) {
    append(instance.root, instance.config.leader, {
      from: THE_CHAT,
      text: overheardLine(instance.config.human, name, text.trim()),
      overheard: true,
    });
    overhear(instance.config.leader, overheardWrapper(instance.config.human, name, text.trim()));
  }

  // The whole exchange happens inside the session's turn, the question written down when the turn
  // begins rather than when it arrived. A transcript then reads question, answer, question, answer,
  // instead of two questions followed by two answers nobody can pair up.
  const { question, reply } = await whileWaitingFor(sender?.name ?? null, name, () =>
    inTurn(name, async () => {
      const asked = append(instance.root, name, { from: sender?.name ?? "human", text: text.trim() });

      // The reply is waited for rather than streamed. One run of Claude Code answers one message,
      // so the answer is ready or it is not; a page that shows it appearing is a later question.
      let answer;
      try {
        answer = await ask(
          instance,
          name,
          withWhatWasOverheard(
            // Drained here, where the turn begins, rather than where the message arrived: anything
            // said while this turn was waiting its place in the queue belongs to this turn.
            carry(name),
            sender === null ? asked.text : wrap(sender.name, sender.role, asked.text),
          ),
          (request) => park(name, request),
        );
      } finally {
        // Whatever it was still asking about, it is not there to hear the answer now.
        giveUp(name);
      }

      return {
        question: asked,
        reply: append(instance.root, name, {
          from: name,
          text: answer.text,
          ...(answer.failed ? { failed: true } : {}),
          // Kept as its own thing rather than folded into the text: the transcript should say
          // what the session said, and it said nothing.
          ...(answer.silent ? { silent: true } : {}),
        }),
      };
    }),
  );

  sendJson(response, 200, { message: question, reply });
}

// Answering what a session asked to be allowed to do.
//
// The decision is put together here rather than taken from the page, because the protocol is
// unforgiving about it: a refusal without a reason does not parse as a refusal, and anything that
// does not parse is read as one anyway. So the page says allow or deny and this says it properly.
//
// An id that is not waiting any more is a 409 and not a 404: the request was real, it is simply
// answered or abandoned, and a page showing a stale one should say so rather than look broken.
async function postPermission(name, request, response) {
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

  if (decision !== "allow" && decision !== "deny") {
    sendJson(response, 400, { error: "a decision is allow or deny" });
    return;
  }

  const said =
    decision === "allow"
      ? allow()
      : refuse(typeof why === "string" && why.trim() !== "" ? why.trim() : "not allowed from the chat");

  if (!settle(name, id, said)) {
    sendJson(response, 409, { error: "nothing is waiting on that any more" });
    return;
  }

  sendJson(response, 200, { answered: id, decision });
}

async function handle(instance, request, response) {
  const url = new URL(request.url, `http://${HOST}`);

  if (request.method === "GET" && url.pathname === "/") {
    sendPage(response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      instance: instance.root,
      human: instance.config.human,
      leader: instance.config.leader,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    // Who works here, and which of them is in the middle of a turn. The second part is why the
    // page asks again rather than only at load: a session is put to work by another session as
    // well as by the person at the page, and a panel that says nothing while that happens reads
    // as a panel nobody is listening on.
    sendJson(response, 200, {
      sessions: sessions(instance).map((session) => ({ ...session, busy: midTurn(session.name) })),
    });
    return;
  }

  const route = SESSION_ROUTE.exec(url.pathname);
  if (route !== null) {
    const [, asked, what] = route;
    const name = decodeURIComponent(asked);

    // Only somebody with a desk can be written to. Without this the name is a path segment we
    // were handed, and a conversation would be started for whatever was typed in the URL.
    if (!sessions(instance).some((session) => session.name === name)) {
      sendJson(response, 404, { error: `nobody called ${name} works here` });
      return;
    }

    if (request.method === "GET" && what === "messages") {
      sendJson(response, 200, { messages: read(instance.root, name) });
      return;
    }

    if (request.method === "POST" && what === "message") {
      await postMessage(instance, name, request, response);
      return;
    }

    if (request.method === "GET" && what === "permissions") {
      sendJson(response, 200, { permissions: parked(name) });
      return;
    }

    if (request.method === "POST" && what === "permission") {
      await postPermission(name, request, response);
      return;
    }
  }

  sendJson(response, 404, { error: `nothing at ${request.method} ${url.pathname}` });
}

export function serve(instance) {
  const server = http.createServer((request, response) => {
    handle(instance, request, response).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(instance.config.port, HOST, () => {
      // Written from here rather than from whatever started the server, so that every way of
      // serving an instance leaves the address behind and none of them has to remember to.
      record(instance.root, server.address().port);
      resolve(server);
    });
  });
}
