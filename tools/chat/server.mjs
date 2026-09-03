// The instance's chat server: one page, and one panel for each session in the instance.
//
// It listens on 127.0.0.1 only. A workspace is one person's machine, and a chat that can
// drive a Claude Code session is not something to put on a network by accident.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { append, lastAt, panelDirectory, panelFile, read } from "./conversation.mjs";
import { HOST, record } from "./listening.mjs";
import { respond } from "./mcp.mjs";
import { carry, overhear } from "./overheard.mjs";
import { allow, answer as settle, giveUp, park, parked, refuse } from "./permissions.mjs";
import { roomLines } from "./room.mjs";
import { DESK_FILE, DeskError, WORK, archiveFor, deskTitle, describeName, hire, isName, retire } from "../desks.mjs";
import { ask, forget, hasGoneCold, hasThread, sessions } from "./session.mjs";
import { inTurn, turnsGoing, waitingFor, whileWaitingFor, wouldWaitForItself } from "./turns.mjs";
import { takeWord } from "./untold.mjs";
import { version } from "../version.mjs";

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

// What the lead's panel says when the toolkit underneath it was replaced.
//
// Under `the chat` and not under anybody's name, for the reason an overheard line is: nobody said
// it to anybody. The version it was on and the version it is on now, then what the release said
// about itself, because a person looking at this panel wants to know what changed and there is
// nowhere else in the instance that says.
function updateLine(from, to, notes) {
  return `the toolkit was updated from ${from ?? "no recorded version"} to ${to}. What the release says changed:\n\n${notes}`;
}

// The same thing said to the lead's model, and it has to explain itself.
//
// An update ships new templates and re-renders no persona, so the lead reading this is running the
// one written before any of it existed: there is no paragraph in its instructions to look this up
// in. So the wrapper says, in itself, that the chat is speaking rather than the human, what was
// replaced, what was deliberately left alone, and that it is the only one here who knows. That
// last part is the whole point of telling it at all — the lead is what tells everybody else.
function updateWrapper(from, to, notes) {
  return [
    `<update from="${from ?? ""}" to="${to}">`,
    "The chat is telling you this. Nobody typed it.",
    `The toolkit this workspace runs on was replaced while nothing here was running: it was on ${from ?? "no recorded version"} and is now on ${to}. Your desks, the personas everybody here is running under, and everything this workspace has learned were left exactly as they were.`,
    "What the release says changed:",
    notes,
    "Everybody here was hired under the arrangement before this one, you included, and nobody else has been told. Work out from those notes what is different now, and say it to whoever it affects.",
    "</update>",
  ].join("\n\n");
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
function inFrontOf(instance, name, message, restarted = false) {
  // Ahead of everything, when there was one. A session that does not yet know it has lost its
  // memory would read what it overheard as things it remembers being told.
  const said = restarted ? [pickUpWrapper(name)] : [];
  said.push(...carry(name));
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

// What a session is asked for at the two moments a thread ends: anything it worked out that the
// next one would otherwise work out again.
//
// It rides on the handover and the leave rather than on every turn. The title ask can sit on every
// turn because it is self-limiting — it stops the moment the field is filled — and "have you learned
// anything" has no such condition, so asking it always would be a sentence in every turn forever. A
// thread ending is the only moment something is actually about to be lost.
//
// It names the memory rather than describing it. Claude Code puts what the workspace has learned in
// front of every session before it is asked anything, and adding to it takes a Write and no
// permission this instance has to grant. So a session already has both the file and the hands, and
// what was missing was being asked.
//
// One sentence, inside the wrapper, after the desk. The desk is this task and the memory is the
// workspace; a session that runs out of turn loses the desk, which is the right one to lose.
const WHAT_WAS_LEARNED =
  "Anything you worked out here that the next person would otherwise work out again — how something" +
  " works, a trap, a decision and the argument that took it — put in your memory, which every session" +
  " after you reads before it is asked anything; the desk is this task, the memory is the workspace.";

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
    `us can see it without opening this panel. ${WHAT_WAS_LEARNED} Then say in one line that you`,
    `are ready. Start nothing new.</handover>`,
  ].join(" ");
}

