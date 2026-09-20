// The store: memory and knowledge behind `recall` and `remember`, and what every session is told
// about the hard rules.
//
// The first half calls lib/store.mjs directly — a scratch root, a clock handed in, a helper that
// answers what a check stages — because the rules of the store are rules of that module and the
// question each check asks is answered there. The second half serves a chat in this process,
// starts a Worker and the Leader on it, and calls the two tools over each one's own door — its
// secret, read from the stand-in's log — with the stand-in answering the helper: what the tool
// sent it is read from that log, and what the tool did with the answer from the tool's own reply.
//
// The helper is never a model here. Every mutation in tests/mutations-store.json names the check
// it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  HARD_RULE,
  HARD_RULES,
  LEADER,
  WORKER,
  hardRulesFor,
  hardRulesIn,
  onHardRulesChanged,
  parse,
  readStore,
  recall,
  remember,
  renderHardRules,
  said,
  setVersion,
  storeDirectory,
  withHardRules,
  withoutHardRules,
} from "../lib/store.mjs";
import { BUILT_IN } from "../lib/plugins.mjs";
import { hire, persona } from "../lib/desks.mjs";
import { endSeat, serve, startSeat } from "../lib/chat/server.mjs";
import { CONFIG_FILE } from "../lib/seed.mjs";
import { installed, post, readLog, remove, repo, scratch, secretsIn, standInEnvironment, waitFor, writeStandIn } from "./helpers.mjs";

const ZONE = "Europe/Warsaw";
const NOW = new Date("2026-09-12T19:04:11+02:00");
const SUPERMAN = { name: "Superman", role: LEADER };
const PAUL = { name: "Paul", role: WORKER };

const base = scratch("store-test");
let roots = 0;

