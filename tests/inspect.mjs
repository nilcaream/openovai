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

  if (config.human !== expected.human) {
    wrong.push(`human is ${config.human}, expected ${expected.human}`);
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

// Does the instance grant exactly what working there takes and nothing wider: one rule per person
// for their own desk, and the one rule that lets a session call the tools the chat serves it.
//
// Two per person and one for everybody, and it used to be two per person and six for everybody:
// every command a persona named needed both of its spellings granted. The list being exact in both
// directions is what says that retiring a command retired its rule with it.
export function settingsProblems(file, names) {
  const expected = [
    ...names.map((name) => `Edit(work/${name}/STATE.md)`),
    "mcp__openovai",
  ];

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
  const wider = allow.filter((rule) => !expected.includes(rule) && !accounted.includes(rule));
  if (wider.length > 0) {
    wrong.push(`rules nothing accounts for, beyond the desks of ${names.join(", ")} and saying something: ${JSON.stringify(wider)}`);
  }

  // And the other direction, which is the half a ledger is usually missing. A line for a rule that
  // is not granted is not harmless bookkeeping: it is the file saying this workspace allows
  // something it does not, which is worse than saying nothing, because it is read as an answer.
  const claimed = accounted.filter((rule) => !allow.includes(rule));
  if (claimed.length > 0) {
    wrong.push(`accounted for but not granted: ${JSON.stringify(claimed)}`);
  }

  return wrong;
}

// What the workspace has written down about the rules it holds beyond the two it hands out by
// itself. One file beside the settings, one line per rule, the rule in backticks first on the
// line — a person reads it top to bottom and can see who asked for what and when.
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
    .map((line) => line.slice(3, line.indexOf("`", 3)));
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