// What a session is told when its thread ended while nobody was speaking to it.
//
// The mirror of handoverWrapper, and a wrapper for the same reason: what is left OUTSIDE every
// wrapper is the human speaking on this session's own panel, so an instruction from the chat handed
// over bare would arrive as the human having typed it. Where the handover says "your thread is
// about to end, write your desk", this says "your thread has ended, read it".
//
// It rides only on the turn that follows a reset. Whether there was one is known where it happened
// and is passed in from there, so this costs a sentence exactly once and nothing on any turn after.
//
// It does not apologise for the loss or explain the cache. What the session can act on is where the
// work stands, and that is on the desk.
function pickUpWrapper(name) {
  return [
    `<pick-up>Nobody spoke to you for long enough that the conversation you were having ended by`,
    `itself, and this is a new one: you remember none of it. Read ${desk(name)} before anything`,
    `else and carry on from what it says the work is, what is true right now and what to do next.`,
    `If what you find there is behind where the work actually got to, say so in your reply rather`,
    `than guessing at the difference.</pick-up>`,
  ].join(" ");
}

// The same moment on the panel, in the voice handoverDone and leavingDone already use. It is for
// the person who opens this panel later and finds the memory stops here — without it, a transcript
// that runs on either side of a reset reads as one continuous conversation, which is the one thing
// it is not.
//
// Written before the question, so the record reads in the order it happened.
function coldLine(name) {
  return `${name} had been quiet for longer than a conversation can be carried, so the thread that answered up to here is gone. What follows was answered by a new one, which reads ${desk(name)} first.`;
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
    `— it is the name this desk is filed under. ${WHAT_WAS_LEARNED} Then say in one line that`,
    `you are ready to leave. Start nothing new.</leave>`,
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

// When the limit lifts, in the reading of whoever is looking at this panel. The frame gives a unix
// second; a person wants an hour, and the hour they want is theirs. Nothing here is computed from a
// clock of our own — the moment comes from the service and only its spelling is ours.
function atTime(seconds) {
  const when = new Date(seconds * 1000);
  return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
}

// What the panel says when the service turned the run away. Under `the chat` because nobody said it
// to anybody, and flagged, so what a check reads is the flag rather than the prose.
//
// It is built from the fields the frame carried and from nothing else. The service also sends a
// sentence of its own — "You've hit your session limit · resets 9am" — and that sentence is exactly
// what used to land here under the session's name, which is the whole bug: a panel saying a worker
// said something it never said. So the prose is dropped rather than quoted, and what is said here is
// said from `resetsAt` and `rateLimitType`.
//
// The kind is spelled as it arrives, with its underscores opened out: `five_hour` is the service's
// word for it and inventing a friendlier one means a table of them, kept true by somebody, for a
// word the service can change under us. A limit that names no kind and no reset is still reported;
// it is a refusal either way, and the sentence simply says less.
function limitSaid(refused) {
  const kind = refused.kind === null ? "a usage limit" : `a ${refused.kind.replace(/_/g, "-")} limit`;
  return refused.resetsAt === null ? kind : `${kind}, which lifts at ${atTime(refused.resetsAt)}`;
}

function refusedLine(name, refused) {
  return `Nothing reached ${name}: the service turned the run away on ${limitSaid(refused)}. Its conversation is untouched and nothing was lost — say it again once the limit has lifted.`;
}

// The same moment on a handover, where what is at stake is different and worse. A handover asks a
// session to write its desk and then ends its thread; if the run is turned away, the desk was not
// written — and until this slice the thread was ended anyway, which is the one place this toolkit
// was worse than the office it is modelled on. So nothing is ended, and the line says that, because
// a person who has just pressed a button needs to know whether it cost them anything.
function handoverRefused(name, refused) {
  return `${name} could not be asked to hand over: the service turned the run away on ${limitSaid(refused)}. Nothing was ended — its thread and ${desk(name)} are exactly as they were — so hand over again once the limit has lifted.`;
}

// And on the way out. A desk is filed under a date and a title the session is asked for on this
// very turn, so a leave that was refused has nothing to file: the desk stays open, the name stays
// taken, and nobody has left.
function leavingRefused(name, refused) {
  return `${name} could not be asked before leaving: the service turned the run away on ${limitSaid(refused)}. Nothing was filed and the desk is still open — ask again once the limit has lifted.`;
}

// Everything a session is asked or answers is under its own name, so one route shape serves
// every panel and there is no path through here that only the lead can take.
const SESSION_ROUTE = /^\/sessions\/([^/]+)\/(messages|message|permissions|permission|handover|leave)$/;

// Delivering a message to a session: everything between it arriving and the answer coming back,
// whoever sent it and however it got in.
//
// One function, because there is more than one way in — the page and a terminal post it to the
// route, a session calls it as a tool — and "the tool does exactly what the command does" is worth
// nothing written down. Here it is the same thing because there is only one of it.
//
// `signed` is the name of the session sending it, or null for the human. It answers { status,
// body }: what the route sends back, and what the tool reads its own answer out of.
//
// THE INVARIANT ON THIS PATH: a message may be delayed, and the conversation that answers it may be
// replaced, but it is never parked on a state the addressee is stuck in. The refusals below are all
// about the MESSAGE — empty text, a signature naming nobody, a circle that would deadlock both
// ends, a session that has left — and not one of them is about how the addressee is doing.
//
// That is deliberate and it is what makes it safe to test a session's own state here at all. A
// message refused because of the state a session is in makes that state unreachable: a session
// nobody can reach cannot be told to stop being that way, and the only thing left is a person
// noticing. So a state test on this path has to answer one question before it is written — what
// happens to the message when the answer is yes? If the answer is "it waits for somebody", it does
// not belong here. Ending a stale conversation and delivering is fine; declining to deliver is not.
async function deliver(instance, name, text, signed) {
  if (typeof text !== "string" || text.trim() === "") {
    return { status: 400, body: { error: "a message needs some text" } };
  }

  // A signature naming nobody who works here is refused rather than passed on as the human's: a
  // message arriving as somebody it is not is the one mistake this whole arrangement exists to
  // prevent.
  const sender = signed === null ? null : (sessions(instance).find((session) => session.name === signed) ?? null);
  if (signed !== null && sender === null) {
    return { status: 400, body: { error: `nobody called ${signed} works here` } };
  }
  // A message that would close a circle is answered now rather than queued: the sender's own turn
  // is what the addressee is waiting for, so joining the queue would stop both of them for good.
  // The refusal is written into the sender's own transcript as well as returned, so somebody
  // reading that panel can see why nothing was delivered.
  if (sender !== null && wouldWaitForItself(sender.name, name)) {
    const why = `${name} is waiting for your answer, so it cannot take a message until you have given it — say this in your reply instead`;
    append(instance.root, sender.name, { from: THE_CHAT, text: `not delivered to ${name}: ${why}`, failed: true });
    return { status: 409, body: { error: why } };
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
  const answered = await whileWaitingFor(sender?.name ?? null, name, () =>
    inTurn(name, async () => {
      // Whether this session is still here, asked again where the turn begins. The route said so
      // when the message arrived, and a message that was waiting behind a leave arrived while it
      // still was. Answering it now would start a thread and a panel for somebody who has gone,
      // under a name that was just freed — which is the whole of what leaving was for.
      if (!sessions(instance).some((session) => session.name === name)) {
        return { gone: true };
      }

      // A conversation nobody carried on for long enough is ended here rather than resumed. The
      // whole of ending one is removing the file that holds it: the desk, the persona, the
      // permission rule and the panel are all untouched, and there is no process to stop, so what
      // this costs is the conversation and nothing else.
      //
      // Asked where the turn begins and not where the message arrived. A message that waited behind
      // a long turn may have gone from warm to cold while it waited, and the reading that decides
      // is the one taken the moment before the run.
      //
      // It is lossy and there is no version of this that is not: whatever the session worked out
      // and never wrote to its desk is gone. Asking it to write the desk first is exactly the
      // expensive turn being avoided, so it is not done, and the personas say so instead.
      const restarted = hasGoneCold(instance.root, name);
      if (restarted) {
        forget(instance.root, name);
        append(instance.root, name, { from: THE_CHAT, text: coldLine(name), cold: true });
      }

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
          inFrontOf(
            instance,
            name,
            sender === null ? asked.text : wrap(sender.name, sender.role, asked.text),
            restarted,
          ),
          (request) => park(name, request),
        );
      } finally {
        // Whatever it was still asking about, it is not there to hear the answer now.
        giveUp(name);
      }

      // The service turned the run away, so there is no reply and nothing may be written as one.
      // The question stays where it is — it was asked, it is part of the record, and the next
      // attempt is a person saying it again — and what follows it is the chat saying what became
      // of it, in its own voice and under its own name.
      if (answer.refused !== null) {
        return {
          restarted,
          question: asked,
          refused: append(instance.root, name, {
            from: THE_CHAT,
            text: refusedLine(name, answer.refused),
            refused: true,
          }),
        };
      }

      return {
        restarted,
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

  if (answered.gone === true) {
    return { status: 409, body: { error: `${name} left before this could be delivered` } };
  }

  // Turned away, and said as its own outcome rather than as a 200 carrying a reply that is not one.
  // 503 because that is what happened: the service this run needed was not available, it is not
  // this message's fault and it is not the addressee's, and the same message sent again later is
  // the whole of the repair.
  //
  // This is NOT the state gate the invariant above rules out. Nothing is remembered about the
  // limit, nothing consults it, and the next message is attempted exactly like this one — which is
  // why the message queued behind this one is run rather than held.
  if (answered.refused !== undefined) {
    return { status: 503, body: { error: answered.refused.text, refused: true } };
  }

  // Said back to whoever asked, and not only on the addressee's panel. The caller of `say` is a
  // different session that never reads that panel, and it is the one reader most in need of
  // knowing: a lead about to act on an answer it would otherwise take as continuous with the
  // conversation it remembers having.
  return {
    status: 200,
    body: {
      message: answered.question,
      reply: answered.reply,
      ...(answered.restarted ? { restarted: true } : {}),
    },
  };
}

async function postMessage(instance, name, request, response) {
  let text;
  let from;
  try {
    ({ text, from } = JSON.parse(await readBody(request)));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  // The page signs nothing, so an unsigned message is the person at the page or the person at a
  // terminal — either way, the human.
  const signed = typeof from === "string" && from.trim() !== "" ? from.trim() : null;

  const { status, body } = await deliver(instance, name, text, signed);
  sendJson(response, status, body);
}

// One path per session, and the name in it is who the caller IS.
//
// It is not a name the session can choose. The chat writes this address into the configuration it
// starts that session with, out of the same name it puts in its environment, so what reaches here
// is the workspace's word for who is calling and not the model's. A session cannot sign as
// somebody else because it is never asked to sign at all.
//
// One path shape rather than one per kind of session, for the reason there is one spawn path
// rather than one per kind: what a session may do is decided here, from its name, and not by
// which door it was given.
const TOOL_ROUTE = /^\/mcp\/([^/]+)$/;

// What the server calls itself. It is the name in the configuration too, and therefore the first
// half of every tool name a session sees — and of the one permission rule that grants them.
const TOOLKIT = "office";

// What a session may do here without composing a shell line.
//
// The standing limit: nothing that deletes, archives or spawns joins this list without being
// designed in. The reason is the permission rule rather than the tools — a rule can name a server
// but not an argument, so every tool here is granted the moment it appears, and adding a
// destructive one is a change to what a session is allowed and not only to what it can reach.
//
// The description says what the tool refuses as well as what it does. Measured: a session that
// cannot SEE a tool goes hunting for another way round the same thing and runs commands nobody
// asked it to; one that can see it and reads why it would be refused does not call it at all.
function toolsFor(instance, caller) {
  const lead = leads(instance, caller);

  return [
    {
      name: "say",
      description:
        "Say something to another session working here and wait for their answer, which comes back as the answer to this call. It arrives on their panel under your own name — taken from this workspace, never from anything you say — and it holds you for the whole of their turn. It reaches one session: there is no way to address everybody, and nothing here starts, ends or files anybody's work.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "The name of the session to say it to." },
          message: { type: "string", description: "What to say. Whatever it holds, it arrives exactly as written." },
        },
        required: ["to", "message"],
        additionalProperties: false,
      },
      run: (args) => saidByTool(instance, caller, args),
    },
    {
      name: "status",
      description:
        "List who works in this workspace and what each of them runs on. One desk is one person, and the name in this list is what the say tool addresses. It reads and changes nothing, and it says nothing about who is busy.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => whoWorksHere(instance),
    },
    {
      name: "room",
      description:
        "The room at this instant: one line for each person saying what they are on, whether they are answering and how many messages are waiting behind, who is held up waiting for whom, who is stopped waiting to be allowed something, how big each conversation has grown and how long since anything happened on their panel. It is the lead's, because it is what deciding who does what next takes and nobody else here decides that. It reads and changes nothing.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      // Both halves of the same answer. The list is what a session reads before it decides whether
      // to call, and the refusal is what makes the decision hold — a tool left off the list is
      // advice, and advice is not what a session that heard about the room somewhere else obeys.
      offered: lead,
      run: () =>
        lead
          ? theRoom(instance)
          : { refused: `the room is the lead's to look at, so ask ${instance.config.leader} for it` },
    },
  ];
}

// Which of the sessions working here is the one that leads, decided in one place and from one
// thing: the name in the path against the name this instance was made with.
//
// Never an argument and never a header. The model writes both of those, so a session that could
// say which of them it was would be deciding for itself what it may do — and the name in the path
// is the chat's own word, written into the configuration it started that session with.
//
// It is a mistake net rather than a boundary. Nothing here asks who is knocking and the routes are
// open on the loopback address, so anything running as this person can post to any path. What it
// stops is our own sessions reaching for each other's business, which is the thing that happens.
function leads(instance, caller) {
  return caller === instance.config.leader;
}

// The room, in the same lines the command prints — the same rows off the same list, laid out by
// the same function, so that the lead reading it here and the person reading it in a terminal are
// never told two different things.
function theRoom(instance) {
  return { text: roomLines(sessions(instance).map((session) => everySession(instance, session))).join("\n") };
}

// Who works here, which is the half of `ow status` a session can act on: the names it can say
// something to, and what each of them costs to ask. The other half of that command — where the
// instance is, what version it is on, whether there is a credential — is a person's question about
// the machine, and one of its rows starts Claude Code to answer it. A tool a session calls before
// every message is the wrong place for that.
//
// It comes from the same `sessions()` the page is drawn from and the same `desks()` the command
// reads, so there is one answer to who works here and no second list to keep true.
function whoWorksHere(instance) {
  const here = sessions(instance);
  const width = Math.max(...here.map((session) => session.name.length));

  return { text: here.map((session) => `${session.name.padEnd(width)}  ${session.role.padEnd(6)}  ${session.model}`).join("\n") };
}

// The tool behind `say`, which is the command behind `say`: it hands what it was given to the one
// function everything that delivers a message goes through, signed with the name from the path.
//
// The two refusals it makes for itself are the ones the route makes in `handle()` before a message
// gets this far — a name nobody could have, and a name nobody here has. They are made here rather
// than left to the delivery, because a turn started for somebody who does not work here would
// answer "they left before this could be delivered", which is a different and untrue sentence.
async function saidByTool(instance, caller, args) {
  const to = args?.to;
  if (!isName(to)) {
    return { refused: describeName("to", to) };
  }

  const here = sessions(instance);
  if (!here.some((session) => session.name === caller)) {
    return { refused: `nobody called ${caller} works here` };
  }
  if (!here.some((session) => session.name === to)) {
    return { refused: `nobody called ${to} works here` };
  }

  const answered = await deliver(instance, to, args?.message, caller);
  if (answered.status !== 200) {
    return { refused: answered.body.error };
  }

  // In the tool's own words rather than as a flag: what comes back here is read by a model, and a
  // field beside the text is a thing it may or may not look at. Before the answer, because it
  // changes what the answer is worth.
  if (answered.body.restarted === true) {
    return { text: `(${to} had gone quiet for too long, so it answered this from a new conversation, having read its desk rather than remembering what you told it before.)\n\n${answered.body.reply.text}` };
  }

  return { text: answered.body.reply.text };
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
    // What the toolkit is, said where a client asks who it is talking to. An instance from before
    // the toolkit carried a version still answers, with the truth about itself.
    version: version(instance.root) ?? "unknown",
    tools: toolsFor(instance, caller),
  });

  // A notification is not answered. There is nothing to send, and sending an empty object would
  // have a client pair it with a question it never asked.
  if (body === null) {
    response.writeHead(status).end();
    return;
  }

  sendJson(response, status, body);
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

    // Turned away, so nothing happens. Not the reply row — the session said nothing and the
    // service's own sentence is not its words — and above all not the `forget` below, which would
    // throw the conversation away for a condition that clears by itself, on the one turn where the
    // desk that would have replaced it was never written either.
    //
    // This is the whole of why this slice exists. The rest of the feature stops a refusal costing a
    // message; here it was costing the record of what a session was doing, and there is nothing to
    // read it back from.
    if (answer.refused !== null) {
      const ended = append(instance.root, name, {
        from: THE_CHAT,
        text: handoverRefused(name, answer.refused),
        handover: true,
        refused: true,
      });

      return { asked, ended, refused: true };
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

  sendJson(response, done.refused === true ? 503 : 200, done);
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

    // Turned away, and nothing below this line runs. The order matters and is the reason this
    // branch is here rather than three lines down: `archiveFor` does not only work out where the
    // desk would go, it MAKES the directory. A refused leave that got as far as asking would leave
    // an empty archive behind for a session that is still sitting at its desk.
    //
    // Nothing is filed, nothing is retired, the name stays taken, and the thread — which on this
    // route is the desk directory itself — is exactly where it was.
    if (answer.refused !== null) {
      const left = append(instance.root, name, {
        from: THE_CHAT,
        text: leavingRefused(name, answer.refused),
        leaving: true,
        refused: true,
      });

      return { asked, left, refused: true };
    }

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

  sendJson(response, done.refused === true ? 503 : 200, done);
}

// Opening a desk for somebody new, which is what the page's Hire button posts to.
//
// It writes what `ow hire` writes by calling the same function, so what a name is refused for has
// one answer rather than two that can drift apart, and the page shows that answer in the words it
// came in. Nothing is started: a desk is a person, and a chat already running hosts one from the
// next load of the page.
//
// 201 rather than 200, because this is the one route that makes something that was not there.
async function postSessions(instance, request, response) {
  let name;
  try {
    ({ name } = JSON.parse(await readBody(request)));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  // The one refusal that is not about the name itself but about there being none. `ow hire` says
  // the same thing about an empty command line.
  if (typeof name !== "string" || name.trim() === "") {
    sendJson(response, 400, { error: "hiring needs a name" });
    return;
  }

  let wrote;
  try {
    wrote = hire(instance.root, name, panelDirectory(instance.root, name), instance.config);
  } catch (error) {
    if (error instanceof DeskError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    throw error;
  }

  // Said relatively, as everything else written into an instance is: an instance holds no
  // absolute path anywhere, and the page is looking at the same directory the server is in.
  sendJson(response, 201, { name, wrote: wrote.map((file) => path.relative(instance.root, file)) });
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
    // Whether the next message to this session will end its conversation and start a new one. Not
    // a guess at the model service's cache, which cannot be read and must not be guessed at: it is
    // the same clock and the same rule the chat itself acts on, so the room is describing what is
    // about to happen rather than estimating what is true.
    //
    // Its own word, beside `active` rather than folded into it. They answer different questions —
    // when the panel last moved, and whether the conversation behind it survives — and on the lead
    // they routinely disagree, which is the whole reason this exists.
    cold: hasGoneCold(instance.root, session.name),
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

  if (request.method === "POST" && url.pathname === "/sessions") {
    await postSessions(instance, request, response);
    return;
  }

  const calling = TOOL_ROUTE.exec(url.pathname);
  if (request.method === "POST" && calling !== null) {
    await postTool(instance, decodeURIComponent(calling[1]), request, response);
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

// The lead is told that the toolkit under it was replaced, if it has not been told already.
//
// The word was left in a file rather than handed to anybody because whatever left it was running
// while this chat was not — an update stops the chat, which is the same thing as saying it takes
// with it everything a running chat was holding in memory. So the chat asks, every time it starts,
// whether anything happened while it was away.
//
// Both halves, for the reason the overheard pair is both halves: the panel is what a person reads
// and the wrapper is what the lead's model hears, and neither is the other.
function tellTheLead(instance) {
  const said = takeWord(instance.root);
  if (said === null) {
    return null;
  }

  const line = append(instance.root, instance.config.leader, {
    from: THE_CHAT,
    text: updateLine(said.from, said.to, said.notes),
    update: true,
  });
  overhear(instance.config.leader, updateWrapper(said.from, said.to, said.notes));
  return line;
}

export function serve(instance) {
  // Before a single request is answered, so the panel says what happened to this instance ahead of
  // the first person who looks at it. Here rather than in whatever started the server, for the
  // reason record() below is here: every way of serving an instance does it, and none of them has
  // to remember to.
  tellTheLead(instance);

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
