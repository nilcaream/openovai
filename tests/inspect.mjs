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

// Does the instance grant its leader exactly the one thing it needs: the right to keep its own
// desk, and nothing wider?
export function settingsProblems(file, leader) {
  const expected = `Edit(work/${leader}/STATE.md)`;

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
  if (!allow.includes(expected)) {
    wrong.push(`no rule ${expected}; found ${JSON.stringify(allow)}`);
  }

  // The instance is meant to be movable, so nothing in here may name a place on this machine.
  const absolute = allow.filter((rule) => rule.includes("(//") || rule.includes("(/") || rule.includes("(~"));
  if (absolute.length > 0) {
    wrong.push(`rules anchored outside the instance: ${JSON.stringify(absolute)}`);
  }

  // One rule, one file. Anything wider is a grant nobody asked for.
  const wider = allow.filter((rule) => rule !== expected);
  if (wider.length > 0) {
    wrong.push(`rules beyond the leader's desk: ${JSON.stringify(wider)}`);
  }

  return wrong;
}
