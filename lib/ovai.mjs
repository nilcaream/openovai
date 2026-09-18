#!/usr/bin/env node

// The instance's own command. bin/ovai works out which instance it belongs to and passes it in
// with --root, so nothing here has to guess where it is running.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { settingsIn } from "./chat/lifecycle.mjs";
import { logFile, recorded } from "./chat/runtime.mjs";
import { hasCredential, home, login, machineToken } from "./claude.mjs";
import { desks, modelFor } from "./desks.mjs";
import { hookWired } from "./hooks/compound.mjs";
import { InstanceError, readConfig, readRoot } from "./instance.mjs";
import { holderOf } from "./port.mjs";
import { RELEASES, ReleaseError, latestRelease, replacePayload, unpackInto } from "./release.mjs";
import { describeRunning, runningHere } from "./running.mjs";
import { rulesMissing, seedUserContent, wireHook } from "./seed.mjs";
import { readSettings, settingsFile } from "./settings.mjs";
import { STORE_DIRECTORY } from "./store.mjs";
import { PluginError, describePluginName, isPluginName, writePlugin } from "./plugins.mjs";
import { isOlderThan, version } from "./version.mjs";


const COMMANDS = ["help", "status", "configuration", "start", "stop", "restart", "plugin", "login", "update"];

// What a command takes after its name, for the ones that take anything. A command that is not
// here takes nothing, which is most of them.
const TAKES = {
  plugin: { most: 1, shape: "one name" },
  update: { most: 3, shape: "at most --from <url or directory> and --downgrade" },
};

// The server process, beside this file. `start` runs it in the background; it is a file of its
// own so that starting the server and being the server are never one command with two moods.
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "serve.mjs");

// How long `start` waits for the server it started to answer before calling it a failure. A
// server that binds a port does so within a second; the rest is a machine under load.
const START_PATIENCE = 30_000;

// What `status` exits with when nothing is running, the way a daemon's status does: a script
// can ask without reading the line.
const NOT_RUNNING = 3;

// Saying an update may take a version older than the one the instance is on.
const DOWNGRADE = "--downgrade";

class UsageError extends Error {}

// The server could not be started, reached or stopped. Nothing to do with the command line, so
// the usage under it would only be noise.
class ServerError extends Error {}

function usage() {
  return [
    "The command of an OpenOv AI instance.",
    "",
    "Usage:",
    "  ovai help          this",
    "  ovai status        whether the server is running, and where",
    "  ovai configuration what this instance is: who works here, on which models, how it signs in",
    "  ovai start         start the server in the background and print its address",
    "  ovai stop          stop the server: it parks every session first",
    "  ovai restart       stop the server and start it again",
    "  ovai plugin <name> start a tool this instance serves itself, from the scaffold",
    "  ovai login         sign this instance in to an Anthropic account",
    "  ovai update        take the latest release, replacing what the toolkit ships",
    "                   [--from <url or directory>] where to look instead",
    "                   [--downgrade] take it even when it is older than this instance",
    "",
  ].join("\n");
}

// What we know about this instance's credential, which is less than whether it works. Nothing
// here has talked to Anthropic, so nothing here promises the next message will go through; the
// row says so rather than letting "signed in: yes" stand in front of a token that expired
// last week.
function describeCredential(root, auth) {
  const present = hasCredential(root, auth);
  if (present === null) {
    return "cannot tell — Claude Code did not answer";
  }
  if (present) {
    return "there is one — not checked against Anthropic";
  }
  // What to do about it depends on where the account was supposed to come from. Telling an
  // instance that inherits to run `ovai login` would send it to a command that refuses.
  return auth === "inherit"
    ? "none — CLAUDE_CODE_OAUTH_TOKEN is not set in the environment this ran in"
    : "none — run: ovai login";
}

// Start a tool this instance serves itself. It writes one file and nothing else happens, which is
// the whole of what starting one is: there is no list to join, because the directory IS the list.
//
// The server has to be restarted, and that is said rather than left to be discovered. A tool is
// read when the server starts, so a running server goes on serving exactly what it was serving
// when it started — and a file that is plainly there, with nothing anywhere saying otherwise, is
// the thing somebody would sit and wonder about.
//
// Which is why the first line says when the tool is served rather than that it is served: it is
// the line somebody reads and believes, and a session asking for a tool that no server has read
// yet is told there is no such tool. What is true at the moment it is printed is that the file
// exists and the next start serves it.
//
// What a name is refused for lives in plugins.mjs, beside the rule the loader reads with. All this
// adds is the refusal that is about a command line rather than about a name: nothing typed at all.
function pluginHere(root, name) {
  if (name === undefined) {
    throw new UsageError("plugin needs a name: ovai plugin <name>");
  }
  if (!isPluginName(name)) {
    throw new UsageError(describePluginName(name));
  }

  const written = writePlugin(root, root, name);

  console.log(`${name} is a tool this instance serves from the next server start. Wrote:`);
  for (const entry of written) {
    console.log(`  ${entry}`);
  }
  console.log("Restart the server to serve it, since it reads these when it starts: ovai restart");
}

