// What admin mode leaves behind: `admin.json` at the instance root, written by `ovai claude` when
// the door closes and read by the server — on its periodic look while it runs, and at its next
// start when it did not.
//
// The Leader has to know that admin mode ran, and what it changed, because a permission rule that
// moved or a connector that arrived changes what it may hand a Worker. The obvious way of telling
// it — a route on the running server — fails exactly when the server is not running, which is when
// admin work is likeliest. So nothing crosses a process boundary here but a file: the command
// leaves a record at the root, beside `runtime.json` and for the same reason, and a running server
// notices it within seconds, a stopped one at its start.
//
// What the record carries is when the session ended, which configuration files changed by name,
// and what moved inside them — as names. The configuration is read into a snapshot when the door
// opens and again when it closes, and the snapshot holds names and structure only: which
// marketplaces, which plugins and whether each is on, which skills, which MCP servers at which
// scope, which permission rules, and which other keys differ. Never a value: an MCP server's
// command, url, headers and env, a marketplace's source, an account's oauth record — every one of
// them can hold a secret, and none of them is taken.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { HOME } from "./claude.mjs";
import { mask } from "./mask.mjs";
import { SETTINGS_FILE } from "./settings.mjs";

export const ADMIN_FILE = "admin.json";

const ACCOUNT_SETTINGS = path.join(HOME, "settings.json");
const ACCOUNT_RECORD = path.join(HOME, ".claude.json");
const PROJECT_MCP = ".mcp.json";

// The configuration admin mode exists to change, named from the instance root: the account's
// settings, where `/plugin` records what is enabled; the account's own record, where `mcp add`
// writes the user and local scopes; the permission rules every seat in this instance obeys; and
// the project's MCP file. The plugin directory is read for the snapshot but not fingerprinted: it
// is a tree and not a single readable path.
export const WATCHED = Object.freeze([ACCOUNT_SETTINGS, ACCOUNT_RECORD, SETTINGS_FILE, PROJECT_MCP]);

// The settings files whose permission rules and other keys are compared, one by one.
const SETTINGS = Object.freeze([ACCOUNT_SETTINGS, SETTINGS_FILE]);

// The keys of a settings file that are compared by their parts rather than as a whole.
const STRUCTURED = new Set(["permissions", "enabledPlugins", "extraKnownMarketplaces"]);

const RULE_KINDS = Object.freeze(["allow", "ask", "deny"]);

function file(root) {
  return path.join(root, ADMIN_FILE);
}

// What each watched file is right now: its contents hashed, or null where there is no such file.
// A hash and not a timestamp, so a file rewritten with exactly what it already said is not a
// change; a null and not an absence, so a file created and a file removed are both differences.
export function fingerprint(root) {
  const taken = {};
  for (const name of WATCHED) {
    try {
      taken[name] = hash(fs.readFileSync(path.join(root, name)));
    } catch {
      taken[name] = null;
    }
  }
  return taken;
}

