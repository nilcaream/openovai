// Opening a desk for somebody.
//
// A person in an instance is one directory, `desks/<Name>/`, and everything the instance holds
// about them is in it: the desk file a replacement session reads first, the persona the session was
// last started with, the conversation the chat kept for it — and whatever the session itself keeps
// there, because the directory is that session's working directory and the two permission rules
// that let it write there are granted with it. The installer opens the Leader's when it creates
// the instance; the Leader's `hire` tool opens a worker's afterwards. Both come through here, so
// there is one answer to what a person is made of rather than two that can drift apart.
//
// Who they are is not a copy made at install. A persona is rendered from the toolkit's templates
// the moment a session starts a conversation, and it is written into the desk directory then — so
// it is always the template the instance is running now, plus whatever the person at the instance
// has added to it (`persona` below), and never something an update would have to remember.
//
// One file is written only when it was asked for: `desks/<Name>/MODEL`, one word, when somebody was
// hired onto a model that is not the one this workspace runs its workers on. Absent is the whole of
// "the usual one", which is what keeps the installed model a setting rather than a seed — so there
// is nothing to carry over, and everybody who was never named one moves when it is changed. It is its
// own file rather than a line of the desk because the desk is the one file its session may write.

import fs from "node:fs";
import path from "node:path";

import { readSettings, writeSettings } from "./settings.mjs";

// A name becomes a directory under desks/ and an address other sessions type, so it stays
// short, starts with a letter and holds nothing a shell or a path would read as syntax.
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

// Model identifiers are aliases or full names, never paths. It is written down here rather than
// beside the installer because two things name a model now — installing a workspace, and hiring
// somebody onto one that is not the usual one — and two patterns would be two answers to what a
// model identifier is, the day one of them was widened.
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// A desk is a person: one directory under desks/, holding the one file a replacement session
// reads before it does anything else, and beside it everything else the instance keeps for that
// person. The listing of desks/ IS the roster.
export const DESKS = "desks";
export const DESK_FILE = "STATE.md";
export const DESK_TEMPLATE = path.join("lib", "templates", "STATE.md");

// The other two things a person's directory holds, both the chat's: the conversation it kept for
// that session, and the persona the session was last started with. Named here, with the desk,
// because a person is one directory now and what goes in it is one list — retiring a desk moves
// the directory whole, and nothing has to know the list to do it.
export const CONVERSATION_FILE = "conversation.json";
export const PERSONA_FILE = "persona.md";

// What somebody runs on, when it is not what this workspace runs its workers on. One word, in one
// file beside the desk, written only when a model was named: absent is the whole of "the usual
// one", so a workspace that has never named one has nothing on disk and nothing to carry over.
//
// Its own file rather than a line of the desk. The one thing a session is allowed to write is its
// own STATE.md, so a model kept in that file would be a model the session could raise for itself —
// and a header field nobody told it to keep is a field it drops the first time it rewrites one.
export const MODEL_FILE = "MODEL";

// The personas, before the names are written into them: one for the session that leads and one
// for everybody else. They are named here rather than with any caller, because a persona is
// rendered from two places — the chat, for every conversation it starts, and the tests, to read
// what a session is told — and a template named in both would be one word in two files.
export const LEADER_TEMPLATE = path.join("lib", "templates", "leader.md");
export const WORKER_TEMPLATE = path.join("lib", "templates", "worker.md");
// Admin mode's own, and it is beside these two rather than one of them: an admin is a person
// sitting in Claude Code with this instance's configuration around them, not a third kind of seat.
export const ADMIN_TEMPLATE = path.join("lib", "templates", "admin.md");

// The two roles, as every part of the instance spells them: what a template is chosen by, what a
// tool is offered to, what a seat is one of. Desks' own vocabulary, since a desk is what a role is
// given.
export const LEADER = "Leader";
export const WORKER = "Worker";

// What the person at the instance adds to a persona, one file per kind of session, read as it is
// and put after the template every time one is rendered. The templates are the toolkit's and are
// replaced by an update; these are the person's and are never touched by one — so an instruction
// written here is one that outlives every version, which is what an edit to a rendered persona
// could never be. Absent is the ordinary case, and it means the template alone.
export const CUSTOMIZATION = "customization";

// And the one thing every seat is stopped for: changing one of those files. They are the User's
// own lines, written once and outliving every version, so a session that would rewrite them waits
// for the User's press — the Leader included.
//
// Asked rather than refused, because a refusal is absolute: the call never reaches a panel, and
// the files could then be changed from nowhere inside the instance at all. Asked for every seat
// rather than for the Workers alone, because permissions here are one instance-wide list with no
// per-role mechanism — one settings file per root (lib/settings.mjs), every seat running in that
// root (lib/chat/session.mjs) — so "the Leader allowed, the Workers refused" is not expressible;
// a refusal for everybody plus a tool only the Leader is served is more machinery for the same
// result, and the result is a press either way.
//
// Spelt `Edit(...)` alone, like the rules for the three trees: that rule governs every built-in
// tool that writes a file, the Write tool included, so a `Write(...)` twin would refuse nothing
// more (measured, where the rules for a call stop are composed). The templates tell a Worker to
// propose a change and never write one; this is the backstop, not the instruction.
export const CUSTOMIZATION_ASK_RULES = [`Edit(/${CUSTOMIZATION}/**)`];

