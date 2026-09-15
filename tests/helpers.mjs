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
import http from "node:http";
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
// It speaks the streaming protocol the way a session is run: one process, started once, reading
// user frames from stdin one after another and answering each with a result frame, until stdin
// is closed. It reads its behaviour from the environment, so one stand-in serves every suite:
//   OPENOVAI_STAND_IN_LOG           file to record each call in (required)
//   OPENOVAI_STAND_IN_REPLY         what an answer says            (default: a reply)
//   OPENOVAI_STAND_IN_SLOW          milliseconds to take answering each turn (default: none)
//   OPENOVAI_STAND_IN_NOISE         emit what the real one says beside an answer — a keep-alive, a
//                             system notice, an assistant turn, and a line that is not a frame
//   OPENOVAI_STAND_IN_BROKEN        fall over before framing anything, saying why on stderr
//   OPENOVAI_STAND_IN_EMPTY         answer every turn with an empty result
//   OPENOVAI_STAND_IN_DIES          exit without a result frame in the middle of the first turn it
//                             is asked — a run that ended mid-turn
//   OPENOVAI_STAND_IN_STUCK         ignore stdin being closed and never exit on its own
//   OPENOVAI_STAND_IN_ASKS          ask to be allowed to use this tool before answering each turn,
//                             wait for the answer, and make the answer say what was decided
//   OPENOVAI_STAND_IN_ASKS_INPUT    the argument that tool would be given
//   OPENOVAI_STAND_IN_ASKS_FILE     the same, for the other shape a request takes: a tool that
//                             names a path rather than a command
//   OPENOVAI_STAND_IN_WAITS         milliseconds to wait for that answer before giving up on it
//                             (default: 5000)
//   OPENOVAI_STAND_IN_LIFETIME      milliseconds after which it exits on its own whatever is
//                             going on (default: 60000) — so a run a suite forgot to end cannot
//                             hold the suite's output open
//   OPENOVAI_STAND_IN_SIGNED_IN     what `auth status` reports     (default: true)
//   OPENOVAI_STAND_IN_LOGIN_STATUS  what `auth login` exits with   (default: 0)
//   OPENOVAI_STAND_IN_RATE_LIMIT    a JSON list, one entry per QUESTION — a user or message frame; a
//                             server event is a turn but consumes no entry — the rate_limit_info
//                             (or a list of them) to emit as rate_limit_event frames when that
//                             question is heard, before it is answered — the shape measured on
//                             the real one
//   OPENOVAI_STAND_IN_USAGE         a JSON usage object put on every result, or a list of them, one
//                             per question the same way (a server event's result carries none)
//   OPENOVAI_STAND_IN_TOOL          a JSON list of { name, arguments } to call over the MCP address
//                             in its own --mcp-config, in order, before answering a turn; each
//                             answer is logged as `tool: <name> -> <text>`
//   OPENOVAI_STAND_IN_TOOL_ON       only turns whose question contains this text make those calls
//                             (default: every turn)
//   OPENOVAI_STAND_IN_CALLS         a JSON list, one entry per QUESTION the same way, each a list of
//                             { name, input, error?, parent? }: the tools the real one would say
//                             it is using in that turn, each written before the answer as one
//                             assistant frame with a tool_use block (id call-<turn>-<i>,
//                             parent_tool_use_id from parent, else null) and one user frame
//                             with its tool_result (is_error from error; error given as a
//                             string is the words the failed result says) — the shapes measured
//                             on the real one, one frame per block
//   OPENOVAI_STAND_IN_IGNORES_INTERRUPT
//                             carry on with the turn when told to interrupt it; without this an
//                             interrupt ends the turn with an error result, as the real one does
//                             (measured 2026-09-12: subtype error_during_execution, 13 ms after)
//   OPENOVAI_STAND_IN_HELPER        a file holding what the memory helper answers — the JSON the
//                             model would return, read afresh on every call so one chat can be
//                             handed a different answer per question. Unset, or the file not
//                             there, answers `{}`: a shape the tool has to refuse, which is a case
//                             of its own. A helper run is told apart by `--system-prompt` in its
//                             arguments, which no session run carries; it logs its arguments
//                             whole as JSON (`helper-argv:`), since one of them is the empty
//                             string and a space-joined line cannot show one, and the request it
//                             read from stdin (`helper:`). STUCK and BROKEN apply to it the way
//                             they apply to a session; REFUSED makes it exit the way the service
//                             turns a run away
// It records what a session was given — its arguments, the environment it can be identified
// by, and every frame it was told — so a check can read what a seat was told rather than
// trusting what the server says it sent.
//
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
const log = process.env.OPENOVAI_STAND_IN_LOG;
const note = (line) => fs.appendFileSync(log, line + "\\n");

