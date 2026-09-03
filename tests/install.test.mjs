// tests/install.test.mjs — install an instance, check it is the one that was asked for, remove it.
//
// It needs Node.js and nothing else. Claude Code is only needed to run an instance, so the
// checks that would start one are skipped when it is not installed, and the run still says so.
//
// Run it with: node --test tests/install.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  claudeIsInstalled,
  install,
  installed,
  remove,
  repo,
  runOw,
  scratch,
  writeNodeStandIn,
} from "./helpers.mjs";
import { configProblems, settingsProblems } from "./inspect.mjs";
import { PAYLOAD } from "../tools/payload.mjs";
import { RELEASE_NOTES } from "../tools/release.mjs";

const HUMAN = "Mike";
const LEADER = "Superman";
const LEADER_MODEL = "sonnet";
const WORKER_MODEL = "haiku";
const PORT = 7801;
const AUTH = "inherit";

const instance = scratch("install-test");
const chosen = `${instance}-chosen`;

// Everything the Node checks need: one stand-in node per version they pretend to have, and one
// instance root per install that is expected to go through.
const versions = `${instance}-versions`;

// A source that is this workspace in every way except the version, so a check can ask what the
// installer does about one. Everything else is COPIED rather than made empty: a source of empty
// directories is refused later anyway, when a template it needs turns out not to be there, and a
// check that cannot tell those two refusals apart is not about the version at all.
const versionless = `${instance}-versionless`;

// The instances are removed however this run ends, including one that fails half way through.
process.on("exit", () => remove(instance, chosen, versions, versionless));

// A full command line, which a check then spoils in one place to ask what is refused.
function options(root, changes = {}) {
  return {
    "--root": root,
    "--source": repo,
    "--human": HUMAN,
    "--leader": LEADER,
    "--leader-model": LEADER_MODEL,
    "--worker-model": WORKER_MODEL,
    "--port": PORT,
    "--auth": AUTH,
    ...changes,
  };
}

