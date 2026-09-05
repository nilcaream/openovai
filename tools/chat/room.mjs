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

// One line each, names lined up. The width is the room's rather than each row's, which is the
// whole reason this is not a map over `describeSession` at the call site.
export function roomLines(sessions) {
  const width = Math.max(...sessions.map((session) => session.name.length));

  return sessions.map((session) => `${session.name.padEnd(width)}  ${describeSession(session)}`);
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

function stateOf(session) {
  if (session.asking > 0) {
    return session.asking === 1 ? "needs you" : `needs you (${session.asking})`;
  }
  if (session.waitingFor !== null && session.waitingFor !== undefined) {
    return `waiting for ${session.waitingFor}`;
  }
  if (session.queued > 0) {
    return `answering, ${session.queued} waiting`;
  }
  // Said instead of "idle", because it is the more useful half of the same fact: a quiet session
  // whose next message costs a fresh start is worth knowing about, and a quiet session is not.
  if (session.cold) {
    return "cold";
  }
  return session.busy ? "answering" : "idle";
}

// How long ago, in the roughest terms that are still useful. Nothing anybody decides from a room
// turns on the difference between four minutes and five.
function ago(when) {
  const seconds = Math.round((Date.now() - Date.parse(when)) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  return `${Math.floor(seconds / 3600)}h ago`;
}
