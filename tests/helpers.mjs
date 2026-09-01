// Shared by the test suites: where the repository is, how to install an instance, how to talk
// to a chat server, and the stand-in for Claude Code.
//
// The stand-in matters most. A test that really ran Claude Code would need a subscription,
// would cost money, and would answer differently every time. This one records how it was
// called and answers in the shape measured from the real binary, which is what lets the tests
// check the parts that are ours: the arguments, the environment, the question, and what we do
// with the answer.
//
// It speaks the streaming protocol, because that is what a session is run with: it takes its
// question as a frame on stdin, answers with a result frame on stdout, and — as the real one
// does — waits afterwards rather than exiting, until whoever asked closes stdin. A caller that
// never does is named in the log instead of hanging the suite until somebody kills it.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Scratch lives inside the repository, where .gitignore already covers it, so a failed run
// leaves its evidence somewhere obvious instead of somewhere shared.
export function scratch(name) {
  return path.join(repo, ".tmp", `${name}-${process.pid}`);
}

export function remove(...targets) {
  for (const target of targets) {
    if (target !== undefined && target !== "") {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}

// An option map becomes a command line. A key with no value is left out, which is how a suite
// asks what happens when an option is missing; `true` is a switch such as --force.
export function optionsToArguments(options) {
  const argv = [];
  for (const [flag, value] of Object.entries(options)) {
    if (value === undefined) {
      continue;
    }
    argv.push(flag);
    if (value !== true) {
      argv.push(String(value));
    }
  }
  return argv;
}

// Install an instance. Returns the finished process, so a suite can ask for the exit status as
// easily as for the output. The environment is optional and is only worth passing when the
// check is about something the installer reads out of it, such as which node is on the PATH.
export function install(options, environment) {
  return spawnSync(path.join(repo, "install.sh"), optionsToArguments(options), {
    encoding: "utf8",
    ...(environment === undefined ? {} : { env: environment }),
  });
}

export function installed(options, environment) {
  const done = install(options, environment);
  if (done.status !== 0) {
    throw new Error(`installing failed: ${done.stderr || done.stdout}`);
  }
  return done;
}

// Whether the real Claude Code is on the PATH. Only needed to run an instance, never to make
// one, so the few checks that start a session say they were skipped instead of failing.
export function claudeIsInstalled() {
  return spawnSync("claude", ["--version"], { encoding: "utf8" }).error === undefined;
}

// The stand-in, written into a directory that goes first on the PATH.
//
// It reads its behaviour from the environment, so one stand-in serves every suite:
//   OW_STAND_IN_LOG           file to record each call in (required)
//   OW_STAND_IN_REPLY         what an answer says            (default: a reply)
//   OW_STAND_IN_SESSION       the thread id it returns       (default: test-thread)
//   OW_STAND_IN_RESUME_FAILS  refuse to resume a thread      (default: no)
//   OW_STAND_IN_SLOW          milliseconds to take answering (default: none)
//   OW_STAND_IN_NOISE         emit what the real one says beside an answer — a keep-alive, a
//                             system notice, an assistant turn, and a line that is not a frame
//   OW_STAND_IN_BROKEN        fall over in prose on stdout, framing nothing at all
//   OW_STAND_IN_ASKS          ask to be allowed to use this tool, wait for the answer, and make
//                             what it was told the reply
//   OW_STAND_IN_WAITS         milliseconds to wait for that answer before giving up on it
//                             (default: 5000) — the real one waits for good, and a suite cannot
//   OW_STAND_IN_CALLS         "Speaker>Addressee,…" — while answering, that speaker says
//                             something to that addressee with the instance's own command, which
//                             is how a check builds a session that talks back mid-turn
//   OW_STAND_IN_SIGNED_IN     what `auth status` reports     (default: true)
//   OW_STAND_IN_LOGIN_STATUS  what `auth login` exits with   (default: 0)
// It is plain ESM, like everything else here. A command on the PATH is named the way it is
// typed, so this file has no extension and Node cannot tell from the name what it is written
// in; from 24 it works that out from the syntax instead. The one thing that would take the
// choice away again is package.json declaring "type": "commonjs" — measured on 24.20.0, that
// makes an extensionless module do nothing at all and exit 0, so the field is left out.
const STAND_IN = `#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
const called = argv.join(" ");
const value = (name) => process.env[name] || "<unset>";
const log = process.env.OW_STAND_IN_LOG;

fs.appendFileSync(
  log,
  [
    \`argv: \${called}\`,
    \`cwd: \${process.cwd()}\`,
    \`CLAUDE_CONFIG_DIR: \${value("CLAUDE_CONFIG_DIR")}\`,
    \`ANTHROPIC_API_KEY: \${value("ANTHROPIC_API_KEY")}\`,
    \`CLAUDE_CODE_OAUTH_TOKEN: \${value("CLAUDE_CODE_OAUTH_TOKEN")}\`,
    \`OW_SESSION_NAME: \${value("OW_SESSION_NAME")}\`,
    "",
  ].join("\\n"),
);

if (called === "auth status") {
  const signedIn = process.env.OW_STAND_IN_SIGNED_IN ?? "true";
  process.stdout.write(\`{"loggedIn":\${signedIn},"authMethod":"claude.ai"}\\n\`);
  process.exit(signedIn === "true" ? 0 : 1);
}

if (called === "auth login") {
  process.stdout.write("(the real one opens a browser here)\\n");
  process.exit(Number(process.env.OW_STAND_IN_LOGIN_STATUS ?? 0));
}

// Falling over before anything could be framed: whatever it has to say, it says in prose and it
// says it on stdout, which is the one place a reader of frames would otherwise throw away.
if ((process.env.OW_STAND_IN_BROKEN ?? "") !== "") {
  process.stdout.write("a model was never reached\\n");
  process.exit(1);
}

// One frame per line, the way the real one answers.
const frame = (fields) => process.stdout.write(JSON.stringify(fields) + "\\n");

if (called.includes("--resume") && (process.env.OW_STAND_IN_RESUME_FAILS ?? "") !== "") {
  frame({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    session_id: null,
    result: "No conversation found",
  });
  process.exit(1);
}

// The question arrives on stdin now, as a user frame, and not in the arguments. Reading it is
// what says the run began — the argument line is written before there is anything to answer.
//
// Read with a listener rather than with for-await: leaving a for-await early closes the stream it
// was reading, and this one has to stay open afterwards to see whether the caller ever ends it.
process.stdin.setEncoding("utf8");

let rest = "";
let heard = null;
let answered = null;
const question = new Promise((resolve) => {
  heard = resolve;
});
const ended = new Promise((resolve) => process.stdin.on("end", resolve));

process.stdin.on("data", (chunk) => {
  rest += chunk;
  let at = rest.indexOf("\\n");
  while (at !== -1) {
    const line = rest.slice(0, at);
    rest = rest.slice(at + 1);
    at = rest.indexOf("\\n");
    if (line.trim() === "") {
      continue;
    }
    const said = JSON.parse(line);
    if (said.type === "user" && heard !== null) {
      heard(said.message.content);
      heard = null;
      continue;
    }
    if (answered !== null) {
      answered(said);
    }
  }
});

const asked = await question;
fs.appendFileSync(log, \`heard: \${asked}\\n\`);

// Said from inside this turn, with the instance's own command, from the directory a session is
// started in. A timeout, because the thing being checked is sometimes whether this returns at all.
const me = process.env.OW_SESSION_NAME ?? "";
for (const pair of (process.env.OW_STAND_IN_CALLS ?? "").split(",").filter(Boolean)) {
  const [speaker, addressee] = pair.split(">");
  if (speaker !== me) {
    continue;
  }
  const said = spawnSync("./bin/ow", ["say", addressee, \`a word from \${me}\`], { encoding: "utf8", timeout: 5000 });
  fs.appendFileSync(
    log,
    \`said by \${me} to \${addressee}: status=\${said.status} out=\${JSON.stringify((said.stdout ?? "").trim())} err=\${JSON.stringify((said.stderr ?? "").trim())}\\n\`,
  );
}

// What the real one says beside an answer: a keep-alive while a long turn runs, a system notice,
// and — because stdout is a stream and not only frames — the odd line that is not JSON at all.
if ((process.env.OW_STAND_IN_NOISE ?? "") !== "") {
  frame({ type: "keep_alive" });
  frame({ type: "system", subtype: "init", session_id: "test-thread" });
  process.stdout.write("this line is not a frame at all\\n");
  frame({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "thinking" }] } });
}

// Asking to be allowed to use a tool, the way a run does when the instance has not already
// settled it: a control_request on stdout, then nothing at all until an answer comes back on
// stdin. What the answer was becomes the reply, so a check can read the decision in the transcript
// rather than only in the log.
let decided = null;
if ((process.env.OW_STAND_IN_ASKS ?? "") !== "") {
  const id = "request-1";
  frame({
    type: "control_request",
    request_id: id,
    request: {
      subtype: "can_use_tool",
      tool_name: process.env.OW_STAND_IN_ASKS,
      input: { command: "the one it wanted to run" },
      tool_use_id: "use-1",
    },
  });

  // Nothing times out on this path in the real one, and that is the point of it. Here it must,
  // because a suite that hangs says nothing about what broke: an answer that never arrives, or one
  // that comes back with the wrong id on it, has to read as a failed check and not as a stuck run.
  decided = await Promise.race([
    new Promise((resolve) => {
      answered = (said) => {
        if (said.type === "control_response" && said.response?.request_id === id) {
          resolve(said.response.response);
        }
      };
    }),
    new Promise((resolve) => {
      setTimeout(
        () => resolve({ behavior: "never told", message: "no answer came back for " + id }),
        Number(process.env.OW_STAND_IN_WAITS ?? 5000),
      );
    }),
  ]);
  fs.appendFileSync(log, \`told: \${JSON.stringify(decided)}\\n\`);
}

const slow = Number(process.env.OW_STAND_IN_SLOW ?? 0);
if (slow > 0) {
  await new Promise((resolve) => setTimeout(resolve, slow));
  fs.appendFileSync(log, \`answered: \${asked}\\n\`);
}

frame({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  session_id: process.env.OW_STAND_IN_SESSION ?? "test-thread",
  result:
    decided === null
      ? (process.env.OW_STAND_IN_REPLY ?? "a reply")
      : \`I was told \${decided.behavior}\${decided.message === undefined ? "" : \`: \${decided.message}\`}\`,
});

// The real one would now wait for another question: a result is not what ends it. Whoever asked
// has to close stdin, and a run that is left holding it open is a bug worth naming rather than a
// test that hangs until somebody kills it.
await Promise.race([
  ended,
  new Promise((resolve) => {
    setTimeout(() => {
      fs.appendFileSync(log, \`stdin was never closed: \${asked}\\n\`);
      resolve();
    }, 5000);
  }),
]);
process.exit(0);
`;

// A stand-in for node itself, so a check can ask what the installer does about a Node this
// machine has not got. It answers the version question with whatever it was told to say and
// hands everything else to the real one, whose path is written into the shebang — a plain
// `node` shebang would find this file again and call itself forever.
export function writeNodeStandIn(directory, version) {
  fs.mkdirSync(directory, { recursive: true });
  const command = path.join(directory, "node");
  fs.writeFileSync(
    command,
    `#!${process.execPath}

import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);

if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write("${version}\\n");
  process.exit(0);
}

process.exit(spawnSync(process.execPath, argv, { stdio: "inherit" }).status ?? 1);
`,
    { mode: 0o755 },
  );
  return command;
}

export function writeStandIn(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const command = path.join(directory, "claude");
  fs.writeFileSync(command, STAND_IN, { mode: 0o755 });
  return command;
}

// The environment an instance's command or chat runs in for a test: the stand-in first on the
// PATH, and the log it records its calls in.
export function standInEnvironment(directory, log, extra = {}) {
  return {
    ...process.env,
    OW_STAND_IN_LOG: log,
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    ...extra,
  };
}

export function readLog(log) {
  try {
    return fs.readFileSync(log, "utf8");
  } catch {
    return "";
  }
}

// The lines the stand-in recorded as the arguments it was called with, newest last.
export function callsIn(log) {
  return readLog(log)
    .split("\n")
    .filter((line) => line.startsWith("argv: "));
}

// The questions the stand-in was asked, newest last. The question is a frame on stdin rather than
// an argument, so what a session was actually asked is read from here and not from callsIn.
export function heardIn(log) {
  return readLog(log)
    .split("\n")
    .filter((line) => line.startsWith("heard: "));
}

// Start a chat server as a child, keeping whatever it prints. The output is where the address
// comes from when the instance was installed with --port 0, which is the only way to learn it.
export function startChat(root, environment) {
  const child = spawn("node", [path.join(root, "tools", "ow.mjs"), "--root", root, "chat"], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      child.output += chunk;
    });
  }
  return child;
}

