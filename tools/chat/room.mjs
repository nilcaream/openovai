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
export function roomLines(sessions, offline = false) {
  const width = Math.max(...sessions.map((session) => session.name.length));
  const lines = sessions.map((session) => `${session.name.padEnd(width)}  ${describeSession(session)}`);

  return offline ? [OFF, ...lines] : lines;
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
// Exported, because the chat says the same thing to the session that leads when it tells it who has
// stopped, and a third copy of this wording is a third place for it to drift. There are already two
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
