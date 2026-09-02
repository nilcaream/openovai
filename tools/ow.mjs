#!/usr/bin/env node

// The instance's own command. bin/ow works out which instance it belongs to and passes it in
// with --root, so nothing here has to guess where it is running.

import fs from "node:fs";
import path from "node:path";

import { panelDirectory } from "./chat/conversation.mjs";
import { listening } from "./chat/listening.mjs";
import { serve } from "./chat/server.mjs";
import { NAME_IN_ENVIRONMENT, endEveryRun, runsGoing } from "./chat/session.mjs";
import { hasCredential, home, login, machineToken, memoryDirectory } from "./claude.mjs";
import { DeskError, describeName, desks, hire, isName } from "./desks.mjs";
import { ownInstructions } from "./instructions.mjs";
import { leaveWord } from "./chat/untold.mjs";
import { holderOf } from "./port.mjs";
import { RELEASES, ReleaseError, latestRelease, notesIn, replacePayload, unpackInto } from "./release.mjs";
import { version } from "./version.mjs";

const CONFIG_FILE = "ow.json";

const COMMANDS = ["status", "room", "chat", "hire", "say", "login", "update"];

// What a command takes after its name, for the ones that take anything. A command that is not
// here takes nothing, which is most of them.
const TAKES = {
  hire: { most: 1, shape: "one name" },
  say: { most: Number.POSITIVE_INFINITY, shape: "a name and a message" },
  update: { most: 2, shape: "at most --from <url or directory>" },
};

class UsageError extends Error {}

// The chat could not be reached, or answered a refusal. Nothing to do with the command line, so
// the usage under it would only be noise.
class ChatError extends Error {}

function usage() {
  return [
    "The command of an office workspace instance.",
    "",
    "Usage:",
    "  ow status        show who works in this instance and on which models",
    "  ow room          show what each of them is doing right now",
    "  ow chat          serve the chat page until you stop it",
    "  ow hire <name>   open a desk for a worker, so the chat can host one",
    "  ow say <name> <message>",
    "                   say something to another session in this instance and wait for its reply",
    "  ow login         sign this instance in to an Anthropic account",
    "  ow update        take the latest release, replacing what the toolkit ships",
    "                   [--from <url or directory>] where to look instead",
    "",
  ].join("\n");
}

