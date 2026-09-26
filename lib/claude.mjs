// Running Claude Code as this instance.
//
// An instance has its own Claude Code home, which is what keeps two workspaces on one machine
// from sharing an account, a transcript or a memory. Everything that starts Claude Code goes
// through here so there is one answer to what "as this instance" means.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { RuntimeError, claudeCommand } from "./runtime.mjs";

// These outrank the instance's own home and would run it as somebody else, or against somebody
// else's bill. They are removed whatever the instance was installed with.
const NEVER_INHERITED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
];

// What Claude Code files this instance's transcripts under, inside the instance's own home:
// <root>/.local/projects/<this>/.
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

// The one credential an instance can be told to take from the machine around it. Signing in is
// interactive, and an instance that has to be signed in by hand cannot be started by anything
// automatic; a token minted once with `claude setup-token` and exported where the instances are
// started from gives every one of them an account without a browser. Instances installed with
// --auth login never see it.
const MACHINE_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

// The instance's own Claude Code config directory: its account, transcripts and memory, kept apart
// so two instances on one machine never share a session history. Named for what the directory is
// for — this instance's local state — rather than for the program that keeps it.
export const HOME = ".local";

export function home(root) {
  return path.join(root, HOME);
}

// Claude Code's own settings for this instance, inside the instance's home. This is the file it
// reads as the account's settings; the instance's `.claude/settings.json` is a different one,
// read as the working directory's, and a key that is only honoured in the account's is a no-op
// there. Named here, where the home is, so that the two are never confused for each other.
export function homeSettingsFile(root) {
  return path.join(home(root), "settings.json");
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
//
// Answers null, or the error the write failed with. A session started after a failed write still
// runs, only without its own permissions — that is a degraded session, and here, where one session
// is being started, it is worth more than a refusal. Whether an INSTANCE should start that way is
// decided once, before anything is served (trustProblem): every session it would start is one
// that asks for everything it does.
function trustOwnRoot(root) {
  const file = trustFile(root);
  const directory = path.resolve(root);

  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // No file yet, or one we cannot read. Either way the trust is not recorded, and writing a
    // fresh file is better than refusing to run.
  }

  if (trusted(state, directory)) {
    return null;
  }

  const projects = { ...state?.projects };
  projects[directory] = { ...projects[directory], hasTrustDialogAccepted: true };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...state, projects }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    return error;
  }
  return null;
}

function trustFile(root) {
  return path.join(home(root), STATE_FILE);
}

// Whether Claude Code has run its own first-launch setup under this instance's configuration,
// read and never written: the key is Claude Code's and undocumented. If it ever changes meaning,
// the worst case is that the admin door's first-time line shows every time, which does no harm.
export function onboarded(root) {
  try {
    return JSON.parse(fs.readFileSync(trustFile(root), "utf8"))?.hasCompletedOnboarding === true;
  } catch {
    return false;
  }
}

function trusted(state, directory) {
  return state?.projects?.[directory]?.hasTrustDialogAccepted === true;
}

// Whether this instance may be served at all: the trust is recorded, then READ BACK from disk,
// because the record is the one thing every seat's permissions hang on. A seat started without it
// is not refused anything — it is asked for everything it does, and the only word about why is a
// line Claude Code writes to stderr that nobody reads. That is not an error to Claude Code, and it
// is not nothing to the person whose panels fill with questions the instance was installed to
// settle. So it is said here, once, by whoever starts the chat, as the reason the chat did not
// start: null when the record is on disk, otherwise one sentence naming the file and what went
// wrong, for `ovai start` to print and the log to keep.
export function trustProblem(root) {
  const failure = trustOwnRoot(root);
  const file = trustFile(root);

  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (failure === null) {
      return notTrusted(root, file, error);
    }
  }

  if (failure === null && trusted(state, path.resolve(root))) {
    return null;
  }
  return notTrusted(root, file, failure);
}

function notTrusted(root, file, error) {
  const why = error === null ? "the key was not there when the file was read back" : error.message;
  return `${file}: cannot record that ${root} is trusted (${why}) — Claude Code would ignore ${path.join(root, ".claude", "settings.json")} and every session would ask for everything it does; fix the file or its directory and start again`;
}