export async function stopChat(child) {
  if (child === undefined || child.exitCode !== null || child.killed) {
    return;
  }
  const ended = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await ended;
}

// Run an instance's command and wait for it, whatever it exits with.
export function runOw(root, argv, environment) {
  return spawnSync(path.join(root, "bin", "ow"), argv, { env: environment, encoding: "utf8" });
}

// Run the tool directly rather than through bin/ow, for the cases where the launcher's own
// refusal — no Claude Code on the PATH — would stop a test that is about something else.
export function runTool(root, argv, environment) {
  return spawnSync("node", [path.join(root, "tools", "ow.mjs"), "--root", root, ...argv], {
    env: environment,
    encoding: "utf8",
  });
}

// The same, without holding this process while it runs. A check whose instance is talking to
// something served from here has to use this one: spawnSync blocks the event loop, so the server
// cannot answer the child, the child cannot exit, and the two wait for each other forever.
export function runToolLater(root, argv, environment) {
  const child = spawn("node", [path.join(root, "tools", "ow.mjs"), "--root", root, ...argv], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

const PATIENCE = 50;
const BREATH = 100;

// Wait for something to become true, answering with whatever it produced. Returns null when it
// never did, so a caller can say what was being waited for.
export async function waitFor(attempt) {
  for (let tries = 0; tries < PATIENCE; tries += 1) {
    const found = await attempt();
    if (found !== null && found !== undefined && found !== false) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, BREATH));
  }
  return null;
}

export async function get(url) {
  const answered = await fetch(url);
  return { status: answered.status, body: await answered.text() };
}

export async function post(url, body) {
  const answered = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: answered.status, body: await answered.text() };
}

export async function waitForHealth(url) {
  return waitFor(async () => {
    try {
      const answered = await get(`${url}/health`);
      return answered.status === 200 ? answered : null;
    } catch {
      return null;
    }
  });
}

// The address a chat printed for itself.
export async function waitForAddress(child) {
  return waitFor(() => /http:\/\/127\.0\.0\.1:\d+/.exec(child.output)?.[0] ?? null);
}
