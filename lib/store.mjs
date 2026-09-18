// The store: what a workspace knows, kept where every session reads the same thing.
//
// Two stores under one protocol. `memory` is about us — the hard rules the team works under, the
// facts and the traps — and `knowledge` is about the project. A record is one markdown file with a
// front matter block: the fields are the block, the body is the text, and a person can read it.
// Nothing here is ever deleted or edited in place. A record that changes is superseded by a new one
// that names it, so the store is an append-only history in which "current" is a fact computed from
// the files and never a flag kept beside them.
//
// Sessions never read these files. They reach the store through the two tools the chat serves,
// `recall` and `remember`, and what those answer is the truth about a record — current or replaced,
// expired or not, visible to this caller or not — which the file on its own does not say.
//
// ONE READ, ROLE-AWARE. `readStore` is the only way records leave the files, and it is where the
// scope filter lives: a record scoped to the Leader is dropped for a Worker before anything else
// sees it — the render, a recall by id, the list handed to the helper, the lookup behind a
// replacement. A Worker cannot reach such a record by any argument because it is not in what the
// Worker's call was given. There is no index and no cache: at a few hundred small files a read is
// a millisecond, and either would be a second thing that can disagree with the files.
//
// WRITES ARE SERIALIZED PER STORE. The chat is the only writer, the tool runs inside it, and one
// promise chain per store makes every write read, decide and write before the next one reads — so
// two `remember` calls issued in one turn see each other: distinct numbers, the cap held. The id is
// the file that was created, opened with "wx" as a crash net and never retried.
//
// Where a request needs understanding rather than a grep — recall by meaning, "does this replace
// something", "for today" into a moment — the tool asks the helper (lib/helper.mjs). The helper
// proposes; every rule below is applied here, on a validated answer, and the helper never touches
// a text, an id it was not sent, or the decision to refuse.

import fs from "node:fs";
import path from "node:path";

export const STORE_DIRECTORY = "store";
export const STORES = ["memory", "knowledge"];
export const KINDS = { memory: ["hard-rule", "fact", "trap"], knowledge: ["fact", "trap"] };
export const SOURCES = ["user", "team"];
export const SCOPES = ["team", "leader"];
export const HARD_RULE = "hard-rule";

// The two roles a caller has. Named here and nowhere else: what a role may do is decided in this
// file, and a tool hands its caller's role in and never looks at how it was established.
export const LEADER = "Leader";
export const WORKER = "Worker";

// How many hard rules a workspace holds and how long one may be, when its configuration does not
// say. The rules go into every initial prompt verbatim and are never summarised, so the cap is what
// keeps that prompt one screen; the length is what makes a one-line render possible without it.
export const HARD_RULES = Object.freeze({ count: 25, length: 200 });

const PREFIX = { memory: "m", knowledge: "k" };
const FILE_NAME = /^(\d{6})\.md$/;
const RECORD_FILE_WIDTH = 6;

// A moment with an offset, which is the only shape a stored moment ever has. Nothing relative is
// ever written: "for today" is turned into one of these before it reaches a file, and a moment
// without an offset would mean a different instant on every machine that read it.
const ABSOLUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// The one word that retires a record: `until: now` is this clock, absolute, and never a question
// for the helper — so a retire is never a request on the account.
const NOW = "now";

const TAG = "given";

// `judged: store` on a record whose replacement the store chose — the writer left `replaces` out
// and the store found the record itself, by the same text or by the helper's answer. Absent when
// the writer named it.
const STORE = "store";

export function storeDirectory(root, store) {
  return path.join(root, STORE_DIRECTORY, store);
}

// The cap and the length as this workspace has them, read from its configuration on every call and
// falling back to the defaults for anything that is not a positive number.
export function hardRulesIn(config) {
  const given = config?.hardRules ?? {};
  return {
    count: positive(given.count) ?? HARD_RULES.count,
    length: positive(given.length) ?? HARD_RULES.length,
  };
}

