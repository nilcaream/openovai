// What a session has been told about but has not run since.
//
// A line on the lead's panel is what a PERSON reads; it is not what the lead's model hears. The
// panel is `chat/<Name>/conversation.json` and the model's context is the Claude Code thread the
// next run resumes by id, and nothing writes into that thread except a run. There is also no way
// to give a session something without asking it a question — a child takes one question, answers
// it and exits — and starting a run just to deliver a line is the nested turn this whole feature
// exists to remove.
//
// So what was overheard waits here until the session runs for its own reasons, and rides in front
// of whatever it is asked next.
//
// THE PROPERTY THIS KEEPS: a debt is cleared only once the run that carried it answered. A turn is
// not a delivery — a run can be turned away by the service or fall over before it has heard
// anything — so the two halves are separate calls, and what is owed stays owed until something
// says it was heard.
//
// In memory rather than on disk, deliberately: this is what a session has not heard YET, and a
// chat that is stopped and started again has no session waiting to be told. The panel keeps the
// record; this keeps only the debt.

const pending = new Map();

// Something was said that this session should know about. Kept as the text it will be handed, so
// that what a line looks like is decided in one place — here it is only a queue.
export function overhear(name, line) {
  pending.set(name, [...(pending.get(name) ?? []), line]);
}

// Everything this session is owed, READ AND NOT CLEARED. Read when a turn BEGINS, so a line that
// arrived while the session was queued rides with that turn rather than the one after it.
//
// A copy, so that what a caller is holding is what it carried and cannot be moved under it by
// anything said while its run was going.
export function owed(name) {
  return [...(pending.get(name) ?? [])];
}

// It has been heard, and this session is no longer owed it.
//
// Exactly the lines that were carried, and not everything waiting. A line that arrived WHILE the
// run was going has been heard by nobody, and emptying the queue here would drop it without a
// trace. The queue is appended to at one end and a session takes one turn at a time, so what was
// carried is what is at the front: dropping that many drops exactly those and leaves the rest
// where they are.
//
// Nothing is dropped and there is no cap. A cap would be a guess at a case nobody has seen; the
// day a session is measured struggling under what it was told is the day one gets added, with
// that case named.
export function heard(name, lines) {
  const left = (pending.get(name) ?? []).slice(lines.length);
  if (left.length === 0) {
    pending.delete(name);
    return;
  }
  pending.set(name, left);
}
