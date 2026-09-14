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
//
// A second kind of question is parked beside those: a RULE REQUEST, the Leader asking the User to
// settle one rule for the whole instance through the `permission` tool. Nothing waits on one — the
// tool answers at once and the press reaches the Leader as an event — so it holds no promise; it
// is listed on the Leader's panel with the call stops, and answered from the same route.

import crypto from "node:crypto";
import path from "node:path";

import { publish } from "./events.mjs";

// name -> id -> { request, answer, parkedAt, told }
const waiting = new Map();

// name -> id -> { id, kind: "rule", rule, why, from, parkedAt, popped }
const rules = new Map();

function forSession(name) {
  const held = waiting.get(name);
  if (held !== undefined) {
    return held;
  }
  const made = new Map();
  waiting.set(name, made);
  return made;
}

function rulesOf(name) {
  const held = rules.get(name);
  if (held !== undefined) {
    return held;
  }
  const made = new Map();
  rules.set(name, made);
  return made;
}

// Park a request and hand back the promise the run waits on. What is given to whoever asks is
// what a person needs to decide: which tool, and what it was going to be given. `now` is the
// server's clock: the wait below is measured from it.
export function park(name, request, now = Date.now()) {
  return new Promise((answer) => {
    forSession(name).set(request.id, { request, answer, parkedAt: now, told: false });
    asking(name);
  });
}

// The page is told that what this seat asks has changed — a question parked, or one taken down
// — and reads the list itself: what the list shows depends on the seat's turn and the instance,
// which are the server's to know.
function asking(name) {
  publish("asking", { seat: name });
}

// What this session's panel shows, oldest first, so a page can show them in the order they were
// asked rather than in whatever order a map happens to keep: the call stops, each with the rule
// the server would offer when it composed one, and the rule requests — a rule request only once
// the turn that raised it has ended (`onTurn` false), so the Leader's reply lands on the panel
// before its dialogs.
export function parked(name, root, { onTurn = false } = {}) {
  const stops = [...forSession(name).values()].map(({ request, parkedAt }) => {
    const shape = shapeOf(request, root);
    return { parkedAt, shown: shape === null ? request : { ...request, shape } };
  });
  const asked = onTurn ? [] : [...rulesOf(name).values()].map((held) => ({ parkedAt: held.parkedAt, shown: shownRule(held) }));
  return [...stops, ...asked].sort((a, b) => a.parkedAt - b.parkedAt).map(({ shown }) => shown);
}

function shownRule({ id, kind, rule, why, from }) {
  return { id, kind, rule, why, from };
}

// ------------------------------------------------------------------------------- rule requests

// Park one rule request on a seat's panel. The id is the server's, and the answer is a press on
// the page that writes the rule and tells the seat; nothing here waits for it.
export function parkRule(name, { rule, why, from }, now = Date.now()) {
  const id = crypto.randomUUID();
  rulesOf(name).set(id, { id, kind: "rule", rule, why, from, parkedAt: now, popped: false });
  asking(name);
  return id;
}

// The rule requests on a seat's panel, as the page sees them, oldest first.
export function rulesPending(name) {
  return [...rulesOf(name).values()].sort((a, b) => a.parkedAt - b.parkedAt).map(shownRule);
}

// The rule requests on a seat's panel that the desktop has not been told about, marked told.
// Read once the turn that raised them has ended: the pop goes with the listing, never before it.
export function rulesToPop(name) {
  const fresh = [...rulesOf(name).values()].filter((held) => !held.popped);
  for (const held of fresh) {
    held.popped = true;
  }
  return fresh.map(shownRule);
}

// One rule request, as parked, or nothing.
export function ruleAskedFor(name, id) {
  const held = rulesOf(name).get(id);
  return held === undefined ? undefined : shownRule(held);
}

// Take one down: the User has pressed, and what the press does is the caller's.
export function answerRule(name, id) {
  const taken = rulesOf(name).delete(id);
  if (taken) {
    asking(name);
  }
  return taken;
}

// ------------------------------------------------------------------------------- the long wait

