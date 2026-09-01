// Shared by the test suites: where the repository is, how to install an instance, how to talk
// to a chat server, and the stand-in for Claude Code.
//
// The stand-in matters most. A test that really ran Claude Code would need a subscription,
// would cost money, and would answer differently every time. This one records how it was
// called and answers in the shape measured from the real binary, which is what lets the tests
// check the parts that are ours: the arguments, the environment, and what we do with the
// answer.

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
//   OW_STAND_IN_SIGNED_IN     what `auth status` reports     (default: true)
//   OW_STAND_IN_LOGIN_STATUS  what `auth login` exits with   (default: 0)
// It is plain ESM, like everything else here. A command on the PATH is named the way it is
// typed, so this file has no extension and Node cannot tell from the name what it is written
// in; from 24 it works that out from the syntax instead. The one thing that would take the
// choice away again is package.json declaring "type": "commonjs" — measured on 24.20.0, that
// makes an extensionless module do nothing at all and exit 0, so the field is left out.
const STAND_IN = `#!/usr/bin/env node

import fs from "node:fs";

const argv = process.argv.slice(2);
const called = argv.join(" ");
const value = (name) => process.env[name] || "<unset>";

fs.appendFileSync(
  process.env.OW_STAND_IN_LOG,
  [
    \`argv: \${called}\`,
    \`cwd: \${process.cwd()}\`,
    \`CLAUDE_CONFIG_DIR: \${value("CLAUDE_CONFIG_DIR")}\`,
    \`ANTHROPIC_API_KEY: \${value("ANTHROPIC_API_KEY")}\`,
    \`CLAUDE_CODE_OAUTH_TOKEN: \${value("CLAUDE_CODE_OAUTH_TOKEN")}\`,
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

if (called.includes("--resume") && (process.env.OW_STAND_IN_RESUME_FAILS ?? "") !== "") {
  process.stdout.write('{"type":"result","is_error":true,"session_id":null,"result":"No conversation found"}\\n');
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({
    type: "result",
    is_error: false,
    session_id: process.env.OW_STAND_IN_SESSION ?? "test-thread",
    result: process.env.OW_STAND_IN_REPLY ?? "a reply",
  }) + "\\n",
);
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
