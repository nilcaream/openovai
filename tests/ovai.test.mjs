// tests/ovai.test.mjs — check the instance command: what status reports, and what login hands over.
//
// Claude Code is never really run. The stand-in from helpers.mjs answers `auth status` and
// `auth login`, so this checks our side of both: that status asks rather than guesses, that an
// instance without a credential says how to fix itself, and that a failed sign-in cannot look
// like a success.
//
// Two instances are installed, one for each way of signing in, because the difference between
// them is exactly what an instance is allowed to take from the environment it is started in.
//
// Run it with: node --test tests/ovai.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, it } from "node:test";

import {
  installed,
  projectDirectoriesIn,
  readLog,
  remove,
  repo,
  runOvai,
  scratch,
  writeNodeStandIn,
  writeStandIn,
} from "./helpers.mjs";
import { settingsProblems, trustProblems } from "./inspect.mjs";

const HUMAN = "Mike";
const LEADER = "Superman";
// Two models and not one. They sit side by side in the same file and are printed on two lines of
// the same report, so with one word in both fields a report that read the wrong one — or wrote a
// model of its own — said the right thing anyway.
const LEADER_MODEL = "sonnet";
const WORKER_MODEL = "haiku";
const PORT = 7900;
const TOKEN = "a-machine-token";
const WORKER = "Paul";

const instance = scratch("ovai-test");
const inherited = `${instance}-inherited`;
const standIn = `${instance}-stand-in`;

// One stand-in node per version the Node checks pretend the machine has.
const nodes = `${instance}-nodes`;

// Each instance records its calls in its own file, so that what one of them was run with can
// never be read as evidence about the other.
const log = path.join(standIn, "calls.txt");
const inheritedLog = path.join(standIn, "inherited.txt");

process.on("exit", () => remove(instance, inherited, standIn, nodes));

function install(root, auth) {
  installed({
    "--root": root,
    "--source": repo,
    "--human": HUMAN,
    "--leader": LEADER,
    "--leader-model": LEADER_MODEL,
    "--worker-model": WORKER_MODEL,
    "--port": PORT,
    "--auth": auth,
  });
}

// Run an instance's command with the stand-in first on the PATH, and with both an account
// credential that must never be inherited and a machine token that may be, depending on how the
// instance was installed. `changes` is how a check asks what happens when the machine has no
// token, or when Claude Code answers differently.
function run(root, recordIn, argv, changes = {}) {
  return runOvai(root, argv, {
    ...process.env,
    OPENOVAI_STAND_IN_LOG: recordIn,
    ANTHROPIC_API_KEY: "must-not-be-inherited",
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    PATH: `${standIn}${path.delimiter}${process.env.PATH}`,
    ...changes,
  });
}

// A PATH whose node reports the version given, with the stand-in for Claude Code still on it,
// so the only thing different about the run is which Node the launcher finds first.
function onNode(version) {
  const directory = path.join(nodes, version);
  writeNodeStandIn(directory, version);
  return { PATH: [directory, standIn, process.env.PATH].join(path.delimiter) };
}

const ovai = (argv, changes) => run(instance, log, argv, changes);
const ovaiInherited = (argv, changes) => run(inherited, inheritedLog, argv, changes);

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
    said = ovai(["status"]).stdout;
  });

  // What this instance is running. Read from the payload, so it names the code that is actually
  // here rather than whatever it was installed as.
  it("says which version this instance is on", () => {
    assert.match(said, new RegExp(`version\\s+${fs.readFileSync(path.join(repo, "VERSION"), "utf8").trim()}`));
  });

  it("names the human", () => {
    assert.match(said, new RegExp(HUMAN));
  });

  it("names the leader and the model it runs on", () => {
    assert.match(said, new RegExp(`${LEADER} \\(${LEADER_MODEL}\\)`));
  });

  it("names the model a hired worker runs on, which is the other one", () => {
    assert.match(said, new RegExp(`worker model\\s+${WORKER_MODEL}`));
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
    said = ovai(["status"], { OPENOVAI_STAND_IN_SIGNED_IN: "false" }).stdout;
  });

  it("reports that it has none", () => {
    assert.match(said, /credential\s+none/);
  });

  it("says how to fix itself", () => {
    assert.match(said, /ovai login/);
  });
});

