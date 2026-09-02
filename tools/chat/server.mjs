// The instance's chat server: one page, and one panel for each session in the instance.
//
// It listens on 127.0.0.1 only. A workspace is one person's machine, and a chat that can
// drive a Claude Code session is not something to put on a network by accident.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { append, lastAt, panelFile, read } from "./conversation.mjs";
import { HOST, record } from "./listening.mjs";
import { carry, overhear } from "./overheard.mjs";
import { allow, answer as settle, giveUp, park, parked, refuse } from "./permissions.mjs";
import { DESK_FILE, WORK, archiveFor, deskTitle, retire } from "../desks.mjs";
import { ask, forget, hasThread, sessions } from "./session.mjs";
import { inTurn, turnsGoing, waitingFor, whileWaitingFor, wouldWaitForItself } from "./turns.mjs";

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

// What a session is asked for when its desk does not say what it is on.
//
// The header's title: is the one field of a desk anything outside it reads, and a desk that has not
// filled it in is a name in the room with nothing beside it. The personas ask for it and that is
// not enough on its own: a session given real work and left to do it keeps the work, not the
// header. What gets a field written is being asked for it in the turn — which is what this is.
//
// It rides on any turn where the title is empty rather than on the first turn of a new desk. A
// session that let the first one go by would otherwise leave the room blank for good, and the state
// worth acting on is not "newly hired", it is "nobody can see what this one is on". It costs a
// sentence while that is true and nothing at all once it is not, so it stops asking by being
// answered — including after a handover, which writes the title itself.
//
// A wrapper, for the reason `wrap` is one: what is left OUTSIDE every wrapper is the human speaking
// on this session's own panel, and an instruction from the chat handed over bare would arrive as
// something the human had typed.
function deskWrapper(name) {
  return [
    `<desk>Your desk ${desk(name)} opens with a one-line header, and the title: in it is the one`,
    `field of it anybody outside this desk reads — it is how the rest of us see what you are on`,
    `without opening this panel. It is empty. Put what you are on into it, in a few words, and keep`,
    `it true as the work moves.</desk>`,
  ].join(" ");
}

// Everything a session is handed in front of the message this turn is about: what it overheard
// while it was not running, and the standing ask above while its desk says nothing. Blank lines
// between them, because they are separate things said by different people.
function inFrontOf(instance, name, message) {
  const said = [...carry(name)];
  if (deskTitle(instance.root, name) === "") {
    said.push(deskWrapper(name));
  }
  return withWhatWasOverheard(said, message);
}

// The desk a session keeps, said the way the session's own persona says it: relative to the
// directory a session is started in, which is the instance root. Never an absolute path — an
// instance that was moved would have been telling people about somewhere it no longer is.
function desk(name) {
  return path.posix.join(WORK, name, DESK_FILE);
}

// What a session is asked to do before its thread is ended.
//
// A wrapper, for the reason `wrap` is one: what is left OUTSIDE every wrapper is the human
// speaking on this session's own panel. An instruction from the chat handed over bare would arrive
// as the human having typed it, and that guarantee is the one thing this arrangement must not get
// wrong. The personas say what this one means.
//
// It asks for the desk and nothing else. Only the session may write it — the one permission an
// instance grants a person is `Edit(work/<Name>/STATE.md)` — so preparing cannot be something the
// server does to a file; it has to be a question, and a question is a turn.
function handoverWrapper(name) {
  return [
    `<handover>Your thread is about to be ended, and a new session takes this desk with none of`,
    `what you remember. Write ${desk(name)} so that session can carry on with nothing lost: what`,
    `the task is, what is true right now, what to do next, and what has already been settled so it`,
    `is not worked out twice. Leave the header's title: saying what this desk is on, so the rest of`,
    `us can see it without opening this panel. Then say in one line that you are ready. Start`,
    `nothing new.</handover>`,
  ].join(" ");
}

// What the panel says a handover is, while it happens and once it has. Written under `the chat`
// because nobody said it to anybody, and flagged, so what is checked is the flag rather than the
// prose.
//
// The transcript is not cleared with the thread. It is the record of what was said, and it is the
// only place a person can see where the memory stops.
function handoverAsked(human, name) {
  return `${human} asked ${name} to hand over. ${name} is writing ${desk(name)} before its thread ends.`;
}

function handoverDone(name) {
  return `${name} handed over. The thread that answered up to here is gone; the next message starts a new one, which reads ${desk(name)} first.`;
}

