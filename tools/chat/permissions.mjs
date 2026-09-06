// What a session is waiting to be allowed to do.
//
// A run that has been given a way to ask stops when it wants to use a tool the instance does not
// already allow, and says so rather than being refused on the spot. The request is parked here
// until somebody answers it on the page; the run waits for exactly as long as that takes, because
// nothing on that path times out. That is the whole point: the answer is a person's, and a person
// is not a deadline.
//
// Parked in memory and nowhere else. A request belongs to a run that is currently open, so a chat
// that is restarted has nothing left to answer — the runs it was serving are gone with it.
//
// One session can have more than one waiting at a time: a turn is free to reach for two tools at
// once, and a store that held only the newest would leave the first one waiting for good.

// name -> id -> { request, answer }
const waiting = new Map();

function forSession(name) {
  const held = waiting.get(name);
  if (held !== undefined) {
    return held;
  }
  const made = new Map();
  waiting.set(name, made);
  return made;
}

// Park a request and hand back the promise the run waits on. What is given to whoever asks is
// what a person needs to decide: which tool, and what it was going to be given.
export function park(name, request) {
  return new Promise((answer) => {
    forSession(name).set(request.id, { request, answer });
  });
}

// What this session is waiting on, oldest first, so a page can show them in the order they were
// asked rather than in whatever order a map happens to keep.
export function parked(name) {
  return [...forSession(name).values()].map(({ request }) => {
    const shape = shapeOf(request);
    return shape === null ? request : { ...request, shape };
  });
}

// One of them, as it was parked. What answers a request has to be composed from what was asked
// rather than from what the page says it was asked: the page is a caller like any other, and a
// rule granted from a string somebody posted is a rule nobody read.
export function askedFor(name, id) {
  return forSession(name).get(id)?.request;
}

// The shape of a rule that would let a call like this one through next time, or nothing.
//
// Deliberately dull, and it refuses far more often than it guesses. A rule is permanent and it is
// the whole instance's, so one is only ever offered where the request says plainly what the class
// of calls is — and where it does not, the page shows no button rather than a dead one.
//
// Bash, and nothing else, which is what the measurement leaves standing. A session is stopped per
// COMMAND rather than per tool, so Bash is where the same question is asked over and over: `ls`,
// `find` and `cat` went through, `rm -f` stopped. The tools a name-only rule would have been for
// are not there to grant — `Glob` and `Grep` do not exist in the harness at all, and a session
// asking for either is told so; `Read` is never stopped, so a rule for it would be a grant nobody
// was ever asked for. `Edit` and `Write` name a path, which is a different decision from allowing
// a call and the one opening a desk already makes. An MCP tool is granted the moment the chat
// offers it, and a rule can name a server and a tool, never an argument.
//
// The first word of the command only, and only when it is a bare name. A rule is a literal prefix
// rather than a path or a command line, so a word with a slash, a tilde, a dollar or a quote in it
// would make a rule that matches something other than what the person read on the button.
export function shapeOf(request) {
  if (request.tool !== "Bash" || typeof request.input?.command !== "string") {
    return null;
  }

  const [word] = request.input.command.trim().split(/\s+/);
  return /^[A-Za-z0-9_.-]+$/.test(word ?? "") ? `Bash(${word}:*)` : null;
}

// Every session with something parked, and what. `parked` above answers for one session a page is
// showing; this answers for all of them, which is what a census asking what the chat has not
// finished needs.
//
// Asking about a session is enough to give it an empty entry here, and those are handed back as
// they are rather than filtered out. What reads this counts the requests it is given, so a session
// waiting for nothing contributes nothing either way, and a rule here would be a second place
// deciding what an empty one means.
export function requestsUnderway() {
  return [...waiting.entries()].map(([name, held]) => [name, [...held.values()].map(({ request }) => request)]);
}

// Answer one. The id has to match something still waiting: a page that was showing a stale
// request, or two people answering the same one, must not resolve a request twice — the second
// answer would be for a tool use that has already gone ahead.
export function answer(name, id, decision) {
  const held = forSession(name).get(id);
  if (held === undefined) {
    return false;
  }
  forSession(name).delete(id);
  held.answer(decision);
  return true;
}

// Everything this session was waiting on, given up. Called when a run ends: whatever it was
// asking about, it is not there to hear the answer any more, and a page still offering to allow
// something that nobody is waiting for is a page that lies.
export function giveUp(name) {
  for (const [id, held] of forSession(name)) {
    forSession(name).delete(id);
    held.answer(refuse("the run that asked this is no longer waiting for an answer"));
  }
}

// A decision in the shape the protocol takes. Allowing needs nothing else said; refusing must
// carry a reason, and a refusal that carries none is not read as a refusal at all.
export function allow() {
  return { behavior: "allow" };
}

export function refuse(why) {
  return { behavior: "deny", message: why };
}