// A PATH whose node reports the version given. The installer only asks node what version it
// is, so this is enough to put it in front of a Node nobody here has installed.
function pretending(version) {
  const directory = path.join(versions, "node", version);
  writeNodeStandIn(directory, version);
  return { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` };
}

function rootFor(version) {
  return path.join(versions, "root", version);
}

// Built once, on first use: the checks that want it are two, and building it in each of them
// would say the same thing twice.
function withoutVersion() {
  if (!fs.existsSync(versionless)) {
    for (const entry of ["bin", "tools", "templates"]) {
      fs.cpSync(path.join(repo, entry), path.join(versionless, entry), { recursive: true });
    }
  }
  return versionless;
}

function inside(...parts) {
  return path.join(instance, ...parts);
}

function contentOf(...parts) {
  return fs.readFileSync(inside(...parts), "utf8");
}

remove(instance, chosen);
const made = installed(options(instance));

describe("what the installer made", () => {
  it("writes the instance its own description", () => {
    assert.ok(fs.existsSync(inside("ow.json")));
  });

  it("copies the launcher in", () => {
    assert.ok(fs.existsSync(inside("bin", "ow")));
  });

  it("leaves the launcher executable", () => {
    assert.doesNotThrow(() => fs.accessSync(inside("bin", "ow"), fs.constants.X_OK));
  });

  it("copies the installer in", () => {
    assert.ok(fs.existsSync(inside("tools", "install.mjs")));
  });

  it("copies the instance command in", () => {
    assert.ok(fs.existsSync(inside("tools", "ow.mjs")));
  });

  it("copies the version in", () => {
    assert.ok(fs.existsSync(inside("VERSION")));
  });

  // Read out of the source rather than compared with a literal. A version written into the check
  // as well as into the file would agree with itself on the day it was written and never again.
  it("carries the version the source is on", () => {
    assert.equal(contentOf("VERSION").trim(), fs.readFileSync(path.join(repo, "VERSION"), "utf8").trim());
  });

  it("copies the desk template in", () => {
    assert.ok(fs.existsSync(inside("templates", "STATE.md")));
  });

  it("copies the memory index template in", () => {
    assert.ok(fs.existsSync(inside("templates", "MEMORY.md")));
  });

  // Where a session reads it is not the installer's choice — it is inside the instance's own
  // Claude Code home, under the fixed name that survives the instance being moved. The path is
  // spelled out here rather than asked of the code, so that moving the index and moving the check
  // cannot be one edit.
  it("gives the instance an index of what it knows, where its sessions read it", () => {
    assert.ok(fs.existsSync(inside(".claude-home", "projects", "workspace", "memory", "MEMORY.md")));
  });

  it("says in that index what belongs in it", () => {
    assert.match(
      contentOf(".claude-home", "projects", "workspace", "memory", "MEMORY.md"),
      /work it out again/,
    );
  });

  it("says it wrote the index", () => {
    assert.ok(made.stdout.includes(inside(".claude-home", "projects", "workspace", "memory", "MEMORY.md")));
  });

  it("makes a directory for the settings", () => {
    assert.ok(fs.statSync(inside(".claude")).isDirectory());
  });

  it("makes the instance its own Claude Code home", () => {
    assert.ok(fs.statSync(inside(".claude-home")).isDirectory());
  });

  it("gives the leader a desk", () => {
    assert.ok(fs.existsSync(inside("work", LEADER, "STATE.md")));
  });

  it("names the leader on that desk", () => {
    assert.match(contentOf("work", LEADER, "STATE.md"), new RegExp(`^# ${LEADER}$`, "m"));
  });

  // The header is one line holding one field, and that is the whole definition of it: the title is
  // what anything outside the desk reads, so it is what the header carries and there is nothing
  // else in there for a session to keep true for nobody.
  it("opens that desk with a header holding the title and nothing else", () => {
    assert.equal(contentOf("work", LEADER, "STATE.md").split("\n")[0], "<!-- DESK | title: -->");
  });

  it("leaves no unfilled placeholder on the desk", () => {
    assert.ok(!contentOf("work", LEADER, "STATE.md").includes("{{"));
  });

  it("copies the leader persona template in", () => {
    assert.ok(fs.existsSync(inside("templates", "leader.md")));
  });

  it("copies the worker persona template in", () => {
    assert.ok(fs.existsSync(inside("templates", "worker.md")));
  });

  it("writes the leader a persona", () => {
    assert.ok(fs.existsSync(inside("personas", `${LEADER}.md`)));
  });

  it("says in the persona who the leader is", () => {
    assert.ok(contentOf("personas", `${LEADER}.md`).includes(`You are ${LEADER}, ${HUMAN}'s lead`));
  });

  it("points the persona at the leader's own desk", () => {
    assert.ok(contentOf("personas", `${LEADER}.md`).includes(`work/${LEADER}/STATE.md`));
  });

  it("leaves no unfilled placeholder in the persona", () => {
    assert.ok(!contentOf("personas", `${LEADER}.md`).includes("{{"));
  });

  it("gives the instance settings of its own", () => {
    assert.ok(fs.existsSync(inside(".claude", "settings.json")));
  });

  it("writes those settings as valid JSON", () => {
    assert.doesNotThrow(() => JSON.parse(contentOf(".claude", "settings.json")));
  });

  it("lets the leader write its own desk, and nothing wider", () => {
    assert.deepEqual(settingsProblems(inside(".claude", "settings.json"), [LEADER]), []);
  });

  // A lead that cannot reach the team has to do the work itself. The rule is relative, like the
  // desk rules, because a session is started with the instance root as its working directory.
  it("names each file it wrote once, however many things went into it", () => {
    const settings = inside(".claude", "settings.json");
    assert.equal(made.stdout.split("\n").filter((line) => line.trim() === settings).length, 1);
  });

  // What a session calls to reach another. Without the rule the call is refused outright, or parks
  // a request on a panel nobody may be watching — for every message a session sends.
  it("lets a session say something to another without being asked", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(allow.includes("mcp__office"));
  });

  // It replaced two rules, one per spelling of a command. Nothing should be left granting a shell
  // line no persona names any more: a grant nobody uses is a grant nobody is watching.
  it("no longer grants the command it replaced", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(!allow.some((rule) => rule.includes("ow say")));
  });

  // Seeing who else works here is a tool now, under the one rule above. Watched before there was
  // any rule for it: a lead sat parked on `bin/ow status` for six and a half minutes and would not
  // have stopped, so nothing may be left telling a session to type it.
  it("no longer grants the command that listed who works here", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(!allow.some((rule) => rule.includes("ow status")));
  });

  it("tells the leader how to say something to somebody", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /the `say` tool says something to one of them/);
  });

  // A persona that still named the command would be telling a session to type a shell line the
  // instance no longer grants, which is a session stopped for doing as it was told.
  it("does not tell the leader to type the command it replaced", () => {
    assert.ok(!contentOf("personas", `${LEADER}.md`).includes("ow say"));
  });

  it("tells the leader how to see who works here", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /The `status` tool lists who\s+works here/);
  });

  it("does not tell the leader to type the command that listed who works here", () => {
    assert.ok(!contentOf("personas", `${LEADER}.md`).includes("ow status"));
  });

  // The room is the third of them, and the only one the lead alone is offered. Watched here as
  // well as on the endpoint: what the instance grants and what the persona names have to move
  // together, or a lead is told to ask for something nothing will serve it.
  it("no longer grants the command that showed the room", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(!allow.some((rule) => rule.includes("ow room")));
  });

  it("tells the leader that a message from a session comes wrapped", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /<from-session name=/);
  });

  it("tells the leader that what is outside a wrapper is the human", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), new RegExp(`outside a wrapper is\\s+${HUMAN}`));
  });

  it("tells the leader that the chat says what was typed on another panel", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /<overheard on="[^"]*" from="Mike">/);
  });

  // An update ships new templates and re-renders nothing, so this paragraph is for the sessions
  // hired after one — the lead that was running through the update is told in the wrapper itself.
  it("tells the leader that the chat says when the toolkit under it was replaced", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /<update from="[^"]*" to="[^"]*">/);
  });

  it("tells the leader that an update leaves the desks and the personas alone", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /desks, the personas and what this workspace has learned are\s+untouched/);
  });

  it("tells the leader when it will hear it, since it is not at the moment it was said", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /at the start of your\s+next turn/);
  });

  // The lead used to be told the workers would pass it on. They no longer do, and a persona still
  // saying so would have it waiting for something that is not coming.
  it("no longer tells the leader that workers pass it on themselves", () => {
    assert.ok(!contentOf("personas", `${LEADER}.md`).includes("Workers are told to tell you"));
  });

  // The lead keeps a desk and is handed over exactly as everybody else is, so it is told the same
  // thing — and told to write the part of the desk only a lead has, which is the room.
  it("tells the leader what a handover arrives as", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /<handover>/);
  });

  it("tells the leader which file to write when one does", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), new RegExp(`<handover>[\\s\\S]*work/${LEADER}/STATE.md`));
  });

  it("tells the leader that the thread ends when it answers", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /the\s+thread ends when you answer/);
  });

  // The lead is not exempt from the ending nobody announces, and is the session it takes most from:
  // what goes is who it had waiting on what, which is nowhere else unless its desk says so.
  it("tells the leader that a conversation can also end unannounced", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /<pick-up>/);
  });

  it("tells the leader which file to read when one does", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), new RegExp(`<pick-up>[\\s\\S]*work/${LEADER}/STATE.md`));
  });

  it("tells the leader that everybody here reads what the workspace has learned", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /everybody\s+here reads the same thing/);
  });

  it("tells the leader what belongs in the memory rather than on a desk", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /the memory is the workspace/);
  });

  it("tells the leader to keep the desk current before one is ever asked for", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /kept current as you go and not only then/);
  });

  // What the lead is on has to come from somewhere, and the only thing that knows it is the lead.
  // One field of the desk header, named in the persona, is the whole of the arrangement.
  // The lead is the one session that cannot look at the page, because it is on it. Naming the
  // command in its persona is the whole of how it finds out; a command a persona names and an
  // instance does not grant is the failure this repo has already had twice.
  it("tells the leader how to see the room", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /The `room` tool is the other half of that/);
  });

  it("does not tell the leader to type the command that showed the room", () => {
    assert.ok(!contentOf("personas", `${LEADER}.md`).includes("ow room"));
  });

  // Said in the persona because it is not said anywhere else the lead reads: a tool it is offered
  // and the others are not is the only asymmetry in this instance, and a lead that did not know
  // would tell a worker to go and look for itself.
  it("tells the leader the room is its own to look at", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /it is yours alone/);
  });

  it("tells the leader the room is true at the moment it asks", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /true at the moment you ask/);
  });

  it("tells the leader which one field of its header is read by anybody else", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /the `title:` in it is the one field/);
  });

  it("tells the leader to keep that field saying what it is on", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /Keep it saying what you are on/);
  });

  // And that there is nothing else in that header to keep true for anybody else's sake.
  it("tells the leader its header holds nothing else", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /header holds nothing else/);
  });

  it("warns the leader that asking somebody waits for them", () => {
    assert.match(contentOf("personas", `${LEADER}.md`), /waits for them/);
  });

  it("describes the instance that was asked for", () => {
    assert.deepEqual(
      configProblems(inside("ow.json"), {
        human: HUMAN,
        leader: LEADER,
        leaderModel: LEADER_MODEL,
        workerModel: WORKER_MODEL,
        port: PORT,
        auth: AUTH,
      }),
      [],
    );
  });
});

