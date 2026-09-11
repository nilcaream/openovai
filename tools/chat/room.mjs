// What a room says: one line per person, laid out.
//
// The rows themselves come from the chat, because half of what a room is lives only in the process
// serving the page — how many turns are going, who is held up waiting for whom, what is stopped
// waiting to be allowed something. What this file decides is what those rows SAY. It sits here,
// beside the server, rather than inside the command that first needed it: the chat has to answer
// the same question for the session that leads, and two layouts of one room would drift the day
// one of them learned a new phrase.
//
// The page lays the same rows out for itself, in its own script, and the two say the same things
// in the same order. They are not shared code and cannot be — one of them is a page served as
// text — so this is a duplication somebody has to keep true, and it is written down here rather
// than discovered. There are two places to keep true, not three: the command and the tool are the
// same lines from here.

import { NO_NEW_WORK } from "./gate.mjs";

// What a room that is off says, and the one place it is worded. Above the rows and never on one:
// whether anything will be started is a fact about the ROOM, and the same sentence on every row
// would read as a state each of those sessions is in, which is the one thing this is not.
const OFF = "The room is offline — nothing new will be started until it is brought back online.";

// One line each, names lined up. The width is the room's rather than each row's, which is the
// whole reason this is not a map over `describeSession` at the call site.
//
// The room's own line comes first and only when there is one. It is a second argument rather than a
// row the caller could push on, so that both callers get the wording from here — the command and
// the tool are the same lines from this file, and a room off in one of them and on in the other
// would be two answers to a question that has one.
//
// And the account's line after it, for the same reason and with the same argument shape: whether
// the account is stopping is a fact about the workspace, and the two callers get its wording from
// here. It is the facts the hold was decided on and not a sentence — the moment, whether that
// moment is inside the hour a conversation can be carried across, and whether anybody is being
// handed over — because the moment is worded in the hours of whoever is reading, and that is a
// clock only the reader's side has.
//
// And whether the room is being read at all, after those two. A pass that finds nothing writes
// nothing, so a watch that has died and one that has nothing to do look the same from the rows —
// and since the watch is the thing that parks, its death is the one blocker nothing else would
// name. What is said is the record the watch keeps of itself: when the room was last read and how
// often it is read, and nothing more. A timestamp and not a health indicator: there is no threshold
// here and no colour, "older than about two cadences" is a judgment, and it belongs to whoever is
// reading. `null` says nothing, for a chat too old to send it.
export function roomLines(sessions, offline = false, hold = null, watch = null) {
  const width = Math.max(...sessions.map((session) => session.name.length));
  const lines = sessions.map((session) => `${session.name.padEnd(width)}  ${describeSession(session)}`);

  const above = [];
  if (offline) {
    above.push(OFF);
  }
  if (hold !== null && typeof hold === "object") {
    above.push(holdSaid(hold));
  }
  if (watch !== null && typeof watch === "object") {
    above.push(watchSaid(watch));
  }
  return [...above, ...lines];
}

// What a room says about being read: an age and a cadence, and no verdict. Two shapes, one for a
// watch that has finished a pass and one for a watch armed and not yet round — the arming is said
// in that second one so that a room read every five minutes and armed twenty minutes ago reads
// exactly as what it is. The moments come as moments, and are worded in the reader's own terms.
function watchSaid(watch) {
  if (typeof watch.at === "string") {
    return `The room was last read ${ago(watch.at)}; it is read every ${watch.everySeconds} seconds.`;
  }
  return `The room has not been read yet; the watch was armed ${ago(watch.armedAt)} and reads every ${watch.everySeconds} seconds.`;
}

