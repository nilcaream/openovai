#!/usr/bin/env node

// The instance's own command. bin/ovai works out which instance it belongs to and passes it in
// with --root, so nothing here has to guess where it is running.

import fs from "node:fs";
import path from "node:path";

import { panelDirectory } from "./chat/conversation.mjs";
import { listening } from "./chat/listening.mjs";
import { QUIET_HOURS, describePop, popIn, quietHoursProblem } from "./chat/pop.mjs";
import { parkRoom, settingsIn, stopping } from "./chat/lifecycle.mjs";
import { serve } from "./chat/server.mjs";
import { endEvery, runningSeats } from "./chat/session.mjs";
import { hasCredential, home, login, machineToken } from "./claude.mjs";
import { DeskError, desks, hire, modelFor } from "./desks.mjs";
import { instructionsAbove } from "./instructions.mjs";
import { holderOf } from "./port.mjs";
import { RELEASES, ReleaseError, latestRelease, replacePayload, unpackInto } from "./release.mjs";
import { describeRunning, runningHere } from "./running.mjs";
import { CONFIG_FILE, seedUserContent } from "./seed.mjs";
import { STORE_DIRECTORY } from "./store.mjs";
import { PluginError, describePluginName, describePlugins, isPluginName, pluginsIn, writePlugin } from "./plugins.mjs";
import { isOlderThan, version } from "./version.mjs";


const COMMANDS = ["status", "chat", "stop", "hire", "plugin", "login", "update"];

// What a command takes after its name, for the ones that take anything. A command that is not
// here takes nothing, which is most of them.
const TAKES = {
  hire: { most: 2, shape: "a name, and a model if not the usual one" },
  plugin: { most: 1, shape: "one name" },
  update: { most: 3, shape: "at most --from <url or directory> and --downgrade" },
};

// Saying an update may take a version older than the one the instance is on.
const DOWNGRADE = "--downgrade";

class UsageError extends Error {}

// The chat could not be reached, or answered a refusal. Nothing to do with the command line, so
// the usage under it would only be noise.
class ChatError extends Error {}

function usage() {
  return [
    "The command of an OpenOv AI instance.",
    "",
    "Usage:",
    "  ovai status        show who works in this instance and on which models",
    "  ovai chat          serve the chat page until you stop it",
    "  ovai stop          stop the chat serving this instance: it parks every session first",
    "  ovai hire <name> [model]",
    "                   open a desk for a worker, so the chat can host one; on the",
    "                   model this workspace runs its workers on unless another is named",
    "  ovai plugin <name> start a tool this instance serves itself, from the scaffold",
    "  ovai login         sign this instance in to an Anthropic account",
    "  ovai update        take the latest release, replacing what the toolkit ships",
    "                   [--from <url or directory>] where to look instead",
    "                   [--downgrade] take it even when it is older than this instance",
    "",
  ].join("\n");
}