describe("what the installer refuses", () => {
  it("refuses a directory that is not empty", () => {
    assert.notEqual(install(options(instance)).status, 0);
  });

  it("installs into a directory that is not empty when told to", () => {
    assert.equal(install(options(instance, { "--force": true })).status, 0);
  });

  it("refuses a command line with an option missing", () => {
    const asked = {
      "--root": instance,
      "--source": repo,
      "--human": HUMAN,
      "--leader": LEADER,
    };
    assert.notEqual(install(asked).status, 0);
  });

  // A source with no version in it is not a version of the toolkit, whatever else is in it. The
  // same function answers for a clone and for an unpacked release, so this is also what stops an
  // update taking a package that is something else entirely.
  // One check and not two. A refusal and the reason for it are separate things wherever a refusal
  // can arrive for more than one reason, and here it cannot: with the version in the payload, a
  // source without one cannot be installed successfully whatever this function does, so a check on
  // the exit status alone would pass on a crash. Both in one expression, so neither half can go
  // missing quietly.
  //
  // And it reads the installer's OWN sentence, not the word VERSION anywhere in the output. An
  // installer that carried on past this would fall over copying the file that is not there, and
  // that crash names the same path on stderr — so a looser check passes on the failure it exists
  // to rule out. Measured: both a removed refusal and one downgraded to a warning went unnoticed
  // until this was anchored on the line the installer writes itself.
  it("refuses a source with no version in it, saying which entry that is", () => {
    const refused = install(options(`${instance}-noversion`, { "--source": withoutVersion() }));
    const said = /^install: .*does not look like an office workspace.*VERSION/m.test(refused.stderr);
    assert.equal([refused.status === 0, said].join(" "), "false true");
  });

  it("refuses a port below 1024", () => {
    assert.notEqual(install(options(`${instance}-lowport`, { "--port": 80 })).status, 0);
  });

  it("refuses a port that is not a number", () => {
    assert.notEqual(install(options(`${instance}-badport`, { "--port": "banana" })).status, 0);
  });

  it("refuses a way of signing in that does not exist", () => {
    assert.notEqual(install(options(`${instance}-badauth`, { "--auth": "sometimes" })).status, 0);
  });

  it("refuses a port that is not written in digits", () => {
    assert.notEqual(install(options(`${instance}-hexport`, { "--port": "0x1f90" })).status, 0);
  });

  it("refuses a command line with no way of signing in", () => {
    assert.notEqual(install(options(`${instance}-noauth`, { "--auth": undefined })).status, 0);
  });
});

