// What this workspace knows, as files: `knowledge/` at the instance root, flat, one note per
// topic, every seat writing in it with the file tools it already has. There is no database here,
// no model, no stored state, no index file and no cache — every answer below is built from the
// files at the moment it is asked, because a note edited by hand a second ago is the note the next
// call must see, and anything remembered between calls is a second truth to keep.
//
// Two tools are served over this, and they divide the work: `index` says what is there and never
// judges it, `validate` judges and says what to fix. That line matters. A session looking for a
// topic wants everything readable, including the note somebody left half-written; a session that
// has just written one wants every rule it broke. One function answering both would have to guess
// which of the two was asking.
//
// The note contract lives in this file and nowhere else. Nothing else in the toolkit parses a
// note: the persona render reads `common.md` as bytes and frames it, and that is the whole of the
// rest. So a rule changed here is changed everywhere it is enforced, and there is no second parser
// to fall out of step with this one.
import fs from "node:fs";
import path from "node:path";

import { KNOWLEDGE } from "./desks.mjs";

// The head, and the reason it is exactly four fields. Every one of them earns its place at read
// time: `summary` is the line an index shows, `tags` is the only thing a search matches on,
// `sources` is where the note came from, and `updated` is how old it is. There is no id, no
// status, no expiry, no author and no `replaces`, because a file has a name and a history already
// — a wrong note is edited and a dead one deleted, and a field that records either is a field that
// goes stale the first time somebody forgets it.
const FIELDS = ["summary", "tags", "sources", "updated"];
const FOUR = "the four fields are summary, tags, sources, updated";

// At least three tags, because one or two describe a note and three begin to describe a shelf: the
// third is what puts a note beside the others it belongs with, and it is the one nobody writes
// unless asked for it.
const LEAST_TAGS = 3;

const TAG = /^[a-z0-9-]+$/;
const FILENAME = /^[a-z0-9-]+\.md$/;
const URL = /^https?:\/\/\S+$/;

// What the User said, as a source. It is not a path and there is nothing to open: it records that
// a person said it, which is the one origin a file cannot hold.
const SAID = "<user>";

// The front matter, and a file without it is not a note. Read as `field: value` lines rather than
// as YAML, because the head is four known fields and a parser that accepted more would be
// accepting shapes `validate` would then have to refuse. A value is taken after the FIRST colon,
// so a summary may say "One sentence: what a session gets" and mean it.
//
// Answers either the fields it read or the one reason it could not, in the words the writer needs
// to fix it — a head that fails here fails for `index` and `validate` alike, and it is the only
// message the two share.
function head(text) {
  const framed = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (framed === null) {
    return { error: "no front matter: a note opens with the head between two `---` lines" };
  }
  const fields = new Map();
  let line = 0;
  for (const raw of framed[1].split("\n")) {
    line += 1;
    if (raw.trim() === "") {
      continue;
    }
    const named = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(raw);
    if (named === null) {
      return { error: `head line ${line} is not \`field: value\` (${FOUR}; tags and sources are inline lists like [a, b, c])` };
    }
    if (fields.has(named[1])) {
      return { error: `head names \`${named[1]}\` twice` };
    }
    fields.set(named[1], named[2].trim());
  }
  return { fields };
}

// An inline list, or null for a value that is not one. Entries are split on commas and trimmed,
// and an empty pair of brackets is an empty list rather than a list holding nothing — the two read
// the same in the file and `validate` says which rule the empty one breaks.
function list(value) {
  if (!/^\[.*\]$/.test(value)) {
    return null;
  }
  const inner = value.slice(1, -1).trim();
  return inner === "" ? [] : inner.split(",").map((entry) => entry.trim());
}

// A source's form, never its existence: a path is not opened and a URL is not fetched. Checking
// that a path resolves would make `validate` say a note is wrong because a directory moved, which
// is a fact about the tree rather than about the note. A path is written from the instance root,
// so it reads the same from every session whatever directory that session is standing in.
function sourceForm(entry) {
  if (entry === SAID || URL.test(entry)) {
    return true;
  }
  // The angle brackets are refused along with the rest, so that `<user>` is accepted by the line
  // above and by nothing else: a path shaped like it — `<usr>`, `<User>` — is a source nobody can
  // follow, and a rule broad enough to let it through was letting the typo through with it.
  if (entry === "" || /[\s\\<>]/.test(entry) || entry.startsWith("/") || entry.startsWith("~")) {
    return false;
  }
  return !entry.split("/").includes("..");
}