fs.appendFileSync(
  log,
  [
    \`argv: \${called}\`,
    \`pid: \${process.pid}\`,
    \`cwd: \${process.cwd()}\`,
    \`CLAUDE_CONFIG_DIR: \${value("CLAUDE_CONFIG_DIR")}\`,
    \`CLAUDE_CODE_PROJECT_DIR_NAME: \${value("CLAUDE_CODE_PROJECT_DIR_NAME")}\`,
    \`ANTHROPIC_API_KEY: \${value("ANTHROPIC_API_KEY")}\`,
    \`CLAUDE_CODE_OAUTH_TOKEN: \${value("CLAUDE_CODE_OAUTH_TOKEN")}\`,
    \`OPENOVAI_SESSION_SECRET: \${value("OPENOVAI_SESSION_SECRET")}\`,
    "",
  ].join("\\n"),
);

if (argv[0] === "auth" && argv[1] === "status") {
  const signedIn = process.env.OPENOVAI_STAND_IN_SIGNED_IN ?? "true";
  process.stdout.write(JSON.stringify({ loggedIn: signedIn === "true" }) + "\\n");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "login") {
  process.exit(Number(process.env.OPENOVAI_STAND_IN_LOGIN_STATUS ?? 0));
}

// The real one falls over on stderr, not stdout, because that is where it puts prose.
if ((process.env.OPENOVAI_STAND_IN_BROKEN ?? "") !== "") {
  process.stderr.write("a model was never reached\\n");
  process.exit(1);
}

// One frame per line, the way the real one answers.
const frame = (fields) => process.stdout.write(JSON.stringify(fields) + "\\n");

// The memory helper: a print-mode run with the question as its whole system prompt, the request
// on stdin as plain text, and ONE JSON object back — never a stream of frames, which is why this
// sits before every frame a session run would be sent.
if (argv.includes("--system-prompt")) {
  fs.appendFileSync(
    log,
    "helper-argv: " + JSON.stringify(argv) + "\\n" +
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY: " + value("CLAUDE_CODE_DISABLE_AUTO_MEMORY") + "\\n" +
      "helper-cwd-holds: " + fs.readdirSync(process.cwd()).length + "\\n",
  );
  process.stdin.setEncoding("utf8");
  let request = "";
  for await (const chunk of process.stdin) {
    request += chunk;
  }
  fs.appendFileSync(log, "helper: " + request + "\\n");
  if ((process.env.OPENOVAI_STAND_IN_STUCK ?? "") !== "") {
    // Kept alive on purpose: a promise nobody settles with nothing else on the loop is an exit,
    // not a run that will not end. Its pid is above, for whoever has to end it.
    setInterval(() => {}, 60000);
    await new Promise(() => {});
  }
  if ((process.env.OPENOVAI_STAND_IN_REFUSED ?? "") !== "") {
    frame({ type: "result", subtype: "success", is_error: true, api_error_status: 429, num_turns: 0, result: "You've hit your session limit · resets 9am", session_id: "helper" });
    process.exit(1);
  }
  let result = "{}";
  try {
    result = fs.readFileSync(process.env.OPENOVAI_STAND_IN_HELPER ?? "", "utf8");
  } catch {
    // Nothing staged: the empty shape, which the tool refuses.
  }
  frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result, session_id: "helper" });
  process.exit(0);
}

// A run that will not end on its own, whatever it is told. The lifetime bound below still ends
// it, so a suite that forgot it cannot hang.
const stuck = (process.env.OPENOVAI_STAND_IN_STUCK ?? "") !== "";

setTimeout(() => {
  note("outlived: " + (process.env.OPENOVAI_STAND_IN_LIFETIME ?? 60000));
  process.exit(0);
}, Number(process.env.OPENOVAI_STAND_IN_LIFETIME ?? 60000)).unref();

frame({
  type: "system",
  subtype: "init",
  session_id: "test-thread",
  model: argv[argv.indexOf("--model") + 1] || "a-model",
});

// Frames arrive on stdin one per line. A user frame is a question; anything else is an answer to
// something this run asked. Read with a listener rather than with for-await: leaving a for-await
// early closes the stream it was reading, and this one stays open for the next question.
process.stdin.setEncoding("utf8");

let rest = "";
const questions = [];
let wakeQuestion = null;
let wakeAnswer = null;
// An interrupt under way: set while a turn runs, called when one arrives.
let interrupted = false;
let onInterrupt = null;

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
    if (said.type === "control_request" && said.request?.subtype === "interrupt") {
      note("interrupt: " + said.request_id);
      frame({ type: "control_response", response: { subtype: "success", request_id: said.request_id, response: {} } });
      if ((process.env.OPENOVAI_STAND_IN_IGNORES_INTERRUPT ?? "") === "") {
        interrupted = true;
        if (onInterrupt !== null) {
          onInterrupt();
        }
      }
      continue;
    }
    if (said.type === "user") {
      // Noted the moment the line arrives, before its turn: what the server wrote and when it
      // wrote it, as against "heard:", which is when this run got round to it.
      note("read-at: " + process.hrtime.bigint());
      note("read: " + said.message.content);
      questions.push(said.message.content);
      if (wakeQuestion !== null) {
        const wake = wakeQuestion;
        wakeQuestion = null;
        wake();
      }
      continue;
    }
    if (wakeAnswer !== null) {
      wakeAnswer(said);
    }
  }
});

let closed = false;
process.stdin.on("end", () => {
  closed = true;
  if (wakeQuestion !== null) {
    const wake = wakeQuestion;
    wakeQuestion = null;
    wake();
  }
});

const nextQuestion = () =>
  new Promise((resolve) => {
    if (questions.length > 0 || closed) {
      resolve();
      return;
    }
    wakeQuestion = resolve;
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A wait that an interrupt cuts short.
const sleepUnlessInterrupted = (ms) =>
  new Promise((resolve) => {
    const made = setTimeout(resolve, ms);
    onInterrupt = () => {
      clearTimeout(made);
      resolve();
    };
  }).finally(() => {
    onInterrupt = null;
  });

const perTurn = (name, turn) => {
  const raw = process.env[name] ?? "";
  if (raw === "") {
    return null;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return parsed;
  }
  return parsed.length === 0 ? null : (parsed[turn - 1] ?? null);
};

// The MCP address this run was given, with the secret it refers to filled in from the environment
// the way Claude Code does it.
const toolAddress = () => {
  const at = argv.indexOf("--mcp-config");
  if (at === -1) {
    return null;
  }
  const url = JSON.parse(argv[at + 1]).mcpServers.openovai.url;
  return url.replace(/\\$\\{([A-Z_]+)\\}/g, (_, name) => process.env[name] ?? "");
};

async function callTool(name, args) {
  const address = toolAddress();
  if (address === null) {
    note("tool: " + name + " -> no MCP address");
    return;
  }
  try {
    const answered = await fetch(address, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} } }),
    });
    const body = await answered.json();
    const text = body.result?.content?.[0]?.text ?? JSON.stringify(body);
    note("tool: " + name + " -> " + (body.result?.isError === true ? "refused: " : "") + text);
  } catch (error) {
    note("tool: " + name + " -> failed: " + error.message);
  }
}

// Asking to be allowed, the way the real one asks: a control request, then a wait for the
// control response echoing the same request id. The real one waits for good; a suite cannot.
async function askPermission(turn) {
  const id = "request-" + turn;
  frame({
    type: "control_request",
    request_id: id,
    request: {
      subtype: "can_use_tool",
      tool_name: process.env.OPENOVAI_STAND_IN_ASKS,
      input:
        (process.env.OPENOVAI_STAND_IN_ASKS_FILE ?? "") === ""
          ? { command: process.env.OPENOVAI_STAND_IN_ASKS_INPUT ?? "the one it wanted to run" }
          : { file_path: process.env.OPENOVAI_STAND_IN_ASKS_FILE },
    },
  });
  const answer = await Promise.race([
    new Promise((resolve) => {
      wakeAnswer = (said) => {
        if (said.type === "control_response" && said.response?.request_id === id) {
          wakeAnswer = null;
          resolve(said.response.response);
        }
      };
    }),
    sleep(Number(process.env.OPENOVAI_STAND_IN_WAITS ?? 5000)).then(() => null),
  ]);
  note(answer === null ? "nobody answered: " + id : "decided: " + JSON.stringify(answer));
  return answer;
}

let turn = 0;
let question = 0;
for (;;) {
  await nextQuestion();
  if (questions.length === 0) {
    break;
  }
  const asked = questions.shift();
  turn += 1;
  interrupted = false;
  note("heard: " + asked);

  // A server event is a turn like any other, but the per-question knobs count questions: what
  // the account stands at and what a turn cost are staged against what the suite asked.
  const isQuestion = !asked.startsWith("<server-event");
  if (isQuestion) {
    question += 1;
  }
  const readings = isQuestion ? perTurn("OPENOVAI_STAND_IN_RATE_LIMIT", question) : null;
  for (const info of readings === null ? [] : Array.isArray(readings) ? readings : [readings]) {
    frame({ type: "rate_limit_event", rate_limit_info: info, session_id: "test-thread" });
  }
  const usage = !isQuestion ? null : perTurn("OPENOVAI_STAND_IN_USAGE", question) ?? (() => {
    const raw = process.env.OPENOVAI_STAND_IN_USAGE ?? "";
    const parsed = raw === "" ? null : JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed.at(-1) : null;
  })();

  let decided = null;
  if ((process.env.OPENOVAI_STAND_IN_ASKS ?? "") !== "") {
    decided = await askPermission(turn);
  }

  // What the real one says beside an answer: a keep-alive while a long turn runs, a system
  // notice, and — because stdout is a stream and not only frames — the odd line that is not
  // JSON at all.
  if ((process.env.OPENOVAI_STAND_IN_NOISE ?? "") !== "") {
    frame({ type: "keep_alive" });
    frame({ type: "system", subtype: "init", session_id: "test-thread" });
    process.stdout.write("this line is not a frame at all\\n");
    frame({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "thinking" }] } });
  }

  // The tools the real one would say it is using in this turn: the call as its own assistant
  // frame, then its result as the user's turn of the protocol, before the answer — as measured.
  const made = isQuestion ? perTurn("OPENOVAI_STAND_IN_CALLS", question) : null;
  for (const [i, call] of (made ?? []).entries()) {
    const id = "call-" + turn + "-" + i;
    const parent = call.parent ?? null;
    frame({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: call.name, input: call.input ?? {} }] }, parent_tool_use_id: parent, session_id: "test-thread" });
    frame({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: typeof call.error === "string" ? call.error : call.error === true ? "failed" : "done", is_error: call.error === true || typeof call.error === "string", tool_use_id: id }] }, parent_tool_use_id: parent, session_id: "test-thread" });
  }

  const slow = Number(process.env.OPENOVAI_STAND_IN_SLOW ?? 0);
  if (slow > 0 && !interrupted) {
    await sleepUnlessInterrupted(slow);
  }

  if ((process.env.OPENOVAI_STAND_IN_DIES ?? "") !== "") {
    note("died: " + asked);
    process.exit(1);
  }

  const calls = (process.env.OPENOVAI_STAND_IN_TOOL ?? "") === "" ? [] : JSON.parse(process.env.OPENOVAI_STAND_IN_TOOL);
  const on = process.env.OPENOVAI_STAND_IN_TOOL_ON ?? "";
  if (!interrupted && (on === "" || asked.includes(on))) {
    for (const call of calls) {
      await callTool(call.name, call.arguments);
    }
  }

  if (interrupted) {
    note("interrupted: " + asked);
    frame({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: turn,
      session_id: "test-thread",
      ...(usage === null ? {} : { usage }),
    });
    continue;
  }

  note("answered: " + asked);
  // The answer the way the real one gives it: the text as an assistant frame of its own the
  // moment it is said, then the result frame carrying the same text — as measured. A turn with
  // nothing to say says no text and results in an empty string.
  const answer =
    (process.env.OPENOVAI_STAND_IN_EMPTY ?? "") !== ""
      ? ""
      : decided === null
        ? (process.env.OPENOVAI_STAND_IN_REPLY ?? "a reply")
        : \`I was told \${decided.behavior}\${decided.message === undefined ? "" : \`: \${decided.message}\`}\`;
  if (answer !== "") {
    frame({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] }, session_id: "test-thread" });
  }
  frame({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: turn,
    session_id: "test-thread",
    ...(usage === null ? {} : { usage }),
    result: answer,
  });
}

// Stdin was closed: the conversation is over. A stuck run stays until its lifetime is up — held
// by an interval, because a promise nobody settles with nothing else on the loop is an exit.
note("left: " + turn);
if (stuck) {
  setInterval(() => {}, 60000);
  await new Promise(() => {});
}
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
    OPENOVAI_STAND_IN_LOG: log,
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    ...extra,
  };
}

// Drive the stand-in directly: spawn it, hand it a question, read its frames and wait for it to
// go. Almost every check here reaches it through the chat, which is right when the subject is
// what the chat does with an answer. When the subject is the stand-in's OWN output — the shape it
// is modelling, which every later check about that shape stands on — going through the chat would
// be reading the value the code was kind enough to hand back rather than what was on the wire.
export function driveStandIn(command, argv, environment) {
  const child = spawn(command, argv, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [];
  const loose = [];
  let err = "";
  let rest = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    rest += chunk;
    let at = rest.indexOf("\n");
    while (at !== -1) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      at = rest.indexOf("\n");
      if (line.trim() === "") {
        continue;
      }
      try {
        frames.push(JSON.parse(line));
      } catch {
        loose.push(line);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });

  // A run that has already gone makes writing to it an error on the pipe rather than a throw.
  child.stdin.on("error", () => {});

  const ended = new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, frames, loose, err }));
  });

  return {
    frames,
    ask(text) {
      child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    },
    // What ends a run: the real one waits for another question until whoever asked closes stdin.
    close() {
      child.stdin.end();
    },
    waitForFrame(is) {
      return waitFor(() => frames.find(is) ?? null);
    },
    ended,
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

// A line the stand-in recorded under a label, newest last: `heard: ` for every frame it was
// told, `pid: ` for the process it ran as, and so on.
function recordedIn(log, label) {
  return readLog(log)
    .split("\n")
    .filter((line) => line.startsWith(label))
    .map((line) => line.slice(label.length));
}

// The frames a session was told, newest last. A frame goes in on stdin rather than in an
// argument, so what a session was actually told is read from here and not from callsIn.
export function heardIn(log) {
  return recordedIn(log, "heard: ");
}

// Every note the stand-in made, in order, as [label, rest] pairs: for a check about the ORDER of
// what arrived and what was answered rather than about one kind of note.
export function notesIn(log) {
  return readLog(log)
    .split("\n")
    .map((line) => /^([a-z]+): (.*)$/.exec(line))
    .filter((found) => found !== null)
    .map((found) => [found[1], found[2]]);
}

// The secrets the stand-in found in its environment, one per run, newest last. This is the one
// place a test reads a session's secret from: the server never says it.
export function secretsIn(log) {
  return recordedIn(log, "OPENOVAI_SESSION_SECRET: ");
}

// The processes the stand-in ran as, newest last. A check about a run being ended needs the
// process itself: whether a model is still held open is a question about the machine, and only
// a pid answers it.
// When each frame arrived on this run's stdin, in nanoseconds of the machine's monotonic clock:
// comparable across runs, which is what an ORDER of writes across seats is read from.
export function arrivalsIn(log) {
  return recordedIn(log, "read-at: ").map(BigInt);
}

export function pidsIn(log) {
  return recordedIn(log, "pid: ").map(Number);
}

// What Claude Code was told to file this instance's transcripts and memory under, newest last.
// Read as a list rather than matched in the whole log, because the question a check asks about it
// is what the LAST run was told — a value from an earlier run is somebody else's answer.
export function projectDirectoriesIn(log) {
  return readLog(log)
    .split("\n")
    .filter((line) => line.startsWith("CLAUDE_CODE_PROJECT_DIR_NAME: "))
    .map((line) => line.slice("CLAUDE_CODE_PROJECT_DIR_NAME: ".length));
}

// Whether a process is there at all. Signal 0 asks without sending anything.
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Start the server process as a child in the foreground — lib/serve.mjs, the very file
// `ovai start` runs detached — keeping whatever it prints. The output is where the address comes
// from when the instance was installed with --port 0, which is the only way to learn it.
export function startChat(root, environment) {
  const child = spawn("node", [path.join(root, "lib", "serve.mjs"), "--root", root], {
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
export function runOvai(root, argv, environment) {
  return spawnSync(path.join(root, "bin", "ovai"), argv, { env: environment, encoding: "utf8" });
}

// Run the tool directly rather than through bin/ovai, for the cases where the launcher's own
// refusal — no Claude Code on the PATH — would stop a test that is about something else.
export function runTool(root, argv, environment) {
  return spawnSync("node", [path.join(root, "lib", "ovai.mjs"), "--root", root, ...argv], {
    env: environment,
    encoding: "utf8",
  });
}

// The same, without holding this process while it runs. A check whose instance is talking to
// something served from here has to use this one: spawnSync blocks the event loop, so the server
// cannot answer the child, the child cannot exit, and the two wait for each other forever.
export function runToolLater(root, argv, environment) {
  const child = spawn("node", [path.join(root, "lib", "ovai.mjs"), "--root", root, ...argv], {
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

// The address the server printed for itself.
export async function waitForAddress(child) {
  return waitFor(() => /http:\/\/127\.0\.0\.1:\d+/.exec(child.output)?.[0] ?? null);
}

// A release, served the way GitHub serves one.
//
// Two routes, because that is all an instance asks for: what the latest release is, and the archive
// for it. The archive is made with tar from a real directory, wrapped in one directory named for it
// — which is the shape GitHub hands out and the reason the update strips one level off. A check
// against a hand-made shape would prove the update could read something nobody serves.
//
// No release is ever published from here. This is what makes the whole path checkable without one.
export function serveRelease(tree, tag) {
  const archive = spawnSync("tar", ["-czf", "-", "-C", path.dirname(tree), path.basename(tree)], {
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/releases/latest") {
      const body = JSON.stringify({
        tag_name: tag,
        tarball_url: `http://127.0.0.1:${server.address().port}/tarball`,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
      return;
    }
    if (url.pathname === "/tarball") {
      response.writeHead(200, { "content-type": "application/gzip" });
      response.end(archive);
      return;
    }
    response.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        latest: `http://127.0.0.1:${server.address().port}/releases/latest`,
        close: () => server.close(),
      });
    });
  });
}