// The toolkit is written against one Node. An older one reads a different language and stops
// on syntax used freely here, so the installer says so in one line rather than leaving an
// instance to fail at its first message.
describe("the Node the installer needs", () => {
  const refused = install(options(rootFor("v20.18.1")), pretending("v20.18.1"));

  it("refuses a Node older than the one it needs", () => {
    assert.notEqual(refused.status, 0);
  });

  it("says which Node it needs", () => {
    assert.match(refused.stderr, /Node\.js 24 or newer is required/);
  });

  it("says which Node it found", () => {
    assert.match(refused.stderr, /v20\.18\.1/);
  });

  it("installs on the Node it needs", () => {
    assert.equal(install(options(rootFor("v24.0.0")), pretending("v24.0.0")).status, 0);
  });

  it("installs on a Node newer than the one it needs", () => {
    assert.equal(install(options(rootFor("v99.0.0")), pretending("v99.0.0")).status, 0);
  });
});

describe("a port the machine picks", () => {
  it("installs with --port 0", () => {
    assert.equal(install(options(chosen, { "--port": 0 })).status, 0);
  });

  it("records the port as 0 rather than one it chose", () => {
    assert.deepEqual(
      configProblems(path.join(chosen, "ow.json"), {
        human: HUMAN,
        leader: LEADER,
        leaderModel: LEADER_MODEL,
        workerModel: WORKER_MODEL,
        port: 0,
        auth: AUTH,
      }),
      [],
    );
  });
});