// Where the package is opened before any of it is put in place. Inside the instance rather than
// somewhere shared: an instance is self-contained, and an update that falls over half way leaves
// what it was working on where somebody would look for it rather than in a directory nobody owns.
const UNPACKING = ".release";

// Taking a newer version of the toolkit.
//
// What the toolkit ships is replaced, whole. Everything an instance accumulated — the desks, the
// settings, its Claude Code home with its account and its transcripts and what the workspace has
// learned, the panels and their conversations, its own description of itself — is the person's
// and is left as it is; a file of theirs that a fresh install would have given them and they have
// not got is seeded, once, the way the installer seeds it (lib/seed.mjs). So an updated instance
// is a clean install of the new version with the person's material in it, there is nothing here to
// migrate and no key that changes: the version is a file in the payload, so replacing the payload
// replaces it.
async function update(root, argv) {
  const { from, downgrade } = whereToLook(argv);

  // A running server is serving code that is about to be replaced underneath it, and a process
  // keeps the code it started with. Stopping first is what the person would have to do anyway for
  // the new version to run; asking for it here also means no session is mid-turn while this
  // happens, which is a whole class of half-finished state that never has to be reasoned about.
  const running = await serving(root);
  if (running !== null) {
    throw new ServerError(
      `the server is running at ${running.url} — stop it with: ovai stop — and run this again, or it will go on running the version it started with`,
    );
  }

  // And the sessions themselves, asked of the machine, because a server stopped is not every
  // session ended: a run that outlived a server killed with -9, or a session started by hand with this
  // instance's home, holds its persona and its code in memory and would go on running the old
  // version under an instance that says the new one is installed. Each is named with the command
  // that ends it, since the server that could have is not there.
  const sessions = runningHere(root);
  if (sessions.length > 0) {
    throw new ReleaseError(describeRunning(sessions));
  }

  const here = version(root);
  const release = await latestRelease(from);

  if (release.version === here) {
    console.log(`This instance is on ${here}, which is the latest release. Nothing to do.`);
    return;
  }

  // An instance can be ahead of what is published, and an update that only asked whether the two
  // versions differ would replace the payload with the older one and report the fall in the same
  // words as the rise. Refused rather than forbidden: walking away from a release that turned out
  // to be wrong is done by taking the one before it, and that is a thing somebody does on purpose.
  if (!downgrade && isOlderThan(release.version, here)) {
    throw new ReleaseError(
      `this instance is on ${here} and ${from} is ${release.version}, which is older — run it again with --downgrade to take it anyway`,
    );
  }

  const opened = path.join(root, UNPACKING);
  let replaced;
  try {
    fs.rmSync(opened, { recursive: true, force: true });
    const tree = release.unpacked ? release.package : await unpackInto(release.package, opened);
    // What was downloaded is asked whether it is a workspace before any of it is put in place,
    // inside replacePayload, so an instance is never half replaced by something that turned out to
    // be something else.
    replaced = replacePayload(root, tree);
  } finally {
    fs.rmSync(opened, { recursive: true, force: true });
  }

  const now = version(root);
  console.log(`Was on ${here ?? "no recorded version"}, now on ${now}. Replaced:`);
  for (const entry of replaced) {
    console.log(`  ${entry}`);
  }

  // From the templates just put in place, and only where the person has nothing yet.
  const seeded = seedUserContent(root, readConfig(root).leader);
  if (seeded.length > 0) {
    console.log("Seeded, since this instance had none:");
    for (const entry of seeded) {
      console.log(`  ${entry}`);
    }
  }

  // The hook is mechanism and goes into settings that lack it; the rules are the person's, and
  // the ones a fresh instance is born with that these settings have not got are said, not added.
  const wired = wireHook(root);
  if (wired.length > 0) {
    console.log("Wired the hook that lets a compound of allowed commands through, into:");
    for (const entry of wired) {
      console.log(`  ${entry}`);
    }
  } else if (!hookWired(readSettings(root))) {
    console.log(`Left ${settingsFile(root)} as it is, since it could not be read as JSON; the hook that lets a compound of allowed commands through is not wired.`);
  }
  const missing = rulesMissing(root);
  if (missing.length > 0) {
    console.log(`This instance's settings lack ${missing.length} of the rules a fresh one is born with; add them with an editor and a restart if you want them:`);
    for (const entry of missing) {
      console.log(`  ${entry}`);
    }
  }

  console.log("");
  console.log("Start the server to run it:");
  console.log(`  ${path.join(root, "bin", "ovai")} start`);
}

