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

export function inTurn(name, answer) {
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