// The seat a session is, in its process environment, beside the instance's home. Everything a
// session starts inherits it — a shell, a browser, a server it left in the background — so
// whatever is still running once the session is gone can be named by the seat that started it,
// and ended (lib/running.mjs). Set only on a session, for that session's seat, and never
// inherited: a process started from inside a session that starts Claude Code of its own — a
// Claude Code the seat starts itself, another instance's server — would otherwise hand the
// seat's name on to work that is not the seat's.
export const SEAT_IN_ENVIRONMENT = "OPENOVAI_SEAT";

// What the chat puts on a session, and what a process started from inside one inherits: the
// seat, the seat's secret (lib/chat/session.mjs) and the switch that takes the account's
// connectors away (below). None of it is handed on: a Claude Code started as nobody's session —
// `ovai claude` typed in a seat's shell — is the person's own, and a session's start sets its own.
const SET_ON_A_SESSION = [SEAT_IN_ENVIRONMENT, "OPENOVAI_SESSION_SECRET", "ENABLE_CLAUDEAI_MCP_SERVERS"];

// What Claude Code puts on the session it runs, and a shell of that session hands on to whatever
// is started from it: the session's own id, pid, entry point and effort, the socket and token its
// sessions talk over, and the directory the shell stood in. Read off a server started from a
// seat's shell and off a session that server started; named one by one rather than by prefix,
// because CLAUDE_CODE_OAUTH_TOKEN is the machine's sign-in and "inherit" is there to keep it.
// None of it is anything a process started here is: a server is not the session it was typed in,
// and a session it starts is its own.
const A_SESSIONS_OWN = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "PWD",
  "OLDPWD",
];

// The environment the chat server runs in: this instance's Claude Code home, and nothing of the
// session or the seat it was started from.
export function serverEnvironment(root) {
  const env = { ...process.env };
  for (const name of [...A_SESSIONS_OWN, ...SET_ON_A_SESSION]) {
    delete env[name];
  }
  env.CLAUDE_CONFIG_DIR = home(root);
  return env;
}

