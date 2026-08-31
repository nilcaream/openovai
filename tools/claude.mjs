// Running Claude Code as this instance.
//
// An instance has its own Claude Code home, which is what keeps two workspaces on one machine
// from sharing an account, a transcript or a memory. Everything that starts Claude Code goes
// through here so there is one answer to what "as this instance" means.

import { spawnSync } from "node:child_process";
import path from "node:path";

// These outrank the instance's own home and would run it as somebody else, or against somebody
// else's bill. They are removed whatever the instance was installed with.
const NEVER_INHERITED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
];

// The one credential an instance can be told to take from the machine around it. Signing in is
// interactive, and an instance that has to be signed in by hand cannot be started by anything
// automatic; a token minted once with `claude setup-token` and exported where the instances are
// started from gives every one of them an account without a browser. Instances installed with
// --auth login never see it.
const MACHINE_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

export function home(root) {
  return path.join(root, ".claude-home");
}

// `auth` is what the instance was installed with, from ow.json. Anything other than "inherit"
// is treated as "sign in on your own", so an instance from before the option existed keeps the
// stricter behaviour rather than quietly picking up whatever token is lying around.
export function environment(root, auth) {
  const env = { ...process.env };
  for (const name of NEVER_INHERITED) {
    delete env[name];
  }
  if (auth !== "inherit") {
    delete env[MACHINE_TOKEN];
  }
  env.CLAUDE_CONFIG_DIR = home(root);
  return env;
}

// Whether a machine token is there to be inherited. The value is never read out — whether an
// instance can start is the question, and printing a credential to answer it would be a poor
// trade.
export function machineToken() {
  const value = process.env[MACHINE_TOKEN];
  return typeof value === "string" && value !== "";
}

// Whether this instance can talk to Anthropic at all. Claude Code answers it directly, so ask
// it rather than guessing from the presence of a credentials file, which says nothing about
// whether the credential still works. Returns null when the question cannot be asked.
export function loggedIn(root, auth) {
  const asked = spawnSync("claude", ["auth", "status"], {
    cwd: root,
    env: environment(root, auth),
    encoding: "utf8",
  });

  if (asked.error !== undefined) {
    return null;
  }

  try {
    return JSON.parse(asked.stdout).loggedIn === true;
  } catch {
    return null;
  }
}

// Hand the terminal to Claude Code so a person can sign this instance in.
export function login(root, auth) {
  const signed = spawnSync("claude", ["auth", "login"], {
    cwd: root,
    env: environment(root, auth),
    stdio: "inherit",
  });

  if (signed.error !== undefined) {
    throw signed.error;
  }

  return signed.status ?? 1;
}
