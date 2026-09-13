// What an instance is given to start with, and the one rule for giving it.
//
// An instance is two kinds of file. The payload — bin, tools, templates, the version — is the
// toolkit's, and taking a newer version replaces it whole (tools/release.mjs). Everything else is
// the person's: their configuration, their desks, what the workspace remembers, the rules they have
// granted. The toolkit writes the first version of some of those, because a workspace with no
// settings and no memory index would grow shapes of its own; but the first version is the only one
// it ever writes.
//
// So the rule is SEED IF ABSENT, NEVER TOUCH IF PRESENT, and it is one rule for every file here
// rather than a judgement per file. A file that is not there is placed as a clean install would
// place it; a file that is there is the person's, whatever is in it, and is left exactly as it is.
// That makes installing over an instance, and taking a newer version, the same act as installing
// fresh: the payload replaced, the person's files seeded where missing and untouched where not —
// an updated instance is a clean install into which the person's own material was copied.
//
// It is called from both the installer and the update, and it reads the templates from the
// instance rather than from wherever the payload came from, because by the time it runs the
// payload is in place — and because an instance opens desks on machines its source was never on.

import fs from "node:fs";
import path from "node:path";

import { homeSettingsFile } from "./claude.mjs";
import { DESK_DENY_RULES, DESK_TEMPLATE, OWN_ACCOUNT_RULES, READ_RULES, TOOL_RULES, deskFile, readTemplate, render } from "./desks.mjs";
import { settingsFile } from "./settings.mjs";
import { STORES, storeDirectory } from "./store.mjs";

// The instance's own description of itself, and the file whose absence says a directory is not an
// instance. It sits at the root beside the payload rather than inside it, because it describes
// what the instance became and an update replaces only what the toolkit ships; and it is
// deliberately free of absolute paths — not where it came from, not even its own root, which
// anything running inside works out from where it sits — so that an instance can be moved or
// copied and still be itself. Named here, with the rest of what the person owns.
export const CONFIG_FILE = "openovai.json";

// What a session does when it is refused for the rest of a usage window. Left to itself Claude Code
// waits the window out and takes the session up again when it reopens. Turned off, the limit
// arrives instead as a dialog on that session's own terminal offering the wait as a choice, and the
// session sits on it until somebody answers at that keyboard. A workspace is run by messages, so a
// session waiting on a dialog has left the room: it cannot be asked anything, told anything, or
// ended. Waiting the window out is much the lesser of the two.
//
// What keeps a reopened window from being spent by a whole room coming back at once is a
// different question, and this key is not its answer.
//
// The key is written out rather than left to the default, because the default belongs to the
// harness and is its to change. It goes into the instance's Claude Code home rather than its own
// settings because that is the only one of the two files the key is read from.
//
// And Claude Code's own memory is off. What a workspace knows lives in its store, reached through
// the `recall` and `remember` tools by every session alike; a second memory that each session
// grew on its own would be a second answer to what the workspace knows, read by nobody else.
const HOME_SETTINGS = {
  autoContinueAtUsageLimit: true,
  autoMemoryEnabled: false,
};

// The instance's own settings, whole, as a fresh workspace holds them: any session may use the
// tools the chat serves and read any file in the instance; no file-writing tool reaches the
// workspace's own account of what it allows, nor any desk — a desk is written through a tool.
// One object written once — the rules the User settles later go through tools/desks.mjs
// `ruleAsked`, which merges into whatever the person has made of this file by then. What each
// rule is worth is said beside the rules themselves.
//
// Nothing here goes through the ledger beside the settings. The ledger says who asked for a rule,
// and nobody asked for these: they are what an instance is born with.
function settingsToStartWith() {
  return {
    permissions: {
      allow: [...TOOL_RULES, ...READ_RULES],
      deny: [...OWN_ACCOUNT_RULES, ...DESK_DENY_RULES],
    },
  };
}

function asJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// The rule, once. The content is asked for only when it is going to be written, so a template that
// is missing is only a problem for an instance that has not got the file yet.
function seed(target, content) {
  if (fs.existsSync(target)) {
    return [];
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content());
  return [target];
}

// Everything the toolkit writes for the person and never writes again, given who leads here. The
// instance's own description of itself is not among them: the installer writes it from the command
// line, and an update has read it before it does anything, so it is never missing there.
//
// Answers with what it wrote, the way everything else that puts a file in an instance does.
export function seedUserContent(root, leader) {
  // The store's two directories, empty: a record is written when somebody has something to
  // remember, and nothing is seeded into them. They are made so that where the workspace keeps what
  // it knows is there to be seen from the first minute.
  for (const store of STORES) {
    fs.mkdirSync(storeDirectory(root, store), { recursive: true });
  }
  return [
    ...seed(homeSettingsFile(root), () => asJson(HOME_SETTINGS)),
    ...seed(deskFile(root, leader), () => render("desk", readTemplate(root, "desk", DESK_TEMPLATE), { NAME: leader })),
    ...seed(settingsFile(root), () => asJson(settingsToStartWith())),
  ];
}
