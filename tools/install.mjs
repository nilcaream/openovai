#!/usr/bin/env node

// The OpenOv AI installer.
//
// It turns a command line into one resolved description of an instance — where it lives, who
// works there and on which models — and then creates it, in the two acts an instance is made by:
// the payload is put in place (tools/release.mjs, the same act an update does) and the person's
// own files are seeded where they are absent (tools/seed.mjs, the same act an update does). An
// install over an existing instance is therefore an update of it, and neither ever writes over
// anything the person has.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DeskError, describeModel, describeName, isModel, isName, writePersona } from "./desks.mjs";
import { notAWorkspace } from "./payload.mjs";
import { PLUGINS } from "./plugins.mjs";
import { ReleaseError, replacePayload } from "./release.mjs";
import { CONFIG_FILE, seedUserContent } from "./seed.mjs";

// Ports below 1024 need privileges nobody should be granting a workspace.
const LOWEST_PORT = 1024;
const HIGHEST_PORT = 65535;

// Except zero, which is not a port but a request: bind whatever is free. Picking a number by
// hand means remembering which ones are taken, and being wrong about it only shows up as a
// refusal to start. It has to be typed like any other value — there is still no default.
const PORT_CHOSEN_AT_START = 0;

// How an instance gets an account.
//
//   login    it signs itself in, once, with `ovai login`, and keeps the credential in its own
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

// Installing over what is there is the same act as taking a newer version: the payload is replaced
// whole and nothing of the person's is written over — a file they have is kept as it is, a file
// they have not got is placed as a fresh install would place it.
const SWITCHES = [["--force", "force", "install into a directory that is not empty, keeping what is there"]];

// Every option is required. The installer never prompts and never guesses: a command line
// that describes the whole instance is one that can be read back, repeated and tested.
//
// Over an existing instance the description is already there, in its openovai.json, and that is
// where an answer left off the command line comes from — not a guess, the instance's own word.
// An answer that IS given is applied to it: a person typing `--port 8000` over their instance
// means the port, and dropping it because the file already had one would be the installer
// quietly deciding otherwise.
const REQUIRED = OPTIONS.map(([, key]) => key);

// Where each answer sits in openovai.json, for reading one out and for writing one in.
const IN_CONFIG = {
  human: (config) => config.human,
  leader: (config) => config.leader,
  leaderModel: (config) => config.models?.leader,
  workerModel: (config) => config.models?.worker,
  port: (config) => (config.port === undefined ? undefined : String(config.port)),
  auth: (config) => config.auth,
};

// The directories an instance is made of, relative to its root.
//
//   work/          one directory per person, holding the state a replacement session reads
//   personas/      one file per session, saying who it is, with the names written into it
//   .claude/       settings that belong to the instance and can be shared
//   .claude-home/  the instance's own Claude Code home: its account, transcripts and memory,
//                  kept apart so two instances on one machine never share a session history
//   plugins/       tools this instance serves itself, one file per tool, written where the
//                  machine they reach out to is known
//
// None of these is in the payload. What the toolkit ships and what an instance accumulates are
// different things and stay in different directories, so that replacing the one never reaches
// into the other.
const LAYOUT = ["work", "personas", ".claude", ".claude-home", PLUGINS];

// Bumped when a field changes meaning, so an older instance can be recognised as one.
const CONFIG_SCHEMA = 1;

// The lead's persona, before the names are written into it. What becomes of it — where it is
// written and why the names are welded in rather than looked up — is in tools/desks.mjs, which
// every session's persona goes through.
const LEADER_TEMPLATE = path.join("templates", "leader.md");

// A bad command line: the person can fix it and try again, so we show them the usage.
class UsageError extends Error {}

// A refusal to act on the machine as it is. Nothing to do with the arguments, so printing the
// usage under it would only be noise.
class InstallError extends Error {}

