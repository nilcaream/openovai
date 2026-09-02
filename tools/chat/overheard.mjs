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
// In memory rather than on disk, deliberately: this is what a session has not heard YET, and a
// chat that is stopped and started again has no session waiting to be told. The panel keeps the
// record; this keeps only the debt.

const pending = new Map();

// Something was said that this session should know about. Kept as the text it will be handed, so
// that what a line looks like is decided in one place — here it is only a queue.
export function overhear(name, line) {
  pending.set(name, [...(pending.get(name) ?? []), line]);
}

// Everything this session is owed, and it is no longer owed it. Drained rather than read, and
// drained when a turn BEGINS, so a line that arrived while the session was queued goes with that
// turn rather than the one after it.
//
// Nothing is dropped and there is no cap. A cap would be a guess at a case nobody has seen; the
// day a session is measured struggling under what it was told is the day one gets added, with
// that case named.
export function carry(name) {
  const lines = pending.get(name) ?? [];
  pending.delete(name);
  return lines;
}
