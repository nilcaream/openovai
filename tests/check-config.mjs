#!/usr/bin/env node

// Read an instance's ow.json and say whether it describes the instance that was asked for.
// Called by tests/install.sh with the file and the expected values.

import fs from "node:fs";

const [file, human, leader, leaderModel, workerModel] = process.argv.slice(2);

const text = fs.readFileSync(file, "utf8");
const config = JSON.parse(text);

const wrong = [];
if (config.human !== human) {
  wrong.push(`human is ${config.human}, expected ${human}`);
}
if (config.leader !== leader) {
  wrong.push(`leader is ${config.leader}, expected ${leader}`);
}
if (config.models.leader !== leaderModel) {
  wrong.push(`leader model is ${config.models.leader}, expected ${leaderModel}`);
}
if (config.models.worker !== workerModel) {
  wrong.push(`worker model is ${config.models.worker}, expected ${workerModel}`);
}
if (typeof config.schema !== "number") {
  wrong.push("there is no schema number");
}
// An instance that records a path stops working the moment somebody moves it.
if (text.includes("/")) {
  wrong.push("it holds a path");
}

if (wrong.length > 0) {
  console.error(wrong.join("; "));
  process.exit(1);
}
