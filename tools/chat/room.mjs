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
    session.thread ? null : "nothing to carry on",
    typeof session.context === "number" ? `${session.context.toLocaleString("en-US")} tokens` : null,
    session.active === null ? "nothing said yet" : `last moved ${ago(session.active)}`,
  ].filter((part) => part !== null);

  return `${session.role} (${session.model})  ${doing}  —  ${said.join(" · ")}`;
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
