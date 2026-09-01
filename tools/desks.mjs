// Opening a desk for somebody.
//
// A person in an instance is three things on disk: a desk to keep their state on, a persona
// saying who they are, and the one permission rule that lets them write that desk. The installer
// opens the lead's when it creates the instance; `ow hire` opens a worker's afterwards. Both come
// through here, so there is one answer to what a person is made of rather than two that can
// drift apart.

import fs from "node:fs";
import path from "node:path";

// A name becomes a directory under work/ and an address other sessions type, so it stays
// short, starts with a letter and holds nothing a shell or a path would read as syntax.
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

// A desk is a person: one directory, holding the one file a replacement session reads before
// it does anything else.
export const WORK = "work";
export const DESK_FILE = "STATE.md";
export const DESK_TEMPLATE = path.join("templates", "STATE.md");

// One persona file per session, named after the session. The names are written into it rather
// than looked up when it is read, so the file says "You are Superman, Mike's lead" outright.
export const PERSONAS = "personas";

// What the instance lets a session do without being asked. A session that cannot write its own
// desk cannot keep it, and a workspace whose state files go stale is one that has to be explained
// out loud every time somebody new sits down.
//
// One rule, one file, one per desk. `Edit(...)` is the rule that governs every built-in tool that
// writes a file, the Write tool included; a `Write(...)` rule is never matched, so adding one
// would look like care and do nothing. The path is relative, which is what it means here because
// the chat starts Claude Code with the instance root as its working directory — and it keeps the
// instance free of absolute paths, so moving one does not quietly cost a session its hands.
export const SETTINGS_FILE = path.join(".claude", "settings.json");

// Something is wrong with a name, a template or a file we were asked to write. The caller says
// which command it happened under, so this carries only the reason.
export class DeskError extends Error {}

export function isName(value) {
  return typeof value === "string" && NAME_PATTERN.test(value);
}

export function describeName(flag, value) {
  return `${flag} must start with a letter and hold only letters, digits, '-' or '_' (got ${JSON.stringify(value)})`;
}

// Everybody who works in the instance, in the order a directory listing gives them. A desk is a
// person, so this is the roster: there is nothing else to register and nothing that can disagree
// with what is on disk.
export function desks(root) {
  try {
    return fs
      .readdirSync(path.join(root, WORK), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function deskFile(root, name) {
  return path.join(root, WORK, name, DESK_FILE);
}

export function personaFile(root, name) {
  return path.join(root, PERSONAS, `${name}.md`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Placeholders are {{NAME}}. Anything left unfilled is a mistake in the template rather than
// something to paper over, so say so instead of shipping the braces to an instance.
export function render(what, template, values) {
  const filled = template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.hasOwn(values, key) ? values[key] : match,
  );

  const missing = filled.match(/\{\{\w+\}\}/g);
  if (missing !== null) {
    throw new DeskError(`the ${what} template has placeholders nothing fills: ${[...new Set(missing)].join(", ")}`);
  }

  return filled;
}

// Templates are read from wherever the caller carries them: the installer reads the source it
// was pointed at, an instance reads the copy it was given.
export function readTemplate(from, what, relative) {
  const source = path.join(from, relative);
  try {
    return fs.readFileSync(source, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new DeskError(`the ${what} template is missing at ${source}`);
    }
    throw error;
  }
}

export function writeDesk(root, from, name) {
  const template = readTemplate(from, "desk", DESK_TEMPLATE);
  const target = deskFile(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, render("desk", template, { NAME: name, DATE: today() }));
  return [target];
}

export function writePersona(root, from, name, what, relative, values) {
  const template = readTemplate(from, what, relative);
  const target = personaFile(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, render(what, template, values));
  return [target];
}

// Grant one desk, leaving whatever is already granted alone. The installer writes the first rule
// into a file that is not there yet; hiring adds one to a file that is, and must not take
// anybody else's away doing it.
export function allowDesk(root, name) {
  const target = path.join(root, SETTINGS_FILE);
  const rule = `Edit(${path.posix.join(WORK, name, DESK_FILE)})`;

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    // No settings yet, or none we can read. Writing a fresh file is better than refusing to
    // open a desk over it.
  }

  const allow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  if (allow.includes(rule)) {
    return [];
  }

  const updated = { ...settings, permissions: { ...settings.permissions, allow: [...allow, rule] } };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(updated, null, 2)}\n`);
  return [target];
}