// Claude Code is a prerequisite of running an instance, not of making one.
describe("the instance runs", { skip: claudeIsInstalled() ? false : "Claude Code is not on the PATH" }, () => {
  it("answers ow status", () => {
    assert.equal(runOw(instance, ["status"], process.env).status, 0);
  });

  it("names the human in ow status", () => {
    assert.match(runOw(instance, ["status"], process.env).stdout, new RegExp(HUMAN));
  });
});

// One version, written in two places for two readers: the file the payload carries, and the
// package declaration for tooling that reads that instead. Nothing makes one follow the other, so
// this is what says they have not drifted.
describe("the version the toolkit is on", () => {
  it("says the same thing in the payload and in the package", () => {
    const declared = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
    assert.equal(fs.readFileSync(path.join(repo, "VERSION"), "utf8").trim(), declared);
  });
});

// A release is cut from the repository, and what it carries for the lead of a workspace taking it
// is a file in that repository. A release cut without one tells the lead an update happened and
// nothing about what it was — which is the whole of what this feature is for.
describe("what a release says for itself", () => {
  it("carries notes for the lead at the root of the repository", () => {
    assert.match(fs.readFileSync(path.join(repo, RELEASE_NOTES), "utf8").trim(), /\S/);
  });

  it("says something about the version being released", () => {
    assert.match(fs.readFileSync(path.join(repo, RELEASE_NOTES), "utf8"), new RegExp(fs.readFileSync(path.join(repo, "VERSION"), "utf8").trim()));
  });

  it("is not in the payload, since it describes a release rather than an instance", () => {
    assert.equal(PAYLOAD.includes(RELEASE_NOTES), false);
  });
});