// A root of its own for each describe, so nothing one describe wrote is a record another reads.
function freshRoot() {
  roots += 1;
  const root = `${base}-${roots}`;
  remove(root);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// A helper that answers what a check staged, in order, and remembers what it was asked. Answers
// are `{ answer }` in the validated shape or `{ refused }`; nothing staged is the empty shape the
// tool has to refuse.
function stubHelper() {
  const asked = [];
  const answers = [];
  const helper = async (question, request) => {
    asked.push({ question, request });
    return answers.shift() ?? { refused: "the helper answered badly" };
  };
  return { helper, asked, answers };
}

// The helper as most checks want it: nothing replaces anything, nothing answers a query, no words
// name a moment. A check about what the helper is asked, or what is done with its answer, brings
// its own.
async function nothing(question) {
  return { answer: { select: { ids: [] }, replaces: { replaces: null, reason: "new" }, absolute: { until: null } }[question] };
}

function context(root, overrides = {}) {
  return { caller: SUPERMAN, now: NOW, zone: ZONE, config: {}, helper: nothing, ...overrides };
}

function filesIn(root, store) {
  try {
    return fs.readdirSync(storeDirectory(root, store)).sort();
  } catch {
    return [];
  }
}

function recordFile(root, store, n) {
  return path.join(storeDirectory(root, store), `${String(n).padStart(6, "0")}.md`);
}

function readRecord(root, store, n) {
  return parse(fs.readFileSync(recordFile(root, store, n), "utf8"));
}

async function rule(root, text, extra = {}, ctx = {}) {
  return remember(root, { store: "memory", kind: HARD_RULE, text, ...extra }, context(root, ctx));
}

process.on("exit", () => {
  for (let i = 1; i <= roots; i += 1) {
    remove(`${base}-${i}`);
  }
});

// ---------------------------------------------------------------------------------------------

describe("who may write what", () => {
  const root = freshRoot();

  it("refuses a Worker's hard rule and writes no file", async () => {
    const said = await rule(root, "Never push", {}, { caller: PAUL });
    assert.match(said.refused ?? "", /hard rules are the Leader's to write/);
    assert.deepEqual(filesIn(root, "memory"), []);
  });

  it("refuses a Worker's source user", async () => {
    const said = await remember(root, { store: "memory", kind: "fact", text: "a fact", source: "user" }, context(root, { caller: PAUL }));
    assert.match(said.refused ?? "", /a Worker's write is always source team and scope team/);
  });

  it("refuses a Worker's scope leader", async () => {
    const said = await remember(root, { store: "memory", kind: "fact", text: "a fact", scope: "leader" }, context(root, { caller: PAUL }));
    assert.match(said.refused ?? "", /a Worker's write is always source team and scope team/);
  });

  it("refuses scope leader on a team rule", async () => {
    const said = await rule(root, "Never push", { scope: "leader" });
    assert.match(said.refused ?? "", /scope leader is for a hard-rule with source user/);
    assert.deepEqual(filesIn(root, "memory"), []);
  });

  it("refuses a hard rule in knowledge", async () => {
    const said = await remember(root, { store: "knowledge", kind: HARD_RULE, text: "the port is chosen at install" }, context(root));
    assert.match(said.refused ?? "", /kind in knowledge is fact or trap/);
    assert.deepEqual(filesIn(root, "knowledge"), []);
  });

  it("refuses a hard rule one character over the length and takes one at it", async () => {
    const config = { hardRules: { count: 25, length: 20 } };
    const over = await rule(root, "x".repeat(21), {}, { config });
    assert.match(over.refused ?? "", /at most 20 characters and this one is 21/);
    const at = await rule(root, "y".repeat(20), {}, { config });
    assert.equal(at.refused, undefined, at.refused);
    assert.deepEqual(filesIn(root, "memory"), ["000001.md"]);
  });

  it("refuses a hard rule holding a newline", async () => {
    const said = await rule(root, "one line\nand another");
    assert.match(said.refused ?? "", /one line; take the newline out/);
    assert.deepEqual(filesIn(root, "memory"), ["000001.md"]);
  });
});

describe("when a record runs out", () => {
  const root = freshRoot();

  it("stores the helper's absolute moment for until given in words, never the words", async () => {
    const { helper, answers, asked } = stubHelper();
    answers.push({ answer: { until: "2026-09-14T23:59:59+02:00" } });
    const said = await rule(root, "Never push before the release commit is on main", { until: "until Monday" }, { helper });
    assert.equal(said.refused, undefined, said.refused);
    assert.equal(asked.at(0)?.question, "absolute");
    assert.equal(asked.at(0)?.request.words, "until Monday");
    assert.equal(readRecord(root, "memory", 1).until, "2026-09-14T23:59:59+02:00");
  });

  it("refuses until words the helper cannot place, quoting them, and writes nothing", async () => {
    const { helper, answers } = stubHelper();
    answers.push({ answer: { until: null } });
    const said = await rule(root, "Prefer Conventional Commits", { until: "whenever" }, { helper });
    assert.match(said.refused ?? "", /until "whenever" could not be placed/);
    assert.deepEqual(filesIn(root, "memory"), ["000001.md"]);
  });

  it("refuses an absolute until that has passed", async () => {
    const said = await rule(root, "Prefer Conventional Commits", { until: "2026-09-12T19:04:10+02:00" });
    assert.match(said.refused ?? "", /has passed/);
    assert.deepEqual(filesIn(root, "memory"), ["000001.md"]);
  });

  it("takes until now from its own clock, asks the helper nothing, and so retires without a request on the account", async () => {
    const { helper, asked } = stubHelper();
    const said = await rule(root, "Never push before the release commit is on main", { replaces: "m1", until: "now" }, { helper });
    assert.equal(said.refused, undefined, said.refused);
    assert.deepEqual(asked, []);
    assert.equal(readRecord(root, "memory", 2).until, "2026-09-12T19:04:11+02:00");
  });

  it("retires a rule with until now and brings it back with a renew", async () => {
    const { helper, asked } = stubHelper();
    const lead = hardRulesFor(root, LEADER, { now: NOW, zone: ZONE });
    const worker = hardRulesFor(root, WORKER, { now: NOW, zone: ZONE });
    assert.doesNotMatch(lead.text, /release commit/);
    assert.doesNotMatch(worker.text, /release commit/);
    const listed = await recall(root, { store: "memory", kind: HARD_RULE, expired: true }, context(root, { helper }));
    assert.match(listed.text, /\[m2\] hard-rule 1, team, until 2026-09-12 19:04 CEST - "Never push before the release commit is on main" \(expired 2026-09-12 19:04 CEST\)\n\s+by Leader, 2026-09-12 19:04 CEST/);
    const renewed = await rule(root, "Never push before the release commit is on main", { replaces: "m2", until: "2026-09-20T23:59:59+02:00" }, { helper });
    assert.equal(renewed.refused, undefined, renewed.refused);
    assert.deepEqual(asked, []);
    assert.match(hardRulesFor(root, LEADER, { now: NOW, zone: ZONE }).text, /\n  1\. Never push before the release commit is on main \(until 2026-09-20 23:59 CEST\)/);
  });
});

describe("replacing", () => {
  const root = freshRoot();

  before(async () => {
    await rule(root, "Never push on Fridays", { source: "user" });
    await remember(root, { store: "memory", kind: "fact", text: "the User prefers a dark palette" }, context(root));
    await remember(root, { store: "knowledge", kind: "fact", text: "the port is chosen at install" }, context(root));
  });

  it("refuses replaces naming a missing id or one of another store or kind", async () => {
    const missing = await remember(root, { store: "memory", kind: "fact", text: "a fact", replaces: "m99" }, context(root));
    assert.match(missing.refused ?? "", /m99 is not a current fact record of memory/);
    const otherKind = await remember(root, { store: "memory", kind: "trap", text: "a trap", replaces: "m2" }, context(root));
    assert.match(otherKind.refused ?? "", /m2 is not a current trap record of memory/);
    const otherStore = await remember(root, { store: "memory", kind: "fact", text: "a fact", replaces: "k1" }, context(root));
    assert.match(otherStore.refused ?? "", /k1 is not a current fact record of memory/);
    assert.deepEqual(filesIn(root, "memory"), ["000001.md", "000002.md"]);
  });

  it("refuses a team write over the User's record, the Leader included", async () => {
    const said = await rule(root, "Never push on Fridays or Mondays", { replaces: "m1" });
    assert.match(said.refused ?? "", /m1 is the User's hard-rule; only a write with source user can replace it/);
    assert.deepEqual(filesIn(root, "memory"), ["000001.md", "000002.md"]);
  });

  it("writes provenance: by, at, supersedes, the replaced text byte for byte, the reason", async () => {
    const said = await rule(root, "Never push before the release commit is on main", { source: "user", replaces: "m1", reason: "the User widened it" }, { caller: SUPERMAN });
    assert.equal(said.refused, undefined, said.refused);
    const record = readRecord(root, "memory", 3);
    assert.equal(record.by, "Leader");
    assert.equal(record.at, "2026-09-12T19:04:11+02:00");
    assert.equal(record.supersedes, "m1");
    assert.equal(record.replaced, "Never push on Fridays");
    assert.equal(record.reason, "the User widened it");
    const given = await rule(root, "Never push before the release commit is on main, ever", { source: "user", replaces: "m3" });
    assert.equal(given.refused, undefined, given.refused);
    assert.equal(readRecord(root, "memory", 4).reason, "given");
  });

  it("lists a replaced record under neither all nor the render, and marks it by id", async () => {
    const all = await recall(root, { store: "memory", all: true }, context(root));
    assert.doesNotMatch(all.text, /\[m1\]/);
    assert.doesNotMatch(all.text, /\[m3\]/);
    assert.match(all.text, /\[m4\]/);
    assert.doesNotMatch(hardRulesFor(root, LEADER, { now: NOW, zone: ZONE }).text, /Never push on Fridays\n/);
    const one = await recall(root, { store: "memory", id: "m1" }, context(root));
    assert.match(one.text, /^\[m1\] hard-rule 1, user - "Never push on Fridays" \(replaced by m3\)/);
  });

  it("names the current successor when replaces points at a replaced record", async () => {
    const said = await rule(root, "anything", { source: "user", replaces: "m1" });
    assert.match(said.refused ?? "", /m1 was replaced by m3; replace the current record instead/);
  });

  // The store never chooses. Without `replaces`, a text that is a record already held — byte for
  // byte, or as the helper judges — is refused with that record, and the writer names it or says none.
  it("refuses the same text again without asking the helper, naming the record, and writes nothing", async () => {
    const { helper, asked } = stubHelper();
    const said = await remember(root, { store: "memory", kind: "fact", text: "  the User prefers a   dark palette " }, context(root, { helper }));
    assert.equal(
      said.refused,
      'not written: this reads as [m2] "the User prefers a dark palette" restated, widened, narrowed or reversed — the same text; re-issue with replaces: m2 if so, or replaces: none for a new record',
    );
    assert.deepEqual(asked, []);
    assert.deepEqual(filesIn(root, "memory"), ["000001.md", "000002.md", "000003.md", "000004.md"]);
  });

  it("asks the helper about the current records of the same store and kind only, and refuses with the record it names, its text and the reason, writing nothing", async () => {
    const widened = await remember(root, { store: "memory", kind: "fact", text: "the User prefers a dark palette, on every panel", replaces: "m2", reason: "widened" }, context(root));
    assert.equal(widened.refused, undefined, widened.refused);
    const { helper, asked, answers } = stubHelper();
    answers.push({ answer: { replaces: "m5", reason: "the same preference, reversed" } });
    const said = await remember(root, { store: "memory", kind: "fact", text: "the User prefers a light palette" }, context(root, { helper }));
    assert.equal(
      said.refused,
      'not written: this reads as [m5] "the User prefers a dark palette, on every panel" restated, widened, narrowed or reversed — the same preference, reversed; re-issue with replaces: m5 if so, or replaces: none for a new record',
    );
    assert.equal(asked.length, 1);
    assert.equal(asked[0].question, "replaces");
    assert.deepEqual(
      asked[0].request.records.map((record) => record.id),
      ["m5"],
    );
    assert.deepEqual(filesIn(root, "memory").length, 5);
    // The User's record is named like any other: the refusal comes before the door on it.
    const { helper: names, answers: staged } = stubHelper();
    staged.push({ answer: { replaces: "m4", reason: "the same rule" } });
    const rule_ = await rule(root, "Push only after the release commit is on main", {}, { helper: names });
    assert.match(rule_.refused ?? "", /^not written: this reads as \[m4\] "Never push before the release commit is on main, ever" restated, widened, narrowed or reversed — the same rule;/);
    assert.deepEqual(filesIn(root, "memory").length, 5);
  });

  it("writes a new record on replaces none without asking the helper", async () => {
    const { helper, asked, answers } = stubHelper();
    answers.push({ answer: { replaces: "m5", reason: "the same preference, reversed" } });
    const said = await remember(root, { store: "memory", kind: "fact", text: "the User prefers a light palette", replaces: "none" }, context(root, { helper }));
    assert.equal(said.refused, undefined, said.refused);
    assert.deepEqual(asked, []);
    const record = readRecord(root, "memory", 6);
    assert.equal(record.text, "the User prefers a light palette");
    assert.equal(record.supersedes, undefined);
    assert.equal(record.reason, undefined);
    assert.match(said.text, /^\[m6\] fact, team - "the User prefers a light palette"\n\s+by Leader, 2026-09-12 19:04 CEST$/);
  });

  it("refuses a reason without replaces naming a record", async () => {
    for (const replaces of [undefined, "none"]) {
      const said = await remember(root, { store: "memory", kind: "fact", text: "a fact with a reason", replaces, reason: "because" }, context(root));
      assert.equal(said.refused, "reason goes with replaces naming a record; leave it out or name what this replaces");
    }
    assert.deepEqual(filesIn(root, "memory").length, 6);
  });

  // The file appears between the read and the open — planted while the helper is being asked,
  // which is the one moment a write is waiting on anything.
  it("opens the file with wx: a file already at the next name fails the write and nothing is overwritten", async () => {
    const planted = "---\nid: m7\nstore: memory\nkind: fact\nsource: team\nscope: team\nby: Leader\nat: 2026-09-12T19:04:11+02:00\n---\nplanted\n";
    const helper = async () => {
      fs.writeFileSync(recordFile(root, "memory", 7), planted);
      return { answer: { replaces: null, reason: "new" } };
    };
    await assert.rejects(remember(root, { store: "memory", kind: "fact", text: "a seventh fact" }, context(root, { helper })), /EEXIST/);
    assert.equal(fs.readFileSync(recordFile(root, "memory", 7), "utf8"), planted);
    fs.rmSync(recordFile(root, "memory", 7));
  });
});

describe("restoring", () => {
  const root = freshRoot();
  const asPaul = { caller: PAUL };

  before(async () => {
    await remember(root, { store: "knowledge", kind: "fact", text: "the backlog: A, B, C" }, context(root));
    await remember(root, { store: "knowledge", kind: "fact", text: "the backlog: D", replaces: "k1", reason: "wrote over it" }, context(root));
    await rule(root, "Never push on Fridays", { source: "user" });
    await rule(root, "Never push on Fridays or Mondays", { source: "user", replaces: "m1" });
    await remember(root, { store: "memory", kind: "fact", text: "the User's fact", source: "user" }, context(root));
    await remember(root, { store: "memory", kind: "fact", text: "the User's fact, changed", source: "user", replaces: "m3" }, context(root));
  });

  it("brings a replaced record back live under its id by a marker file, the record that replaced it standing, and says so on its line", async () => {
    const said = await remember(root, { store: "knowledge", restore: "k1" }, context(root, asPaul));
    assert.equal(said.refused, undefined, said.refused);
    assert.equal(
      said.text,
      '[k1] fact, team - "the backlog: A, B, C"\n      by Leader, 2026-09-12 19:04 CEST; restored by Paul (Worker), 2026-09-12 19:04 CEST (had been replaced by k2, which stands)',
    );
    assert.deepEqual(readRecord(root, "knowledge", 3), { id: "k3", store: "knowledge", by: "Paul (Worker)", at: "2026-09-12T19:04:11+02:00", restores: "k1", text: "" });
    const all = await recall(root, { store: "knowledge", all: true }, context(root));
    assert.match(all.text, /^\[k1\] fact, team - "the backlog: A, B, C"\n/);
    assert.match(all.text, /\n\[k2\] fact, team - "the backlog: D"\n/);
    assert.doesNotMatch(all.text, /k3/);
    const one = await recall(root, { store: "knowledge", id: "k1" }, context(root));
    assert.equal(one.text, said.text);
    const marker = await recall(root, { store: "knowledge", id: "k3" }, context(root));
    assert.equal(marker.text, "k3 is not a record: it restored k1 (by Paul (Worker), 2026-09-12 19:04 CEST)");
  });

  it("hands the helper the restored record with the rest, and a later replacement of it takes the restored line off", async () => {
    const { helper, asked, answers } = stubHelper();
    answers.push({ answer: { replaces: null, reason: "new" } });
    const other = await remember(root, { store: "knowledge", kind: "fact", text: "something else entirely" }, context(root, { helper }));
    assert.equal(other.refused, undefined, other.refused);
    assert.deepEqual(asked[0].request.records.map((record) => record.id), ["k1", "k2"]);
    const again = await remember(root, { store: "knowledge", kind: "fact", text: "the backlog: A, B, C, E", replaces: "k1" }, context(root));
    assert.equal(again.refused, undefined, again.refused);
    const one = await recall(root, { store: "knowledge", id: "k1" }, context(root));
    assert.match(one.text, /^\[k1\] fact, team - "the backlog: A, B, C" \(replaced by k5\)\n\s+by Leader, 2026-09-12 19:04 CEST$/);
  });

  it("refuses restoring an unknown id, a marker, a current record, a hard rule, or the User's record from a Worker, and writes nothing", async () => {
    const knowledge = filesIn(root, "knowledge").length;
    const memory = filesIn(root, "memory").length;
    const unknown = await remember(root, { store: "knowledge", restore: "k99" }, context(root));
    assert.equal(unknown.refused, "k99 is not a record of knowledge; restore names a replaced record by its id");
    const marker = await remember(root, { store: "knowledge", restore: "k3" }, context(root));
    assert.equal(marker.refused, "k3 is not a record of knowledge; restore names a replaced record by its id");
    const live = await remember(root, { store: "knowledge", restore: "k2" }, context(root));
    assert.equal(live.refused, "k2 is current; nothing to restore");
    const hardRule = await remember(root, { store: "memory", restore: "m1" }, context(root));
    assert.equal(hardRule.refused, "m1 is a hard rule; a hard rule comes back by being written again with replaces naming the rule that holds number 1");
    const users = await remember(root, { store: "memory", restore: "m3" }, context(root, asPaul));
    assert.equal(users.refused, "m3 is the User's fact; the Leader restores it");
    assert.equal(filesIn(root, "knowledge").length, knowledge);
    assert.equal(filesIn(root, "memory").length, memory);
    const leader = await remember(root, { store: "memory", restore: "m3" }, context(root));
    assert.equal(leader.refused, undefined, leader.refused);
    assert.equal(filesIn(root, "memory").length, memory + 1);
  });

  it("refuses a restore with anything beside store and restore, or one that is not an id", async () => {
    const beside = await remember(root, { store: "knowledge", restore: "k1", kind: "fact", text: "a text" }, context(root));
    assert.equal(beside.refused, "restore goes alone with store; take kind, text out");
    const notAnId = await remember(root, { store: "knowledge", restore: 1 }, context(root));
    assert.equal(notAnId.refused, "restore is a record id such as k47");
    const noStore = await remember(root, { restore: "k1" }, context(root));
    assert.equal(noStore.refused, "store is memory or knowledge");
  });
});

describe("the cap and the numbers", () => {
  const root = freshRoot();
  const config = { hardRules: { count: 3, length: 50 } };

  it("reads the cap and the length from the workspace configuration, with the defaults when absent", () => {
    assert.deepEqual(hardRulesIn({}), { count: 25, length: 200 });
    assert.deepEqual(hardRulesIn(config), { count: 3, length: 50 });
    assert.deepEqual(HARD_RULES, { count: 25, length: 200 });
  });

  it("refuses the rule over the cap with the count and the numbered set, and takes a replacement of a current one at the cap", async () => {
    for (const text of ["rule one", "rule two", "rule three"]) {
      const said = await rule(root, text, {}, { config });
      assert.equal(said.refused, undefined, said.refused);
    }
    const over = await rule(root, "rule four", {}, { config });
    assert.match(over.refused ?? "", /holds 3 hard rules and the cap is 3/);
    assert.match(over.refused ?? "", /\n  1\. rule one\n  2\. rule two\n  3\. rule three/);
    const replacement = await rule(root, "rule two, widened", { replaces: "m2" }, { config });
    assert.equal(replacement.refused, undefined, replacement.refused);
    assert.deepEqual(filesIn(root, "memory").length, 4);
  });

  it("counts Leader-scoped rules toward the cap", async () => {
    const own = freshRoot();
    await rule(own, "for the Leader only", { source: "user", scope: "leader" }, { config });
    await rule(own, "rule two", {}, { config });
    await rule(own, "rule three", {}, { config });
    const over = await rule(own, "rule four", {}, { config });
    assert.match(over.refused ?? "", /holds 3 hard rules and the cap is 3/);
  });

  it("leaves expired rules out of the count", async () => {
    const retired = await rule(root, "rule three", { replaces: "m3", until: "now" }, { config });
    assert.equal(retired.refused, undefined, retired.refused);
    const room = await rule(root, "rule five", {}, { config });
    assert.equal(room.refused, undefined, room.refused);
  });

  it("numbers a new rule past every number ever given and hands a replacement the number it replaces", async () => {
    assert.equal(readRecord(root, "memory", 4).number, 2);
    assert.equal(readRecord(root, "memory", 5).number, 3);
    assert.equal(readRecord(root, "memory", 6).number, 4);
    const own = freshRoot();
    await rule(own, "rule one", {}, { config });
    await rule(own, "rule two", {}, { config });
    await rule(own, "rule one, retired", { replaces: "m1", until: "now" }, { config });
    const next = await rule(own, "rule three", {}, { config });
    assert.equal(next.refused, undefined, next.refused);
    assert.equal(readRecord(own, "memory", 4).number, 3);
  });

  it("gives two rules remembered at once distinct numbers and holds the cap", async () => {
    const own = freshRoot();
    await rule(own, "rule one", {}, { config });
    await rule(own, "rule two", {}, { config });
    const [a, b] = await Promise.all([rule(own, "rule three", {}, { config }), rule(own, "rule four", {}, { config })]);
    const written = [a, b].filter((said) => said.refused === undefined);
    const refused = [a, b].filter((said) => said.refused !== undefined);
    assert.equal(written.length, 1, JSON.stringify([a, b]));
    assert.equal(refused.length, 1);
    assert.match(refused[0].refused, /the cap is 3/);
    assert.deepEqual(filesIn(own, "memory").map((name) => readRecord(own, "memory", Number(name.slice(0, 6))).number), [1, 2, 3]);
  });
});

describe("the render", () => {
  const root = freshRoot();

  before(async () => {
    await rule(root, "Answer in English even when addressed in another language", { source: "user" });
    await rule(root, "Prefer Conventional Commits unless the repository already uses another convention");
    await rule(root, "Never push before the release commit is on main", { source: "user", until: "2026-09-14T23:59:59+02:00" });
    await rule(root, "Never `cd x && <command>`; absolute paths from every tool  !");
    await rule(root, "for the Leader only", { source: "user", scope: "leader" });
    await rule(root, "ran out yesterday", { until: "2026-09-13T00:00:00+02:00" });
    await remember(root, { store: "memory", kind: "fact", text: "the User prefers a dark palette" }, context(root));
  });

  it("renders the User's rules first, then the team's, by number inside each", () => {
    const { text } = hardRulesFor(root, LEADER, { now: NOW, zone: ZONE });
    assert.equal(
      text,
      [
        "Hard rules (set m6). Follow them as written; they are numbered so you can name one.",
        "From the User:",
        "  1. Answer in English even when addressed in another language",
        "  3. Never push before the release commit is on main (until 2026-09-14 23:59 CEST)",
        "  5. for the Leader only",
        "From the team:",
        "  2. Prefer Conventional Commits unless the repository already uses another convention",
        "  4. Never `cd x && <command>`; absolute paths from every tool  !",
        "  6. ran out yesterday (until 2026-09-13 00:00 CEST)",
      ].join("\n"),
    );
  });

  it("leaves expired rules out of the render and shows them marked on recall with expired", async () => {
    const later = new Date("2026-09-15T09:00:00+02:00");
    const { text } = hardRulesFor(root, LEADER, { now: later, zone: ZONE });
    assert.doesNotMatch(text, /release commit/);
    assert.doesNotMatch(text, /ran out yesterday/);
    assert.match(text, /\n  4\. Never `cd x/);
    const listed = await recall(root, { store: "memory", kind: HARD_RULE, expired: true }, context(root, { now: later }));
    assert.match(listed.text, /\[m3\] hard-rule 3, user, until 2026-09-14 23:59 CEST - "Never push before the release commit is on main" \(expired 2026-09-14 23:59 CEST\)/);
    const all = await recall(root, { store: "memory", kind: HARD_RULE, all: true }, context(root, { now: later }));
    assert.doesNotMatch(all.text, /\[m3\]/);
  });

  it("keeps a Leader-scoped rule from a Worker on every path", async () => {
    const worker = context(root, { caller: PAUL });
    assert.doesNotMatch(hardRulesFor(root, WORKER, { now: NOW, zone: ZONE }).text, /for the Leader only/);
    assert.match(hardRulesFor(root, LEADER, { now: NOW, zone: ZONE }).text, /for the Leader only/);
    assert.equal((await recall(root, { store: "memory", id: "m5" }, worker)).text, "no record m5 in memory");
    assert.match((await recall(root, { store: "memory", id: "m5" }, context(root))).text, /for the Leader only/);
    assert.doesNotMatch((await recall(root, { store: "memory", all: true }, worker)).text, /for the Leader only/);
    assert.doesNotMatch((await recall(root, { store: "memory", kind: HARD_RULE }, worker)).text, /for the Leader only/);
    const { helper, asked, answers } = stubHelper();
    answers.push({ answer: { ids: [] } });
    await recall(root, { store: "memory", query: "the Leader" }, { ...worker, helper });
    assert.ok(asked.length === 1 && asked[0].request.records.length > 0, "the helper was asked nothing");
    assert.deepEqual(
      asked[0].request.records.filter((record) => record.text === "for the Leader only"),
      [],
    );
  });

  it("says until in the workspace zone with its label", () => {
    const { current } = readStore(root, "memory", { role: LEADER });
    assert.match(renderHardRules(current, { role: LEADER, now: NOW, zone: "Asia/Kolkata" }), /\(until 2026-09-15 03:29 GMT\+5:30\)/);
    assert.match(renderHardRules(current, { role: LEADER, now: NOW, zone: "Europe/Warsaw" }), /\(until 2026-09-14 23:59 CEST\)/);
    assert.equal(said("2026-09-14T23:59:59+02:00", "Asia/Kolkata"), "2026-09-15 03:29 GMT+5:30");
  });

  it("says until the same way on the recall line and in the render", async () => {
    const line = await recall(root, { store: "memory", id: "m3" }, context(root));
    assert.match(line.text, /until 2026-09-14 23:59 CEST - /);
    assert.match(hardRulesFor(root, LEADER, { now: NOW, zone: ZONE }).text, /\(until 2026-09-14 23:59 CEST\)/);
  });

  it("renders a rule's text byte for byte", () => {
    const { text } = hardRulesFor(root, LEADER, { now: NOW, zone: ZONE });
    assert.match(text, /\n  4\. Never `cd x && <command>`; absolute paths from every tool  !\n/);
  });

  it("says none yet for an empty set and omits a heading with no rules", async () => {
    const empty = freshRoot();
    assert.equal(hardRulesFor(empty, LEADER, { now: NOW, zone: ZONE }).text, "Hard rules (set none): none yet.");
    assert.equal(hardRulesFor(empty, LEADER, { now: NOW, zone: ZONE }).version, null);
    await rule(empty, "a team rule");
    const { text } = hardRulesFor(empty, WORKER, { now: NOW, zone: ZONE });
    assert.doesNotMatch(text, /From the User:/);
    assert.match(text, /From the team:\n  1\. a team rule$/);
  });

  it("versions the set by the newest current hard rule: a fact leaves it, a retire moves it", async () => {
    const own = freshRoot();
    assert.equal(setVersion(readStore(own, "memory", { role: LEADER }).current), null);
    await rule(own, "rule one");
    await rule(own, "rule two");
    assert.equal(hardRulesFor(own, LEADER, { now: NOW, zone: ZONE }).version, "m2");
    await remember(own, { store: "memory", kind: "fact", text: "a fact" }, context(own));
    assert.equal(hardRulesFor(own, LEADER, { now: NOW, zone: ZONE }).version, "m2");
    await rule(own, "rule two", { replaces: "m2", until: "now" });
    assert.equal(hardRulesFor(own, LEADER, { now: NOW, zone: ZONE }).version, "m4");
    assert.match(hardRulesFor(own, WORKER, { now: NOW, zone: ZONE }).text, /^Hard rules \(set m4\)/);
  });
});

describe("what a running session is told", () => {
  const root = freshRoot();
  const heard = [];
  let off;

  before(async () => {
    off = onHardRulesChanged((version, renderFor) => heard.push({ version, lead: renderFor(LEADER), worker: renderFor(WORKER) }));
    for (let i = 1; i <= 25; i += 1) {
      const said = await rule(root, `rule ${i}`);
      assert.equal(said.refused, undefined, said.refused);
    }
    await remember(root, { store: "memory", kind: "fact", text: "a fact" }, context(root));
  });

  after(() => off());

  it("says the delta on an update: the rule, its old text, the version, never the set", async () => {
    heard.length = 0;
    const said = await rule(root, "rule 7, widened", { replaces: "m7" });
    assert.equal(said.refused, undefined, said.refused);
    assert.equal(heard.length, 1);
    assert.equal(heard[0].version, "m27");
    assert.equal(heard[0].worker, 'Hard rules update (set m27): rule 7 now reads "rule 7, widened" (replaced "rule 7").');
    assert.equal(heard[0].lead, heard[0].worker);
    assert.doesNotMatch(heard[0].lead, /rule 8/);
  });

  it("says nothing to a Worker about a rule scoped to the Leader", async () => {
    heard.length = 0;
    const said = await rule(root, "rule 8, for the Leader", { replaces: "m8", source: "user", scope: "leader" });
    assert.equal(said.refused, undefined, said.refused);
    assert.equal(heard.length, 1);
    assert.equal(heard[0].worker, null);
    assert.match(heard[0].lead, /rule 8 now reads "rule 8, for the Leader"/);
  });

  it("says new for a new rule and retired for a retire", async () => {
    heard.length = 0;
    await rule(root, "rule 9", { replaces: "m9", until: "now" });
    assert.equal(heard.at(-1)?.lead, 'Hard rules update (set m29): rule 9 retired: "rule 9".');
    const fresh = await rule(root, "rule twenty-six");
    assert.equal(fresh.refused, undefined, fresh.refused);
    assert.equal(heard.at(-1)?.lead, 'Hard rules update (set m30): rule 26, new: "rule twenty-six".');
  });

  it("announces once per hard-rule write and never for a fact", async () => {
    heard.length = 0;
    await remember(root, { store: "memory", kind: "fact", text: "another fact" }, context(root));
    await remember(root, { store: "knowledge", kind: "trap", text: "a trap" }, context(root));
    assert.equal(heard.length, 0);
    await rule(root, "rule 10, widened", { replaces: "m10" });
    assert.equal(heard.length, 1);
  });

  it("answers a hard-rule write with the record, the update line with the version, and what happens next", async () => {
    const said = await rule(root, "rule 11, widened", { replaces: "m11" });
    assert.match(said.text, /^\[m\d+\] hard-rule 11, team - "rule 11, widened"\n\s+by Leader, 2026-09-12 19:04 CEST; replaced m11 \("rule 11"\)\n/);
    assert.match(said.text, /\nHard rules update \(set m\d+\): rule 11 now reads "rule 11, widened" \(replaced "rule 11"\)\.\n/);
    assert.match(said.text, /\nEvery running session gets this on its next turn; every new session gets the set\.$/);
  });
});

describe("the persona a session is spawned with", () => {
  const root = freshRoot();

  before(async () => {
    await rule(root, "a team rule");
    await rule(root, "for the Leader only", { source: "user", scope: "leader" });
  });

  it("ends the persona with the render for that role and returns the version", () => {
    const lead = withHardRules("You lead.\n", root, LEADER, { now: NOW, zone: ZONE });
    const worker = withHardRules("You work.\n", root, WORKER, { now: NOW, zone: ZONE });
    assert.equal(lead.version, "m2");
    assert.equal(worker.version, "m2");
    assert.match(lead.text, /^You lead\.\n\nHard rules \(set m2\)\./);
    assert.match(lead.text, /for the Leader only/);
    assert.match(worker.text, /^You work\.\n\nHard rules \(set m2\)\./);
    assert.doesNotMatch(worker.text, /for the Leader only/);
    assert.match(worker.text, /\n  1\. a team rule\n$/);
  });

  it("takes the render off a persona and leaves the rest", () => {
    const lead = withHardRules("You lead.\n\nHard rules (set m1) is a phrase in the persona.\n", root, LEADER, { now: NOW, zone: ZONE });
    assert.equal(withoutHardRules(lead.text), "You lead.\n\nHard rules (set m1) is a phrase in the persona.\n");
    assert.equal(withoutHardRules("A persona with no render.\n"), "A persona with no render.\n");
    // The exact inverse on the persona an installed instance really spawns its Leader with, byte
    // for byte: a running session's instructions minus the render must equal what the instance
    // renders now, or every hard-rule write would read as older instructions.
    const real = persona(instance, CHAT_LEADER, { user: USER, leader: CHAT_LEADER });
    assert.match(real, /[^\n]\n$/, "the leader template must end in exactly one newline");
    assert.equal(withoutHardRules(withHardRules(real, root, LEADER, { now: NOW, zone: ZONE }).text), real);
  });
});

describe("what recall accepts", () => {
  const root = freshRoot();

  it("refuses a recall with two of query, id and all, or none", async () => {
    const two = await recall(root, { store: "memory", id: "m1", all: true }, context(root));
    assert.match(two.refused ?? "", /give exactly one of query, id or all/);
    const none = await recall(root, { store: "memory" }, context(root));
    assert.match(none.refused ?? "", /give exactly one of query, id or all/);
  });

  it("refuses kind hard-rule in knowledge on recall", async () => {
    const said = await recall(root, { store: "knowledge", kind: HARD_RULE }, context(root));
    assert.match(said.refused ?? "", /hard rules are memory/);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the chat: the two tools over a session's own door, the stand-in answering the helper.

const USER = "Mike";
const CHAT_LEADER = "Superman";
const CHAT_WORKER = "Paul";

const instance = `${base}-chat`;
const standIn = `${base}-stand-in`;
const log = path.join(standIn, "calls.txt");
const helperAnswer = path.join(standIn, "helper-answer.json");

// The chat, served in this process; the seats' processes are the stand-in, started through the one
// seam that starts a seat, and each one's door is the secret it was given.
let server = null;
let url = null;
const doors = {};
const warned = [];
const served = [];
let warn = null;
let log_ = null;
let environmentBefore = null;

process.on("exit", () => {
  remove(instance, standIn);
});

function options(root) {
  return {
    "--root": root,
    "--source": repo,
    "--user": USER,
    "--leader": CHAT_LEADER,
    "--leader-model": "sonnet",
    "--worker-model": "sonnet",
    "--port": 0,
    "--auth": "login",
  };
}

function call(as, method, params) {
  return post(`${url}/mcp/${doors[as]}`, { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
}

function answerOf(said) {
  const body = JSON.parse(said.body);
  return { text: body.result?.content?.[0]?.text, refused: body.result?.isError === true, error: body.error ?? null };
}

async function tool(as, name, args) {
  return answerOf(await call(as, "tools/call", { name, arguments: args }));
}

async function listed(as) {
  return JSON.parse((await call(as, "tools/list")).body).result.tools.map((tool) => tool.name);
}

async function described(as, name) {
  return JSON.parse((await call(as, "tools/list")).body).result.tools.find((tool) => tool.name === name).description;
}

function stage(answer) {
  fs.writeFileSync(helperAnswer, JSON.stringify(answer));
}

// The helper requests the stand-in read, whole and in order.
function helperRequests() {
  return readLog(log)
    .split("\n")
    .filter((line) => line.startsWith("helper: "))
    .map((line) => JSON.parse(line.slice("helper: ".length)));
}

function helperCalls() {
  return readLog(log).split("\n").filter((line) => line.startsWith("helper-argv: ")).length;
}

// The helper runs on the environment this process has, so the stand-in's knobs are set on it for
// the checks and taken off after them; a knob set for one call is set and unset around that call.
async function withKnob(name, body) {
  process.env[name] = "1";
  try {
    return await body();
  } finally {
    delete process.env[name];
  }
}

remove(instance, standIn);
writeStandIn(standIn);
installed(options(instance));
hire(instance, CHAT_WORKER);

describe("the tools the chat serves for the store", () => {
  before(async () => {
    environmentBefore = { ...process.env };
    Object.assign(process.env, standInEnvironment(standIn, log, { OPENOVAI_STAND_IN_HELPER: helperAnswer }));
    warn = console.warn;
    console.warn = (line) => warned.push(String(line));
    // The server says every request on console.log; a suite is not its log, but the store's
    // timing lines are read off it below.
    log_ = console.log;
    console.log = (line) => served.push(String(line));
    const config = JSON.parse(fs.readFileSync(path.join(instance, CONFIG_FILE), "utf8"));
    const chat = { root: instance, config, plugins: [] };
    server = await serve(chat);
    url = `http://127.0.0.1:${server.address().port}`;
    for (const seat of [CHAT_LEADER, CHAT_WORKER]) {
      startSeat(chat, seat);
      const before_ = Object.keys(doors).length;
      assert.ok(await waitFor(() => secretsIn(log).length > before_), `${seat} never logged its secret`);
      doors[seat] = secretsIn(log).at(-1);
    }
  });

  after(async () => {
    await Promise.all([endSeat(CHAT_LEADER), endSeat(CHAT_WORKER)]);
    await new Promise((resolve) => server.close(resolve));
    console.warn = warn;
    console.log = log_;
    for (const name of Object.keys(process.env)) {
      if (!(name in environmentBefore)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, environmentBefore);
  });

  it("lists recall and remember for a Worker and for the Leader", async () => {
    const worker = await listed(CHAT_WORKER);
    const lead = await listed(CHAT_LEADER);
    assert.ok(worker.includes("recall") && worker.includes("remember"), JSON.stringify(worker));
    assert.ok(lead.includes("recall") && lead.includes("remember"), JSON.stringify(lead));
  });

  it("serves the Leader exactly what BUILT_IN names, recall and remember among them", async () => {
    assert.ok(BUILT_IN.includes("recall") && BUILT_IN.includes("remember"));
    assert.deepEqual(await listed(CHAT_LEADER), BUILT_IN);
  });

  it("refuses a recall with two of query, id and all, or none, over the door", async () => {
    const said = await tool(CHAT_WORKER, "recall", { store: "memory", id: "m1", query: "rules" });
    assert.equal(said.refused, true);
    assert.match(said.text, /give exactly one of query, id or all/);
  });

  it("answers a Leader's hard-rule write with the version and the update line", async () => {
    const said = await tool(CHAT_LEADER, "remember", { store: "memory", kind: HARD_RULE, text: "Never push on Fridays", source: "user" });
    assert.equal(said.refused, false, said.text);
    assert.match(said.text, /^\[m1\] hard-rule 1, user - "Never push on Fridays"\n\s+by Leader for the User, /);
    assert.match(said.text, /\nHard rules update \(set m1\): rule 1, new: "Never push on Fridays"\.\n/);
    assert.equal(fs.existsSync(path.join(instance, "store", "memory", "000001.md")), true);
  });

  // The log says, per call of the store's tools, whether a model was asked and how long that took
  // — the round-trip is what makes a call slow, and a seat watching it can look stuck.
  const stored = (from) => served.slice(from).filter((line) => line.startsWith("store: "));

  it("asks the helper nothing for id, all or the numbered set, and the log says no model each time", async () => {
    const calls = helperCalls();
    const logged = served.length;
    await tool(CHAT_LEADER, "recall", { store: "memory", id: "m1" });
    await tool(CHAT_LEADER, "recall", { store: "memory", all: true });
    const set = await tool(CHAT_WORKER, "recall", { store: "memory", kind: HARD_RULE });
    assert.match(set.text, /^Hard rules \(set m1\)\.[\s\S]*\n  1\. Never push on Fridays$/);
    assert.equal(helperCalls(), calls);
    assert.deepEqual(stored(logged), [`store: ${CHAT_LEADER} recall no model`, `store: ${CHAT_LEADER} recall no model`, `store: ${CHAT_WORKER} recall no model`]);
  });

  it("sends the helper exactly the current records of the store on a query and answers only ids it named, and the log times the round-trip", async () => {
    const logged = served.length;
    let said = await tool(CHAT_LEADER, "remember", { store: "memory", kind: HARD_RULE, text: "Never push before the release commit is on main", source: "user", replaces: "m1" });
    assert.equal(said.refused, false, said.text);
    said = await tool(CHAT_WORKER, "remember", { store: "memory", kind: "fact", text: "the User prefers a dark palette" });
    assert.equal(said.refused, false, said.text);
    stage({ ids: ["m3", "m1", "m99"] });
    const found = await tool(CHAT_WORKER, "recall", { store: "memory", query: "the User's preferred palette" });
    assert.deepEqual(
      stored(logged).map((line) => line.replace(/ in \d+ ms$/, " in N ms")),
      [`store: ${CHAT_LEADER} remember no model`, `store: ${CHAT_WORKER} remember no model`, `store: ${CHAT_WORKER} recall model in N ms`],
    );
    const request = helperRequests().at(-1);
    assert.equal(request.question, "select");
    assert.equal(request.query, "the User's preferred palette");
    assert.deepEqual(request.records.map((record) => record.id), ["m2", "m3"]);
    assert.deepEqual(request.records.map((record) => record.kind), [HARD_RULE, "fact"]);
    assert.equal(found.refused, false, found.text);
    assert.match(found.text, /^\[m3\] fact, team - "the User prefers a dark palette"\n\s+by Paul \(Worker\), /);
    assert.doesNotMatch(found.text, /\[m1\]/);
    assert.doesNotMatch(found.text, /m99/);
  });

  it("hands the helper nothing scoped to the Leader on a Worker's query", async () => {
    stage({ replaces: null, reason: "new" });
    let said = await tool(CHAT_LEADER, "remember", { store: "memory", kind: HARD_RULE, text: "for the Leader only", source: "user", scope: "leader" });
    assert.equal(said.refused, false, said.text);
    stage({ ids: [] });
    await tool(CHAT_WORKER, "recall", { store: "memory", query: "anything for the Leader" });
    const query = helperRequests().at(-1);
    assert.equal(query.question, "select");
    assert.ok(query.records.length > 0, "the Worker's query sent the helper no records at all");
    assert.deepEqual(query.records.filter((record) => record.text === "for the Leader only"), []);
    assert.deepEqual(query.records.map((record) => record.id), ["m2", "m3"]);
    stage({ replaces: null, reason: "new" });
    said = await tool(CHAT_WORKER, "remember", { store: "memory", kind: "fact", text: "a fact of the team's" });
    assert.equal(said.refused, false, said.text);
    // And through the Leader the same query sees it, so the difference above is the role.
    stage({ ids: [] });
    await tool(CHAT_LEADER, "recall", { store: "memory", query: "anything for the Leader" });
    assert.deepEqual(helperRequests().at(-1).records.filter((record) => record.text === "for the Leader only").length, 1);
  });

  it("asks the helper about the same store and kind only on a remember without replaces, and nothing when there is no record of that kind", async () => {
    const calls = helperCalls();
    let said = await tool(CHAT_WORKER, "remember", { store: "memory", kind: "trap", text: "a trap of the team's" });
    assert.equal(said.refused, false, said.text);
    assert.equal(helperCalls(), calls, "the helper was asked about a kind the store had nothing of");
    stage({ replaces: null, reason: "new" });
    said = await tool(CHAT_WORKER, "remember", { store: "memory", kind: "trap", text: "a second trap" });
    assert.equal(said.refused, false, said.text);
    const request = helperRequests().at(-1);
    assert.equal(request.question, "replaces");
    assert.equal(request.kind, "trap");
    assert.equal(request.text, "a second trap");
    assert.deepEqual(request.records, [{ id: "m6", text: "a trap of the team's" }]);
  });

  it("refuses a helper answer that is not JSON or names an unsent id, and writes nothing", async () => {
    const before_ = fs.readdirSync(path.join(instance, "store", "memory")).length;
    fs.writeFileSync(helperAnswer, "not json at all");
    let said = await tool(CHAT_WORKER, "remember", { store: "memory", kind: "fact", text: "a third fact" });
    assert.equal(said.refused, true);
    assert.equal(said.text, "the helper answered badly");
    stage({ replaces: "m1", reason: "the rule, restated" });
    said = await tool(CHAT_WORKER, "remember", { store: "memory", kind: "fact", text: "a third fact" });
    assert.equal(said.refused, true);
    assert.equal(said.text, "the helper answered badly");
    assert.equal(fs.readdirSync(path.join(instance, "store", "memory")).length, before_);
  });

  it("refuses the call in its own words when the helper is turned away or falls over, writes nothing, and keeps the model's words out of the answer", async () => {
    const before_ = fs.readdirSync(path.join(instance, "store", "memory")).length;
    fs.writeFileSync(helperAnswer, "the model wrote PLUM-CRUMBLE here");
    let said = await tool(CHAT_WORKER, "recall", { store: "memory", query: "anything" });
    assert.equal(said.refused, true);
    assert.equal(said.text, "the helper answered badly");
    assert.doesNotMatch(said.text, /PLUM-CRUMBLE/);
    assert.ok(warned.some((line) => /the helper answered badly to select: the model wrote PLUM-CRUMBLE here/.test(line)), warned.join("\n"));
    said = await withKnob("OPENOVAI_STAND_IN_REFUSED", () => tool(CHAT_WORKER, "remember", { store: "memory", kind: "fact", text: "a fourth fact" }));
    assert.equal(said.refused, true);
    assert.equal(said.text, "the helper did not answer");
    said = await withKnob("OPENOVAI_STAND_IN_BROKEN", () => tool(CHAT_WORKER, "remember", { store: "memory", kind: "fact", text: "a fourth fact" }));
    assert.equal(said.refused, true);
    assert.equal(said.text, "the helper did not answer");
    assert.ok(warned.some((line) => /the helper exited 1: a model was never reached/.test(line)), warned.join("\n"));
    assert.equal(fs.readdirSync(path.join(instance, "store", "memory")).length, before_);
  });

  // The store never chooses, whoever's record the helper names: the refusal names it, nothing lands.
  it("refuses over the door with the record the helper named, its text and the reason, and writes nothing", async () => {
    const before_ = fs.readdirSync(path.join(instance, "store", "memory")).length;
    stage({ replaces: "m2", reason: "the same rule" });
    const said = await tool(CHAT_LEADER, "remember", { store: "memory", kind: HARD_RULE, text: "Push only once the release commit is on main" });
    assert.equal(said.refused, true);
    assert.equal(
      said.text,
      'not written: this reads as [m2] "Never push before the release commit is on main" restated, widened, narrowed or reversed — the same rule; re-issue with replaces: m2 if so, or replaces: none for a new record',
    );
    assert.equal(fs.readdirSync(path.join(instance, "store", "memory")).length, before_);
  });

  it("refuses the same text again over the door without asking the helper, and writes it on replaces none", async () => {
    const calls = helperCalls();
    let said = await tool(CHAT_WORKER, "remember", { store: "memory", kind: "fact", text: "a fact of the team's" });
    assert.equal(said.refused, true);
    assert.match(said.text, /^not written: this reads as \[m5\] "a fact of the team's" restated, widened, narrowed or reversed — the same text;/);
    said = await tool(CHAT_WORKER, "remember", { store: "memory", kind: "fact", text: "a fact of the team's", replaces: "none" });
    assert.equal(said.refused, false, said.text);
    assert.match(said.text, /^\[m8\] fact, team - "a fact of the team's"\n\s+by Paul \(Worker\), [^\n]*$/);
    assert.equal(helperCalls(), calls, "the helper was asked");
    assert.equal(readRecord(instance, "memory", 8).supersedes, undefined);
  });

  it("restores over the door: the record is live under its id, the replacer stands, and recall says who restored it", async () => {
    let said = await tool(CHAT_WORKER, "remember", { store: "memory", kind: "fact", text: "every fact of the team's", replaces: "m8", reason: "widened" });
    assert.equal(said.refused, false, said.text);
    said = await tool(CHAT_WORKER, "remember", { store: "memory", restore: "m8" });
    assert.equal(said.refused, false, said.text);
    assert.match(said.text, /^\[m8\] fact, team - "a fact of the team's"\n\s+by Paul \(Worker\), [^\n]*; restored by Paul \(Worker\), [^\n]* \(had been replaced by m9, which stands\)$/);
    assert.equal(readRecord(instance, "memory", 10).restores, "m8");
    const all = await tool(CHAT_LEADER, "recall", { store: "memory", all: true });
    assert.match(all.text, /\[m8\]/);
    assert.match(all.text, /\[m9\]/);
    assert.doesNotMatch(all.text, /m10/);
    said = await tool(CHAT_LEADER, "recall", { store: "memory", id: "m10" });
    assert.match(said.text, /^m10 is not a record: it restored m8 \(by Paul \(Worker\), /);
    said = await tool(CHAT_WORKER, "remember", { store: "memory", restore: "m8" });
    assert.equal(said.refused, true);
    assert.equal(said.text, "m8 is current; nothing to restore");
  });

  // What the tools say of themselves is the whole of what a session knows about the store before
  // its first call: that a model manages it, that it refuses rather than chooses, and the way back.
  it("describes remember as managed by a model, never a file, refusing a resemblance with the record named, none for a new record, and restore as the way back", async () => {
    const text = await described(CHAT_WORKER, "remember");
    assert.match(text, /The store is managed by a model, not by you: it is not a file, and remember and recall are not create, read, update and delete over a MEMORY\.md you know from elsewhere\./);
    assert.match(text, /or none, when you have read the store and this is a new record\./);
    assert.match(text, /restated, widened, narrowed or reversed; when it is, nothing is written and the refusal names that record — its id, its text, the model's reason — and you re-issue with replaces naming it if you agree, or replaces none if you do not\./);
    assert.match(text, /The store never replaces on its own judgement, and a write never lands unseen\./);
    assert.match(text, /restore: the id of a replaced record, alone with store, brings it back live under its own id, as it was; the record that replaced it stands — a restore is not a swap — and nobody is told\./);
    assert.match(text, /Writes to one store run one at a time\./);
    assert.match(text, /reason without replaces naming a record;/);
    assert.match(text, /a text that reads as a current record restated, widened, narrowed or reversed \(the refusal names it\)/);
    assert.match(text, /A restore is refused with anything beside store and restore; naming what is not a record you can see; naming a current record; naming a hard rule \(write it again with replaces naming the rule that holds its number\); naming the User's record from a Worker\./);
    assert.doesNotMatch(text, /store chose|store's judgement alone|write it again\./);
  });

  it("describes recall as managed by a model, never a file, every replacement named by its writer, a restored record's line, and nobody told", async () => {
    const text = await described(CHAT_WORKER, "recall");
    assert.match(text, /The store is managed by a model, not by you: it is not a file, and recall and remember are not create, read, update and delete over a MEMORY\.md you know from elsewhere\./);
    assert.match(text, /every replacement was named by its writer, the store replaces nothing on its own\./);
    assert.match(text, /A record brought back by restore says who restored it, when, and what had replaced it, which still stands\./);
    assert.match(text, /nobody is told when a fact or trap is replaced or restored/);
    assert.doesNotMatch(text, /store chose/);
  });
});
