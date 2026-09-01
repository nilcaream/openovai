// tests/ow.test.mjs — check the instance command: what status reports, and what login hands over.
//
// Claude Code is never really run. The stand-in from helpers.mjs answers `auth status` and
// `auth login`, so this checks our side of both: that status asks rather than guesses, that an
// instance without a credential says how to fix itself, and that a failed sign-in cannot look
// like a success.
//
// Two instances are installed, one for each way of signing in, because the difference between
// them is exactly what an instance is allowed to take from the environment it is started in.
//
// Run it with: node --test tests/ow.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, it } from "node:test";

import { installed, readLog, remove, repo, runOw, scratch, writeStandIn } from "./helpers.mjs";
import { trustProblems } from "./inspect.mjs";

const HUMAN = "Mike";
const LEADER = "Superman";
const MODEL = "haiku";
const PORT = 7900;
const TOKEN = "a-machine-token";

const instance = scratch("ow-test");
const inherited = `${instance}-inherited`;
const standIn = `${instance}-stand-in`;

// Each instance records its calls in its own file, so that what one of them was run with can
// never be read as evidence about the other.
const log = path.join(standIn, "calls.txt");
const inheritedLog = path.join(standIn, "inherited.txt");

process.on("exit", () => remove(instance, inherited, standIn));

function install(root, auth) {
  installed({
    "--root": root,
    "--source": repo,
    "--human": HUMAN,
    "--leader": LEADER,
    "--leader-model": MODEL,
    "--worker-model": MODEL,
    "--port": PORT,
    "--auth": auth,
  });
}

// Run an instance's command with the stand-in first on the PATH, and with both an account
// credential that must never be inherited and a machine token that may be, depending on how the
// instance was installed. `changes` is how a check asks what happens when the machine has no
// token, or when Claude Code answers differently.
function run(root, recordIn, argv, changes = {}) {
  return runOw(root, argv, {
    ...process.env,
    OW_STAND_IN_LOG: recordIn,
    ANTHROPIC_API_KEY: "must-not-be-inherited",
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    PATH: `${standIn}${path.delimiter}${process.env.PATH}`,
    ...changes,
  });
}

const ow = (argv, changes) => run(instance, log, argv, changes);
const owInherited = (argv, changes) => run(inherited, inheritedLog, argv, changes);

remove(instance, inherited, standIn);
writeStandIn(standIn);
install(instance, "login");
install(inherited, "inherit");

// Claude Code owns this file and writes its own things into it. Put something there first, so
// the checks below can tell recording the trust apart from replacing the file.
fs.writeFileSync(
  path.join(inherited, ".claude-home", ".claude.json"),
  `${JSON.stringify(
    { somethingClaudeCodeWrote: "keep-me", projects: { "/somewhere-else": { hasTrustDialogAccepted: true } } },
    null,
    2,
  )}\n`,
);

describe("what status reports", () => {
  let said;

  before(() => {
    said = ow(["status"]).stdout;
  });

  it("names the human", () => {
    assert.match(said, new RegExp(HUMAN));
  });

  it("names the leader and the model it runs on", () => {
    assert.match(said, new RegExp(`${LEADER} \\(${MODEL}\\)`));
  });

  it("shows the port", () => {
    assert.match(said, new RegExp(String(PORT)));
  });

  it("reports an instance with a credential as having one", () => {
    assert.match(said, /credential\s+there is one/);
  });

  it("does not claim the credential was checked against Anthropic", () => {
    assert.match(said, /not checked against Anthropic/);
  });

  it("asks Claude Code rather than guessing", () => {
    assert.match(readLog(log), /argv: auth status/);
  });
});

describe("an instance with no credential", () => {
  let said;

  before(() => {
    said = ow(["status"], { OW_STAND_IN_SIGNED_IN: "false" }).stdout;
  });

  it("reports that it has none", () => {
    assert.match(said, /credential\s+none/);
  });

  it("says how to fix itself", () => {
    assert.match(said, /ow login/);
  });
});

describe("how the instance signs in", () => {
  it("says an instance with an account of its own signs itself in", () => {
    assert.match(ow(["status"]).stdout, /signs in by\s+an account of its own/);
  });

  it("names the variable an inheriting instance signs in with", () => {
    assert.match(owInherited(["status"]).stdout, /signs in by\s+CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("says the machine's token is there", () => {
    assert.match(owInherited(["status"]).stdout, /which is set here/);
  });

  it("notices a missing machine token", () => {
    assert.match(owInherited(["status"], { CLAUDE_CODE_OAUTH_TOKEN: "" }).stdout, /not set here/);
  });

  it("never prints the value of the machine's token", () => {
    assert.ok(!owInherited(["status"]).stdout.includes(TOKEN));
  });

  it("does not send an inheriting instance to a sign-in that would refuse it", () => {
    const said = owInherited(["status"], { OW_STAND_IN_SIGNED_IN: "false" }).stdout;
    assert.ok(!said.includes("run: ow login"));
  });
});

describe("the sign-in", () => {
  it("hands over to Claude Code", () => {
    assert.equal(ow(["login"]).status, 0);
    assert.match(readLog(log), /argv: auth login/);
  });

  it("does not let a failed sign-in look like a success", () => {
    assert.notEqual(ow(["login"], { OW_STAND_IN_LOGIN_STATUS: "3" }).status, 0);
  });
});

describe("what Claude Code is run as", () => {
  it("uses the instance's own Claude Code home", () => {
    assert.match(readLog(log), new RegExp(`CLAUDE_CONFIG_DIR: ${instance}/.claude-home`));
  });

  it("keeps an account credential in the environment away from it", () => {
    assert.ok(!readLog(log).includes("ANTHROPIC_API_KEY: must-not-be-inherited"));
  });
});

describe("the instance trusts its own directory", () => {
  it("records its own directory as trusted", () => {
    assert.deepEqual(trustProblems(path.join(instance, ".claude-home", ".claude.json"), instance), []);
  });

  it("keeps what Claude Code had already written there", () => {
    assert.match(fs.readFileSync(path.join(inherited, ".claude-home", ".claude.json"), "utf8"), /keep-me/);
  });

  it("keeps another directory Claude Code had trusted", () => {
    assert.deepEqual(
      trustProblems(path.join(inherited, ".claude-home", ".claude.json"), "/somewhere-else"),
      [],
    );
  });
});

describe("an instance that signs itself in", () => {
  it("never sees the machine's token", () => {
    assert.ok(!readLog(log).includes(`CLAUDE_CODE_OAUTH_TOKEN: ${TOKEN}`));
  });
});

describe("an instance that inherits", () => {
  before(() => {
    owInherited(["status"]);
  });

  it("takes the machine's token", () => {
    assert.ok(readLog(inheritedLog).includes(`CLAUDE_CODE_OAUTH_TOKEN: ${TOKEN}`));
  });

  it("keeps an account credential in the environment away from Claude Code", () => {
    assert.ok(!readLog(inheritedLog).includes("ANTHROPIC_API_KEY: must-not-be-inherited"));
  });

  it("still uses its own Claude Code home", () => {
    assert.match(readLog(inheritedLog), new RegExp(`CLAUDE_CONFIG_DIR: ${inherited}/.claude-home`));
  });

  it("is refused a sign-in of its own", () => {
    assert.notEqual(owInherited(["login"]).status, 0);
  });

  it("is told where a token comes from instead", () => {
    assert.match(owInherited(["login"]).stderr, /setup-token/);
  });
});

describe("what the command refuses", () => {
  it("refuses a command it does not have", () => {
    assert.notEqual(ow(["nonsense"]).status, 0);
  });
});
