// What an instance is given to start with, and the one rule for giving it.
//
// An instance is two kinds of file. The payload — bin, lib, the version — is the
// toolkit's, and taking a newer version replaces it whole (lib/release.mjs). Everything else is
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
import { DEFAULT_RULES, DESK_TEMPLATE, IGNORED_DEFAULTS, LISTS, STALE_DENY_RULES, deskFile, deskRules, readTemplate, render } from "./desks.mjs";
import { HOOK_ENTRY, hookWired } from "./hooks/compound.mjs";
import { SUBAGENT_HOOK_ENTRY, subagentHookWired } from "./hooks/subagent.mjs";
import { PRIVATE_FILE } from "./private.mjs";
import { readSettings, settingsFile, writeSettings } from "./settings.mjs";

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
// And Claude Code's own memory is off. What a workspace knows lives in `knowledge/`, read by every
// session alike; a second memory that each session grew on its own would be a second answer to
// what the workspace knows, read by nobody else.
const HOME_SETTINGS = {
  autoContinueAtUsageLimit: true,
  autoMemoryEnabled: false,
};

// The instance's own settings, whole, as a fresh workspace holds them: any session may use the
// tools the chat serves, read any file in the instance, write under the three trees the User
// works in, and work a repository under projects/ with plain git, mkdir and cd; the Leader may
// write in its own desk directory, the way every person hired later may
// in theirs; no file-writing tool reaches the workspace's own account of what it allows, nor any
// desk file — a desk file is written through a tool; and a change to what the person added to a
// persona is asked about, every seat alike, because those are their own lines. The
// Leader's pair is in the first version and nowhere else: a settings file that is there is the
// person's, whatever it holds, and a Leader's pair they took out is a pair they took out.
// One object written once — the rules the User settles later go through lib/desks.mjs
// `ruleAsked`, which merges into whatever the person has made of this file by then. What each
// rule is worth is said beside the rules themselves.
//
// Nothing here goes through the ledger beside the settings. The ledger says who asked for a rule,
// and nobody asked for these: they are what an instance is born with.
//
// Beside the rules, two hooks. Before a Bash call is asked about, lib/hooks/compound.mjs lets it
// through when every side of it is a command these rules already hold. And when a session starts
// a subagent, lib/hooks/subagent.mjs hands it `customization/common.md`, which it would otherwise
// never see. Mechanism, not rules — they grant nothing the list above does not — so an update wires
// each into settings that lack it (`wireHooks`), where it adds no rule. Both run on the toolkit's
// own node (lib/hooks/run.sh), never on one the machine has.
//
// And the harness's attribution is off. Left to itself Claude Code asks every session to end each
// commit with a `Co-Authored-By` trailer naming the model, each pull request with a "Generated
// with" line, and a commit made from a cloud session with a link to it. A commit here is the
// seat's, made as the User asked, and what it says is the message and nothing else; so the three
// are turned off by the one key that governs them (`attribution`: an empty `commit` and `pr`, and
// `sessionUrl` false), and an update turns them off in settings that have no `attribution` at all
// (`turnAttributionOff`) — a file that has one, whatever it says, is the person's.
export const ATTRIBUTION = { commit: "", pr: "", sessionUrl: false };

// The defaults in one list, from the one table the cards after an update are asked from, so a rule
// a fresh instance is born with is a rule an older one is asked for.
function defaultsIn(list) {
  return DEFAULT_RULES.filter((group) => group.list === list).flatMap((group) => group.rules);
}

function settingsToStartWith(leader) {
  return {
    permissions: {
      allow: [...defaultsIn("allow"), ...deskRules(leader)],
      deny: defaultsIn("deny"),
      ask: defaultsIn("ask"),
    },
    hooks: { PreToolUse: [HOOK_ENTRY], SubagentStart: [SUBAGENT_HOOK_ENTRY] },
    attribution: ATTRIBUTION,
  };
}

// The settings as they are, or null for a file that is there and cannot be read as JSON: what an
// update does to the person's settings is add one thing to what it read, and a file it could not
// read is one it would be writing over, not adding to.
function settingsReadable(root) {
  if (!fs.existsSync(settingsFile(root))) {
    return {};
  }
  try {
    const read = JSON.parse(fs.readFileSync(settingsFile(root), "utf8"));
    return typeof read === "object" && read !== null && !Array.isArray(read) ? read : null;
  } catch {
    return null;
  }
}

// Each hook, by the event it runs on, and the test that says whether settings carry it.
const HOOKS = [
  ["PreToolUse", HOOK_ENTRY, hookWired],
  ["SubagentStart", SUBAGENT_HOOK_ENTRY, subagentHookWired],
];
export function hooksWired(settings) {
  return HOOKS.every(([, , wired]) => wired(settings));
}

// The commands the hooks were wired with while they ran on whatever `node` the session's PATH had.
// Settings that still carry one run that hook twice once the current one is wired beside it, the
// second time on the machine's node, so an update takes each of them out.
const RETIRED_HOOK_COMMANDS = ['node "${CLAUDE_PROJECT_DIR}/lib/hooks/compound.mjs"', 'node "${CLAUDE_PROJECT_DIR}/lib/hooks/subagent.mjs"'];
const retired = (hook) => RETIRED_HOOK_COMMANDS.includes(hook?.command);

