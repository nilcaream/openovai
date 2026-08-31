// Running Claude Code as this instance.
//
// An instance has its own Claude Code home, which is what keeps two workspaces on one machine
// from sharing an account, a transcript or a memory. Everything that starts Claude Code goes
// through here so there is one answer to what "as this instance" means.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

// Claude Code's own file inside the instance's home, where it records what it knows about the
// directories it has been run in.
const STATE_FILE = ".claude.json";

// Claude Code ignores a directory's own .claude/settings.json until that directory has been
// trusted, and trusting one is a dialog in an interactive session — which an instance never
// has. Left alone, an instance would silently run without the permissions it ships with, and
// the only sign of it is a line on stderr nobody reads.
//
// The instance's root is its own directory, created by whoever installed it, so answering that
// dialog on its behalf grants nothing that was not already granted. It is recorded here rather
// than at install time because the key is an absolute path: an instance that gets moved would
// carry a stale one, and this way the first run after a move puts it right.
//
// One case this does not cover: an instance installed inside a git repository, where Claude
// Code trusts by the enclosing repository instead of the directory it was started in. Such an
// instance runs without its own permissions until somebody trusts that repository. Installing
// a workspace inside a checkout is odd enough to leave alone rather than to guess at.
function trustOwnRoot(root) {
  const file = path.join(home(root), STATE_FILE);
  const directory = path.resolve(root);

  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // No file yet, or one we cannot read. Either way the trust is not recorded, and writing a
    // fresh file is better than refusing to run.
  }

  if (state?.projects?.[directory]?.hasTrustDialogAccepted === true) {
    return;
  }

  const projects = { ...state?.projects };
  projects[directory] = { ...projects[directory], hasTrustDialogAccepted: true };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...state, projects }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // An instance that cannot record this still runs, only without its own permissions. That
    // is worth a degraded session, not a refusal to start.
  }
}

// The environment Claude Code runs in as this instance — and, on the way, the one thing that
// has to be true on disk before it will read the instance's own settings. Everything that
// starts Claude Code goes through here, so this is the one place it cannot be forgotten.
//
// `auth` is what the instance was installed with, from ow.json. Anything other than "inherit"
// is treated as "sign in on your own", so an instance from before the option existed keeps the
// stricter behaviour rather than quietly picking up whatever token is lying around.
export function environment(root, auth) {
  trustOwnRoot(root);

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
