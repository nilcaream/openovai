// A desk is one directory, and filing it away is moving it.
//
// A person in an instance is `desks/<Name>/`: the desk file, the persona the session was last
// started with, the conversation the chat kept for it, the model when one was named, and whatever
// the session itself kept there. Retiring the desk moves that directory whole into
// `archive/<day>-<Name>-<slug of the final title>/`, withdraws the pair of rules that made it the
// person's to write in, and frees the name. This suite reads the directory before and after, and
// the settings with it — the check `tests/inspect.mjs` makes is one rule pair per desk and nothing
// wider, so a pair left behind is a failure here, not untidiness.
//
// Every mutation in tests/mutations-desks.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { archiveFor, conversationFile, hire, personaFile, retire, writeDeskHeader } from "../lib/desks.mjs";
import { settingsProblems } from "./inspect.mjs";
import { installed, remove, scratch } from "./helpers.mjs";

const USER = "Mike";
const LEADER = "Superman";
const WORKER = "Paul";
const CHOSEN = "opus";

const instance = scratch("desks-test");
const settings = () => path.join(instance, ".claude", "settings.json");
const allow = () => JSON.parse(fs.readFileSync(settings(), "utf8")).permissions.allow;

before(() => {
  installed({
    "--root": instance,
    "--source": path.resolve(import.meta.dirname, ".."),
    "--user": USER,
    "--leader": LEADER,
    "--leader-model": "sonnet",
    "--worker-model": "haiku",
    "--port": 0,
    "--auth": "login",
  });
});

after(() => remove(instance));

describe("retiring a desk", () => {
  let filed;
  let where;
  let day;

  before(() => {
    hire(instance, WORKER, CHOSEN);
    // What the chat writes there while the session runs, and what the session keeps for itself.
    fs.writeFileSync(personaFile(instance, WORKER), `You are ${WORKER}.\n`);
    fs.writeFileSync(conversationFile(instance, WORKER), "[]\n");
    fs.mkdirSync(path.join(instance, "desks", WORKER, "proof"), { recursive: true });
    fs.writeFileSync(path.join(instance, "desks", WORKER, "proof", "run.md"), "measured\n");
    writeDeskHeader(instance, WORKER, { title: "Winding up the desks review" });
    day = new Date().toISOString().slice(0, 10);
    const archive = archiveFor(instance, WORKER);
    where = archive.where;
    filed = retire(instance, WORKER, archive.at);
  });

  it("files the desk under the day, the name and the slug of the final title", () => {
    assert.equal(where, `archive/${day}-${WORKER}-winding-up-the-desks-review`);
  });

  it("moves the whole directory: the desk, the model, the persona, the conversation, and what the session kept", () => {
    const archived = path.join(instance, where);
    assert.deepEqual(fs.readdirSync(archived).sort(), ["MODEL", "STATE.md", "conversation.json", "persona.md", "proof"]);
    assert.equal(fs.readFileSync(path.join(archived, "proof", "run.md"), "utf8"), "measured\n");
    assert.equal(fs.readFileSync(path.join(archived, "MODEL"), "utf8"), `${CHOSEN}\n`);
  });

  it("says what it filed, one entry per thing in the directory", () => {
    assert.deepEqual(filed.map((entry) => path.basename(entry)).sort(), ["MODEL", "STATE.md", "conversation.json", "persona.md", "proof"]);
  });

  it("leaves nothing under desks/ for that name", () => {
    assert.equal(fs.existsSync(path.join(instance, "desks", WORKER)), false);
    assert.deepEqual(fs.readdirSync(path.join(instance, "desks")), [LEADER]);
  });

  it("withdraws the pair that made the directory the worker's", () => {
    assert.deepEqual(allow().filter((rule) => rule.includes(`desks/${WORKER}/`)), []);
  });

  it("leaves the instance holding exactly the standing rules and the Leader's pair", () => {
    assert.deepEqual(settingsProblems(settings()), []);
  });

  it("frees the name: hiring it again opens a fresh desk", () => {
    const written = hire(instance, WORKER);
    assert.ok(written.some((entry) => entry.endsWith(path.join("desks", WORKER, "STATE.md"))));
    assert.deepEqual(fs.readdirSync(path.join(instance, "desks", WORKER)), ["STATE.md"]);
    assert.deepEqual(settingsProblems(settings()), []);
  });

  it("files a second leaving of the same name and title on the same day under a number", () => {
    writeDeskHeader(instance, WORKER, { title: "Winding up the desks review" });
    const again = archiveFor(instance, WORKER);
    assert.equal(again.where, `${where}-2`);
    retire(instance, WORKER, again.at);
  });
});

describe("what a desk without a title is filed under", () => {
  const NAMELESS = "Quinn";

  it("is the day and the name alone, never a guess", () => {
    hire(instance, NAMELESS);
    const archive = archiveFor(instance, NAMELESS);
    assert.equal(archive.where, `archive/${new Date().toISOString().slice(0, 10)}-${NAMELESS}`);
    retire(instance, NAMELESS, archive.at);
  });
});

describe("what the rule check says about desks", () => {
  const ODD = "Wren";

  it("names a desk that was opened without its pair", () => {
    fs.mkdirSync(path.join(instance, "desks", ODD), { recursive: true });
    fs.writeFileSync(path.join(instance, "desks", ODD, "STATE.md"), "<!-- DESK | title: -->\n");
    const problems = settingsProblems(settings());
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], new RegExp(`Edit\\(desks/${ODD}/\\*\\*\\)`));
    fs.rmSync(path.join(instance, "desks", ODD), { recursive: true, force: true });
  });

  it("names a pair held for a desk nobody has", () => {
    const held = JSON.parse(fs.readFileSync(settings(), "utf8"));
    const widened = { ...held, permissions: { ...held.permissions, allow: [...held.permissions.allow, `Edit(desks/${ODD}/**)`, `Write(desks/${ODD}/**)`] } };
    fs.writeFileSync(settings(), `${JSON.stringify(widened, null, 2)}\n`);
    const problems = settingsProblems(settings());
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /nothing accounts for/);
    fs.writeFileSync(settings(), `${JSON.stringify(held, null, 2)}\n`);
  });
});
