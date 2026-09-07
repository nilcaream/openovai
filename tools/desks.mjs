// Opening a desk for somebody.
//
// A person in an instance is three things on disk: a desk to keep their state on, a persona
// saying who they are, and the one permission rule that lets them write that desk. The installer
// opens the lead's when it creates the instance; `ovai hire` opens a worker's afterwards. Both come
// through here, so there is one answer to what a person is made of rather than two that can
// drift apart.

import fs from "node:fs";
import path from "node:path";

import { readSettings, writeSettings } from "./settings.mjs";

// A name becomes a directory under work/ and an address other sessions type, so it stays
// short, starts with a letter and holds nothing a shell or a path would read as syntax.
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

// Model identifiers are aliases or full names, never paths. It is written down here rather than
// beside the installer because two things name a model now — installing a workspace, and hiring
// somebody onto one that is not the usual one — and two patterns would be two answers to what a
// model identifier is, the day one of them was widened.
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// A desk is a person: one directory, holding the one file a replacement session reads before
// it does anything else.
export const WORK = "work";
export const DESK_FILE = "STATE.md";
export const DESK_TEMPLATE = path.join("templates", "STATE.md");

// What somebody runs on, when it is not what this workspace runs its workers on. One word, in one
// file beside the desk, written only when a model was named: absent is the whole of "the usual
// one", so a workspace that has never named one has nothing on disk and nothing to migrate.
//
// Beside the desk rather than inside it. The one thing a session is allowed to write is its own
// STATE.md, so a model kept in that file would be a model the session could raise for itself — and
// a header field nobody told it to keep is a field it drops the first time it rewrites one.
export const MODEL_FILE = "MODEL";

// A worker's persona, before the name is written into it. It lives beside the desk template
// rather than with either caller, because hiring now happens from two places — the command and
// the chat's route — and a template named in both would be one word in two files.
export const WORKER_TEMPLATE = path.join("templates", "worker.md");

// One persona file per session, named after the session. The names are written into it rather
// than looked up when it is read, so the file says "You are Superman, Mike's lead" outright.
export const PERSONAS = "personas";

// What every session in the instance may do to reach the others: call the tools the chat serves
// it. One rule serves everybody, because these settings are the instance's rather than anybody's
// in particular — the same reason there is one file and not one per desk.
//
// One rule for the server and not one per tool, because that is the only shape there is: a
// permission rule can name a server and a tool, never an argument. So a tool is granted the moment
// the chat offers it, which is why what the chat offers is decided rather than added to.
//
// It replaces the pair of rules each of these commands used to need — a rule is a literal prefix
// rather than a path, so `ovai say …` and `./bin/ovai say …` were two different rules for one command,
// and a session that typed the other spelling stopped to be approved for doing as it was told.
export const TOOL_RULES = ["mcp__openovai"];

// Everything else this workspace allows, and who asked for it. It sits beside the settings and is
// written whenever a rule is granted that is nobody's desk and not the rule above.
export const LEDGER = path.join(".claude", "allowed.md");

const LEDGER_OPENING = [
  "# What this workspace allows beyond a desk",
  "",
  "One line per rule. Every one of them is something a person was asked about and said yes to,",
  "and it says who, when, and what they were doing at the time. A rule in the settings with no",
  "line here is a grant nobody can account for.",
  "",
  "",
].join("\n");


// Something is wrong with a name, a template or a file we were asked to write. The caller says
// which command it happened under, so this carries only the reason.
export class DeskError extends Error {}

export function isName(value) {
  return typeof value === "string" && NAME_PATTERN.test(value);
}

export function describeName(flag, value) {
  return `${flag} must start with a letter and hold only letters, digits, '-' or '_' (got ${JSON.stringify(value)})`;
}

export function isModel(value) {
  return typeof value === "string" && MODEL_PATTERN.test(value);
}

