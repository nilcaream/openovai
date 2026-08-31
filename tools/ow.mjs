#!/usr/bin/env node

// The instance's own command. bin/ow works out which instance it belongs to and passes it in
// with --root, so nothing here has to guess where it is running.

import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE = "ow.json";

class UsageError extends Error {}

function usage() {
  return [
    "The command of an office workspace instance.",
    "",
    "Usage:",
    "  ow status    show who works in this instance and on which models",
    "",
  ].join("\n");
}

function readRoot(argv) {
  const at = argv.indexOf("--root");
  if (at === -1 || argv[at + 1] === undefined) {
    throw new UsageError("--root is missing; run this instance's bin/ow rather than the tool directly");
  }
  return { root: argv[at + 1], rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

function readConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new UsageError(`${file} is missing; this directory is not an instance`);
    }
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${file} is not readable as JSON: ${error.message}`);
  }
}

function desks(root) {
  const work = path.join(root, "work");
  try {
    return fs
      .readdirSync(work, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function status(root) {
  const config = readConfig(root);
  const rows = [
    ["instance", root],
    ["human", config.human],
    ["leader", `${config.leader} (${config.models.leader})`],
    ["worker model", config.models.worker],
    ["chat port", config.port],
    ["installed", config.createdAt],
    ["desks", desks(root).join(", ") || "none"],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));

  for (const [label, value] of rows) {
    console.log(`${label.padEnd(width)}  ${value}`);
  }
}

function main(argv) {
  try {
    const { root, rest } = readRoot(argv);
    const command = rest[0] ?? "status";

    if (command === "--help" || command === "-h" || command === "help") {
      console.log(usage());
      return 0;
    }
    if (command !== "status") {
      throw new UsageError(`unknown command: ${command}`);
    }
    if (rest.length > 1) {
      throw new UsageError(`status takes no arguments (got ${rest.slice(1).join(" ")})`);
    }

    status(root);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`ow: ${error.message}`);
      console.error("");
      console.error(usage());
      return 2;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