describe("how the instance signs in", () => {
  it("says an instance with an account of its own signs itself in", () => {
    assert.match(ovai(["status"]).stdout, /signs in by\s+an account of its own/);
  });

  it("names the variable an inheriting instance signs in with", () => {
    assert.match(ovaiInherited(["status"]).stdout, /signs in by\s+CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("says the machine's token is there", () => {
    assert.match(ovaiInherited(["status"]).stdout, /which is set here/);
  });

  it("notices a missing machine token", () => {
    assert.match(ovaiInherited(["status"], { CLAUDE_CODE_OAUTH_TOKEN: "" }).stdout, /not set here/);
  });

  it("never prints the value of the machine's token", () => {
    assert.ok(!ovaiInherited(["status"]).stdout.includes(TOKEN));
  });

  it("does not send an inheriting instance to a sign-in that would refuse it", () => {
    const said = ovaiInherited(["status"], { OPENOVAI_STAND_IN_SIGNED_IN: "false" }).stdout;
    assert.ok(!said.includes("run: ovai login"));
  });
});

// An instance made before the toolkit carried a version is a real thing to be standing in front
// of, and status is the command somebody runs when they are working out what they have. So it
// answers that question instead of dying of it.
describe("an instance with no version in it", () => {
  let said;

  before(() => {
    const file = path.join(instance, "VERSION");
    const kept = fs.readFileSync(file, "utf8");
    fs.rmSync(file);
    try {
      said = ovai(["status"]);
    } finally {
      fs.writeFileSync(file, kept);
    }
  });

  it("still answers", () => {
    assert.equal(said.status, 0);
  });

  it("says the version is not recorded rather than inventing one", () => {
    assert.match(said.stdout, /version\s+not recorded/);
  });
});

describe("where a person can read what the workspace has learned", () => {
  // Inside the Claude Code home, which is the one part of an instance nobody is expected to go
  // looking in. Spelled out here rather than asked of the code, so that moving it and moving the
  // check cannot be one edit.
  it("says where this instance keeps it", () => {
    assert.match(ovai(["status"]).stdout, new RegExp(`memory\\s+${instance}/.claude-home/projects/workspace/memory`));
  });
});

describe("the sign-in", () => {
  it("hands over to Claude Code", () => {
    assert.equal(ovai(["login"]).status, 0);
    assert.match(readLog(log), /argv: auth login/);
  });

  it("does not let a failed sign-in look like a success", () => {
    assert.notEqual(ovai(["login"], { OPENOVAI_STAND_IN_LOGIN_STATUS: "3" }).status, 0);
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

// Where an instance keeps what it has learned. Claude Code files transcripts and memory under
// <config dir>/projects/<a name>/, and left alone it makes that name out of the absolute directory
// a session was started in — which for every session here is the instance root. An instance that
// was moved would then be looking for both under a path it does not sit at any more.
//
// The two instances are at two different roots, which is the only set-up in which "the same
// wherever it sits" is observably different from "made out of where it sits".
describe("where an instance files what it knows", () => {
  before(() => {
    ovai(["status"]);
    ovaiInherited(["status"]);
  });

  it("names the directory Claude Code files this instance's transcripts and memory under", () => {
    assert.equal(projectDirectoriesIn(log).at(-1), "workspace");
  });

  it("gives an instance at another root the same name", () => {
    assert.equal(projectDirectoriesIn(inheritedLog).at(-1), projectDirectoriesIn(log).at(-1));
  });

  it("does not let the environment it was started in decide", () => {
    ovai(["status"], { CLAUDE_CODE_PROJECT_DIR_NAME: "somebody-elses-workspace" });
    assert.equal(projectDirectoriesIn(log).at(-1), "workspace");
  });

  it("keeps it to one directory name", () => {
    assert.ok(!projectDirectoriesIn(log).at(-1).includes(path.sep));
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
    ovaiInherited(["status"]);
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
    assert.notEqual(ovaiInherited(["login"]).status, 0);
  });

  it("is told where a token comes from instead", () => {
    assert.match(ovaiInherited(["login"]).stderr, /setup-token/);
  });
});

// An instance carries its own copy of everything it runs and can be started on a different
// machine from the one it was installed on, so the launcher applies the same floor the
// installer does rather than trusting that it was checked once.
describe("the Node the command needs", () => {
  const refused = ovai(["status"], onNode("v20.18.1"));

  it("refuses a Node older than the one it needs", () => {
    assert.notEqual(refused.status, 0);
  });

  it("says which Node it needs", () => {
    assert.match(refused.stderr, /Node\.js 24 or newer is required/);
  });

  it("says which Node it found", () => {
    assert.match(refused.stderr, /v20\.18\.1/);
  });

  it("runs on the Node it needs", () => {
    assert.equal(ovai(["status"], onNode("v24.0.0")).status, 0);
  });

  it("runs on a Node newer than the one it needs", () => {
    assert.equal(ovai(["status"], onNode("v99.0.0")).status, 0);
  });
});

// Hiring is the whole of what it takes to add a person to an instance: a desk to keep state on,
// a persona saying who they are, and the one rule that lets them write that desk.
describe("hiring a worker", () => {
  let said;

  before(() => {
    said = ovai(["hire", WORKER]);
  });

  it("opens the worker a desk", () => {
    assert.ok(fs.existsSync(path.join(instance, "work", WORKER, "STATE.md")));
  });

  it("names the worker on that desk", () => {
    const desk = fs.readFileSync(path.join(instance, "work", WORKER, "STATE.md"), "utf8");
    assert.match(desk, new RegExp(`^# ${WORKER}$`, "m"));
  });

  // A desk opened by hiring is the same desk the installer opens: one line of header, holding the
  // one field anything outside the desk reads.
  it("opens that desk with a header holding the title and nothing else", () => {
    const desk = fs.readFileSync(path.join(instance, "work", WORKER, "STATE.md"), "utf8");
    assert.equal(desk.split("\n")[0], "<!-- DESK | title: -->");
  });

  it("writes the worker a persona", () => {
    assert.ok(fs.existsSync(path.join(instance, "personas", `${WORKER}.md`)));
  });

  it("says in the persona who the worker is", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.ok(persona.includes(`You are ${WORKER}`));
  });

  it("says in the persona who leads", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.ok(persona.includes(LEADER));
  });

  // A worker is asked for the same one line the lead is: the header field that says what it is on.
  // Without it the page has a column with nothing in it and no way to fill one.
  // And the worker is not told about it. A worker has one task and the others are not its
  // business; the room is what somebody deciding who does what needs, which is the lead and the
  // person at the page.
  it("does not tell the worker to look at the room", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.ok(!persona.includes("bin/ovai room"));
  });

  // Nor to ask for it as a tool. The chat does not offer a worker that one and refuses it if asked
  // anyway, so a persona naming it would be sending a session for a refusal.
  it("does not tell the worker to ask for the room either", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.ok(!/`room` tool/.test(persona));
  });

  // What it IS told, in place of the tools it has not got: where the boundary runs. A worker that
  // knows only that something stopped has the files right there, and rewriting a desk by hand is
  // both easier than asking and indistinguishable from the tool having worked.
  it("tells the worker whose the workspace itself is", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, new RegExp(`who is asked to join and who leaves,\\s+is ${LEADER}'s`));
    assert.match(persona, /the files underneath it are never\s+the way round/);
  });

  // The other half of the same paragraph, and the half a person actually sees. A panel is handed
  // one thing per turn — what the run amounted to — so a refusal reported and then followed by a
  // desk edit and a closing line is a refusal that reaches nobody, and the turn reads as done.
  // Measured on a real session: it reported the refusal exactly as told, wrote its desk exactly as
  // told, and the panel showed the desk sentence. Hence the ordering, said in the persona rather
  // than built into the page: it costs a clause, and the alternative is a mechanism.
  it("tells the worker to report a refusal last of all", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /saying so is the last thing you do that turn/);
    assert.match(persona, /Finish the rest first/);
    assert.match(persona, /a panel that shows only the last thing you said/);
  });

  // The same rule as the two above, widened to every tool the worker is not offered and asserted
  // once. Naming one is what sends a session hunting for it; the paragraph above is written to say
  // where the boundary is without naming a single thing on the other side of it.
  it("names the worker no tool it cannot call", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.doesNotMatch(persona, /\b(hire|retire|room|interrupt)\b/i);
  });

  it("tells the worker which one field of its header is read by anybody else", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /the `title:` in it is the one field/);
  });

  it("tells the worker to keep that field saying what it is on", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /Keep it saying what you are on/);
  });

  // The desk is one task and goes away with it; the memory is the workspace. A session that does
  // not know the difference files a durable fact where the next person will never look.
  it("tells the worker that everybody here reads what the workspace has learned", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /everybody\s+here reads the same thing/);
  });

  it("tells the worker what belongs in the memory rather than on the desk", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /the memory is the workspace/);
  });

  // How a worker reaches anybody else here. It is a tool rather than a command because the message
  // is free text: composed as a shell line, an apostrophe in it ends the quoting and a backtick is
  // run instead of sent.
  it("tells the worker how to say something to somebody", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /The `say` tool is also how you reach anybody else here/);
  });

  it("tells the worker how to see who works here", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /the `status` tool says who that is/);
  });

  it("does not tell the worker to type the command it replaced", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.ok(!persona.includes("ovai say"));
    assert.ok(!persona.includes("ovai status"));
  });

  it("tells the worker its header holds nothing else", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /header holds nothing else/);
  });

  // The whole of the speakerphone on the worker's side: it can see that nobody wrapped the turn, it
  // knows that means the human, and it knows the chat has already said so upward — so it answers
  // the human rather than spending a turn passing it on.
  it("tells the worker that a message from a session comes wrapped", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /<from-session name=/);
  });

  it("tells the worker that what is outside a wrapper is the human", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, new RegExp(`outside a wrapper is ${HUMAN}`));
  });

  it("tells the worker that the chat passes it on, so the worker does not", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, new RegExp(`the chat tells ${LEADER} what was said`));
  });

  // Asserted as an absence, which is the half a text check usually misses: the instruction that
  // cost a whole nested turn has to be GONE, not merely outweighed by a newer paragraph.
  it("no longer tells the worker to pass on what the human said itself", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.ok(!persona.includes(`bin/ovai say ${LEADER}`));
  });

  it("tells the worker what to do when the one it is telling is waiting on it", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /waiting for your answer[\s\S]*say it in your reply instead/i);
  });

  // A handover is asked for in words, so a session that does not know what the wrapper means reads
  // it as prose and may do anything with it. These are the two halves it has to have: what the
  // wrapper is, and that the desk is kept current before one ever arrives.
  it("tells the worker what a handover arrives as", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /<handover>/);
  });

  it("tells the worker which file to write when one does", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, new RegExp(`<handover>[\\s\\S]*work/${WORKER}/STATE.md`));
  });

  it("tells the worker that the thread ends when it answers", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /the\s+thread ends when you answer/);
  });

  // And the ending nobody announces. A session told only about <handover> reads a conversation that
  // simply stopped as a fault in the workspace, and — worse — has no reason to keep its desk current
  // for an ending it does not know can happen.
  it("tells the worker that a conversation can also end unannounced", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /<pick-up>/);
  });

  it("tells the worker which file to read when one does", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, new RegExp(`<pick-up>[\\s\\S]*work/${WORKER}/STATE.md`));
  });

  it("tells the worker to keep the desk current before one is ever asked for", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.match(persona, /kept current as you go and not only then/);
  });

  it("leaves no unfilled placeholder in the worker's persona", () => {
    const persona = fs.readFileSync(path.join(instance, "personas", `${WORKER}.md`), "utf8");
    assert.ok(!persona.includes("{{"));
  });

  it("lets the worker write its own desk, and nothing wider", () => {
    assert.deepEqual(
      settingsProblems(path.join(instance, ".claude", "settings.json"), [LEADER, WORKER]),
      [],
    );
  });

  it("says whose desk it opened", () => {
    assert.match(said.stdout, new RegExp(WORKER));
  });

  it("lists the new desk in status", () => {
    assert.match(ovai(["status"]).stdout, new RegExp(`desks.*${WORKER}`));
  });

  it("starts no session doing it", () => {
    assert.ok(!readLog(log).includes("argv: -p"));
  });
});

