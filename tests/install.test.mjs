// tests/install.test.mjs — install an instance, check it is the one that was asked for, remove it.
//
// It needs Node.js and nothing else. Claude Code is only needed to run an instance, so the
// checks that would start one are skipped when it is not installed, and the run still says so.
//
// Run it with: node --test tests/install.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, it } from "node:test";

import {
  claudeIsInstalled,
  install,
  installed,
  remove,
  repo,
  runOvai,
  scratch,
  writeNodeStandIn,
} from "./helpers.mjs";
import { configProblems, settingsProblems } from "./inspect.mjs";
import { CUSTOMIZATION, persona } from "../lib/desks.mjs";
import { PAYLOAD } from "../lib/payload.mjs";
import { RELEASE_NOTES } from "../lib/release.mjs";

const USER = "Mike";
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
process.on("exit", () => remove(instance, chosen, versions, versionless, `${instance}-over`));

// A full command line, which a check then spoils in one place to ask what is refused.
function options(root, changes = {}) {
  return {
    "--root": root,
    "--source": repo,
    "--user": USER,
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
    for (const entry of ["bin", "lib"]) {
      fs.cpSync(path.join(repo, entry), path.join(versionless, entry), { recursive: true });
    }
    // The version comes in with lib/, so a copy of the payload is a source WITH a version until
    // the file is taken out again.
    fs.rmSync(path.join(versionless, "lib", "VERSION"));
  }
  return versionless;
}

function inside(...parts) {
  return path.join(instance, ...parts);
}

function contentOf(...parts) {
  return fs.readFileSync(inside(...parts), "utf8");
}

// What the Leader is told, rendered the way the chat renders it when the Leader's first conversation
// starts: from the templates the installer put in place, with the names written in. The installer
// writes no persona file, so this is the one way to read what a Leader of this instance would be told.
function leadPersona(root = instance) {
  return persona(root, LEADER, { user: USER, leader: LEADER });
}

remove(instance, chosen);
const made = installed(options(instance));