// Every call stop, on any seat, that has waited at least `minutes` and has not been reported
// yet: marked told and answered as { seat, request }, once each. A stop is inside a turn, so no
// idle clock ever sees it; this is its own clock, from the park time.
export function waitedLong(now, minutes) {
  const found = [];
  for (const [name, held] of waiting) {
    for (const entry of held.values()) {
      if (!entry.told && now - entry.parkedAt >= minutes * 60_000) {
        entry.told = true;
        found.push({ seat: name, request: entry.request });
      }
    }
  }
  return found;
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
// Two shapes, because there are exactly two things this workspace can grant: a COMMAND and a PATH.
// A session is stopped per command rather than per tool, so Bash is where the same question is
// asked over and over — `ls`, `find` and `cat` went through, `rm -f` stopped — and it is stopped
// per path for the two tools that write one. The tools a name-only rule would have been for are
// not there to grant: `Glob` and `Grep` do not exist in the harness at all, and a session asking
// for either is told so; `Read` is never stopped inside the instance (measured: a read under
// the cwd goes through with no rule at all, and the `Read(**)` the seed grants is that same
// ground said out loud — a read outside it stops whatever rule is held), so a rule for it would
// be a grant nobody was ever asked for. An MCP tool is granted the moment the chat offers it, and
// a rule can name a server and a tool, never an argument.
//
// The first word of the command only, and only when it is a bare name. A rule is a literal prefix
// rather than a path or a command line, so a word with a slash, a tilde, a dollar or a quote in it
// would make a rule that matches something other than what the person read on the button.
export function shapeOf(request, root) {
  if (request.tool === "Bash") {
    if (typeof request.input?.command !== "string") {
      return null;
    }
    const [word] = request.input.command.trim().split(/\s+/);
    return /^[A-Za-z0-9_.-]+$/.test(word ?? "") ? `Bash(${word}:*)` : null;
  }

  // The two that write a file, named one at a time rather than as "anything carrying a path". A
  // tool this does not know is one whose input nobody here has read, and a rule composed out of an
  // unread input is a press into the dark.
  if (request.tool === "Write" || request.tool === "Edit") {
    return subtreeOf(request.input?.file_path, root);
  }

  return null;
}

// The inverse of `shapeOf`: a rule written by hand, accepted when it is one of the two shapes
// this workspace grants and refused otherwise. The Leader's `permission` tool asks through this,
// so what a person can be asked to settle is exactly what an Always button could have offered —
// one checker, two callers, and a rule nobody here has measured is not asked.
//
// `Bash(word:*)`: a first word that is a bare name, then any number of further words — a rule is
// a literal prefix, so `Bash(git push:*)` is honoured as "git push" and whatever follows — and the
// prefix star. `Edit(dir/**)`: a directory inside the instance, spelt the way `shapeOf` spells it,
// so no absolute path, no `..`, no leading `./`; and `Edit(**)`, the root, which `shapeOf` composes
// for a write there.
const BASH_RULE = /^Bash\(([A-Za-z0-9_.-]+(?: [A-Za-z0-9_.=-]+)*):\*\)$/;
const EDIT_RULE = /^Edit\((.+)\/\*\*\)$/;

export function acceptRule(rule, root) {
  if (typeof rule !== "string") {
    return null;
  }
  if (BASH_RULE.test(rule) || rule === "Edit(**)") {
    return rule;
  }
  const edit = EDIT_RULE.exec(rule);
  if (edit === null) {
    return null;
  }
  const named = inside(edit[1], root);
  return named === edit[1] ? rule : null;
}

// What a write may be allowed by: the directory it was in, and never the file itself.
//
// Every part of this is measured against the Claude Code a chat starts, and none of it is reasoned
// from the shape of the string.
//
// `Edit(...)` governs every built-in tool that writes a file, the Write tool included, and a
// `Write(...)` rule matches nothing at all — so a `Write` request composes an `Edit` rule, and a
// rule naming the tool that asked would look like care and grant nothing.
//
// A rule naming a DIRECTORY is honoured as the whole subtree under it, and matching is by path
// segment rather than by string prefix, so `Edit(projects/Wren/**)` never leaks into `projects/Wrenna/` or
// onto `projects/Wren.md`. A rule naming one FILE is that file and nothing beside it, which is why the
// file is not what is composed: a button settling the call it was pressed for and nothing near it
// would be the `Write(...)` trap in another costume, and the point of the button is that the next
// call like this one does not stop.
//
// Relative to the instance root, always. The instance is meant to be movable, so nothing it holds
// may name a place on this machine, and a write landing outside the root has no relative form at
// all: that composes nothing and shows no button, the way a command whose first word is not a bare
// name composes nothing.
//
// It follows that a write at the root itself composes `Edit(**)`, the widest rule there is, and
// that is deliberate rather than an oversight. Nothing composes it except a write somebody asked
// for at that path; the button carries it verbatim; and the press writes a line naming who asked
// and what for. A floor here would hide the one grant most worth reading behind a rule nobody can
// see, which is less honest rather than safer.
function subtreeOf(where, root) {
  const named = inside(where, root);
  if (named === null) {
    return null;
  }

  const held = path.posix.dirname(named);
  // Both of these are spelling, and spelling is the whole of what a person judges: the rule on the
  // button is what they read, and every alternative here was measured to grant exactly the same
  // thing.
  //
  // `path.dirname` of a path at the root is `"."`. `Edit(./**)` is honoured — measured, twice, in
  // separate runs, against a no-rule baseline that was refused — so this is not a correctness
  // guard and must not be described as one. It is that a leading `./` says nothing to a reader and
  // makes the widest rule in the system look like a rule about somewhere in particular.
  //
  // And `/**` rather than the bare directory or `/*`, also honoured identically: a bare trailing
  // `*` crosses `/`, so `Edit(projects/Wren/*)` invites the person reading the button to see one level
  // where it is a subtree.
  const subtree = held === "." ? "**" : `${held}/**`;
  return `Edit(${subtree})`;
}

// Where a path a request named lands inside the instance, in the instance's own terms, or nothing
// at all when it lands outside it.
//
// One place, because two things need the same answer and a workspace where they disagreed would be
// granting a rule in one vocabulary and accounting for it in another: the rule composed for a
// write, and the line written down beside it saying what that rule was granted for.
export function inside(where, root) {
  if (typeof where !== "string" || where.trim() === "" || typeof root !== "string") {
    return null;
  }

  const named = path.relative(root, path.resolve(root, where)).split(path.sep).join("/");
  return named === "" || named === ".." || named.startsWith("../") || path.isAbsolute(named) ? null : named;
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

// The rule requests every seat has up, for the same census.
export function rulesUnderway() {
  return [...rules.entries()].map(([name, held]) => [name, [...held.values()].map(shownRule)]);
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
  asking(name);
  return true;
}

// Everything this session was waiting on, given up. Called when a run ends: whatever it was
// asking about, it is not there to hear the answer any more, and a page still offering to allow
// something that nobody is waiting for is a page that lies.
export function giveUp(name) {
  const asked = forSession(name).size > 0;
  for (const [id, held] of forSession(name)) {
    forSession(name).delete(id);
    held.answer(refuse("the run that asked this is no longer waiting for an answer"));
  }
  if (asked) {
    asking(name);
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
