// Running Claude Code as this instance.
//
// An instance has its own Claude Code home, which is what keeps two workspaces on one machine
// from sharing an account, a transcript or a memory. Everything that starts Claude Code goes
// through here so there is one answer to what "as this instance" means.

import { spawnSync } from "node:child_process";
import path from "node:path";

// Any of these outranks the instance's own home and would run as somebody else.
const NEVER_INHERITED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
];

export function home(root) {
  return path.join(root, ".claude-home");
}

export function environment(root) {
  const env = { ...process.env };
  for (const name of NEVER_INHERITED) {
    delete env[name];
  }
  env.CLAUDE_CONFIG_DIR = home(root);
  return env;
}

// Whether this instance can talk to Anthropic at all. Claude Code answers it directly, so ask
// it rather than guessing from the presence of a credentials file, which says nothing about
// whether the credential still works. Returns null when the question cannot be asked.
export function loggedIn(root) {
  const asked = spawnSync("claude", ["auth", "status"], {
    cwd: root,
    env: environment(root),
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
export function login(root) {
  const signed = spawnSync("claude", ["auth", "login"], {
    cwd: root,
    env: environment(root),
    stdio: "inherit",
  });

  if (signed.error !== undefined) {
    throw signed.error;
  }

  return signed.status ?? 1;
}