// What this workspace knows, as files rather than as a thing behind a tool: one flat directory of
// Markdown notes, one topic per file, written and edited by every seat with the file tools it
// already has. The two tools served over it read the files at every call and hold nothing of their
// own (lib/knowledge.mjs); the contract a note keeps is stated there and enforced in `validate`
// alone — the render below reads one file as bytes and never parses it.
export const KNOWLEDGE = "knowledge";

// The one note the framework itself knows by name: what every session here is handed at its start,
// the way the person's own files are. It is an ordinary note otherwise — same head, indexed and
// validated with the rest — and the Leader gathers it: the team, whom to heed, the business, the
// lingo, where things are, and which notes a newcomer reads first.
//
// A constant rather than a setting, because a session cannot be told to read a file whose name it
// would have to be told first, and a name that varied by instance is a name no template could say.
export const KNOWLEDGE_COMMON = "common.md";

// And the grant that makes it a shelf rather than a display case: every seat writes here, with the
// same one `Edit(...)` rule shape the three trees are given. Knowledge is written by whoever
// learnt the thing, at the moment they learnt it — a session that must ask before recording what
// it just measured records nothing, and the note is lost with the session.
export const KNOWLEDGE_RULES = [`Edit(/${KNOWLEDGE}/**)`];

// And the one file in that tree the grant stops at. The common note is framed into every session
// at its start, so a change to it reaches every seat rather than the one that made it, and the
// User is asked before it is made. The rule is narrower than the allow above and matches a file
// that allow already matches: the two lists overlap here on purpose, and the narrower ask is the
// one consulted.
export const KNOWLEDGE_ASK_RULES = [`Edit(/${KNOWLEDGE}/${KNOWLEDGE_COMMON})`];

// What every session in the instance may do to reach the others: call the tools the chat serves
// it. One rule serves everybody, because these settings are the instance's rather than anybody's
// in particular — the same reason there is one file and not one per desk.
//
// One rule for the server and not one per tool, because that is the only shape there is: a
// permission rule can name a server and a tool, never an argument. So a tool is granted the moment
// the chat offers it, which is why what the chat offers is decided rather than added to.
//
// And one rule for a server rather than for shell lines — a rule is a literal prefix rather than
// a path, so a command and its `./bin/` spelling are two rules for one thing, and a session that
// typed the other spelling stopped to be approved for doing as it was told.
export const TOOL_RULES = ["mcp__openovai"];

// And every session's file-read tool, for any file in the instance. Reading is how a session
// reaches its knowledge and every desk, and a workspace whose Leader can read any file here is
// what lets "reading is yours, doing is a Worker's" be a rule rather than a hope.
// Anchored at the instance root, the way every path rule here is, so it grants nothing outside
// it. Measured: a read under the instance goes through with no rule at all, so this changes no
// stop; it is the grant said out loud, where a person reading the settings looks for it.
export const READ_RULES = ["Read(/**)"];

// The three trees every session may write in, granted when the instance is made: what is kept to
// look at (`reference/`), what is worked on (`projects/`), and scratch (`temp/`). One `Edit(...)`
// rule for each: that rule governs every built-in tool that writes a file, the Write tool
// included, and a `Write(...)` rule matches nothing at all (measured, both ways, and said where
// the rules for a call stop are composed: lib/chat/permissions.mjs), so a file made and a file
// changed are both answered by the one rule rather than by a press.
//
// Anchored at the instance root with a leading `/`, like every path rule here. Claude Code reads
// a bare `dir/**` from the session's CURRENT directory, which moves with every `cd` a run makes
// (measured: a write under `temp/` went through from the root and stopped for a press once the
// run had stepped into a repository under `projects/`); `/dir/**` is read from the directory the
// settings file belongs to, the root, wherever the run is standing. Nothing outside it is granted.
//
// Which of the first two a thing goes in is the Leader's question to the User, asked on every
// clone — it is behaviour in the persona, not a difference in the grants: both are writable, so a
// Worker told to edit a reference is refused by nobody, and the persona is what keeps it from
// being told.
export const USER_TREES = ["reference", "projects", "temp"];