function usage() {
  return [
    "Install an OpenOv AI instance.",
    "",
    "Usage:",
    "  ./install.sh --root <dir> --source <dir> --human <name> --leader <name>",
    "               --leader-model <model> --worker-model <model> --port <number|0>",
    `               --auth <${AUTH_MODES.join("|")}>`,
    "",
    "Every option is required. Nothing is prompted for and nothing is guessed — except over an",
    "instance that is already there, whose openovai.json answers for whatever is left off, and",
    "into which whatever is given is written.",
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

// What the root already says about itself, or null where there is nothing there yet. Read before
// the answers are checked, because it is where a missing one is looked up.
function existingConfig(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, CONFIG_FILE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InstallError(`${path.join(root, CONFIG_FILE)} is not readable as JSON: ${error.message}`);
  }
}

function resolvePlan(parsed) {
  if (parsed.root === undefined) {
    throw new UsageError("--root is required");
  }
  const root = path.resolve(expandHome(parsed.root));
  const existing = existingConfig(root);

  const given = new Set(REQUIRED.filter((key) => parsed[key] !== undefined));
  for (const key of REQUIRED) {
    if (parsed[key] === undefined && existing !== null && IN_CONFIG[key] !== undefined) {
      parsed[key] = IN_CONFIG[key](existing);
    }
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

  // What a model identifier is comes from desks.mjs, which is also what hiring somebody onto one
  // asks. A workspace that may be installed on a model can hire onto it, and there is one sentence
  // to read when neither will have it.
  for (const key of ["leaderModel", "workerModel"]) {
    if (!isModel(parsed[key])) {
      const flag = OPTIONS.find(([, name]) => name === key)[0];
      throw new UsageError(describeModel(flag, parsed[key]));
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
    existing,
    given,
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

// The instance's own description of itself, from the answers. Where there is none it is written
// whole; where there is one, the answers actually given on the command line are written into it
// and the rest of it — what was not given, and anything the person has added since — is left as
// it is. Nothing to write when what was given is what is there already, and then the file is not
// named among what was written either.
function writeConfig(plan) {
  const target = path.join(plan.root, CONFIG_FILE);
  const answers = {
    human: plan.human,
    leader: plan.leader,
    models: {
      leader: plan.leaderModel,
      worker: plan.workerModel,
    },
    port: plan.port,
    auth: plan.auth,
  };

  let config;
  if (plan.existing === null) {
    config = { schema: CONFIG_SCHEMA, createdAt: new Date().toISOString(), ...answers };
  } else {
    config = { ...plan.existing, models: { ...plan.existing.models } };
    for (const key of plan.given) {
      if (key === "leaderModel") config.models.leader = answers.models.leader;
      else if (key === "workerModel") config.models.worker = answers.models.worker;
      else if (key in answers) config[key] = answers[key];
    }
    if (JSON.stringify(config) === JSON.stringify(plan.existing)) {
      return [];
    }
  }

  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
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
  console.log("Wrote:");
  for (const entry of written) {
    console.log(`  ${entry}`);
  }
  const ovai = path.join(plan.root, "bin", "ovai");
  console.log("");
  console.log("Start it with:");
  if (plan.auth === "login") {
    console.log(`  ${ovai} login`);
  }
  console.log(`  ${ovai} chat`);
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
    // The payload first and whole, then the person's files where they are missing, then the lead's
    // persona — which is rendered from the payload just put in place, so an install over an
    // instance leaves the lead on the templates of the version that was installed.
    report(plan, [
      ...createLayout(plan),
      ...replacePayload(plan.root, plan.source),
      ...writeConfig(plan),
      ...seedUserContent(plan.root, plan.leader),
      ...writePersona(plan.root, plan.root, plan.leader, "leader", LEADER_TEMPLATE, {
        LEADER: plan.leader,
        HUMAN: plan.human,
      }),
    ]);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`install: ${error.message}`);
      console.error("");
      console.error(usage());
      return 2;
    }
    if (error instanceof InstallError || error instanceof DeskError || error instanceof ReleaseError) {
      console.error(`install: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