// The same moment, when the session could not be asked at all.
//
// The thread is gone either way, and that is not this route's doing: a run that fails to resume is
// dropped where it is asked, because losing the history beats losing the chat. What is lost here is
// the desk being written, so that is what the line is about.
function handoverUnanswered(name) {
  return `${name} could not be asked to hand over, so ${desk(name)} may not say where the work stands. Its thread is gone all the same; the next message starts a new one.`;
}

// What a session is asked for on its way out.
//
// The same shape as a handover and a different question. A handover is a session being replaced at
// a desk that stays, so what it writes is for whoever sits down next; this is the desk itself being
// put away, so what it writes is the record of what was done. It is asked for the title in the same
// breath, because the title is what the desk is filed under and this is the last moment anybody can
// ask for it.
//
// Wrapped, like every other instruction from the chat: what is outside a wrapper is the human.
function leaveWrapper(name) {
  return [
    `<leave>You are leaving this workspace, and this desk is being put away. Write ${desk(name)} as`,
    `the record of what was done: what the task was, where it ended, what was settled, and what`,
    `anybody picking it up later would need. Leave the header's title: saying what this desk was on`,
    `— it is the name this desk is filed under. Then say in one line that you are ready to leave.`,
    `Start nothing new.</leave>`,
  ].join(" ");
}

// What the panel says while a session is leaving and once it has. Under `the chat`, because nobody
// said it to anybody, and flagged, so what a check reads is the flag rather than the prose.
function leavingAsked(human, name) {
  return `${human} asked ${name} to leave. ${name} is writing ${desk(name)} before this desk is put away.`;
}

function leavingDone(name, where) {
  return `${name} has left. The desk is filed under ${where}, the thread that answered here is gone, and the name is free again.`;
}

// The same moment, when the session could not be asked at all. The desk is put away either way —
// somebody asked for this exit and a run that fails to resume has already lost its thread — so what
// this says is what was actually lost, which is the record being written before it was filed.
function leavingUnanswered(name, where) {
  return `${name} could not be asked before leaving, so ${desk(name)} may not say where the work ended. The desk is filed under ${where} all the same.`;
}

// Everything a session is asked or answers is under its own name, so one route shape serves
// every panel and there is no path through here that only the lead can take.
const SESSION_ROUTE = /^\/sessions\/([^/]+)\/(messages|message|permissions|permission|handover|leave)$/;

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
          // Put together here, where the turn begins, rather than where the message arrived:
          // anything said while this turn was waiting its place in the queue belongs to this turn,
          // and a desk written by the turn ahead of this one is not asked about again.
          inFrontOf(instance, name, sender === null ? asked.text : wrap(sender.name, sender.role, asked.text)),
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

// Handing a session over: it writes its desk, and then the thread that has been answering is
// ended, so the next message starts a new conversation that reads that desk first.
//
// It is a TURN, through the same queue every message goes through, and that is the whole design.
// A session answers one message at a time, so a handover cannot land in the middle of one and
// cannot be raced by the next; and `ask()` writes the thread id down AFTER the run returns, so a
// forget anywhere outside the turn would be written straight back by the very run it was ending.
// Nothing new had to be locked to get either.
//
// There is no process to end. A run lives for one message and is over before this returns.
async function postHandover(instance, name, response) {
  const done = await inTurn(name, async () => {
    const asked = append(instance.root, name, {
      from: THE_CHAT,
      text: handoverAsked(instance.config.human, name),
      handover: true,
    });

    let answer;
    try {
      answer = await ask(
        instance,
        name,
        // Drained here as on any turn, so the thread hears what it was owed before it goes and
        // the session that follows it starts owed nothing.
        withWhatWasOverheard(carry(name), handoverWrapper(name)),
        (request) => park(name, request),
      );
    } finally {
      giveUp(name);
    }

    const reply = append(instance.root, name, {
      from: name,
      text: answer.text,
      ...(answer.failed ? { failed: true } : {}),
      ...(answer.silent ? { silent: true } : {}),
    });

    forget(instance.root, name);

    const ended = append(instance.root, name, {
      from: THE_CHAT,
      text: answer.failed ? handoverUnanswered(name) : handoverDone(name),
      handover: true,
      ...(answer.failed ? { failed: true } : {}),
    });

    return { asked, reply, ended };
  });

  sendJson(response, 200, done);
}

