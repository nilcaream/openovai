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

export function inTurn(name, answer) {
  const waiting = queues.get(name) ?? Promise.resolve();
  const mine = waiting.then(answer, answer);

  // What the next turn waits for is that this one ENDED, never how it went: a turn that failed
  // must not take the session down with it, and a rejection nobody is left to catch would.
  queues.set(
    name,
    mine.then(
      () => {},
      () => {},
    ),
  );

  return mine;
}