// ------------------------------------------------------------------------------- the stylesheet

// The page's <style> block, read as rules rather than as text: one entry per rule in source
// order, `{ selector, media, keyframes, declarations }`, where `media` is the query the rule sits
// under, `keyframes` the animation a keyframe rule belongs to (each null otherwise) and
// `declarations` maps each property to its value. A regex over the stylesheet text says whether a
// string is present; this says which rule carries which value, which is what a check on a token
// table or on a stray colour needs. The page is read by the browser and never here, so the parser
// covers what the page writes — comments, plain rules, one level of @media and of @keyframes — and
// throws on anything else rather than reading it as something it is not.
export function styleRules(source) {
  const opened = source.indexOf("<style>");
  const closed = source.indexOf("</style>", opened);
  if (opened === -1 || closed === -1) throw new Error("the page has no <style> block");
  const css = source.slice(opened + "<style>".length, closed).replace(/\/\*[\s\S]*?\*\//g, "");

  const rules = [];
  const parse = (text, media, keyframes) => {
    let rest = text;
    for (;;) {
      const open = rest.indexOf("{");
      if (open === -1) {
        if (rest.trim() !== "") throw new Error(`text outside any rule: "${rest.trim().slice(0, 40)}"`);
        return;
      }
      const head = rest.slice(0, open).trim();
      const close = blockEnd(rest, open);
      const body = rest.slice(open + 1, close);
      if (head.startsWith("@")) {
        if (media !== null || keyframes !== null) throw new Error(`a nested block under "${head}"`);
        if (head.startsWith("@media")) parse(body, head.slice("@media".length).trim(), null);
        else if (head.startsWith("@keyframes")) parse(body, null, head.slice("@keyframes".length).trim());
        else throw new Error(`unsupported block: "${head}"`);
      } else {
        if (body.includes("{")) throw new Error(`a nested block under "${head}"`);
        const declarations = {};
        for (const piece of body.split(";")) {
          const line = piece.trim();
          if (line === "") continue;
          const colon = line.indexOf(":");
          if (colon === -1) throw new Error(`not a declaration under "${head}": "${line}"`);
          declarations[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
        }
        rules.push({ selector: head, media, keyframes, declarations });
      }
      rest = rest.slice(close + 1);
    }
  };
  parse(css, null, null);
  return rules;
}

// The index of the brace that closes the block opened at `open`, counting nested ones.
function blockEnd(text, open) {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "{") depth += 1;
    else if (text[at] === "}" && (depth -= 1) === 0) return at;
  }
  throw new Error("an unclosed block in the stylesheet");
}
