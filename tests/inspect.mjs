// Reading an installed instance and saying what is wrong with it.
//
// Written as functions over the files rather than as assertions in one suite, because the
// interesting part of some of these is what is NOT there — a permission rule that reaches
// wider than one file passes any check that only looks for the file's name in the text. Each
// one answers with a list of problems, empty when there are none.

import fs from "node:fs";
import path from "node:path";

// The workspace's own account of every rule it holds beyond a desk and the tools the chat serves.
export const LEDGER = "allowed.md";

// Does openovai.json describe the instance that was asked for?
export function configProblems(file, expected) {
  const text = fs.readFileSync(file, "utf8");
  const config = JSON.parse(text);
  const wrong = [];

  if (config.user !== expected.user) {
    wrong.push(`user is ${config.user}, expected ${expected.user}`);
  }
  if (config.leader !== expected.leader) {
    wrong.push(`leader is ${config.leader}, expected ${expected.leader}`);
  }
  if (config.models.leader !== expected.leaderModel) {
    wrong.push(`leader model is ${config.models.leader}, expected ${expected.leaderModel}`);
  }
  if (config.models.worker !== expected.workerModel) {
    wrong.push(`worker model is ${config.models.worker}, expected ${expected.workerModel}`);
  }
  if (config.port !== Number(expected.port)) {
    wrong.push(`port is ${config.port}, expected ${expected.port}`);
  }
  if (config.auth !== expected.auth) {
    wrong.push(`auth is ${config.auth}, expected ${expected.auth}`);
  }
  if (typeof config.schema !== "number") {
    wrong.push("there is no schema number");
  }
  // An instance that records a path stops working the moment somebody moves it.
  if (text.includes("/")) {
    wrong.push("it holds a path");
  }

  return wrong;
}

// Does the instance grant exactly what working there takes and nothing wider: the one rule that
// lets a session call the tools the chat serves it, the one that lets it read any file here, the
// edit and write rules for the three trees the User works in — reference/, projects/, temp/ — and,
// per person, the edit and write rules for their own desk directory.
//
// Eight for everybody and one pair per person. The list being exact in both directions is what
// says that retiring a desk withdrew its pair with it, that no tree beyond the three was quietly
// opened, and that no desk was opened without its pair.
export const STANDING = [
  "mcp__openovai",
  "Read(**)",
  "Edit(reference/**)",
  "Write(reference/**)",
  "Edit(projects/**)",
  "Write(projects/**)",
  "Edit(temp/**)",
  "Write(temp/**)",
];

// The pair a desk is granted, the same spelling desks.mjs grants: spelled here rather than
// imported, because a check that read the list it is checking would agree with itself the day
// somebody widened it.
export function deskPair(name) {
  return [`Edit(desks/${name}/**)`, `Write(desks/${name}/**)`];
}

// Who has a desk, read from the instance the settings file sits in: the settings are
// `<root>/.claude/settings.json`, and the desks are the listing of `<root>/desks/`.
function desksBeside(file) {
  try {
    return fs
      .readdirSync(path.join(path.dirname(path.dirname(file)), "desks"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function settingsProblems(file) {
  const desks = desksBeside(file);
  const expected = [...STANDING, ...desks.flatMap(deskPair)];

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return [`cannot read ${file}: ${error.message}`];
  }

  const allow = settings?.permissions?.allow;
  if (!Array.isArray(allow)) {
    return ["permissions.allow is missing"];
  }

  const wrong = [];
  const missing = expected.filter((rule) => !allow.includes(rule));
  if (missing.length > 0) {
    wrong.push(`no rule ${missing.join(", ")}; found ${JSON.stringify(allow)}`);
  }

  // The instance is meant to be movable, so nothing in here may name a place on this machine.
  const absolute = allow.filter((rule) => rule.includes("(//") || rule.includes("(/") || rule.includes("(~"));
  if (absolute.length > 0) {
    wrong.push(`rules anchored outside the instance: ${JSON.stringify(absolute)}`);
  }

  // One rule per desk, the one that lets a session speak to another, and anything a person asked
  // for in writing. A rule is granted for a reason, and the reason outlives the moment somebody
  // pressed a button: a workspace that cannot say who asked for a rule ends up holding a pid that
  // died a week ago, a delete for a directory that is gone, and two rules that were the first
  // words of a sentence somebody was typing. Measured, in the workspace this toolkit came out of:
  // twenty-six rules, every one a press, not one of them accounted for.
  const accounted = ledger(file);
  const inList = (list) => accounted.filter((entry) => entry.list === list).map((entry) => entry.rule);
  const wider = allow.filter((rule) => !expected.includes(rule) && !inList("allow").includes(rule));
  if (wider.length > 0) {
    wrong.push(`rules nothing accounts for, beyond the standing eight and a pair per desk: ${JSON.stringify(wider)}`);
  }

  // And the other direction, which is the half a ledger is usually missing. A line for a rule that
  // is not held is not harmless bookkeeping: it is the file saying this workspace settled
  // something it did not, which is worse than saying nothing, because it is read as an answer. A
  // rule settled twice has two lines, and the last one is the one the settings hold.
  const latest = new Map(accounted.map((entry) => [entry.rule, entry.list]));
  const claimed = [...latest.entries()]
    .filter(([rule, list]) => !(Array.isArray(settings?.permissions?.[list]) ? settings.permissions[list] : []).includes(rule))
    .map(([rule]) => rule);
  if (claimed.length > 0) {
    wrong.push(`accounted for but not held: ${JSON.stringify(claimed)}`);
  }

  return wrong;
}

// What the workspace has written down about the rules it holds beyond the two it hands out by
// itself. One file beside the settings, one line per rule, the rule in backticks first on the
// line and the list it landed in after it — a person reads it top to bottom and can see who
// asked for what and when. A line naming no list is one an older instance wrote, and it is an
// allow.
//
// It lives beside the settings rather than inside them, because `.claude/settings.json` has a
// shape Claude Code owns and a key of ours in it is a key we would be guessing about. A workspace
// that has never granted anything wider has no file, which is not a problem: nothing to account
// for is the state a fresh instance is in.
function ledger(settings) {
  let lines;
  try {
    lines = fs.readFileSync(path.join(path.dirname(settings), LEDGER), "utf8").split("\n");
  } catch {
    return [];
  }

  return lines
    .filter((line) => line.startsWith("- `") && line.indexOf("`", 3) > 3)
    .map((line) => {
      const close = line.indexOf("`", 3);
      const list = /^ \((allow|deny|ask)\)/.exec(line.slice(close + 1));
      return { rule: line.slice(3, close), list: list === null ? "allow" : list[1] };
    });
}

// Is the instance's own directory recorded as trusted in the Claude Code state file inside its
// home? Without this, Claude Code ignores the settings the instance ships with and says so only
// on a line of stderr, so a check that did not look here would not notice it happening.
export function trustProblems(file, root) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return [`${file} could not be read: ${error.message}`];
  }

  if (state?.projects?.[root]?.hasTrustDialogAccepted !== true) {
    return [`${root} is not recorded as trusted in ${file}`];
  }

  return [];
}