describe("what the installer made", () => {
  it("writes the instance its own description", () => {
    assert.ok(fs.existsSync(inside("openovai.json")));
  });

  it("copies the launcher in", () => {
    assert.ok(fs.existsSync(inside("bin", "ovai")));
  });

  it("leaves the launcher executable", () => {
    assert.doesNotThrow(() => fs.accessSync(inside("bin", "ovai"), fs.constants.X_OK));
  });

  it("copies the installer in", () => {
    assert.ok(fs.existsSync(inside("lib", "install.mjs")));
  });

  it("copies the instance command in", () => {
    assert.ok(fs.existsSync(inside("lib", "ovai.mjs")));
  });

  it("copies the version in", () => {
    assert.ok(fs.existsSync(inside("lib", "VERSION")));
  });

  // Read out of the source rather than compared with a literal. A version written into the check
  // as well as into the file would agree with itself on the day it was written and never again.
  it("carries the version the source is on", () => {
    assert.equal(contentOf("lib", "VERSION").trim(), fs.readFileSync(path.join(repo, "lib", "VERSION"), "utf8").trim());
  });

  it("copies the desk template in", () => {
    assert.ok(fs.existsSync(inside("lib", "templates", "STATE.md")));
  });

  // Where the workspace keeps what it knows: two empty directories, one per store, and nothing
  // seeded into them. The paths are spelled out rather than asked of the code, so that moving the
  // store and moving the check cannot be one edit.
  it("makes the store's two directories, empty", () => {
    assert.deepEqual(fs.readdirSync(inside("store", "memory")), []);
    assert.deepEqual(fs.readdirSync(inside("store", "knowledge")), []);
  });

  // Claude Code's own memory is a second answer to what the workspace knows, read by the one
  // session that wrote it. The store is the only one. The key is honoured in the home's settings.
  it("turns Claude Code's own memory off in the home settings", () => {
    const settings = JSON.parse(contentOf(".local", "settings.json"));
    assert.equal(settings.autoMemoryEnabled, false);
  });

  it("seeds no memory index into the Claude Code home", () => {
    assert.equal(fs.existsSync(inside(".local", "projects", "workspace", "memory", "MEMORY.md")), false);
  });

  // The path is spelled out rather than asked of the code. The key is only honoured in the home's
  // settings, so a check that followed the code would go on passing if the file moved to the
  // instance's own settings and stopped meaning anything.
  it("brings a refused session back by itself rather than leaving it on a dialog", () => {
    const settings = JSON.parse(contentOf(".local", "settings.json"));
    assert.equal(settings.autoContinueAtUsageLimit, true);
  });

  it("says it wrote those settings", () => {
    assert.ok(made.stdout.includes(inside(".local", "settings.json")));
  });

  it("tells the person to start the server with the command that does", () => {
    const lines = made.stdout.split("\n");
    const hint = lines.indexOf("Start it with:");
    assert.notEqual(hint, -1);
    assert.equal(lines[hint + 1], `  ${inside("bin", "ovai")} start`);
    assert.ok(!made.stdout.includes("ovai chat"));
  });

  it("makes a directory for the settings", () => {
    assert.ok(fs.statSync(inside(".claude")).isDirectory());
  });

  it("makes the instance its own Claude Code home", () => {
    assert.ok(fs.statSync(inside(".local")).isDirectory());
  });

  it("gives the leader a desk", () => {
    assert.ok(fs.existsSync(inside("desks", LEADER, "STATE.md")));
  });

  it("names the leader on that desk", () => {
    assert.match(contentOf("desks", LEADER, "STATE.md"), new RegExp(`^# ${LEADER}$`, "m"));
  });

  // The header is one line holding one field, and that is the whole definition of it: the title is
  // what anything outside the desk reads, so it is what the header carries and there is nothing
  // else in there for a session to keep true for nobody.
  it("opens that desk with a header holding the title and nothing else", () => {
    assert.equal(contentOf("desks", LEADER, "STATE.md").split("\n")[0], "<!-- DESK | title: | status: | rules: | updated: -->");
  });

  it("leaves no unfilled placeholder on the desk", () => {
    assert.ok(!contentOf("desks", LEADER, "STATE.md").includes("{{"));
  });

  it("copies the leader persona template in", () => {
    assert.ok(fs.existsSync(inside("lib", "templates", "leader.md")));
  });

  it("copies the worker persona template in", () => {
    assert.ok(fs.existsSync(inside("lib", "templates", "worker.md")));
  });

  // What the workspace allows is a tool's answer now — the Leader's `permission` tool, called with
  // no rule — and not a procedure a session follows through files it reads, so no skill ships:
  // none in the payload, none in the source, none written into an instance.
  it("ships no skill", () => {
    assert.deepEqual(PAYLOAD.filter((entry) => entry.includes(".claude")), []);
    assert.equal(fs.existsSync(path.join(repo, ".claude", "skills")), false);
    assert.equal(fs.existsSync(inside(".claude", "skills")), false);
  });

  // Who the Leader is gets rendered when its first conversation starts, from the templates just put
  // in place — so there is nothing here to say who anybody was, and nothing for an update to leave
  // stale: the Leader's directory holds the desk and nothing else.
  it("writes no persona: the Leader's directory is the desk alone", () => {
    assert.deepEqual(fs.readdirSync(inside("desks", LEADER)), ["STATE.md"]);
  });

  // The root is the layout and nothing else. Every directory a session may write in is made here,
  // because the grants that name them are written here; and nothing lands in the root itself.
  it("makes exactly the layout at the root: the product, the instance's own, the people, the User's material, Claude Code's", () => {
    assert.deepEqual(fs.readdirSync(instance).sort(), [
      ".claude",
      ".local",
      "bin",
      "customization",
      "desks",
      "instructions.json",
      "lib",
      "openovai.json",
      "plugins",
      "projects",
      "reference",
      "store",
      "temp",
    ]);
    for (const tree of ["reference", "projects", "temp", "customization"]) {
      assert.deepEqual(fs.readdirSync(inside(tree)), [], tree);
    }
  });

  // The settings document every session is started with, written here so a fresh instance carries
  // it from the start and the root is the whole layout. What is on it is the chat's business
  // (tests/chat.test.mjs); here is only that it is the list, absolute, for where the instance sits.
  it("writes the list of what its sessions are not to read, at the root, absolute", () => {
    const excluded = JSON.parse(contentOf("instructions.json")).claudeMdExcludes;
    assert.ok(excluded.includes(path.join(path.dirname(instance), "CLAUDE.md")), `nothing for the parent in ${JSON.stringify(excluded)}`);
    assert.deepEqual(excluded.filter((pattern) => !path.isAbsolute(pattern)), []);
  });

  // What the person adds to a persona. Their file, at the root beside desks/, read as it is and put
  // after everything the toolkit puts in — so it can add to what a session is told and cannot take
  // any of it away, and an update, which replaces the templates, never reaches it.
  describe("what the person adds to a persona", () => {
    const ADDED = "Always answer in French. Keep {{THIS}} as it is.\n";
    const file = inside(CUSTOMIZATION, "leader.md");
    let plain;
    let added;

    before(() => {
      plain = leadPersona();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, ADDED);
      added = leadPersona();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });

    it("is the template alone while there is nothing added", () => {
      assert.ok(!plain.includes("Always answer in French"));
    });

    it("comes after everything the toolkit puts in, the budget included", () => {
      assert.ok(added.startsWith(plain.replace(/\s*$/, "")));
      assert.ok(added.indexOf("Always answer in French") > added.indexOf("at most 15 tool calls"));
    });

    it("is read as it is, braces and all", () => {
      assert.ok(added.endsWith("Keep {{THIS}} as it is.\n"));
    });

    it("is the person's, so the installer does not make the directory for it", () => {
      assert.equal(fs.existsSync(inside(CUSTOMIZATION)), false);
    });
  });

  it("gives the instance settings of its own", () => {
    assert.ok(fs.existsSync(inside(".claude", "settings.json")));
  });

  it("writes those settings as valid JSON", () => {
    assert.doesNotThrow(() => JSON.parse(contentOf(".claude", "settings.json")));
  });

  it("grants the tools, the reads, the three trees and the Leader its desk, and nothing wider", () => {
    assert.deepEqual(settingsProblems(inside(".claude", "settings.json")), []);
  });

  // A Leader that cannot reach the team has to do the work itself. The rule is relative, like the
  // desk rules, because a session is started with the instance root as its working directory.
  it("names each file it wrote once, however many things went into it", () => {
    const settings = inside(".claude", "settings.json");
    assert.equal(made.stdout.split("\n").filter((line) => line.trim() === settings).length, 1);
  });

  // What a session calls to reach another. Without the rule the call is refused outright, or parks
  // a request on a panel nobody may be watching — for every message a session sends.
  it("lets a session say something to another without being asked", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(allow.includes("mcp__openovai"));
  });

  // The other half of the file, and the only refusals a fresh instance holds. The rules are spelled
  // out here rather than asked of the code: a check that read the list it is checking would agree
  // with itself the day somebody widened it.
  //
  // What they are worth is narrower than it looks and the workspace says so where it says anything
  // about them: `Edit(...)` binds the tools that write a file, so a granted shell rule reaches
  // these paths whatever the refusal says.
  it("closes its own account of what it allows to the tools that write files", () => {
    const deny = JSON.parse(contentOf(".claude", "settings.json")).permissions.deny;
    assert.deepEqual(deny.filter((rule) => rule.startsWith("Edit(.claude") || rule.startsWith("Edit(.local")), [
      "Edit(.claude/**)",
      "Edit(.local/settings.json)",
      "Edit(.local/.claude.json)",
    ]);
  });

  // A desk file is written through the write_desk tool and no other way. A session reaching for
  // one with a file tool is refused on the spot — never a stop that asks the User to settle it —
  // and both spellings, because the directory around it is granted for both and a deny wins only
  // for the tool it names.
  it("denies a desk file edit and write at install", () => {
    const deny = JSON.parse(contentOf(".claude", "settings.json")).permissions.deny;
    assert.deepEqual(deny.filter((rule) => rule.includes("desks/")), ["Edit(desks/*/STATE.md)", "Write(desks/*/STATE.md)"]);
  });

  // The allow list, exactly: the tool server, the reads, the edit and write rules for the three
  // trees the User works in, and the Leader's own desk directory — a desk is a working directory.
  // Spelled out rather than asked of the code, so a widened list is caught here.
  it("allows the tool server, the reads, the three trees, the Leader's desk directory, and nothing else", () => {
    const permissions = JSON.parse(contentOf(".claude", "settings.json")).permissions;
    assert.deepEqual(permissions.allow, [
      "mcp__openovai",
      "Read(**)",
      "Edit(reference/**)",
      "Write(reference/**)",
      "Edit(projects/**)",
      "Write(projects/**)",
      "Edit(temp/**)",
      "Write(temp/**)",
      `Edit(desks/${LEADER}/**)`,
      `Write(desks/${LEADER}/**)`,
    ]);
  });

  // A refusal is absolute: no rule overrides it, the call never reaches a panel, and somebody who
  // works differently is blocked rather than defaulted away. So these name the workspace's account
  // of itself and the one file a tool writes, and nothing anybody works on.
  it("refuses nothing about anybody's work", () => {
    const deny = JSON.parse(contentOf(".claude", "settings.json")).permissions.deny;
    assert.deepEqual(deny.filter((rule) => !rule.startsWith("Edit(.claude") && !rule.startsWith("Edit(.local") && !rule.endsWith("(desks/*/STATE.md)")), []);
  });

  // And the subtree deliberately left open, because the memory index and the transcripts live in
  // it: refusing that one would break memory to protect nothing.
  it("leaves what the instance remembers alone", () => {
    const deny = JSON.parse(contentOf(".claude", "settings.json")).permissions.deny;
    assert.deepEqual(deny.filter((rule) => rule.includes("projects")), []);
  });

  // The ledger is what this workspace allows beyond a desk, and a refusal is not a grant. A fresh
  // instance has nothing to account for, which is also what the first turn of one reads to decide
  // whether it has ever settled anything.
  it("accounts for none of them, since a refusal is not something somebody asked for", () => {
    assert.ok(!fs.existsSync(inside(".claude", "allowed.md")));
  });

  // It replaced two rules, one per spelling of a command. Nothing should be left granting a shell
  // line no persona names any more: a grant nobody uses is a grant nobody is watching.
  it("grants no shell line for saying something to somebody", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(!allow.some((rule) => rule.includes("ovai say")));
  });

  // Seeing who else works here is a tool now, under the one rule above. Watched before there was
  // any rule for it: a Leader sat parked on `bin/ovai status` for six and a half minutes and would not
  // have stopped, so nothing may be left telling a session to type it.
  it("grants no shell line for seeing who works here", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(!allow.some((rule) => rule.includes("ovai status")));
  });

  // A persona naming a shell line would be telling a session to type something the instance does
  // not grant, which is a session stopped for doing as it was told.
  it("does not tell the leader to type a shell line for either", () => {
    assert.ok(!leadPersona().includes("ovai say"));
    assert.ok(!leadPersona().includes("ovai status"));
  });

  it("grants no shell line for the room", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(!allow.some((rule) => rule.includes("ovai room")));
  });

  it("does not tell the leader to type a shell line for the room", () => {
    assert.ok(!leadPersona().includes("ovai room"));
  });

  it("describes the instance that was asked for", () => {
    assert.deepEqual(
      configProblems(inside("openovai.json"), {
        user: USER,
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

// Installing over an instance is the same act as taking a newer version of it: the payload is
// replaced whole, the person's files are kept whatever is in them, and a file of theirs that a
// fresh install would have given them is seeded if it is missing. Each file is marked with a line
// no template holds, so the check reads content rather than counting files. The one file that is
// read rather than kept is the instance's own description: what the command line says is written
// into it, what it leaves off is taken from it.
describe("installing over an instance", () => {
  const root = `${instance}-over`;
  const MARK = "kept by the person\n";
  const USER_FILES = [
    [".claude", "settings.json"],
    [".local", "settings.json"],
    ["desks", LEADER, "STATE.md"],
  ];
  let again;
  let before_;

  remove(root);
  installed(options(root));
  for (const parts of USER_FILES) {
    fs.appendFileSync(path.join(root, ...parts), MARK);
  }
  // Something the person added to their description, which no answer names and which has to
  // survive the answers being written in.
  before_ = JSON.parse(fs.readFileSync(path.join(root, "openovai.json"), "utf8"));
  fs.writeFileSync(path.join(root, "openovai.json"), `${JSON.stringify({ ...before_, quietHours: "22-07" }, null, 2)}\n`);
  // Something the person put beside the layout: read by nothing, and not the installer's to take
  // away.
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", `${LEADER}.md`), MARK);
  fs.writeFileSync(path.join(root, "lib", "left-behind.mjs"), "// not in the source\n");
  fs.rmSync(path.join(root, ".claude", "allowed.md"), { force: true });
  again = install(options(root, { "--force": true, "--port": 4242, "--leader-model": "haiku" }));

  it("goes through", () => {
    assert.equal(again.status, 0, again.stderr);
  });

  for (const parts of USER_FILES) {
    it(`keeps ${parts.join("/")} as the person left it`, () => {
      assert.ok(fs.readFileSync(path.join(root, ...parts), "utf8").endsWith(MARK));
    });
  }

  // An answer given over an instance is written into its description — a person typing a port
  // means the port — and everything the answer does not name is left as it was, the person's own
  // additions included.
  it("writes the answers given into the description the instance has, and keeps the rest of it", () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, "openovai.json"), "utf8"));
    assert.deepEqual(
      [config.port, config.models.leader, config.models.worker, config.createdAt, config.quietHours],
      [4242, "haiku", WORKER_MODEL, before_.createdAt, "22-07"],
    );
  });

  it("names the description among what it wrote, since it changed it", () => {
    assert.ok(again.stdout.includes(path.join(root, "openovai.json")));
  });

  // What is not given is not missing: the instance's own description answers for it.
  it("takes an answer left off the command line from the description the instance has", () => {
    const fewer = install({ "--root": root, "--source": repo, "--force": true });
    const config = JSON.parse(fs.readFileSync(path.join(root, "openovai.json"), "utf8"));
    assert.equal(fewer.status, 0, fewer.stderr);
    assert.deepEqual([config.port, config.models.leader, config.user], [4242, "haiku", USER]);
    assert.ok(!fewer.stdout.includes(path.join(root, "openovai.json")));
  });

  it("replaces the payload whole, taking away what the source has not got", () => {
    assert.ok(!fs.existsSync(path.join(root, "lib", "left-behind.mjs")));
  });

  it("leaves what the person put beside the layout exactly as it found it", () => {
    assert.equal(fs.readFileSync(path.join(root, "notes", `${LEADER}.md`), "utf8"), MARK);
  });

  it("names what it seeded and what it replaced, and nothing it kept", () => {
    assert.ok(again.stdout.includes(path.join(root, "lib")));
    assert.ok(!again.stdout.includes(path.join(root, "notes")));
    assert.ok(!again.stdout.includes(path.join(root, ".claude", "settings.json")));
    assert.ok(!again.stdout.includes(path.join(root, ".local", "settings.json")));
  });

  // A file the person has not got is placed as a fresh install places it — the case of an
  // instance made before the toolkit wrote that file at all.
  describe("a file of the person's that is missing", () => {
    let seeded;

    before(() => {
      fs.rmSync(path.join(root, ".local", "settings.json"));
      fs.rmSync(path.join(root, "desks", LEADER, "STATE.md"));
      seeded = install(options(root, { "--force": true }));
    });

    it("is seeded as a fresh install would seed it", () => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, ".local", "settings.json"), "utf8"));
      assert.equal(settings.autoContinueAtUsageLimit, true);
      assert.ok(fs.readFileSync(path.join(root, "desks", LEADER, "STATE.md"), "utf8").includes(LEADER));
    });

    it("is named among what was written", () => {
      assert.ok(seeded.stdout.includes(path.join(root, ".local", "settings.json")));
      assert.ok(seeded.stdout.includes(path.join(root, "desks", LEADER, "STATE.md")));
    });

    it("leaves the rest of the person's files as they were", () => {
      assert.ok(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8").endsWith(MARK));
    });
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
      "--user": USER,
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
    const said = /^install: .*does not look like an OpenOv AI instance.*lib\/VERSION/m.test(refused.stderr);
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
      configProblems(path.join(chosen, "openovai.json"), {
        user: USER,
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
  it("answers ovai configuration", () => {
    assert.equal(runOvai(instance, ["configuration"], process.env).status, 0);
  });

  it("names the User in ovai configuration", () => {
    assert.match(runOvai(instance, ["configuration"], process.env).stdout, new RegExp(USER));
  });
});

// One version, written in two places for two readers: the file the payload carries, and the
// package declaration for tooling that reads that instead. Nothing makes one follow the other, so
// this is what says they have not drifted.
describe("the version the toolkit is on", () => {
  it("says the same thing in the payload and in the package", () => {
    const declared = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
    assert.equal(fs.readFileSync(path.join(repo, "lib", "VERSION"), "utf8").trim(), declared);
  });
});

// A release is cut from the repository, and what it carries for the Leader of a workspace taking it
// is a file in that repository. A release cut without one tells the Leader an update happened and
// nothing about what it was — which is the whole of what this feature is for.
describe("what a release says for itself", () => {
  it("carries notes for the Leader at the root of the repository", () => {
    assert.match(fs.readFileSync(path.join(repo, RELEASE_NOTES), "utf8").trim(), /\S/);
  });

  it("says something about the version being released", () => {
    assert.match(fs.readFileSync(path.join(repo, RELEASE_NOTES), "utf8"), new RegExp(fs.readFileSync(path.join(repo, "lib", "VERSION"), "utf8").trim()));
  });

  it("is not in the payload, since it describes a release rather than an instance", () => {
    assert.equal(PAYLOAD.includes(RELEASE_NOTES), false);
  });
});