// One event's entries without a retired hook: an entry that held nothing else goes with it, and an
// entry that held one of the person's own beside it keeps theirs.
function withoutRetired(entries) {
  if (!Array.isArray(entries)) {
    return entries;
  }
  return entries.flatMap((entry) => {
    if (!Array.isArray(entry?.hooks) || !entry.hooks.some(retired)) {
      return [entry];
    }
    const kept = entry.hooks.filter((hook) => !retired(hook));
    return kept.length === 0 ? [] : [{ ...entry, hooks: kept }];
  });
}

function carriesRetired(settings) {
  const hooks = settings?.hooks;
  return typeof hooks === "object" && hooks !== null && Object.values(hooks).some((entries) => Array.isArray(entries) && entries.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some(retired)));
}

// The hooks into settings that have not got them, each after whatever that event already runs,
// and a hook wired by a retired command taken out; the rest of the file left as it is. Answers with
// what it wrote: the settings file, or nothing when every hook was there and none retired, or the
// file is not ours to read (`hooksWired(readSettings(root))` tells the two apart).
export function wireHooks(root) {
  const settings = settingsReadable(root);
  if (settings === null || (hooksWired(settings) && !carriesRetired(settings))) {
    return [];
  }
  const hooks = {};
  if (typeof settings.hooks === "object" && settings.hooks !== null) {
    for (const [event, entries] of Object.entries(settings.hooks)) {
      hooks[event] = withoutRetired(entries);
    }
  }
  for (const [event, entry, wired] of HOOKS) {
    if (!wired(settings)) {
      hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), entry];
    }
  }
  return writeSettings(root, { ...settings, hooks });
}

// Whether settings say anything about attribution. Any `attribution` at all is a decision the
// person made — theirs to keep, whatever it says.
export function attributionSet(settings) {
  return typeof settings === "object" && settings !== null && "attribution" in settings;
}

// The attribution off in settings that say nothing about it, the rest of the file left as it is.
// Answers the way `wireHooks` does: the settings file it wrote, or nothing when the file already
// says something about attribution or is not ours to read.
export function turnAttributionOff(root) {
  const settings = settingsReadable(root);
  if (settings === null || attributionSet(settings)) {
    return [];
  }
  return writeSettings(root, { ...settings, attribution: ATTRIBUTION });
}

// The rules a fresh instance is born with that these settings hold in none of their three lists
// and the User has not ignored, each as `{ list, rule, why }`: the list it is born in, and what the
// card that asks for it says. Nothing here adds one: what a workspace allows is its owner's, so the
// server asks on a card at every start (lib/chat/server.mjs, `askDefaults`) and the press decides.
// A rule held in another list than the one it is born in is a decision already taken, and a rule
// taken out is asked again, since the card is where the owner says no.
export function rulesMissing(root) {
  const settings = settingsReadable(root);
  if (settings === null) {
    return [];
  }
  const held = LISTS.flatMap((list) => (Array.isArray(settings.permissions?.[list]) ? settings.permissions[list].map(String) : []));
  const ignored = defaultsIgnored(root);
  return DEFAULT_RULES.flatMap(({ list, rules, why }) =>
    rules.filter((rule) => !held.includes(rule) && !ignored.some((entry) => entry.list === list && entry.rule === rule)).map((rule) => ({ list, rule, why })),
  );
}

// The defaults the User pressed Ignore on, as the file holds them; none when there is no file or
// it is not a list. Unreadable is not ignored: the card comes back, which a person can answer again.
export function defaultsIgnored(root) {
  let held;
  try {
    held = JSON.parse(fs.readFileSync(path.join(root, IGNORED_DEFAULTS), "utf8"));
  } catch {
    return [];
  }
  return Array.isArray(held) ? held.filter((entry) => typeof entry?.list === "string" && typeof entry?.rule === "string") : [];
}

// One default ignored for good. Once: the same press twice is one entry.
export function ignoreDefault(root, { list, rule }) {
  const held = defaultsIgnored(root);
  if (held.some((entry) => entry.list === list && entry.rule === rule)) {
    return [];
  }
  const file = path.join(root, IGNORED_DEFAULTS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, asJson([...held, { list, rule }]), { mode: PRIVATE_FILE });
  fs.chmodSync(file, PRIVATE_FILE);
  return [file];
}

// The mirror: rules these settings hold that a fresh instance is no longer born with, each spelt
// as it stands in the file. An update says them and removes none, for the same reason it adds
// none. Today that is the one rule that refused the desk file to the file tools.
export function rulesStale(root) {
  const settings = settingsReadable(root);
  if (settings === null) {
    return [];
  }
  const deny = Array.isArray(settings.permissions?.deny) ? settings.permissions.deny.map(String) : [];
  return STALE_DENY_RULES.filter((rule) => deny.includes(rule)).map((rule) => `deny ${rule}`);
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
  return [
    ...seed(homeSettingsFile(root), () => asJson(HOME_SETTINGS)),
    ...seed(deskFile(root, leader), () => render("desk", readTemplate(root, "desk", DESK_TEMPLATE), { NAME: leader })),
    ...seed(settingsFile(root), () => asJson(settingsToStartWith(leader))),
  ];
}