function readRoot(argv) {
  const at = argv.indexOf("--root");
  if (at === -1 || argv[at + 1] === undefined) {
    throw new UsageError("--root is missing; run this instance's bin/ovai rather than the tool directly");
  }
  return { root: argv[at + 1], rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

// Where this instance keeps its description.
function configIn(root) {
  return path.join(root, CONFIG_FILE);
}

function readConfig(root) {
  const file = configIn(root);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new UsageError(`${file} is missing; this directory is not an instance`);
    }
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${file} is not readable as JSON: ${error.message}`);
  }
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

// Open a desk for a worker. Everything a person is made of is written here and nothing else
// happens: no session is started, and a chat already running picks the desk up on its own,
// because what the page shows is read from work/ rather than remembered.
//
// What a name is refused for lives in desks.mjs, because the page's Hire button reaches the same
// answer through a route rather than through this. All this adds is the one refusal that is about
// a command line rather than about a name: nothing typed at all.
//
// The model is optional and it is the second word, because leaving it out is the answer nearly
// every time: somebody hired without one runs on what this workspace runs its workers on. What a
// model is refused for lives in desks.mjs too, for the same reason a name's refusals do.
function hireHere(root, name, model) {
  if (name === undefined) {
    throw new UsageError("hire needs a name: ovai hire <name> [model]");
  }

  const written = hire(root, name, panelDirectory(root, name), model ?? null);

  console.log(`${name} works here now. Wrote:`);
  for (const entry of written) {
    console.log(`  ${entry}`);
  }
}

// Start a tool this instance serves itself. It writes one file and nothing else happens, which is
// the whole of what starting one is: there is no list to join, because the directory IS the list.
//
// The chat has to be started again, and that is said rather than left to be discovered. A tool is
// read when the chat starts, so a running chat goes on serving exactly what it was serving when it
// started — and a file that is plainly there, with nothing anywhere saying otherwise, is the thing
// somebody would sit and wonder about.
//
// Which is why the first line says when the tool is served rather than that it is served: it is
// the line somebody reads and believes, and a session asking for a tool that no chat has read yet
// is told there is no such tool. What is true at the moment it is printed is that the file exists
// and the next chat start serves it.
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

  console.log(`${name} is a tool this instance serves from the next chat start. Wrote:`);
  for (const entry of written) {
    console.log(`  ${entry}`);
  }
  console.log("Start the chat again to serve it: it reads these when it starts.");
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
// not got is seeded, once, the way the installer seeds it (tools/seed.mjs). So an updated instance
// is a clean install of the new version with the person's material in it, there is nothing here to
// migrate and no key that changes: the version is a file in the payload, so replacing the payload
// replaces it.
async function update(root, argv) {
  const { from, downgrade } = whereToLook(argv);

  // A running chat is serving code that is about to be replaced underneath it, and a process keeps
  // the code it started with. Stopping first is what the person would have to do anyway for the new
  // version to run; asking for it here also means no session is mid-turn while this happens, which
  // is a whole class of half-finished state that never has to be reasoned about.
  const url = listening(root);
  if (url !== null && (await isAnswering(url))) {
    throw new ChatError(
      `a chat is serving this instance at ${url} — stop it with ctrl-c and run this again, or it will go on running the version it started with`,
    );
  }

  // And the sessions themselves, asked of the machine, because a chat stopped is not every session
  // ended: a run that outlived a chat killed with -9, or a session started by hand with this
  // instance's home, holds its persona and its code in memory and would go on running the old
  // version under an instance that says the new one is installed. Each is named with the command
  // that ends it, since the chat that could have is not there.
  const running = runningHere(root);
  if (running.length > 0) {
    throw new ReleaseError(describeRunning(running));
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

  // Left where the chat will look. The Leader running in this instance was started under the old
  // arrangement and will go on telling everybody the old way until it is told otherwise, and it
  // cannot be told while nothing is running it.

  console.log("");
  console.log("Start the chat again to run it:");
  console.log(`  ${path.join(root, "bin", "ovai")} chat`);
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

// Whether anything is actually there. A recorded address outlives the process that wrote it, on
// purpose — a stale one is found out by trying rather than by tidying up on the way out.
async function isAnswering(url) {
  try {
    return (await fetch(`${url}/health`)).ok;
  } catch {
    return false;
  }
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

// Stop the chat serving this instance: SIGTERM to whatever holds its port, which parks the room
// and exits; then wait until nothing answers on the address any more.
async function stopChat(root) {
  const url = listening(root);
  if (url === null || !(await isAnswering(url))) {
    throw new ChatError("no chat is serving this instance");
  }
  const port = Number(new URL(url).port);
  const holder = holderOf(port);
  if (holder === null) {
    throw new ChatError(`a chat answers at ${url} but the process holding port ${port} could not be named — stop it by hand`);
  }
  console.log(`Stopping the chat at ${url} (pid ${holder.pid}).`);
  process.kill(holder.pid, "SIGTERM");
  const patience = (settingsIn(readConfig(root)).park.timeout + 15) * 1000;
  const began = Date.now();
  while (await isAnswering(url)) {
    if (Date.now() - began > patience) {
      throw new ChatError(`the chat at ${url} is still answering after ${patience / 1000}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log("Stopped.");
}

function status(root) {
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
    ["chat port", config.port === 0 ? "0 — chosen when the chat starts" : config.port],
    describeAuth(config),
    ["credential", describeCredential(root, config.auth)],
    ["installed", config.createdAt],
    // Each desk with what it resolves to, which is where the truth about models is once any of
    // them can differ — and on an instance whose chat is not running it is the only place it can
    // be read at all, because the room and the status tool both need one.
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

// The rest of "that port is taken". Naming the process turns a hunt into one `kill`, and the
// commonest thing on the port is a chat somebody forgot to stop — its command line says which
// instance it belongs to. When the machine cannot tell us, the advice alone still stands.
function byWhom(port) {
  const advice = "or install this instance with a different --port (0 takes a free one)";
  const holder = holderOf(port);

  if (holder === null) {
    return ` — stop whatever is on it, ${advice}`;
  }

  const named =
    holder.command === null ? `pid ${holder.pid}` : `pid ${holder.pid} (${holder.command})`;
  return ` by ${named} — stop it, ${advice}`;
}

// What the chat says about the instructions it is keeping out. One line, naming the files that
// are actually there: the list itself is two dozen paths and mostly hypothetical, and a person
// wondering why a session ignores the rules of the project this instance sits in needs to see
// that it is not reading them, not to read the whole sweep.
function describeInstructions(existing) {
  return existing.length === 0
    ? "This instance's instructions are its own; nothing above it holds any today."
    : `This instance's instructions are its own; not read: ${existing.join(", ")}`;
}

async function chat(root) {
  const config = readConfig(root);

  // Said before anything is served. The list itself is handed to each run as it is started
  // (tools/chat/session.mjs); what is printed here is which of the things on it exist today.
  console.log(describeInstructions(instructionsAbove(root).existing));

  // Read here rather than inside the server, and read once. Here because every line a person
  // sees when a chat starts is composed in this file — all but one: the server says, itself, that
  // it has armed its watch and how often the room is read, because that line is only true from
  // the scope that armed it; once
  // because a module is imported once per process, so a directory read again later would show a
  // new file while going on serving the old code of a changed one. A plugin is picked up when the
  // chat is started, which is already the act that replaces everything else the chat is running.
  // Before anything is served, because this is the field that decides whether somebody's night is
  // interrupted and there is no safe way to be half sure of it. A window nothing can read would
  // otherwise become "nothing is quiet" — silently, and only findable at three in the morning. It
  // is read once, like everything else here, so the fix costs the restart a person was going to
  // make anyway.
  const wrongWindow = quietHoursProblem(config[QUIET_HOURS]);
  if (wrongWindow !== null) {
    throw new UsageError(`${configIn(root)}: ${wrongWindow}`);
  }

  const plugins = await pluginsIn(root);

  // What was found, and what was meant to be found and could not be. Only when there is something
  // to say: an instance with no tools of its own is the ordinary case and a line saying so every
  // time would stop being read. A file that could not be served is named here and nowhere else —
  // it is absent from every list a session sees, which is exactly what it would look like if it
  // had never been written, so the terminal the chat was started in is the only place anybody
  // learns that it was.
  const aboutPlugins = describePlugins(plugins);
  if (aboutPlugins !== "") {
    console.log(aboutPlugins);
  }

  // How this instance makes a desktop pop, which is the instance's own file for the same reason a
  // plugin is: notify-send here, osascript there, a toast API somewhere else. Read once and beside
  // the plugins, and said in the same place and on the same terms — nothing at all when there is no
  // such file, which is most of them, and the reason named when there is one that cannot be used.
  const pop = await popIn(root);
  const aboutPop = describePop(pop);
  if (aboutPop !== "") {
    console.log(aboutPop);
  }

  const instance = { root, config, plugins: plugins.tools, pop: pop.pop, stopping: false };
  let server;
  try {
    server = await serve(instance);
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      throw new UsageError(`port ${config.port} is already taken${byWhom(config.port)}`);
    }
    throw error;
  }

  // Always the whole address, never "the port you installed with": with --port 0 nobody knows
  // it until now, and even with a fixed one this is the line somebody copies into a browser.
  const { port } = server.address();
  console.log(`${config.leader} is listening on http://127.0.0.1:${port}`);
  console.log("Stop it with ctrl-c.");

  // Whatever stops the chat, the sessions it started are its own to end. A ctrl-c is sent to
  // every process in the terminal's group and so reaches them anyway, but a kill and a closed
  // window are sent to this process alone, and a session does not notice a parent that has gone:
  // it stays there holding a model open. Ending them here means the chat has one way out and not
  // one per way of being stopped.
  //
  // Nothing is left to catch a SIGKILL on this process, where no handler of ours runs at all.
  // That case is the reason a stopped chat is stopped with ctrl-c and not with kill -9.
  //
  // In this order, because the park is a conversation over this very server: (1) the instance is
  // marked stopping, so the page is told to wait and nobody is hired, while the MCP route keeps
  // answering; (2) the room is parked, the Leader included — every session is interrupted, told,
  // and given the stop timeout to write its desk and stop itself; (3) only then is the server
  // closed; (4) whoever is left is ended; (5) exit. A server closed first would refuse the very
  // write_desk and stop_session calls the park waits for.
  const stop = async () => {
    stopping(instance);
    const going = runningSeats().length;
    if (going > 0) {
      console.log(`Parking ${going} ${going === 1 ? "session" : "sessions"}.`);
      const parked = await parkRoom(instance, { interrupt: true, deadline: settingsIn(config).park.timeout, leaderToo: true });
      console.log(parked.text ?? parked.refused);
    }
    server.close();
    await endEvery();
    // Stopping a server that was asked to stop is what it was told to do, not a failure.
    process.exit(0);
  };

  // Once, not on: a second ctrl-c from somebody who thinks it has hung would otherwise start the
  // whole thing again underneath the first one.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, stop);
  }
}

async function main(argv) {
  try {
    const { root, rest } = readRoot(argv);
    const command = rest[0] ?? "status";

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

    if (command === "chat") {
      await chat(root);
      return 0;
    }
    if (command === "stop") {
      await stopChat(root);
      return 0;
    }
    if (command === "hire") {
      hireHere(root, arguments_[0], arguments_[1]);
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
    if (command === "login") {
      return signIn(root);
    }

    status(root);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`ovai: ${error.message}`);
      console.error("");
      console.error(usage());
      return 2;
    }
    // Nothing to do with the command line, so the usage under it would only be noise.
    if (
      error instanceof DeskError ||
      error instanceof ChatError ||
      error instanceof PluginError ||
      error instanceof ReleaseError
    ) {
      console.error(`ovai: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
