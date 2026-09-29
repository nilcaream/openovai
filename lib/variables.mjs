// Claude Code variables: which of them the shell `ovai start` was typed in carries, and what a
// session gets of each — removed, overridden, passed on, or set by ovai where the shell had none.
//
// Gathered once, when the server is started, and written down: `claude-variables` at the instance
// root, one line per variable, sorted by name. `ovai start` prints it, and `ovai configuration`
// prints it last. Both read the file and never the shell they are typed in, which may not be the
// one the server was started from.
//
// A value is masked as it is gathered, so the file holds nothing a panel or a log would not: a
// variable whose name says it carries a credential is `***` whole, a URL's query values are `***`,
// and everything else goes through the command masker (lib/mask.mjs). A token in a URL's path has
// no shape and no name to be found by, and it is shown as it is.

import fs from "node:fs";
import path from "node:path";

import { inherited, serverEnvironment, sessionEnvironment } from "./claude.mjs";
import { MASK, mask } from "./mask.mjs";
import { writePrivate } from "./private.mjs";

export const VARIABLES_FILE = "claude-variables";

// Claude Code's own names: every CLAUDE_ and ANTHROPIC_ one, and the few its documentation lists
// under no prefix that change what a session does. Names shared with the rest of the machine, a
// proxy or a terminal, are not Claude Code's to list.
const PREFIXES = /^(?:CLAUDE|ANTHROPIC)_/;
const DOCUMENTED = [
  "API_TIMEOUT_MS",
  "AWS_BEARER_TOKEN_BEDROCK",
  "BASH_DEFAULT_TIMEOUT_MS",
  "BASH_MAX_OUTPUT_LENGTH",
  "BASH_MAX_TIMEOUT_MS",
  "DISABLE_AUTOUPDATER",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_TELEMETRY",
  "MAX_THINKING_TOKENS",
  "MCP_TIMEOUT",
  "MCP_TOOL_TIMEOUT",
];

// What a seat is started with outranks these, whatever the variable says: every seat gets
// --model, which beats ANTHROPIC_MODEL on the pinned claude (measured on 2.1.280).
const OUTRANKED = ["ANTHROPIC_MODEL"];

// A name that says what it holds is a credential: a key, a token, a secret, a password or
// passphrase, headers, an auth value. Matched as a whole word of the name, so the number in
// MAX_THINKING_TOKENS is not taken for one.
const CREDENTIAL = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?|HEADERS|AUTH)(?:_|$)/;

const URL = /^[a-z][a-z0-9+.-]*:\/\//i;

function known(name) {
  return PREFIXES.test(name) || DOCUMENTED.includes(name);
}

export function masked(name, value) {
  if (CREDENTIAL.test(name)) {
    return MASK;
  }
  const queried = URL.test(value) ? value.replace(/([?&][^=&#\s]*=)[^&#\s]+/g, `$1${MASK}`) : value;
  // One line each: a value that runs on over lines would read as a variable of its own.
  return mask(queried).replace(/\n/g, "\\n");
}

function action(name, found, given) {
  if (!(name in given)) {
    return "(removed)";
  }
  if (OUTRANKED.includes(name)) {
    return "(overridden)";
  }
  if (given[name] === found[name]) {
    return "(passed on)";
  }
  return `(overridden: ${masked(name, given[name])})`;
}

// One line per Claude Code variable, sorted by name: what the shell had, and what a seat gets of
// it. A seat, since that is what the server starts; the admin door and the sign-in keep the
// person's effort.
export function gathered(root, auth, shell) {
  // The shell's own CLAUDE_CONFIG_DIR among them: the server never sees it, and a seat gets the
  // instance's home over it.
  const found = inherited(shell);
  const given = sessionEnvironment(root, auth, "any seat", serverEnvironment(root, shell));
  const names = [...new Set([...Object.keys(found), ...Object.keys(given)])].filter(known).sort();
  return names.map((name) => (name in found ? `  ${name} = ${masked(name, found[name])} ${action(name, found, given)}` : `  ${name} = ${masked(name, given[name])}`));
}

function file(root) {
  return path.join(root, VARIABLES_FILE);
}

// Written by `ovai start` once the server it started is up, from the shell it was typed in.
export function record(root, auth, shell = process.env) {
  writePrivate(file(root), `${gathered(root, auth, shell).join("\n")}\n`);
}

// The lines as written, or null when no start has written them.
export function recorded(root) {
  try {
    return fs.readFileSync(file(root), "utf8").trimEnd();
  } catch {
    return null;
  }
}
