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

import { readSettings } from "../settings.mjs";
import { BARE_WORD, GIT_SUBCOMMAND, RESERVED, holdersOf, sidesOf } from "../shell.mjs";
import { publish } from "./events.mjs";

// name -> id -> { request, answer, parkedAt, told }
const waiting = new Map();

// name -> id -> { id, kind: "rule", rule, why, from, parkedAt, turn }
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
// the turn that raised it has ended, so the Leader's reply lands on the panel before its dialogs.
// `turn` is the turn the seat is on now, or null: a rule request raised by that very turn is not
// listed yet; one raised earlier stays listed whatever turn runs, since a press on one card is a
// turn of its own and the cards beside it are not to leave and come back for it.
export function parked(name, root, { turn = null } = {}) {
  const stops = [...forSession(name).values()].map(({ request, parkedAt }) => {
    const shape = shapeOf(request, root);
    return { parkedAt, shown: shape === null ? request : { ...request, shape } };
  });
  const asked = [...rulesOf(name).values()]
    .filter((held) => turn === null || held.turn !== turn)
    .map((held) => ({ parkedAt: held.parkedAt, shown: shownRule(held) }));
  return [...stops, ...asked].sort((a, b) => a.parkedAt - b.parkedAt).map(({ shown }) => shown);
}

function shownRule({ id, kind, rule, why, from }) {
  return { id, kind, rule, why, from };
}

// ------------------------------------------------------------------------------- rule requests

// Park one rule request on a seat's panel. The id is the server's, and the answer is a press on
// the page that writes the rule and tells the seat; nothing here waits for it. `turn` is the
// turn that raised it, or null off a turn: parked() keeps it off the panel while that turn runs.
export function parkRule(name, { rule, why, from, turn = null }, now = Date.now()) {
  const id = crypto.randomUUID();
  rulesOf(name).set(id, { id, kind: "rule", rule, why, from, parkedAt: now, turn });
  asking(name);
  return id;
}