function readRoot(argv) {
  const at = argv.indexOf("--root");
  if (at === -1 || argv[at + 1] === undefined) {
    throw new UsageError("--root is missing; run this instance's bin/ow rather than the tool directly");
  }
  return { root: argv[at + 1], rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

function readConfig(root) {
  const file = path.join(root, CONFIG_FILE);
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
  // instance that inherits to run `ow login` would send it to a command that refuses.
  return auth === "inherit"
    ? "none — CLAUDE_CODE_OAUTH_TOKEN is not set in the environment this ran in"
    : "none — run: ow login";
}

// Open a desk for a worker. Everything a person is made of is written here and nothing else
// happens: no session is started, and a chat already running picks the desk up on its own,
// because what the page shows is read from work/ rather than remembered.
//
// What a name is refused for lives in desks.mjs, because the page's Hire button reaches the same
// answer through a route rather than through this. All this adds is the one refusal that is about
// a command line rather than about a name: nothing typed at all.
function hireHere(root, name) {
  if (name === undefined) {
    throw new UsageError("hire needs a name: ow hire <name>");
  }

  const written = hire(root, name, panelDirectory(root, name), readConfig(root));

  console.log(`${name} works here now. Wrote:`);
  for (const entry of written) {
    console.log(`  ${entry}`);
  }
}

// The room: one line per session, saying what is true of each of them right now.
//
// It asks the chat rather than reading the instance, because half of what a room is cannot be
// read off disk. How many turns are going, who is held up waiting for whom and what is stopped
// waiting to be allowed something all live in the process serving the page; only what a session
// is called, what it is on and how big its thread is are in files. So there is no room to show
// when no chat is running, and saying so is the honest answer.
//
// The same rows the page builds its own room from, on the same route. What each of them means is
// settled in one place — the server — and this only lays them out.
async function room(root) {
  const url = listening(root);
  if (url === null) {
    throw new ChatError("no chat is running in this instance, so there is no room to show — start one with: ow chat");
  }

  let answered;
  try {
    answered = await fetch(`${url}/sessions`);
  } catch (error) {
    throw new ChatError(`the chat at ${url} did not answer (${error.cause?.code ?? error.message}) — start one with: ow chat`);
  }

  let body;
  try {
    body = await answered.json();
  } catch {
    body = null;
  }

  if (!answered.ok || !Array.isArray(body?.sessions)) {
    throw new ChatError(`the chat answered ${answered.status} with nothing that reads as a room`);
  }

  const width = Math.max(...body.sessions.map((session) => session.name.length));
  for (const session of body.sessions) {
    console.log(`${session.name.padEnd(width)}  ${describeSession(session)}`);
  }
}

// What one line of the room says. The order the phrases are tried in is the whole of what makes it
// worth reading: what a person can end comes before what they cannot.
//
// The page lays the same rows out for itself, in its own script, and the two say the same things
// in the same order. They are not shared code and cannot be — one of them is a page served as
// text — so this is a duplication somebody has to keep true, and it is written down here rather
// than discovered.
function describeSession(session) {
  const doing = session.doing === "" ? "(has not said what it is on)" : session.doing;
  const said = [
    stateOf(session),
    session.thread ? null : "nothing to carry on",
    typeof session.context === "number" ? `${session.context.toLocaleString("en-US")} tokens` : null,
    session.active === null ? "nothing said yet" : `last moved ${ago(session.active)}`,
  ].filter((part) => part !== null);

  return `${session.role} (${session.model})  ${doing}  —  ${said.join(" · ")}`;
}

function stateOf(session) {
  if (session.asking > 0) {
    return session.asking === 1 ? "needs you" : `needs you (${session.asking})`;
  }
  if (session.waitingFor !== null && session.waitingFor !== undefined) {
    return `waiting for ${session.waitingFor}`;
  }
  if (session.queued > 0) {
    return `answering, ${session.queued} waiting`;
  }
  return session.busy ? "answering" : "idle";
}

// How long ago, in the roughest terms that are still useful. Nothing anybody decides from a room
// turns on the difference between four minutes and five.
function ago(when) {
  const seconds = Math.round((Date.now() - Date.parse(when)) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  return `${Math.floor(seconds / 3600)}h ago`;
}

// Say something to another session and wait for what it answers.
//
// It goes through the chat rather than starting a session here: a session belongs to the chat
// serving this instance, which is what keeps its transcript and its thread in one place no matter
// who spoke to it. So this is a message posted to the same route the page posts to, and the panel
// shows the exchange as it would any other.
//
// The reply is waited for. The caller is a session itself, mid-turn, and it asked because it
// wants the answer — which costs it the whole of the other session's turn, and is the trade to
// revisit when a session waiting is actually in the way.
//
// The message is signed with the name of the session running the command, which the chat put in
// its environment when it started it. Run from a terminal there is no name and nothing is signed,
// which is correct: the person at the keyboard is the human, and that is who it arrives as.
async function say(root, name, words) {
  if (name === undefined) {
    throw new UsageError("say needs somebody to say it to: ow say <name> <message>");
  }
  if (!isName(name)) {
    throw new UsageError(describeName("a name", name));
  }

  const text = words.join(" ").trim();
  if (text === "") {
    throw new UsageError(`say needs something to say: ow say ${name} <message>`);
  }

  const url = listening(root);
  if (url === null) {
    throw new ChatError("no chat is running in this instance — start one with: ow chat");
  }

  const from = process.env[NAME_IN_ENVIRONMENT];

  let answered;
  try {
    answered = await fetch(`${url}/sessions/${encodeURIComponent(name)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...(from === undefined || from === "" ? {} : { from }) }),
    });
  } catch (error) {
    // The address was written down by a chat that has since been stopped, or one that is no
    // longer answering. Say where we tried, so the next question is about that process.
    throw new ChatError(`the chat at ${url} did not answer (${error.cause?.code ?? error.message}) — start one with: ow chat`);
  }

  let body;
  try {
    body = await answered.json();
  } catch {
    body = null;
  }

  if (!answered.ok) {
    throw new ChatError(body?.error ?? `the chat answered ${answered.status}`);
  }

  // The reply is what the caller asked for, so anything that is not one is said out loud rather
  // than printed as an answer. A session reading "undefined" off its own tool has no way to tell
  // that apart from a colleague who said it.
  const reply = body?.reply?.text;
  if (typeof reply !== "string") {
    throw new ChatError(`the chat answered ${answered.status} with nothing that reads as a reply`);
  }

  console.log(reply);
}

// Where the package is opened before any of it is put in place. Inside the instance rather than
// somewhere shared: an instance is self-contained, and an update that falls over half way leaves
// what it was working on where somebody would look for it rather than in a directory nobody owns.
const UNPACKING = ".release";

// Taking a newer version of the toolkit.
//
// Only what the toolkit ships is replaced. Everything an instance accumulated — the desks, the
// personas, the settings, its Claude Code home with its account and its transcripts and what the
// workspace has learned, the panels and the threads they resume — is in different directories and
// is not touched, and its own description of itself is not rewritten at all. So there is nothing
// here to migrate and no key that changes: the version is a file in the payload, so replacing the
// payload replaces it.
async function update(root, argv) {
  const from = whereToLook(argv);

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

  const here = version(root);
  const release = await latestRelease(from);

  if (release.version === here) {
    console.log(`This instance is on ${here}, which is the latest release. Nothing to do.`);
    return;
  }

  const opened = path.join(root, UNPACKING);
  let replaced;
  let notes;
  try {
    fs.rmSync(opened, { recursive: true, force: true });
    const tree = release.unpacked ? release.package : await unpackInto(release.package, opened);
    // What was downloaded is asked whether it is a workspace before any of it is put in place,
    // inside replacePayload, so an instance is never half replaced by something that turned out to
    // be something else.
    notes = notesIn(tree);
    replaced = replacePayload(root, tree);
  } finally {
    fs.rmSync(opened, { recursive: true, force: true });
  }

  const now = version(root);
  console.log(`Was on ${here ?? "no recorded version"}, now on ${now}. Replaced:`);
  for (const entry of replaced) {
    console.log(`  ${entry}`);
  }

  // Left where the chat will look. The lead running in this instance was started under the old
  // arrangement and will go on telling everybody the old way until it is told otherwise, and it
  // cannot be told while nothing is running it.
  leaveWord(root, { from: here, to: now, notes });

  console.log("");
  console.log("Start the chat again to run it:");
  console.log(`  ${path.join(root, "bin", "ow")} chat`);
}

// Where to look for a release: what was asked for, or the toolkit's own.
//
// Anything that is not exactly the one option is refused rather than ignored. A command that takes
// a default quietly does the default thing when it is mistyped, and updating an instance from
// somewhere other than the place that was meant is not a mistake to make quietly.
function whereToLook(argv) {
  if (argv.length === 0) {
    return RELEASES;
  }

  if (argv[0] !== "--from" || argv.length !== 2 || argv[1] === "") {
    throw new UsageError(`update takes at most --from <url or directory> (got ${argv.join(" ")})`);
  }

  return argv[1];
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

function status(root) {
  const config = readConfig(root);
  const rows = [
    ["instance", root],
    // What this instance is running, which is the first thing anybody comparing two of them
    // wants and the first thing to know before taking a newer one. It is read from the payload
    // rather than from ow.json, so it says what the code here IS and not what it was installed
    // as.
    ["version", version(root) ?? "not recorded — this instance was made before the toolkit carried one"],
    ["human", config.human],
    ["leader", `${config.leader} (${config.models.leader})`],
    ["worker model", config.models.worker],
    ["chat port", config.port === 0 ? "0 — chosen when the chat starts" : config.port],
    describeAuth(config),
    ["credential", describeCredential(root, config.auth)],
    ["installed", config.createdAt],
    ["desks", desks(root).join(", ") || "none"],
    // Where what this workspace has learned is kept. Every session reads it before it is asked
    // anything and writes into it when a thread ends, and it is the one part of an instance a
    // person would otherwise have no way of finding: it sits inside the Claude Code home, which is
    // there to be left alone. Named here rather than shown, because it is a directory of files for
    // whoever wants to read them.
    ["memory", memoryDirectory(root)],
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

  // Before anything is served, and again every time the chat starts rather than once when the
  // instance was made: the list is absolute paths worked out from where the instance sits now,
  // so an instance that was moved would otherwise carry the list for where it used to be.
  console.log(describeInstructions(ownInstructions(root).existing));

  let server;
  try {
    server = await serve({ root, config });
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
  const stop = async () => {
    server.close();
    const going = runsGoing();
    if (going > 0) {
      console.log(`Ending ${going} ${going === 1 ? "session" : "sessions"}.`);
    }
    await endEveryRun();
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
    if (command === "hire") {
      hireHere(root, arguments_[0]);
      return 0;
    }
    if (command === "room") {
      await room(root);
      return 0;
    }
    if (command === "say") {
      await say(root, arguments_[0], arguments_.slice(1));
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
      console.error(`ow: ${error.message}`);
      console.error("");
      console.error(usage());
      return 2;
    }
    // Nothing to do with the command line, so the usage under it would only be noise.
    if (error instanceof DeskError || error instanceof ChatError || error instanceof ReleaseError) {
      console.error(`ow: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