// The names whose fingerprint differs, in the order `WATCHED` names them.
export function changedBetween(before, after) {
  return WATCHED.filter((name) => (before[name] ?? null) !== (after[name] ?? null));
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// A JSON object from a file under the root, or an empty one: a file missing, unreadable or of
// another shape has nothing in it to name.
function objectIn(root, name) {
  try {
    const read = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    return isObject(read) ? read : {};
  } catch {
    return {};
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysOf(value) {
  return isObject(value) ? Object.keys(value) : [];
}

function namesIn(list) {
  return Array.isArray(list) ? list.filter((one) => typeof one === "string") : [];
}

function directoriesIn(root, name) {
  try {
    return fs
      .readdirSync(path.join(root, name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// The configuration as names. Each part says where it is read and what is dropped:
//
// - marketplaces: the keys of the plugin directory's `known_marketplaces.json` and of
//   `extraKnownMarketplaces` in each settings file. The source is dropped: a git URL can carry a
//   token.
// - plugins: "name@marketplace" → "enabled", "disabled" or "installed", from the plugin
//   directory's `installed_plugins.json` and `enabledPlugins` in each settings file (the project's
//   settings read last, so they win, as they do in Claude Code). Paths, versions and dates dropped.
// - skills: the directory names under the account's `skills/`.
// - mcp: server name → its scopes, from `mcpServers` in the account's record (user), in the
//   account's record for this project (local) and in `.mcp.json` (project). Command, args, url,
//   headers, env and oauth are dropped, all of them.
// - connectors: the claude.ai connector names the account's record lists as ever connected.
// - rules: per settings file, each permission rule as "allow Bash(npm:*)". Kept: a rule is a
//   pattern the person wrote to say what a seat may do, and it is what the Leader must know —
//   masked (`mask.mjs`), since a rule allowed from a card is the whole command, token and all.
// - settings: per settings file and `.mcp.json`, every other top-level key → a hash of its value,
//   so a key is named when it changed and nothing of what it holds is. `permissions` keys other
//   than the rules count as their own keys, `permissions.defaultMode` and the like. The account's
//   record gives no such keys: it is Claude Code's own state store, rewritten with caches, dates
//   and the account's oauth record every session, and only its MCP parts are admin mode's.
export function snapshot(root) {
  const plugins = path.join(HOME, "plugins");
  const account = objectIn(root, ACCOUNT_RECORD);
  const project = objectIn(root, PROJECT_MCP);
  const settings = Object.fromEntries(SETTINGS.map((name) => [name, objectIn(root, name)]));

  const marketplaces = new Set(keysOf(objectIn(root, path.join(plugins, "known_marketplaces.json"))));
  const installed = {};
  for (const name of keysOf(objectIn(root, path.join(plugins, "installed_plugins.json")).plugins)) {
    installed[name] = "installed";
  }
  for (const name of SETTINGS) {
    keysOf(settings[name].extraKnownMarketplaces).forEach((one) => marketplaces.add(one));
    const enabled = settings[name].enabledPlugins;
    for (const plugin of keysOf(enabled)) {
      installed[plugin] = enabled[plugin] === true ? "enabled" : "disabled";
    }
  }

  const mcp = {};
  const scoped = [
    ["user", account.mcpServers],
    ["local", keysOf(account.projects).includes(path.resolve(root)) ? account.projects[path.resolve(root)].mcpServers : undefined],
    ["project", project.mcpServers],
  ];
  for (const [scope, servers] of scoped) {
    for (const name of keysOf(servers)) {
      mcp[name] = [...(mcp[name] ?? []), scope];
    }
  }

  const rules = {};
  const other = {};
  for (const name of SETTINGS) {
    const read = settings[name];
    rules[name] = RULE_KINDS.flatMap((kind) => namesIn(read.permissions?.[kind]).map((rule) => `${kind} ${mask(rule)}`));
    other[name] = {};
    for (const key of Object.keys(read)) {
      if (!STRUCTURED.has(key)) {
        other[name][key] = hash(JSON.stringify(read[key]));
      }
    }
    for (const key of keysOf(read.permissions)) {
      if (!RULE_KINDS.includes(key)) {
        other[name][`permissions.${key}`] = hash(JSON.stringify(read.permissions[key]));
      }
    }
  }
  other[PROJECT_MCP] = {};
  for (const key of Object.keys(project)) {
    if (key !== "mcpServers") {
      other[PROJECT_MCP][key] = hash(JSON.stringify(project[key]));
    }
  }

  return {
    marketplaces: [...marketplaces].sort(),
    plugins: installed,
    skills: directoriesIn(root, path.join(HOME, "skills")).sort(),
    mcp,
    connectors: namesIn(account.claudeAiMcpEverConnected).sort(),
    rules,
    settings: other,
  };
}

function added(before, after) {
  return after.filter((one) => !before.includes(one));
}

// What moved between two snapshots, as the sentences the Leader reads, one per kind of change and
// only for the kinds that moved. Empty when nothing did.
export function differences(before, after) {
  const said = [];
  const say = (what, names) => {
    if (names.length > 0) {
      said.push(`${what}: ${names.join(", ")}`);
    }
  };

  say("marketplaces added", added(before.marketplaces, after.marketplaces));
  say("marketplaces removed", added(after.marketplaces, before.marketplaces));

  const was = before.plugins;
  const now = after.plugins;
  say("plugins installed", Object.keys(now).filter((name) => !(name in was)).sort().map((name) => `${name} (${now[name]})`));
  say("plugins removed", Object.keys(was).filter((name) => !(name in now)).sort());
  say("plugins enabled", Object.keys(now).filter((name) => name in was && was[name] !== now[name] && now[name] === "enabled").sort());
  say("plugins disabled", Object.keys(now).filter((name) => name in was && was[name] !== now[name] && now[name] === "disabled").sort());

  say("skills added", added(before.skills, after.skills));
  say("skills removed", added(after.skills, before.skills));

  const scopes = (names) => names.join(" and ");
  say("MCP servers added", Object.keys(after.mcp).filter((name) => !(name in before.mcp)).sort().map((name) => `${name} (${scopes(after.mcp[name])} scope)`));
  say("MCP servers removed", Object.keys(before.mcp).filter((name) => !(name in after.mcp)).sort().map((name) => `${name} (${scopes(before.mcp[name])} scope)`));
  say(
    "MCP servers that changed scope",
    Object.keys(after.mcp)
      .filter((name) => name in before.mcp && scopes(before.mcp[name]) !== scopes(after.mcp[name]))
      .sort()
      .map((name) => `${name} (${scopes(before.mcp[name])} → ${scopes(after.mcp[name])})`),
  );

  say("claude.ai connectors connected", added(before.connectors, after.connectors));
  say("claude.ai connectors no longer listed", added(after.connectors, before.connectors));

  for (const name of Object.keys(after.rules)) {
    say(`permission rules added in ${name}`, added(before.rules[name] ?? [], after.rules[name]));
    say(`permission rules removed in ${name}`, added(after.rules[name], before.rules[name] ?? []));
  }

  for (const name of Object.keys(after.settings)) {
    const then = before.settings[name] ?? {};
    const today = after.settings[name];
    const keys = [...new Set([...Object.keys(then), ...Object.keys(today)])].filter((key) => then[key] !== today[key]).sort();
    say(`other settings changed in ${name}`, keys);
  }
  return said;
}

// Written whether or not anything changed: that admin mode ran at all is the thing the Leader is
// owed, and an empty list is an answer rather than a reason to stay quiet.
export function record(root, { ended, changed, moved }) {
  const target = file(root);
  fs.writeFileSync(target, `${JSON.stringify({ ended, changed, moved }, null, 2)}\n`);
  return target;
}

// The record as written — { ended, changed, moved } — or null when there is none worth reading.
// Anything unreadable answers null too, the way `runtime.mjs` does: a server with no notice to
// pass on and a server that found half a file say the same thing, and a half-written file is not
// worth a different sentence.
export function recorded(root) {
  let read;
  try {
    read = JSON.parse(fs.readFileSync(file(root), "utf8"));
  } catch {
    return null;
  }

  if (typeof read?.ended !== "string" || !Array.isArray(read?.changed)) {
    return null;
  }
  return { ended: read.ended, changed: namesIn(read.changed), moved: namesIn(read.moved) };
}

// Removed once the notice has really reached the Leader, and never before — and only the record
// that notice was made from, named by its `ended`. The door can close again while the first
// notice is still held by the quota gate: the record then says the second close, and it waits for
// its own notice.
export function forget(root, ended) {
  if (recorded(root)?.ended === ended) {
    fs.rmSync(file(root), { force: true });
  }
}