// The environment Claude Code runs in as this instance — and, on the way, the one thing that
// has to be true on disk before it will read the instance's own settings. Everything that
// starts Claude Code goes through here, so this is the one place it cannot be forgotten.
//
// `auth` is what the instance was installed with, from openovai.json. Anything other than "inherit"
// is treated as "sign in on your own", so an instance from before the option existed keeps the
// stricter behaviour rather than quietly picking up whatever token is lying around.
//
// `seat` is the seat the process is a session of; null for a run that is nobody's session.
export function environment(root, auth, seat = null) {
  trustOwnRoot(root);

  const env = { ...process.env };
  for (const name of [...NEVER_INHERITED, ...SET_ON_A_SESSION, ...A_SESSIONS_OWN]) {
    delete env[name];
  }
  if (auth !== "inherit") {
    delete env[MACHINE_TOKEN];
  }
  env.CLAUDE_CONFIG_DIR = home(root);
  if (seat !== null) {
    env[SEAT_IN_ENVIRONMENT] = seat;
    // The MCP servers a claude.ai account adds on the web reach every session signed in with it,
    // with no file here naming them and no card. A seat gets the servers this instance was given —
    // its own connector, and what `ovai claude` added — and none of the account's. The switch takes
    // away the account's servers alone; --strict-mcp-config would take the admin door's with them.
    // A start that is nobody's session, the admin door among them, is the person's own and keeps
    // what their account gives them.
    env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  }
  env.CLAUDE_CODE_PROJECT_DIR_NAME = PROJECT_DIRECTORY;
  // The claude command is the toolkit's own, at the version lib/RUNTIME pins, and a newer one
  // reaches an instance through the next release: its background updater is off, or it would
  // replace the binary under the pin on its own.
  env.DISABLE_AUTOUPDATER = "1";
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
//
// An `auth` subcommand and not a session: it runs no turn, which is one of the three shapes the
// check in tests/ovai.test.mjs allows a start of Claude Code to take. The other two are print
// mode, which every seat runs in, and the admin door, which is exempt for a different reason
// again: the terminal it runs on is the person's own.
//
// A claude that was never fetched is the same null as one that could not be started: the
// question cannot be asked, and the caller says so.
export function hasCredential(root, auth) {
  let asked;
  try {
    asked = spawnSync(claudeCommand(root), ["auth", "status"], {
      cwd: root,
      env: environment(root, auth),
      encoding: "utf8",
    });
  } catch (error) {
    if (error instanceof RuntimeError) {
      return null;
    }
    throw error;
  }

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
//
// One of the two places the toolkit hands a child a real terminal — the admin door below is the
// other — and one of the two starts of Claude Code here that are not in print mode. With stdio
// "inherit" this child's stdout IS a terminal when a person runs the command from a shell, which
// is exactly the shape Claude Code judges interactive and arms its background-shell pressure
// reaper for. It is safe for one reason and only that reason: an `auth` subcommand runs no turn,
// so there is no background work for a reaper to take. A seat's session must never be started
// this way. The check in tests/ovai.test.mjs holds every start of Claude Code to one of three
// shapes — --print, `auth`, or the admin door — and this is the `auth` one.
export function login(root, auth) {
  const signed = spawnSync(claudeCommand(root), ["auth", "login"], {
    cwd: root,
    env: environment(root, auth),
    stdio: "inherit",
  });

  if (signed.error !== undefined) {
    throw signed.error;
  }

  return signed.status ?? 1;
}

// Hand the terminal to Claude Code so a person can reach its own commands — `/mcp`, `/plugin`,
// and whatever it gains next — against this instance's configuration rather than their own.
//
// This is the second place the toolkit hands over a real terminal, and unlike the sign-in it is a
// session: it runs turns, and Claude Code will arm its background-shell reaper for it. That is
// correct here and it is the difference worth stating. The reaper reaps the background work of the
// session it is armed for, and this session has none of ours: it is the person's own, started by
// them, with no seat, no desk and no connector. The rule the check in tests/ovai.test.mjs holds is
// about never giving one of OUR sessions a terminal, and this is not one of ours.
//
// The whole of what makes it this instance's rather than the person's is the environment:
// CLAUDE_CONFIG_DIR points at the instance's home, so every key `/mcp` and `/plugin` write lands
// where the seats will read it. Run bare, the same commands would write the person's own home,
// report success, and change nothing here.
//
// None of a seat's arguments are passed, and each is left out for its own reason. --print, because
// there is a person at a terminal. --permission-prompt-tool, because a card must appear where that
// person is sitting and inherited stdio does that for nothing. --mcp-config, because the connector
// is what a seat talks to the room with and an admin has no room. --settings, because those are
// the rules set for seats. --model, because the model is the person's own choice in their own
// session: this instance chooses one for its seats, not for people.
//
// One argument beyond the briefing is passed, and it is there to take something away.
// `--setting-sources user` loads the person's own settings and leaves this instance's project
// settings out of the session. Those settings are the rules written for seats — unattended
// sessions with nobody watching — and the allow list among them grants Edit over the desks, over
// what the workspace knows and over the repositories, and `rm`. An admin session inheriting that
// would edit a Worker's desk or a shared note with no card at all: the exact consequence the
// briefing spends its lines warning about, made silent by the very settings that keep seats in
// their lane. What must not happen quietly is refused by a rule; the briefing explains why. Left
// out, each of those asks the person who is sitting right there, which costs an admin nothing and
// is the whole shape of this command. The deny lines go with the allow and that is intended too:
// they hold a seat's file tools away from the two configuration files, which is exactly where
// admin work has to land.
//
// Measured on 2.1.280 before it was written: all three jobs the door exists for — `plugin
// marketplace add`, `plugin install`, `mcp add --scope user` — still exit 0 with the flag, and a
// project-scope server declared in .mcp.json drops out of `mcp list` when it is passed.
export function adminSession(root, auth, briefing) {
  const ran = spawnSync(claudeCommand(root), ["--append-system-prompt", briefing, "--setting-sources", "user"], {
    cwd: root,
    env: environment(root, auth),
    stdio: "inherit",
  });

  if (ran.error !== undefined) {
    throw ran.error;
  }

  return ran.status ?? 1;
}
