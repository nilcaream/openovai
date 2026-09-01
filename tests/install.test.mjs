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

// The instances are removed however this run ends, including one that fails half way through.
process.on("exit", () => remove(instance, chosen, versions));

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

function inside(...parts) {
  return path.join(instance, ...parts);
}

function contentOf(...parts) {
  return fs.readFileSync(inside(...parts), "utf8");
}

remove(instance, chosen);
installed(options(instance));

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

  it("copies the desk template in", () => {
    assert.ok(fs.existsSync(inside("templates", "STATE.md")));
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
    assert.match(contentOf("work", LEADER, "STATE.md"), new RegExp(`name: ${LEADER}`));
  });

  it("leaves no unfilled placeholder on the desk", () => {
    assert.ok(!contentOf("work", LEADER, "STATE.md").includes("{{"));
  });

  it("copies the leader persona template in", () => {
    assert.ok(fs.existsSync(inside("templates", "leader.md")));
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
    assert.deepEqual(settingsProblems(inside(".claude", "settings.json"), LEADER), []);
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
