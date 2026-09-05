// What the chat has started and not finished, and what will end each one.
//
// The chat holds four kinds of thing in memory while it works, in three modules that each own
// their own store, and until now there was no way to ask what was in them. That is fine while
// everything ends; it is the reason a session stuck in a state nobody named is hard to see. A
// person watching a panel can tell that nothing is coming back, and nothing anywhere says what the
// chat is still holding on that session's behalf or what would let it go.
//
// So this reads the three stores and answers a flat list, one entry per thing: which kind it is,
// whose it is, and the sentence saying what ends it. Flat rather than grouped by session, because
// the question it answers is "what is the chat still holding", and grouping would put an empty
// answer and a busy one into different shapes.
//
// It is a reading and never a gate. Nothing in the chat asks this before deciding anything, and
// nothing should: the moment a census decides something, every future kind has to be added here
// before the thing it names can work, and a census that can break the chat is worse than no census.
//
// Not named `holding`. The chat already uses that word for the messages a panel holds back while
// somebody is writing, and two meanings for one word in one process is how the next person reads
// the wrong one.
import { requestsUnderway } from "./permissions.mjs";
import { runsUnderway } from "./session.mjs";
import { callsUnderway, turnsUnderway } from "./turns.mjs";

// Every kind, and what ends it. This is the only place the kinds are named, and each sentence is
// the exit for that kind rather than a description of it — a kind whose exit cannot be written in
// one line is a kind that does not have one, which is the thing worth finding out.
//
// Frozen because it is the list a check compares what it observed against. Two sources that can
// disagree are the point: the kinds come from here, the observations come from real rows off real
// scenarios, and a fifth kind added here without a scenario that reaches it is exactly what should
// go red.
const ENDS = Object.freeze({
  run: "the run answering, failing, or somebody ending it",
  turn: "its answer reaching the panel it was sent from",
  request: "somebody answering it, or the run that asked it going",
  call: "the session it is waiting on answering",
});

export const KINDS = Object.freeze(Object.keys(ENDS));

// One entry per thing, not per session. A session answering one message with another queued behind
// it is holding two turns, and a census that said "one session is busy" would be hiding the second
// — which is the one that has been waiting longest.
export function unfinished() {
  const found = [];

  for (const name of runsUnderway()) {
    found.push({ kind: "run", name, endedBy: ENDS.run });
  }

  for (const [name, count] of turnsUnderway()) {
    for (let each = 0; each < count; each += 1) {
      found.push({ kind: "turn", name, endedBy: ENDS.turn });
    }
  }

  for (const [name, requests] of requestsUnderway()) {
    for (let each = 0; each < requests.length; each += 1) {
      found.push({ kind: "request", name, endedBy: ENDS.request });
    }
  }

  for (const name of callsUnderway()) {
    found.push({ kind: "call", name, endedBy: ENDS.call });
  }

  return found;
}