// A session leaving: it writes its desk as the record, and then the desk is put away — filed under
// the day, the name and what it was on, with the panel that goes with it — and the thread ends.
//
// A TURN, for the three reasons a handover is one: only the session may write its own desk, a turn
// cannot land in the middle of another, and `ask()` writes the thread id down after its run
// returns, so anything that ends a thread outside the turn is written straight back by the run it
// was ending.
//
// The order inside it is the whole of what makes the record true. The session is asked FIRST and
// the desk is read for its title only after the answer, or a session that says what it was on in
// this very turn would be filed under what it used to be on. And the line saying it has left is
// written to the panel BEFORE the panel is moved, so the record ends with the moment it ends at.
async function postLeave(instance, name, response) {
  // The lead is not a desk that can be put away. An instance has one by definition and the chat
  // hosts it whether or not it has a desk, so a lead that left would still be here, with nowhere to
  // read what it was doing and nothing to write it to.
  if (name === instance.config.leader) {
    sendJson(response, 400, { error: `${name} leads here, so this desk stays` });
    return;
  }

  const done = await inTurn(name, async () => {
    const asked = append(instance.root, name, {
      from: THE_CHAT,
      text: leavingAsked(instance.config.human, name),
      leaving: true,
    });

    let answer;
    try {
      answer = await ask(
        instance,
        name,
        // Drained here as on any turn, so a thread hears what it was owed before it goes.
        withWhatWasOverheard(carry(name), leaveWrapper(name)),
        (request) => park(name, request),
      );
    } finally {
      giveUp(name);
    }

    const reply = append(instance.root, name, {
      from: name,
      text: answer.text,
      ...(answer.failed ? { failed: true } : {}),
      ...(answer.silent ? { silent: true } : {}),
    });

    // Where it is going is settled before the last line is written, so that line can say where.
    const { at, where } = archiveFor(instance.root, name);
    const left = append(instance.root, name, {
      from: THE_CHAT,
      text: answer.failed ? leavingUnanswered(name, where) : leavingDone(name, where),
      leaving: true,
      ...(answer.failed ? { failed: true } : {}),
    });

    // Nothing ends the thread separately. A session's memory between runs is one file inside the
    // directory this takes away, so filing the desk away IS the thread ending — and a `forget`
    // here would be a second way of doing something that has to happen exactly once.
    retire(instance.root, name, at, panelFile(instance.root, name));

    return { asked, reply, left, archived: where };
  });

  sendJson(response, 200, done);
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

// One row about one session: who they are, and everything that is true of them right now.
//
// It is one route rather than one per question, and the page asks for it on a tick it was already
// running. Whoever is looking at a workspace wants the same handful of things about everybody at
// once — who is here, what each is on, which of them is mid-turn, how big each conversation has
// grown — and asking for those one at a time is a request per person per question.
//
// Two lifetimes meet on this row and it is worth knowing which is which. How many turns are going,
// who is waiting for whom and what is waiting to be allowed live in THIS process and are gone when
// it restarts; what a session is called and how big its thread is are on disk and are not. A chat
// that has just been started correctly says nobody is busy.
function everySession(instance, session) {
  const going = turnsGoing(session.name);

  return {
    ...session,
    // Whether it is this panel's turn yet: waiting to be answered and being answered are the same
    // thing to somebody typing into it.
    busy: going > 0,
    // And how many are behind the one being answered, which is the part a panel cannot show.
    queued: Math.max(going - 1, 0),
    // Who it is held waiting on, if anybody. A session whose turn is waiting for another session's
    // answer is not slow, it is blocked, and the two look identical from outside.
    waitingFor: waitingFor(session.name),
    // And what it is waiting to be ALLOWED to do, which is a session held up by a person rather
    // than by another session. Today that is visible only on the panel it happened on, which is
    // the one place somebody looking for who needs them is not looking.
    asking: parked(session.name).length,
    // Whether there is a conversation to carry on. Not `context !== null`: a run that reported no
    // usage is remembered without a reading, so a live thread and no thread look the same there.
    thread: hasThread(instance.root, session.name),
    // When anything last happened on its panel. A fact and not a verdict — nothing here knows
    // whether a quiet session is finished, stuck or merely quiet, and the person reading does.
    active: lastAt(instance.root, session.name),
    // And what it is on, in the session's own words, from the one header field its persona asks
    // it to keep current. Nothing else can answer this: a name says who somebody is and a
    // transcript says what they were last asked, neither of which is what they are working on.
    doing: deskTitle(instance.root, session.name),
  };
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
    sendJson(response, 200, { sessions: sessions(instance).map((session) => everySession(instance, session)) });
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

    if (request.method === "POST" && what === "handover") {
      await postHandover(instance, name, response);
      return;
    }

    if (request.method === "POST" && what === "leave") {
      await postLeave(instance, name, response);
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