// What was asked of an update: where to look for a release, and whether it may go backwards.
//
// Anything that is not exactly the one option is refused rather than ignored. A command that takes
// a default quietly does the default thing when it is mistyped, and updating an instance from
// somewhere other than the place that was meant is not a mistake to make quietly.
function whereToLook(argv) {
  const downgrade = argv.includes(DOWNGRADE);
  const rest = argv.filter((word) => word !== DOWNGRADE);

  if (rest.length === 0) {
    return { from: RELEASES, downgrade };
  }

  if (rest[0] !== "--from" || rest.length !== 2 || rest[1] === "") {
    throw new UsageError(
      `update takes at most --from <url or directory> and ${DOWNGRADE} (got ${argv.join(" ")})`,
    );
  }

  return { from: rest[1], downgrade };
}

// What /health at the address says it is serving, or null when nothing answers there. A recorded
// address outlives the process that wrote it, on purpose — a stale one is found out by trying
// rather than by tidying up on the way out — and it is asked what it serves rather than only
// whether it answers, because with a fixed --port the address may by now be another instance's.
async function healthAt(url) {
  try {
    const response = await fetch(`${url}/health`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// The server serving THIS instance, or null: the record at the root, tried. { url, pid, since }
// as the server wrote them, once the address answers as this instance.
async function serving(root) {
  const record = recorded(root);
  if (record === null) {
    return null;
  }
  const health = await healthAt(record.url);
  if (health === null || path.resolve(String(health.instance)) !== path.resolve(root)) {
    return null;
  }
  return record;
}

// An instance that takes its token from the environment has no account of its own to sign in,
// and a credential written into its home would sit there being overridden. Say so rather than
// opening a browser for a sign-in that changes nothing.
function signIn(root) {
  const config = readConfig(root);

  if (config.auth === "inherit") {
    throw new UsageError(
      "this instance signs in with CLAUDE_CODE_OAUTH_TOKEN from the environment it is started in, not with an account of its own — mint a token with: claude setup-token",
    );
  }

  console.log(`Signing in ${home(root)}`);
  return login(root, config.auth);
}

// How this instance gets an account, and — when that is the machine's token — whether the
// token is actually there. Only its presence is reported: what is being answered is whether
// the instance can start, and printing a credential to answer that would be a poor trade.
function describeAuth(config) {
  if (config.auth !== "inherit") {
    return ["signs in by", "an account of its own"];
  }
  return [
    "signs in by",
    machineToken()
      ? "CLAUDE_CODE_OAUTH_TOKEN, which is set here"
      : "CLAUDE_CODE_OAUTH_TOKEN, which is not set here — mint one with: claude setup-token",
  ];
}

// Stop the server serving this instance: SIGTERM to whatever holds its port, which parks the
// room and exits; then wait until nothing answers on the address any more. Stopping what is not
// running is not a failure — the state asked for is the state there is — so it says so and exits 0.
async function stopServer(root) {
  const running = await serving(root);
  if (running === null) {
    console.log("not running");
    return;
  }
  const port = Number(new URL(running.url).port);
  // Named from the port rather than from the record: the record says who wrote it, the port says
  // who holds it now, and the second is the one to signal. The record is the fallback for a
  // machine that cannot name a port's holder.
  const pid = holderOf(port)?.pid ?? running.pid;
  console.log(`Stopping the server at ${running.url} (pid ${pid}).`);
  process.kill(pid, "SIGTERM");
  const patience = (settingsIn(readConfig(root)).park.timeout + 15) * 1000;
  const began = Date.now();
  while ((await healthAt(running.url)) !== null) {
    if (Date.now() - began > patience) {
      throw new ServerError(`the server at ${running.url} is still answering after ${patience / 1000}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log("Stopped.");
}

// Start the server in the background and print where it listens.
//
// The server is its own process (lib/serve.mjs), started detached with its output in the
// instance's log, so this command returns and the terminal is free: nothing here holds it. What
// is waited for is the proof that it is up — the record at the root carrying the pid of the very
// process started here, and its address answering as this instance — and only then is the
// address printed. A server that exits before that is a failed start, said with what it wrote.
async function startServer(root) {
  const running = await serving(root);
  if (running !== null) {
    console.log(`already running at ${running.url}`);
    return;
  }

  // "node" by name: the one bin/ovai found on the PATH and checked the version of, which is the
  // one running this.
  const log = fs.openSync(logFile(root), "w");
  const child = spawn("node", [SERVER, "--root", root], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  child.unref();

  let exited = null;
  child.once("exit", (code, signal) => {
    exited = signal ?? code;
  });

  const began = Date.now();
  for (;;) {
    if (exited !== null) {
      const said = fs.readFileSync(logFile(root), "utf8").trim();
      throw new ServerError(`the server exited (${exited}) before it was up${said === "" ? "" : `:\n${said}`}`);
    }
    const record = await serving(root);
    if (record !== null && record.pid === child.pid) {
      console.log(record.url);
      return;
    }
    if (Date.now() - began > START_PATIENCE) {
      throw new ServerError(`the server (pid ${child.pid}) has not answered after ${START_PATIENCE / 1000}s; its output is in ${logFile(root)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Daemon-style: not running, or where it is. The record is tried, never trusted — a server that
// was killed leaves one behind, and a stale one is found out here rather than tidied up there.
async function status(root) {
  const running = await serving(root);
  if (running === null) {
    console.log("not running");
    return NOT_RUNNING;
  }
  console.log(`running at ${running.url} (pid ${running.pid}, since ${running.since})`);
  return 0;
}

// What this instance is, which does not change while it runs: the static facts, for a person
// comparing two instances or checking one before starting it.
function configuration(root) {
  const config = readConfig(root);
  const rows = [
    ["instance", root],
    // What this instance is running, which is the first thing anybody comparing two of them
    // wants and the first thing to know before taking a newer one. It is read from the payload
    // rather than from openovai.json, so it says what the code here IS and not what it was installed
    // as.
    ["version", version(root) ?? "not recorded — this instance was made before the toolkit carried one"],
    ["user", config.user],
    ["leader", `${config.leader} (${config.models.leader})`],
    // The default, said so. Somebody can be hired onto a model of their own, so a row headed
    // "worker model" names what some of the workers here run on while reading as though it named
    // all of them.
    ["default worker model", config.models.worker],
    ["port", config.port === 0 ? "0 — a free one, chosen at each start" : config.port],
    describeAuth(config),
    ["credential", describeCredential(root, config.auth)],
    ["installed", config.createdAt],
    // Each desk with what it resolves to, which is where the truth about models is once any of
    // them can differ — and on an instance whose server is not running it is the only place it
    // can be read at all, because the room tool needs one.
    ["desks", desks(root).map((name) => `${name} (${modelFor(root, name, config)})`).join(", ") || "none"],
    // Where what this workspace knows is kept: one file per record, memory and knowledge side by
    // side. Sessions reach it through the recall and remember tools and never by path; it is named
    // here for the person, who may want to read the files.
    ["store", path.join(root, STORE_DIRECTORY)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));

  for (const [label, value] of rows) {
    console.log(`${label.padEnd(width)}  ${value}`);
  }
}

async function main(argv) {
  try {
    const { root, rest } = readRoot(argv);
    // Bare `ovai` is the help: the one thing every command line can be asked for.
    const command = rest[0] ?? "help";

    if (command === "--help" || command === "-h" || command === "help") {
      console.log(usage());
      return 0;
    }
    if (!COMMANDS.includes(command)) {
      throw new UsageError(`unknown command: ${command}`);
    }

    const arguments_ = rest.slice(1);
    const takes = TAKES[command];
    if (arguments_.length > (takes?.most ?? 0)) {
      throw new UsageError(`${command} takes ${takes?.shape ?? "no arguments"} (got ${arguments_.join(" ")})`);
    }

    if (command === "status") {
      return status(root);
    }
    if (command === "configuration") {
      configuration(root);
      return 0;
    }
    if (command === "start") {
      await startServer(root);
      return 0;
    }
    if (command === "stop") {
      await stopServer(root);
      return 0;
    }
    if (command === "restart") {
      await stopServer(root);
      await startServer(root);
      return 0;
    }
    if (command === "plugin") {
      pluginHere(root, arguments_[0]);
      return 0;
    }
    if (command === "update") {
      await update(root, arguments_);
      return 0;
    }
    return signIn(root);
  } catch (error) {
    if (error instanceof UsageError || error instanceof InstanceError) {
      console.error(`ovai: ${error.message}`);
      console.error("");
      console.error(usage());
      return 2;
    }
    // Nothing to do with the command line, so the usage under it would only be noise.
    if (error instanceof ServerError || error instanceof PluginError || error instanceof ReleaseError) {
      console.error(`ovai: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
