#!/usr/bin/env node

// The office workspace installer.
//
// It turns a command line into one resolved description of an instance — where it lives, who
// works there and on which models — and then creates it. So far it creates the directories an
// instance is made of; the configuration, the desks and the launcher follow.

import fs from "node:fs";
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

const SWITCHES = [["--force", "force", "install into a directory that is not empty"]];

const REQUIRED = ["root", "human", "leader"];

// The directories an instance is made of, relative to its root.
//
//   work/          one directory per person, holding the state a replacement session reads
//   .claude/       settings that belong to the instance and can be shared
//   .claude-home/  the instance's own Claude Code home: its account, transcripts and memory,
//                  kept apart so two instances on one machine never share a session history
const LAYOUT = ["work", ".claude", ".claude-home"];

// The instance's own description of itself. It is deliberately free of absolute paths — not
// where it came from, not even its own root, which anything running inside works out from
// where it sits — so that an instance can be moved or copied and still be itself.
const CONFIG_FILE = "ow.json";

// Bumped when a field changes meaning, so an older instance can be recognised as one.
const CONFIG_SCHEMA = 1;

// A desk is a person: one directory, holding the one file a replacement session reads before
// it does anything else.
const DESK_TEMPLATE = path.join("templates", "STATE.md");
const DESK_FILE = "STATE.md";

// A bad command line: the person can fix it and try again, so we show them the usage.
class UsageError extends Error {}

// A refusal to act on the machine as it is. Nothing to do with the arguments, so printing the
// usage under it would only be noise.
class InstallError extends Error {}

function usage() {
  return [
    "Install an office workspace instance.",
    "",
    "Usage:",
    "  ./install.sh --root <dir> --human <name> --leader <name>",
    "               [--leader-model <model>] [--worker-model <model>]",
    "",
    "Options:",
    ...[...OPTIONS, ...SWITCHES].map(([flag, , help]) => `  ${flag.padEnd(16)}${help}`),
    "  --help          show this text",
    "",
    "A model left out is not pinned: those sessions start on whatever model Claude Code is",
    "configured to use.",
  ].join("\n");
}

function parseArguments(argv) {
  const flags = new Map(OPTIONS.map(([flag, key]) => [flag, key]));
  const switches = new Map(SWITCHES.map(([flag, key]) => [flag, key]));
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];

    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }

    const flag = switches.get(argument);
    if (flag !== undefined) {
      parsed[flag] = true;
      continue;
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
    force: parsed.force === true,
  };
}

// Refuse to move into an occupied directory unless we are told to. An instance root is going
// to collect desks and a Claude Code home, and dropping that on top of somebody else's files
// is the kind of surprise that is hard to undo.
function checkRoot(plan) {
  let entries;
  try {
    entries = fs.readdirSync(plan.root);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    if (error.code === "ENOTDIR") {
      throw new InstallError(`${plan.root} is a file, not a directory`);
    }
    throw error;
  }

  if (entries.length > 0 && !plan.force) {
    throw new InstallError(
      `${plan.root} is not empty. Give an empty or new directory, or pass --force to install into this one anyway.`,
    );
  }
}

function createLayout(plan) {
  const created = [];

  for (const directory of ["", ...LAYOUT]) {
    const target = path.join(plan.root, directory);
    if (!fs.existsSync(target)) {
      created.push(target);
    }
    fs.mkdirSync(target, { recursive: true });
  }

  return created;
}

function writeConfig(plan) {
  const config = {
    schema: CONFIG_SCHEMA,
    createdAt: new Date().toISOString(),
    human: plan.human,
    leader: plan.leader,
    models: {
      leader: plan.leaderModel,
      worker: plan.workerModel,
    },
  };

  const target = path.join(plan.root, CONFIG_FILE);
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return [target];
}

// Placeholders are {{NAME}}. Anything left unfilled is a mistake in the template rather than
// something to paper over, so say so instead of shipping the braces to a desk.
function render(template, values) {
  const filled = template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.hasOwn(values, key) ? values[key] : match,
  );

  const missing = filled.match(/\{\{\w+\}\}/g);
  if (missing !== null) {
    throw new InstallError(`the desk template has placeholders nothing fills: ${[...new Set(missing)].join(", ")}`);
  }

  return filled;
}

function createDesk(plan, name) {
  const source = path.join(TOOLKIT_ROOT, DESK_TEMPLATE);
  let template;
  try {
    template = fs.readFileSync(source, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new InstallError(`the desk template is missing at ${source}`);
    }
    throw error;
  }

  const directory = path.join(plan.root, "work", name);
  const target = path.join(directory, DESK_FILE);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(target, render(template, { NAME: name, DATE: today() }));
  return [target];
}

function today() {
  return new Date().toISOString().slice(0, 10);
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
}

function report(created) {
  if (created.length === 0) {
    console.log("Everything was already in place; nothing to write.");
  } else {
    console.log("Wrote:");
    for (const entry of created) {
      console.log(`  ${entry}`);
    }
  }
  console.log("");
  console.log("The leader has a desk. The launcher comes next.");
}

function main(argv) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      console.log(usage());
      return 0;
    }

    const plan = resolvePlan(parsed);
    printPlan(plan);
    checkRoot(plan);
    report([...createLayout(plan), ...writeConfig(plan), ...createDesk(plan, plan.leader)]);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`install: ${error.message}`);
      console.error("");
      console.error(usage());
      return 2;
    }
    if (error instanceof InstallError) {
      console.error(`install: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
