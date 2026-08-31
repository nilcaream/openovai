#!/usr/bin/env node

// The instance's own command. bin/ow works out which instance it belongs to and passes it in
// with --root, so nothing here has to guess where it is running.

import fs from "node:fs";
import path from "node:path";

import { serve } from "./chat/server.mjs";
import { hasCredential, home, login, machineToken } from "./claude.mjs";
import { holderOf } from "./port.mjs";

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

// What we know about this instance's credential, which is less than whether it works. Nothing
// here has talked to Anthropic, so nothing here promises the next message will go through; the
// row says so rather than letting "signed in: yes" stand in front of a token that expired
// last week.
function describeCredential(root, auth) {
  const present = hasCredential(root, auth);
  if (present === null) {
    return "cannot tell — Claude Code did not answer";
  }
  if (present) {
    return "there is one — not checked against Anthropic";
  }
  // What to do about it depends on where the account was supposed to come from. Telling an
  // instance that inherits to run `ow login` would send it to a command that refuses.
  return auth === "inherit"
    ? "none — CLAUDE_CODE_OAUTH_TOKEN is not set in the environment this ran in"
    : "none — run: ow login";
}

// An instance that takes its token from the environment has no account of its own to sign in,
// and a credential written into its home would sit there being overridden. Say so rather than
// opening a browser for a sign-in that changes nothing.
function signIn(root) {
  const config = readConfig(root);

  if (config.auth === "inherit") {
    throw new UsageError(
      "this instance signs in with CLAUDE_CODE_OAUTH_TOKEN from the environment it is started in, not with an account of its own — mint a token with: claude setup-token",
    );
  }

  console.log(`Signing in ${home(root)}`);
  return login(root, config.auth);
}

// How this instance gets an account, and — when that is the machine's token — whether the
// token is actually there. Only its presence is reported: what is being answered is whether
// the instance can start, and printing a credential to answer that would be a poor trade.
function describeAuth(config) {
  if (config.auth !== "inherit") {
    return ["signs in by", "an account of its own"];
  }
  return [
    "signs in by",
    machineToken()
      ? "CLAUDE_CODE_OAUTH_TOKEN, which is set here"
      : "CLAUDE_CODE_OAUTH_TOKEN, which is not set here — mint one with: claude setup-token",
  ];
}

function status(root) {
  const config = readConfig(root);
  const rows = [
    ["instance", root],
    ["human", config.human],
    ["leader", `${config.leader} (${config.models.leader})`],
    ["worker model", config.models.worker],
    ["chat port", config.port === 0 ? "0 — chosen when the chat starts" : config.port],
    describeAuth(config),
    ["credential", describeCredential(root, config.auth)],
    ["installed", config.createdAt],
    ["desks", desks(root).join(", ") || "none"],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));

  for (const [label, value] of rows) {
    console.log(`${label.padEnd(width)}  ${value}`);
  }
}

// The rest of "that port is taken". Naming the process turns a hunt into one `kill`, and the
// commonest thing on the port is a chat somebody forgot to stop — its command line says which
// instance it belongs to. When the machine cannot tell us, the advice alone still stands.
function byWhom(port) {
  const advice = "or install this instance with a different --port (0 takes a free one)";
  const holder = holderOf(port);

  if (holder === null) {
    return ` — stop whatever is on it, ${advice}`;
  }

  const named =
    holder.command === null ? `pid ${holder.pid}` : `pid ${holder.pid} (${holder.command})`;
  return ` by ${named} — stop it, ${advice}`;
}

async function chat(root) {
  const config = readConfig(root);

  let server;
  try {
    server = await serve({ root, config });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      throw new UsageError(`port ${config.port} is already taken${byWhom(config.port)}`);
    }
    throw error;
  }

  // Always the whole address, never "the port you installed with": with --port 0 nobody knows
  // it until now, and even with a fixed one this is the line somebody copies into a browser.
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
      return signIn(root);
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