function positive(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------------------------------------
// Records on disk.

// The fields, in the order the file holds them. `text` is the body and not a field.
const FIELDS = ["id", "store", "kind", "source", "scope", "number", "until", "by", "at", "supersedes", "replaced", "reason", "judged"];

// A value is written as it is when it reads back as it is: one line, not starting with a quote,
// not beginning or ending in whitespace. Anything else is JSON-quoted, so a replaced text of three
// lines survives being copied into the front matter byte for byte.
function serialiseValue(value) {
  const text = String(value);
  return /^[^\s"][^\r\n]*$/.test(text) && !/\s$/.test(text) ? text : JSON.stringify(text);
}

function parseValue(text) {
  return text.startsWith('"') ? JSON.parse(text) : text;
}

export function serialise(record) {
  const lines = ["---"];
  for (const field of FIELDS) {
    if (record[field] !== undefined && record[field] !== null) {
      lines.push(`${field}: ${serialiseValue(record[field])}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n${record.text}\n`;
}

// The file back into a record. The body is the text plus the one newline the writer added, so
// exactly one is taken off: a text that ends in a newline of its own keeps it.
export function parse(text) {
  if (!text.startsWith("---\n")) {
    throw new Error("a record starts with a front matter block");
  }
  const close = text.indexOf("\n---\n", 4);
  if (close === -1) {
    throw new Error("a record's front matter block is never closed");
  }
  const record = {};
  for (const line of text.slice(4, close).split("\n")) {
    const at = line.indexOf(": ");
    if (at === -1) {
      throw new Error(`a front matter line is not a field: ${line}`);
    }
    const field = line.slice(0, at);
    const value = parseValue(line.slice(at + 2));
    record[field] = field === "number" ? Number(value) : value;
  }
  const body = text.slice(close + 5);
  record.text = body.endsWith("\n") ? body.slice(0, -1) : body;
  return record;
}

// Every record of one store, as the files hold them, in file order.
function recordsIn(root, store) {
  const directory = storeDirectory(root, store);
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return names
    .map((name) => FILE_NAME.exec(name))
    .filter((found) => found !== null)
    .map((found) => Number(found[1]))
    .sort((a, b) => a - b)
    .map((n) => ({ ...parse(fs.readFileSync(path.join(directory, fileName(n)), "utf8")), n }));
}

function fileName(n) {
  return `${String(n).padStart(RECORD_FILE_WIDTH, "0")}.md`;
}

// THE ONE READ. Currency first, over everything: a record named in another's `supersedes` is
// replaced, whoever may see either. Then the scope: a Worker is handed nothing scoped to the Leader.
// Everything a caller can be shown, and everything the helper is ever sent, comes out of here with
// that caller's role.
//
// `successor` maps a replaced id to the id that replaced it, so a refusal can name where a record
// went — over the visible records only, so what it names is something the caller may see. `next` is
// the number the next file takes, read off the same listing: a write decides it here, under the
// store's chain, and the "wx" at the open is what catches anything that appeared in between.
export function readStore(root, store, { role }) {
  const every = recordsIn(root, store);
  const replaced = new Map();
  for (const record of every) {
    if (record.supersedes !== undefined) {
      replaced.set(record.supersedes, record.id);
    }
  }
  const visible = role === LEADER ? every : every.filter((record) => record.scope !== "leader");
  const seen = new Set(visible.map((record) => record.id));
  const successor = new Map([...replaced].filter(([, to]) => seen.has(to)));
  return {
    records: visible,
    current: visible.filter((record) => !replaced.has(record.id)),
    replaced,
    successor,
    // The set version, over EVERY current hard rule and not only the visible ones: one number for
    // every role, so a Worker's desk and the Leader's name the same set.
    version: setVersion(every.filter((record) => !replaced.has(record.id))),
    next: every.length === 0 ? 1 : every.at(-1).n + 1,
  };
}

// Whether a record has run out at this moment. Absent is never.
export function expired(record, now) {
  return record.until !== undefined && Date.parse(record.until) <= now.getTime();
}

function isCurrentHardRule(record) {
  return record.kind === HARD_RULE;
}

// The set version: the id of the newest current hard-rule record, the same for every role by
// design. A write scoped to the Leader bumps it for Workers too, whose render did not change —
// harmless, and one version is one number to compare. An expiry changes the render without
// changing the version, which is right: the version says what was written.
export function setVersion(current) {
  const rules = current.filter(isCurrentHardRule);
  return rules.length === 0 ? null : rules.reduce((newest, record) => (record.n > newest.n ? record : newest)).id;
}

// ---------------------------------------------------------------------------------------------
// Moments, in the workspace's own zone.

export function zoneOf() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function partsOf(date, zone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);
  const read = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  // A midnight is "24" in this locale's 2-digit hour; a stamp wants "00".
  read.hour = read.hour === "24" ? "00" : read.hour;
  return read;
}

// A moment as a stored field: ISO 8601 with the offset of the workspace's zone at that moment.
export function stamp(date, zone) {
  const p = partsOf(date, zone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offset = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offset < 0 ? "-" : "+";
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

// A moment as a person reads it: the date, the time, and the zone's label. The one format every
// line here uses for an `until`, in the render and on a recall line alike.
export function said(moment, zone) {
  const date = moment instanceof Date ? moment : new Date(moment);
  const p = partsOf(date, zone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

function weekdayOf(date, zone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long" }).format(date);
}

// ---------------------------------------------------------------------------------------------
// The hard-rule render: the one text every session has.

// Take the current hard rules, drop the expired and — for a Worker — the Leader-scoped, and print
// them numbered: the User's first and then the team's, which is the order of the two groups below,
// and by number inside each. The text of a rule is its record's text byte for byte: no wrapping,
// trimming or summary, because the length cap at write time is what makes one line possible
// without one.
export function renderHardRules(current, { role, now, zone = zoneOf(), version = setVersion(current) }) {
  const rules = current
    .filter(isCurrentHardRule)
    .filter((record) => !expired(record, now))
    .filter((record) => role === LEADER || record.scope !== "leader")
    .sort((a, b) => a.number - b.number);
  if (rules.length === 0) {
    return `Hard rules (set ${version ?? "none"}): none yet.`;
  }
  const lines = [`Hard rules (set ${version}). Follow them as written; they are numbered so you can name one.`];
  for (const [source, heading] of [["user", "From the User:"], ["team", "From the team:"]]) {
    const group = rules.filter((record) => record.source === source);
    if (group.length === 0) {
      continue;
    }
    lines.push(heading);
    for (const record of group) {
      lines.push(`  ${record.number}. ${record.text}${untilSuffix(record, zone)}`);
    }
  }
  return lines.join("\n");
}

function untilSuffix(record, zone) {
  return record.until === undefined ? "" : ` (until ${said(record.until, zone)})`;
}

// The render for one role, read from the store now, with the version beside it.
export function hardRulesFor(root, role, { now = new Date(), zone = zoneOf() } = {}) {
  const { current, version } = readStore(root, "memory", { role });
  return { text: renderHardRules(current, { role, now, zone, version }), version };
}

// The persona a session is spawned with, ending in that render: the persona text, then the rules.
// The two are joined here so that what a session is told about the rules is the render and nothing
// a template could paraphrase, and so that `withoutHardRules` can take exactly this off again.
export function withHardRules(persona, root, role, options) {
  const rules = hardRulesFor(root, role, options);
  return { text: `${persona}\n${rules.text}\n`, version: rules.version };
}

// The persona as it was before the render was appended, for whoever compares a running session's
// instructions with what the instance renders now: a rule written since is not older instructions.
// An exact inverse of `withHardRules` for a persona ending in a newline, which every template does.
const RENDER_BEGINS = "\n\nHard rules (set ";

export function withoutHardRules(text) {
  const at = text.lastIndexOf(RENDER_BEGINS);
  return at === -1 ? text : `${text.slice(0, at)}\n`;
}

// What a running session is told after a hard-rule write: the delta and the set version, never the
// set — a session that wants the whole thing calls `recall`. Rendered per recipient role; a rule
// scoped to the Leader produces no Worker message at all, not an empty one.
export function updateMessage(record, { role, zone = zoneOf() }) {
  if (role !== LEADER && record.scope === "leader") {
    return null;
  }
  const opening = `Hard rules update (set ${record.id}):`;
  const text = `"${record.text}"${untilSuffix(record, zone)}`;
  if (record.until !== undefined && Date.parse(record.until) <= Date.parse(record.at)) {
    return `${opening} rule ${record.number} retired: "${record.text}".`;
  }
  if (record.supersedes !== undefined) {
    return `${opening} rule ${record.number} now reads ${text} (replaced "${record.replaced}").`;
  }
  return `${opening} rule ${record.number}, new: ${text}.`;
}

// Whoever wants to know that the rules moved. Called once per hard-rule write, never for a fact or
// a trap, with the new version and a function rendering the update for a role.
const listeners = new Set();

export function onHardRulesChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------------------------
// One record, as a recall line.

// `[m17] hard-rule 7, user, until 2026-09-14 23:59 CEST - "text"` and under it the provenance:
// who, when, and what it replaced with the replaced text quoted. The text is never paraphrased.
// A replacement the store chose says so, because the writer named nothing and may not have read
// what went: `writer` is how that line addresses them — "you" in the write's own answer, "the
// writer" on a recall.
export function recordLine(record, { now, zone, successor, writer = "the writer" }) {
  const head = [`${record.kind}${record.kind === HARD_RULE ? ` ${record.number}` : ""}`, record.source];
  if (record.scope === "leader") {
    head.push("scope leader");
  }
  if (record.until !== undefined) {
    head.push(`until ${said(record.until, zone)}`);
  }
  const marks = [];
  if (successor.has(record.id)) {
    marks.push(`(replaced by ${successor.get(record.id)})`);
  }
  if (expired(record, now)) {
    marks.push(`(expired ${said(record.until, zone)})`);
  }
  const first = `[${record.id}] ${head.join(", ")} - "${record.text}"${marks.length === 0 ? "" : ` ${marks.join(" ")}`}`;
  const who = `by ${record.by}${record.source === "user" ? " for the User" : ""}, ${said(record.at, zone)}`;
  let replaced = "";
  if (record.judged === STORE) {
    replaced = `; replaced ${record.supersedes} ("${record.replaced}") by the store's judgement — ${writer} named nothing: ${record.reason}`;
  } else if (record.supersedes !== undefined) {
    replaced = `; replaced ${record.supersedes} ("${record.replaced}")${record.reason === TAG ? "" : ` - ${record.reason}`}`;
  }
  return `${first}\n      ${who}${replaced}`;
}

// ---------------------------------------------------------------------------------------------
// recall

// Read the store. One of `query`, `id`, `all` — or `kind: hard-rule` alone, which is the numbered
// set exactly as every session already has it plus the set version, so a session can confirm what
// it holds. Every path reads through `readStore` with the caller's role.
export async function recall(root, args, { caller, now = new Date(), config, helper, zone = zoneOf() }) {
  const shape = recallShape(args);
  if (shape.refused !== undefined) {
    return shape;
  }
  const { store, kind, by, expiredToo } = shape;
  const { records, current, successor, version } = readStore(root, store, { role: caller.role });
  const line = (record) => recordLine(record, { now, zone, successor });

  if (by === "id") {
    const record = records.find((one) => one.id === args.id);
    if (record === undefined) {
      return { text: `no record ${args.id} in ${store}` };
    }
    return { text: line(record) };
  }

  const alive = current
    .filter((record) => kind === undefined || record.kind === kind)
    .filter((record) => expiredToo || !expired(record, now));

  if (by === "set") {
    const parts = [renderHardRules(current, { role: caller.role, now, zone, version })];
    if (expiredToo) {
      const gone = alive.filter((record) => expired(record, now));
      if (gone.length > 0) {
        parts.push("Expired:", ...gone.map(line));
      }
    }
    return { text: parts.join("\n") };
  }

  if (by === "all") {
    return { text: alive.length === 0 ? `nothing in ${store}${kind === undefined ? "" : ` of kind ${kind}`}` : alive.map(line).join("\n") };
  }

  // By meaning. The helper is handed what this caller may see and nothing else, and only ids it
  // was sent come back.
  const sent = alive.map((record) => ({ id: record.id, kind: record.kind, text: record.text }));
  const asked = await helper("select", { question: "select", query: args.query, records: sent });
  if (asked.refused !== undefined) {
    return { refused: asked.refused };
  }
  const known = new Map(alive.map((record) => [record.id, record]));
  const found = asked.answer.ids.filter((id) => known.has(id)).map((id) => known.get(id));
  return { text: found.length === 0 ? `nothing in ${store} answers "${args.query}"` : found.map(line).join("\n") };
}

// The arguments of a recall, or the one sentence that refuses them.
function recallShape(args) {
  const store = args?.store;
  if (!STORES.includes(store)) {
    return { refused: `store is ${STORES.join(" or ")}` };
  }
  const kind = args.kind;
  if (kind !== undefined && !KINDS.memory.includes(kind)) {
    return { refused: `kind is ${KINDS.memory.join(", ")}` };
  }
  if (kind === HARD_RULE && store !== "memory") {
    return { refused: "hard rules are memory; ask store memory for kind hard-rule" };
  }
  const given = ["query", "id", "all"].filter((name) => args[name] !== undefined && args[name] !== false && args[name] !== "");
  let by;
  if (given.length === 1) {
    by = given[0];
  } else if (given.length === 0 && kind === HARD_RULE) {
    by = "set";
  } else {
    return { refused: "give exactly one of query, id or all — or kind hard-rule on its own for the numbered set" };
  }
  if (by === "query" && typeof args.query !== "string") {
    return { refused: "query is words" };
  }
  if (by === "id" && typeof args.id !== "string") {
    return { refused: "id is a record id such as m17" };
  }
  return { store, kind, by, expiredToo: args.expired === true };
}

// ---------------------------------------------------------------------------------------------
// remember

// Write one record. Supersede, never accumulate. Every refusal is one sentence naming what would
// pass, and nothing is written. Steps 3 to 9 run under the store's chain.
export function remember(root, args, context) {
  const shape = rememberShape(args, context.caller);
  if (shape.refused !== undefined) {
    return Promise.resolve(shape);
  }
  return serialized(root, shape.store, () => write(root, shape, context));
}

const chains = new Map();

// One promise chain per store: the next write begins after the last one has read, decided and
// written. A write that failed leaves the chain usable — the failure is its own and the next
// write's decision starts from the files as they are.
function serialized(root, store, act) {
  const key = `${root}\0${store}`;
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(act, act);
  chains.set(key, next.catch(() => {}));
  return next;
}

// Refusals 1 to 5: from the arguments and the role alone.
function rememberShape(args, caller) {
  const store = args?.store;
  if (!STORES.includes(store)) {
    return { refused: `store is ${STORES.join(" or ")}` };
  }
  const kind = args.kind;
  if (kind === HARD_RULE && caller.role !== LEADER) {
    return { refused: "hard rules are the Leader's to write; say it to the Leader as a proposal" };
  }
  const source = args.source ?? "team";
  const scope = args.scope ?? "team";
  if (!SOURCES.includes(source)) {
    return { refused: `source is ${SOURCES.join(" or ")}` };
  }
  if (!SCOPES.includes(scope)) {
    return { refused: `scope is ${SCOPES.join(" or ")}` };
  }
  if (caller.role !== LEADER && (source !== "team" || scope !== "team")) {
    return { refused: "a Worker's write is always source team and scope team" };
  }
  if (scope === "leader" && !(kind === HARD_RULE && source === "user")) {
    return { refused: "scope leader is for a hard-rule with source user" };
  }
  if (!KINDS[store].includes(kind)) {
    return { refused: `kind in ${store} is ${KINDS[store].join(" or ")}` };
  }
  const text = args.text;
  if (typeof text !== "string" || text.trim() === "") {
    return { refused: "text is the record, and it is missing" };
  }
  for (const [name, value] of [["until", args.until], ["replaces", args.replaces], ["reason", args.reason]]) {
    if (value !== undefined && typeof value !== "string") {
      return { refused: `${name} is a string` };
    }
  }
  return { store, kind, source, scope, text, until: args.until, replaces: args.replaces, reason: args.reason };
}

async function write(root, shape, { caller, now = new Date(), config, helper, zone = zoneOf() }) {
  const { store, kind, source, scope, text } = shape;
  const limits = hardRulesIn(config);

  // Refusal 5. The length is the configured one, and a rule over it is refused with the number:
  // never shortened, never summarised.
  if (kind === HARD_RULE) {
    if (/[\r\n]/.test(text)) {
      return { refused: "a hard rule is one line; take the newline out" };
    }
    if (text.length > limits.length) {
      return { refused: `a hard rule is at most ${limits.length} characters and this one is ${text.length}; say it shorter` };
    }
  }

  // Step 2: until. Absent, the literal now, an absolute moment, or words for the helper.
  let until;
  if (shape.until !== undefined) {
    const settled = await settleUntil(shape.until, { now, zone, helper });
    if (settled.refused !== undefined) {
      return settled;
    }
    until = settled.until;
  }

  // Step 3: the store, for this caller's role.
  const { current, successor, records, next, version } = readStore(root, store, { role: caller.role });
  const sameKind = current.filter((record) => record.kind === kind);

  // Step 4: what this replaces. Named by the writer, or — `replaces` left out — chosen by the store:
  // the same text again, else whatever the helper judges to be this record restated, widened,
  // narrowed or reversed. A store-chosen replacement is marked, and the answer says so.
  let replaces = null;
  let reason = shape.reason;
  let judged = false;
  if (shape.replaces !== undefined) {
    const named = records.find((record) => record.id === shape.replaces);
    if (named === undefined || named.kind !== kind) {
      return { refused: `${shape.replaces} is not a current ${kind} record of ${store}; leave replaces out or name one that is` };
    }
    if (!current.includes(named)) {
      const to = successor.get(named.id);
      return { refused: `${named.id} was replaced${to === undefined ? "" : ` by ${to}`}; replace the current record instead` };
    }
    replaces = named;
    reason = reason ?? TAG;
  } else {
    const same = sameKind.find((record) => collapse(record.text) === collapse(text));
    if (same !== undefined) {
      replaces = same;
      reason = reason ?? "the same text, restated";
      judged = true;
    } else if (sameKind.length > 0) {
      const asked = await helper("replaces", {
        question: "replaces",
        kind,
        text,
        records: sameKind.map((record) => ({ id: record.id, text: record.text })),
      });
      if (asked.refused !== undefined) {
        return { refused: asked.refused };
      }
      const found = sameKind.find((record) => record.id === asked.answer.replaces);
      if (found !== undefined) {
        replaces = found;
        reason = reason ?? asked.answer.reason;
        judged = true;
      }
    }
  }

  // Step 5: the User's records are the User's. The Leader included.
  if (replaces !== null && replaces.source === "user" && source !== "user") {
    return { refused: `${replaces.id} is the User's ${replaces.kind}; only a write with source user can replace it` };
  }

  // Step 6: the cap, over every current unexpired hard rule whatever its scope.
  if (kind === HARD_RULE) {
    const held = sameKind.filter((record) => !expired(record, now));
    const after = held.length + 1 - (replaces !== null && held.includes(replaces) ? 1 : 0);
    if (after > limits.count) {
      const set = renderHardRules(current, { role: caller.role, now, zone, version });
      return {
        refused: `the workspace holds ${held.length} hard rules and the cap is ${limits.count}; retire or merge one with the User first. The set:\n${set}`,
      };
    }
  }

  // Steps 7 to 9: number, provenance, the file.
  const record = { id: null, store, kind, source, scope };
  if (kind === HARD_RULE) {
    record.number = replaces !== null ? replaces.number : nextNumber(sameKind);
  }
  if (until !== undefined) {
    record.until = until;
  }
  record.by = caller.role === LEADER ? LEADER : `${caller.name} (${WORKER})`;
  record.at = stamp(now, zone);
  if (replaces !== null) {
    record.supersedes = replaces.id;
    record.replaced = replaces.text;
    record.reason = reason;
    if (judged) {
      record.judged = STORE;
    }
  }
  record.text = text;

  const n = next;
  record.id = `${PREFIX[store]}${n}`;
  const directory = storeDirectory(root, store);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, fileName(n)), serialise(record), { flag: "wx" });
  record.n = n;

  // Step 10: the answer — the record's line, addressed to the writer — and the announcement, for a
  // hard rule only.
  const lines = [recordLine(record, { now, zone, successor: new Map(), writer: "you" })];
  if (kind === HARD_RULE) {
    for (const listener of listeners) {
      listener(record.id, (role) => updateMessage(record, { role, zone }));
    }
    lines.push(updateMessage(record, { role: LEADER, zone }));
    lines.push("Every running session gets this on its next turn; every new session gets the set.");
  }
  return { text: lines.join("\n") };
}

function collapse(text) {
  return text.trim().replace(/\s+/g, " ");
}

// The highest number any hard rule ever had, plus one. A number is never reused: a replaced rule
// keeps its number in the record that replaces it, and a retired one's stays taken — so the current
// rules between them hold every number ever given, and the highest among them is the highest ever.
function nextNumber(current) {
  const taken = current.map((record) => record.number).filter((number) => typeof number === "number");
  return taken.length === 0 ? 1 : Math.max(...taken) + 1;
}

// `until` into a stored moment. `now` is this clock; an absolute moment is checked and kept as
// given; anything else is words, which only the helper can place. A moment in the past is refused
// unless it is `now` itself, which is how a record is retired.
async function settleUntil(given, { now, zone, helper }) {
  const words = given.trim();
  if (words === NOW) {
    return { until: stamp(now, zone) };
  }
  if (ABSOLUTE.test(words)) {
    const moment = Date.parse(words);
    if (Number.isNaN(moment)) {
      return { refused: `until "${words}" is not a moment; give ISO 8601 with an offset, words such as "for today", or now` };
    }
    if (moment <= now.getTime()) {
      return { refused: `until "${words}" has passed; give a moment ahead, or now to retire` };
    }
    return { until: words };
  }
  const asked = await helper("absolute", {
    question: "absolute",
    words,
    now: stamp(now, zone),
    zone,
    weekday: weekdayOf(now, zone),
  });
  if (asked.refused !== undefined) {
    return { refused: asked.refused };
  }
  const moment = asked.answer.until;
  if (moment === null) {
    return { refused: `until "${words}" could not be placed on the calendar; say when as a date or as plainer words` };
  }
  if (Date.parse(moment) <= now.getTime()) {
    return { refused: `until "${words}" is a moment that has passed (${said(moment, zone)}); give a moment ahead, or now to retire` };
  }
  return { until: moment };
}
