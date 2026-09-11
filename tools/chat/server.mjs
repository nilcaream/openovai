// The instance's chat server: one page, and one panel for each session in the instance.
//
// It listens on 127.0.0.1 only. A workspace is one person's machine, and a chat that can
// drive a Claude Code session is not something to put on a network by accident.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { THE_CHAT, append, lastAt, panelDirectory, panelFile, read } from "./conversation.mjs";
import { HOST, record } from "./listening.mjs";
import { respond } from "./mcp.mjs";
import { OFFLINE, goOffline, goOnline, offline } from "./offline.mjs";
import { heard, overhear, owed } from "./overheard.mjs";
import { allow, askedFor, answer as settle, giveUp, inside, park, parked, refuse, shapeOf } from "./permissions.mjs";
import { popped } from "./pop.mjs";
import { answerFrom } from "../plugins.mjs";
import { SKILL as ALLOWED } from "../skills.mjs";
import { ago, roomLines, shareSaid } from "./room.mjs";
import { WATCH_EVERY, armTheWatch, buysATurn, forgetTheRoom, howOften, nowSeen, parkAttemptsAllowed, theWatchRecord, tickRead, whatChanged } from "./watch.mjs";
import { DESK_FILE, DeskError, WORK, allowAsked, archiveFor, deskTitle, describeName, hasSettledAnything, hire, isName, personaFile, retire } from "../desks.mjs";
import { accountStanding, ask, bandIn, endRun, forget, fullnessIn, hasGoneCold, hasGoneQuiet, hasNearlyGoneCold, hasThread, quotaIn, ranAt, refusedIn, sessions, standingsUnderway } from "./session.mjs";
import { NO_NEW_WORK, spawnHeld } from "./gate.mjs";
import { endHold, enterHold, forgetRefused, holdIn, holdLifted, holdSaid, holdStands, markParked, markRefused } from "./hold.mjs";
import { inTurn, turnsGoing, waitingFor, whileWaitingFor, wouldWaitForItself } from "./turns.mjs";
import { unfinished } from "./unfinished.mjs";
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