// Said the same way wherever a model is refused, and never with a list of the models there are.
// A list is a table somebody has to keep true as the service renames things, and a workspace that
// may be installed on a model has to be able to hire onto it.
//
// It states the rule rather than the verdict, the way the name sentence next to it does. "Is not a
// model identifier" tells somebody their value is wrong and leaves them to guess what a right one
// looks like — and the one thing this sentence must not do is send them looking for a list.
export function describeModel(flag, value) {
  return `${flag} must start with a letter or digit and hold only letters, digits, '.', '-' or '_' (got ${JSON.stringify(value)})`;
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

export function modelFile(root, name) {
  return path.join(root, WORK, name, MODEL_FILE);
}

// What this desk was hired onto, or nothing at all.
//
// Read rather than checked. The only thing that writes it refuses anything that is not a model
// identifier before a byte of the desk exists, and a file somebody edited by hand afterwards is
// that person's own choice — one Claude Code answers in a line on stderr, which is the stream a
// panel already shows.
//
// Empty is absent. A file holding nothing but whitespace is a desk that has said nothing, and the
// honest reading of saying nothing is the reading of a file that was never written.
function recordedModel(root, name) {
  let said;
  try {
    said = fs.readFileSync(modelFile(root, name), "utf8").trim();
  } catch {
    return null;
  }
  return said === "" ? null : said;
}

// Which model a session runs on. A workspace is installed with one for the session that leads and
// one for everybody else, and hiring may name another for one person — so the desk is asked first
// and the workspace's own answer is what everybody who was never named one gets.
//
// That second half is what keeps the installed model a default rather than a seed. Nothing is
// written down for somebody hired the usual way, so a workspace that changes what its workers run
// on changes what every one of them runs on, from their next message.
export function modelFor(root, name, config) {
  return recordedModel(root, name) ?? (name === config.leader ? config.models.leader : config.models.worker);
}

// What the person at this desk is on, from the header their desk file opens with.
//
// A desk is a whole document and most of it is prose nobody else can read usefully. The header is
// therefore one line holding one field — the `title:` — which is the whole of what anything
// outside the desk reads. It is the field the personas name and the field a turn asks for, so what
// is written and what is read cannot drift apart, and there is no second field for a session to
// keep true for nobody.
//
// A header holding more than that still reads, which is what lets a desk written before this go on
// being understood: the fields are separated, and this takes the one it came for.
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

// Where a desk goes when the person at it has left. Beside work/ rather than inside it: work/ is
// a directory listing and that listing IS the roster, so a directory in there is somebody who works
// here. work/ is who works here, archive/ is who has.
//
// It is made when the first person leaves. An instance nobody has left has nothing to put in one.
export const ARCHIVE = "archive";

export function personaFile(root, name) {
  return path.join(root, PERSONAS, `${name}.md`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// A title, as much of it as belongs in a directory name. Everything that is not a letter or a digit
// becomes a separator, because a name that has to be quoted to be typed is a name that gets typed
// wrong.
function slug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

// Where this desk would be filed, made ready to be filed into.
//
// The name carries the day, the person and what the desk was on, because those are the three things
// somebody looking for it later has. A desk that never said what it was on is filed under the day
// and the name alone — the same answer everything else here gives to an empty title, which is to
// say nothing rather than to guess.
//
// A name already taken gets a number after it. Two people of one name leaving on one day with one
// title is unlikely; two records quietly written into one directory is not a way to find that out.
//
// The directory is made here, before anything is moved, so that whoever is filing can say where the
// desk is going while the panel it is going with is still being written to.
export function archiveFor(root, name) {
  const said = slug(deskTitle(root, name));
  const base = `${today()}-${name}${said === "" ? "" : `-${said}`}`;

  let at = path.join(root, ARCHIVE, base);
  for (let next = 2; fs.existsSync(at); next += 1) {
    at = path.join(root, ARCHIVE, `${base}-${next}`);
  }

  fs.mkdirSync(at, { recursive: true });
  // Said relatively, because it is said on a panel and written into an instance that holds no
  // absolute path anywhere.
  return { at, where: path.posix.join(ARCHIVE, path.basename(at)) };
}

// Close a desk: the desk file and the panel are filed under `at`, and everything that made this a
// person here is taken away.
//
// A desk is one file by design — the only thing an instance lets a session write is its own
// STATE.md — so this files what a desk is rather than sweeping the directory, and takes the
// directory itself away afterwards.
export function retire(root, name, at, panel) {
  const filed = [];
  for (const source of [deskFile(root, name), panel]) {
    if (!fs.existsSync(source)) {
      continue;
    }
    const target = path.join(at, path.basename(source));
    fs.renameSync(source, target);
    filed.push(target);
  }

  fs.rmSync(path.join(root, WORK, name), { recursive: true, force: true });
  fs.rmSync(path.dirname(panel), { recursive: true, force: true });

  // The persona is not filed with the desk. It is the worker template with a name written into it
  // and says nothing about what was done here, so it is reproducible and it names somebody who does
  // not work here any more.
  fs.rmSync(personaFile(root, name), { force: true });
  withdrawDesk(root, name);
  return filed;
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
  fs.writeFileSync(target, render("desk", template, { NAME: name }));
  return [target];
}

// One word and a newline. There is no shape to get wrong, nothing to half-parse, and a file that
// reads the same whether or not an editor put a newline on the end of it.
export function writeModel(root, name, model) {
  const target = modelFile(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${model}\n`);
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

// And taking that right back, when the desk it names is not there any more. A rule for a desk
// nobody has is a grant nobody can account for — `tests/inspect.mjs` reads the settings as "one
// rule per desk and nothing wider", so leaving one behind is not untidiness, it is the instance no
// longer being able to say what it allows and why.
export function withdrawDesk(root, name) {
  const settings = readSettings(root);
  const granted = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  const rule = `Edit(${path.posix.join(WORK, name, DESK_FILE)})`;
  if (!granted.includes(rule)) {
    return [];
  }

  return writeSettings(root, {
    ...settings,
    permissions: { ...settings.permissions, allow: granted.filter((entry) => entry !== rule) },
  });
}

// Opening a worker's desk: everything a person is made of, written at once, or nothing written
// at all because one of the reasons not to came first.
//
// It is here rather than in either caller because there are two of them — `ovai hire` and the
// chat's route, which the page's Hire button posts to — and two copies of what a name is refused
// for would be two answers to the same question the day one of them changed. The refusals are
// values and not printed lines for the same reason: the command puts them on stderr, the route
// answers 400 with them, and neither has an opinion about the wording.
//
// The panel directory is handed in rather than worked out here, as `retire` takes it: how a chat
// lays its directories out is the chat's word, and a second module spelling it would be a word in
// two places.
//
// The templates are read from the instance and not from wherever it was installed from, which is
// what lets an instance open a desk on a machine the source was never on.
//
// The model is the last argument and it is optional, because leaving it out is the answer nearly
// every time: somebody hired without a word about it runs on what this workspace runs its workers
// on, and goes on doing so if that is ever changed.
//
// It is refused before the desk is looked at and long before anything is written, so a model that
// is not one leaves nothing behind — no desk, no persona, no rule, and no name taken by a person
// who was never opened one.
export function hire(root, name, panel, { human, leader }, model = null) {
  if (!isName(name)) {
    throw new DeskError(describeName("a worker name", name));
  }
  if (model !== null && !isModel(model)) {
    throw new DeskError(describeModel("a model", model));
  }
  if (fs.existsSync(deskFile(root, name))) {
    throw new DeskError(`${name} already has a desk here`);
  }

  // A name is more than its desk. The chat keeps a panel and a thread under the same name, and a
  // desk opened over the top of those is a new person answering out of somebody else's
  // conversation, with somebody else's transcript on their panel — which looks like a fresh start
  // until the first reply.
  //
  // Refused rather than cleared away: what is in there is a record somebody may want, and a
  // command that deletes one to get its own job done is worse than the surprise it is fixing.
  if (fs.existsSync(panel)) {
    throw new DeskError(
      `${name} has left a conversation here; move or remove ${path.relative(root, panel)} before hiring that name again`,
    );
  }

  return [
    ...writeDesk(root, root, name),
    ...writePersona(root, root, name, "worker", WORKER_TEMPLATE, { NAME: name, HUMAN: human, LEADER: leader }),
    // Only when one was named. Writing the workspace's own model into every desk would freeze
    // today's answer onto each person and turn a live setting into a seed nothing reads afterwards
    // — a workspace that changed it and saw nobody move would have a setting that lies.
    ...(model === null ? [] : writeModel(root, name, model)),
    ...allowDesk(root, name),
  ];
}

// Granting something wider than the two kinds this workspace hands out by itself, and writing
// down who asked for it in the same act.
//
// The line first and the rule second. If only one of the two can happen, the workspace is better
// off accounting for a rule it does not hold than holding one nothing accounts for: the first is
// noticed by anything that reads the pair, and the second is what twenty-six rules in a workspace
// nobody can explain look like.
//
// Nothing happens twice. The same shape allowed again is one rule and one line, because the second
// press is a person answering the same question rather than a second decision.
export function allowAsked(root, { rule, session, call, day }) {
  return [...account(root, { rule, session, call, day }), ...allow(root, rule)];
}

// The file a person reads to find out what this workspace allows beyond a desk. One line per rule:
// the rule in backticks first, so it can be read off the line, and then who asked for it, when, and
// what they were doing at the time.
//
// Beside the settings rather than inside them: `.claude/settings.json` has a shape Claude Code
// owns, and a key of ours in it is a key we would be guessing about.
export function account(root, { rule, session, call, day }) {
  const file = path.join(root, LEDGER);
  const held = readLedger(root);
  if (held !== null && held.includes(`- \`${rule}\` `)) {
    return [];
  }

  // Appended to whatever is there, byte for byte. Somebody reading this file writes in it — a
  // sentence about why a rule is there, a heading of their own — and a writer that rebuilt the
  // file from the lines it recognised would quietly throw all of that away.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = held === null ? LEDGER_OPENING : held.endsWith("\n") ? held : `${held}\n`;
  fs.writeFileSync(file, `${text}- \`${rule}\` — ${session}, ${day}, for ${asked(call)}\n`);
  return [file];
}

function readLedger(root) {
  try {
    return fs.readFileSync(path.join(root, LEDGER), "utf8");
  } catch {
    return null;
  }
}

// What the call was, in one line of a file somebody reads. A command is free text and can hold a
// newline or a backtick, either of which would end the line early and leave the rest of it being
// read as a rule of its own.
function asked(call) {
  const said = String(call ?? "").replaceAll(/[`\s]+/g, " ").trim();
  const short = said.length > 80 ? `${said.slice(0, 79)}…` : said;
  return short === "" ? "a call it did not describe" : `\`${short}\``;
}

// The right to use the tools the chat serves, saying something to another session among them.
// Granted once, when the instance is made, rather than per person: it names no desk, so a second
// copy of it would grant nothing a first one had not.
export function allowTools(root) {
  return TOOL_RULES.flatMap((rule) => allow(root, rule));
}

