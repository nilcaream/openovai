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
