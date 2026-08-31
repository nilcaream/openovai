#!/usr/bin/env node

// The instance's own command. bin/ow works out which instance it belongs to and passes it in
// with --root, so nothing here has to guess where it is running.

import fs from "node:fs";
import path from "node:path";

import { serve } from "./chat/server.mjs";
import { home, loggedIn, login } from "./claude.mjs";

const CONFIG_FILE = "ow.json";

class UsageError extends Error {}

function usage() {
  return [
    "The command of an office workspace instance.",
    "",
    "Usage:",
    "  ow status    show who works in this instance and on which models",
    "  ow chat      serve the chat page until you stop it",
    "  ow login     sign this instance in to an Anthropic account",
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

function describeLogin(root) {
  const signed = loggedIn(root);
  if (signed === null) {
    return "cannot tell — Claude Code did not answer";
  }
  return signed ? "yes" : `no — run: ow login`;
}

function status(root) {
  const config = readConfig(root);
  const rows = [
    ["instance", root],
    ["human", config.human],
    ["leader", `${config.leader} (${config.models.leader})`],
    ["worker model", config.models.worker],
    ["chat port", config.port],
    ["signed in", describeLogin(root)],
    ["installed", config.createdAt],
    ["desks", desks(root).join(", ") || "none"],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));

  for (const [label, value] of rows) {
    console.log(`${label.padEnd(width)}  ${value}`);
  }
}

async function chat(root) {
  const config = readConfig(root);

  let server;
  try {
    server = await serve({ root, config });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      throw new UsageError(
        `port ${config.port} is already taken — stop whatever is on it, or install this instance with a different --port`,
      );
    }
    throw error;
  }

  const { port } = server.address();
  console.log(`${config.leader} is listening on http://127.0.0.1:${port}`);
  console.log("Stop it with ctrl-c.");
}

async function main(argv) {
  try {
    const { root, rest } = readRoot(argv);
    const command = rest[0] ?? "status";

    if (command === "--help" || command === "-h" || command === "help") {
      console.log(usage());
      return 0;
    }
    if (command !== "status" && command !== "chat" && command !== "login") {
      throw new UsageError(`unknown command: ${command}`);
    }
    if (rest.length > 1) {
      throw new UsageError(`${command} takes no arguments (got ${rest.slice(1).join(" ")})`);
    }

    if (command === "chat") {
      await chat(root);
      return 0;
    }
    if (command === "login") {
      console.log(`Signing in ${home(root)}`);
      return login(root);
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

process.exitCode = await main(process.argv.slice(2));