// The rule requests on a seat's panel, as the page sees them, oldest first.
export function rulesPending(name) {
  return [...rulesOf(name).values()].sort((a, b) => a.parkedAt - b.parkedAt).map(shownRule);
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

// The rules that would let a call like this one through next time — one or more, since a compound
// command is allowed side by side — or nothing.
//
// Deliberately dull, and it refuses far more often than it guesses. A rule is permanent and it is
// the whole instance's, so one is only ever offered where the request says plainly what the class
// of calls is — and where it does not, the page shows no button rather than a dead one.
//
// Two shapes are composed here, because there are exactly two things this workspace grants wider
// than the call that asked: a COMMAND and a PATH. A session is stopped per command rather than
// per tool, so Bash is where the same question is asked over and over — `ls`, `find` and `cat`
// went through, `rm -f` stopped — and it is stopped per path for the two tools that write one.
// `Read` is never stopped inside the instance (measured: a read under the cwd goes through with
// no rule at all, and the `Read(/**)` the seed grants is that same ground said out loud — a read
// outside it stops whatever rule is held). An MCP tool is granted the moment the chat offers it.
//
// For everything else — a fetch, a search, a read outside the instance, a tool the chat did not
// offer — and for a command nothing above composes for, the rule is the one Claude Code itself
// would save: it says so in the request (`suggested` below), and that rule is held to the same
// checker as one written by hand, so the button never carries what the tool refuses. A write
// nothing above composes for is one outside the instance, and what Claude Code would save for
// that names a place on this machine, which the checker refuses: nothing to fall back on.
export function shapeOf(request, root) {
  if (request.tool === "Bash") {
    const own = typeof request.input?.command === "string" ? rulesForCommand(request.input.command, root) : null;
    return own ?? suggested(request, root);
  }

  // The two that write a file, named one at a time rather than as "anything carrying a path".
  if (request.tool === "Write" || request.tool === "Edit") {
    const rule = subtreeOf(request.input?.file_path, root);
    return rule === null ? null : [rule];
  }

  return suggested(request, root);
}

// The rules Claude Code would write for "don't ask again" on this call. The request carries them
// as `permission_suggestions` (session.mjs hands them over as `suggestions`): one `addRules` entry
// per rule it would save, each a tool name and what goes inside the parentheses — measured on the
// Claude Code the chat starts: `{ toolName: "Bash", ruleContent: "mkdir <the whole command>" }` for
// a command (the exact command, never a prefix), `{ toolName: "WebFetch", ruleContent:
// "domain:example.com" }` for a fetch, `{ toolName: "WebSearch" }` and nothing beside it for a
// search. Beside those it offers a `setMode` and an `addDirectories` for the session, which carry
// no rules and are passed over; and only what it would ALLOW is a button, since a press here is a
// grant. Spelt the way a settings file reads them, once each, and only what `acceptRule` accepts:
// a suggestion the checker refuses shows no button rather than a dead one.
function suggested(request, root) {
  const rules = [];
  for (const suggestion of Array.isArray(request.suggestions) ? request.suggestions : []) {
    if (suggestion?.behavior !== "allow" || !Array.isArray(suggestion.rules)) {
      continue;
    }
    for (const { toolName, ruleContent } of suggestion.rules) {
      const accepted = acceptRule(typeof ruleContent === "string" ? `${toolName}(${ruleContent})` : toolName, root);
      if (accepted !== null && !rules.includes(accepted)) {
        rules.push(accepted);
      }
    }
  }
  return rules.length === 0 ? null : rules;
}

// What a command may be allowed by: one rule per side of it that nothing allows yet.
//
// Claude Code splits a command at the shell's operators and holds every side against the rules
// on its own, so a rule for the first word of `cd app && npm test` allows nothing: `cd` is held
// and `npm` is what stopped. From the docs (Configure permissions, Compound commands): "The
// recognized command separators are `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines. A rule must
// match each subcommand independently." An `&` next to `>` or `<` is a redirection, not a
// separator. A side with nothing in it after `&&`, `||` or a pipe is a command the shell would
// not run and the docs call unparseable — nothing is offered for the whole of it, because no set
// of rules lets it through. After `;`, `&` or a newline an empty side is only the end of the line.
//
// The sides Claude Code runs without asking are not offered either. From the same page,
// Read-only commands: "Claude Code recognizes a built-in set of Bash commands as read-only and runs
// them without a permission prompt in every mode ... The set includes `ls`, `cat`, `echo`, `pwd`,
// `head`, `tail`, `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`, `cd`, and read-only forms
// of `git`." A rule for one of those grants nothing, and a call that stopped on them alone
// stopped for a reason no rule reaches (a glob, a redirect, `cd` beside `git`). The set is the
// docs' list as quoted and no wider: a word the docs do not name is offered even when it might
// be read-only, since a dead button is cheaper than a stop that can never be settled.
//
// Nor are the sides the instance already allows: what is held is read from the settings as they
// are now, a trailing `:*` or ` *` read as the prefix it is and any other rule as the exact
// command it names, by whole words, so `Bash(npm:*)` holds `npm test` and never `npx`.
//
// The first word of a side, and only when it is a bare name. A rule is a literal prefix rather
// than a path or a command line, so a word with a slash, a tilde, a dollar or a quote in it
// would make a rule that matches something other than what the person read on the button. A
// side like that in a compound composes nothing for the whole: a rule set with a hole in it is a
// button that settles nothing. `git` is the one program granted by its subcommand — `git push`
// rather than `git` — the way the instance is born granting it and the way the docs put the
// star: "In `git log --oneline main`, `git` is the program and `log` is the subcommand, the word
// that determines what the program does." A rule for the bare word would let `git push` in
// through `git status`. The subcommand has to be a word; `git -C somewhere push` composes
// nothing, and the persona says to `cd` instead.
//
// A side that starts with one of the shell's reserved words is not a command but a piece of
// one — `for f in a b; do cmp x/$f $f; done` splits into `for f in a b`, `do cmp x/$f $f` and
// `done`, and was measured offered as `Bash(for:*)`, `Bash(do:*)`, `Bash(done:*)`: three rules
// that name no program and would let anything in inside a loop. Nothing is offered for the whole
// of such a command; what the loop does is not parsed.
// The separator, the reserved words and the shapes of a program's name are lib/shell.mjs's, shared
// with the hook that lets a compound of allowed sides through: what reads as a side here reads as
// a side there.
const READ_ONLY = new Set(["ls", "cat", "echo", "pwd", "head", "tail", "grep", "find", "wc", "which", "diff", "stat", "du", "cd"]);

function rulesForCommand(command, root) {
  const held = holdersOf(readSettings(root)?.permissions?.allow);
  const rules = [];
  const sides = sidesOf(command);
  if (sides === null) {
    return null;
  }
  for (const side of sides) {
    const words = side.split(/\s+/);
    const spoken = words.join(" ");
    if (RESERVED.has(words[0]) || !BARE_WORD.test(words[0])) {
      return null;
    }
    if (READ_ONLY.has(words[0])) {
      continue;
    }
    let prefix = words[0];
    if (prefix === "git") {
      if (words.length < 2 || !GIT_SUBCOMMAND.test(words[1])) {
        return null;
      }
      prefix = `git ${words[1]}`;
    }
    if (held.some((holds) => holds(spoken))) {
      continue;
    }
    const rule = `Bash(${prefix}:*)`;
    if (!rules.includes(rule)) {
      rules.push(rule);
    }
  }
  return rules.length === 0 ? null : rules;
}

// The one checker, for both callers: a rule written by hand for the Leader's `permission` tool,
// and a rule Claude Code suggested for a button. Accepted when it is a rule Claude Code reads from
// a settings file, spelt the way its reference spells it; refused when Claude Code would skip it
// or never consult it, or when it names a place on this machine that the instance's own spelling
// reaches. Every shape here is measured against the reference (Configure permissions, Permission
// rule syntax and the tool-specific sections), none is reasoned from the look of the string, and
// the answer is the rule in the one spelling this workspace writes, so that "already held" is a
// string the settings either contain or do not.
//
// `Bash(...)`: a command as a prefix, in either spelling of the trailing star — "The `:*` suffix
// is an equivalent way to write a trailing wildcard, so `Bash(ls:*)` matches the same commands as
// `Bash(ls *)`" — answered as `Bash(word:*)`, the spelling `shapeOf` composes; or a command exactly,
// with no star at all. Claude Code matches the text as written against each side of the command
// once it has split it at the shell's operators and stripped the wrappers it knows, so a program
// by its path, a wrapper it does not strip (`env`, `script`), a new filter in a pipe or a `find`
// with `-exec` each want a rule of their own, and for the last the reference says to "write an
// exact-match rule for the full command string". A star anywhere else stands in for a program or
// a subcommand — `Bash(* --version)` lets any program in, `Bash(git * main)` every subcommand —
// and is refused: what it lets in is not what the person read. `Bash(*)` is `Bash` and is
// answered so.
//
// `Edit(/dir/**)`, `Read(/dir/**)`: a subtree inside the instance, spelt the way `shapeOf` spells
// it — one leading `/`, the anchor at the instance root, then a path `inside` accepts as it is,
// so no `..`, no `./`; `Edit(/**)` and `Read(/**)` are the root. `Read(//dir/**)`: a subtree
// outside the instance by the machine's own path, since a read outside is what a session is
// stopped for that no relative spelling reaches; the same path inside the instance is refused,
// because the instance is meant to be movable and its own spelling is there for it. A write
// outside the instance is not the instance's to settle. A bare `Edit(dir/**)` is refused: it is
// not an older spelling of the same rule but a different rule, one read from wherever the
// session happens to be. A path on `Write`, `Glob`, `NotebookEdit` or `MultiEdit` is refused:
// "Claude Code accepts the rule but never consults it, and warns at startup".
//
// `WebFetch(domain:host)`: a host, `*` alone for every host, `*.` in front for every subdomain,
// `*` for one label between two dots — the wildcards the reference names. `WebSearch`: bare, the
// reference spells nothing narrower. `mcp__server`, `mcp__server__tool`, `mcp__server__*`,
// `mcp__server__get_*`: a server's tools, with a glob only after the server is named in full —
// "Allow rules accept tool-name globs only after a literal `mcp__<server>__` prefix", `mcp__*` is
// "skipped with a warning", and an `mcp__` rule with parentheses is skipped at load. `Agent(Name)`:
// one subagent. A bare tool name: every use of that tool, `WebFetch`, `Agent`, `Bash` included —
// the widest rule there is for it, on the button verbatim, the User's to press.
//
// Refused with the rest: a parameter rule such as `Agent(model:opus)` and a tool-name glob such
// as `*` or `B*`, which the reference gives to deny and ask alone.
const BASH_RULE = /^Bash\(([^\s*]|[^\s*][^\n*]*[^\s*])(:\*| \*)?\)$/;
const SUBTREE_RULE = /^(Edit|Read)\(\/(.+)\/\*\*\)$/;
const ROOT_RULE = "Edit(/**)";
const ROOT_RULES = new Set([ROOT_RULE, "Read(/**)"]);
const OUTSIDE_READ = /^Read\(\/(\/.+)\/\*\*\)$/;
const FETCH_RULE = /^WebFetch\(domain:(?:\*|(?:\*\.)?[A-Za-z0-9-]+(?:\.(?:[A-Za-z0-9-]+|\*))*)\)$/;
const MCP_RULE = /^mcp__[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*(?:__(?:[A-Za-z0-9_-]+\*?|\*))?$/;
const AGENT_RULE = /^Agent\([A-Za-z0-9_-]+\)$/;
const TOOL_RULE = /^[A-Z][A-Za-z]+$/;

export function acceptRule(rule, root) {
  if (typeof rule !== "string") {
    return null;
  }
  if (rule === "Bash(*)") {
    return "Bash";
  }
  const bash = BASH_RULE.exec(rule);
  if (bash !== null) {
    return bash[2] === undefined ? rule : `Bash(${bash[1]}:*)`;
  }
  if (ROOT_RULES.has(rule) || FETCH_RULE.test(rule) || MCP_RULE.test(rule) || AGENT_RULE.test(rule) || TOOL_RULE.test(rule)) {
    return rule;
  }
  const outside = OUTSIDE_READ.exec(rule);
  if (outside !== null) {
    const named = outside[1];
    return path.posix.normalize(named) === named && !named.includes("*") && inside(named, root) === null ? rule : null;
  }
  const subtree = SUBTREE_RULE.exec(rule);
  if (subtree === null) {
    return null;
  }
  return inside(subtree[2], root) === subtree[2] ? rule : null;
}

// What a write may be allowed by: the directory it was in, and never the file itself.
//
// Every part of this is measured against the Claude Code a chat starts, and none of it is reasoned
// from the shape of the string.
//
// `Edit(...)` governs every built-in tool that writes a file, the Write tool included, and a
// `Write(...)` rule matches nothing at all — measured both ways: a deny spelt `Write(...)` let the
// Write tool through, and the same deny spelt `Edit(...)` refused it — so a `Write` request
// composes an `Edit` rule, and a rule naming the tool that asked would look like care and grant
// nothing.
//
// A rule naming a DIRECTORY is honoured as the whole subtree under it, and matching is by path
// segment rather than by string prefix, so `Edit(/projects/Wren/**)` never leaks into `projects/Wrenna/`
// or onto `projects/Wren.md`. A rule naming one FILE is that file and nothing beside it, which is why
// the file is not what is composed: a button settling the call it was pressed for and nothing near it
// would be the `Write(...)` trap in another costume, and the point of the button is that the next
// call like this one does not stop.
//
// Anchored at the instance root with one leading `/`, always. Claude Code reads a path rule three
// ways: a bare `dir/**` from the session's CURRENT directory, `/dir/**` from the directory the
// settings file belongs to — the instance root — and `//dir/**` from the machine's root. The
// session's current directory moves with every `cd` a run makes, so a bare rule that let a write
// through from the root stopped the same write once the run had stepped into a repository under
// `projects/` (measured: one dialog and a press with the bare rule, none with the anchored one,
// and an anchored deny still refusing from the stepped-into directory). The instance is meant to
// be movable, so nothing it holds may name a place on this machine — never the `//` form — and a
// write landing outside the root has no relative form at all: that composes nothing and shows no
// button, the way a command whose first word is not a bare name composes nothing.
//
// It follows that a write at the root itself composes `Edit(/**)`, the widest rule there is, and
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
  // `path.dirname` of a path at the root is `"."`, and it is not spelt into the rule. Before the
  // anchor, `Edit(./**)` was measured honoured, twice, against a no-rule baseline that was refused,
  // so this was never a correctness guard and must not be described as one; the anchored `./`
  // form has not been measured and there is no reason to: a `./` says nothing to a reader and
  // makes the widest rule in the system look like a rule about somewhere in particular.
  //
  // And `/**` rather than the bare directory or `/*`, also honoured identically: a bare trailing
  // `*` crosses `/`, so `Edit(/projects/Wren/*)` invites the person reading the button to see one
  // level where it is a subtree.
  return held === "." ? ROOT_RULE : `Edit(/${held}/**)`;
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

// A decision in the shape the protocol takes. Allowing needs nothing else said, unless the call
// goes ahead with another input — an answered question carries its answers that way; refusing
// must carry a reason, and a refusal that carries none is not read as a refusal at all.
export function allow(updatedInput) {
  return updatedInput === undefined ? { behavior: "allow" } : { behavior: "allow", updatedInput };
}

export function refuse(why) {
  return { behavior: "deny", message: why };
}
