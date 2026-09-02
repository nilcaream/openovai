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
];

// What Claude Code files this instance's transcripts and memory under, inside the instance's own
// home: <root>/.claude-home/projects/<this>/.
//
// Left alone, Claude Code names that directory after the ABSOLUTE working directory a session was
// started in — and every session here is started in the instance root. So a workspace that was
// moved or copied would look for its threads and everything it had learned under the path it used
// to sit at, find neither, and be unable to say why. An instance holds no absolute path anywhere
// else, by design; this is the one place the choice was being made for us.
//
// So it is a fixed word, the same in every instance. Two instances never collide over it because
// each has its own home to file it in. It is set rather than merely kept, which also takes care of
// the reason it used to be stripped: a value from the environment an instance is started in would
// otherwise decide where that instance keeps what it knows.
//
// No separator in it. It is one directory name, and a name that reached out of the projects
// directory would put an instance's memory somewhere the instance does not own.
export const PROJECT_DIRECTORY = "workspace";

// What Claude Code calls the index of what it has been told to remember, and where it keeps it.
// A session reads that directory before it is asked anything and writes into it when it is asked
// to remember something, so it is the one thing in an instance that outlives a conversation
// without anybody having to go and look for it.
//
// It is under the instance's own home, so two workspaces on one machine never read each other's;
// and under the fixed name above, so one workspace reads its own wherever it has been moved to.
export const MEMORY_FILE = "MEMORY.md";

export function memoryDirectory(root) {
  return path.join(home(root), "projects", PROJECT_DIRECTORY, "memory");
}

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
  env.CLAUDE_CODE_PROJECT_DIR_NAME = PROJECT_DIRECTORY;
  return env;
}

// Whether a machine token is there to be inherited. The value is never read out — whether an
// instance can start is the question, and printing a credential to answer it would be a poor
// trade.
export function machineToken() {
  const value = process.env[MACHINE_TOKEN];
  return typeof value === "string" && value !== "";
}

// Whether this instance has a credential to run with. Claude Code is asked rather than the
// disk being searched, because where a credential lives is Claude Code's business and not
// ours.
//
// This is not the same as being able to talk to Anthropic, and it must not be reported as if
// it were. `claude auth status` says nothing to the network: given a token of the right shape
// but no value — `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-nonsense` — it answers
// `{"loggedIn":true,"authMethod":"oauth_token"}` and exits 0, while the first real request
// comes back `401 OAuth access token is invalid`.
//
// The honest check costs a request, which is too much for a status command to spend every time
// it is run. So this answers the cheap question and the caller says which question it was.
// Returns null when even that cannot be asked.
export function hasCredential(root, auth) {
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
