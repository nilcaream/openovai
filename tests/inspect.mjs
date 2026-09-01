// Reading an installed instance and saying what is wrong with it.
//
// Written as functions over the files rather than as assertions in one suite, because the
// interesting part of some of these is what is NOT there — a permission rule that reaches
// wider than one file passes any check that only looks for the file's name in the text. Each
// one answers with a list of problems, empty when there are none.

import fs from "node:fs";

// Does ow.json describe the instance that was asked for?
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
// for their own desk, and the one rule that lets a session say something to another?
export function settingsProblems(file, names) {
  const expected = [
    ...names.map((name) => `Edit(work/${name}/STATE.md)`),
    "Bash(bin/ow say:*)",
    "Bash(./bin/ow say:*)",
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

  // One rule per desk, the one that lets a session speak to another, and nothing else. Anything
  // wider is a grant nobody asked for.
  const wider = allow.filter((rule) => !expected.includes(rule));
  if (wider.length > 0) {
    wrong.push(`rules beyond the desks of ${names.join(", ")} and saying something: ${JSON.stringify(wider)}`);
  }

  return wrong;
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