// What a room says while the account is at its stop line — what the hold does, and what the gate
// refuses for as long as it stands.
//
// What the hold does was decided at entry and is kept on it: it hands everybody over, or carries
// everybody because the window lifts in time, or carries everybody because nobody said when it
// lifts, or hands nobody over because this workspace buys no turn. Four sentences, one each, and a
// person takes each in at a glance.
//
// AND THE SAME CLAUSE AFTER EACH, from gate.mjs and never worded here: that no new work is being
// started. That clause was deliberately absent until the gate existed, because a person would have
// believed it and it would have been false — a typed message still starts a run, a hire still went
// through. It is worded beside the mechanism that makes it true, and the check that reads it here
// is the check that watches a hire and a message be refused.
//
// `warm` IS READ OFF THE HOLD AND NEVER OFF THE CLOCK. Whether the window lifts inside the hour was
// answered once, when the hold was entered, and that answer is what was acted on: a hold that has
// been handing the room over for two hours is by now "inside the hour", and a line that derived it
// again would say so about a room that was parked on the opposite answer.
function holdSaid(hold) {
  if (typeof hold.resetsAt !== "number") {
    return `The account is nearly spent and did not say when it lifts — nobody is being handed over; the next completed turn settles it. ${NO_NEW_WORK}`;
  }
  const lifts = `its window lifts at ${atTime(hold.resetsAt)}`;
  if (hold.warm === true) {
    return `The account is nearly spent — ${lifts}, inside the hour a conversation can be carried across, so nothing is being ended or handed over. ${NO_NEW_WORK}`;
  }
  if (hold.parking === true) {
    return `The account is nearly spent — ${lifts}, later than a conversation can be carried across, so each conversation is being handed over to its desk. ${NO_NEW_WORK}`;
  }
  return `The account is nearly spent — ${lifts}, later than a conversation can be carried across, and this workspace buys no turn, so nobody is handed over. ${NO_NEW_WORK}`;
}

// What one line of the room says. The order the phrases are tried in is the whole of what makes it
// worth reading: what a person can end comes before what they cannot.
function describeSession(session) {
  const doing = session.doing === "" ? "(has not said what it is on)" : session.doing;
  const said = [
    stateOf(session),
    // Beside the state phrase and not inside it. What a session is doing and whether its account
    // is available are different questions, and a session answering right now while its last run
    // was turned away is a real state that one word could not say.
    refusedSaid(session.refused),
    windowsSaid(session.quota),
    session.thread ? null : "nothing to carry on",
    typeof session.context === "number" ? `${session.context.toLocaleString("en-US")} tokens` : null,
    // The same reading in the unit that means something on every model. BESIDE the tokens and never
    // instead of them, and never as a state: a share is a second reading, and what a person does
    // about it is theirs. There is no threshold here, no colour and no word for how full is too
    // full — the row carries readings, and the one line in this toolkit that holds an opinion about
    // a size is handed to the lead and nowhere else.
    shareSaid(session.context, session.window),
    session.active === null ? "nothing said yet" : `last moved ${ago(session.active)}`,
  ].filter((part) => part !== null);

  return `${session.role} (${session.model})  ${doing}  —  ${said.join(" · ")}`;
}

// When the limit lifts, in the hours of whoever is reading. The moment comes from the service and
// only its spelling is ours — the same rule, and the same two lines, the panel says it by.
function atTime(seconds) {
  const when = new Date(seconds * 1000);
  return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
}

// The refusal still in force, if there is one. A refusal that named no moment is still said: it is
// a refusal either way and the phrase simply says less, which is the rule the panel already
// follows for the same field.
function refusedSaid(refused) {
  if (refused === null || refused === undefined) {
    return null;
  }
  return typeof refused.resetsAt === "number" ? `refused until ${atTime(refused.resetsAt)}` : "refused";
}

// How full each window the frame named was, and — never separately — when it was read.
//
// The age is not decoration and is not optional. One account means N rows carrying N readings of
// N different ages, each honestly describing its own session's last run, so a number printed on
// its own invites the one misreading this feature can cause: a low number off a row that has not
// run for hours, read as the account's current state. The number and its age are one phrase so
// that there is no way to print half of it.
//
// Every window the frame named, in the frame's order. Picking one would write a window's name into
// this toolkit for the service to rename underneath it.
function windowsSaid(quota) {
  if (quota === null || quota === undefined || !Array.isArray(quota.windows) || quota.windows.length === 0) {
    return null;
  }
  // No moment means no age, and a fullness without its age is not said at all.
  if (typeof quota.at !== "number") {
    return null;
  }
  const full = quota.windows
    .map((window) => `${window.name.replace(/_/g, "-")} window ${Math.round(window.fullness * 100)}% full`)
    .join(", ");

  return `${full}, read ${ago(new Date(quota.at).toISOString())}`;
}

// How much of the window this conversation has taken, as a share of what the model it ran on can
// hold, or nothing at all.
//
// Nothing whenever either half is missing, which is the same rule the two readings above keep and
// is the whole of what makes this safe to add. When the service names no window the row is byte for
// byte what it said before this existed — the tokens, and nothing beside them.
//
// A percentage here and a fraction everywhere else, for windowsIn()'s reason: the fraction is what
// arrives, turning it into a percentage is a thing to do when printing it, and this is the printing.
//
// Exported for `ago`'s reason. The block the lead is handed says this reading too, and a second copy
// of the wording is a second place for one fact to be said two ways. There are two places to keep
// true, not three: the page keeps its own copy because a page served as text cannot import
// anything, and that duplication is the one this file names at the top.
export function shareSaid(context, window) {
  if (typeof context !== "number" || typeof window !== "number" || window <= 0) {
    return null;
  }
  return `${Math.round((context / window) * 100)}% of its window`;
}