// A desk file is edited in place with the file tools like any other file under the desk
// directory (deskRules): a session changes the line that changed, and rewrites nothing. Only
// line 1 is the server's — the header, written through `write_desk` (writeDeskHeader) — and a
// header a file tool damaged is put back whole by the next write, the body kept. Earlier
// releases refused the file to every file tool; the rule they wrote is named here so an update
// can say it is stale — it is the owner's file, and the update removes nothing from it.
export const STALE_DENY_RULES = ["Edit(/desks/*/STATE.md)"];
export const TREE_RULES = USER_TREES.map((tree) => `Edit(/${tree}/**)`);

// The shell commands a seat works with, granted when the instance is made so that the ordinary
// day — a repository cloned, branched, staged and committed, files copied, moved, removed and
// compared, a script run, an archive made, a page fetched — raises no stop. The three below them
// are refused by rule: a push is the User's, and a rule that refuses it wins over the `git` rule
// that would let it through (Claude Code holds deny above allow). These are guidance for a seat
// that means well, not control over one that does not: a shell that runs `bash` runs anything.
//
// WHAT THEY ARE WORTH: a Bash rule is matched by the command, never by a directory, so these
// commands are free anywhere the seat can reach, not only under `projects/`. And it is matched
// from the command's first character, so a compound asks whatever its halves are (measured:
// `cd projects/x && git status` stopped with only `cd` and `git status` held). The Worker's persona
// says how to spell it: `cd projects/<repo>` once, alone, then plain commands.
export const SHELL_RULES = [
  "Bash(git:*)",
  "Bash(mkdir:*)",
  "Bash(cd:*)",
  "Bash(node:*)",
  "Bash(bash:*)",
  "Bash(sh:*)",
  "Bash(cp:*)",
  "Bash(mv:*)",
  "Bash(rm:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(tar:*)",
  "Bash(diff:*)",
  "Bash(cmp:*)",
  "Bash(sha256sum:*)",
  "Bash(grep:*)",
  "Bash(find:*)",
  "Bash(sed:*)",
  "Bash(awk:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(echo:*)",
  "Bash(chmod:*)",
  "Bash(touch:*)",
  "Bash(curl:*)",
  "Bash(npm:*)",
];
export const SHELL_DENY_RULES = ["Bash(git push:*)", "Bash(sudo:*)", "Bash(ssh:*)"];

// Everything else this workspace allows, and who asked for it. It sits beside the settings and is
// written whenever a rule is granted that is nobody's desk and not the rule above.
export const LEDGER = path.join(".claude", "allowed.md");