// And the other end of it: what a turn carried is settled here, on what the run amounted to.
//
// THE PROPERTY, and the reason this is a function rather than three lines written out three times:
// a debt is cleared only once the run that carried it answered. A run the service turned away
// never got a turn, and a run that fell over never finished one — in both, the lines were handed
// to nobody, and a queue emptied at the top of the turn would have no way back. What is left of
// them then is the panel row, which is what a PERSON reads and not what the model hears.
//
// It is the same reading the rest of a turn already takes on this path. A refusal leaves the
// question on the panel to be asked again, leaves the thread unforgotten, hands no desk over and
// files none away; this is that list with the one thing on it that used to be lost.
//
// Flagged rather than smoothed over: a run that took a turn and THEN failed would be handed its
// lines a second time. Every failure watched here is a run that never got that far — no result
// frame at all, or one carrying no turn — so the shape that would double a line is not one
// anybody has seen, and it is named rather than guarded against.
function settleWhatWasOverheard(name, carried, answer) {
  if (answer.refused === null && answer.failed !== true) {
    heard(name, carried);
  }
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

// The one question a workspace is worth asking before anything else happens in it, asked once.
//
// A fresh workspace grants two things: one desk each, and the tools the chat serves. Everything
// else stops a run mid-turn and waits on a panel, which is the right default and is not what this
// is about. What this is about is that the person then finds out what they are willing to allow one
// interruption at a time, over days, each one arriving in the middle of somebody else's work and on
// a panel they may not have open. Nobody ever asks them the question that would settle most of them
// at once, while they are thinking about the workspace rather than about whatever a session was
// doing when it stopped.
//
// FIRED ON A TRANSITION AND NEVER ON A CONDITION, which is what keeps it from being a sentence in
// every turn forever. The transition is the workspace's first turn, and it is read from two things
// that are already there and are already read elsewhere: nothing has ever run here, and nothing has
// ever been granted here. Nothing new is stored, and there is nothing to clear — the block stops by
// either becoming false, which the first turn and the first press respectively do.
//
// THE TRADE, SAID RATHER THAN HIDDEN. A lead handed over in a workspace that has still granted
// nothing is asked again, because a new conversation does not know the question was put once. That
// is one repeated question in a workspace where nothing has been settled, and it is the cheapest
// honest answer: a marker file of its own, or a key in the config, would be a second record of one
// fact, and the day the two disagree the workspace is confidently wrong about whether it ever asked.
//
// IT GRANTS NOTHING. No rule is composed here, none is written, and what the person says is not
// parsed, recorded or turned into a setting: every rule this workspace holds is still a press on a
// panel and the line beside it saying who asked. The lead's part is to ask, and then to make the
// calls the answer permits so that each one stops where a person can answer it.
// WHAT A TRIP HAS TO DO, and not only what to trip. Read on two real instances before this was
// written: told "you may run git", the lead ran `git status`, which the frame reads and lets
// through — nothing parked, nothing was granted — and it reported the command settled. Told "no
// restrictions" with no command named, it improvised `ls`, and the sentence forbidding exactly that
// held only because `ls` never parks either. And needing something to write, it wrote the person's
// own answer into a file, which is the one thing this feature says is recorded nowhere. None of the
// three is a defect in the code: the code never saw a request in the first two, and it records
// nothing in the third. They are three sentences the block did not say, so it says them.
//
// AND WHAT IT CANNOT SEE, read on the same instances one turn later: both calls parked and were
// pressed — `Bash(git:*)` and `Edit(work/**)` in the settings, a line each in the ledger — and the
// lead told the person nothing had been granted because nothing had stopped, with a mechanism it
// had invented for why. Neither half of that reaches it: a call settled by a rule never gets as far
// as the permission tool, and an allow carries nothing back, because the protocol's allow is
// `{behavior: "allow", updatedInput?: object}` and has no message in it where a deny has one. So a
// lead told to watch the panel fills the gap by guessing. It is not asked to any more — it is
// pointed at `.claude/allowed.md`, written in the same act as the rule, and a read like any other.
//
// AND WHY IT NOW DESCRIBES NOTHING ITSELF. This block used to open by saying what the workspace
// allowed — that nothing had run here and nothing had been granted beyond one desk each. True of a
// fresh instance, unreadable by the code that says it, and silent about the three things a person
// actually needs on this turn: what is denied, what never stops at all, and which of what is
// written the runtime is honouring. So the first thing it asks for is the skill that reads the
// files, and the person hears on turn one exactly the answer they will get in three weeks. One
// source, and the sentence nobody has to keep true.
//
function permissionsWrapper(instance, name) {
  if (name !== instance.config.leader) {
    return null;
  }
  // Nothing has ever run here...
  if (hasThread(instance.root, name)) {
    return null;
  }
  // ...and nothing has ever been granted here.
  if (hasSettledAnything(instance.root)) {
    return null;
  }

  return [
    "<permissions>",
    "The chat is telling you this. Nobody typed it.",
    `Run the \`${ALLOWED}\` skill first and read ${instance.config.human} what it answers: what this workspace denies, what it allows and who asked for each, what stops a session and waits on their panel, what never stops at all, and which of that the runtime is honouring here. It reads the files in this turn, so what they hear now is the same answer they get in three weeks when they ask again — and nothing in this block describes that state itself, because a sentence written months ago about a workspace nobody had installed yet is the one thing they cannot check.`,
    `Whatever it comes to, everything not settled by a rule stops a session mid-turn and waits on a panel. That is the right default, and it means ${instance.config.human} would otherwise find out what they are willing to allow one interruption at a time, over days, each one arriving in the middle of somebody else's work.`,
    `Ask them the one question that settles most of it, now, while they are thinking about this workspace rather than about whatever a session was doing when it stopped: what may be done at this root. Ask it open and offer no menu — an answer sounds like "never push anything", "never write outside work/", "no restrictions", "ask me every time" — and take it as they say it. Nothing here reads it, records it or turns it into a setting.`,
    "Then, if what they said allows anything at all, make the calls it permits, one at a time, so that each one stops and they can press Always allow on it while the question is still in their head. There are two shapes to trip and no others: a COMMAND they named, never one you chose, and a WRITE at the path their answer names — where they named a place, at the root itself where they said no restrictions, and under `.tmp/` at the root where they named nowhere in particular. Tripping somewhere narrower than they allowed asks them to grant less than they said yes to, which is the one thing this exists to prevent.",
    "A TRIP ONLY COUNTS WHEN IT STOPS, and you cannot see whether it did. The frame settles a great deal on its own — `git status` and `ls` read and return, and nothing parks — so reach for the form of their command that parks rather than the form that reads. But a call coming back tells you nothing about which of the two happened: it returns the same whether the frame let it through, whether they pressed Allow for that one call, or whether they pressed the rule. You are not shown their panel and no press is reported back to you.",

    "WHAT WAS GRANTED IS A FILE, and reading it stops nobody. Every rule this workspace holds beyond a desk is one line in `.claude/allowed.md`, written in the same act as the rule itself and saying who asked, when, and what for. So when the calls are made, read it and report what is on its lines: that, and what you did, is the whole of what you know. Never tell them what did or did not stop — a lead reporting a press it cannot see is how a person is told that nothing was granted while the widest rule there is sits in their settings.",

    "If their answer allows commands but names none — `no restrictions` is such an answer — ask which command they want tripped, or trip only the write. Improvising one is how a rule gets granted for a command nobody asked for, and that is the first line in a ledger nobody can account for.",

    "The write is the trip and not the record. Put something inert at the path — a placeholder saying what the file is for — and never what they said: nothing here writes their answer down, and neither do you.",

    "A write at the root offers them the widest rule there is, `Edit(**)`. Say so in the same breath rather than stepping around it: a rule at the root covers every per-desk rule this workspace hands out, so from that press onward the one-rule-per-desk narrowness is decorative. Not a refusal — a sentence, so that the press is an informed one.",
    "Not now is a whole answer. Then nothing is tripped and nothing is granted, and this workspace stays exactly as capable as it is today, which is the point of asking rather than presetting. Either way, grant nothing yourself: what a rule is worth here is that somebody read it and pressed it.",
    "</permissions>",
  ].join("\n\n");
}

// Who has stopped, told to the session that leads and to nobody else.
//
// The room is the lead's and a worker has one task; the others are not its business. That is
// already true of the room it can ask for, and this is the same fact pushed.
//
// WHY IT IS PUSHED AT ALL, when the room is deliberately never carried into a turn. A room a
// minute old reads exactly like a room that is current, and would have somebody chasing a session
// that finished while they were reading about it. This is not the room. It is one line; it is not
// there at all while nobody has stopped; it says the moment it was read, so it cannot be taken for
// now; and it reports the one state that is not moving by definition. A session nobody carries on
// with for an hour has its conversation ended and begun again from its desk, and whatever it never
// wrote down goes with it — so this is the one reading where waiting to be asked for it costs
// something, and it is what makes the exception worth having.
//
// WHY NOBODY MID-TURN IS NAMED. A session's clock is rewritten when a run ENDS, so it stands still
// for the whole of a turn and a session working reads as one that has stopped. That one predicate
// is also what leaves the reader out: this is composed inside its own turn, so it is running, so it
// is not in its own list. There is no second rule saying "not me" — a rule that says the same thing
// another way is a second place for it to go wrong.
//
// It says who is speaking, for the reason the update note does: an update ships new templates and
// re-renders nobody's persona, so a session reading this may be running one written before any of
// it existed and has nothing to look it up in.
//
// It stops by being acted on, which is the shape the standing ask about a desk already has. Saying
// anything to a session starts a run and moves its clock; handing it over removes the thread
// altogether. Nothing here has to be cleared, and nothing remembers having said it.
//
// It asks the lead to press nothing. The chat's own pass ends a conversation nobody has carried on
// for an hour, and a block that asked the lead to hand people over by hand would be the product
// arguing with itself in front of the person reading both. What it still says is the reading and
// what the ending costs, because that is the reason a desk is kept current as the work moves.
function quietWrapper(instance, name) {
  if (name !== instance.config.leader) {
    return null;
  }
  const stopped = sessions(instance).filter(
    (session) => turnsGoing(session.name) === 0 && hasGoneQuiet(instance.root, session.name),
  );
  if (stopped.length === 0) {
    return null;
  }

  // The same words the room says of the same reading — a person and a session reading one line
  // each should not have to work out that two phrasings are one fact.
  const each = stopped.map((session) => `${session.name} last ran ${ago(ranOn(instance.root, session.name))}`);
  const when = new Date();
  const read = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;

  return [
    "<quiet>",
    "The chat is telling you this. Nobody typed it.",
    `${each.join(", and ")}. That is how long each has been doing nothing, read at ${read}, as this turn began.`,
    "A conversation nobody carries on for an hour is ended and begun again from the desk, and whatever it worked out and never wrote down goes with it. The chat's own pass ends it, at the hour, and asks nobody first; nothing here is yours to press.",
    ...olderInstructions(instance, name),
    "</quiet>",
  ].join("\n\n");
}

// The day the two blocks above and below stopped asking the lead to hand people over by hand,
// because the chat had begun doing it itself.
//
// A persona is rendered once, at hire, and an update re-renders nobody's — so a lead hired before
// this day is running instructions that still say handing a conversation over is a person's to
// press, and reads a block here that says the chat does it. Two instructions, one of them older,
// and the session has nothing to look up which. This sentence says which, and it is said only while
// that is true: read off the persona file's own modified time against this day, the same discipline
// as the standing ask about a desk — it costs a sentence while it applies and nothing at all once it
// does not, so it stops by everybody it was for having been hired after it.
const RETOLD_ON = Date.UTC(2026, 8, 11);

function olderInstructions(instance, name) {
  let rendered;
  try {
    rendered = fs.statSync(personaFile(instance.root, name)).mtimeMs;
  } catch {
    // No persona to contradict, so nothing to say about one.
    return [];
  }
  return rendered < RETOLD_ON
    ? ["If your instructions say otherwise, they were written before this, and this is what happens."]
    : [];
}

// Which conversations here have grown big enough to plan around, told to the session that leads and
// to nobody else.
//
// The third reading in this toolkit that is pushed, and it answers to the same list the one below
// does. A worker has one task and no say in when its conversation is handed over; which of them is
// worth handing over is the lead's, and it is the lead who would otherwise keep loading one.
//
// WHY IT IS PUSHED. The number is already on every row and on every panel, with no opinion attached
// — that is right for a person reading a room, and no use at all to a reader who never asks. A size
// nobody is handed until they think to want it is no use for a condition whose whole cost is that
// it goes unnoticed: the conversation that most needs handing over is the one whose reader has the
// least room left to notice it in.
//
// Every property that earns the exception is here, and each has a check:
//
//   Absent while nothing applies. A sentence in every turn forever is a sentence nobody reads.
//   Dated — the moment this turn began, said once for the whole block. It needs no second age the
//     way the reading beside it does: one account's standing reaches N rows at N ages, while a size
//     belongs to the conversation it is about and is exactly as old as that conversation's last
//     turn, which "at the end of its last turn" already says.
//   It names the speaker, for updateWrapper's reason: an update ships new templates and re-renders
//     nobody's persona, so a session reading this may be running one written before any of it
//     existed and has nothing to look it up in.
//   The lead only.
//   A reading and never a gate. Nothing consults bandIn to deliver, hire, hand over, queue, refuse
//     or end.
//
// TWO THINGS IT DOES THAT THE QUIET BLOCK DOES NOT, both deliberate.
//
// Nobody is left out for being mid-turn. There the reading is a clock that stands still for the
// whole of a turn, so a session working reads as one that has stopped. A size does not go stale
// that way — it is simply behind, and a session in the middle of a turn is at least as large as
// this says. Leaving it out would hide the biggest conversation here at the moment it is biggest.
//
// And the reader is in its own list, in the second person. It is the largest conversation in the
// workspace, it is the one that cannot press its own button, and it is the reader — a block naming
// everybody except the session that most needs handing over would be the worst reading this could
// give.
function sizeWrapper(instance, name) {
  if (name !== instance.config.leader) {
    return null;
  }
  const large = sessions(instance).filter((session) => bandIn(instance.root, session.name) !== null);
  if (large.length === 0) {
    return null;
  }

  // The same words the row and the panel say of the same reading, down to the separators — a person
  // and a session reading one number each should not have to work out that two phrasings are one
  // fact. The number is the row's own, off the list this just filtered: reading the file again here
  // would be a second answer to one question, and a filter that could disagree with its own sentence.
  const each = large.map((session) => {
    // The share beside the size, from the same wording the row says it in. It is the half that
    // means anything on a model nobody here has measured: 178,400 is a number, and 89% of its
    // window is how much room is left to plan in. Said with the size and never instead of it — the
    // block is read by somebody deciding which panel to press, and the size is what they will see
    // on it. It cannot come back nothing here: a session is in this list because it is in a band,
    // and a band needs both readings, so the filter above is what makes this phrase always sayable.
    const held = `${session.context.toLocaleString("en-US")} tokens, ${shareSaid(session.context, session.window)}`;
    return session.name === name
      ? `you were carrying ${held} at the end of yours`
      : `${session.name} was carrying ${held} at the end of its last turn`;
  });
  const when = new Date();
  const read = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;

  return [
    "<size>",
    "The chat is telling you this. Nobody typed it.",
    `${each.join(", and ")}, read as this turn began at ${read}.`,
    "A conversation that big is one where what is left has to be planned rather than simply carried on, and what survives it is what its desk says. Which panel is worth handing over early is still yours to say, your own included — and the chat parks a conversation itself, asking it to write its desk first, when it is about to lose its cache, when it has grown into a strong band of its window, or when the account is nearly spent.",
    ...olderInstructions(instance, name),
    "</size>",
  ].join("\n\n");
}

// Where the account stands, told to the session that leads and to nobody else.
//
// The second reading in this toolkit that is pushed, and it answers to the same list the first one
// does. A worker has one task; what the whole workspace does about a window that is filling up is
// the lead's, and it is the lead whose next act would spend the last of it.
//
// WHY IT IS PUSHED. The turn in which the lead would have asked is the turn that gets refused. That
// is not a worry, it is what happened: on one measured afternoon the very turn that was to take
// the room off was itself turned away, so the moment to act had already gone by the time anybody
// went looking. A reading nobody is handed until they think to want it is no use for a condition
// whose arrival is what stops them thinking.
//
// Every property that earns the exception is here, and each has a check:
//
//   Absent while nothing applies. A sentence in every turn forever is a sentence nobody reads.
//   Dated — the reading's own age AND the moment this turn began, because "read 4m ago" has no
//     anchor on its own, and an undated line is exactly the stale snapshot a carried room is not
//     handed as.
//   It names the speaker, for updateWrapper's reason: an update ships new templates and re-renders
//     nobody's persona, so a session reading this may be running one written before any of it
//     existed and has nothing to look it up in.
//   The lead only.
//   A reading and never a gate. Nothing consults THIS BLOCK to deliver, hire, hand over, queue or
//     refuse — the one gate on the number it carries is gate.mjs, on what the lead starts, and
//     that gate reads the account and never this sentence about it.
//     No sweep, no timer, no new state, nothing to clear.
//
// It stops by being acted on, which is the shape deskWrapper and the one beside it already have:
// the work stops, the account fills no further, and when the window lifts there is nothing to say
// and nothing had to remember having said it.
function usageWrapper(instance, name) {
  if (name !== instance.config.leader) {
    return null;
  }
  const standing = accountStanding(instance);
  if (standing === null) {
    return null;
  }

  const when = new Date();
  const read = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const window = standing.window.replace(/_/g, "-");
  const full = Math.round(standing.fullness * 100);

  const said = [
    "<usage>",
    "The chat is telling you this. Nobody typed it.",
    // WHO WAS TOLD IT, and whether they have finished. A reading taken from a run still going is
    // attributed to the run HAVING it; only a reading from a run that ended is a reading somebody
    // last ran on. The distinction comes down on the reading itself rather than being guessed at
    // here, because by the time this reads it the two kinds are one shape.
    `The ${window} usage window was ${full}% full ${standing.live ? `while ${standing.on} was running` : `when ${standing.on} last ran`}, read ${ago(new Date(standing.at).toISOString())}, as this turn began at ${read}.`,
  ];

  if (!standing.stop) {
    said.push(
      "Plan what is left wisely: finish what is in flight, start no new front and take nobody new on until that window has lifted. What is left of it is only ever less than this says — a reading is a floor, because what a window has been used for does not go back down.",
    );
  } else if (standing.warm === null) {
    // Nothing is known about when it lifts, so nothing is decided here either. The one sentence
    // that is certain is said, and the choice is handed over WITH the thing it turns on — which is
    // worth more than either guess, because both guesses look exactly like an answer.
    said.push("It did not say when it lifts.");
    said.push(
      "Stop the tasks. Whether to pause everybody where they are or hand them all over turns on when it lifts against the hour a conversation here stays carriable, so find that out before choosing.",
    );
  } else if (standing.warm) {
    said.push(`It lifts at ${atTime(standing.resetsAt)}, which is inside the hour a conversation here stays carriable.`);
    said.push(
      "Stop the tasks and pause everybody where they are. Their conversations will still be there when it lifts, so nothing has to be handed over and nothing has to be read back off a desk.",
    );
  } else {
    said.push(
      `It lifts at ${atTime(standing.resetsAt)}, which is further off than the hour a conversation here stays carriable.`,
    );
    said.push(
      "Stop the tasks and park everybody, yourself included: every conversation in this workspace will be past carrying on by then, so hand each one over to its desk while it can still say what it knows, and start fresh on the desks afterwards.",
    );
  }

  // And the other window, when it too is over the line, as a fact with nothing to do about it
  // attached. Said last, after the sentence it qualifies, and never in place of it.
  if (standing.alsoWeek !== null) {
    const week = standing.alsoWeek.name.replace(/_/g, "-");
    const lifts =
      standing.alsoWeek.resetsAt === null
        ? "and it did not say when it lifts"
        : `and it does not lift until ${onDay(standing.alsoWeek.resetsAt)}`;
    said.push(
      `The ${week} usage window was ${Math.round(standing.alsoWeek.fullness * 100)}% full in the same reading, ${lifts}. Nothing here tells you what to do about that; it is said because waiting for the ${window} window would not be enough on its own.`,
    );
  }

  said.push("</usage>");
  return said.join("\n\n");
}

// Everything a session is handed in front of the message this turn is about: what it overheard
// while it was not running, and the standing ask above while its desk says nothing. Blank lines
// between them, because they are separate things said by different people.
//
// What it overheard is handed IN rather than taken from the queue here, because whoever calls this
// is also the one who gets to see how the run went, and the two have to be the same reader: what a
// turn was given is settled against what that turn amounted to.
function inFrontOf(instance, name, message, carried, restarted = false, answering = null) {
  // Ahead of everything, when there was one. A session that does not yet know it has lost its
  // memory would read what it overheard as things it remembers being told.
  const said = restarted ? [pickUpWrapper(name)] : [];
  said.push(...carried);
  // Beside what was overheard, because both are what happened elsewhere while this session was not
  // running, and read HERE — the turn is where every other reading on this path is taken, and a
  // message that waited behind a long turn is answered against what is true now.
  const stopped = quietWrapper(instance, name);
  if (stopped !== null) {
    said.push(stopped);
  }
  // Beside it, about the same conversations and read at the same moment: both are about what one
  // conversation is about to lose, and the one below is about the whole workspace and is the one
  // that says stop, so it reads last.
  const large = sizeWrapper(instance, name);
  if (large !== null) {
    said.push(large);
  }
  // Beside it, for the same reason and read at the same moment: both are things the chat knows and
  // nobody typed, and both are worth nothing if they describe the room as it was before this turn
  // got its place in the queue.
  const standing = usageWrapper(instance, name);
  if (standing !== null) {
    said.push(standing);
  }
  if (deskTitle(instance.root, name) === "") {
    said.push(deskWrapper(name));
  }
  // After the desk, and for once that order is about who answers rather than about what is said.
  // The ask above is answered by the reader itself, in this turn, by writing one line; this one is
  // answered by a person, over as many turns as it takes them, so it reads nearest the message.
  const settling = permissionsWrapper(instance, name);
  if (settling !== null) {
    said.push(settling);
  }
  // Last, nearest the message it is about, and usually not there at all.
  if (answering !== null) {
    said.push(answering);
  }
  return withWhatWasOverheard(said, message);
}

// Which line of its own a session is being answered on, as a position in its panel.
//
// An index into a file that is only ever appended to is the whole of the reference: no id has to be
// minted, no counter has to survive a restart, and no field is added to every row for the benefit
// of the one row that needs it. Nothing before the position can change, so the answer is the same
// whenever it is asked.
//
// A message that says nothing about what was in front of it — a terminal, or a page that has just
// opened — is answering the last thing that was said, which is the honest reading of it.
function whatItAnswers(root, name, shown) {
  const all = read(root, name);
  const upTo = Number.isInteger(shown) ? Math.min(Math.max(shown, 0), all.length) : all.length;
  const at = all.slice(0, upTo).findLastIndex((message) => message.from === name);
  return at === -1 ? null : at;
}

// And what the session is told about it, which is only ever the unobvious case.
//
// Nearly always somebody is answering the last thing a session said, and saying so would be a
// sentence in every turn forever in aid of the rare one. The first line of the row rather than its
// number: a position is what the server holds, and what locates a line for whoever is reading the
// thread is what that line said.
//
// Decided where the turn BEGINS and not where the message arrived: a message that waited behind a
// long turn is being read now, against everything this session has said by now.
function answeringWrapper(root, name, answers) {
  if (answers === null) {
    return null;
  }
  const all = read(root, name);
  if (answers === all.findLastIndex((message) => message.from === name)) {
    return null;
  }
  return `<answering>${(all[answers]?.text ?? "").split("\n")[0]}</answering>`;
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
//
// Who asked is handed in rather than being the instance's person, because there are two doors and
// they are not the same somebody: the page's Leave button, which is the person pressing it, and the
// lead's `retire`. This line is written into the panel that is filed with the desk, so it is the
// record of who ended it — and a desk the lead put away, filed under a sentence naming the person,
// is a record of something that did not happen.
function leavingAsked(asker, name) {
  return `${asker} asked ${name} to leave. ${name} is writing ${desk(name)} before this desk is put away.`;
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

// The same moment when it may not be today. A window measured in days lifts on a date, and an hour
// on its own would read as this afternoon — which is the one misreading that matters here, since
// the whole point of saying it is that waiting is not the answer.
function onDay(seconds) {
  const when = new Date(seconds * 1000);
  return `${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ${atTime(seconds)}`;
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
// written — and until this slice the thread was ended anyway, so a refusal cost the conversation on
// the very turn whose replacement was never written. So nothing is ended, and the line says that,
// because a person who has just pressed a button needs to know whether it cost them anything.
function handoverRefused(name, refused) {
  return `${name} could not be asked to hand over: the service turned the run away on ${limitSaid(refused)}. Nothing was ended — its thread and ${desk(name)} are exactly as they were — so hand over again once the limit has lifted.`;
}

// And on the way out. A desk is filed under a date and a title the session is asked for on this
// very turn, so a leave that was refused has nothing to file: the desk stays open, the name stays
// taken, and nobody has left.
function leavingRefused(name, refused) {
  return `${name} could not be asked before leaving: the service turned the run away on ${limitSaid(refused)}. Nothing was filed and the desk is still open — ask again once the limit has lifted.`;
}

// The same three moments again, for a room that is off rather than for an account that is out.
//
// They are written beside their refusal twins on purpose. A person pressing a button wants the same
// three facts either way — nothing ran, nothing was lost, and what to do about it — and the only
// difference here is the last one: a limit lifts by itself and this does not. It lifts when somebody
// presses the switch, so that is what the sentence says instead of a time.
//
// Said in full rather than as a shared phrase with a word swapped. Two sentences that differ in what
// is at stake should differ in their words: a message costs nothing and can simply be said again, a
// handover was about to end a conversation, and a leave was about to file a desk away.
function offlineLine(name) {
  return `Nothing reached ${name}: the room is offline, so nothing is being run. Its conversation is untouched and nothing was lost — bring the room back online and say it again.`;
}

function handoverOffline(name) {
  return `${name} could not be asked to hand over: the room is offline, so nothing is being run. Nothing was ended — its thread and ${desk(name)} are exactly as they were — so bring the room back online and hand over again.`;
}

function leavingOffline(name) {
  return `${name} could not be asked before leaving: the room is offline, so nothing is being run. Nothing was filed and the desk is still open — bring the room back online and ask again.`;
}

// What a session is told when the gate turned its spawn away — `what` is the thing that was not
// started, said in the caller's own terms. Three facts, the same three as every refusal above:
// nothing ran, nothing was lost, and what to do about it — which is to ask again, and when.
//
// FROM THE FACTS THE GATE HANDS BACK and nothing else, the way `limitSaid` is worded from the
// frame's fields: the window as the service names it, the reading, and the moment it lifts when
// the service gave one. The account not having said when it lifts is a fact too, and a different
// last sentence — a spawn refused on an unknown is asked again after the next completed turn, which
// is when a fresh reading arrives.
//
// The reading may be missing — a hold read back off disk with no number on it — and then the
// sentence says the line and not the number: the hold stands on the account having reached its
// stop line, and that is as much as is known.
function spawnRefused(what, held) {
  const window = held.window.replace(/_/g, "-");
  const read = typeof held.fullness === "number" ? `was ${Math.round(held.fullness * 100)}% full` : "has reached its stop line";
  const opening = `Nothing new is started while the account is nearly spent, so ${what}: the ${window} usage window ${read}`;
  if (held.resetsAt === null) {
    return `${opening} and did not say when it lifts. Nothing ran and nothing was lost — ask again after the next completed turn, which is when a fresh reading arrives.`;
  }
  return `${opening}, and it lifts at ${atTime(held.resetsAt)}. Nothing ran and nothing was lost — ask again once it has.`;
}

// How a run asks to be allowed something, on every turn that runs one.
//
// The request is parked — that is the whole of what happens to it, and `permissions.mjs` stays the
// store it is, holding what was asked until a person answers — and then the desktop is told, because
// a parked request is the second of the two things in this workspace that only a person can end. It
// was measured sitting for six and a half minutes on a panel nobody had open, and nothing on that
// path times out.
//
// One helper rather than the same two lines on each of the three turns that ask — an ordinary
// message, a handover and a leaving all park identically — so a fourth kind of turn cannot be
// written that parks without ringing.
//
// On the park and never on what is parked: this runs once per request, while the page asks what is
// waiting once a second. The sentence is composed here because there is nobody to compose it — a run
// stops without saying why in words, and the tool it stopped on is what the person needs to read.
function asking(instance, name) {
  return (request) => {
    const waiting = park(name, request);
    popped(instance, { on: name, why: `${name} is stopped, waiting to be allowed to use ${request.tool}` });
    return waiting;
  };
}

// Everything a session is asked or answers is under its own name, so one route shape serves
// every panel and there is no path through here that only the lead can take.
const SESSION_ROUTE = /^\/sessions\/([^/]+)\/(messages|message|permissions|permission|handover|leave|end)$/;

// Delivering a message to a session: everything between it arriving and the answer coming back,
// whoever sent it and however it got in.
//
// One function, because there is more than one way in — the page and a terminal post it to the
// route, a session calls it as a tool — and "the tool does exactly what the command does" is worth
// nothing written down. Here it is the same thing because there is only one of it.
//
// `signed` is the name of the session sending it, or null for the human, or THE_CHAT for the room
// watch. It answers { status, body }: what the route sends back, and what the tool reads its own
// answer out of.
//
// THE THIRD SENDER, and it is safe by construction rather than by a check: THE_CHAT has a space in
// it, so no session can ever be called that — a name is a directory under work/ and cannot hold one
// — and the human is null. It does three things and no more. The sender lookup does not refuse it,
// the overheard copy is not made (nobody spoke on anybody's panel), and its line is written
// `from: THE_CHAT` with a `watch: true` flag, the shape `handover: true` and `cold: true` already
// have, so the page and the checks rest on a flag rather than on prose.
//
// Everything else on this path is untouched by it. Once a turn is sent it is an ordinary turn: it
// queues, it waits, it is refused while the room is off, it ends a cold thread and begins a new one
// — every one of those because it comes through here unchanged and not because anything was written
// twice.
//
// THE INVARIANT ON THIS PATH: a message may be delayed, and the conversation that answers it may be
// replaced, but it is never parked on a state the addressee is stuck in. The refusals below are all
// about the MESSAGE — empty text, a signature naming nobody, a circle that would deadlock both
// ends, a session that has left — and not one of them is about how the addressee is doing. The one
// about the ACCOUNT, the gate, says at its own place how it passes this test.
//
// That is deliberate and it is what makes it safe to test a session's own state here at all. A
// message refused because of the state a session is in makes that state unreachable: a session
// nobody can reach cannot be told to stop being that way, and the only thing left is a person
// noticing. So a state test on this path has to answer one question before it is written — what
// happens to the message when the answer is yes? If the answer is "it waits for somebody", it does
// not belong here. Ending a stale conversation and delivering is fine; declining to deliver is not.
async function deliver(instance, name, text, signed, shown = null) {
  if (typeof text !== "string" || text.trim() === "") {
    return { status: 400, body: { error: "a message needs some text" } };
  }

  // The room watch, which is neither a session nor the person. Asked first and by identity against
  // the one constant there is, so nothing below has to work out which of the three this is twice.
  const watching = signed === THE_CHAT;

  // A signature naming nobody who works here is refused rather than passed on as the human's: a
  // message arriving as somebody it is not is the one mistake this whole arrangement exists to
  // prevent.
  const sender =
    signed === null || watching ? null : (sessions(instance).find((session) => session.name === signed) ?? null);
  if (signed !== null && !watching && sender === null) {
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

  // THE GATE, and it is the one refusal on this path that is about neither the message nor the
  // addressee: it is about the account. A colleague's message to a seat with no conversation, or
  // with one that has gone cold, would start a conversation from nothing — a new front, at the
  // moment the account can least afford one — and while the account is nearly spent it is not
  // started. The person's message is never held here: the reading exists for the person, and a
  // message they typed goes through to be refused by the service or not, which is the truth.
  //
  // IT PASSES THE INVARIANT'S TEST, which is why it is allowed on this path at all. What happens to
  // the message when the answer is yes: it is refused NOW, to its sender, with the moment to ask
  // again in the answer — never queued, never parked on a state somebody has to notice. And the
  // state it is refused on clears by itself when the window lifts, or at the person's hand, since
  // the person can always say it themselves. Nothing here waits for anybody.
  //
  // DECIDED HERE, AT ARRIVAL, AND NOT AGAIN INSIDE THE TURN. A message let through is a turn in
  // flight, and a turn in flight is never touched: a conversation that goes cold while it waits its
  // place in the queue is started afresh below, as it always was, and a reading that crosses the
  // line while it waits changes nothing about it. The whole of what the gate refuses is what it can
  // see when the spawn is asked for, and that is the point rather than a gap.
  //
  // NOTHING IS WRITTEN ANYWHERE. The circle refusal above leaves a line on the sender's panel
  // because somebody reading that panel could not otherwise tell why nothing arrived; this leaves
  // none, because the answer says it all and a line about the account on every refused spawn would
  // be the account being said once per call rather than once.
  if (sender !== null && (!hasThread(instance.root, name) || hasGoneCold(instance.root, name))) {
    const held = spawnHeld(instance);
    if (held !== null) {
      return { status: 409, body: { error: spawnRefused(`nothing is said to ${name}, whose conversation would have to be started from nothing`, held) } };
    }
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
  //
  // And not for the watch, which is why this asks for the watch as well as for a sender. Overhearing
  // is the lead being told what the PERSON said on a panel it was not on; the chat speaking is not
  // somebody speaking, and a copy of it on the lead's own panel would be the lead overhearing itself.
  if (sender === null && !watching && name !== instance.config.leader) {
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
      // AND IT STAYS NOW THAT THE TICK ENDS THEM TOO, which is a decision rather than an accident.
      // The pass in `readTheRoom` reaches a cold conversation on its own cadence; this reaches one
      // the moment somebody types, which is sooner whenever a person got there first, and it is the
      // whole of the cold handling in a chat whose timer has been taken out. The two cannot fight:
      // ending one is removing `session.json`, after which `hasThread` fails and `hasGoneCold`
      // answers false, so whichever of them arrives second finds nothing left to do.
      const restarted = hasGoneCold(instance.root, name);
      if (restarted) {
        forget(instance.root, name);
        append(instance.root, name, { from: THE_CHAT, text: coldLine(name), cold: true });
      }

      // Which line of this session's the sender was looking at. Worked out from the position that
      // came WITH the message, so what it names cannot be moved by anything this session said while
      // the message waited its place in the queue.
      const answers = whatItAnswers(instance.root, name, shown);

      const asked = append(instance.root, name, {
        from: watching ? THE_CHAT : (sender?.name ?? "human"),
        // Flagged, so that a page and a check read a field rather than the prose. A turn the chat
        // started must not be readable as the person having typed one: the whole worth of a signed
        // message here is that a session can tell what it is being asked BY, and a line the room
        // watch wrote is neither the person nor a colleague.
        ...(watching ? { watch: true } : {}),
        text: text.trim(),
        ...(answers === null ? {} : { answers }),
      });

      // What this session is owed, read where the turn begins and cleared where it ends. Read
      // here for the reason everything else on this path is: a line that arrived while this turn
      // waited its place in the queue belongs to this turn.
      const carried = owed(name);

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
            carried,
            restarted,
            answeringWrapper(instance.root, name, answers),
          ),
          asking(instance, name),
        );
      } finally {
        // Whatever it was still asking about, it is not there to hear the answer now.
        giveUp(name);
      }

      settleWhatWasOverheard(name, carried, answer);

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

  // The room is off, so no turn was taken and nothing was run. The question is not written down —
  // it was never asked of anybody — and what goes on the panel is the chat saying so in its own
  // voice, flagged, so that a check reads the flag rather than the prose.
  //
  // What was overheard above is left where it is. That line is the record of the human having spoken
  // on a panel, which is true whether or not anything was delivered, and it reaches the lead on
  // whatever turn the lead next takes — which, while the room is off, is none.
  if (answered === OFFLINE) {
    const said = append(instance.root, name, {
      from: THE_CHAT,
      text: offlineLine(name),
      offline: true,
    });
    return { status: 503, body: { error: said.text, offline: true } };
  }

  if (answered.gone === true) {
    return { status: 409, body: { error: `${name} left before this could be delivered` } };
  }

  // Turned away, and said as its own outcome rather than as a 200 carrying a reply that is not one.
  // 503 because that is what happened: the service this run needed was not available, it is not
  // this message's fault and it is not the addressee's, and the same message sent again later is
  // the whole of the repair.
  //
  // This is NOT the state gate the invariant above rules out. The limit IS remembered now — it is
  // on the session's row until the moment it named has passed — and what makes that a fact rather
  // than a gate is that nothing consults it. Not here, not on the way in, not in the queue. The
  // next message is attempted exactly like this one, which is why the message queued behind this
  // one is run rather than held.
  //
  // Held true by a check and not by this paragraph: a message to a session whose row says refused
  // is still attempted, and the check reads the stand-in's own call log rather than the status,
  // because a gate would answer this very 503 without running anything at all.
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
  let shown;
  try {
    ({ text, from, shown } = JSON.parse(await readBody(request)));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  // The page signs nothing, so an unsigned message is the person at the page or the person at a
  // terminal — either way, the human.
  const signed = typeof from === "string" && from.trim() !== "" ? from.trim() : null;

  const { status, body } = await deliver(instance, name, text, signed, Number.isInteger(shown) ? shown : null);
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
const TOOLKIT = "openovai";

// What a session may do here without composing a shell line.
//
// The standing limit: nothing that deletes, archives or spawns joins this list without being
// designed in. The reason is the permission rule rather than the tools — a rule can name a server
// but not an argument, so every tool here is granted the moment it appears, and adding a
// destructive one is a change to what a session is allowed and not only to what it can reach.
//
// It has been spent twice, both times on who is here. `hire` writes a desk and does none of the
// three things the limit names. `retire` does one of them, and is here because of the order it
// does it in: the desk and the whole conversation are filed away together before anything is taken
// down, so what is lost is a record nothing here reads back rather than a record. Both are the
// lead's alone, and both stayed inside the limit rather than lifting it.
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
    {
      name: "interrupt",
      description:
        `Break in on ${instance.config.human} while they are writing. It is the one line you have to them without being asked, and there is no ordinary version of it: everything else you say reaches them when they next read the panel, and while there is anything in their box it waits. This does not wait. It ends the waiting, so what was held arrives with it and your line arrives last, with the reason beside it — which is why it is for the two things worth breaking off a half-written sentence for: what makes that sentence pointless, and what somebody must act on now. Anything that can wait goes in your next answer instead. It says it and returns at once: no turn is started, nothing is waited for, and whatever they say back arrives on this panel later as an ordinary message.`,
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: `What to say to ${instance.config.human}. It arrives exactly as written.` },
          why: {
            type: "string",
            description:
              "What makes it worth interrupting for. It is shown to them beside the line rather than read out of the words, so write it for them: what it is that they are in the middle of that this changes.",
          },
        },
        required: ["message", "why"],
        additionalProperties: false,
      },
      // The same split `room` uses, and for the same two reasons: a tool left off the list is not
      // reached for, and a session that heard of it elsewhere is told whose it is rather than that
      // it does not exist.
      offered: lead,
      run: (args) =>
        lead
          ? brokeIn(instance, caller, args)
          : { refused: `breaking in on ${instance.config.human} is the lead's, so ask ${instance.config.leader}` },
    },

    {
      name: "hire",
      description:
        "Open a desk for somebody new, so there is one more person here to give work to. It writes their desk, the instructions saying who they are, and the one file they are allowed to write. Nothing is started: a desk is what makes somebody a person here, so they are in the room from now on and they run for the first time when you say something to them. The name is yours to choose and it is theirs — it is what say addresses and what the room calls them. It refuses a name somebody here already has, and a name whose conversation from last time is still sitting here, which is a person's to move out of the way rather than yours. A model can be named beside it when this one should not run on what everybody here runs on; leaving it out is the usual answer, and it is the one that keeps moving with the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "What to call them. A letter, then letters, digits, hyphens or underscores.",
          },
          model: {
            type: "string",
            description:
              "What to run them on, when it should not be what this workspace runs its workers on. Left out, they run on that, and go on doing so if it is ever changed.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      // The same split `room` and `interrupt` use, and for the same two reasons: a tool left off
      // the list is not reached for, and a session that heard of it elsewhere is told whose it is
      // rather than that it does not exist.
      offered: lead,
      run: (args) =>
        lead
          ? hiredByTool(instance, caller, args)
          : { refused: `opening a desk is the lead's, so ask ${instance.config.leader}` },
    },

    {
      name: "retire",
      description:
        "Put a desk away when the work on it is done. They are asked to write their desk one last time, and then that desk and the whole of their conversation are filed together under a dated directory of their own, the instructions saying who they were are taken down, and the name is free for somebody else. It holds you for the whole of that last turn, the way saying something to them does. It files rather than throws away — but nothing here reads a filed desk back afterwards, so undoing this means somebody going and looking at the files. It refuses your own desk, because a workspace has a lead by definition and this page is hosted by it, and it refuses a name nobody here has.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Whose desk to put away." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      offered: lead,
      run: (args) =>
        lead
          ? retiredByTool(instance, caller, args)
          : { refused: `putting a desk away is the lead's, so ask ${instance.config.leader}` },
    },

    // And after them, the tools this instance serves itself. After rather than among: a plugin
    // takes the name of its file, and the ones above take the names they were written with, so a
    // file called say.mjs finds the name already taken rather than quietly answering for it.
    //
    // The context is built here, per call, because most of it is about who is calling and that is
    // not known until somebody does. It carries what a tool of this kind has to have: who called,
    // whether they lead, the root — the one thing a plugin cannot work out for itself, since an
    // instance holds no absolute path anywhere — and the instance's own description of itself,
    // which is where the names in a sentence to a person come from.
    ...(instance.plugins ?? []).map((plugin) => ({
      name: plugin.name,
      description: plugin.description,
      inputSchema: plugin.inputSchema,
      // Awaited here rather than handed straight on, so that a plugin that answers with nothing is
      // told so in words instead of arriving as a tool call that came back empty. A throw is not
      // caught: that is answered one layer up, in the same words every other tool's is.
      run: async (args) =>
        answerFrom(plugin.name, await plugin.run(args, { caller, leads: lead, root: instance.root, config: instance.config })),
    })),
  ];
}

// The lead's one unprompted line to the human, and the exception every hold on this server is
// built around.
//
// It appends to the caller's OWN panel — which is the panel the human reads — and returns. Nothing
// is delivered anywhere: the human is not a session, has no desk and no turn, so there is nobody to
// be held waiting and no circle that could close. That is also what keeps this inside the standing
// limit on the tools: it appends, and does nothing else.
//
// Both halves are required and both are read trimmed, so there is no way to break in without
// saying what it makes stale — and what it makes stale is the first thing the person being
// interrupted is shown.
function brokeIn(instance, caller, args) {
  const message = typeof args?.message === "string" ? args.message : "";
  if (message.trim() === "") {
    return { refused: "breaking in needs something to say" };
  }

  const why = typeof args?.why === "string" ? args.why : "";
  if (why.trim() === "") {
    return {
      refused: `breaking in needs a reason: what it is that makes this worth ${instance.config.human} breaking off mid-sentence for, in the words they will read`,
    };
  }

  append(instance.root, caller, { from: caller, text: message, breaking: why.trim() });

  // And the desktop, if this instance has one and this is not the middle of somebody's night. The
  // line above reaches whoever is reading the page; this is the half of breaking in that reaches
  // somebody who is not. It is not awaited — the sentence below promises this returns at once.
  popped(instance, { on: caller, why: why.trim() });

  // In the tool's own words rather than as an empty result: what comes back here is read by a
  // model, and one handed nothing waits for something, or says the same thing again. There is
  // nothing to wait for.
  return {
    text: `Broke in on ${instance.config.human}. They have it now, and nothing comes back here — whatever they say arrives on this panel as an ordinary message.`,
  };
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

// What the terminal is told when the watch is armed: how often the room is read, and — where the
// workspace declined the turn — that nothing is spent on it. The one thing somebody starting a
// chat needs to know about the watch is that there is one, and this is the only place that fact
// is asserted rather than inferred from the absence of an effect.
// The record as a reader wants it: moments as moments, not as milliseconds since 1970.
function watchSaid(record) {
  if (record === null) {
    return null;
  }
  return {
    ...record,
    armedAt: new Date(record.armedAt).toISOString(),
    at: record.at === null ? null : new Date(record.at).toISOString(),
  };
}

function watchArmedLine(config, every) {
  const cadence = `The room is read every ${every / 1000} seconds`;
  if (!buysATurn(config)) {
    return `${cadence}, and nothing is spent on it: this workspace wrote ${WATCH_EVERY}: 0, so nobody is handed over by the chat. Whether it is being read shows on /health as watch.`;
  }
  return `${cadence}. Whether it is being read shows on /health as watch.`;
}

// The room, in the same lines the command prints — the same rows off the same list, laid out by
// the same function, so that the lead reading it here and the person reading it in a terminal are
// never told two different things.
function theRoom(instance) {
  const rows = sessions(instance).map((session) => everySession(instance, session));

  // Off is said here too, and from the same call the command makes. The lead asking what the room
  // is doing is the reader most likely to be told nothing back — it is the session whose next
  // message will be turned away — so a tool that left this out would be the one place the silence
  // had no explanation.
  return { text: roomLines(rows, offline(), holdSaid(holdIn(instance.root))).join("\n") };
}

// Who works here, which is the half of `ovai status` a session can act on: the names it can say
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

// Opening a desk for somebody new, asked for by the session that leads rather than pressed on the
// page.
//
// It calls what the command and the route call, so what a name is refused for still has one answer
// and it is `desks.mjs`'s. What is added here is only the shape of it: a sentence, because what
// reads this is a model, where the route answers a status the page renders.
//
// The panel directory is worked out before `hire` is asked, and `path.join` takes nothing but a
// string — so a name of the wrong type would break here rather than be refused. Handing an empty
// one over instead keeps the refusal where every other one is: `hire` looks at the name first and
// never reaches the panel.
function hiredByTool(instance, caller, args) {
  const name = args?.name;
  const panel = isName(name) ? panelDirectory(instance.root, name) : "";

  // An absent model is `null` rather than `undefined`, which is what `hire` reads as "the usual
  // one". Nothing is validated here: what a model identifier is has one answer and it is
  // `desks.mjs`'s, so a model that is not one is refused in the sentence the command prints.
  const model = args?.model ?? null;

  // The gate, before the name is so much as looked at: whether anything new may be started is a
  // question about the account and not about the desk, and it is the same answer whatever the
  // desk would have been called. Nothing is written and nothing is said anywhere but here.
  const held = spawnHeld(instance);
  if (held !== null) {
    return { refused: spawnRefused("no desk is opened", held) };
  }

  try {
    hire(instance.root, name, panel, instance.config, model);
  } catch (error) {
    if (error instanceof DeskError) {
      return { refused: error.message };
    }
    throw error;
  }

  // And a line on the panel a person reads, because the room is not what it was a moment ago and
  // nothing else here would say so. After the work rather than before it: a panel saying a desk was
  // opened for a name that was refused is worse than a panel saying nothing at all.
  //
  // On the CALLER's panel, which is the lead's, which is the one being read. The new desk has a
  // panel of its own and this line is not for it — nobody has been started, and the first thing on
  // that panel should be the first thing somebody says to them.
  //
  // The model is on the line only when one was chosen. A line that named one every time would
  // report a decision that was not taken — and the room row already says what everybody is on.
  const onto = model === null ? "" : `, on ${model}`;
  append(instance.root, caller, { from: THE_CHAT, text: `${caller} opened a desk for ${name}${onto}.` });

  // What is NOT said is the point of the sentence. A caller told only that a desk was opened goes
  // looking for the session it opened, and there is none: the chat reads who works here from
  // `work/` every time it is asked, so the desk IS the hire and the first run is the first thing
  // said to them.
  return {
    text: `${name} works here now, with a desk of their own and nothing on it. Nobody has been started — they run for the first time when you say something to them.`,
  };
}

// Putting a desk away, asked for by the session that leads rather than pressed on the page.
//
// It composes nothing. Every one of the four things this can end as already has a sentence, written
// for the panel a person reads — and the same sentence is what the caller is told, because it says
// the same thing to both of them. Reading it back off the line that was written is what keeps it
// one sentence rather than two that agree today.
//
// Which of them is a refusal and which is an answer is the only judgement here: a desk that was
// filed is an answer even when the session could not be asked first, and a desk still open because
// the account is out or the room is off is a refusal, because nothing was done and asking again is
// the whole of what to do about it.
async function retiredByTool(instance, caller, args) {
  // Asked for by the lead, and said as such on the panel that is filed with the desk. This tool is
  // offered to nobody else and `putAway` refuses anybody else who posts for it anyway, so the lead
  // is who asked whenever this line is reached — and the person pressed nothing.
  const done = await putAway(instance, args?.name, instance.config.leader);

  if (done.turnedAway !== undefined) {
    return { refused: done.turnedAway };
  }
  if (done.offline === true || done.refused === true) {
    return { refused: done.left.text };
  }

  // The line the leaving panel was given, said again on the panel that is still here to read it.
  // Read back rather than composed, like the answer below it, and only on this branch: the three
  // above left the desk exactly where it was, and a line saying where it was filed would be saying
  // something that did not happen.
  //
  // It is worth saying twice precisely because the panel it was first written on is filed away with
  // the desk a moment later — so without this, the one panel a person goes on reading never learns
  // that somebody left.
  append(instance.root, caller, { from: THE_CHAT, text: done.left.text });

  return { text: done.left.text };
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
//
// The line it opens with is handed in rather than written here, because the panel says who asked
// and not every caller is a person. The words the button writes name whoever pressed it, and a turn
// that wrote them itself would put a sentence on somebody's panel about somebody who did nothing.
// AND WHETHER IT IS STILL WANTED IS ASKED INSIDE THE TURN, by whoever asked for it.
//
// A caller that decided this was worth doing decided it BEFORE the turn began, and the turn may run
// a long time afterwards: `inTurn` chains onto the session's own queue, so a park that was decided
// on an idle seat can run behind a message that arrived a moment later and everything that was
// already stacked up behind it. The condition that made this worth doing may not hold by then.
//
// ASKED AS THE FIRST STATEMENT AND NOT ONE LATER, which is the whole of why it lives here rather
// than in the caller. The callback opens by writing "was asked to hand over" on a panel; a caller
// that re-read its own condition and then called this would already have said so before finding
// out, and a person watching would see a park announced and no park — worse than the race it was
// added to prevent. `deliver` makes both of its checks in the same place, before anything is
// written.
//
// The press passes nothing, because a person pressing a button IS the condition and there is
// nothing to re-read.
export async function handOver(instance, name, askedLine, stillHolds = null) {
  return inTurn(name, async () => {
    if (stillHolds !== null && !stillHolds()) {
      return { abandoned: true };
    }

    const asked = append(instance.root, name, {
      from: THE_CHAT,
      text: askedLine,
      handover: true,
    });

    // Carried here as on any turn, so the thread hears what it was owed before it goes and the
    // session that follows it starts owed nothing — and, as on any turn, only settled below once
    // this run has answered. A handover that was turned away goes nowhere, and a thread that is
    // still there is still owed what it never heard.
    const carried = owed(name);

    let answer;
    try {
      answer = await ask(
        instance,
        name,
        withWhatWasOverheard(carried, handoverWrapper(name)),
        asking(instance, name),
      );
    } finally {
      giveUp(name);
    }

    settleWhatWasOverheard(name, carried, answer);

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
}

// The press, which is the caller that IS a person: it says so in the line the turn opens with, and
// it is the one that owes somebody an answer. What came back is written to that answer here rather
// than inside the turn, which is the split `deliver` is written in and for the same reason — a turn
// is one thing, and what an HTTP request is told about it is another.
async function postHandover(instance, name, response) {
  const done = await handOver(instance, name, handoverAsked(instance.config.human, name));

  // Nothing was asked, so there is no question on the panel either — only the line saying why. The
  // thread is where it was, the desk is where it was, and pressing this again once the room is back
  // costs exactly what it would have cost now.
  if (done === OFFLINE) {
    const ended = append(instance.root, name, {
      from: THE_CHAT,
      text: handoverOffline(name),
      handover: true,
      offline: true,
    });
    sendJson(response, 503, { ended, offline: true });
    return;
  }

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
// Ending the run a session is on.
//
// The one thing on the page that is NOT a turn, and the comment is here because every other route
// on this path is one. A message, a handover and a leave all go through the queue, which is right
// for all three: they are things to be answered, and answering them in order is the point. This is
// not a thing to be answered. It is the way out of a session whose queue is not moving, and a way
// out that waits in that queue is not one.
//
// It appends nothing. The run it ends closes with nothing to show for itself, and the turn that
// was waiting on it writes that up the way it writes up any turn that failed — so the panel
// carries one line about this, written where every other line is written, rather than two lines
// racing each other from opposite ends.
async function postEnd(instance, name, response) {
  if (!(await endRun(name))) {
    sendJson(response, 409, { error: `${name} is not running anything to end` });
    return;
  }

  sendJson(response, 200, { ended: name });
}

// Putting a desk away: the session writes it one last time, and then the desk and the whole of
// the conversation are filed together and everything that made this a person here is taken down.
//
// One implementation for both doors, the way `deliver` is one for a message. The page's Leave
// button and the tool the lead is offered reach exactly this, so the guards, the order inside the
// turn and every sentence written on the way are the same however it was asked for — and neither
// door has an opinion about the wording. What comes back is what HAPPENED; saying it as a status
// or as a sentence is the caller's half.
//
// Who asked is the caller's half too, and passed in for the same reason: one door is the person and
// the other is the lead, and the line written on the way in names them.
async function putAway(instance, name, asker) {
  // The lead is not a desk that can be put away. An instance has one by definition and the chat
  // hosts it whether or not it has a desk, so a lead that left would still be here, with nowhere to
  // read what it was doing and nothing to write it to.
  //
  // Before `inTurn` and not merely present. A session inside its own turn asking for its own desk
  // would wait here for a turn that cannot finish until this returns, and the lead calling this
  // tool IS inside its own turn — so a guard further down would not refuse it, it would hang it.
  if (name === instance.config.leader) {
    return { turnedAway: `${name} leads here, so this desk stays` };
  }

  // A name nobody here has. The routes get this from the dispatcher, which answers 404 before it
  // reaches any of them; the tool route does not go past that, and `archiveFor` does not only work
  // out where a desk would go, it MAKES the directory — so without this a name that never worked
  // here leaves an archive behind. Said in the words every other unknown name is said in.
  if (!sessions(instance).some((session) => session.name === name)) {
    return { turnedAway: `nobody called ${name} works here` };
  }

  const done = await inTurn(name, async () => {
    const asked = append(instance.root, name, {
      from: THE_CHAT,
      text: leavingAsked(asker, name),
      leaving: true,
    });

    // Carried here as on any turn, so a thread hears what it was owed before it goes, and settled
    // below only once this run has answered: a leave that was turned away leaves the session at
    // its desk, still owed what it never heard.
    const carried = owed(name);

    let answer;
    try {
      answer = await ask(
        instance,
        name,
        withWhatWasOverheard(carried, leaveWrapper(name)),
        asking(instance, name),
      );
    } finally {
      giveUp(name);
    }

    settleWhatWasOverheard(name, carried, answer);

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

  // And on the way out, where the order inside the turn already says why nothing may run early:
  // `archiveFor` MAKES the directory it names. Nothing here reaches it, so there is no empty archive
  // left behind for somebody who is still at their desk.
  if (done === OFFLINE) {
    return {
      offline: true,
      left: append(instance.root, name, {
        from: THE_CHAT,
        text: leavingOffline(name),
        leaving: true,
        offline: true,
      }),
    };
  }

  return done;
}

// The page's Leave button, which is what a person presses.
async function postLeave(instance, name, response) {
  const done = await putAway(instance, name, instance.config.human);

  if (done.turnedAway !== undefined) {
    sendJson(response, 400, { error: done.turnedAway });
    return;
  }

  if (done.offline === true) {
    sendJson(response, 503, { left: done.left, offline: true });
    return;
  }

  sendJson(response, done.refused === true ? 503 : 200, done);
}

// Opening a desk for somebody new, which is what the page's Hire button posts to.
//
// It writes what `ovai hire` writes by calling the same function, so what a name is refused for has
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

  // The one refusal that is not about the name itself but about there being none. `ovai hire` says
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
async function postPermission(instance, name, request, response) {
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

  // The third answer, and the only one that outlives the call it was given about. The rule is
  // composed here from the request as it was parked, never from anything the caller sent: the page
  // is a caller like any other, and a rule granted from a posted string is a rule nobody read.
  let granted;
  if (decision === "always") {
    const asked = askedFor(name, id);
    if (asked === undefined) {
      sendJson(response, 409, { error: "nothing is waiting on that any more" });
      return;
    }

    granted = shapeOf(asked, instance.root);
    if (granted === null) {
      sendJson(response, 400, { error: "there is no rule that would allow that call" });
      return;
    }

    // Written before the call is let through, because the two are one decision and the file is
    // what says so afterwards. A run allowed by a grant that never landed would go on to be
    // stopped by the same question next turn, and nothing would say why.
    allowAsked(instance.root, {
      rule: granted,
      session: name,
      // Whichever of the two a request names, because a line saying the rule was granted for "a
      // call it did not describe" accounts for nothing: the question a person asks a month later
      // is what was being done at the time, and for a write that is the path.
      //
      // In the instance's own terms, as the rule beside it on the line is. An absolute path here
      // is mostly this machine's name for the root — the part anybody wanted is at the end of it,
      // and the end is what a line kept to a readable length cuts off.
      call: asked.input?.command ?? inside(asked.input?.file_path, instance.root),
      day: new Date().toISOString().slice(0, 10),
    });
  }

  const said =
    decision === "deny"
      ? refuse(typeof why === "string" && why.trim() !== "" ? why.trim() : "not allowed from the chat")
      : allow();

  if (!settle(name, id, said)) {
    sendJson(response, 409, { error: "nothing is waiting on that any more" });
    return;
  }

  sendJson(response, 200, { answered: id, decision, ...(granted === undefined ? {} : { granted }) });
}

// What a panel answers, and the one place where a page somebody is writing on is answered
// differently from any other reader.
//
// Two facts arrive with the request, each held by the only party that can know it: the page knows
// there is text in its box and how many rows it has already drawn, and the server knows what there
// is. Nothing is remembered between requests — no lease, no expiry, no second clock, nothing to
// reset — so a page closed mid-sentence stops holding by not asking again, and a reader that sends
// neither field is answered exactly as it always was.
//
// The cut is here, on the way OUT, and never on the way in. A hold on the delivery path would make
// one person half-way through a sentence the state another session is stuck behind, which is the
// failure that path exists to forbid.
function whatToShow(instance, name, query) {
  const all = read(instance.root, name);

  // A reader that says nothing about what it has drawn has drawn everything, as far as this is
  // concerned: it is asking for the first time, or it is not a page at all, and neither should be
  // told that rows are being kept from it.
  //
  // Only the floor is applied. A number past the end needs no ceiling — slicing past the end of a
  // list is the whole list — and a check watching the ceiling removed reported nothing, which is
  // what a line that cannot be wrong looks like. Below zero is different: it would silently cut
  // rows off the END of the panel and call them held.
  const asked = Number.parseInt(query.get("shown") ?? "", 10);
  const shown = Math.max(Number.isInteger(asked) ? asked : all.length, 0);

  // And the one thing that is never held: a line that breaks in ENDS the wait rather than jumping
  // it. Everything behind is sent, in the order the panel has, with the breaking line last — so
  // there is one render path, nothing is reordered, and the reader is never shown a line that
  // refers to rows they have not been given.
  const breaks = all.slice(shown).some((message) => typeof message.breaking === "string");

  const messages = query.get("writing") === "1" && !breaks ? all.slice(0, shown) : all;
  const holding = all.slice(messages.length);

  return {
    messages,
    held: holding.length,
    // Who is calling, and never what they said. A count on its own cannot be judged, so it would
    // be looked at every time; the words themselves are the interruption this exists to prevent,
    // and a fragment read sideways is worse than either waiting or looking.
    from: [...new Set(holding.map((message) => message.from))],
  };
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
// The reading its last run was handed, with how old it is, or nothing.
//
// The age is not stored anywhere and deliberately so: the file holding the reading is rewritten on
// every answered run, so the file's own moment IS the moment the reading was taken. Storing it
// beside the number would be keeping two records of one fact, and the day they disagreed the row
// would be confidently wrong about how old its number was.
//
// `ranAt` and not `lastAt`: a panel is appended to outside any run, so its moment walks forward
// while the conversation sits untouched. The question here is when this session was last TOLD
// something, which only the thread's own clock answers.
// When this session last ran, as the row says it: the thread's own clock, or nothing at all.
//
// Beside `active` and never folded into it. The two answer different questions — when the panel
// last moved, and when the session last thought — and the day they agree is not the day anybody
// needed either of them.
function ranOn(root, name) {
  const ran = ranAt(root, name);
  return ran === null ? null : new Date(ran).toISOString();
}

function quotaOn(root, name) {
  const windows = quotaIn(root, name);
  return windows === null ? null : { at: ranAt(root, name), windows };
}

// Where the account stands as the run this session has going right now has been told it, or
// nothing at all when it has none going.
//
// FROM MEMORY AND NOT FROM THE ROOT, which is the whole of why it is a second reader rather than a
// second argument to the one above: a reading whose process is gone is not a stale reading, it is
// not a reading, and nothing on disk could say which of those it was holding.
//
// Found by name out of a list, because what is published is what anybody is being told right now
// and the row is the only reader that narrows it to one session. Its own name is dropped on the
// way past: the row it lands on already carries that, and a name said twice is a name two readers
// can come to disagree about.
function standingNow(name) {
  const said = standingsUnderway().find((one) => one.name === name);
  if (said === undefined) {
    return null;
  }
  return { at: said.at, windows: said.windows, ranModel: said.ranModel, since: said.since };
}

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
    asking: parked(session.name, instance.root).length,
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
    // And when this session last RAN, which is the other half of that and is not the same
    // question. A panel is appended to outside any run — an overheard line, a notice from the
    // chat — so `active` walks forward on a session that has not thought since, and on the lead
    // it does so routinely. This is the clock the cold rule already acts on, so how long a
    // session has been doing nothing and whether its conversation is about to be ended cannot
    // disagree: they are the same reading, said at two distances.
    //
    // Two ages on one row was once refused as a distinction nobody had a use for. The use is now
    // named — a session that has stopped is one somebody should check on, and the whole worth of
    // knowing is in the stretch BEFORE the hour is up — and the row already carries this clock
    // once, as the age of a usage reading that is only there when the service sent one.
    //
    // An ISO string, like `active`, rather than the raw moment: both readers already turn one of
    // those into "34m ago" and neither has to learn a second shape. Nothing, rather than a guess,
    // when there is no conversation to have run — which is `ranAt`'s own rule.
    ran: ranOn(instance.root, session.name),
    // How full the account's usage windows were the last time this session was told, and when it
    // was told. A fact on the row and never a gate: nothing in this toolkit reads it to decide
    // anything, and a check about a message to a refused session holds that true rather than this
    // comment. One account means N rows carrying N readings of different ages, each honestly
    // describing its own session's last run, which is why the age is served beside the number and
    // never separated from it.
    quota: quotaOn(instance.root, session.name),
    // And where it stands NOW, if this session has a run going — which is a different question and
    // not a fresher answer to that one. `quota` is what a finished run reported; a window can fill
    // from one side of a line to the other inside a single long turn, and until this the only thing
    // that knew was a variable inside a promise. On the run that matters most it was worse than
    // that: a run turned away with no result frame has its reading read correctly and then dropped,
    // so the overshoot was not invisible until the run ended, it was invisible for ever.
    //
    // Beside `quota` and never instead of it, which is this row's own habit and is argued three
    // times above already — `active` beside `ran`, `cold` beside `active`, `queued` beside `busy`.
    // The day the two agree is not the day anybody needed either of them.
    //
    // The same shape as the stored reading in its `at` and `windows`, deliberately, so that a
    // reader of either does not have to know which it has; the two fields it carries beyond that
    // are the ones only a run in flight can answer. Which MODEL, because the same number means very
    // different things depending on what is spending it. And WHEN IT BEGAN, because a run three
    // minutes in and a run forty minutes in are different decisions at the same reading.
    //
    // A fact on the row and never a gate: nothing here reads it to decide anything. The one act a
    // full account and a long run together argue for — ending a run that is spending the window —
    // is a button the page already has, and a person presses it.
    standing: standingNow(session.name),
    // And whether the account is still turned away, with the moment it lifts. Feature 9 says this
    // on the panel, once, at the moment it happens; it is gone the next time anybody looks, which
    // is how a workspace could sit refused with a room full of rows saying idle. Here it lasts as
    // long as the condition does and no longer.
    //
    // Beside the state phrase rather than inside it: what a session is doing and whether its
    // account is available are different questions, and a session answering right now while its
    // last run was turned away is a real state that one word could not say.
    refused: refusedIn(instance.root, session.name),
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
      // And whether the room is being read, as the record the watch keeps of itself: the cadence
      // it was armed with, when, and when a pass last finished. A timestamp and not a health
      // indicator — "older than about two cadences" is a judgment, and it is the reader's. Read
      // off the live record and not re-derived from the config, so that it cannot say a watch is
      // there when none was armed.
      watch: watchSaid(theWatchRecord()),
    });
    return;
  }

  // Nothing on the page reads this and nothing in the chat decides anything by it. It is here so
  // that what the chat is still holding can be asked for at all — by a person looking at a session
  // that has stopped answering, and by the checks that make sure every kind of hold has a way out.
  if (request.method === "GET" && url.pathname === "/unfinished") {
    sendJson(response, 200, { unfinished: unfinished() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    sendJson(response, 200, {
      // Beside the rows and never on them. Whether the room will start anything is one fact about
      // the room, and a copy of it on every row is N places to disagree — the same reason the
      // fullness of a window is said per row, where it genuinely is one reading per session, and
      // this is not.
      offline: offline(),
      // And whether the account is stopping, for the same reason and in the same place: the facts
      // the hold was decided on, worded by whoever lays the room out, so that the page and the
      // terminal say it in their own copy of one sentence the way they already do for `offline`.
      hold: holdSaid(holdIn(instance.root)),
      sessions: sessions(instance).map((session) => everySession(instance, session)),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/sessions") {
    await postSessions(instance, request, response);
    return;
  }

  // Taking the room off, and bringing it back.
  //
  // Two verbs rather than one carrying a value, because they are not symmetrical in what they mean
  // even though they are in what they do: one of them is the exit, and an exit spelled as an
  // argument to the thing it is the exit from is an exit somebody can forget to offer.
  //
  // Neither runs anything, neither asks anybody, and neither has a branch that could refuse. That
  // is what "taken in every state" means here — not a condition written wide enough to admit them
  // all, but no condition at all. A press that cannot be turned away cannot leave the room half
  // off, which is the failure this whole feature was paid for.
  //
  // Instance-level, so not on the session routes: it is the room that is off, not a person.
  if (request.method === "POST" && url.pathname === "/offline") {
    goOffline();
    sendJson(response, 200, { offline: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/online") {
    goOnline();
    sendJson(response, 200, { offline: false });
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
      sendJson(response, 200, whatToShow(instance, name, url.searchParams));
      return;
    }

    if (request.method === "POST" && what === "message") {
      await postMessage(instance, name, request, response);
      return;
    }

    if (request.method === "GET" && what === "permissions") {
      sendJson(response, 200, { permissions: parked(name, instance.root) });
      return;
    }

    if (request.method === "POST" && what === "permission") {
      await postPermission(instance, name, request, response);
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

    if (request.method === "POST" && what === "end") {
      await postEnd(instance, name, response);
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

// What the lead is told a pass did, and it is BOTH HALVES OR NEITHER.
//
// One function rather than two calls at each site, because either half alone is the bug and the
// half that goes missing is always the same one. The panel is what a PERSON reads; it is not what
// the lead's model hears, and nothing writes into that thread except a run. Append alone leaves a
// record nobody acts on — the lead goes on addressing a session that has been acted on, which is
// the failure this whole feature exists to prevent. Overhear alone leaves a debt that dies with
// the process and a panel with no record it ever happened.
//
// Free, both of them: a file append and a map write. That is the whole reason the pass is allowed
// to say anything at all.
//
// FLAGGED, not read off the prose. `watch: true` is the shape `handover: true`, `cold: true` and
// `overheard: true` already have, so a page and a check rest on a field.
function announce(instance, said, at) {
  append(instance.root, instance.config.leader, { from: THE_CHAT, text: said, watch: true });
  overhear(instance.config.leader, watchedWrapper(said, at));
}

// The same thing said to the lead's model rather than to the person reading its panel.
//
// A wrapper, for the reason `wrap` and `overheardWrapper` are ones: the server is the only thing
// that writes one, so what is left OUTSIDE every wrapper is the human speaking on this session's
// own panel, still by construction.
//
// IT SAYS WHO IS SPEAKING IN WORDS AS WELL AS IN THE TAG. A session reading this may be running a
// persona written before any of this existed and has nothing to look the tag up in, and an
// unattributed instruction in front of a message reads as one the person typed.
//
// AND IT CARRIES THE MOMENT THE ROOM WAS READ, which matters more here than it did when this
// bought its own turn. It is handed to the lead in front of whatever the lead is asked next, so it
// may have been waiting since long before that question — an undated line handed to somebody
// unasked reads as now, and this one frequently is not.
function watchedWrapper(said, at) {
  return [
    `<watch read="${at}">`,
    "The chat is telling you this. Nobody typed it, and no turn was bought to say it: it waited here until you were asked something else.",
    said,
    "</watch>",
  ].join("\n\n");
}

// What the lead is told when a pass ended a conversation nobody had carried on.
//
// It says what was lost rather than what was saved, because that is the half a reader cannot work
// out: the thread is gone and whatever that session had worked out and not written to its desk went
// with it. And it says what was NOT done, because nothing was — no process was stopped, nothing was
// asked of the session, and a lead reading "ended" could otherwise take it for a handover.
function endedColdLine(name) {
  return `${name}'s conversation had been quiet for longer than one can be carried on, so the chat ended it rather than paying for the whole of it again at the next message. Nothing was stopped and nothing was asked of ${name}: whatever it had not written to ${desk(name)} is gone, and the next message to it starts a new conversation that reads that desk first.`;
}

// What the lead is told when a conversation has newly grown into a band worth knowing about, and
// was not handed over for it.
//
// THE REASON IS IN THE LINE. A crossing is parked at most once, on the pass that reads it, and a
// seat that could not be parked then is not tried again on this band — so a lead reading "has
// reached" with nothing after it would be left to guess whether the chat had tried. What is left to
// press is said last, and it is still true: nothing here comes back for this band.
//
// BY NAME AND NOT IN THE SECOND PERSON, including where the name is the lead's own. One sentence
// said one way — the block this replaced named several sessions at once and had to choose between
// "you" and a name, and there is nothing left here to choose between.
function crossedLine(human, name, held, why) {
  return `${name} has reached ${held}. It was not handed over for it — ${why} — so handing ${name} over is ${human}'s to press, on that session's panel.`;
}

// What a session is told when the CHAT, and not a person, is asking it to hand over.
//
// `handoverAsked` names whoever pressed the button. Nobody pressed one here, and a line saying
// somebody had would put a sentence on a panel about a person who did nothing. So this says what
// actually decided it — a session asked out of nowhere to write its desk has to be able to tell
// this from somebody deciding it was finished.
function parkAsked(name, full) {
  return `The chat is asking ${name} to hand over. The account has reached ${full} of the usage window it is running in, and that window does not lift within the hour a conversation can be carried across, so what is in flight is being written down rather than waited out. ${name} is writing ${desk(name)} before its thread ends.`;
}

// What the lead is told once a session has been parked on where the account stands.
function parkedLine(name, full) {
  return `${name} was handed over by the chat rather than by anybody pressing for it: the account had reached ${full} of the window it is in, and that window does not lift within the hour a conversation can be carried across. ${name} wrote ${desk(name)} first, so what it was doing is on that desk rather than gone, and the next message to it starts a new conversation that reads it.`;
}

// What a session is asked when the pass hands it over ahead of its cache going cold. The same
// register as `parkAsked`, for the same reason: nobody pressed anything, so the line says what
// decided it — and says how long the seat has been idle, which is the whole of the reason.
function expiringAsked(name, idle) {
  return `The chat is asking ${name} to hand over. Its conversation is about to lose its cache: its last turn ended ${idle}, and an hour after it the whole conversation would have to be paid for again, so what is in flight is being written down while it can still be asked for. ${name} is writing ${desk(name)} before its thread ends.`;
}

// What the lead is told once a session has been parked ahead of its cache going cold.
function expiredLine(name, idle) {
  return `${name} was handed over by the chat rather than by anybody pressing for it: its conversation was about to lose its cache, its last turn having ended ${idle}. ${name} wrote ${desk(name)} first, so what it was doing is on that desk rather than gone, and the next message to it starts a new conversation that reads it.`;
}

// What a session is asked when the pass hands it over for how far into its window it has grown.
// The same register as the two above, for the same reason: nobody pressed anything, so the line
// says what decided it — the share, in the words the row says it in — and why a fresh conversation
// is the cheaper one to carry from here.
function grownAsked(name, held) {
  return `The chat is asking ${name} to hand over. Its conversation has reached ${held}, and from here a fresh conversation that reads ${desk(name)} is cheaper to carry than this one, so what is in flight is being written down while there is room left to ask for it. ${name} is writing ${desk(name)} before its thread ends.`;
}

// What the lead is told once a session has been parked for the size of its conversation.
function grownLine(name, held) {
  return `${name} was handed over by the chat rather than by anybody pressing for it: its conversation had reached ${held}, and a fresh conversation that reads its desk is cheaper to carry than that one. ${name} wrote ${desk(name)} first, so what it was doing is on that desk rather than gone, and the next message to it starts a new conversation that reads it.`;
}

// Names, said in a sentence.
function named(names) {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function times(count) {
  return count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
}

// What the lead is told when the account is found at its stop line — ONCE, on the pass that enters
// the hold, which is what makes the hold a record and not only a latch.
//
// FROM THE SAME ANSWERS THE ROOM IS WORDED FROM. The room says what the hold does above its rows,
// and this says it on the lead's panel; both read `warm`, `parking` and the moment off the one
// record, so that the page and the panel cannot disagree about what is being done. And after what
// the hold does, what the gate refuses while it stands — the clause from gate.mjs, which is the
// lead being told before it tries that a desk and a conversation from nothing will be refused.
// The clause was absent until the gate existed, because the lead would have believed it and it
// would have been false; it is worded beside the mechanism and nowhere here.
function holdEnteredLine(hold) {
  const opening = `The account has reached ${Math.round(hold.fullness * 100)}% of the usage window it is running in`;
  if (hold.resetsAt === null) {
    return `${opening} and did not say when that window lifts, so nobody is being handed over: a park is not something to do on an unknown. The next completed turn settles it — this is re-read from every reading until one names the moment or no longer says the account is stopping. ${NO_NEW_WORK}`;
  }
  const lifts = `That window lifts at ${atTime(hold.resetsAt)}`;
  if (hold.warm) {
    return `${opening}. ${lifts}, inside the hour a conversation can be carried across, so nothing is being ended and nobody is handed over: everybody is still here when it does. ${NO_NEW_WORK}`;
  }
  if (hold.parking) {
    return `${opening}. ${lifts}, later than a conversation can be carried across, so each conversation is being handed over to its desk, fullest first, while there is still an account to write it with. Each park is said here as it lands. ${NO_NEW_WORK}`;
  }
  return `${opening}. ${lifts}, later than a conversation can be carried across, and this workspace buys no turn, so nobody is handed over: whatever a conversation has not written to its desk by then goes with it. ${NO_NEW_WORK}`;
}

// What the lead is told when the window has reopened — ONCE, on the pass that finds the hold
// lifted and removes it. With the auto-continue off nothing wakes a rejected session by itself, so
// without this line the room would come back to nobody: a person would have to notice a non-event.
//
// It names who was handed over, because those are the seats whose next message starts a new
// conversation from a desk rather than carrying one on, and who was still being turned away,
// because those were never handed over at all and are carrying whatever they had.
function holdLiftedLine(hold) {
  const said = [`The usage window the account was held on lifted at ${atTime(hold.resetsAt)}, so the hold is over and the room is being read as usual again.`];
  if (hold.parked.length === 0) {
    said.push("Nobody was handed over under it, so every conversation that was here is still here.");
  } else {
    said.push(
      `${named(hold.parked)} ${hold.parked.length === 1 ? "was" : "were"} handed over under it: each is on its desk, and the next message to each starts a new conversation that reads that desk first.`,
    );
  }
  const refused = Object.keys(hold.refused);
  if (refused.length > 0) {
    said.push(
      `${named(refused)} ${refused.length === 1 ? "was" : "were"} never handed over — the account turned the park away every time it was asked — and still ${refused.length === 1 ? "carries" : "carry"} the conversation ${refused.length === 1 ? "it" : "each"} had.`,
    );
  }
  return said.join(" ");
}

// The other exit, for the hold that had no moment: a later reading no longer says the account is
// stopping. Said once too, on the pass that removes the record.
function holdEndedLine() {
  return "The account no longer reads as stopping: the reading that put it at the stop line has been overtaken by one that does not, so the hold entered on it is over. Nobody had been handed over under it.";
}

// What the lead is told when a seat whose park the account kept turning away has gone cold. Said
// ONCE, and it says what was lost: this is the seat that was never handed over, so its desk holds
// whatever it held before the hold and nothing of what the conversation worked out since. The cold
// ending in the same pass says on its own panel where the memory stops; this is the lead's copy of
// why it stopped there.
function neverParkedLine(name, count) {
  return `${name} was never handed over: the account turned its handover away ${times(count)}, and its conversation has gone cold with ${desk(name)} unwritten, so whatever it had worked out since that desk was last written is gone. It is ended as a cold conversation, and the next message to it starts a new one from that desk.`;
}

// Whether there is a conversation here worth parking. Asked the same way in both places it is
// asked, which is what makes the second reading worth taking at all.
//
// A SESSION WITH NO THREAD HAS NOTHING TO HAND OVER. It is also what keeps a pass from acting
// twice: a park ends in `forget`, so a session this feature has already parked answers no here and
// is not asked again on the next pass. There is no memory of what was parked and none is needed —
// the act removes its own subject, the way ending a cold conversation does.
//
// AND A SESSION SITTING ON A PERMISSION PROMPT IS LEFT ALONE. It costs time and not tokens: nothing
// is running, no transcript is growing, and a person is mid-decision. Parking it destroys that
// decision to save nothing. Asked with `parked`, which answers for one session — the all-sessions
// reading hands back empty entries for anybody who was ever asked about, so a length taken from it
// would call every session busy that had once been asked anything.
//
// AND A CONVERSATION THAT HAS GONE COLD IS NOT PARKED EITHER. Past the hour the thread cannot be
// carried on, so there is nothing a handover turn could write down that the desk does not already
// hold — the ending it gets is the cold one, below in the same pass, which says on its panel where
// the memory stops. This is what bounds a park the service keeps turning away: it is tried again
// while the seat is warm, and stops being tried when the seat is not.
function worthParking(instance, name) {
  if (!hasThread(instance.root, name) || hasGoneCold(instance.root, name)) {
    return false;
  }
  return parked(name, instance.root).length === 0;
}

// Why a crossing into a strong band is told rather than parked, or nothing when the park is worth
// its turn.
//
// THE SAME THREE GATES AS THE PARK AHEAD OF THE HOUR, in the same order, answered as a reason
// rather than as a filter because the line said about a crossing that was not parked says why. A
// workspace that buys no turn is told every crossing, as it always was. A seat with a turn going on
// it is not parked, for the reason the block above gives: a park queued behind that turn would run
// the moment it ends, on a conversation somebody may be mid-sentence with. And `worthParking` is
// the seat's own state. A crossing is only ever read off a thread that is there, and the cold
// ending above has already removed a thread past the hour unless the room is off and it came back
// OFFLINE — so a permission prompt somebody is mid-decision on is what `worthParking` is saying no
// about here, and the cold arm is the one reading left, worded rather than checked.
function keptFromParking(instance, name) {
  if (!buysATurn(instance.config)) {
    return "this workspace buys no turn";
  }
  if (turnsGoing(name) !== 0) {
    return "a turn is going on it";
  }
  if (!worthParking(instance, name)) {
    return parked(name, instance.root).length > 0 ? "it is sitting on a permission prompt" : "its conversation has gone cold";
  }
  return null;
}

// Why a park that was asked for did not happen, read off what the turn came back with — or nothing
// when it did. Three ways, none of them retried on this band: the room is off, and `inTurn` said
// so; the seat stopped being worth it while the parks before it ran, and the turn's own re-check
// abandoned it before writing anything; or the account turned the run away.
function heldBack(done) {
  if (done === OFFLINE) {
    return "the room is off";
  }
  if (done.abandoned === true) {
    return "it was handed over, or stopped being worth it, before its turn came";
  }
  if (done.refused === true) {
    return "the account turned the park away";
  }
  return null;
}

// The room in the order it is parked in, which is DETERMINED and not chosen. A pass that picked an
// order would be exercising the one judgment this whole feature is written not to have.
//
// DESCENDING SHARE OF THE WINDOW, so the seat with the most to lose gets its turn first on an
// account that may start refusing partway down the list. Ranked on `fullnessIn` and not on the
// band beside it, because a band is a bucket: two conversations inside one are equal to it, and so
// are two in none, and an order built on that is alphabetical wearing an argument.
//
// A SESSION NOBODY HAS A READING FOR GOES LAST, deliberately and not by falling out of a
// comparison. Nothing is not zero. A seat whose size is unknown is not the emptiest one here; it
// is the one there is no reason to hurry for.
//
// TIES ON SEAT NAME, ASCENDING. Two seats on an equal share have an equal claim by every measure
// this has, so the tie goes to the one thing that cannot drift between passes — and a check can
// then assert the whole order rather than some property of it.
//
// AND THE LEAD LAST, which is not courtesy. Every other park leaves its line for the lead, and the
// lead's own handover turn is what carries those lines onto its desk. Park the lead first and its
// desk is written before it has been told what became of anybody, and every line after that arrives
// to a conversation which no longer exists.
function inParkOrder(instance, room) {
  const lead = instance.config.leader;
  return [...room].sort((one, other) => {
    if (one.name === lead || other.name === lead) {
      return one.name === lead ? 1 : -1;
    }
    const mine = fullnessIn(instance.root, one.name);
    const theirs = fullnessIn(instance.root, other.name);
    if (mine !== theirs) {
      if (mine === null) {
        return 1;
      }
      if (theirs === null) {
        return -1;
      }
      return theirs - mine;
    }
    return one.name < other.name ? -1 : 1;
  });
}

// One pass over the room, and everything it decides costs nothing.
//
// WHAT CHANGED HERE, because the shape of this function is the whole feature. It used to read the
// room and hand the lead a block, which bought a run nobody asked for so that a model could decide
// whether to press a button. It now decides itself, acts on the session concerned, and leaves a
// line. Three things follow from that and each of them is the point rather than a consequence:
//
//   The lead's account is not spent to be told something. A file append and a map write are what
//   this costs, and a pass that finds nothing costs neither.
//
//   The room being off no longer silences it. `deliver` had three ways of returning with no turn
//   having been taken — the room off, the addressee gone, the run refused — and on every one of
//   them the crossing had already been written down as said and was reported to nobody, ever. The
//   room goes off around quota events, which is exactly when a strong band is crossed.
//
//   Nothing waits on the lead. The old whole-tick gate on `turnsGoing(leader)` is gone with the
//   turn it protected: there is nothing here now that a busy lead could be a bad moment for, and a
//   crossing during a long lead turn used to be dropped for the length of that turn.
//
// NOTHING IS RECORDED AS DONE UNTIL THE ACT RETURNED. A session is entered against `seen` only
// after the line about it is on the panel, and a conversation is ended only inside the turn that
// re-read it as cold. A pass that cannot act on something records nothing about it and reads it
// fresh next time, which is what makes this safe to kill: there is no queue here and no half-kept
// promise, so a chat that goes down mid-pass loses nothing but the pass.
//
// THE GATE IS PER CONDITION AND NOT PER SESSION. Ending a cold conversation needs no turn in
// flight on that session — it is the one thing that must not happen under a live run — while what
// is only said needs nothing at all.
//
// ONE PASS AT A TIME. A pass waits on turns now — a park goes through `handOver`, which chains
// onto the session's own queue and then runs a whole turn — so a pass can outlast the cadence it
// fired on, and the timer does not wait for it. Two passes over one room would each decide about
// the same seats: the second would queue a park behind every park the first has in flight, and
// start parking whatever the first has not reached yet beside it, in an order nobody chose. So a
// tick that finds the last pass still going does nothing and records nothing, which is right:
// the room is being read.
//
// NOT SHIPPED BEFORE THIS SLICE, deliberately. Until the park, every await in a pass resolved in
// microtasks inside the tick's own macrotask, and a guard around a window that does not exist
// cannot be shown to matter — it was written, could not be reddened, and was taken out again. This
// is the slice that opens the window.
//
// WHERE A SECOND PASS SHOWS, measured while the check for this was written: not in the order of the
// parks. A second pass chains onto the same per-session queues as the first, so it trails it park
// for park and is abandoned at each — what it leaves is a turn queued for nothing on every seat the
// first has not finished with, and a record of the pass that acted overwritten by one that did
// nothing. The check reads the queue on a seat the first pass is held on.
let passing = false;

export async function readTheRoom(instance) {
  if (passing) {
    return;
  }
  passing = true;
  try {
    await walkTheRoom(instance);
  } finally {
    passing = false;
  }
}

// The pass itself, and the shape of this function is the whole feature: see above.
async function walkTheRoom(instance) {
  const room = sessions(instance);
  const when = new Date();
  const at = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;

  let decided = 0;
  let acted = 0;

  // THE ACCOUNT FIRST, because it is the only thing read here that is not about a session at all.
  //
  // Where the account stands is a fact about the whole workspace, so unlike everything below it
  // this asks nothing about whether a turn is in flight: a seat that is mid-run is exactly the seat
  // spending the window, and waiting for it to be idle is waiting for the thing being decided
  // about to finish happening.
  //
  // WHAT IS READ IS THE HOLD, AND THE READINGS ONLY WHERE THERE IS NONE. The readings are folded
  // out of each session's own file and a park ends by removing that file, so a pass that decided
  // from the readings alone would go quiet the moment it had parked the seats carrying them — a
  // refused park would stop being retried not because the account recovered but because the parks
  // around it destroyed what said otherwise. The hold is entered ONCE, on the reading that crossed
  // the line, and everything after that is decided against the hold, which survives every park
  // and a restart of the chat.
  //
  // THREE ANSWERS AND NOT TWO, which is the whole of what entering it is. `warm` says whether the
  // window lifts inside the hour a conversation can be carried across, and it is THREE-VALUED —
  // `null` is the account not having said when it lifts, which is not the same answer as no.
  //   true  — it lifts within the hour. Carry: everybody is still here when the wait is over, and
  //           parking them would spend the account to save conversations that were never at risk.
  //           The hold is recorded, parks nobody, and lifts at that moment.
  //   null  — nobody said when it lifts. Carry, because a park is not something to do on an
  //           unknown: it is irreversible for the conversation it ends, and the reading that would
  //           have justified it never arrived. This hold has no moment to wait for, so it is the
  //           one that is re-decided from the readings on every pass — it parks nobody, so the
  //           readings keep arriving — and it ends when they no longer say the account is stopping.
  //   false — it lifts later than that. Kill: every conversation still here when the window turns
  //           over is one that will have to be paid for again from nothing, so what each seat knows
  //           is written to its desk while there is still an account to write it with.
  //
  // AND ONLY WHERE THE WORKSPACE BUYS A TURN IS ANYBODY PARKED. A park is a turn on the session
  // parked, which is the first thing in a pass that spends anything; a workspace that wrote `0`
  // declined exactly this. The hold is still recorded there, because recording it spends nothing
  // and the room should be able to say the account is stopping.
  //
  // AND WHAT THE HOLD DOES IS SAID TWICE, ONCE EACH WAY. The pass that enters it says so, and the
  // pass that finds it over says so — because with nothing waking a turned-away session by itself,
  // the window reopening is a non-event, and a person would otherwise have to notice one. Both are
  // said inside the pass that writes or removes the record, so the record is the latch: a hold that
  // is on disk has been announced, and one that is gone has been announced as gone.
  let hold = holdIn(instance.root);
  if (hold !== null && holdLifted(hold)) {
    // The seats the account kept turning away are looked at before the record goes, because the
    // count of how often each was turned away goes with it: one that has gone cold under the hold
    // is the failure this exists to make visible, and it is said now or never.
    for (const name of Object.keys(hold.refused)) {
      if (hasGoneCold(instance.root, name)) {
        announce(instance, neverParkedLine(name, hold.refused[name]), at);
        forgetRefused(instance.root, name);
      }
    }
    hold = holdIn(instance.root);
    endHold(instance.root);
    announce(instance, holdLiftedLine(hold), at);
    hold = null;
  }
  if (hold === null || hold.resetsAt === null) {
    const standing = accountStanding(instance);
    if (standing === null || !standing.stop) {
      if (hold !== null) {
        endHold(instance.root);
        announce(instance, holdEndedLine(), at);
        hold = null;
      }
    } else if (hold === null || standing.resetsAt !== null) {
      hold = enterHold(instance.root, {
        resetsAt: standing.resetsAt,
        fullness: standing.fullness,
        warm: standing.warm,
        parking: standing.warm === false && buysATurn(instance.config),
      });
      announce(instance, holdEnteredLine(hold), at);
    }
  }

  if (hold !== null && hold.parking) {
    const full = `${Math.round(hold.fullness * 100)}%`;
    const attempts = parkAttemptsAllowed(instance.config);
    for (const session of inParkOrder(instance, room)) {
      // ONCE PER SEAT PER HOLD, and the hold keeps the list. A seat that was parked and then spoken
      // to again inside the same window has a thread again and is still not parked again; a seat
      // whose park was turned away is not in the list, and is tried again while it is warm.
      if (hold.parked.includes(session.name)) {
        continue;
      }

      // A SEAT THE ACCOUNT KEPT TURNING AWAY, NOW COLD, IS THE ONE FAILURE HERE, and it is said
      // once. Past the hour there is nothing left to park — the cold ending below removes the
      // conversation in this same pass — so the retry stops here, and what is said is what was lost:
      // this seat was never handed over, and its desk was never written. The count is removed with
      // the saying, which is what makes it once and not every pass the seat stays cold in.
      if (hold.refused[session.name] !== undefined && hasGoneCold(instance.root, session.name)) {
        announce(instance, neverParkedLine(session.name, hold.refused[session.name]), at);
        forgetRefused(instance.root, session.name);
        continue;
      }
      if (!worthParking(instance, session.name)) {
        continue;
      }

      // A SEAT ASKED AS OFTEN AS THIS WORKSPACE ALLOWS IS NOT ASKED AGAIN. The count is the hold's
      // and the bound is the instance's; absent, there is no bound, and a park is asked for again
      // on every pass while the seat is warm. What becomes of a seat left here is what becomes of
      // any seat the account kept turning away: said once if it goes cold, named at the lift if not.
      if (attempts !== null && (hold.refused[session.name] ?? 0) >= attempts) {
        continue;
      }
      decided += 1;

      // ASKED AGAIN INSIDE THE TURN, and what is asked again is what can have changed. `inTurn`
      // chains onto this session's own queue, so this can run behind a message that arrived a
      // moment after the room was read and behind everything already stacked up: by then the seat
      // may have been handed over by a press, may be waiting on a permission prompt, or the window
      // may have lifted — and a park after the lift spends the new window to save nothing.
      //
      // WHAT IS DELIBERATELY NOT RE-READ IS THE ACCOUNT'S READINGS. Parking ends in `forget`, which
      // removes the very file they are folded from, so a second reading taken after the first park
      // can say the account is fine — not because it recovered but because this destroyed what said
      // otherwise. A park that re-read them would abandon every seat after the first. The hold is
      // what survives a park, and the hold is what is asked.
      const done = await handOver(instance, session.name, parkAsked(session.name, full), () =>
        worthParking(instance, session.name) && holdStands(instance.root, hold),
      );

      // Nothing happened, and each of the three ways that can be true is a reason to leave the seat
      // exactly as it is: the room was off, the turn found the seat no longer worth parking, or the
      // account turned the run away. The last one is the one that comes back — the thread is still
      // there and the seat is not in the hold's list, so the next pass tries again — and it is the
      // one that is counted, against the seat, on the hold: the count is what the failure above is
      // said with if the seat goes cold first.
      if (done === OFFLINE || done.abandoned === true) {
        continue;
      }
      if (done.refused === true) {
        markRefused(instance.root, session.name);
        continue;
      }
      markParked(instance.root, session.name);
      acted += 1;
      announce(instance, parkedLine(session.name, full), at);
    }
  }

  // A conversation nobody carried on for long enough, ended here rather than on the next message
  // that happens to arrive. The same act, at the moment it becomes true instead of whenever
  // somebody next types: `deliver` already does exactly this at the top of a turn, and past the
  // hour the thread is unresumable either way, so what this moves is when the panel says so and
  // not what is lost.
  //
  // THE ONE IN `deliver` IS THE FALLBACK AND IT IS NOT GOING ANYWHERE. It ends a cold conversation
  // sooner than this whenever a person types before the next tick, and it is the whole of the cold
  // handling in a chat that is not being ticked at all. This costs nothing to run and neither does
  // that one, so there is no saving in choosing between them and no state they can disagree about:
  // ending a conversation is removing its file, and the second one to arrive finds it gone.
  //
  // ONLY WHERE NOTHING IS RUNNING ON IT, read here and then held by the turn below. `forget` is a
  // bare `rmSync` with no lock and every other caller of it sits inside a turn already; a pass that
  // read the gate and then deleted the file would be the first caller outside one, and a message
  // arriving in between would have its session removed under a live run — the thread id gone, the
  // run finishing into nothing, and the next turn starting fresh from the desk with no cold reading
  // having said so.
  //
  // AND ASKED AGAIN INSIDE THE TURN, which is what actually closes that race rather than the gate
  // above. A message that arrived while this was queuing runs first, the conversation is warm
  // again, and the second reading is the one that decides.
  const cold = room.filter(
    (session) => turnsGoing(session.name) === 0 && hasGoneCold(instance.root, session.name),
  );
  decided += cold.length;
  for (const session of cold) {
    // OFFLINE comes back here whenever the room is off, and nothing is done and nothing recorded.
    // That is accepted rather than worked around: `inTurn` is the one place the question "may
    // anything happen right now" is asked, and a free condition that acted anyway would be a second
    // answer to it. The conversation is still cold next pass.
    const ended = await inTurn(session.name, () => {
      if (!hasGoneCold(instance.root, session.name)) {
        return false;
      }
      forget(instance.root, session.name);
      append(instance.root, session.name, { from: THE_CHAT, text: coldLine(session.name), cold: true });
      return true;
    });
    if (ended !== true) {
      continue;
    }
    acted += 1;
    announce(instance, endedColdLine(session.name), at);
  }

  // A conversation in its last warm minutes, handed over before the hour rather than ended after
  // it. The cache behind a conversation lives an hour past its last turn; past that the ending
  // above is the right and cheaper act, and before it there is a window — the last ten minutes — in
  // which a turn spent asking the seat to write its desk is spent while the conversation can still
  // be asked. It saves no tokens: nothing is ever resumed, so doing nothing is free and this turn is
  // not. What it buys is a desk written by the session that knows what is on it.
  //
  // THE SECOND THING HERE THAT SPENDS, so it asks the question the hold's parks ask, at the moment
  // it is about to: a workspace that wrote `watchEverySeconds: 0` declined the turn and is told
  // nothing here.
  //
  // ONE DECISION PER SEAT WITHOUT A RULE SAYING SO. It cannot meet the ending above: that reads
  // `idle > COLD_AFTER` and this reads `PARK_AFTER < idle <= COLD_AFTER`. It cannot meet the hold's
  // parks: a seat parked under the hold this pass has no thread, and `worthParking` says so. And a
  // seat parked here has no thread when the bands below read it, so `bandIn` answers nothing.
  //
  // ONLY WHERE NOTHING IS RUNNING ON IT, for the reason the ending gives — a seat's clock stands
  // still for the whole of a turn, so a session working through a long one reads as idle — and
  // ASKED AGAIN INSIDE THE TURN, because the park is queued behind whatever is on that seat and may
  // run minutes later: if the seat spoke meanwhile its clock moved and it is no longer nearly cold,
  // and if it went cold while queued the cheaper ending is the right act. What is asked again is
  // the reading and not the turn count: inside its own turn a seat always has one going.
  //
  // In the order the hold parks in, the lead last, so that every other park's line reaches a lead
  // that still has a conversation to carry it onto its desk. A park the account turns away is left
  // as it is: the seat is still warm and still nearly cold on the next pass, and is asked again
  // there; if it goes cold first, the ending above is what it gets.
  if (buysATurn(instance.config)) {
    const expiring = inParkOrder(
      instance,
      room.filter(
        (session) =>
          turnsGoing(session.name) === 0 &&
          hasNearlyGoneCold(instance.root, session.name) &&
          worthParking(instance, session.name),
      ),
    );
    decided += expiring.length;
    for (const session of expiring) {
      const idle = ago(ranOn(instance.root, session.name));
      const done = await handOver(instance, session.name, expiringAsked(session.name, idle), () =>
        worthParking(instance, session.name) && hasNearlyGoneCold(instance.root, session.name),
      );
      if (done === OFFLINE || done.abandoned === true || done.refused === true) {
        continue;
      }
      acted += 1;
      announce(instance, expiredLine(session.name, idle), at);
    }
  }

  // And the bands. Read after the cold conversations were ended, so that a session this pass has
  // just ended is not also read as having grown: `bandIn` reads the file that was removed and
  // answers nothing, which is one decision per session without a rule saying so.
  //
  // ACTED ON, ONCE PER CROSSING. A crossing into a strong band is the third reason this pass spends
  // a turn: a conversation that far into its window is a few turns from losing whatever its desk
  // does not say, and a fresh conversation that reads the desk is cheaper to carry than this one.
  // The park is a consequence of the crossing, so the crossing's own record bounds it: `whatChanged`
  // names a seat until `nowSeen` records the band, and that is written EXACTLY ONCE below, after
  // whichever of the two outcomes happened. A seat that could not be parked on this crossing — a
  // turn going on it, a permission prompt, no turn bought here, the account turning the park away —
  // is told, with the reason, and not tried again on this band: its next chance is the next strong
  // band, or the park ahead of the hour once it idles. That is an accepted loss and not an
  // oversight. A retry keyed on the band would be a second record beside `seen`, saying "parked"
  // when nothing parked — the mistake watch.mjs names, on the other channel.
  //
  // DECIDED AT THE READ, for every crossing at once, like the block above: the parks run one after
  // another, and a seat further down the list may not be the seat it was by the time its turn
  // comes. What can change is not the size — a context cannot shrink while it waits — but the
  // thread: a press, a leave, the hour passing. `worthParking` reads exactly that, so it is what
  // the turn asks again before writing anything, and a seat it no longer holds for is told instead.
  //
  // IN THE ORDER THE CROSSINGS CAME, not `inParkOrder`. A band is entered on one seat's answer, so
  // a crossing is one seat at a time by construction; and the lead, when it crosses, is parked like
  // anybody — every line said before its park is on its panel and goes onto its desk with it, which
  // is what parking the lead last is for.
  const crossed = whatChanged(instance, room);
  decided += crossed.length;
  const kept = new Map(crossed.map((one) => [one.name, keptFromParking(instance, one.name)]));
  for (const one of crossed) {
    // The share said off the reading the room was read with, in the wording the row and the size
    // block already say it in: a sentence carrying its own copy of a number, or its own copy of a
    // phrasing, is a second place for one fact to be said two ways.
    const held = `${one.context.toLocaleString("en-US")} tokens, ${shareSaid(one.context, one.window)}`;
    let why = kept.get(one.name);
    if (why === null) {
      const done = await handOver(instance, one.name, grownAsked(one.name, held), () => worthParking(instance, one.name));
      why = heldBack(done);
    }
    announce(instance, why === null ? grownLine(one.name, held) : crossedLine(instance.config.human, one.name, held, why), at);
    nowSeen(one.name, one.band);
    acted += 1;
  }

  tickRead({ sessions: room.length, decided, acted });
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

  // The one timer in this toolkit, and it is tied to the server rather than to the process.
  //
  // UNREF'D, so it is not a reason for node to stay up: a timer that holds the event loop open is a
  // process that will not end when everything else has, and the only way out of that is a kill.
  // CLEARED WHERE THE SERVER CLOSES, so a chat that has been stopped has stopped reading the room —
  // a timer that outlived its server would go on ending conversations and writing on the panels of
  // a workspace nobody is serving, and there would be nothing left to stop it with. The room it
  // remembers goes with it, because a restarted chat has told nobody anything.
  //
  // Both, and not one of them. Unref alone leaves it running for as long as the process happens to
  // live; clearing alone leaves the process unable to end by itself.
  //
  // ARMED ALWAYS, including in a workspace that has asked for no turn to be spent on it. This is a
  // reversal of what stood here, and the reason it is written out rather than quietly edited: the
  // old shape read `watchEverySeconds: 0` as "this feature does not exist here" and skipped the
  // timer entirely, which is stronger than a tick that fires and decides not to speak — and being
  // stronger was the argument for it.
  //
  // It is the wrong strength now. `0` says "do not spend a turn on me", and everything the tick
  // does today spends nothing: it reads the room, ends a conversation that could no longer be
  // carried on, and appends a line. A workspace that declined a run would have been quietly
  // declining those too, and the ones that come later are the ones it would least have chosen to
  // decline. A field must not grow into a larger promise than the one it was written with.
  //
  // So the cadence is asked for every workspace, and what may be SPENT is asked separately, by
  // whatever is about to spend it — the park asks `buysATurn` where it is about to.
  const every = howOften(instance.config);
  // Said at the moment of arming and nowhere else, so that "no record at all" keeps a meaning of
  // its own. A watch that has been armed and has not yet fired is every restart of the chat, for as
  // long as a whole cadence — and a reading that could not tell that apart from a watch that died
  // on arrival would cry fault every time somebody restarts a chat, which is the documented repair
  // for a stale server. Every served instance has one now, `0` included: a record is a record of a
  // watch, and every instance has a watch.
  armTheWatch(every);
  // AND SAID, HERE, AT THE MOMENT OF ARMING. A watch that is armed and working produces no effect
  // — a pass that decides nothing writes nothing — so nothing a person could test would tell a
  // working watch from one that was never armed, and the only assertion that cannot be wrong in
  // the direction that hides the failure is the arming code's own. It is said in this function
  // rather than by whatever started the server, for the reason `tellTheLead` above is: every way
  // of serving an instance arms a watch, and the line has to come from the scope that holds
  // `every`, or it is a second reading of the config that can drift from the one that was armed.
  console.log(watchArmedLine(instance.config, every));
  const watch = setInterval(() => {
    readTheRoom(instance).catch(() => {
      // A tick that fell over is one tick. There is another along, the room is read fresh, and
      // nothing here is worth taking a chat down for.
    });
  }, every);
  watch.unref();
  server.once("close", () => {
    clearInterval(watch);
    forgetTheRoom();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(instance.config.port, HOST, () => {
      // Written from here rather than from whatever started the server, so that every way of
      // serving an instance leaves the address behind and none of them has to remember to.
      //
      // The tools this instance serves itself are the one thing NOT done that way: they are read
      // by whoever is about to serve and handed in, because what was read is a line somebody
      // reads when the chat starts and this file prints nothing at all. Moving it in here would
      // move that line into a process with no terminal to say it on.
      record(instance.root, server.address().port);
      resolve(server);
    });
  });
}