// Every state a row can be said to be in, in the order they are tried: the condition that says it,
// and the words it is said in. The order is the whole of what makes a room worth reading — what a
// person can end comes before what they cannot.
//
// A table rather than a chain of returns, so that the states can be counted. A phrase written into
// a branch is a state nobody can enumerate: there is no way to ask what a room can say, and so no
// way to hold anybody to every state it says being one that somebody has been in. This is that
// list, and `stateOf` can return nothing that is not in it.
//
// `named` is the state and `say` is the wording, and they are apart because the wording carries a
// number or a name in three of the six. Keeping them apart is what lets a reader of this table ask
// whether a state was ever reached without also asking whether it was worded exactly this way —
// the wording belongs to the room and is free to change.
//
// The ORDER is not held by anything, and that is measured rather than assumed: swapping the first
// two entries is noticed by nothing in the suite. It would take a session that is at once waiting
// on somebody and stopped waiting to be allowed something, and no fixture reaches that — the run
// that calls is blocked in the call until it comes back, so it has not asked for anything yet.
// Written down here so nobody spends another mutation finding out.
export const STATES = Object.freeze([
  {
    named: "needs you",
    when: (session) => session.asking > 0,
    say: (session) => (session.asking === 1 ? "needs you" : `needs you (${session.asking})`),
  },
  {
    named: "waiting for <name>",
    when: (session) => session.waitingFor !== null && session.waitingFor !== undefined,
    say: (session) => `waiting for ${session.waitingFor}`,
  },
  {
    named: "answering, N waiting",
    when: (session) => session.queued > 0,
    say: (session) => `answering, ${session.queued} waiting`,
  },
  // Said instead of "idle", because it is the more useful half of the same fact: a quiet session
  // whose next message costs a fresh start is worth knowing about, and a quiet session is not.
  {
    named: "cold",
    when: (session) => session.cold,
    say: () => "cold",
  },
  {
    named: "answering",
    when: (session) => session.busy,
    say: () => "answering",
  },
  // Last, and it asks nothing of the row: rest is what is left when none of the others hold. A
  // table whose final entry could fail to match would leave `stateOf` with nothing to return for a
  // row nobody thought of, which is the one way a state could still go unnamed.
  //
  // The wording carries how long it has been idle, from the clock the entry above acts on, so the
  // two are one reading said at two distances rather than two answers to one question. It is said
  // HERE, in the wording of the state, and never as a fact of its own beside the state phrase:
  // every state above this one is a run in flight, and a running session's clock is stale for the
  // whole of its turn — so a duration printed beside the phrase would tell a busy session it had
  // been doing nothing for as long as it had been working. The order of this table is what makes
  // that unreachable, and it costs nothing.
  {
    named: "idle",
    when: () => true,
    say: (session) => idleSaid(session.ran),
  },
]);

// How long a session has been doing nothing, said with the word for doing nothing.
//
// One phrase and not two, for the reason the usage reading is one phrase: there is no way to print
// half of it, and no way for the duration to end up on a row that is not idle.
//
// Nothing rather than a guess when there is no reading. A session with no conversation to carry on
// has never run or has just been handed over, and the row says `nothing to carry on` beside this,
// so the absence is not silent. Inventing "just now" out of it would be the most reassuring
// possible reading of not knowing.
function idleSaid(ran) {
  return typeof ran === "string" ? `idle, last ran ${ago(ran)}` : "idle";
}

function stateOf(session) {
  return STATES.find((state) => state.when(session)).say(session);
}

// How long ago, in the roughest terms that are still useful. Nothing anybody decides from a room
// turns on the difference between four minutes and five.
//
// Exported, because the chat says the same thing to the session that leads, in the block about
// where the account stands, and on a panel when it parks a conversation nobody has carried on —
// and a third copy of this wording is a third place for it to drift. There are already two
// — the page keeps its own, because a page served as text cannot import anything — and that
// duplication is the one this file names at the top and nobody has to add to.
export function ago(when) {
  const seconds = Math.round((Date.now() - Date.parse(when)) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  return `${Math.floor(seconds / 3600)}h ago`;
}