// One file read into what the rest of this module works with: either a note, or the reason it
// could not be read as one. `tags` and `summary` are taken as they are — a `tags` that is not a
// list leaves the note with none, and that is `validate`'s to report rather than a reason to
// refuse the note an index it could otherwise appear in.
function note(dir, name) {
  if (!name.endsWith(".md")) {
    return { name, error: "not a .md file" };
  }
  const read = head(fs.readFileSync(path.join(dir, name), "utf8"));
  if (read.error !== undefined) {
    return { name, error: read.error };
  }
  const fields = read.fields;
  return {
    name,
    fields,
    summary: fields.get("summary") ?? "",
    tags: list(fields.get("tags") ?? "") ?? [],
  };
}

// Said by `readAll` and recognised again by `validate`, which counts notes and must not count a
// directory as one. Named because the two have to agree: reworded in one place and matched in the
// other, the count would quietly change with nothing to notice.
const NOT_A_FILE = "not a file: `knowledge/` is flat";

// Everything under the directory, in one pass, with the latest mtime it saw. A directory inside
// `knowledge/` is reported the way a stray file is: the shelf is flat, and a session that made a
// folder has made something no tool here will ever look in.
function readAll(root) {
  const dir = path.join(root, KNOWLEDGE);
  let entries;
  let changed;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
    changed = fs.statSync(dir).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const read = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) {
      read.push({ name: entry.name, error: NOT_A_FILE });
      continue;
    }
    changed = Math.max(changed, fs.statSync(path.join(dir, entry.name)).mtimeMs);
    read.push(note(dir, entry.name));
  }
  return { read, changed };
}

