#!/usr/bin/env node

// The office workspace installer.
//
// It turns a command line into one resolved description of an instance — where it lives, who
// works there and on which models — and then creates it. This first cut stops after the
// resolving: it prints the plan and writes nothing, so the arguments can be settled before
// anything touches the disk.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A name becomes a directory under work/ and an address other sessions type, so it stays
// short, starts with a letter and holds nothing a shell or a path would read as syntax.
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

// Model identifiers are aliases or full names, never paths.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const OPTIONS = [
  ["--root", "root", "directory to install the instance into"],
  ["--human", "human", "name of the person the team works for"],
  ["--leader", "leader", "name of the session that leads the team"],
  ["--leader-model", "leaderModel", "model the leader runs on"],
  ["--worker-model", "workerModel", "model hired workers run on"],
];

const REQUIRED = ["root", "human", "leader"];

class UsageError extends Error {}

function usage() {
  return [
    "Install an office workspace instance.",
    "",
    "Usage:",
    "  ./install.sh --root <dir> --human <name> --leader <name>",
    "               [--leader-model <model>] [--worker-model <model>]",
    "",
    "Options:",
    ...OPTIONS.map(([flag, , help]) => `  ${flag.padEnd(16)}${help}`),
    "  --help          show this text",
    "",
    "A model left out is not pinned: those sessions start on whatever model Claude Code is",
    "configured to use.",
  ].join("\n");
}

function parseArguments(argv) {
  const flags = new Map(OPTIONS.map(([flag, key]) => [flag, key]));
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];

    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }

    const key = flags.get(argument);
    if (key === undefined) {
      throw new UsageError(`unknown argument: ${argument}`);
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${argument} needs a value`);
    }
    if (parsed[key] !== undefined) {
      throw new UsageError(`${argument} was given twice`);
    }

    parsed[key] = value;
    i += 1;
  }

  return { help: false, ...parsed };
}

// A path typed as ~/somewhere survives quoting, so expand it ourselves rather than relying on
// the shell having done it.
function expandHome(value) {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolvePlan(parsed) {
  for (const key of REQUIRED) {
    if (parsed[key] === undefined) {
      const flag = OPTIONS.find(([, name]) => name === key)[0];
      throw new UsageError(`${flag} is required`);
    }
  }

  for (const key of ["human", "leader"]) {
    if (!NAME_PATTERN.test(parsed[key])) {
      const flag = OPTIONS.find(([, name]) => name === key)[0];
      throw new UsageError(
        `${flag} must start with a letter and hold only letters, digits, '-' or '_' (got ${JSON.stringify(parsed[key])})`,
      );
    }
  }

  for (const key of ["leaderModel", "workerModel"]) {
    if (parsed[key] !== undefined && !MODEL_PATTERN.test(parsed[key])) {
      const flag = OPTIONS.find(([, name]) => name === key)[0];
      throw new UsageError(`${flag} is not a model identifier (got ${JSON.stringify(parsed[key])})`);
    }
  }

  const root = path.resolve(expandHome(parsed.root));
  if (root === path.parse(root).root || root === os.homedir()) {
    throw new UsageError(`--root ${root} is too broad; give the instance its own directory`);
  }

  return {
    toolkit: TOOLKIT_ROOT,
    root,
    human: parsed.human,
    leader: parsed.leader,
    leaderModel: parsed.leaderModel ?? null,
    workerModel: parsed.workerModel ?? null,
  };
}

function describeModel(model) {
  return model ?? "not pinned, Claude Code decides";
}

function printPlan(plan) {
  const rows = [
    ["toolkit", plan.toolkit],
    ["instance", plan.root],
    ["human", plan.human],
    ["leader", plan.leader],
    ["leader model", describeModel(plan.leaderModel)],
    ["worker model", describeModel(plan.workerModel)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));

  console.log("Planned instance:");
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(width)}  ${value}`);
  }
  console.log("");
  console.log("Nothing was written. This build resolves the arguments and stops there.");
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArguments(argv);
    if (parsed.help) {
      console.log(usage());
      return 0;
    }
    printPlan(resolvePlan(parsed));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`install: ${error.message}`);
      console.error("");
      console.error(usage());
      return 2;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
