// tests/ovai.test.mjs — check the instance command: what configuration reports, what the server
// commands do, and what login hands over.
//
// Claude Code is never really run. The stand-in from helpers.mjs answers `auth status` and
// `auth login`, so this checks our side of both: that configuration asks rather than guesses,
// that an instance without a credential says how to fix itself, and that a failed sign-in cannot
// look like a success.
//
// It also reads the toolkit's own source, for the one thing about starting Claude Code that
// cannot be seen by starting it: that no way of doing so gives the session a terminal.
//
// Two instances are installed, one for each way of signing in, because the difference between
// them is exactly what an instance is allowed to take from the environment it is started in.
//
// Run it with: node --test tests/ovai.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  // The local install() below is the one this suite makes instances with. This is the raw one,
  // for the checks that are about an install being refused rather than about what it wrote.
  install as installing,
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
import { LEDGER, settingsProblems, trustProblems } from "./inspect.mjs";

// The reader this suite asks directly. Everywhere else what a session runs on is seen by starting
// one, which is right when the subject is a run — and no help at all with what a file holding
// nothing means, which is a question about the reading rather than about the running.
import { DeskError, POOL, hire, modelFor, persona as renderPersona } from "../lib/desks.mjs";
import { HOOK_ENTRY } from "../lib/hooks/compound.mjs";

// Open a desk the way the Leader's `hire` tool does, in this process, and answer the way a command
// would: what was written, or the refusal. The command line has no hire — a Worker joins through
// the tool — and this suite is about the desk that opening one leaves behind.
function hiring(name, model = null) {
  try {
    return { ok: true, written: hire(instance, name, model) };
  } catch (error) {
    if (error instanceof DeskError) {
      return { ok: false, refused: error.message };
    }
    throw error;
  }
}

const USER = "Mike";
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
    "--user": USER,
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
  path.join(inherited, ".local", ".claude.json"),
  `${JSON.stringify(
    { somethingClaudeCodeWrote: "keep-me", projects: { "/somewhere-else": { hasTrustDialogAccepted: true } } },
    null,
    2,
  )}\n`,
);