// To the second. The header says when the shelf last moved, which is a thing a session compares
// against its own memory of the last call; milliseconds are noise in that comparison.
function when(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const ABSENT = `${KNOWLEDGE}/ is not there.`;

// `index()` with nothing: the header. How many notes, when the directory last changed, every tag
// with its count, and the files it could not read. The tag line is the point of the call — it is
// the workspace's vocabulary, and a session that writes a note without having seen it invents a
// fourth spelling of a tag three notes already carry.
//
// The full list of notes is deliberately not here and is not available from this tool at all.
// A hundred summaries is a page nobody reads and every session pays for; whoever truly wants them
// greps `^summary:` over the directory, which costs one call and returns the same thing.
function header(read, changed) {
  const notes = read.filter((one) => one.error === undefined);
  const counts = new Map();
  for (const one of notes) {
    for (const tag of one.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const tags = [...counts.keys()].sort();
  const lines = [
    `${KNOWLEDGE}/ — ${notes.length} notes, last changed ${when(changed)}`,
    `tags (${tags.length}): ${tags.map((tag) => `${tag} ${counts.get(tag)}`).join(" · ")}`,
  ];
  const unread = read.filter((one) => one.error !== undefined);
  if (unread.length > 0) {
    lines.push("not indexed:");
    for (const one of unread) {
      lines.push(`  ${one.name} — ${one.error}`);
    }
  }
  return lines.join("\n");
}

// `index(tags)`: the notes carrying at least one of them. OR rather than AND, because a session
// asking about two topics is looking for whatever touches either — an AND over three tags on a
// hundred notes answers nothing far too often, and the way to narrow here is to read the summaries
// that came back.
//
// Matched on tags and on nothing else. Filenames and summaries are not searched, so that what a
// tag means stays a decision somebody made when they wrote the note rather than an accident of
// which words the summary happened to use; for words, there is grep.
//
// Ordered by how many of the asked tags a note carries, so the note sitting at the intersection of
// the question comes first, then by filename so that two equal notes always come back the same way
// round.
function matches(read, asked) {
  const wanted = new Set(asked);
  const found = [];
  for (const one of read) {
    if (one.error !== undefined) {
      continue;
    }
    const hits = one.tags.filter((tag) => wanted.has(tag)).length;
    if (hits > 0) {
      found.push({ one, hits });
    }
  }
  found.sort((a, b) => b.hits - a.hits || a.one.name.localeCompare(b.one.name));
  if (found.length === 0) {
    return `no notes carry any of: ${asked.join(", ")}`;
  }
  return found.map(({ one }) => `${one.name}  [${one.tags.join(", ")}]\n  ${one.summary}`).join("\n");
}

export function index(root, tags) {
  const all = readAll(root);
  if (all === null) {
    return ABSENT;
  }
  const asked = (tags ?? []).map((tag) => String(tag).trim()).filter((tag) => tag !== "");
  return asked.length === 0 ? header(all.read, all.changed) : matches(all.read, asked);
}

// Every rule the contract has, checked in code and nowhere else, and each message states the rule
// it is holding the note to rather than naming it. A session that has just written a note reads
// this and knows what to type next; it should never have to go and find the contract to understand
// what it did wrong. That is why the instruction text in the personas shows an example head and
// leaves the rules here: an example is what gets a note written, and these messages are what get
// it written correctly.
function problems(one, today) {
  const found = [];
  const say = (message) => found.push(`${one.name}: ${message}`);
  if (one.error !== undefined) {
    say(one.error);
    return found;
  }
  if (!FILENAME.test(one.name)) {
    say("a filename is lowercase letters, digits and hyphens, ending `.md`");
  }
  for (const field of FIELDS) {
    if (!one.fields.has(field)) {
      say(`the head has no \`${field}\` (${FOUR}, all four, none missing)`);
    }
  }
  for (const field of one.fields.keys()) {
    if (!FIELDS.includes(field)) {
      say(`the head has \`${field}\` (${FOUR}, and nothing else)`);
    }
  }
  if (one.fields.has("summary") && one.fields.get("summary") === "") {
    say("`summary` is one non-empty line: what a session gets from reading this note");
  }
  if (one.fields.has("tags")) {
    const tags = list(one.fields.get("tags"));
    if (tags === null) {
      say("`tags` is an inline list, like [billing-service, invoicing, rounding]");
    } else {
      if (tags.length < LEAST_TAGS) {
        say(`\`tags\` has ${tags.length}, and a note carries at least ${LEAST_TAGS}`);
      }
      for (const tag of tags.filter((tag) => !TAG.test(tag))) {
        say(`\`tags\` has \`${tag}\`, and a tag is lowercase letters, digits and hyphens`);
      }
      for (const tag of [...new Set(tags.filter((tag, at) => tags.indexOf(tag) !== at))]) {
        say(`\`tags\` names \`${tag}\` twice`);
      }
    }
  }
  if (one.fields.has("sources")) {
    const sources = list(one.fields.get("sources"));
    if (sources === null) {
      say("`sources` is an inline list, like [reference/billing-service, <user>]");
    } else {
      for (const entry of sources.filter((entry) => !sourceForm(entry))) {
        say(`\`sources\` has \`${entry}\`, and a source is a path from the instance root, a URL, or \`${SAID}\``);
      }
    }
  }
  if (one.fields.has("updated")) {
    const updated = one.fields.get("updated");
    // There is no shape rule here and none is needed, because the comparison IS one: anything that
    // survives it is equal to a `toISOString().slice(0, 10)`, and that is YYYY-MM-DD by
    // construction. No string can exist that fails the shape and passes this. Do not add a regex
    // back to make the shape explicit — it would refuse nothing this does not already refuse, and
    // a parser that one day accepts `2026-9-22` changes nothing either, since the round trip would
    // answer `2026-09-22` and the comparison would still say no.
    //
    // The guard is for a different thing: a month of 13 or a day of 45 makes no instant at all,
    // and asking one for its ISO string throws, which in the tool whose job is to report a
    // malformed note would take the reading of every other note down with it. A day merely too
    // long for its month, 31 February, does make a real instant, in March, and comes back
    // different. Both are the same mistake to whoever wrote the note.
    const midnight = new Date(`${updated}T00:00:00Z`);
    if (Number.isNaN(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== updated) {
      say(`\`updated\` is \`${updated}\`, and a date is YYYY-MM-DD`);
    } else if (updated > today) {
      say(`\`updated\` is \`${updated}\`, which is after today (${today})`);
    }
  }
  return found;
}

// Today where this is running, and local rather than UTC on purpose. ovai runs on somebody's
// machine: the date a session is handed, and the date a person reads, is the local one, so a note
// dated today by the seat writing it must never be in the future to the tool validating it a
// moment later. Taking UTC here would have meant telling every seat to write a date it was not
// given, to satisfy a comparison nobody can see — and east of Greenwich it reports a note written
// this evening as tomorrow's.
function localDate(now) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${String(now.getDate()).padStart(2, "0")}`;
}

// All of `knowledge/`, never one note: a session that has just edited one file wants to know the
// shelf is sound, and a note it broke is as likely to be the one it did not touch. Called by a
// Worker after it writes, and by the Leader at the end of a round.
export function validate(root, { now = new Date() } = {}) {
  const all = readAll(root);
  if (all === null) {
    return ABSENT;
  }
  const today = localDate(now);
  const notes = all.read.filter((one) => one.name.endsWith(".md") && one.error !== NOT_A_FILE);
  const found = all.read.flatMap((one) => problems(one, today));
  if (found.length === 0) {
    return `${notes.length} notes, all valid`;
  }
  return [...found, `${notes.length} notes, ${found.length} ${found.length === 1 ? "problem" : "problems"}`].join("\n");
}
