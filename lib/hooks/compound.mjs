// A compound command whose every side the instance already allows runs without a stop.
//
// Claude Code matches a Bash rule against a command from its first character, so a seat whose
// settings hold `git`, `cd` and `npm` is still stopped on `cd projects/x && npm test`: no one rule
// holds the whole. The card offers one rule per side and gives up at a loop (lib/chat/permissions.mjs);
// this runs before the question is asked at all. Wired as a PreToolUse hook on Bash (lib/seed.mjs), it
// reads the command, cuts it into sides the way the card does, and if every side is a command the
// instance's own `permissions.allow` holds, and no side is one its `permissions.deny` refuses, it
// answers `allow`. Anything else it answers nothing — exit 0, empty stdout — and the harness asks as
// it always did. Deny rules stay the rules' job, and the harness evaluates them whatever a hook says.
//
// It answers `deny`, with a reason, in two cases. A command that hides a program (below), and that
// the hook would allow were each hidden span a side of its own: the harness stops such a line on a
// card even when its program is allowed — a grep whose double-quoted pattern holds a backtick is
// the common one — and the User is asked about a slip of spelling. And a line that is more than one
// plain command, with a side no rule holds: its card asks the User about the shape of a line a
// script would run without one. A subagent a session starts is given none of the instance's rules
// but runs under this hook all the same, so the reason is where it learns how to spell the step.
// Refused, the session reads the reason as the call's result and spells the step again, as a
// pattern file or a script, with no card. A refusal lets nothing run; a line with a side the rules
// refuse, or one this cannot read, is never refused toward a script — the harness asks.
//
// Convenience over strictness, but never wider than the rules: what the hook lets through is what a
// rule in the file already lets through on its own, one side at a time. One list, read from the
// settings on every call, so a rule the User settles later is honoured at the next command, and a
// rule they take out stops counting.
//
// The command is read as text: no quoting rules, no expansion. Where reading it as text could hide a
// program — a substitution, a here-document, a quote that is not closed — nothing is allowed, which
// is the safe way round: a stop the harness would have raised anyway, or the refusal above.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readSettings } from "../settings.mjs";
import { BARE_WORD, GIT_SUBCOMMAND, RESERVED, holdersOf, sidesOf } from "../shell.mjs";

// Where the settings are read from: the instance this file is installed in, worked out from where it
// sits (lib/hooks/ under the root), never from where the session is standing.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// What the settings hold as the hook's own command. `${CLAUDE_PROJECT_DIR}` is the harness's name
// for the directory a session was started in — the instance root — resolved when the hook runs, so
// the settings file keeps no absolute path in it (lib/settings.mjs).
export const HOOK_COMMAND = 'node "${CLAUDE_PROJECT_DIR}/lib/hooks/compound.mjs"';

// The entry the settings carry, whole, and the test that says whether they carry it.
export const HOOK_ENTRY = { matcher: "Bash", hooks: [{ type: "command", command: HOOK_COMMAND }] };
export function hookWired(settings) {
  const entries = settings?.hooks?.PreToolUse;
  return Array.isArray(entries) && entries.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((hook) => hook?.command === HOOK_COMMAND));
}