describe("what configuration reports", () => {
  let said;

  before(() => {
    said = ovai(["configuration"]).stdout;
  });

  // What this instance is running. Read from the payload, so it names the code that is actually
  // here rather than whatever it was installed as.
  it("says which version this instance is on", () => {
    assert.match(said, new RegExp(`version\\s+${fs.readFileSync(path.join(repo, "lib", "VERSION"), "utf8").trim()}`));
  });

  it("names the User", () => {
    assert.match(said, new RegExp(USER));
  });

  it("names the leader and the model it runs on", () => {
    assert.match(said, new RegExp(`${LEADER} \\(${LEADER_MODEL}\\)`));
  });

  // As the default, in the label. Somebody can be hired onto a model of their own, so a row that
  // said "worker model" would name what some of the workers here run on and read as all of them.
  it("names the model a hired worker runs on by default, and says that is the default", () => {
    assert.match(said, new RegExp(`default worker model\\s+${WORKER_MODEL}`));
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
    said = ovai(["configuration"], { OPENOVAI_STAND_IN_SIGNED_IN: "false" }).stdout;
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
    assert.match(ovai(["configuration"]).stdout, /signs in by\s+an account of its own/);
  });

  it("names the variable an inheriting instance signs in with", () => {
    assert.match(ovaiInherited(["configuration"]).stdout, /signs in by\s+CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("says the machine's token is there", () => {
    assert.match(ovaiInherited(["configuration"]).stdout, /which is set here/);
  });

  it("notices a missing machine token", () => {
    assert.match(ovaiInherited(["configuration"], { CLAUDE_CODE_OAUTH_TOKEN: "" }).stdout, /not set here/);
  });

  it("never prints the value of the machine's token", () => {
    assert.ok(!ovaiInherited(["configuration"]).stdout.includes(TOKEN));
  });

  it("does not send an inheriting instance to a sign-in that would refuse it", () => {
    const said = ovaiInherited(["configuration"], { OPENOVAI_STAND_IN_SIGNED_IN: "false" }).stdout;
    assert.ok(!said.includes("run: ovai login"));
  });
});

// An instance made before the toolkit carried a version is a real thing to be standing in front
// of, and configuration is the command somebody runs when they are working out what they have. So it
// answers that question instead of dying of it.
describe("an instance with no version in it", () => {
  let said;

  before(() => {
    const file = path.join(instance, "lib", "VERSION");
    const kept = fs.readFileSync(file, "utf8");
    fs.rmSync(file);
    try {
      said = ovai(["configuration"]);
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
  // Spelled out here rather than asked of the code, so that moving the store and moving the check
  // cannot be one edit.
  it("says where this instance keeps it", () => {
    assert.match(ovai(["configuration"]).stdout, new RegExp(`store\\s+${instance}/store`));
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
    assert.match(readLog(log), new RegExp(`CLAUDE_CONFIG_DIR: ${instance}/.local`));
  });

  it("keeps an account credential in the environment away from it", () => {
    assert.ok(!readLog(log).includes("ANTHROPIC_API_KEY: must-not-be-inherited"));
  });
});

// What the toolkit starts, and the shape it starts Claude Code in.
//
// Claude Code arms its own background-shell pressure reaper only for a session it judged
// interactive, and it judges once, as the session opens: a run given --print is never one,
// whatever sits underneath it. Nothing here gives a session a terminal today, and this is where
// that stays true — not by listing the places Claude Code is started, because a list goes stale
// the day somebody adds the next one, but by reading every process this tree starts and refusing
// the ones whose shape cannot be decided.
//
// The rule is about the arguments and not about the stdio, on purpose. Piped stdout would make a
// run non-interactive too, and it does at two of the three places Claude Code is started here,
// but it is the half a refactor from "pipe" to "inherit" invalidates without touching anything
// that looks related. --print sits in the argument list, where a reader is already looking.
//
// Assumed rather than smoothed over: `claude auth …` runs no turn, so it owns no background work
// there is anything to lose. That is the whole reason the sign-in may hand over a real terminal —
// lib/claude.mjs starts it with stdio "inherit", and on a terminal that child's stdout IS one —
// and still be safe.
//
// The shell is the one way past all of that: this reads the child_process family, so a line in
// install.sh or bin/ovai that ran Claude Code would pass unseen. Teaching the walk to read shell
// buys guesswork rather than an answer — there is no tree to read there and every heuristic has a
// false positive waiting — so the rule over there is the blunt one instead: nothing in this repo
// reaches Claude Code from a shell script at all, and the last check below is the tripwire on it.
const CLAUDE = "claude";

// Where the walk does not go. Scratch holds installed instances, which are copies of lib/, so
// reading those would report every finding twice; the suites themselves start a Node stand-in,
// git and `claude --version`, none of which is a session being given a shape.
const NOT_THE_TOOLKIT = new Set([".git", ".tmp", ".local", "node_modules", "desks", "tests"]);

// The child_process family, and nothing that merely ends in one of those names: `.exec(` belongs
// to RegExp and there are a dozen of those in here.
const STARTS_A_PROCESS = /(?<![.\w$])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/g;

// The first line of a file, without reading the rest of it: a walk that slurped every file whole
// to look at its opening would read the images too.
function opening(at) {
  const fd = fs.openSync(at, "r");
  try {
    const head = Buffer.alloc(64);
    return head.toString("utf8", 0, fs.readSync(fd, head, 0, head.length, 0)).split("\n")[0];
  } finally {
    fs.closeSync(fd);
  }
}

// Written in JavaScript, and written in shell. A shell script here is either named .sh or named
// nothing at all and opened with a shell shebang, which is what bin/ovai is.
const IS_JAVASCRIPT = (at) => /\.m?js$/.test(at);
const IS_SHELL = (at) => /\.sh$/.test(at) || /^#!.*sh\b/.test(opening(at));

function sourceFiles(from, written, into = []) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (NOT_THE_TOOLKIT.has(entry.name)) continue;
    const at = path.join(from, entry.name);
    if (entry.isDirectory()) sourceFiles(at, written, into);
    else if (written(at)) into.push(at);
  }
  return into;
}

// Comments go before anything is read. A quotation mark or a bracket in a comment beside a call
// is neither an argument nor a nesting, and the argument list of the run that serves a seat has
// three lines of prose in the middle of it.
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

// The arguments a call was written with, as source text, one entry each: everything between its
// parentheses, split at the commas that are not inside a nesting or a string of their own. Null
// when the parentheses do not close, which is a call this cannot read rather than a call with no
// arguments.
function argumentsOf(source, from) {
  const out = [];
  let start = from;
  let depth = 0;
  let quote = null;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        out.push(source.slice(start, i));
        return out;
      }
      depth -= 1;
    } else if (c === "," && depth === 0) {
      out.push(source.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

// The string a piece of argument source says on its own, or null when it does not say one: a
// variable, a call, a template with something interpolated into it. Null is the finding.
function saidLiterally(text) {
  const said = /^\s*(["'])([^"'`\\$]*)\1\s*$/.exec(text ?? "");
  return said === null ? null : said[2];
}

// The arguments handed to a run, read either from the array written at the call or from the one
// declared under that name in the same file — the run that serves a seat builds its list a
// couple of dozen lines above the spawn. An entry that is not a literal comes back as null,
// which is honest: `--model` is followed by a value worked out at the time. A later push can add
// arguments and never take one away, so what is declared is enough to decide on.
function argumentsHandedOver(text, source) {
  let body = text ?? "";
  if (!/^\s*\[/.test(body)) {
    const named = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(body);
    if (named === null) return null;
    const declared = new RegExp(String.raw`(?:const|let|var)\s+${named[1]}\s*=\s*\[`).exec(source);
    if (declared === null) return null;
    body = source.slice(declared.index + declared[0].length - 1);
  }
  const held = argumentsOf(body, body.indexOf("[") + 1);
  return held === null ? null : held.map((one) => saidLiterally(one));
}

// Every process-starting call in the toolkit: where it is, the command it names, and — only when
// that command is Claude Code — the arguments it hands over. A null command or a null argument
// list is a call this could not read, and that is reported rather than passed over.
function processStarts(root) {
  const found = [];
  for (const file of sourceFiles(root, IS_JAVASCRIPT)) {
    const source = withoutComments(fs.readFileSync(file, "utf8"));
    for (const call of source.matchAll(STARTS_A_PROCESS)) {
      const args = argumentsOf(source, call.index + call[0].length);
      const command = args === null ? null : saidLiterally(args[0]);
      found.push({
        where: `${path.relative(root, file)}:${source.slice(0, call.index).split("\n").length}`,
        command,
        argv: command === CLAUDE ? argumentsHandedOver(args[1], source) : undefined,
      });
    }
  }
  return found;
}

// What a shell script says, with what it merely mentions taken out: a comment runs from the first
// # that is not inside quoting to the end of its line, and the inside of a string is prose rather
// than a command — install.sh names Claude Code in a warning it prints when the PATH has none.
function shellCode(source) {
  let out = "";
  for (const line of source.split("\n")) {
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (quote !== null) {
        if (c === "\\" && quote === '"') i += 1;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
      else out += c;
    }
    out += "\n";
  }
  return out;
}

// Asking whether it is installed is not running it. Both shell scripts here look for Claude Code
// on the PATH before they promise anything, and what they do about a missing one is stop.
const ASKS_WHETHER_IT_IS_THERE = /(?:command\s+-v|which|type|hash)\s+$/;

// The name on its own, so that claude.mjs and claude-code-anything are not it.
const NAMES_IT = /(?<![\w./-])claude(?![\w.-])/g;

// Every place a shell script in the toolkit says the name for any reason other than probing the
// PATH for it. Shell is not read here, so everything else is a finding by default rather than a
// shape someone judged: this is a tripwire, and being made to think is the whole of what it buys.
function shellSaysClaudeCode(root) {
  const found = [];
  for (const file of sourceFiles(root, IS_SHELL)) {
    const code = shellCode(fs.readFileSync(file, "utf8"));
    for (const named of code.matchAll(NAMES_IT)) {
      const before = code.slice(0, named.index);
      if (ASKS_WHETHER_IT_IS_THERE.test(before.slice(before.lastIndexOf("\n") + 1))) continue;
      found.push(`${path.relative(root, file)}:${before.split("\n").length}`);
    }
  }
  return found;
}

describe("what the toolkit starts", () => {
  const starts = processStarts(repo);
  const claudes = starts.filter((one) => one.command === CLAUDE);

  // Without this the two checks below both pass on a walk that read nothing at all — a skip list
  // that swallowed lib/, a pattern that stopped matching — and a vacuous check is worse than
  // no check, because it reports that the question was asked.
  it("starts Claude Code somewhere, so that what follows is about something", () => {
    assert.ok(claudes.length > 0, `no run of Claude Code found under ${repo}: the walk is reading the wrong tree`);
  });

  it("says what command and what arguments every process it starts is given", () => {
    const unreadable = starts
      .filter((one) => one.command === null || (one.command === CLAUDE && one.argv === null))
      .map((one) => one.where);
    assert.deepEqual(
      unreadable,
      [],
      "a process is started through something this cannot read: name the command and write its arguments where it is started, so the shape it runs in is legible there",
    );
  });

  it("never starts Claude Code in a shape its background reaper is armed for", () => {
    const armed = claudes
      .filter((one) => one.argv !== null)
      .filter((one) => !one.argv.includes("--print") && one.argv[0] !== "auth")
      .map((one) => one.where);
    assert.deepEqual(
      armed,
      [],
      "Claude Code is started neither in print mode nor as an auth subcommand, so a terminal underneath it would arm the background reaper and background work would start disappearing: pass --print",
    );
  });

  // The tripwire on the shell, which none of the above can see into. No shell script here reaches
  // Claude Code today, so this costs nothing until the day the first one does, and then it goes
  // red on exactly that event and on nothing else. When it does, the answer is not to delete it
  // and not to teach this to read shell: decide whether that new run is non-interactive, and take
  // the rule to whoever owns this.
  it("never reaches Claude Code from a shell script, where the shape it runs in cannot be read", () => {
    assert.deepEqual(
      shellSaysClaudeCode(repo),
      [],
      "a shell script does something with Claude Code other than ask the PATH whether it is installed, and shell is not read here, so nothing is checking the shape that session would run in: start it from JavaScript, where the checks above can see it",
    );
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
    ovai(["configuration"]);
    ovaiInherited(["configuration"]);
  });

  it("names the directory Claude Code files this instance's transcripts and memory under", () => {
    assert.equal(projectDirectoriesIn(log).at(-1), "workspace");
  });

  it("gives an instance at another root the same name", () => {
    assert.equal(projectDirectoriesIn(inheritedLog).at(-1), projectDirectoriesIn(log).at(-1));
  });

  it("does not let the environment it was started in decide", () => {
    ovai(["configuration"], { CLAUDE_CODE_PROJECT_DIR_NAME: "somebody-elses-workspace" });
    assert.equal(projectDirectoriesIn(log).at(-1), "workspace");
  });

  it("keeps it to one directory name", () => {
    assert.ok(!projectDirectoriesIn(log).at(-1).includes(path.sep));
  });
});

describe("the instance trusts its own directory", () => {
  it("records its own directory as trusted", () => {
    assert.deepEqual(trustProblems(path.join(instance, ".local", ".claude.json"), instance), []);
  });

  it("keeps what Claude Code had already written there", () => {
    assert.match(fs.readFileSync(path.join(inherited, ".local", ".claude.json"), "utf8"), /keep-me/);
  });

  it("keeps another directory Claude Code had trusted", () => {
    assert.deepEqual(
      trustProblems(path.join(inherited, ".local", ".claude.json"), "/somewhere-else"),
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
    ovaiInherited(["configuration"]);
  });

  it("takes the machine's token", () => {
    assert.ok(readLog(inheritedLog).includes(`CLAUDE_CODE_OAUTH_TOKEN: ${TOKEN}`));
  });

  it("keeps an account credential in the environment away from Claude Code", () => {
    assert.ok(!readLog(inheritedLog).includes("ANTHROPIC_API_KEY: must-not-be-inherited"));
  });

  it("still uses its own Claude Code home", () => {
    assert.match(readLog(inheritedLog), new RegExp(`CLAUDE_CONFIG_DIR: ${inherited}/.local`));
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
  const refused = ovai(["configuration"], onNode("v20.18.1"));

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
    assert.equal(ovai(["configuration"], onNode("v24.0.0")).status, 0);
  });

  it("runs on a Node newer than the one it needs", () => {
    assert.equal(ovai(["configuration"], onNode("v99.0.0")).status, 0);
  });
});

// Hiring is the whole of what it takes to add a person to an instance: a desk to keep state on,
// and the rule that makes that desk directory the worker's to write in. The desk file
// itself is written through a tool, and stays refused to the file tools.
describe("hiring a worker", () => {
  let said;

  before(() => {
    said = hiring(WORKER);
  });

  it("opens the worker a desk", () => {
    assert.ok(fs.existsSync(path.join(instance, "desks", WORKER, "STATE.md")));
  });

  it("names the worker on that desk", () => {
    const desk = fs.readFileSync(path.join(instance, "desks", WORKER, "STATE.md"), "utf8");
    assert.match(desk, new RegExp(`^# ${WORKER}$`, "m"));
  });

  // A desk opened by hiring is the same desk the installer opens: one line of header, holding the
  // one field anything outside the desk reads.
  it("opens that desk with a header holding the title and nothing else", () => {
    const desk = fs.readFileSync(path.join(instance, "desks", WORKER, "STATE.md"), "utf8");
    assert.equal(desk.split("\n")[0], "<!-- DESK | title: | status: | rules: | updated: -->");
  });

  // Who the worker is gets rendered when its first conversation starts, from the templates the
  // instance has then — so hiring writes nothing that says so, and there is nothing for an update
  // to leave stale. What it would be told is read here the way the chat renders it.
  it("writes the worker no persona: the directory is the desk alone", () => {
    assert.deepEqual(fs.readdirSync(path.join(instance, "desks", WORKER)), ["STATE.md"]);
  });

  // A desk is a working directory: the worker keeps what the work produces beside its desk file,
  // and a session stopped on a permission dialog to keep its own notes is a session stopped for
  // doing its job. One rule, anchored at the root: `Edit(...)` governs the Write tool too.
  it("grants the worker its own desk directory, anchored at the root, and no Write twin that would match nothing", () => {
    const allow = JSON.parse(fs.readFileSync(path.join(instance, ".claude", "settings.json"), "utf8")).permissions.allow;
    assert.ok(allow.includes(`Edit(/desks/${WORKER}/**)`), JSON.stringify(allow));
    assert.ok(!allow.some((rule) => rule.startsWith("Write(")), JSON.stringify(allow));
  });

  it("grants nothing wider than that rule, and the instance still accounts for every rule it holds", () => {
    assert.deepEqual(settingsProblems(path.join(instance, ".claude", "settings.json")), []);
  });

  it("names the settings among what it wrote, since it changed them", () => {
    assert.ok(said.written.includes(path.join(instance, ".claude", "settings.json")), said.written.join("\n"));
  });

  const workerPersona = () => renderPersona(instance, WORKER, { user: USER, leader: LEADER });

  it("does not tell the worker to type a shell line for either", () => {
    const persona = workerPersona();
    assert.ok(!persona.includes("ovai say"));
    assert.ok(!persona.includes("ovai status"));
    assert.ok(!persona.includes("ovai room"));
  });

  // What a brief costs is how many times the agent it went to goes round, and that agent cannot
  // see it: it was handed a question, not a budget. The persona is where the one writing the brief
  // is told to put the budget in it — and told that nothing else will carry it, because the
  // cheapest kinds of agent are given none of this workspace's own instructions.
  it("tells the worker how much a brief it writes may spend", () => {
    const persona = workerPersona();
    assert.match(persona, /at most 15 tool calls/);
    assert.match(persona, /report what you have and say what is missing/);
  });

  // The half that makes the rest of it worth anything. This workspace writes no briefs — the session
  // reading this does — so the persona has to say that the sentences go into the brief itself, copied,
  // rather than merely be true of the one reading them. An agent sees its brief and nothing else.
  it("tells the worker to copy the budget into every brief it writes", () => {
    const persona = workerPersona();
    assert.match(persona, /copy the four sentences below into every brief you write, word for word/);
  });
  it("tells the worker the three rules that keep that budget", () => {
    const persona = workerPersona();
    assert.match(persona, /split the files between them/);
    assert.match(persona, /Search first, then read the part that matched/);
    assert.match(persona, /history, not a place to look things up/);
  });

  it("tells the worker that only the brief carries it", () => {
    const persona = workerPersona();
    assert.match(persona, /none of what you are\s+reading now/);
  });
  it("leaves no unfilled placeholder in the worker's persona", () => {
    const persona = workerPersona();
    assert.ok(!persona.includes("{{"));
  });

  // A hire grants nothing: the desk is written through a tool, so there is no rule per person, and
  // the settings after a hire are the settings the instance was born with.
  it("grants the worker no rule of its own", () => {
    assert.deepEqual(settingsProblems(path.join(instance, ".claude", "settings.json")), []);
  });

  it("names the desk among what it wrote", () => {
    assert.ok(said.written.some((entry) => entry.includes(path.join("desks", WORKER))), said.written.join("\n"));
  });

  it("lists the new desk in the configuration", () => {
    assert.match(ovai(["configuration"]).stdout, new RegExp(`desks.*${WORKER}`));
  });
});

// What a workspace can say about the rules it holds.
//
// Two kinds of rule are handed out here without anybody being asked: a desk for each person, and
// the one that lets a session call the tools the chat serves it. Everything else is somebody
// answering a question at the page, and a press is a bad record of a decision — it says what was
// allowed and nothing about who wanted it or why, and it is permanent. The workspace this toolkit
// came out of holds twenty-six of them: a kill for a pid that died a week ago, a delete for a
// directory that is gone, and two that are not commands at all but the first two words of a line
// somebody was typing when they pressed.
//
// So a rule beyond those two kinds has to be written down beside the settings, in a file a person
// reads, and an instance that holds one nothing accounts for is an instance that cannot say what
// it allows. Nothing writes a wide rule yet — this is the invariant, landed before the thing that
// needs it, and it is read here off files written by hand for the purpose.
describe("what a workspace can account for", () => {
  const accounting = scratch("ovai-test-accounting");
  const settings = path.join(accounting, ".claude", "settings.json");
  const WIDE = "Bash(make:*)";

  function holding(allow, lines) {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, `${JSON.stringify({ permissions: { allow }, hooks: { PreToolUse: [HOOK_ENTRY] } }, null, 2)}\n`);
    const written = path.join(path.dirname(settings), LEDGER);
    if (lines === undefined) {
      fs.rmSync(written, { force: true });
    } else {
      fs.writeFileSync(written, lines.join("\n"));
    }
    return settingsProblems(settings);
  }

  // Spelled out rather than imported: a check that read the list it is checking would agree with
  // itself the day somebody widened it.
  const standing = [
    "mcp__openovai",
    "Read(/**)",
    "Edit(/reference/**)",
    "Edit(/projects/**)",
    "Edit(/temp/**)",
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

  after(() => remove(accounting));

  // The state every instance starts in, and the one the check has always held: the rules it hands
  // out itself, nothing wider, and nothing to account for.
  it("says nothing about an instance that holds only what it was born with", () => {
    assert.deepEqual(holding(standing, undefined), []);
  });

  // The whole slice. This is the check that would have caught `Bash(kill 1807950)` the day it was
  // pressed — a rule in the file with nothing anywhere saying who wanted it.
  it("names a rule nothing accounts for", () => {
    const problems = holding([...standing, WIDE], undefined);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /nothing accounts for/);
    assert.match(problems[0], /Bash\(make:\*\)/);
  });

  // And says nothing about the same rule once somebody has. The line is the account: the rule
  // first, in backticks, the list it landed in, and then whatever a person needs to know about it.
  it("says nothing about the same rule once it is written down", () => {
    assert.deepEqual(
      holding([...standing, WIDE], [
        "# What this workspace has settled",
        "",
        `- \`${WIDE}\` (allow) — ${LEADER}, for \`node --test tests\``,
        "",
      ]),
      [],
    );
  });

  // A line from an older instance names no list, and it is an allow: the only list there was.
  it("reads a line naming no list as an allow", () => {
    assert.deepEqual(holding([...standing, WIDE], [`- \`${WIDE}\` — ${LEADER}, for \`node --test tests\``]), []);
  });

  // A rule settled twice has two lines, and the settings hold the last one: an allow moved to ask
  // is accounted for by its (ask) line, and the stale (allow) line does not make it a claim.
  it("reads the last line for a rule as the one the settings hold", () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, `${JSON.stringify({ permissions: { allow: standing, ask: [WIDE] }, hooks: { PreToolUse: [HOOK_ENTRY] } }, null, 2)}\n`);
    fs.writeFileSync(path.join(path.dirname(settings), LEDGER), [`- \`${WIDE}\` (allow) — ${LEADER}, for x`, `- \`${WIDE}\` (ask) — ${LEADER}, for y`].join("\n"));
    assert.deepEqual(settingsProblems(settings), []);
  });

  // Both directions, which is the half a ledger is usually missing. A line for a rule that is not
  // granted reads as an answer and is not one, and a file allowed to over-claim is a file that
  // stops being evidence — a rule could be removed by hand and its line would keep vouching for it.
  it("names a rule the file claims and the settings do not hold", () => {
    const problems = holding(standing, [`- \`${WIDE}\` (allow) — ${LEADER}, for something that is not granted`]);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /accounted for but not held/);
    assert.match(problems[0], /Bash\(make:\*\)/);
  });

  // Prose in the file is prose. A person opening this writes a heading and a sentence about what it
  // is for, and a reader that took every backticked word for a rule would turn its own explanation
  // into a claim.
  it("reads the lines that are rules and leaves the rest of the file alone", () => {
    assert.deepEqual(
      holding(standing, [
        "# What this workspace has settled",
        "",
        `Every line below was asked for by somebody. \`${WIDE}\` is the shape of one.`,
        "",
      ]),
      [],
    );
  });
});

// Somebody can be hired onto a model that is not the one this workspace runs its workers on. It is
// one word in one file beside their desk, and it is written only because it was named.
describe("hiring somebody onto a model of their own", () => {
  const ON_A_MODEL = "Zoe";
  const CHOSEN = "opus";
  let said;

  before(() => {
    said = hiring(ON_A_MODEL, CHOSEN);
  });

  it("opens the desk", () => {
    assert.deepEqual([said.ok, fs.existsSync(path.join(instance, "desks", ON_A_MODEL, "STATE.md"))], [true, true]);
  });

  it("writes down the model they were hired onto and nothing else", () => {
    assert.equal(fs.readFileSync(path.join(instance, "desks", ON_A_MODEL, "MODEL"), "utf8").trim(), CHOSEN);
  });

  it("names that file among what it wrote", () => {
    assert.ok(said.written.some((entry) => entry.endsWith(path.join("desks", ON_A_MODEL, "MODEL"))), said.written.join("\n"));
  });
});

// And somebody hired the usual way has nothing written down at all. Absent is what "the one
// everybody else here runs on" is made of: a workspace that changes that setting moves everybody
// who was never named one, and a desk holding today's answer would be a person who stopped moving
// with it. So the check reads the directory rather than the resolver — a file holding the default
// and no file at all resolve to the same word, and only one of them is this.
describe("hiring somebody the usual way", () => {
  it("writes nothing down about a model", () => {
    assert.equal(fs.existsSync(path.join(instance, "desks", WORKER, "MODEL")), false);
  });

  it("leaves the desk directory holding the desk and nothing else", () => {
    assert.deepEqual(fs.readdirSync(path.join(instance, "desks", WORKER)).sort(), ["STATE.md"]);
  });
});

// What a desk is read as running on, asked of the reader itself. A file holding nothing is a desk
// that has said nothing, and saying nothing is the workspace's own answer rather than an empty
// model nothing would start on.
describe("what a desk is read as running on", () => {
  const config = { leader: LEADER, models: { leader: LEADER_MODEL, worker: WORKER_MODEL } };
  const READ_BACK = "Bo";
  const file = path.join(instance, "desks", READ_BACK, "MODEL");

  before(() => {
    hiring(READ_BACK, "opus");
  });

  it("reads the word the desk was hired onto", () => {
    fs.writeFileSync(file, "opus\n");
    assert.equal(modelFor(instance, READ_BACK, config), "opus");
  });

  it("reads a word with space around it as that word", () => {
    fs.writeFileSync(file, "  opus  \n");
    assert.equal(modelFor(instance, READ_BACK, config), "opus");
  });

  it("reads a file holding nothing as the workspace's own", () => {
    fs.writeFileSync(file, "");
    assert.equal(modelFor(instance, READ_BACK, config), WORKER_MODEL);
  });

  it("reads a file holding whitespace as the workspace's own", () => {
    fs.writeFileSync(file, "   \n");
    assert.equal(modelFor(instance, READ_BACK, config), WORKER_MODEL);
  });

  it("reads somebody with no such file as the workspace's own", () => {
    assert.equal(modelFor(instance, WORKER, config), WORKER_MODEL);
  });

  it("reads the Leader as the model this workspace leads on", () => {
    assert.equal(modelFor(instance, LEADER, config), LEADER_MODEL);
  });
});

// The one place somebody reading the repo is told that a hire can name a model at all. Read as
// text, because a README is not run: what is asserted is that the section says the two halves of
// it — the argument, and where a named model is written down.
describe("what the README says about hiring onto a model", () => {
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("- `hire` (Leader)"), readme.indexOf("- `permission` (Leader)"));

  it("names the model as what a hire takes beside the name", () => {
    assert.match(section, /and a model when not the usual one/);
  });

  // The roster, as the README says it: the thirty names in the pool's own order, and the rule.
  it("names the roster, in its order, and the rule that picks from it", () => {
    assert.match(section, /called with no name, the roster names the Worker/);
    assert.match(section, new RegExp(`\\(${POOL.join(",\\s+")}\\)`));
    assert.match(section, /never used first, in that order, then the one whose\s+holder left longest ago/);
    assert.match(section, /With nobody in the pool free, Dev and three digits/);
  });

  it("says where a model that was named is written down", () => {
    assert.match(section, /desks\/<Name>\/MODEL/);
  });

  // And names none. The models a workspace uses are chosen at install and live in
  // `openovai.json`; a README that named one would be this workspace's answer written into the
  // documentation of everybody's, and it would go stale the week the service renames something.
  it("names no model of its own", () => {
    assert.doesNotMatch(section, /\b(opus|sonnet|haiku)\b/i);
  });
});

// And what configuration says about all of them at once. Once one desk can differ from another, the row
// listing the desks is the only place the answer for each of them is written down — and on an
// instance whose chat is not running it is the only place it can be read at all.
describe("what configuration says each desk runs on", () => {
  const OF_THEIR_OWN = "Faye";
  const THE_USUAL_WAY = "Gil";
  const CHOSEN = "opus";
  let said;

  const desksRow = () => said.split("\n").find((line) => line.trim().startsWith("desks"));

  before(() => {
    hiring(OF_THEIR_OWN, CHOSEN);
    hiring(THE_USUAL_WAY);
    said = ovai(["configuration"]).stdout;
  });

  it("names somebody hired onto a model of their own with that model", () => {
    assert.match(said, new RegExp(`${OF_THEIR_OWN} \\(${CHOSEN}\\)`));
  });

  // The half a row printing the file would get wrong: there is no file to print for somebody
  // hired the usual way, and a blank where a model should be reads as a desk that runs on nothing.
  it("names somebody hired the usual way with the workspace's own model", () => {
    assert.match(said, new RegExp(`${THE_USUAL_WAY} \\(${WORKER_MODEL}\\)`));
  });

  // The Leader is on the row too, and on the model this workspace leads on rather than on the one
  // its workers get — the resolver is asked about every desk and it knows which one is the Leader's.
  //
  // Read off the desks row rather than out of the report. The leader row prints the Leader and its
  // model two lines above, so a check that looked anywhere would pass on that line however the
  // desks row was written.
  it("names the Leader with the model this workspace leads on", () => {
    assert.ok(desksRow()?.includes(`${LEADER} (${LEADER_MODEL})`), desksRow());
  });

  // Named, not merely mentioned somewhere in the report, for the same reason.
  it("puts them on the desks row and not only in the report", () => {
    assert.ok(desksRow()?.includes(`${OF_THEIR_OWN} (${CHOSEN})`), desksRow());
    assert.ok(desksRow()?.includes(`${THE_USUAL_WAY} (${WORKER_MODEL})`), desksRow());
  });
});

describe("what hiring refuses", () => {
  it("refuses a name a directory could not be", () => {
    assert.equal(hiring("../elsewhere").ok, false);
  });

  it("refuses somebody who already has a desk", () => {
    assert.equal(hiring(LEADER).ok, false);
  });

  it("says who already has a desk", () => {
    assert.match(hiring(LEADER).refused, new RegExp(`${LEADER} already has a desk`));
  });

  // The model is refused before a byte of the desk exists, so a name typed with a model that is not
  // one is a name nobody was opened a desk for — rather than a person half made, holding a name
  // somebody would have to take back by hand.
  describe("a model that is not one", () => {
    const NOT_HIRED = "Rex";
    let said;

    before(() => {
      said = hiring(NOT_HIRED, "not a model");
    });

    it("refuses it", () => {
      assert.equal(said.ok, false);
    });

    // The rule, not the verdict. "Is not a model identifier" says the value is wrong and leaves
    // somebody to guess what a right one looks like — which is the moment they go looking for a
    // list of models, and a list is the one thing this sentence must never send them to.
    it("says what a model identifier is rather than listing the models there are", () => {
      assert.match(
        said.refused,
        /a model must start with a letter or digit and hold only letters, digits, '\.', '-' or '_' \(got "not a model"\)/,
      );
      assert.doesNotMatch(said.refused, /\b(opus|sonnet|haiku)\b/i);
    });

    it("leaves no desk behind", () => {
      assert.equal(fs.existsSync(path.join(instance, "desks", NOT_HIRED)), false);
    });

    it("leaves no conversation behind either", () => {
      assert.equal(fs.existsSync(path.join(instance, "desks", NOT_HIRED)), false);
    });
  });

  // One pattern, asked by both the things that name a model. A workspace that may be installed on
  // a model has to be able to hire onto it, and two patterns would be two answers to what a model
  // identifier is the day one of them was widened.
  describe("what the installer will not take either", () => {
    for (const value of ["a model", "-leading", "with/a/path"]) {
      it(`refuses ${JSON.stringify(value)} where installing refuses it`, () => {
        const putting = installing({
          "--root": `${instance}-never-made`,
          "--source": repo,
          "--user": USER,
          "--leader": LEADER,
          "--leader-model": LEADER_MODEL,
          "--worker-model": value,
          "--port": PORT,
          "--auth": "login",
        });
        assert.deepEqual(
          [hiring("Ann", value).ok, putting.status, fs.existsSync(`${instance}-never-made`)],
          [false, 2, false],
        );
      });
    }
  });

  // The Leader is not hired: the installer opened that desk when the workspace was made. So there is
  // no door here that can put the Leader on another model, and it is refused by the desk it has
  // rather than by a guard written for the occasion.
  describe("the Leader, named with a model", () => {
    let said;

    before(() => {
      said = hiring(LEADER, "opus");
    });

    it("refuses the name for the desk it already has", () => {
      assert.match(said.refused, new RegExp(`${LEADER} already has a desk here`));
    });

    it("writes nothing down about what the Leader runs on", () => {
      assert.equal(fs.existsSync(path.join(instance, "desks", LEADER, "MODEL")), false);
    });
  });

  // A name is more than its desk. The chat keeps a panel and a persona under the same name, and a
  // desk opened over the top of those is a new person answering out of somebody else's
  // conversation — which reads as a fresh start right up until the first reply. The state is
  // reached the way it happens: a desk gone and a conversation still here.
  describe("a name whose conversation is still here", () => {
    const CAME_BACK = "Otter";

    before(() => {
      hiring(CAME_BACK);
      fs.rmSync(path.join(instance, "desks", CAME_BACK), { recursive: true, force: true });
      fs.mkdirSync(path.join(instance, "desks", CAME_BACK), { recursive: true });
      fs.writeFileSync(path.join(instance, "desks", CAME_BACK, "conversation.json"), "[]\n");
    });

    it("refuses", () => {
      assert.equal(hiring(CAME_BACK).ok, false);
    });

    it("says what is in the way and where it is", () => {
      assert.match(hiring(CAME_BACK).refused, new RegExp(`conversation here.*desks/${CAME_BACK}`));
    });

    it("leaves that conversation alone", () => {
      hiring(CAME_BACK);
      assert.ok(fs.existsSync(path.join(instance, "desks", CAME_BACK, "conversation.json")));
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
  // when the server starts, so a server that is already running goes on serving what it started
  // with — and the command that reads it again is named.
  it("says what it wrote, and that the server has to be restarted", () => {
    assert.match(said.stdout, new RegExp(path.join("plugins", `${TOOL}.mjs`)));
    assert.match(said.stdout, /^Restart the server to serve it.*: ovai restart$/m);
  });

  // And the first line, which is the one somebody reads and believes, says when the tool is served
  // rather than that it is served. Nothing has read the file yet, so a session asked to call it
  // now is told there is no such tool — a line saying the instance serves it is a line that sends
  // somebody looking for what is wrong with a workspace that is working.
  it("says when the tool is served, which is not yet", () => {
    assert.match(said.stdout, new RegExp(`^${TOOL} is a tool this instance serves from the next server start\\.`));
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
    const refused = ovai(["plugin", "message"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /message is already the name of a tool the chat serves everywhere/);
    assert.ok(!fs.existsSync(path.join(instance, "plugins", "message.mjs")));
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

// The server as a daemon: started in the background by the command, asked after with status,
// stopped with stop. Through bin/ovai with the stand-in on the PATH, so what is checked is exactly
// what a person at a terminal gets — and that the terminal gets its prompt back, which is what
// spawnSync returning at all proves. On an instance of its own, installed with --port 0: a fixed
// port would be one port for every copy of this suite running at once.
describe("the server commands", () => {
  const served = `${instance}-served`;
  const runtime = path.join(served, "runtime.json");
  const pidRecorded = () => JSON.parse(fs.readFileSync(runtime, "utf8")).pid;
  const ovai = (argv, changes) => run(served, log, argv, changes);
  let url;
  const answering = async () => {
    try {
      return (await fetch(`${url}/health`)).ok;
    } catch {
      return false;
    }
  };

  before(() => {
    remove(served);
    installed({
      "--root": served,
      "--source": repo,
      "--user": USER,
      "--leader": LEADER,
      "--leader-model": LEADER_MODEL,
      "--worker-model": WORKER_MODEL,
      "--port": 0,
      "--auth": "login",
    });
  });
  const settled = async (expected) => {
    for (let waited = 0; waited < 10_000; waited += 100) {
      if ((await answering()) === expected) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

  after(() => {
    // Whatever the checks left running is ended by the pid the server wrote down.
    try {
      process.kill(pidRecorded(), "SIGTERM");
    } catch {
      // Nothing running, or nothing recorded.
    }
    remove(served);
  });

  it("prints the help when given no command", () => {
    const bare = ovai([]);
    assert.equal(bare.status, 0);
    assert.equal(bare.stdout, ovai(["help"]).stdout);
    assert.match(bare.stdout, /^Usage:$/m);
  });

  it("has no chat and no hire", () => {
    for (const gone of ["chat", "hire"]) {
      const refused = ovai([gone]);
      assert.equal(refused.status, 2, gone);
      assert.match(refused.stderr, new RegExp(`^ovai: unknown command: ${gone}$`, "m"));
    }
  });

  it("says not running, and exits 3, while nothing runs", () => {
    const asked = ovai(["status"]);
    assert.equal(asked.stdout, "not running\n");
    assert.equal(asked.status, 3);
  });

  it("stops nothing without complaint", () => {
    const asked = ovai(["stop"]);
    assert.equal(asked.stdout, "not running\n");
    assert.equal(asked.status, 0);
  });

  it("starts the server in the background and prints its address, and nothing else", async () => {
    const started = ovai(["start"]);
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /^http:\/\/127\.0\.0\.1:\d+\n$/);
    assert.equal(started.stderr, "");
    url = started.stdout.trim();
    assert.ok(await settled(true), "the server is not answering after start returned");
  });

  // The last line, not the whole: what the server found on its way up — a plugin file it could not
  // serve, say — is written above it, and that is what the log is for.
  it("writes what the server says to runtime.log at the root, and no request lines", async () => {
    await fetch(`${url}/`);
    await fetch(`${url}/health`);
    const lines = fs.readFileSync(path.join(served, "runtime.log"), "utf8").split("\n").filter((line) => line !== "");
    assert.equal(lines.at(-1), `Serving ${served} at ${url}`);
    assert.deepEqual(lines.filter((line) => /^(GET|POST) /.test(line)), []);
  });

  it("says where it runs, with the pid the server recorded", () => {
    const asked = ovai(["status"]);
    assert.equal(asked.status, 0);
    assert.match(asked.stdout, new RegExp(`^running at ${url} \\(pid ${pidRecorded()}, since \\d{4}-\\d{2}-\\d{2}T[^)]+\\)$`, "m"));
  });

  it("does not start a second server over the first", () => {
    const pid = pidRecorded();
    const again = ovai(["start"]);
    assert.equal(again.status, 0);
    assert.equal(again.stdout, `already running at ${url}\n`);
    assert.equal(pidRecorded(), pid);
  });

  it("restarts: stops the one running, starts another, prints the address", async () => {
    const pid = pidRecorded();
    const restarted = ovai(["restart"]);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, new RegExp(`^Stopping the server at ${url} \\(pid ${pid}\\)\\.\nStopped\\.\n(http://127\\.0\\.0\\.1:\\d+)\n$`));
    assert.notEqual(pidRecorded(), pid);
    url = restarted.stdout.trim().split("\n").at(-1);
    assert.ok(await settled(true));
  });

  it("stops it, and status says so after", async () => {
    const pid = pidRecorded();
    const stopped = ovai(["stop"]);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout, `Stopping the server at ${url} (pid ${pid}).\nStopped.\n`);
    assert.ok(await settled(false), "still answering after stop");
    assert.equal(ovai(["status"]).status, 3);
  });

  // The record outlives the process on purpose; a status that read it without trying would say
  // running about a server that was killed. The state is made the way it happens: -9.
  it("finds a stale record out by trying", async () => {
    const started = ovai(["start"]);
    assert.equal(started.status, 0);
    url = started.stdout.trim();
    process.kill(pidRecorded(), "SIGKILL");
    assert.ok(await settled(false));
    assert.ok(fs.existsSync(runtime));
    assert.equal(ovai(["status"]).stdout, "not running\n");
    assert.equal(ovai(["stop"]).stdout, "not running\n");
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
