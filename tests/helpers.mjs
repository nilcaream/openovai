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
// It reads its behaviour from the environment, so one stand-in serves every suite:
//   OW_STAND_IN_LOG           file to record each call in (required)
//   OW_STAND_IN_REPLY         what an answer says            (default: a reply)
//   OW_STAND_IN_SESSION       the thread id it returns       (default: test-thread)
//   OW_STAND_IN_RESUME_FAILS  refuse to resume a thread      (default: no)
//   OW_STAND_IN_SLOW          milliseconds to take answering (default: none)
//   OW_STAND_IN_NOISE         emit what the real one says beside an answer — a keep-alive, a
//                             system notice, an assistant turn, and a line that is not a frame
//   OW_STAND_IN_BROKEN        fall over before framing anything, saying why on stderr — which is
//                             where the real one puts it: a model it does not know gives
//                             `[claude-code:unrecognized_model] …` there, a missing persona file
//                             `Error: Append system prompt file not found: …`, and stdout stays
//                             frames either way
//   OW_STAND_IN_MUTE          fall over saying nothing on either stream
//   OW_STAND_IN_HALF          frame a few things and then stop, with no result frame and nothing
//                             on stderr — a run killed in the middle of its turn, which is what
//                             stopping the chat does to one on purpose
//   OW_STAND_IN_REFUSED       be turned away by the service: a rate_limit_event saying rejected,
//                             then a result frame spelled success while carrying is_error and
//                             api_error_status 429 — what a run gets when the account has hit a
//                             usage limit, which is neither an answer nor a failure
//   OW_STAND_IN_NO_RESET      refuse without saying when the limit lifts (with REFUSED)
//   OW_STAND_IN_REFUSED_DEAF  refuse and then ignore stdin being closed, for good (with REFUSED)
//   OW_STAND_IN_LIMIT         a status to report in a rate_limit_event before doing anything else
//   OW_STAND_IN_FULLNESS      how full the five-hour window says it is  (default: 0.29)
//   OW_STAND_IN_LIMIT_KIND    which window the service names as the one that refused
//                             (default: "five_hour")
//                             — "allowed" or "allowed_warning", which is what an ordinary run
//                             sends whenever the reading moves
//   OW_STAND_IN_REFUSED_QUIETLY  be turned away with the 429 alone and no rate_limit_event, which
//                             is what a refusal looks like if that frame does not reach a
//                             headless caller
//   OW_STAND_IN_SIGNED_OUT    fail for want of a credential: every field a refusal has, spelled
//                             the same way, except the 429 — the one thing telling them apart
//   OW_STAND_IN_EMPTY         answer successfully with an empty result, the way a session that
//                             ends its turn without saying anything does
//   OW_STAND_IN_DEAF          ignore being asked to stop, and start a shell of its own the way
//                             a tool call does — its own process group AND its own session — so a
//                             check can watch what a forced run leaves behind
//   OW_STAND_IN_STUCK         answer nothing, ignore its input being closed, and never exit — the
//                             one state no fixture here could reach before, and the one the real
//                             one is in when it is waiting to be allowed something and nobody
//                             answers. Beside DEAF it also refuses to go when it is asked, which
//                             is what leaves the forcing something to do
//   OW_STAND_IN_ASKS          ask to be allowed to use this tool, wait for the answer, and make
//                             what it was told the reply
//   OW_STAND_IN_ASKS_INPUT    the argument that tool would be given, and a knob for the same
//                             reason the fullness is one: with every fixture naming one tool and
//                             one argument, a page that named a tool of its own satisfied the
//                             checks about both  (default: "the one it wanted to run")
//   OW_STAND_IN_WAITS         milliseconds to wait for that answer before giving up on it
//                             (default: 5000) — the real one waits for good, and a suite cannot
//   OW_STAND_IN_CALLS         "Speaker>Addressee,…" — while answering, that speaker says
//                             something to that addressee with the instance's own command, which
//                             is how a check builds a session that talks back mid-turn
//   OW_STAND_IN_USAGE         "n,n,…" — how big the thread was at each request this turn made,
//                             reported the way the real one reports it: one `usage.iterations`
//                             entry each, and a top level that ADDS them up. A check about the
//                             reading has to be able to tell those two apart, so the sizes differ
//                             and each is split across the three fields a context is made of
//   OW_STAND_IN_SIGNED_IN     what `auth status` reports     (default: true)
//   OW_STAND_IN_LOGIN_STATUS  what `auth login` exits with   (default: 0)
// It is plain ESM, like everything else here. A command on the PATH is named the way it is
// typed, so this file has no extension and Node cannot tell from the name what it is written
// in; from 24 it works that out from the syntax instead. The one thing that would take the
// choice away again is package.json declaring "type": "commonjs" — measured on 24.20.0, that
// makes an extensionless module do nothing at all and exit 0, so the field is left out.
const STAND_IN = `#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
const called = argv.join(" ");
const value = (name) => process.env[name] || "<unset>";
const log = process.env.OW_STAND_IN_LOG;

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
    \`OW_SESSION_NAME: \${value("OW_SESSION_NAME")}\`,
    "",
  ].join("\\n"),
);

// A run that will not take no for an answer. The real one can be in the middle of anything when
// it is told to stop, so the chat cannot assume being asked is enough.
if ((process.env.OW_STAND_IN_DEAF ?? "") !== "") {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});

}

if (called === "auth status") {
  const signedIn = process.env.OW_STAND_IN_SIGNED_IN ?? "true";
  process.stdout.write(\`{"loggedIn":\${signedIn},"authMethod":"claude.ai"}\\n\`);
  process.exit(signedIn === "true" ? 0 : 1);
}

if (called === "auth login") {
  process.stdout.write("(the real one opens a browser here)\\n");
  process.exit(Number(process.env.OW_STAND_IN_LOGIN_STATUS ?? 0));
}

// Falling over before anything could be framed: whatever it has to say, it says in prose, and it
// says it on stderr — measured on the real one, where stdout stays frames whatever goes wrong.
if ((process.env.OW_STAND_IN_BROKEN ?? "") !== "") {
  process.stderr.write("a model was never reached\\n");
  process.exit(1);
}

// The same fall, with nothing said about it on either stream.
if ((process.env.OW_STAND_IN_MUTE ?? "") !== "") {
  process.exit(1);
}

// One frame per line, the way the real one answers.
const frame = (fields) => process.stdout.write(JSON.stringify(fields) + "\\n");

// The reading the service sends when it is NOT refusing anything. It arrives on an ordinary run
// whenever the numbers move, and both captures on this machine hold the frame in exactly this
// state, so a check that never produced it would be checking the chat against a wire it will not
// meet. Said as early as the run can say anything, and before every branch below: a reading that
// only ever reached the paths that go on to answer would leave the paths that do not unwatched,
// and one of those is where the thread is dropped.
// One reading, in the shape four real captures on this workstation hold — not a shape invented
// here. The whole of it is copied because the parts left out of a fixture are exactly the parts a
// reader can go wrong on, and this frame has a trap in it.
//
// THE TRAP: overageStatus sits directly beside status, it is about billing rather than about this
// run, and it reads "rejected" on every capture — every one of which was an ALLOWED run. A reader
// reaching for the wrong one of two field names that read equally plausibly would call every
// ordinary run a refusal. A fixture without the field lets that reader pass everything here, which
// is why it is in.
//
// utilization is a fraction and not a percentage, resetsAt is unix seconds, and unifiedWindows
// names its own windows rather than being one — all measured, none of it read by this feature,
// all of it here so the frame is the frame.
const reading = (status, lifts) => ({
  status,
  ...(lifts === null ? {} : { resetsAt: lifts }),
  rateLimitType: limitKind(),
  overageStatus: "rejected",
  overageDisabledReason: "org_level_disabled",
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: fullness(), ...(lifts === null ? {} : { resetsAt: lifts }) },
    // Derived from the knob rather than written down, and deliberately not the same number as
    // the window above: with a literal here, a reader that answered with a constant for this
    // window — or read the wrong window entirely — reached the right answer in every fixture.
    seven_day: { utilization: fullness() / 2, resetsAt: Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60 },
  },
});

const lifts = () => Math.floor(Date.now() / 1000) + 3 * 60 * 60;

// How full the window says it is, and a knob rather than a literal for the same reason resetsAt is
// computed above: a check that asserted the number this file had written down would be matching a
// constant both sides already agree on, and would pass whether or not anything read the frame.
const fullness = () => Number(process.env.OW_STAND_IN_FULLNESS ?? 0.29);

// Which window the service says refused, and a knob for exactly the reason the two above are.
// It was a literal until it was measured: with every refusal fixture named five_hour, a reader
// that ignored the field and hard-coded the string reached the right answer in all of them, and
// the check whose whole job is this — "carries the kind of limit the frame named" — stayed green
// under that mutation. The service names its own windows, so a fixture that only ever names one
// proves nothing about whether the field is read.
const limitKind = () => process.env.OW_STAND_IN_LIMIT_KIND ?? "five_hour";

if ((process.env.OW_STAND_IN_LIMIT ?? "") !== "") {
  frame({
    type: "rate_limit_event",
    rate_limit_info: reading(process.env.OW_STAND_IN_LIMIT, lifts()),
    uuid: crypto.randomUUID(),
    session_id: process.env.OW_STAND_IN_SESSION ?? "test-thread",
  });
}


// Stopped in the middle of the turn: the frames it had already emitted are on stdout, there is no
// result frame, and stderr is empty. This is the shape that put 14,546 characters of protocol on a
// panel as what a session had said.
if ((process.env.OW_STAND_IN_HALF ?? "") !== "") {
  frame({ type: "system", subtype: "init", session_id: "test-thread", tools: ["Bash", "Read"] });
  frame({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "half a thought" }] } });
  process.exit(1);
}

// A thread that is not there any more. Measured on the real one (2.1.259) by resuming an id no
// conversation was ever written under: the subtype is error_during_execution, the message is an
// array of plain strings under errors and there is no result field at all, and session_id is the
// id the run was asked to resume rather than null — the run adopts it before finding out it is
// gone. The same message goes to stderr, and it exits 1 without ever reading stdin.
if (called.includes("--resume") && (process.env.OW_STAND_IN_RESUME_FAILS ?? "") !== "") {
  const wanted = argv[argv.indexOf("--resume") + 1];
  const gone = \`No conversation found with session ID: \${wanted}\`;
  process.stderr.write(gone + "\\n");
  frame({
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    session_id: wanted,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, iterations: [] },
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    errors: [gone],
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

// Turned away with nothing said about it in a frame — the refusal reaching the caller only as the
// 429 on the result. This is the state the design's one open assumption is about: the rejected
// reading has never been watched on the wire, and if it turns out not to travel to a headless
// caller, this is what a refusal looks like instead. A stand-in that could only refuse the loud
// way would leave the field that covers it unproven.
if ((process.env.OW_STAND_IN_REFUSED_QUIETLY ?? "") !== "") {
  frame({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 429,
    num_turns: 0,
    result: "You've hit your session limit · resets 9am",
    session_id: process.env.OW_STAND_IN_SESSION ?? "test-thread",
  });
  await ended;
  process.exit(1);
}

// A run with no usable credential. Every field a refusal has, spelled the same way, EXCEPT the
// 429 — which is the whole of the difference and the reason this exists. Nothing about it is a
// rate limit, and a chat that called it one would go on calling it one for ever, since the
// condition never clears by itself.
if ((process.env.OW_STAND_IN_SIGNED_OUT ?? "") !== "") {
  frame({
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 0,
    result: "Invalid API key · Please run /login",
    session_id: process.env.OW_STAND_IN_SESSION ?? "test-thread",
  });
  await ended;
  process.exit(1);
}

// Turned away by the service. Not a failure and not an answer: the run reached the service, was
// refused, and said so in the shape the published schema gives — a rate_limit_event whose
// rate_limit_info.status is "rejected", and then a result frame spelled subtype "success" while
// carrying is_error true and api_error_status 429.
//
// That spelling is the trap the whole thing turns on. A refusal differs from an ordinary answer
// ONLY in is_error, and it is not separable from a signed-out run without api_error_status or the
// rate_limit_event beside it. A stand-in that spelled it error_during_execution would be modelling
// an unresumable thread instead, and everything built on it would be proven against a fiction.
//
// resetsAt is computed rather than fixed, so a check about the reset time cannot pass by matching
// a literal both sides already agree on. The time in the PROSE is deliberately not that one: a
// panel that got its sentence by reading the message rather than the field would say the wrong
// hour, and be caught saying it.
//
// It waits to be told the run is over, exactly as the ordinary path below does — a refusal is not
// what ends a run — and then exits 1, which is what the real one exits when its last result frame
// carries is_error.
if ((process.env.OW_STAND_IN_REFUSED ?? "") !== "") {
  // The same reading as an ordinary run sends, in the same captured shape, saying rejected instead
  // of allowed. Everything beside status is unchanged, overageStatus included — which is the
  // point of it: the two states differ in the one field, and a reader of any other field cannot
  // tell them apart at all.
  //
  // A refusal that does not say when it lifts is the other knob here. The schema does not promise
  // the field, and a chat that needed it to recognise a refusal would go deaf the first time one
  // came without it.
  frame({
    type: "rate_limit_event",
    rate_limit_info: reading("rejected", (process.env.OW_STAND_IN_NO_RESET ?? "") !== "" ? null : lifts()),
    uuid: crypto.randomUUID(),
    session_id: process.env.OW_STAND_IN_SESSION ?? "test-thread",
  });
  frame({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 429,
    num_turns: 0,
    result: "You've hit your session limit · resets 9am",
    session_id: process.env.OW_STAND_IN_SESSION ?? "test-thread",
  });

  // Refused AND deaf: the shape nobody has watched. It has been refused, it has said so, and it
  // then ignores its input being closed for good — which is what the run would look like if some
  // refusal did go quiet. Nothing but being ended reaches it, so it is what proves the ending.
  if ((process.env.OW_STAND_IN_REFUSED_DEAF ?? "") !== "") {
    setInterval(() => {}, 60000);
    await new Promise(() => {});
  }

  const told = await Promise.race([
    ended.then(() => true),
    new Promise((resolve) => {
      setTimeout(() => {
        fs.appendFileSync(log, \`stdin was never closed: \${asked}\\n\`);
        resolve(false);
      }, 5000);
    }),
  ]);

  // Written on the way out, and only when the input really was closed. It is what lets a check
  // tell a run that left because it was told the turn was over from one that was made to go, which
  // are the same exit code and otherwise the same from outside.
  if (told) {
    fs.appendFileSync(log, \`left: \${asked}\\n\`);
  }
  process.exit(1);
}

// What a tool call looks like from the outside. detached puts it in a process group AND a session
// of its own, which is what the real one was measured doing, and is the whole reason a signal sent
// to this process or to the chat cannot reach it. Left alone it outlives this run.
if ((process.env.OW_STAND_IN_DEAF ?? "") !== "") {
  const started = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    detached: true,
    stdio: "ignore",
  });
  started.unref();
  fs.appendFileSync(log, \`shell: \${started.pid}\\n\`);
}

// A run that goes quiet and stays that way. No answer, no failure, no notice on either stream, and
// its input being closed changes nothing — the state a real one is in while it waits to be allowed
// something that nobody is going to answer. Every other knob here ends somehow; this one is the
// absence of an ending, which is the whole point of it.
//
// It sits after the shell above so a run can be stuck AND have left something running underneath
// it, and before everything below so nothing is ever framed.
if ((process.env.OW_STAND_IN_STUCK ?? "") !== "") {
  // Its own pid, said before it goes quiet, because after this line it says nothing ever again.
  // This is the only thread back to it: a run in this state ends because the chat ends it, so a
  // suite checking whether the chat DOES would have no way to clear up after itself the one time
  // it matters — when the ending is broken and the check is about to say so. A stuck run left
  // behind holds the test process's own output open, and a check that cannot be watched failing
  // proves nothing.
  fs.appendFileSync(log, \`stuck: \${process.pid}\\n\`);
  setInterval(() => {}, 60000);
  await new Promise(() => {});
}

// Said from inside this turn, with the instance's own command, from the directory a session is
// started in. A timeout, because the thing being checked is sometimes whether this returns at all.
const me = process.env.OW_SESSION_NAME ?? "";
for (const pair of (process.env.OW_STAND_IN_CALLS ?? "").split(",").filter(Boolean)) {
  const [speaker, addressee] = pair.split(">");
  if (speaker !== me) {
    continue;
  }
  const said = spawnSync("./bin/ovai", ["say", addressee, \`a word from \${me}\`], { encoding: "utf8", timeout: 5000 });
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
      input: { command: process.env.OW_STAND_IN_ASKS_INPUT ?? "the one it wanted to run" },
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

// One request's worth of usage, in the three fields a context is the sum of. Split rather than put
// in one, so that a reader dropping any of the three is a reader that comes out short.
const iteration = (size) => ({
  type: "message",
  output_tokens: 1,
  input_tokens: 8,
  cache_creation_input_tokens: 5,
  cache_read_input_tokens: size - 13,
});

const sizes = (process.env.OW_STAND_IN_USAGE ?? "").split(",").filter(Boolean).map(Number);
const usage =
  sizes.length === 0
    ? {}
    : {
        usage: {
          output_tokens: sizes.length,
          input_tokens: 8 * sizes.length,
          cache_creation_input_tokens: 5 * sizes.length,
          cache_read_input_tokens: sizes.reduce((all, size) => all + size - 13, 0),
          iterations: sizes.map(iteration),
        },
      };

frame({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  ...usage,
  session_id: process.env.OW_STAND_IN_SESSION ?? "test-thread",
  result:
    (process.env.OW_STAND_IN_EMPTY ?? "") !== ""
      ? ""
      : decided === null
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

// The questions the stand-in was asked, newest last. The question is a frame on stdin rather than
// an argument, so what a session was actually asked is read from here and not from callsIn.
// The processes the stand-in ran as, newest last. A check about a run being ended needs the
// process itself and not the promise for it: whether the chat is still holding a model open is a
// question about the machine, and only a pid answers it.
// The shells the stand-in started as a tool call would, newest last.
export function shellsIn(log) {
  return readLog(log)
    .split("\n")
    .filter((line) => line.startsWith("shell: "))
    .map((line) => Number(line.slice("shell: ".length)));
}

// The runs the stand-in left in the state that has no ending of its own, newest last. Read by a
// teardown rather than by a check: what these checks are about is whether the chat ends such a
// run, so the suite cannot lean on the chat to have done it and still be able to report that it
// did not.
export function stuckRunsIn(log) {
  return readLog(log)
    .split("\n")
    .filter((line) => line.startsWith("stuck: "))
    .map((line) => Number(line.slice("stuck: ".length)));
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

export function pidsIn(log) {
  return readLog(log)
    .split("\n")
    .filter((line) => line.startsWith("pid: "))
    .map((line) => Number(line.slice("pid: ".length)));
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

export function heardIn(log) {
  return readLog(log)
    .split("\n")
    .filter((line) => line.startsWith("heard: "));
}

// Start a chat server as a child, keeping whatever it prints. The output is where the address
// comes from when the instance was installed with --port 0, which is the only way to learn it.
export function startChat(root, environment) {
  const child = spawn("node", [path.join(root, "tools", "ovai.mjs"), "--root", root, "chat"], {
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

// The name the command used to be typed under, which ships beside the new one for two releases.
// It is run through rather than around: what is being checked is that somebody who learned the
// old name still gets the command, so the check has to go the way that person goes.
export function runOldName(root, argv, environment) {
  return spawnSync(path.join(root, "bin", "ow"), argv, { env: environment, encoding: "utf8" });
}

// Run the tool directly rather than through bin/ovai, for the cases where the launcher's own
// refusal — no Claude Code on the PATH — would stop a test that is about something else.
export function runTool(root, argv, environment) {
  return spawnSync("node", [path.join(root, "tools", "ovai.mjs"), "--root", root, ...argv], {
    env: environment,
    encoding: "utf8",
  });
}

// The same, without holding this process while it runs. A check whose instance is talking to
// something served from here has to use this one: spawnSync blocks the event loop, so the server
// cannot answer the child, the child cannot exit, and the two wait for each other forever.
export function runToolLater(root, argv, environment) {
  const child = spawn("node", [path.join(root, "tools", "ovai.mjs"), "--root", root, ...argv], {
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
