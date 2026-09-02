#!/usr/bin/env node

// The office workspace installer.
//
// It turns a command line into one resolved description of an instance — where it lives, who
// works there and on which models — and then creates it. So far it creates the directories an
// instance is made of; the configuration, the desks and the launcher follow.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MEMORY_FILE, memoryDirectory } from "./claude.mjs";
import { PAYLOAD, notAWorkspace } from "./payload.mjs";
import {
  DeskError,
  allowDesk,
  allowRoom,
  allowStatus,
  allowTools,
  describeName,
  isName,
  readTemplate,
  writeDesk,
  writePersona,
} from "./desks.mjs";

// Ports below 1024 need privileges nobody should be granting a workspace.
const LOWEST_PORT = 1024;
const HIGHEST_PORT = 65535;

// Except zero, which is not a port but a request: bind whatever is free. Picking a number by
// hand means remembering which ones are taken, and being wrong about it only shows up as a
// refusal to start. It has to be typed like any other value — there is still no default.
const PORT_CHOSEN_AT_START = 0;

// Model identifiers are aliases or full names, never paths.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// How an instance gets an account.
//
//   login    it signs itself in, once, with `ow login`, and keeps the credential in its own
//            Claude Code home. Two instances can be signed in as two different people.
//   inherit  it takes CLAUDE_CODE_OAUTH_TOKEN from the environment it is started in, so one
//            token minted on the machine signs every instance in and starting one needs no
//            browser. Instances still keep their own transcripts and memory.
const AUTH_MODES = ["inherit", "login"];

const OPTIONS = [
  ["--root", "root", "directory to install the instance into"],
  ["--source", "source", "directory to install from: a clone, or an unpacked release"],
  ["--human", "human", "name of the person the team works for"],
  ["--leader", "leader", "name of the session that leads the team"],
  ["--leader-model", "leaderModel", "model the leader runs on"],
  ["--worker-model", "workerModel", "model hired workers run on"],
  ["--port", "port", "port the chat page listens on, or 0 to have one picked at start"],
  ["--auth", "auth", `how the instance signs in: ${AUTH_MODES.join(" or ")}`],
];

const SWITCHES = [["--force", "force", "install into a directory that is not empty"]];

// Every option is required. The installer never prompts and never guesses: a command line
// that describes the whole instance is one that can be read back, repeated and tested.
const REQUIRED = OPTIONS.map(([, key]) => key);

// The directories an instance is made of, relative to its root.
//
//   work/          one directory per person, holding the state a replacement session reads
//   personas/      one file per session, saying who it is, with the names written into it
//   .claude/       settings that belong to the instance and can be shared
//   .claude-home/  the instance's own Claude Code home: its account, transcripts and memory,
//                  kept apart so two instances on one machine never share a session history
//
// None of these is in the payload. What the toolkit ships and what an instance accumulates are
// different things and stay in different directories, so that replacing the one never reaches
// into the other.
const LAYOUT = ["work", "personas", ".claude", ".claude-home"];

// The instance's own description of itself. It is deliberately free of absolute paths — not
// where it came from, not even its own root, which anything running inside works out from
// where it sits — so that an instance can be moved or copied and still be itself.
const CONFIG_FILE = "ow.json";

// Bumped when a field changes meaning, so an older instance can be recognised as one.
const CONFIG_SCHEMA = 1;

// The lead's persona, before the names are written into it. What becomes of it — where it is
// written and why the names are welded in rather than looked up — is in tools/desks.mjs, which
// every session's persona goes through.
const LEADER_TEMPLATE = path.join("templates", "leader.md");