describe("what hiring refuses", () => {
  it("refuses to hire nobody", () => {
    assert.notEqual(ovai(["hire"]).status, 0);
  });

  it("says a name is the thing that is missing", () => {
    assert.match(ovai(["hire"]).stderr, /hire needs a name/);
  });

  it("refuses a name a directory could not be", () => {
    assert.notEqual(ovai(["hire", "../elsewhere"]).status, 0);
  });

  it("refuses somebody who already has a desk", () => {
    assert.notEqual(ovai(["hire", LEADER]).status, 0);
  });

  it("says who already has a desk", () => {
    assert.match(ovai(["hire", LEADER]).stderr, new RegExp(`${LEADER} already has a desk`));
  });

  it("refuses more than one name at a time", () => {
    assert.notEqual(ovai(["hire", "Ann", "Bob"]).status, 0);
  });

  // A name is more than its desk. The chat keeps a panel and a thread under the same name, and a
  // desk opened over the top of those is a new person answering out of somebody else's
  // conversation — which reads as a fresh start right up until the first reply. The state is
  // reached the way it happens: a desk gone and a conversation still here.
  describe("a name whose conversation is still here", () => {
    const CAME_BACK = "Otter";

    before(() => {
      ovai(["hire", CAME_BACK]);
      fs.rmSync(path.join(instance, "work", CAME_BACK), { recursive: true, force: true });
      fs.mkdirSync(path.join(instance, "chat", CAME_BACK), { recursive: true });
      fs.writeFileSync(path.join(instance, "chat", CAME_BACK, "conversation.json"), "[]\n");
    });

    it("refuses", () => {
      assert.notEqual(ovai(["hire", CAME_BACK]).status, 0);
    });

    it("says what is in the way and where it is", () => {
      assert.match(ovai(["hire", CAME_BACK]).stderr, new RegExp(`conversation here.*chat/${CAME_BACK}`));
    });

    it("leaves that conversation alone", () => {
      ovai(["hire", CAME_BACK]);
      assert.ok(fs.existsSync(path.join(instance, "chat", CAME_BACK, "conversation.json")));
    });
  });
});

