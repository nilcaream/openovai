// One session answers one message at a time.
//
// Without this a second message arriving mid-run starts a second Claude Code child for the same
// session, and both carry `--resume` with the same thread id. Measured: two overlapping children,
// and a transcript that reads question, question, answer, answer, in which nothing says which
// answer belongs to which question. It takes no exotic sequence — the human typing on a worker's
// panel while the lead is calling that worker does it.
//
// A turn waits for the turn before it, so messages are answered in the order they arrived. Each
// session has its own queue: one busy session never holds up another, which is the whole point of
// a page with more than one panel on it.
//
// The queue is what owns a session, and running a Claude Code child is what a turn happens to do
// today. When a session becomes one long-lived child fed on its stdin, this is still the thing
// that decides what reaches it and when.

import { OFFLINE, offline } from "./offline.mjs";

// Keyed by name alone, because one of these serves one instance: the process running it is that
// instance's chat. One entry per session that has ever spoken, so it is bounded by the desks.
const queues = new Map();

// How many turns each session has going: the one being answered, plus any waiting behind it. A
// session with anything in here is one the page should say is busy — from the panel's side there
// is no difference between a message being answered and a message waiting its turn, and both mean
// the same thing to whoever is looking at it: not yet.
//
// Counted rather than flagged, because a queued turn and the turn ahead of it both end, and a
// flag cleared by the first would say idle while the second was still running.
const going = new Map();

// Who each session's turn is currently waiting for an answer FROM. One session at a time can be
// waiting, because a session runs one turn at a time, which is what makes this a map and not a
// list — and what makes the chain below a walk rather than a search.
const waitingOn = new Map();

// Would waiting for this session mean waiting for ourselves?
//
// The lead's turn asks a worker something; the worker's turn, before answering, says something
// back to the lead. The lead cannot take it, because the lead is holding its own turn open until
// the worker answers — and the worker cannot answer until the lead takes it. Nothing here times
// out, so that is not a slow answer, it is both sessions stopped for good and a page nobody can
// use until the chat is killed.
//
// It is not an exotic sequence: a lead asking a worker anything while a worker is told to speak up
// is enough. So rather than joining the queue and hoping, a message that would close a circle is
// answered at once with what to do instead.
export function wouldWaitForItself(sender, addressee) {
  let ahead = addressee;

  // The chain is at most one link per session, and a session appears in it once, so this ends.
  for (let step = 0; step <= waitingOn.size; step += 1) {
    if (ahead === sender) {
      return true;
    }
    const next = waitingOn.get(ahead);
    if (next === undefined) {
      return false;
    }
    ahead = next;
  }

  return false;
}

// Note that a session is waiting for another to answer, for as long as it is. The caller says who
// it is; a message nobody signed is the human's, and the human is not a session that can be waited
// for, so nothing is recorded for one.
//
// That last guard has no behaviour anybody can observe — measured, by taking it out: the map is
// keyed by whoever is waiting, so an unsigned message would put a null key in and take it out
// again, and no reader is any the wiser. It is kept because a map of session names should not
// quietly hold something that is not one, and it is written down here so that nobody spends
// another mutation finding out it changes nothing.
export async function whileWaitingFor(sender, addressee, wait) {
  if (sender === null) {
    return wait();
  }

  waitingOn.set(sender, addressee);
  try {
    return await wait();
  } finally {
    waitingOn.delete(sender);
  }
}

// How many turns this session has going: the one being answered, plus any waiting behind it.
// Counted from the moment a message is taken rather than from the moment a run starts, so a page
// asking a fraction of a second after somebody typed is told the truth.
//
// The COUNT is what leaves here, not a yes or no. A panel only wants to know whether it is its
// turn yet, but somebody deciding whom to talk to wants to know how deep the pile is, and a
// boolean cannot be turned back into that. Both readings are worked out from this one number, so
// there is nothing that can disagree with itself.
export function turnsGoing(name) {
  return going.get(name) ?? 0;
}

// Who this session's turn is waiting for an answer from, or nobody. The map is written while a
// session waits and cleared when it stops waiting, so this is the whole of it — and because a
// session runs one turn at a time, there is at most one answer.
export function waitingFor(name) {
  return waitingOn.get(name) ?? null;
}

// Every session with a turn going, and how many each has. Answered as counts rather than as names
// because two turns on one session are two things the chat has not finished, and the second one is
// the one that has been waiting longest.
//
// Nothing is filtered out. A session that has finished everything is already gone from here — the
// count comes down on the handler below and the entry is deleted when it reaches zero, never left
// sitting at zero — so a rule here about zeros would be a second place saying it, and the two would
// only ever disagree by one of them being wrong.
export function turnsUnderway() {
  return [...going.entries()];
}

// Every session whose turn is waiting on an answer from another. Names only: who it is waiting for
// is `waitingFor` above, and a census asking what is unfinished is asking whose turn is held, not
// by whom.
export function callsUnderway() {
  return [...waitingOn.keys()];
}

// THE ONE PLACE ANYTHING IS STARTED, and therefore the one place anything is stopped from starting.
//
// A room that is off starts nothing. That is asked HERE and nowhere else, because everything that
// runs Claude Code runs it inside one of these — a message, a handover and a leave are all turns —
// and a question asked at three call sites is a question a fourth call site can be written without.
// The comment at the top of this file already claimed this role for the queue; this is it being
// taken.
//
// It is asked BEFORE the queue, not inside it. A turn that joined the queue and then declined would
// leave the room filling up with things nobody is going to answer, and a panel would say it was
// answering while nothing was: the count is not raised, nothing is chained, and what the chat is
// holding stays exactly what it would be with nobody talking.
//
// `answer` is never called. That is the whole promise — not that the run is short, not that it is
// cheap, but that it does not happen — and it is what makes taking the room off worth the press: the
// run this saves is a cold one, and a cold one costs the whole of a conversation again at write
// price.
//
// Nothing already going is touched. A turn that was underway when the room went off runs to its end
// and answers in its own words; only the NEXT one is refused. Stopping work in flight would be a
// second thing this press does, and a press that does two things is a press that can half happen.
//
// WHY THIS IS ALLOWED TO DECLINE, when the delivery path is written never to. That rule exists so
// that a session cannot be made unreachable by the state it is in: a message refused for the
// addressee's own state leaves nobody able to tell it to stop being that way. This state is not the
// addressee's. It belongs to the room, it was set by the person reading it, and the press that
// clears it runs nothing and reaches nobody — so there is no session that has to be reachable for
// the room to come back.
export function inTurn(name, answer) {
  if (offline()) {
    return Promise.resolve(OFFLINE);
  }

  const waiting = queues.get(name) ?? Promise.resolve();
  const mine = waiting.then(answer, answer);

  going.set(name, (going.get(name) ?? 0) + 1);
  const over = () => {
    const left = going.get(name) - 1;
    if (left === 0) {
      going.delete(name);
    } else {
      going.set(name, left);
    }
  };

  // What the next turn waits for is that this one ENDED, never how it went: a turn that failed
  // must not take the session down with it, and a rejection nobody is left to catch would. The
  // count comes down here, on the same handler, so it comes down exactly once either way.
  queues.set(name, mine.then(over, over));

  return mine;
}
