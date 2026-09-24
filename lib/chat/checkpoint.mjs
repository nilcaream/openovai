// A Worker's checkpoint: the number of tool calls after which it reports, set by the Leader on the
// message that orders the work, and counted here rather than by the Worker, which cannot count its
// own calls.
//
// One checkpoint per Worker, in memory. A new one replaces whatever was pending, and a message
// that sets none leaves it alone. It is reached once, and then it is gone: a checkpoint asks for a
// report and never stops anything, so there is nothing to do at the next call. It outlives a
// restart, since the successor is on the same order, and goes with the Worker's process otherwise.
//
// What is counted is what the server sees: every call the Worker's own process makes, its own
// write_desk and message included. A subagent's calls are not among them (session.mjs), so a
// checkpoint is for Workers and never for an agent a seat starts itself.

const pending = new Map();

export function set(seat, calls) {
  pending.set(seat, { calls, count: 0 });
}

export function clear(seat) {
  pending.delete(seat);
}

// One call by `seat`, counted: the checkpoint's number when this call reaches it, else null.
export function counted(seat) {
  const checkpoint = pending.get(seat);
  if (checkpoint === undefined) {
    return null;
  }
  checkpoint.count += 1;
  if (checkpoint.count < checkpoint.calls) {
    return null;
  }
  pending.delete(seat);
  return checkpoint.calls;
}