// Starting a tool this instance serves itself. One file is written and nothing else happens, and
// the two things worth checking are where it lands and what is said about it — a scaffold that
// writes somewhere the chat does not look is a command that appears to work and does nothing.
describe("starting a tool the instance serves itself", () => {
  const TOOL = "notify";
  let said;

  before(() => {
    said = ovai(["plugin", TOOL]);
  });

  // Where the chat looks, and nowhere else. The directory is the list, so the file being in the
  // right one IS the tool being served, and there is nothing else that could be checked instead.
  it("writes it where the chat looks for one", () => {
    assert.ok(fs.existsSync(path.join(instance, "plugins", `${TOOL}.mjs`)));
  });

  // The file, and then the one thing somebody would otherwise sit and wonder about: a tool is read
  // when the chat starts, so a chat that is already running goes on serving what it started with.
  it("says what it wrote, and that the chat has to be started again", () => {
    assert.match(said.stdout, new RegExp(path.join("plugins", `${TOOL}.mjs`)));
    assert.match(said.stdout, /chat again/);
  });

  // And the first line, which is the one somebody reads and believes, says when the tool is served
  // rather than that it is served. Nothing has read the file yet, so a session asked to call it
  // now is told there is no such tool — a line saying the instance serves it is a line that sends
  // somebody looking for what is wrong with a workspace that is working.
  it("says when the tool is served, which is not yet", () => {
    assert.match(said.stdout, new RegExp(`^${TOOL} is a tool this instance serves from the next chat start\\.`));
  });

  // Refused rather than written over, and the check reads the file rather than the status: a
  // command that refuses after it has already overwritten somebody's work has refused nothing.
  it("refuses a name that is already a tool here, and leaves that tool alone", () => {
    const target = path.join(instance, "plugins", `${TOOL}.mjs`);
    fs.writeFileSync(target, "// somebody's own work\n");
    const again = ovai(["plugin", TOOL]);
    assert.equal(again.status, 1);
    assert.equal(fs.readFileSync(target, "utf8"), "// somebody's own work\n");
  });

  // A name the chat serves itself is taken, the way a name with a file already under it is taken:
  // something true of the workspace rather than of what was typed, so exit 1 and no usage. It is
  // refused here or it is refused on the next chat start, by which time somebody has written a
  // handler into a file that was never going to be served.
  it("refuses a name the chat already serves, and writes nothing", () => {
    const refused = ovai(["plugin", "say"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /say is already the name of a tool the chat serves everywhere/);
    assert.ok(!fs.existsSync(path.join(instance, "plugins", "say.mjs")));
  });

  // A name a tool cannot have is a command line that is wrong, not a workspace that is: answered
  // with the usage under it, and exit 2 rather than 1. The exact status, never "not zero" — the
  // refusals in this describe are told apart by nothing else.
  it("refuses a name a tool cannot have, as a command line", () => {
    const refused = ovai(["plugin", "not_a_tool"]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /not a name a tool can have/);
    assert.match(refused.stderr, /ovai plugin <name>/);
    assert.ok(!fs.existsSync(path.join(instance, "plugins", "not_a_tool.mjs")));
  });

  it("refuses to start one with no name at all", () => {
    const refused = ovai(["plugin"]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /plugin needs a name/);
  });
});

describe("what the command refuses", () => {
  it("refuses a command it does not have", () => {
    assert.notEqual(ovai(["nonsense"]).status, 0);
  });

  it("refuses an argument to a command that takes none", () => {
    assert.notEqual(ovai(["status", WORKER]).status, 0);
  });
});