// The index of what the workspace knows, before anybody has put anything in it. An instance is
// given one rather than left to grow one, because a session asked to remember something and
// finding nothing there writes whatever shape occurs to it, and every session after that reads
// that shape as the workspace's own. What the index says about what belongs in it is the only
// steering there is.
const MEMORY_TEMPLATE = path.join("templates", "MEMORY.md");

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
    "  ./install.sh --root <dir> --source <dir> --human <name> --leader <name>",
    "               --leader-model <model> --worker-model <model> --port <number|0>",
    `               --auth <${AUTH_MODES.join("|")}>`,
    "",
    "Every option is required. Nothing is prompted for and nothing is guessed.",
    "",
    "Options:",
    ...[...OPTIONS, ...SWITCHES].map(([flag, , help]) => `  ${flag.padEnd(16)}${help}`),
    "  --help          show this text",
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
    if (!isName(parsed[key])) {
      const flag = OPTIONS.find(([, name]) => name === key)[0];
      throw new UsageError(describeName(flag, parsed[key]));
    }
  }

  for (const key of ["leaderModel", "workerModel"]) {
    if (!MODEL_PATTERN.test(parsed[key])) {
      const flag = OPTIONS.find(([, name]) => name === key)[0];
      throw new UsageError(`${flag} is not a model identifier (got ${JSON.stringify(parsed[key])})`);
    }
  }

  if (!AUTH_MODES.includes(parsed.auth)) {
    throw new UsageError(
      `--auth must be ${AUTH_MODES.join(" or ")} (got ${JSON.stringify(parsed.auth)})`,
    );
  }

  // Digits and nothing else, because Number() is too willing: it reads "" as 0 and "0x10" as
  // 16, and neither is something anybody meant to type.
  const port = /^\d+$/.test(parsed.port) ? Number(parsed.port) : Number.NaN;
  const usable =
    Number.isInteger(port) &&
    (port === PORT_CHOSEN_AT_START || (port >= LOWEST_PORT && port <= HIGHEST_PORT));
  if (!usable) {
    throw new UsageError(
      `--port must be ${PORT_CHOSEN_AT_START}, or a whole number between ${LOWEST_PORT} and ${HIGHEST_PORT} (got ${JSON.stringify(parsed.port)})`,
    );
  }

  const source = path.resolve(expandHome(parsed.source));
  const root = path.resolve(expandHome(parsed.root));
  if (root === path.parse(root).root || root === os.homedir()) {
    throw new UsageError(`--root ${root} is too broad; give the instance its own directory`);
  }

  if (root === source) {
    throw new UsageError("--root and --source are the same directory");
  }

  return {
    source,
    root,
    human: parsed.human,
    leader: parsed.leader,
    leaderModel: parsed.leaderModel,
    workerModel: parsed.workerModel,
    port,
    auth: parsed.auth,
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

// Everything the installer reads comes from the source, so that installing from a clone and
// installing from an unpacked release are one code path rather than two. What makes a directory
// one is asked of tools/payload.mjs, because taking a newer version asks the same question of the
// package it downloaded and the two must not be able to drift apart.
function checkSource(plan) {
  const wrong = notAWorkspace(plan.source);
  if (wrong !== null) {
    throw new InstallError(wrong);
  }
}

function copyPayload(plan) {
  const copied = [];

  for (const entry of PAYLOAD) {
    const target = path.join(plan.root, entry);
    fs.cpSync(path.join(plan.source, entry), target, { recursive: true });
    copied.push(target);
  }

  return copied;
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
    port: plan.port,
    auth: plan.auth,
  };

  const target = path.join(plan.root, CONFIG_FILE);
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return [target];
}

// The index goes where the sessions read it — inside the instance's own Claude Code home, under
// the name tools/claude.mjs pins — rather than anywhere of the installer's choosing. One answer to
// where an instance's memory is, and the installer asks for it rather than spelling it again.
function writeMemoryIndex(plan) {
  const target = path.join(memoryDirectory(plan.root), MEMORY_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, readTemplate(plan.source, "memory", MEMORY_TEMPLATE));
  return [target];
}

function printPlan(plan) {
  const rows = [
    ["source", plan.source],
    ["instance", plan.root],
    ["human", plan.human],
    ["leader", plan.leader],
    ["leader model", plan.leaderModel],
    ["worker model", plan.workerModel],
    ["chat port", plan.port === PORT_CHOSEN_AT_START ? "0 — picked when the chat starts" : String(plan.port)],
    ["signs in by", plan.auth],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));

  console.log("Planned instance:");
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(width)}  ${value}`);
  }
  console.log("");
}

function report(plan, written) {
  // Named once each. Two things an instance needs can land in the same file — the lead's desk
  // rule and the rule that lets a session speak to another both go into the settings — and a
  // list that says so twice reads as though something had been written over.
  const created = [...new Set(written)];

  if (created.length === 0) {
    console.log("Everything was already in place; nothing to write.");
  } else {
    console.log("Wrote:");
    for (const entry of created) {
      console.log(`  ${entry}`);
    }
  }
  const ow = path.join(plan.root, "bin", "ow");
  console.log("");
  console.log("Start it with:");
  if (plan.auth === "login") {
    console.log(`  ${ow} login`);
  }
  console.log(`  ${ow} chat`);
  if (plan.auth === "inherit") {
    console.log("");
    console.log("It signs in with CLAUDE_CODE_OAUTH_TOKEN from the environment you start it in.");
    console.log("Mint one once with: claude setup-token");
  }
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
    checkSource(plan);
    checkRoot(plan);
    report(plan, [
      ...createLayout(plan),
      ...copyPayload(plan),
      ...writeConfig(plan),
      ...writeMemoryIndex(plan),
      ...writeDesk(plan.root, plan.source, plan.leader),
      ...writePersona(plan.root, plan.source, plan.leader, "leader", LEADER_TEMPLATE, {
        LEADER: plan.leader,
        HUMAN: plan.human,
      }),
      ...allowDesk(plan.root, plan.leader),
      ...allowTools(plan.root),
      ...allowStatus(plan.root),
      ...allowRoom(plan.root),
    ]);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`install: ${error.message}`);
      console.error("");
      console.error(usage());
      return 2;
    }
    if (error instanceof InstallError || error instanceof DeskError) {
      console.error(`install: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
