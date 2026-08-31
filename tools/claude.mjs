// Running Claude Code as this instance.
//
// An instance has its own Claude Code home, which is what keeps two workspaces on one machine
// from sharing an account, a transcript or a memory. Everything that starts Claude Code goes
// through here so there is one answer to what "as this instance" means.

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
