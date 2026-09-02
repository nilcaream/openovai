// Opening a desk for somebody.
//
// A person in an instance is three things on disk: a desk to keep their state on, a persona
// saying who they are, and the one permission rule that lets them write that desk. The installer
// opens the lead's when it creates the instance; `ow hire` opens a worker's afterwards. Both come
// through here, so there is one answer to what a person is made of rather than two that can
// drift apart.

import fs from "node:fs";
import path from "node:path";

import { readSettings, writeSettings } from "./settings.mjs";

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

// What every session in the instance may do to reach the others: run the instance's own command
// to say something to one of them. One rule serves everybody, because these settings are the
// instance's rather than anybody's — the same reason there is one file and not one per desk.
//
// Both spellings of the same command, because the rule is a literal prefix rather than a path:
// `./bin/ow say …` is the same command as `bin/ow say …` and would match neither the other's rule.
// Telling a session which one to type works until the first time it types the other, and being
// asked to approve a command it was told to run is a worse answer than a second narrow rule.
export const SAY_RULES = ["Bash(bin/ow say:*)", "Bash(./bin/ow say:*)"];

// And the one that tells a session who the others are. The personas name it — a lead is told
// `bin/ow status` lists who works here — so without the rule a session stops and asks a person
// for a command the instance itself put in its hands, and waits there for as long as nobody is
// looking at that panel. It reads and changes nothing, which is why it can be granted outright
// where the rest of what a session might reach for cannot.
//
// Both spellings again, for the reason SAY_RULES gives: the rule is a literal prefix.
export const STATUS_RULES = ["Bash(bin/ow status:*)", "Bash(./bin/ow status:*)"];

// And the one that shows the lead the room: who is here, what each is on, which of them is
// answering and which is held up waiting. The lead's persona names it, and the standing rule is
// that a command a persona tells a session to run is granted when the instance is made — or the
// instance stops a session for doing as it was told, on a panel nobody may be looking at.
//
// It reads and changes nothing, which is what puts it in the same class as `status` rather than
// with everything else a session might reach for. Both spellings, same reason as above.
export const ROOM_RULES = ["Bash(bin/ow room:*)", "Bash(./bin/ow room:*)"];

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

// What the person at this desk is on, from the header their desk file opens with.
//
// A desk is a whole document and most of it is prose nobody else can read usefully. The header's
// `title:` is the one field of it that anything outside the desk reads, which is why the personas
// name that field and no other: one line, kept current as the work moves, and everything else in
// there stays the desk's own business.
//
// Nothing is guessed when it is not there. An empty title is a session that has not said what it
// is on, and saying nothing is the honest rendering of that — better than the first line of a
// document that was written for somebody else.
//
// It stops at the next `|`, which is the header's own separator, and at the comment's end, so a
// title written last does not swallow the rest of the line.
export function deskTitle(root, name) {
  let opening;
  try {
    opening = fs.readFileSync(deskFile(root, name), "utf8").split("\n")[0];
  } catch {
    return "";
  }

  const said = /\|\s*title:\s*([^|]*)/.exec(opening);
  return said === null ? "" : said[1].replace(/-->\s*$/, "").trim();
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

// Grant one thing, leaving whatever is already granted alone. The installer writes the first rule
// into a file that is not there yet; hiring adds one to a file that is, and must not take
// anybody else's away doing it.
function allow(root, rule) {
  const settings = readSettings(root);

  const granted = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  if (granted.includes(rule)) {
    return [];
  }

  return writeSettings(root, {
    ...settings,
    permissions: { ...settings.permissions, allow: [...granted, rule] },
  });
}

// The right to keep one desk. A session that cannot write its own desk cannot keep it, and a
// workspace whose state files go stale is one that has to be explained out loud every time
// somebody new sits down.
//
// One rule, one person. `Edit(...)` is the rule that governs every built-in tool that writes a
// file, the Write tool included; a `Write(...)` rule is never matched, so adding one would look
// like care and do nothing. The path in it is relative, which is what it means to Claude Code:
// the chat starts it with the instance root as its working directory.
export function allowDesk(root, name) {
  return allow(root, `Edit(${path.posix.join(WORK, name, DESK_FILE)})`);
}

// The right to say something to the others. Granted once, when the instance is made, rather than
// per person: it names no desk, so a second copy of it would grant nothing a first one had not.
export function allowSay(root) {
  return SAY_RULES.flatMap((rule) => allow(root, rule));
}

// The right to see who else works here. Granted once with the rest, for the same reason: it
// names no desk.
export function allowStatus(root) {
  return STATUS_RULES.flatMap((rule) => allow(root, rule));
}

// And the right to see what each of them is doing right now. Granted once with the rest, for the
// same reason again: it names no desk.
export function allowRoom(root) {
  return ROOM_RULES.flatMap((rule) => allow(root, rule));
}