const LEDGER_OPENING = [
  "# What this workspace has settled",
  "",
  "One line per rule: the rule, the list it landed in (allow, deny or ask), and who asked for",
  "it, when, and what they were doing at the time. Every one of them is something a person was",
  "asked about and pressed a button on. A rule in the settings with no line here is one nobody",
  "can account for.",
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
//
// A directory nobody could be called is not somebody who works here. Hiring is not the only thing
// that writes in desks/: it is a directory on somebody's machine, and an editor opening the
// workspace, a copy made beside a desk or a tool of their own can all leave something in there.
// Whatever lands would otherwise be a person — a panel with a Leave button on it, a row in the
// room, a name the say tool accepts — and pressing that button on one of them puts away whatever
// the directory was holding.
//
// It is filtered here rather than at each of those, because this is the one read they all go
// through, and a roster that can disagree with itself is what a second answer would buy.
export function desks(root) {
  try {
    return fs
      .readdirSync(path.join(root, DESKS), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// The directory that is this person: everything the instance holds about them is in it.
export function deskDirectory(root, name) {
  return path.join(root, DESKS, name);
}

export function deskFile(root, name) {
  return path.join(deskDirectory(root, name), DESK_FILE);
}

export function modelFile(root, name) {
  return path.join(deskDirectory(root, name), MODEL_FILE);
}

export function conversationFile(root, name) {
  return path.join(deskDirectory(root, name), CONVERSATION_FILE);
}

export function personaFile(root, name) {
  return path.join(deskDirectory(root, name), PERSONA_FILE);
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

// The header, field by field. Line 1 of a desk is the server's: `<!-- DESK | title: … | status: … |
// updated: … -->`, and it is read and rewritten here and nowhere else. A field that is not there
// reads as empty; a header written before a field existed still reads, and one carrying a field
// this no longer knows reads without it and is rewritten without it — the body is never touched.
const HEADER = /^<!--\s*DESK\s*(\|.*)?-->\s*$/;
const HEADER_FIELDS = ["title", "status", "updated"];

export function deskHeader(root, name) {
  let opening;
  try {
    opening = fs.readFileSync(deskFile(root, name), "utf8").split("\n")[0];
  } catch {
    return null;
  }
  return parseHeader(opening);
}

function parseHeader(opening) {
  if (!HEADER.test(opening)) {
    return null;
  }
  const fields = {};
  for (const field of HEADER_FIELDS) {
    const said = new RegExp(`\\|\\s*${field}:\\s*([^|]*)`).exec(opening);
    fields[field] = said === null ? "" : said[1].replace(/-->\s*$/, "").trim();
  }
  return fields;
}

export function renderHeader(fields) {
  const value = (field) => (fields[field] === undefined || fields[field] === "" ? `${field}:` : `${field}: ${fields[field]}`);
  return `<!-- DESK | ${HEADER_FIELDS.map(value).join(" | ")} -->`;
}

export function deskStatus(root, name) {
  return deskHeader(root, name)?.status ?? "";
}

// What write_desk takes: a title and a status, each short enough for one header line. The
// decision is here, pure, so it is checked on its own: the fields trimmed and fit to write, or
// what is wrong with them. A `|` is the header's own separator and cannot be in a status; a title
// stops at the next `|` when read, so one in a title would only lose what follows it.
//
// The length asked for and the length refused are two numbers on purpose. A writer composing a
// sentence estimates its length rather than counting it, and an estimate near a hard edge
// overshoots; the header is a comment line with no real width limit, so a line somewhat over
// what was asked costs nothing and is taken. Only one well past it is refused, and the refusal
// names the length it was and the length asked for, never the ceiling.
export const LONGEST_TITLE = 120;
export const LONGEST_STATUS = 80;
export const REFUSED_TITLE = 150;
export const REFUSED_STATUS = 100;

// One wording per fault, so a caller is told what to change and not sent to count characters
// when the fault was a newline. Answers the fault, or null when the value fits.
function lineFault(field, value, asked, ceiling) {
  if (typeof value !== "string" || value.trim() === "") {
    return `${field} is empty`;
  }
  if (value.includes("\n")) {
    return `${field} has a newline in it; it is one line`;
  }
  if (value.length > ceiling) {
    return `${field} is ${value.length} characters; write it in ${asked}`;
  }
  return null;
}

export function headerFields({ title, status } = {}) {
  const titleFault = lineFault("title", title, LONGEST_TITLE, REFUSED_TITLE);
  if (titleFault !== null) {
    return { refused: titleFault };
  }
  const statusFault = lineFault("status", status, LONGEST_STATUS, REFUSED_STATUS);
  if (statusFault !== null) {
    return { refused: statusFault };
  }
  if (status.includes("|")) {
    return { refused: "status has a | in it; the header uses | between its fields" };
  }
  return { title: title.trim(), status: status.trim() };
}

// Rewrite the header of an existing desk with the fields given, keeping the rest of the header
// and the whole body as they are. A desk whose line 1 is no longer a header — a file tool took
// it, or wrote over it — gets one back in front of every line it has, so nothing a session wrote
// is lost to the header it damaged. Nothing is written when there is no desk: a header is a
// desk's and not a way to make one. Answers the fields as written, or null.
export function writeDeskHeader(root, name, fields) {
  const file = deskFile(root, name);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const kept = parseHeader(lines[0]);
  const merged = { ...(kept ?? {}), ...fields, updated: fields.updated ?? new Date().toISOString() };
  const header = renderHeader(merged);
  const body = kept === null ? lines : lines.slice(1);
  fs.writeFileSync(file, [header, ...body].join("\n"));
  return merged;
}

// The desk as it stands, whole, or null when there is none.
export function readDesk(root, name) {
  try {
    return fs.readFileSync(deskFile(root, name), "utf8");
  } catch {
    return null;
  }
}

// Where a desk goes when the person at it has left. Beside desks/ rather than inside it: desks/ is
// a directory listing and that listing IS the roster, so a directory in there is somebody who works
// here. desks/ is who works here, archive/ is who has.
//
// It is made when the first person leaves. An instance nobody has left has nothing to put in one.
export const ARCHIVE = "archive";

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
// desk is going while the conversation it is going with is still being written to.
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

// Close a desk: the person's whole directory is filed under `at`, entry by entry, and the name is
// free again.
//
// The directory is moved whole rather than file by file from a list: a person is one directory
// now, and what the instance kept for them — the desk, the conversation, the persona it was last
// started with, the model when one was named — is whatever is in it. A list here would be a second
// answer to what a person is made of, wrong the day something was added to the directory and not
// to the list. The persona goes with the rest: it is the template with a name written into it, and
// it is filed rather than dropped because the directory is filed and it was in it.
//
// Answers the entries as filed, so whoever is filing can say what the archive holds.
export function retire(root, name, at) {
  const from = deskDirectory(root, name);
  const filed = [];
  let entries;
  try {
    entries = fs.readdirSync(from);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const target = path.join(at, entry);
    fs.renameSync(path.join(from, entry), target);
    filed.push(target);
  }

  fs.rmSync(from, { recursive: true, force: true });
  withdrawDesk(root, name);
  return filed;
}

// The roster: what a Worker is called when the Leader names nobody. Thirty first names in a
// fixed order — the same list every instance hires from — and the next one is the least recently
// used free name: a name never used at all first, in pool order, then the one whose holder left
// longest ago. Least recently used rather than first free, so a name is not somebody new the
// moment its last holder leaves: a name just given up goes to the back of the line, and a
// first name stays one person for as long as thirty names allow.
export const POOL = [
  "Paul", "Jane", "Jack", "Pete", "Anna", "Mark", "Lucy", "Tom", "Eva", "Sam", "Nora", "Ben", "Mia", "Leo", "Zoe", "Max",
  "Ivy", "Finn", "Ada", "Noah", "Ella", "Owen", "Ruby", "Hugo", "Iris", "Otto", "Lena", "Axel", "Nina", "Theo",
];

// A name is taken while `desks/<Name>/` exists — a desk, running or not, and a directory a
// conversation was left in, which hire refuses too.
function taken(root, name) {
  return fs.existsSync(deskDirectory(root, name));
}

// When the latest archived stint of each name ended, as a map of name to epoch milliseconds. A
// stint is `archive/<day>-<Name>[-<slug>]/`, the slug optional: a desk filed with no title is the
// day and the name alone. Its end is the last write of its desk file — the last thing that person
// wrote before leaving — then, without a desk file, noon of the day in the directory name, then
// the directory's own time. The directory's time comes last because anything later touching the
// directory moves it.
function stintEnds(root) {
  const ended = new Map();
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, ARCHIVE));
  } catch {
    return ended;
  }
  const filed = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-(${POOL.join("|")})(?:-|$)`);
  for (const entry of entries) {
    const found = filed.exec(entry);
    if (found === null) continue;
    const [, day, name] = found;
    const at = path.join(root, ARCHIVE, entry);
    let when;
    try {
      when = fs.statSync(path.join(at, DESK_FILE)).mtimeMs;
    } catch {
      when = Date.parse(`${day}T12:00:00`);
      if (Number.isNaN(when)) {
        try {
          when = fs.statSync(at).mtimeMs;
        } catch {
          when = 0;
        }
      }
    }
    if (!ended.has(name) || when > ended.get(name)) ended.set(name, when);
  }
  return ended;
}

// The next name for a hire: the free names of the pool, never used first in pool order, then by
// how long ago the holder left. With nobody in the pool free, Dev and three digits, fifty tries
// to find one nobody has, then a refusal rather than a loop.
export function nextName(root) {
  const ended = stintEnds(root);
  const free = POOL.map((name, place) => ({ name, place, ended: ended.get(name) ?? 0 })).filter(({ name }) => !taken(root, name));
  free.sort((one, two) => one.ended - two.ended || one.place - two.place);
  if (free.length > 0) return free[0].name;
  for (let tries = 0; tries < 50; tries += 1) {
    const name = `Dev${100 + Math.floor(Math.random() * 900)}`;
    if (!taken(root, name)) return name;
  }
  throw new DeskError("could not find a free name");
}

// What every persona here says about handing work to another agent, written into each one as it is
// rendered rather than repeated in the templates. It is one paragraph in two personas today and it
// has to be the same paragraph: a Leader and a worker briefing agents to two different budgets is
// worse than either budget.
//
// Why it goes in the text a session hands over and nowhere else: an agent is given the question and
// whatever its own kind is given, and the cheapest kinds are given very little. A rule written in
// the workspace's own instructions reaches the expensive kinds and misses exactly the ones a
// wide search reaches for. The brief is the only surface every agent reads.
//
// Deliberately not built: anything that counts an agent's calls and stops it. Nothing here can see
// inside a run it did not make, and a sentence followed most of the time is worth more than a
// mechanism that does not exist.
export const BUDGET = `When you hand work to another agent, what it costs is not how much it reads — it is how many times
it goes round. Every turn re-reads the whole conversation so far, so the same answer found in five
turns costs a fraction of what it costs found in fifty, whatever either of them read. The agent
cannot see this. It was handed a question, not a budget, and it will keep going until it is
satisfied.

So copy the four sentences below into every brief you write, word for word, before you send it —
not a summary of them, not the gist of them, and never left for the agent to work out. What is not
in the brief did not reach anybody: the cheapest kinds of agent arrive with none of what you are
reading now, nothing this workspace knows and no instructions, so a rule that lives anywhere but
the text you hand them is one they never see.

The four sentences, to be copied into every brief:

- Answer in at most 15 tool calls; if you cannot, report what you have and say what is missing.
- When several are working at once, split the files between them; never let two read the same one.
- Search first, then read the part that matched, rather than reading a whole file to find it.
- What has been filed away is history, not a place to look things up. Read what is there now.

The first is the budget and the other three are how it is kept. A brief without them is one you are
paying for blind.`;

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

// Who a session is, as the text it is handed: the template for its kind with the names written
// into it, so the file says "You are Superman, the Leader of Mike's workspace" outright, and then
// whatever the person at the instance has added for that kind. Rendered from the instance's own templates, never from
// an install source — an instance is what it was given, and this is what makes it say so.
//
// Every persona this workspace renders goes through here, which is why the budget is added here
// and not passed in: a caller cannot forget it, and a caller cannot give one persona a budget of
// its own. It goes into the template's own placeholder, so nothing a caller passes can quietly
// replace it — and the person's addition comes after the whole of that, so it can add to what a
// session is told and cannot take any of it away.
//
// The addition is read as it is. It is prose the person wrote for a session to read, not a
// template: a pair of braces in it is theirs and stays theirs.
export function persona(root, name, { user, leader }) {
  const leads = name === leader;
  const what = leads ? "leader" : "worker";
  const template = readTemplate(root, what, leads ? LEADER_TEMPLATE : WORKER_TEMPLATE);
  const rendered = render(what, template, { NAME: name, USER: user, LEADER: leader, BUDGET });
  const frames = [...customization(root, what), ...knowledge(root)];
  return frames.length === 0 ? rendered : `${rendered.replace(/\s*$/, "")}\n\n${frames.join("\n\n")}\n`;
}

// What admin mode is told, generated as the session opens: the real root, the real home, the desks
// that exist and whether anything is running. Written once it would be true on the day it was
// written and wrong the first time something here was renamed, and an admin acting on a stale
// description of an instance is the failure this whole mode exists to avoid.
//
// Its own function and not a third branch of persona(): that one adds the person's additions for a
// kind of seat and what the workspace knows, and an admin is not a seat and is not on the team. A
// branch there would hand a person's admin session the team's own material without anybody
// deciding to.
export function adminBriefing(root, { home, running }) {
  const template = readTemplate(root, "admin", ADMIN_TEMPLATE);
  const here = desks(root);
  return render("admin", template, {
    ROOT: root,
    HOME: home,
    DESKS: here.length === 0 ? "- none: nobody works here yet" : here.map((name) => `- ${name}`).join("\n"),
    RUNNING:
      running.length === 0
        ? "Nothing: no session of this instance is running, so there is nothing to interrupt."
        : `${running.length} session${running.length === 1 ? "" : "s"} of this instance ${running.length === 1 ? "is" : "are"} running.`,
  });
}

// Which of the person's files reach which kind of session, and in what order. `common.md` is what
// every session here is given, so it comes first and the role's own reads as the narrower thing
// under it. A Leader is given the Worker's file after both, marked as the Worker's rather than as
// its own, so that it knows what every Worker already holds and briefs the task rather than the
// method. A Worker is never given the Leader's: the two files exist because the roles differ.
const FRAMED = Object.freeze({
  leader: Object.freeze([{ name: "common.md" }, { name: "leader.md" }, { name: "worker.md", whose: "worker" }]),
  worker: Object.freeze([{ name: "common.md" }, { name: "worker.md" }]),
});

// What the person added for this instance, each file in a frame of its own, in that order. The
// files are theirs, so an absence is an answer and not a mistake: no file, no frame, and an
// instance with none of them renders the template and nothing else.
//
// The content is put between the tags exactly as it was read — nothing trimmed, nothing re-wrapped,
// no newline added and none taken away — because these are the person's own words going into every
// session, and a frame that tidies them is worse than no frame. The open tag has the line to
// itself and the close tag follows the content immediately, so what lies between the first newline
// and `</customization>` is the file byte for byte, whether or not it ended in one. A file that is
// there and empty is a frame with nothing in it, which is what it says; it is not an absence.
function customization(root, what) {
  const frames = [];
  for (const { name, whose } of FRAMED[what]) {
    const content = added(root, name);
    if (content === null) {
      continue;
    }
    const source = path.posix.join(CUSTOMIZATION, name);
    const open = whose === undefined ? `<customization source="${source}">` : `<customization source="${source}" for="${whose}">`;
    frames.push(`${open}\n${content}</customization>`);
  }
  return frames;
}

// The one note every session is handed, in a frame of its own, last of all. Last because it is the
// only frame that is neither the toolkit's nor the person's instruction but the workspace's own
// facts, and a session reads what it must do before it reads what happens to be true.
//
// Read as bytes and framed the way the person's files are — nothing parsed, nothing trimmed, no
// head stripped. The head stays visible on purpose: it is the shape every note here keeps, and a
// session that has just read one has read the example the template points at.
//
// Absent is the ordinary case and not a mistake. A clean instance has an empty `knowledge/` and no
// common note, so there is no frame and no error — the file appears the day somebody writes it.
function knowledge(root) {
  const content = readIfThere(path.join(root, KNOWLEDGE, KNOWLEDGE_COMMON));
  if (content === null) {
    return [];
  }
  const source = path.posix.join(KNOWLEDGE, KNOWLEDGE_COMMON);
  return [`<knowledge source="${source}">\n${content}</knowledge>`];
}

function added(root, name) {
  return readIfThere(path.join(root, CUSTOMIZATION, name));
}

function readIfThere(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// What a person may write with the file tools: their own directory, all of it but the desk file. A
// desk is a working directory — the desk file, and beside it whatever the work produces: a design,
// a finding, a proof — and a session that stops on a permission dialog to keep its own notes is a
// session stopped for doing its job. One `Edit(...)` rule, anchored at the root like the trees
// above, so a file made and a file changed are both answered by the settings from wherever the
// run is standing. One rule per person, granted when the desk is opened and withdrawn when it is
// filed away: a rule for a desk nobody has is a grant nobody can account for.
//
// The desk file is in it like everything else: its body is edited in place, and only its first
// line, the header, is the server's (writeDeskHeader).
export function deskRules(name) {
  return [`Edit(/${path.posix.join(DESKS, name)}/**)`];
}

// Grant the rule, once. Nothing is written when it is already held.
export function grantDesk(root, name) {
  const settings = readSettings(root);
  const granted = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  const missing = deskRules(name).filter((rule) => !granted.includes(rule));
  if (missing.length === 0) {
    return [];
  }

  return writeSettings(root, {
    ...settings,
    permissions: { ...settings.permissions, allow: [...granted, ...missing] },
  });
}

export function withdrawDesk(root, name) {
  const settings = readSettings(root);
  const granted = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  const rules = deskRules(name);
  if (!rules.some((rule) => granted.includes(rule))) {
    return [];
  }

  return writeSettings(root, {
    ...settings,
    permissions: { ...settings.permissions, allow: granted.filter((entry) => !rules.includes(entry)) },
  });
}

// Opening a worker's desk: everything a person is made of — the desk, the rules that let them
// write there, the model when one was named — written at once, or nothing written at all because
// one of the reasons not to came first.
//
// It is here rather than in the tool because what a name is refused for is a fact about desks
// and not about the tool that asked. The refusals are values and not printed lines for the same
// reason: the tool answers with them, and has no opinion about the wording.
//
// The desk template is read from the instance and not from wherever it was installed from, which
// is what lets an instance open a desk on a machine the source was never on.
//
// The model is the last argument and it is optional, because leaving it out is the answer nearly
// every time: somebody hired without a word about it runs on what this workspace runs its workers
// on, and goes on doing so if that is ever changed.
//
// It is refused before the desk is looked at and long before anything is written, so a model that
// is not one leaves nothing behind — no desk, no rule, and no name taken by a person who was never
// opened one.
export function hire(root, name, model = null) {
  if (!isName(name)) {
    throw new DeskError(describeName("a worker name", name));
  }
  if (model !== null && !isModel(model)) {
    throw new DeskError(describeModel("a model", model));
  }
  if (fs.existsSync(deskFile(root, name))) {
    throw new DeskError(`${name} already has a desk here`);
  }

  // A name is more than its desk file. The chat keeps the conversation and the persona in the same
  // directory, and a desk opened over the top of those is a new person answering with somebody
  // else's transcript on their panel — which looks like a fresh start until the first reply.
  //
  // Refused rather than cleared away: what is in there is a record somebody may want, and a
  // command that deletes one to get its own job done is worse than the surprise it is fixing.
  if (fs.existsSync(deskDirectory(root, name))) {
    throw new DeskError(
      `${name} has left a conversation here; move or remove ${path.posix.join(DESKS, name)} before hiring that name again`,
    );
  }

  return [
    ...writeDesk(root, root, name),
    ...grantDesk(root, name),
    // Only when one was named. Writing the workspace's own model into every desk would freeze
    // today's answer onto each person and turn a live setting into a seed nothing reads afterwards
    // — a workspace that changed it and saw nobody move would have a setting that lies.
    ...(model === null ? [] : writeModel(root, name, model)),
  ];
}

// Settling one rule for the whole instance — allowed, denied, or asked every time — and writing
// down who asked for it in the same act. The three lists a settings file holds, and the one the
// press names; a rule lands in that list and leaves the other two, because a press is the User's
// last word on that rule, and deny and ask beat allow inside Claude Code, so a stale allow beside
// a new ask would look like the ask lost.
//
// The line first and the rule second. If only one of the two can happen, the workspace is better
// off accounting for a rule it does not hold than holding one nothing accounts for: the first is
// noticed by anything that reads the pair, and the second is what twenty-six rules in a workspace
// nobody can explain look like.
//
// Nothing happens twice. The same rule settled the same way again is one entry and one line,
// because the second press is a person answering the same question rather than a second decision.
export const LISTS = Object.freeze(["allow", "deny", "ask"]);

export function ruleAsked(root, { rule, list, session, call, day }) {
  if (!LISTS.includes(list)) {
    throw new Error(`a rule is settled as one of ${LISTS.join(", ")}, not ${JSON.stringify(list)}`);
  }
  return [...account(root, { rule, list, session, call, day }), ...settle(root, rule, list)];
}

// A rule pressed Always on a call stop: allowed, instance-wide.
export function allowAsked(root, { rule, session, call, day }) {
  return ruleAsked(root, { rule, list: "allow", session, call, day });
}

// The file is the person's by the time this runs — the installer wrote it whole, once, and
// whatever they have made of it since is theirs — so settling one rule merges into it and must
// not take anything else away doing it.
function settle(root, rule, list) {
  const settings = readSettings(root);
  const permissions = settings?.permissions ?? {};
  const held = (name) => (Array.isArray(permissions[name]) ? permissions[name] : []);
  if (held(list).includes(rule) && LISTS.every((other) => other === list || !held(other).includes(rule))) {
    return [];
  }
  const written = { ...permissions };
  for (const other of LISTS) {
    if (other !== list && Array.isArray(permissions[other])) {
      written[other] = permissions[other].filter((entry) => entry !== rule);
    }
  }
  written[list] = held(list).includes(rule) ? held(list) : [...held(list), rule];
  return writeSettings(root, { ...settings, permissions: written });
}

// The file a person reads to find out what this workspace has settled beyond a desk. One line per
// rule: the rule in backticks first, so it can be read off the line, then the list it landed in,
// and then who asked for it, when, and what they were doing at the time.
//
// Beside the settings rather than inside them: `.claude/settings.json` has a shape Claude Code
// owns, and a key of ours in it is a key we would be guessing about.
export function account(root, { rule, list = "allow", session, call, day }) {
  const file = path.join(root, LEDGER);
  const held = readLedger(root);
  if (held !== null && held.includes(`- \`${rule}\` (${list}) `)) {
    return [];
  }

  // Appended to whatever is there, byte for byte. Somebody reading this file writes in it — a
  // sentence about why a rule is there, a heading of their own — and a writer that rebuilt the
  // file from the lines it recognised would quietly throw all of that away.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = held === null ? LEDGER_OPENING : held.endsWith("\n") ? held : `${held}\n`;
  fs.writeFileSync(file, `${text}- \`${rule}\` (${list}) — ${session}, ${day}, for ${asked(call)}\n`);
  return [file];
}

// Whether this workspace has ever settled anything beyond what it hands out by itself.
//
// The ledger is the whole of the answer and deliberately the only one. A rule and the line that
// accounts for it are written in one act, so a workspace with no file here has granted nothing
// wider than a desk, and one with a file has. Nothing else has to be stored and nothing has to be
// cleared — a second record of one fact is a thing to disagree with this on the day it matters.
export function hasSettledAnything(root) {
  return readLedger(root) !== null;
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


// What no file-writing tool may reach: this workspace's own account of what it allows.
//
// A moderately safe default here is a few deny rules and not many, because a deny rule is
// absolute — no allow overrides it, the call never reaches the panel, and somebody who works
// differently is BLOCKED rather than defaulted away. So the set is narrow on purpose: the settings
// that decide what is allowed, the ledger that says who asked for each rule, and the record of
// whether this workspace has been trusted. Nothing about anybody's work is in here.
//
// WHAT THEY ARE WORTH, exactly, and it is narrower than it looks. `Edit(...)` governs every
// built-in tool that writes a file, the Write tool included, and nothing else — a `Write(...)`
// twin beside it would refuse nothing more, measured: a deny spelt `Write(...)` let the Write tool
// through, the same deny spelt `Edit(...)` refused it. A shell command is not one of those tools,
// and these paths sit inside the working directory, so nothing else refuses them either. A granted
// `Bash(sed:*)` reaches every one of them. So the honest sentence is that these paths are closed
// to the file tools, never that a session here cannot widen its own permissions — and the skill
// that reports on all this crosses the deny paths against the granted shell rules and says which
// of the two is true in the instance it is asked about.
//
// Anchored at the root with a leading `/`, like every path rule here, so a run that has stepped
// into a repository under `projects/` is refused these paths under the root and not the same
// names under wherever it is standing.
//
// They hold whether or not the workspace has been trusted, which is the case they matter most in:
// an instance installed inside somebody's checkout has its `permissions.allow` entries ignored, and
// `deny` and `ask` in the same file go on applying.
//
// `.local/projects/**` is deliberately not among them. The memory index and the transcripts live
// there, and denying that subtree would break memory to protect nothing.
//
// Written when the instance is made and never afterwards (lib/seed.mjs), for the reason the
// rest of a fresh instance's settings are: changing how somebody's running workspace behaves is not
// an installer's to do, and an instance that has been worked in for a month may have reasons for
// what it holds. A workspace that wants these later adds them with an editor and a restart — they
// are three lines in a file its owner has, and the first turn of a new workspace names them out loud.
//
// Nothing the chat itself does goes through them: the settings and the ledger are written from node
// rather than through a session's tools.
export const OWN_ACCOUNT_RULES = [
  "Edit(/.claude/**)",
  "Edit(/.local/settings.json)",
  "Edit(/.local/.claude.json)",
];