// Text that hides a program from a reader that does not expand: a command substitution either
// way, a process substitution, a here-document. Not judged; nothing answered. (A quote left open
// is `sidesOf`'s to refuse.)
const HIDDEN = /\$\(|`|<<|<\(|>\(/;
const HIDDEN_EVERY = new RegExp(HIDDEN.source, "g");

// What the session reads when such a line is refused. The harness puts "PreToolUse:Bash hook
// error: " in front of it (measured on 2.1.280).
export const HIDDEN_REASON = "not run: a backtick, $(, <( or << reads as a program hidden inside the line, even within double quotes, and would stop on a card. Put a pattern that holds one in a file and pass it with grep -f, or write the steps in a script on your desk and run it with node or bash.";
export const COMPOUND_REASON = "not run: this line is more than one plain command (a pipe, &&, ;, a loop, $( or a here-document) and would stop on a card. Create the script with the Write tool, in temp/ or on your desk, then run only `bash <file>` as its own Bash call. Read a file's lines with Read, not sed or cat.";

// A word that is a redirection, alone (`>`, `2>`, `&>`, `>>`, `<`, `2>&1`) or with its target
// attached (`>out`, `2>/dev/null`); a lone one takes the next word as its target.
const REDIRECTION = /^(\d*|&)(>>|>|<)(&\d*|&-|)(\S*)$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// The reserved words a command may open with and still be that command: `! cmd`, `{ cmd`,
// `do cmd`, `then cmd`, `else cmd`, and the loop and branch heads `while cmd`, `until cmd`,
// `if cmd`, `elif cmd`. A `for x in a b` head and a closing `done`, `fi`, `}` run nothing.
const OPENERS = new Set(["!", "{", "do", "then", "else", "while", "until", "if", "elif"]);
const CLOSERS = new Set(["done", "fi", "}", "{"]);

// The words of one side that name a program and its arguments: openers taken off the front and
// redirections out of the middle. Empty when the side runs nothing;
// null when it opens with something this does not read (`case`, `function`, `time`, `[[`, …).
function programOf(side) {
  let words = side.split(/\s+/);
  while (words.length > 0 && OPENERS.has(words[0])) {
    words = words.slice(1);
  }
  if (words.length === 0) {
    return [];
  }
  if (words[0] === "for") {
    return words.length >= 3 && BARE_WORD.test(words[1]) && words[2] === "in" ? [] : null;
  }
  if (words.length === 1 && CLOSERS.has(words[0])) {
    return [];
  }
  // An assignment in front changes what the program is (`PATH=`, `LD_PRELOAD=`), and one alone
  // changes it for the sides after; no rule holds either, so neither is read.
  if (RESERVED.has(words[0]) || ASSIGNMENT.test(words[0])) {
    return null;
  }
  const kept = [];
  for (let at = 0; at < words.length; at += 1) {
    const found = REDIRECTION.exec(words[at]);
    if (found === null) {
      kept.push(words[at]);
    } else if (found[4] === "" && found[3] === "") {
      at += 1;
    }
  }
  return kept;
}

// A side whose program a rule holds by its first word, but which the harness's own rule reader
// does not: `find` running or deleting what it finds is not held by `Bash(find:*)` there
// (a rule for the program is not a rule for what -exec hands it), so it is not held here.
const FIND_ACTS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete"]);

// The decision for one command against one settings object: "allow"; "hidden" or "compound", each
// a refusal with its own reason; or null for no answer. A line that hides a program is judged with
// each hidden mark read as a separator, so what sits inside a substitution is a side of its own.
// A side the rules refuse, or one this does not read, leaves the line to the harness, whatever
// the other sides are: the refusal's reason sends the session to a script, and a script is no
// place to send what a rule refuses or what could not be read.
export function decide(command, settings) {
  if (typeof command !== "string") {
    return null;
  }
  const hidden = HIDDEN.test(command);
  const sides = sidesOf(hidden ? command.replace(HIDDEN_EVERY, " ; ") : command);
  if (sides === null || sides.length === 0) {
    return null;
  }
  const allowed = holdersOf(settings?.permissions?.allow);
  const refused = holdersOf(settings?.permissions?.deny);
  const verdicts = sides.map((side) => verdictOf(side, allowed, refused));
  if (verdicts.includes("unread")) {
    return null;
  }
  if (!verdicts.includes("unheld")) {
    return hidden ? "hidden" : "allow";
  }
  return hidden || !plain(sides) ? "compound" : null;
}

// One side against the rules: "held" when a rule allows it or it runs nothing, "unheld" when it is
// a program no rule names, "unread" when a rule refuses it or this cannot tell what it runs.
function verdictOf(side, allowed, refused) {
  const words = programOf(side);
  if (words === null) {
    return "unread";
  }
  if (words.length === 0) {
    return "held";
  }
  if (!BARE_WORD.test(words[0])) {
    return "unread";
  }
  if (words[0] === "git" && (words.length < 2 || !GIT_SUBCOMMAND.test(words[1]))) {
    return "unread";
  }
  if (words[0] === "find" && words.some((word) => FIND_ACTS.has(word))) {
    return "unread";
  }
  const spoken = words.join(" ");
  if (refused.some((holds) => holds(spoken))) {
    return "unread";
  }
  return allowed.some((holds) => holds(spoken)) ? "held" : "unheld";
}

// One plain command: a single side that opens with its program, not with a negation or a loop or
// branch head. Such a line that no rule holds is the User's to answer, on the card; anything more
// is the session's to write as a script.
function plain(sides) {
  const first = sides.length === 1 ? sides[0].split(/\s+/)[0] : "";
  return sides.length === 1 && first !== "for" && !OPENERS.has(first);
}

// What the harness reads back: the decision in the shape PreToolUse takes, or nothing.
const ANSWERS = {
  allow: ["allow", "every side of the command is one this instance allows"],
  hidden: ["deny", HIDDEN_REASON],
  compound: ["deny", COMPOUND_REASON],
};
export function answerFor(input, settings) {
  const decision = input?.tool_name === "Bash" ? decide(input.tool_input?.command, settings) : null;
  if (decision === null) {
    return "";
  }
  const [permissionDecision, permissionDecisionReason] = ANSWERS[decision];
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
    },
  });
}

// Run as the hook: the call on stdin, the answer on stdout, exit 0 either way. Input that is not
// the call's JSON is no call to answer.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = null;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    input = null;
  }
  process.stdout.write(answerFor(input, readSettings(ROOT)));
}
