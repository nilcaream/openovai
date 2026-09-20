// The chat: who it serves, how it knows who is calling, and how a session is spoken to.
//
// A session is one process, started by the chat, that reads frames on stdin and answers each
// with a result; the chat knows it by a secret it minted for that process and nothing else. The
// checks here serve a chat in this process and start its seats through the one seam that starts
// one, with the stand-in (tests/helpers.mjs) as the process: what a seat was told is read from
// the stand-in's log, and what the chat did with the answer from the chat's own replies.
//
// Every mutation in tests/mutations.json names the check it was written to redden.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { SERVER, panelFile, read as panel } from "../lib/chat/conversation.mjs";
import { messageFrame, serverEvent, userFrame } from "../lib/chat/frames.mjs";
import { listening } from "../lib/chat/runtime.mjs";
import { pageSecret } from "../lib/chat/secrets.mjs";
import { hire } from "../lib/desks.mjs";
import { endSeat, serve, shownRoot, startSeat, toolsFor } from "../lib/chat/server.mjs";
import { hasLeft } from "../lib/chat/lifecycle.mjs";
import { LEADER as LEADS, SECRET_IN_ENVIRONMENT, WORKER as WORKS, end, endEvery, interrupt, running, runningSeats, start, tell } from "../lib/chat/session.mjs";
import { BUILT_IN } from "../lib/plugins.mjs";
import { CONFIG_FILE } from "../lib/seed.mjs";
import { alive, callsIn, get as fetchPlain, heardIn, installed, notesIn, post as postPlain, remove, repo, scratch, secretsIn, startChat, stopChat, waitFor, waitForAddress, writeStandIn } from "./helpers.mjs";

const USER = "Mike";
const LEADER = "Superman";
const WORKER = "Paul";
const OTHER = "Jane";
const LEADER_MODEL = "opus";
const WORKER_MODEL = "sonnet";

const base = scratch("chat-test");
const instance = `${base}-instance`;
// Beside the instance and never under it: a check greps the instance root for a secret and the
// log is the one place a secret is written on purpose.
const standIn = `${base}-stand-in`;
const nowhere = `${base}-nowhere`;
// Where a process the chat starts of its own accord — the successor after a restart — writes:
// nobody arranged a log for it, and the machine's own `claude`, present or not, must never be it.
const unarranged = path.join(standIn, "unarranged.txt");
const realPath = process.env.PATH;

process.on("exit", () => {
  remove(instance, standIn, nowhere);
});

// ---------------------------------------------------------------------------------------------
// The fixture: one instance, served here; seats started and ended by the describes that need them.

function options(root) {
  return {
    "--root": root,
    "--source": repo,
    "--user": USER,
    "--leader": LEADER,
    "--leader-model": LEADER_MODEL,
    "--worker-model": WORKER_MODEL,
    "--port": 0,
    "--auth": "login",
  };
}

function configOf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
}

const pops = [];
const said = [];
let chat = null;
let server = null;
let url = null;
let log_ = null;

remove(instance, standIn, nowhere);
writeStandIn(standIn);
fs.mkdirSync(nowhere, { recursive: true });
installed(options(instance));
hire(instance, WORKER);
hire(instance, OTHER);

before(async () => {
  chat = { root: instance, config: configOf(instance), plugins: [], pop: (asked) => pops.push(asked) };
  // The chat says every request and every refusal to tell on console.log; a check reads them
  // from here rather than from the suite's output.
  log_ = console.log;
  console.log = (line) => said.push(String(line));
  // A seat is started with the stand-in on the PATH for that spawn only (seatUp); a spawn the
  // chat makes later on its own gets the environment of that moment, so the stand-in is on the
  // PATH for the whole suite and a spawn nobody arranged a log for writes to the one place.
  process.env.PATH = `${standIn}${path.delimiter}${realPath}`;
  process.env.OPENOVAI_STAND_IN_LOG = unarranged;
  server = await serve(chat);
  url = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await endEvery(500);
  await new Promise((resolve) => server.close(resolve));
  console.log = log_;
  process.env.PATH = realPath;
  delete process.env.OPENOVAI_STAND_IN_LOG;
});

// Start a seat with the stand-in as its process, its own log, and the knobs given, and answer
// with its secret once the process has said it in the log. The knobs are set on this process's
// environment for the spawn only: the chat hands a process the environment it has at that moment.
// `first` is a frame told in the same tick as the start, for a process that will be gone before
// a check could get a word in.
let logs = 0;
async function seatUp(seat, knobs = {}, { on = chat, command = standIn, first = null } = {}) {
  logs += 1;
  const log = path.join(standIn, `${seat}-${logs}.txt`);
  const before_ = { ...process.env };
  process.env.OPENOVAI_STAND_IN_LOG = log;
  // A command of null is a PATH with nothing on it at all: the one way to start a seat where
  // Claude Code is not, on a machine where it is.
  process.env.PATH = command === null ? nowhere : `${command}${path.delimiter}${before_.PATH}`;
  Object.assign(process.env, knobs);
  let started;
  let asked = null;
  try {
    started = startSeat(on, seat);
    if (first !== null) {
      asked = tell(seat, first);
    }
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in before_)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, before_);
  }
  if (command !== null) {
    assert.ok(await waitFor(() => secretsIn(log).length > 0), `${seat} never logged its secret`);
  }
  return { ...started, log, secret: secretsIn(log)[0] ?? null, asked };
}

// Let the chat spawn a seat of its own accord — the Leader, for something addressed to it — with
// the stand-in as the process and a log of its own: the knobs stay on this process's environment
// for as long as `act` runs, since the spawn happens inside it. Answers what `act` answered, the
// log, and the secret once the process has said it.
async function spawnedBy(seat, act, knobs = {}) {
  logs += 1;
  const log = path.join(standIn, `${seat}-${logs}.txt`);
  const before_ = { ...process.env };
  process.env.OPENOVAI_STAND_IN_LOG = log;
  process.env.PATH = `${standIn}${path.delimiter}${before_.PATH}`;
  Object.assign(process.env, knobs);
  let result;
  try {
    result = await act();
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in before_)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, before_);
  }
  assert.ok(await waitFor(() => secretsIn(log).length > 0), `${seat} was never started`);
  return { seat, result, log, secret: secretsIn(log)[0] };
}

// The page's own calls, carrying its secret.
function page(method, route, body) {
  return fetch(`${url}${route}`, {
    method,
    headers: { authorization: `Bearer ${pageSecret()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (answered) => ({ status: answered.status, body: await answered.text() }));
}

// A session's own calls, over its door.
function call(secret, method, params) {
  return postPlain(`${url}/mcp/${secret}`, { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
}

function answerOf(answered) {
  const body = JSON.parse(answered.body);
  return { text: body.result?.content?.[0]?.text, refused: body.result?.isError === true, error: body.error ?? null };
}

async function tool(secret, name, args = {}) {
  return answerOf(await call(secret, "tools/call", { name, arguments: args }));
}

async function listed(secret) {
  return JSON.parse((await call(secret, "tools/list")).body).result.tools.map((tool) => tool.name);
}

// What a seat's log shows it was told, once at least this many frames are in it.
async function told(log, count) {
  await waitFor(() => (heardIn(log).length >= count ? true : null));
  return heardIn(log);
}

const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// ---------------------------------------------------------------------------------------------

describe("what the chat serves", () => {
  let answeredPage = "";

  it("serves the page with its secret in the one tag that carries it", async () => {
    const answered = await fetchPlain(`${url}/`);
    assert.equal(answered.status, 200);
    answeredPage = answered.body;
    assert.ok(answered.body.includes(`<meta name="openovai-secret" content="${pageSecret()}">`), "the page has no secret in it");
    assert.ok(!answered.body.includes('<meta name="openovai-secret" content="">'), "the empty tag is still there");
  });

  // The page's own script is not run here, so the two things it has to do with the secret are read
  // off the source: carry it on every call, and reload when the server no longer knows it — a
  // server restart mints a new page secret, and a page still holding the one before would otherwise
  // sit on 401 for good.
  it("reads its secret off the tag, sends it on every call, and reloads when it is no longer known", () => {
    const opened = answeredPage.indexOf('<script type="module">');
    const script = answeredPage.slice(opened, answeredPage.indexOf("</script>", opened));
    assert.match(script, /querySelector\('meta\[name="openovai-secret"\]'\)\.content/);
    assert.match(script, /authorization: `Bearer \$\{secret\}`/);
    assert.match(script, /status === 401[\s\S]{0,80}location\.reload\(\)/);
    assert.equal(script.split("fetch(").length - 1, 1, "the page fetches somewhere other than through call()");
  });

  it("says in its health which instance it serves, on which port, at which version", async () => {
    const answered = await fetchPlain(`${url}/health`);
    assert.equal(answered.status, 200);
    const health = JSON.parse(answered.body);
    assert.equal(health.instance, instance);
    assert.equal(health.port, server.address().port);
    assert.equal(typeof health.version, "string");
    assert.deepEqual(Object.keys(health).sort(), ["instance", "port", "version"]);
  });

  it("records where it is listening, for whoever starts a session", () => {
    assert.equal(listening(instance), url);
  });

  it("tells the page who the User and the Leader are, and every seat with its role and model", async () => {
    const answered = await page("GET", "/sessions");
    assert.equal(answered.status, 200);
    const room = JSON.parse(answered.body);
    assert.equal(room.user, USER);
    assert.equal(room.leader, LEADER);
    assert.deepEqual(
      room.sessions.map((seat) => [seat.name, seat.role, seat.model, seat.running]),
      [
        [LEADER, LEADS, LEADER_MODEL, false],
        [OTHER, WORKS, WORKER_MODEL, false],
        [WORKER, WORKS, WORKER_MODEL, false],
      ],
    );
  });

  // The title names the instance by its root with the home directory as ~; the usage windows are
  // null until the account has been asked, which it is only while a page holds a stream.
  it("tells the page the instance as the title says it, and the usage windows as they stand", async () => {
    const room = JSON.parse((await page("GET", "/sessions")).body);
    assert.equal(room.instance, shownRoot(instance));
    assert.equal(room.quota, null);
    assert.equal(shownRoot("/home/a/inst", "/home/a"), "~/inst");
    assert.equal(shownRoot("/home/a", "/home/a"), "~");
    assert.equal(shownRoot("/home/alice/inst", "/home/a"), "/home/alice/inst");
    assert.equal(shownRoot("/srv/inst", "/home/a"), "/srv/inst");
  });

  it("puts the Leader first and the rest in name order", async () => {
    const { sessions } = JSON.parse((await page("GET", "/sessions")).body);
    assert.deepEqual(
      sessions.map((seat) => seat.name),
      [LEADER, OTHER, WORKER],
    );
  });

  it("will not open a panel for somebody who does not work here", async () => {
    assert.equal((await page("GET", "/sessions/Nobody/messages")).status, 404);
    assert.equal((await page("POST", "/sessions/Nobody/message", { text: "hello" })).status, 404);
  });

  it("answers nothing at a route it has not got", async () => {
    const answered = await page("GET", "/sessions/somewhere/else");
    assert.equal(answered.status, 404);
  });
});

// A directory under desks/ that no person could be called is not a seat: an editor's directory, a
// copy somebody made, something a tool dropped there.
describe("a directory under desks/ that is not a person", () => {
  const stray = path.join(instance, "desks", ".vscode");

  before(() => {
    fs.mkdirSync(stray, { recursive: true });
  });

  after(() => {
    remove(stray);
  });

  it("is not on the roster", async () => {
    const { sessions } = JSON.parse((await page("GET", "/sessions")).body);
    assert.ok(!sessions.some((seat) => seat.name === ".vscode"), JSON.stringify(sessions));
    assert.ok(sessions.some((seat) => seat.name === WORKER), "a seat whose name is fine is off the roster");
  });

  it("gets no panel", async () => {
    assert.equal((await page("GET", "/sessions/.vscode/messages")).status, 404);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the gate", () => {
  const UNKNOWN = JSON.stringify({ error: "unknown secret" });
  let paul;

  before(async () => {
    paul = await seatUp(WORKER);
  });

  after(async () => {
    await endSeat(WORKER, 500);
  });

  it("answers an unknown secret with one body, whatever was tried", async () => {
    const tried = [
      await postPlain(`${url}/mcp/${"x".repeat(43)}`, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      await postPlain(`${url}/mcp/`, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      await fetchPlain(`${url}/sessions`),
      await fetch(`${url}/sessions`, { headers: { authorization: "Bearer not-the-page" } }).then(async (a) => ({ status: a.status, body: await a.text() })),
      await fetch(`${url}/sessions`, { headers: { authorization: "Basic abc" } }).then(async (a) => ({ status: a.status, body: await a.text() })),
    ];
    for (const answered of tried) {
      assert.equal(answered.status, 401);
      assert.equal(answered.body, UNKNOWN);
    }
    assert.deepEqual(heardIn(paul.log), [], "a call from nobody reached a session");
  });

  it("never lets one kind of secret open the other side", async () => {
    const asPage = await postPlain(`${url}/mcp/${pageSecret()}`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(asPage.status, 401);
    assert.equal(asPage.body, UNKNOWN);
    const asSession = await fetch(`${url}/sessions`, { headers: { authorization: `Bearer ${paul.secret}` } });
    assert.equal(asSession.status, 401);
    assert.equal(await asSession.text(), UNKNOWN);
  });

  it("opens the door to the secret it issued", async () => {
    assert.equal((await call(paul.secret, "tools/list")).status, 200);
  });

  // A caller opens GET on its own door to listen for a stream the server does not offer. The
  // answer is 405, the one the protocol reserves for that, and nothing else: a 401 here reads as
  // "log in first" and sends the caller looking for a login that does not exist.
  it("answers GET on the door it issued with 405, and GET on an unknown one with the same 401", async () => {
    const before_ = said.length;
    const own = await fetch(`${url}/mcp/${paul.secret}`, { headers: { accept: "text/event-stream" } });
    assert.equal(own.status, 405);
    assert.equal(own.headers.get("allow"), "POST");
    await own.text();
    const stranger = await fetchPlain(`${url}/mcp/${"x".repeat(43)}`);
    assert.equal(stranger.status, 401);
    assert.equal(stranger.body, UNKNOWN);
    assert.deepEqual(said.slice(before_), [], "a request was logged");
    assert.deepEqual(heardIn(paul.log), [], "a GET reached a session");
  });

  // A request is never a line the server says: what it says is about the room, and the traffic of
  // a page polling for rows would bury that. And a secret is masked wherever an ANSWER names the
  // path that carried it — a caller that goes looking for a login appends the whole tool path to
  // a discovery route, and the one answer that repeats a path is the 404.
  it("says nothing about a request, and never a secret where an answer names the path", async () => {
    const before_ = said.length;
    const probes = [
      `/.well-known/oauth-protected-resource/mcp/${paul.secret}`,
      `/mcp/${paul.secret}/`,
      `/mcp/${paul.secret}/messages`,
    ];
    for (const probe of probes) {
      assert.equal((await fetchPlain(`${url}${probe}`)).status, 401);
    }
    const nowhere = await fetch(`${url}/nowhere/mcp/${paul.secret}`, { headers: { authorization: `Bearer ${pageSecret()}` } });
    assert.equal(nowhere.status, 404);
    assert.equal((await nowhere.json()).error, "nothing at GET /nowhere/mcp/<secret>");
    assert.deepEqual(said.slice(before_), [], "a request was logged");
  });

  it("forgets a secret when its process has gone, and the next process gets another", async () => {
    const old = paul.secret;
    await endSeat(WORKER, 500);
    assert.equal(running(WORKER), false);
    const closed = await postPlain(`${url}/mcp/${old}`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(closed.status, 401);
    assert.equal(closed.body, UNKNOWN);
    paul = await seatUp(WORKER);
    assert.notEqual(paul.secret, old);
    assert.equal((await call(paul.secret, "tools/list")).status, 200);
  });

  it("writes no secret anywhere under the instance", async () => {
    await tool(paul.secret, "room");
    const found = spawnSync("grep", ["-rF", "--", paul.secret, instance], { encoding: "utf8" });
    assert.equal(found.status, 1, `the secret is on disk:\n${found.stdout}`);
    const pageFound = spawnSync("grep", ["-rF", "--", pageSecret(), instance], { encoding: "utf8" });
    assert.equal(pageFound.status, 1, `the page secret is on disk:\n${pageFound.stdout}`);
  });
});

// ---------------------------------------------------------------------------------------------

describe("starting a seat", () => {
  let superman;
  let paul;

  before(async () => {
    superman = await seatUp(LEADER);
    paul = await seatUp(WORKER);
  });

  after(async () => {
    await endEvery(500);
  });

  it("mints one secret per process, 43 characters of base64url, and no two alike", async () => {
    assert.match(superman.secret, SECRET_SHAPE);
    assert.match(paul.secret, SECRET_SHAPE);
    assert.notEqual(superman.secret, paul.secret);
    await endSeat(WORKER, 500);
    const again = await seatUp(WORKER);
    assert.match(again.secret, SECRET_SHAPE);
    assert.notEqual(again.secret, paul.secret);
    assert.notEqual(again.secret, superman.secret);
    paul = again;
  });

  it("hands the process its secret in the environment and never on the command line", () => {
    const argv = callsIn(paul.log).at(-1);
    assert.ok(!argv.includes(paul.secret), `the secret is in argv: ${argv}`);
    assert.ok(argv.includes(`/mcp/\${${SECRET_IN_ENVIRONMENT}}`), `no placeholder in argv: ${argv}`);
  });

  it("points the process at this chat, with a whole turn to wait on a colleague", () => {
    const argv = callsIn(paul.log).at(-1);
    const config = JSON.parse(argv.match(/--mcp-config (\{.*?\}) --settings/s)[1]);
    assert.equal(config.mcpServers.openovai.type, "http");
    assert.equal(config.mcpServers.openovai.url, `${url}/mcp/\${${SECRET_IN_ENVIRONMENT}}`);
    assert.equal(config.mcpServers.openovai.timeout, 30 * 60 * 1000);
  });

  it("runs it in print mode over the streaming protocol, asking here before using a tool", () => {
    const argv = callsIn(paul.log).at(-1);
    for (const part of ["--print", "--input-format stream-json", "--output-format stream-json", "--verbose", "--permission-prompt-tool stdio"]) {
      assert.ok(argv.includes(part), `${part} is not in ${argv}`);
    }
  });

  it("runs each seat on the model its desk resolves to", () => {
    assert.match(callsIn(superman.log).at(-1), new RegExp(`--model ${LEADER_MODEL}\\b`));
    assert.match(callsIn(paul.log).at(-1), new RegExp(`--model ${WORKER_MODEL}\\b`));
  });

  it("renders the persona at every start, with the hard rules after it", () => {
    const handed = callsIn(paul.log).at(-1).match(/--append-system-prompt-file (\S+)/)[1];
    assert.equal(handed, path.join(instance, "desks", WORKER, "persona.md"));
    const persona = fs.readFileSync(handed, "utf8");
    assert.ok(persona.includes(WORKER), "the persona does not name the seat");
    assert.match(persona, /\n\nHard rules \(set /);
  });

  it("hands the run the list of what is not to be read, as a settings document of its own", () => {
    const handed = callsIn(paul.log).at(-1).match(/--settings (\S+)/)[1];
    assert.equal(handed, path.join(instance, "instructions.json"));
    const excluded = JSON.parse(fs.readFileSync(handed, "utf8")).claudeMdExcludes;
    assert.ok(excluded.includes("/CLAUDE.md"), `nothing for the filesystem root in ${JSON.stringify(excluded)}`);
    assert.deepEqual(excluded.filter((pattern) => !path.isAbsolute(pattern)), []);
  });

  it("starts the process in the instance, on the instance's own home", () => {
    const lines = fs.readFileSync(paul.log, "utf8");
    assert.match(lines, new RegExp(`^cwd: ${instance}$`, "m"));
    assert.match(lines, new RegExp(`^CLAUDE_CONFIG_DIR: ${path.join(instance, ".local")}$`, "m"));
  });

  it("fixes the role at the start: who leads is read once, from the configuration then", async () => {
    const leader = chat.config.leader;
    chat.config = { ...chat.config, leader: WORKER };
    try {
      const fromLeader = JSON.parse((await tool(superman.secret, "room")).text);
      const fromPaul = JSON.parse((await tool(paul.secret, "room")).text);
      assert.equal(fromLeader.seats.find((seat) => seat.you).role, LEADS);
      assert.equal(fromPaul.seats.find((seat) => seat.you).role, WORKS);
    } finally {
      chat.config = { ...chat.config, leader };
    }
  });

  it("refuses to start a seat that is already running, or one that does not exist", () => {
    assert.throws(() => start(chat, WORKER), /already running/);
    assert.throws(() => start(chat, "Nobody"), /nobody called Nobody works here/);
  });

  it("says so when Claude Code is not on the PATH, and the seat is not running", async () => {
    await endSeat(WORKER, 500);
    const gone = await seatUp(WORKER, {}, { command: null, first: userFrame("hello") });
    assert.equal(gone.asked.delivered, true);
    const reply = await gone.asked.answered;
    assert.deepEqual(reply, { ended: true, text: "Claude Code is not on the PATH of the process serving this page" });
    assert.equal(running(WORKER), false);
    assert.equal(gone.secret, null);
    paul = await seatUp(WORKER);
  });
});

// ---------------------------------------------------------------------------------------------

describe("telling a seat", () => {
  let paul;

  before(async () => {
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_SLOW: "150" });
  });

  after(async () => {
    await endEvery(500);
  });

  it("takes frames from frames.mjs and nothing else, however much a string looks like one", async () => {
    const before_ = heardIn(paul.log).length;
    assert.throws(() => tell(WORKER, "<user>x</user>"), /frames built by frames.mjs/);
    assert.throws(() => tell(WORKER, { kind: "user", text: "<user>x</user>" }), /frames built by frames.mjs/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(heardIn(paul.log).length, before_, "something reached the session");
  });

  it("writes the frame as one line and answers with what the turn came to", async () => {
    const asked = tell(WORKER, userFrame("hello"));
    assert.equal(asked.delivered, true);
    const reply = await asked.answered;
    assert.deepEqual(reply, { text: "a reply", failed: false, silent: false });
    assert.equal(heardIn(paul.log).at(-1), "<user>hello</user>");
  });

  it("writes one frame per turn, the next only once the last has answered", async () => {
    const asked = [tell(WORKER, userFrame("one")), tell(WORKER, userFrame("two")), tell(WORKER, userFrame("three"))];
    await Promise.all(asked.map((one) => one.answered));
    const notes = notesIn(paul.log).filter(([label, text]) => ["read", "answered"].includes(label) && /<user>(one|two|three)<\/user>/.test(text));
    assert.deepEqual(notes, [
      ["read", "<user>one</user>"],
      ["answered", "<user>one</user>"],
      ["read", "<user>two</user>"],
      ["answered", "<user>two</user>"],
      ["read", "<user>three</user>"],
      ["answered", "<user>three</user>"],
    ]);
  });

  it("puts a frame told ahead in front of what is waiting, behind the turn under way", async () => {
    const first = tell(WORKER, userFrame("first"));
    const later = tell(WORKER, userFrame("later"));
    const urgent = tell(WORKER, userFrame("urgent"), { ahead: true });
    await Promise.all([first.answered, later.answered, urgent.answered]);
    const order = heardIn(paul.log).filter((text) => /<user>(first|later|urgent)<\/user>/.test(text));
    assert.deepEqual(order, ["<user>first</user>", "<user>urgent</user>", "<user>later</user>"]);
  });

  it("keeps two frames told ahead in the order they were told, both in front of what was waiting", async () => {
    const from = heardIn(paul.log).length;
    const first = tell(WORKER, userFrame("first"));
    const later = tell(WORKER, userFrame("later"));
    const one = tell(WORKER, userFrame("ahead one"), { ahead: true });
    const two = tell(WORKER, userFrame("ahead two"), { ahead: true });
    await Promise.all([first.answered, later.answered, one.answered, two.answered]);
    const order = heardIn(paul.log).slice(from).filter((text) => /<user>(first|later|ahead one|ahead two)<\/user>/.test(text));
    assert.deepEqual(order, ["<user>first</user>", "<user>ahead one</user>", "<user>ahead two</user>", "<user>later</user>"]);
  });

  // The User steers wherever they type: a line typed onto a panel goes in front of the messages
  // and events waiting on that seat, and two lines typed keep their order.
  it("puts what the User types ahead of a message waiting on the seat, in the order typed", async () => {
    const busy = tell(WORKER, userFrame("busy"));
    const message = tell(WORKER, messageFrame(LEADER, "from the Leader"));
    await page("POST", `/sessions/${WORKER}/message`, { text: "typed one" });
    await page("POST", `/sessions/${WORKER}/message`, { text: "typed two" });
    await Promise.all([busy.answered, message.answered]);
    // Every turn answered before the next check, whichever went in last.
    for (const text of ["typed one", "typed two"]) {
      await waitFor(() => (notesIn(paul.log).some(([label, note]) => label === "answered" && note === `<user>${text}</user>`) ? true : null));
    }
    const order = heardIn(paul.log).filter((text) => /<user>(busy|typed one|typed two)<\/user>|<message from="/.test(text));
    assert.deepEqual(order, ["<user>busy</user>", "<user>typed one</user>", "<user>typed two</user>", `<message from="${LEADER}">from the Leader</message>`]);
  });

  // `written` is the one word a caller gets between the queue and the answer: it fires as the
  // frame goes in — at once when nothing is under way, after the turn under way otherwise — and
  // always before that turn's own answer.
  it("says when a frame is written: at once on an idle seat, after the turn under way on a busy one, before the answer", async () => {
    let atOnce = false;
    const idle = tell(WORKER, userFrame("idle"), { written: () => { atOnce = true; } });
    assert.equal(atOnce, true, "the write of a frame told to an idle seat waited for something");
    await idle.answered;
    const order = [];
    const answeredOne = () => notesIn(paul.log).some(([label, text]) => label === "answered" && text === "<user>one</user>");
    const one = tell(WORKER, userFrame("one"), { written: () => order.push("one written") });
    const two = tell(WORKER, userFrame("two"), { written: () => order.push(`two written, one ${answeredOne() ? "answered" : "under way"}`) });
    assert.deepEqual(order, ["one written"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(order, ["one written"], "the second frame went in while the first turn was under way");
    await one.answered;
    assert.deepEqual(order, ["one written", "two written, one answered"]);
    await two.answered;
    assert.deepEqual(order, ["one written", "two written, one answered"], "written fired again, or for something else");
  });

  // The log is where a seat that stays busy is read afterwards: every frame told is a line as it
  // is queued and a line as it goes in, each with its arrival number and how many wait behind it.
  it("says in the log what was queued and what was written, by arrival, with how many wait", async () => {
    const before_ = said.length;
    await tell(WORKER, userFrame("logged")).answered;
    const lines = said.slice(before_);
    const queued = lines.find((line) => line.startsWith("queued: "));
    const order = /^queued: (\S+) user #(\d+), 1 waiting$/.exec(queued ?? "");
    assert.notEqual(order, null, lines.join("\n"));
    assert.equal(order[1], WORKER);
    assert.ok(lines.includes(`wrote: ${WORKER} user #${order[2]}, 0 waiting`), lines.join("\n"));
  });

  it("says in the log why a frame was not written: the turn open since when, and how many wait", async () => {
    const before_ = said.length;
    const one = tell(WORKER, userFrame("one"));
    const two = tell(WORKER, userFrame("two"));
    await Promise.all([one.answered, two.answered]);
    const lines = said.slice(before_);
    const held = lines.filter((line) => line.startsWith("not written: "));
    assert.equal(held.length, 1, lines.join("\n"));
    assert.match(held[0], new RegExp(`^not written: ${WORKER} turn open since \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z, 1 waiting$`));
    const after_ = lines.slice(lines.indexOf(held[0]) + 1);
    assert.ok(after_.some((line) => new RegExp(`^wrote: ${WORKER} user #\\d+, \\d+ waiting$`).test(line)), lines.join("\n"));
  });

  it("says in the log that a seat on its way out took no new turn, and what it was ending as", async () => {
    const spawned = secretsIn(unarranged).length;
    await seatUp(OTHER, {
      OPENOVAI_STAND_IN_TOOL: JSON.stringify([
        { name: "write_desk", arguments: { title: "restart by the stand-in", status: "going", body: "## State\nx\n" } },
        { name: "restart_session", arguments: {} },
      ]),
    });
    const before_ = said.length;
    try {
      const going = tell(OTHER, userFrame("go"));
      const after_ = tell(OTHER, userFrame("after"));
      await going.answered;
      const line = await waitFor(() => said.slice(before_).find((one) => one.startsWith(`not written: ${OTHER} ending=`)) ?? null);
      assert.equal(line, `not written: ${OTHER} ending=restart, 1 waiting`);
      await after_.answered;
      assert.ok(await waitFor(() => secretsIn(unarranged).length > spawned), "no successor was started");
    } finally {
      await endSeat(OTHER, 500);
    }
  });

  it("says in the log that the interrupt was written, and how long the run took to answer it", async () => {
    await seatUp(OTHER, { OPENOVAI_STAND_IN_SLOW: "4000" });
    const before_ = said.length;
    try {
      const slow = tell(OTHER, userFrame("slowly"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await interrupt(OTHER), true);
      assert.deepEqual(await slow.answered, { interrupted: true, text: "interrupted" });
      const lines = said.slice(before_).filter((line) => line.startsWith("interrupt: "));
      assert.equal(lines.length, 2, said.slice(before_).join("\n"));
      assert.match(lines[0], new RegExp(`^interrupt: ${OTHER} written, turn user #\\d+$`));
      assert.match(lines[1], new RegExp(`^interrupt: ${OTHER} result in \\d+ ms$`));
    } finally {
      await endSeat(OTHER, 500);
    }
  });

  it("says in the log when the run never answered the interrupt and the seat was freed anyway", async () => {
    await seatUp(OTHER, { OPENOVAI_STAND_IN_SLOW: "4000", OPENOVAI_STAND_IN_IGNORES_INTERRUPT: "1" });
    const before_ = said.length;
    try {
      const deaf = tell(OTHER, userFrame("deaf"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await interrupt(OTHER, { patience: 300 }), true);
      assert.deepEqual(await deaf.answered, { interrupted: true, text: "interrupted" });
      const lines = said.slice(before_).filter((line) => line.startsWith(`interrupt: ${OTHER} no result`));
      assert.deepEqual(lines, [`interrupt: ${OTHER} no result after 300 ms — seat freed`]);
    } finally {
      await endSeat(OTHER, 500);
    }
  });

  it("refuses a seat with no process, queues nothing, and says so in the log", async () => {
    const before_ = said.length;
    const asked = tell(OTHER, serverEvent("user-typed", { who: WORKER }, "go"));
    assert.deepEqual(asked, { refused: "no process" });
    assert.ok(said.slice(before_).includes(`no process: ${OTHER} (server-event)`), said.slice(before_).join("\n"));
    const jane = await seatUp(OTHER);
    const first = tell(OTHER, userFrame("hello"));
    await first.answered;
    assert.deepEqual(heardIn(jane.log), ["<user>hello</user>"]);
    await endSeat(OTHER, 500);
  });

  it("reads the answer among whatever else the run says", async () => {
    const noisy = await seatUp(OTHER, { OPENOVAI_STAND_IN_NOISE: "1", OPENOVAI_STAND_IN_REPLY: "found it" });
    const reply = await tell(OTHER, userFrame("look")).answered;
    assert.deepEqual(reply, { text: "found it", failed: false, silent: false });
    assert.ok(noisy.pid > 0);
    await endSeat(OTHER, 500);
  });

  it("says when a turn answered with nothing", async () => {
    await seatUp(OTHER, { OPENOVAI_STAND_IN_EMPTY: "1" });
    const reply = await tell(OTHER, userFrame("well?")).answered;
    assert.deepEqual(reply, { text: "", failed: false, silent: true });
    await endSeat(OTHER, 500);
  });

  it("settles every waiting turn when the process ends mid-turn, and holds nobody past the exit", async () => {
    const dying = await seatUp(OTHER, { OPENOVAI_STAND_IN_DIES: "1" });
    const first = tell(OTHER, userFrame("go"));
    const second = tell(OTHER, userFrame("and then"));
    const replies = await Promise.all([first.answered, second.answered]);
    assert.deepEqual(replies, [
      { ended: true, text: `${OTHER} ended before answering` },
      { ended: true, text: `${OTHER} ended before answering` },
    ]);
    assert.equal(running(OTHER), false);
    assert.equal(alive(dying.pid), false);
    assert.deepEqual(heardIn(dying.log), ["<user>go</user>"]);
  });

  it("says what the process said on stderr when it fell over saying something", async () => {
    const broken = await seatUp(OTHER, { OPENOVAI_STAND_IN_BROKEN: "1" }, { first: userFrame("go") });
    assert.equal(broken.asked.delivered, true);
    const reply = await broken.asked.answered;
    assert.deepEqual(reply, { ended: true, text: "a model was never reached" });
    assert.equal(running(OTHER), false);
  });
});

// ---------------------------------------------------------------------------------------------

describe("ending a seat", () => {
  it("closes the conversation, which ends a run between turns, and forgets the secret", async () => {
    const paul = await seatUp(WORKER);
    await tell(WORKER, userFrame("hello")).answered;
    assert.equal(await end(WORKER, 2000), true);
    assert.equal(running(WORKER), false);
    assert.equal(alive(paul.pid), false);
    assert.ok(fs.readFileSync(paul.log, "utf8").includes("\nleft: 1\n"), "the run was not let go of");
    assert.equal((await postPlain(`${url}/mcp/${paul.secret}`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
  });

  it("takes down a run that will not go once patience has run out", async () => {
    const stuck = await seatUp(WORKER, { OPENOVAI_STAND_IN_STUCK: "1" });
    const began = Date.now();
    assert.equal(await end(WORKER, 300), true);
    assert.ok(Date.now() - began >= 300, "it did not wait its patience out");
    assert.equal(alive(stuck.pid), false);
    assert.equal(running(WORKER), false);
  });

  it("answers false for a seat with no process", async () => {
    assert.equal(await end(WORKER, 100), false);
  });

  it("ends every seat at once", async () => {
    await seatUp(WORKER);
    await seatUp(OTHER);
    assert.deepEqual(runningSeats().sort(), [OTHER, WORKER]);
    await endEvery(500);
    assert.deepEqual(runningSeats(), []);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the tools a session is served", () => {
  let superman;
  let paul;

  before(async () => {
    superman = await seatUp(LEADER);
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_REPLY: "pong", OPENOVAI_STAND_IN_SLOW: "300" });
  });

  after(async () => {
    await endEvery(500);
  });

  it("serves the Leader exactly what BUILT_IN names, and a Worker the same but park, hire, retire and permission", async () => {
    assert.deepEqual(await listed(superman.secret), BUILT_IN);
    assert.deepEqual(
      await listed(paul.secret),
      BUILT_IN.filter((name) => name !== "park" && name !== "hire" && name !== "retire" && name !== "permission"),
    );
  });

  it("binds who is calling into every tool, so none of them reads it from an argument", () => {
    const tools = toolsFor(chat, { seat: WORKER, role: WORKS });
    for (const one of tools) {
      assert.equal(typeof one.run, "function", `${one.name} has no run`);
      assert.equal(one.run.length <= 1, true, `${one.name} takes more than its arguments`);
    }
  });

  it("says who a message is from by the secret it came over, whatever the arguments claim", async () => {
    const before_ = heardIn(superman.log).length;
    const said_ = await tool(paul.secret, "message", { to: LEADER, text: "hello", from: LEADER });
    assert.equal(said_.refused, false, said_.text);
    const heard = await told(superman.log, before_ + 1);
    assert.equal(heard.at(-1), `<message from="${WORKER}">hello</message>`);
  });

  // The call comes back the moment the addressee has the message; nobody's turn is held for
  // anybody else's, and what the addressee says at the end of its turn is its own — on its
  // panel, never handed back as the call's result.
  it("comes back at once, with nothing of the reply in it", async () => {
    const began = Date.now();
    const before_ = panel(instance, WORKER).length;
    const heard = heardIn(paul.log).length;
    const said_ = await tool(superman.secret, "message", { to: WORKER, text: "ping" });
    assert.equal(said_.refused, false, said_.text);
    assert.equal(said_.text, `sent to ${WORKER}`);
    assert.ok(Date.now() - began < 300, "it waited for the turn");
    assert.equal((await told(paul.log, heard + 1)).at(-1), `<message from="${LEADER}">ping</message>`);
    await waitFor(() => (panel(instance, WORKER).length >= before_ + 2 ? true : null));
    const rows = panel(instance, WORKER).slice(before_);
    assert.deepEqual(rows.map((row) => [row.from, row.to, row.text]), [
      [LEADER, WORKER, "ping"],
      [WORKER, undefined, "pong"],
    ]);
    assert.match(rows[0].msg, /^[0-9a-f-]{36}$/, "the message has an id");
    assert.equal(rows[1].msg, undefined, "what the addressee said is its own reply, not a message back");
  });

  // The call is a row of the caller's own log the moment its outcome is known, under the id the
  // addressee's row carries: the page takes a click on one to the other.
  it("writes the call on the caller's panel with its outcome, under the id the addressee's row carries", () => {
    const mine = panel(instance, LEADER).findLast((row) => row.outcome !== undefined);
    assert.deepEqual([mine.from, mine.to, mine.text, mine.outcome, mine.why], [LEADER, WORKER, "ping", "sent", undefined]);
    assert.equal(mine.msg, panel(instance, WORKER).at(-2).msg, "one id per message, on both logs");
  });

  it("refuses a message to nobody, and delivers nothing to anybody", async () => {
    const before_ = [heardIn(superman.log).length, heardIn(paul.log).length];
    const said_ = await tool(paul.secret, "message", { to: "Nobody", text: "hello" });
    assert.equal(said_.refused, true);
    assert.equal(said_.text, "nobody called Nobody works here");
    assert.deepEqual([heardIn(superman.log).length, heardIn(paul.log).length], before_);
  });

  it("records a message nobody could take as not sent, on the caller's panel only", async () => {
    const leaderRows = panel(instance, LEADER).length;
    await tool(paul.secret, "message", { to: "Nobody", text: "hello" });
    const last = panel(instance, WORKER).at(-1);
    assert.deepEqual([last.from, last.to, last.text, last.outcome, last.why], [WORKER, "Nobody", "hello", "not sent", "nobody called Nobody works here"]);
    assert.equal(panel(instance, LEADER).length, leaderRows, "a row landed on the Leader's panel");
  });

  // The Leader's answer to a Worker is a message the other way, made with the tool, or it stays
  // on the Leader's own panel: nothing goes back to the Worker on its own.
  it("records a Worker's call on its own log and the receipt on the Leader's, and hands nothing back", async () => {
    const mine = panel(instance, WORKER).length;
    const theirs = panel(instance, LEADER).length;
    const said_ = await tool(paul.secret, "message", { to: LEADER, text: "a question" });
    assert.equal(said_.refused, false, said_.text);
    assert.equal(said_.text, `sent to ${LEADER}`);
    const own = panel(instance, WORKER).slice(mine);
    assert.deepEqual(own.map((r) => [r.from, r.to, r.text, r.outcome]), [[WORKER, LEADER, "a question", "sent"]]);
    await waitFor(() => (panel(instance, LEADER).length >= theirs + 2 ? true : null));
    const rows = panel(instance, LEADER).slice(theirs);
    assert.deepEqual(rows.map((r) => [r.from, r.to, r.text, r.outcome]), [
      [WORKER, LEADER, "a question", undefined],
      [LEADER, undefined, "a reply", undefined],
    ]);
    assert.equal(rows[0].msg, own[0].msg, "the question carries one id on both logs");
    assert.equal(rows[1].msg, undefined, "the Leader's reply is its own, not a message back");
    assert.equal(panel(instance, WORKER).length, mine + 1, "something landed on the Worker's panel on its own");
  });

  it("records a refused message on the caller's log with the reason", async () => {
    await tool(paul.secret, "message", { to: WORKER, text: "hello me" });
    const last = panel(instance, WORKER).at(-1);
    assert.deepEqual([last.from, last.to, last.text, last.outcome, last.why], [WORKER, WORKER, "hello me", "refused", "that is you"]);
  });

  it("refuses a message to yourself", async () => {
    const before_ = heardIn(paul.log).length;
    const said_ = await tool(paul.secret, "message", { to: WORKER, text: "hello me" });
    assert.equal(said_.refused, true);
    assert.equal(said_.text, "that is you");
    assert.equal(heardIn(paul.log).length, before_);
  });

  it("refuses a message with nothing in it", async () => {
    const said_ = await tool(paul.secret, "message", { to: LEADER, text: "   " });
    assert.equal(said_.refused, true);
    assert.equal(said_.text, "a message needs some text");
  });

  let othersRows = 0;
  it("never starts a seat for a message: no process is a refusal", async () => {
    othersRows = panel(instance, OTHER).length;
    const logsBefore = fs.readdirSync(standIn).length;
    const said_ = await tool(superman.secret, "message", { to: OTHER, text: "wake up" });
    assert.equal(said_.refused, true);
    assert.equal(said_.text, `${OTHER} has no process`);
    assert.equal(running(OTHER), false);
    assert.equal(fs.readdirSync(standIn).length, logsBefore, "something was started");
  });

  it("a message to a seat without a process is not sent, and says so on the caller's panel", () => {
    const last = panel(instance, LEADER).at(-1);
    assert.deepEqual([last.from, last.to, last.text, last.outcome, last.why], [LEADER, OTHER, "wake up", "not sent", `${OTHER} has no process`]);
    assert.equal(panel(instance, OTHER).length, othersRows, "a row landed on the panel of a seat that got nothing");
  });

  it("says on the addressee's panel when its process ended before answering; the call itself went", async () => {
    await seatUp(OTHER, { OPENOVAI_STAND_IN_DIES: "1" });
    const said_ = await tool(superman.secret, "message", { to: OTHER, text: "go" });
    assert.equal(said_.refused, false, said_.text);
    assert.equal(said_.text, `sent to ${OTHER}`);
    await waitFor(() => (panel(instance, OTHER).at(-1)?.failed === true ? true : null));
    const last = panel(instance, OTHER).at(-1);
    assert.equal(last.from, SERVER);
    assert.match(last.text, new RegExp(`^${OTHER} stopped before answering: `));
  });

  // The Leader's turn asks Paul something and Paul, before answering, messages the Leader: with
  // nobody's turn held for anybody's, the message is simply the Leader's next turn.
  it("takes a message from the one it is itself messaging: nobody waits, so nothing can wait for itself", async () => {
    const before_ = heardIn(superman.log).length;
    const said_ = await tool(paul.secret, "message", { to: LEADER, text: "one thing first" });
    assert.equal(said_.refused, false, said_.text);
    const heard = await told(superman.log, before_ + 1);
    assert.equal(heard.at(-1), `<message from="${WORKER}">one thing first</message>`);
  });

  it("tells a session who works here, who runs, and which one it is", async () => {
    const room = JSON.parse((await tool(paul.secret, "room")).text);
    assert.deepEqual(
      room.seats.map((seat) => [seat.name, seat.role, seat.model, seat.running, seat.you]),
      [
        [LEADER, LEADS, LEADER_MODEL, true, false],
        [OTHER, WORKS, WORKER_MODEL, false, false],
        [WORKER, WORKS, WORKER_MODEL, true, true],
      ],
    );
  });

  it("serves a tool of the instance's own after its own, handing it who is calling", async () => {
    const seen = [];
    const plugin = {
      name: "weather",
      description: "what it is like outside",
      inputSchema: { type: "object", properties: { where: { type: "string" } } },
      run(args, caller) {
        seen.push({ args, caller });
        return { text: `sunny in ${args.where}` };
      },
    };
    chat.plugins = [plugin];
    try {
      assert.deepEqual(await listed(superman.secret), [...BUILT_IN, "weather"]);
      const said_ = await tool(paul.secret, "weather", { where: "Oslo" });
      assert.equal(said_.text, "sunny in Oslo");
      assert.deepEqual(seen, [{ args: { where: "Oslo" }, caller: { seat: WORKER, role: WORKS, root: instance, config: chat.config } }]);
      const fromLeader = await tool(superman.secret, "weather", { where: "Rome" });
      assert.equal(fromLeader.text, "sunny in Rome");
      assert.equal(seen.at(-1).caller.role, LEADS);
    } finally {
      chat.plugins = [];
    }
  });

  it("refuses a call whose arguments do not fit what the tool declared, in one line naming the argument, before the tool sees it", async () => {
    const seen = [];
    chat.plugins = [
      {
        name: "brew",
        description: "makes a drink",
        inputSchema: {
          type: "object",
          properties: {
            what: { type: "string" },
            how: { type: "string", enum: ["hot", "cold"] },
            cups: { type: "integer" },
          },
          required: ["what"],
          additionalProperties: false,
        },
        run(args) {
          seen.push(args);
          return { text: `${args.what}, ${args.how ?? "as it comes"}` };
        },
      },
    ];
    try {
      const unfit = async (args) => {
        const said_ = await tool(paul.secret, "brew", args);
        assert.equal(said_.refused, true, JSON.stringify(said_));
        return said_.text;
      };
      assert.equal(await unfit({}), "brew: what is required");
      assert.equal(await unfit({ what: 3 }), "brew: what is not a string");
      assert.equal(await unfit({ what: "tea", how: "warm" }), "brew: how is not one of hot, cold");
      assert.equal(await unfit({ what: "tea", cups: 1.5 }), "brew: cups is not a whole number");
      assert.equal(await unfit({ what: "tea", milk: true }), "brew: milk is not an argument it takes");
      assert.deepEqual(seen, [], "a call that did not fit reached the tool");
      assert.equal((await tool(paul.secret, "brew", { what: "tea", how: "hot", cups: 2 })).text, "tea, hot");
      assert.deepEqual(seen, [{ what: "tea", how: "hot", cups: 2 }]);
      // The chat's own tools are held to the same line, and a refusal about what an argument
      // means stays theirs, after it.
      assert.equal((await tool(paul.secret, "message", { to: LEADER })).text, "message: text is required");
      assert.equal((await tool(paul.secret, "message", { to: LEADER, text: " " })).text, "a message needs some text");
    } finally {
      chat.plugins = [];
    }
  });

  it("refuses for a tool of the instance's own that answers outside the shape", async () => {
    chat.plugins = [{ name: "odd", description: "answers wrongly", inputSchema: { type: "object", properties: {} }, run: () => 42 }];
    try {
      const said_ = await tool(paul.secret, "odd");
      assert.equal(said_.refused, true);
      assert.match(said_.text, /^odd answered with nothing that can be passed on/);
    } finally {
      chat.plugins = [];
    }
  });
});

// ---------------------------------------------------------------------------------------------

// A message from one Worker to another is heard by the Leader the way a line the User types on a
// Worker's panel is: a row on the Leader's panel, `<sender> → <addressee>` with the words, and a
// server event on its next turn. Told, not asked; nothing waits on it; the addressee's delivery is
// what it was. A message to or from the Leader is heard already and gets nothing more.
describe("what one Worker says to another", () => {
  let superman;
  let paul;
  let sam;

  before(async () => {
    remove(panelFile(instance, LEADER), panelFile(instance, WORKER), panelFile(instance, OTHER));
    superman = await seatUp(LEADER, { OPENOVAI_STAND_IN_REPLY: "heard" });
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_REPLY: "on it" });
    sam = await seatUp(OTHER, { OPENOVAI_STAND_IN_REPLY: "got it" });
  });

  after(async () => {
    await endEvery(500);
  });

  it("reaches the addressee as the message it is, and the Leader as an overheard event with the words", async () => {
    const said_ = await tool(paul.secret, "message", { to: OTHER, text: "the fixture is yours" });
    assert.equal(said_.refused, false, said_.text);
    assert.equal(said_.text, `sent to ${OTHER}`);
    assert.deepEqual(await told(sam.log, 1), [`<message from="${WORKER}">the fixture is yours</message>`]);
    assert.deepEqual(await told(superman.log, 1), [`<server-event type="overheard" from="${WORKER}" to="${OTHER}">the fixture is yours</server-event>`]);
  });

  it("lands on the Leader's panel as a row from the sender to the addressee, under the id both ends carry", async () => {
    await waitFor(() => (panel(instance, LEADER).length >= 2 ? true : null));
    const rows = panel(instance, LEADER);
    assert.deepEqual([rows[0].from, rows[0].to, rows[0].text, rows[0].overheard, rows[0].outcome], [WORKER, OTHER, "the fixture is yours", true, undefined]);
    assert.equal(rows[0].msg, panel(instance, WORKER).at(-1).msg, "the sender's row and the Leader's carry one id");
    assert.equal(rows[0].msg, panel(instance, OTHER)[0].msg, "the addressee's row and the Leader's carry one id");
    assert.deepEqual([rows[1].from, rows[1].text], [LEADER, "heard"]);
    const shown = JSON.parse((await page("GET", `/sessions/${LEADER}/messages`)).body).messages;
    assert.deepEqual(shown, rows);
  });

  it("hears nothing more for a message to or from the Leader", async () => {
    const heard = heardIn(superman.log).length;
    const rows = panel(instance, LEADER).length;
    assert.equal((await tool(superman.secret, "message", { to: WORKER, text: "ping" })).text, `sent to ${WORKER}`);
    assert.equal((await tool(paul.secret, "message", { to: LEADER, text: "a question" })).text, `sent to ${LEADER}`);
    await waitFor(() => (panel(instance, LEADER).length >= rows + 3 ? true : null));
    assert.deepEqual(heardIn(superman.log).slice(heard), [`<message from="${WORKER}">a question</message>`]);
    assert.deepEqual(
      panel(instance, LEADER).slice(rows).map((row) => [row.from, row.to, row.overheard, row.outcome]),
      [[LEADER, WORKER, undefined, "sent"], [WORKER, LEADER, undefined, undefined], [LEADER, undefined, undefined, undefined]],
    );
  });
});

// ---------------------------------------------------------------------------------------------

describe("what the User types", () => {
  let superman;
  let paul;

  before(async () => {
    // Panels are files, and the describes above wrote on them: these checks read rows by position.
    remove(panelFile(instance, LEADER), panelFile(instance, WORKER));
    superman = await seatUp(LEADER, { OPENOVAI_STAND_IN_REPLY: "noted" });
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_REPLY: "on it" });
  });

  after(async () => {
    await endEvery(500);
  });

  it("reaches the seat as the User's own frame, and the Leader as a server event", async () => {
    const answered = await page("POST", `/sessions/${WORKER}/message`, { text: "go" });
    assert.equal(answered.status, 200);
    assert.deepEqual(JSON.parse(answered.body), { delivered: true, leaderTold: true });
    assert.deepEqual(await told(paul.log, 1), ["<user>go</user>"]);
    assert.deepEqual(await told(superman.log, 1), [`<server-event type="user-typed" who="${WORKER}">go</server-event>`]);
  });

  it("lands on the seat's panel as the User's row, with the reply under it", async () => {
    await waitFor(() => (panel(instance, WORKER).length >= 2 ? true : null));
    const rows = panel(instance, WORKER);
    assert.equal(rows[0].from, "user");
    assert.equal(rows[0].text, "go");
    assert.equal(rows[0].delivered, true, "the row is not marked delivered once its frame went in");
    assert.equal(rows[1].from, WORKER);
    assert.equal(rows[1].text, "on it");
    assert.equal(rows[1].delivered, undefined, "a reply is nobody's delivery");
    const shown = JSON.parse((await page("GET", `/sessions/${WORKER}/messages`)).body).messages;
    assert.deepEqual(shown, rows);
  });

  it("shows the Leader what was typed to whom, and what the Leader made of it", async () => {
    await waitFor(() => (panel(instance, LEADER).length >= 2 ? true : null));
    const rows = panel(instance, LEADER);
    assert.equal(rows[0].from, "user");
    assert.equal(rows[0].typedTo, WORKER);
    assert.equal(rows[0].text, "go");
    assert.equal(rows[1].from, LEADER);
    assert.equal(rows[1].text, "noted");
  });

  it("frames a word to the Leader as the User's own, and tells nobody else", async () => {
    const rows = panel(instance, LEADER).length;
    const answered = await page("POST", `/sessions/${LEADER}/message`, { text: "how is it going" });
    assert.deepEqual(JSON.parse(answered.body), { delivered: true });
    // Once the reply is on the panel the turn is over, and whatever else the Leader was going to
    // be told about this would be in its log by now.
    await waitFor(() => (panel(instance, LEADER).length >= rows + 2 ? true : null));
    assert.deepEqual(heardIn(superman.log), [`<server-event type="user-typed" who="${WORKER}">go</server-event>`, "<user>how is it going</user>"]);
    assert.deepEqual(panel(instance, LEADER).slice(rows).map((row) => [row.from, row.typedTo, row.text]), [["user", undefined, "how is it going"], [LEADER, undefined, "noted"]]);
    assert.deepEqual(heardIn(paul.log), ["<user>go</user>"]);
  });

  // A run that cannot go on — not logged in, a window spent — says why as text and then results
  // in the same words as an error: the words land once, as the failed row, not once plain and
  // once failed.
  it("shows a turn that failed in its own words as one failed row, not two", async () => {
    await endSeat(WORKER, 500);
    remove(panelFile(instance, WORKER));
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_FAILS: "1", OPENOVAI_STAND_IN_REPLY: "Not logged in · Please run /login" });
    const answered = await page("POST", `/sessions/${WORKER}/message`, { text: "go" });
    assert.deepEqual(JSON.parse(answered.body), { delivered: true, leaderTold: true });
    await waitFor(() => (panel(instance, WORKER).some((row) => row.failed === true) ? true : null));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const said = panel(instance, WORKER).filter((row) => row.from === WORKER);
    assert.deepEqual(said.map((row) => [row.text, row.failed]), [["Not logged in · Please run /login", true]], "the failed words landed twice, or not as failed");
  });

  // A Leader whose process is gone leaves one row on its panel saying so — between what that
  // session said and what the next one will say — and the next one is a fresh run: no resume, no
  // continue, nothing of the context it had; the desk is its only memory.
  it("leaves one row on the Leader's panel when its process is gone, and starts a fresh one for the event, the event its first line", async () => {
    const rows = panel(instance, LEADER).length;
    await endSeat(LEADER, 500);
    assert.equal(running(LEADER), false);
    await waitFor(() => (panel(instance, LEADER).length > rows ? true : null));
    const left = panel(instance, LEADER).slice(rows);
    assert.deepEqual(left.map((row) => [row.from, row.divider, row.text]), [[SERVER, true, hasLeft(LEADER)]]);
    assert.equal(hasLeft(LEADER), `${LEADER} has left — the next message starts a fresh session`);
    const spawned = await spawnedBy(LEADER, () => page("POST", `/sessions/${WORKER}/message`, { text: "carry on" }));
    assert.deepEqual(JSON.parse(spawned.result.body), { delivered: true, leaderTold: true });
    assert.equal((await told(paul.log, 2)).at(-1), "<user>carry on</user>");
    assert.deepEqual(await told(spawned.log, 1), [`<server-event type="user-typed" who="${WORKER}">carry on</server-event>`]);
    const argv = callsIn(spawned.log)[0];
    assert.ok(!/--resume|--continue/.test(argv), argv);
    assert.deepEqual([panel(instance, LEADER)[rows + 1].from, panel(instance, LEADER)[rows + 1].typedTo], ["user", WORKER], "the typed line is not the first row after the one that says the Leader left");
    superman = spawned;
  });

  it("says when the seat itself has no process, on the panel too", async () => {
    await endSeat(WORKER, 500);
    const answered = await page("POST", `/sessions/${WORKER}/message`, { text: "anybody there" });
    assert.deepEqual(JSON.parse(answered.body), { delivered: false, leaderTold: true });
    const rows = panel(instance, WORKER).slice(-2);
    assert.deepEqual([rows[0].from, rows[0].text, rows[0].delivered], ["user", "anybody there", undefined], "a row nobody took reads delivered");
    assert.deepEqual([rows[1].from, rows[1].text, rows[1].failed], [SERVER, `${WORKER} has no process`, true]);
  });

  it("refuses a message with nothing in it, or nothing it can read", async () => {
    const empty = await page("POST", `/sessions/${LEADER}/message`, { text: " " });
    assert.equal(empty.status, 400);
    assert.deepEqual(JSON.parse(empty.body), { error: "a message needs some text" });
    const broken = await fetch(`${url}/sessions/${LEADER}/message`, {
      method: "POST",
      headers: { authorization: `Bearer ${pageSecret()}` },
      body: "not json",
    });
    assert.equal(broken.status, 400);
  });
});

// ---------------------------------------------------------------------------------------------

// The stream, read here with fetch on the body the way a browser's EventSource would read it,
// except that a browser sends no header — which is why the secret is on the query of this one
// route. Every client opened is closed by the describe that opened it.
const open = [];

async function listen(query = "") {
  const controller = new AbortController();
  const response = await fetch(`${url}/events?page=${pageSecret()}${query}`, { signal: controller.signal });
  const events = [];
  const client = { status: response.status, type: response.headers.get("content-type"), events, close: () => controller.abort() };
  open.push(client);
  if (response.status !== 200) {
    return client;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        rest += decoder.decode(value, { stream: true });
        let at;
        while ((at = rest.indexOf("\n\n")) !== -1) {
          const block = rest.slice(0, at);
          rest = rest.slice(at + 2);
          const fields = {};
          for (const line of block.split("\n")) {
            const colon = line.indexOf(": ");
            fields[line.slice(0, colon)] = line.slice(colon + 2);
          }
          events.push({ id: Number(fields.id), name: fields.event, data: JSON.parse(fields.data) });
        }
      }
    } catch {
      // closed by the check
    }
  })();
  return client;
}

function about(client, name, kind = "seat") {
  return client.events.filter((event) => event.name === kind && (event.data.name ?? event.data.seat) === name);
}

async function until(client, predicate) {
  assert.ok(await waitFor(() => (client.events.some(predicate) ? true : null)), client.events.map((event) => `${event.name} ${JSON.stringify(event.data).slice(0, 120)}`).join("\n"));
}


// ---------------------------------------------------------------------------------------------

// What a Worker's tool calls write: one line per call on its own conversation, as the call is
// made, marked once the call's result comes back as an error; nothing for a call the summary
// says nothing about, nothing for a subagent's call, and never anything for the Leader's own.
describe("what a Worker's calls draw", () => {
  let superman;
  let paul;
  let client;
  const READ = { name: "Read", input: { file_path: "/srv/app/lib/chat/session.mjs" } };
  const FAILING = { name: "Bash", input: { command: "npm test", description: "Run the suite" }, error: "\n  Exit code 1\nnpm error Missing script: \"test\"" };
  const CALLS = JSON.stringify([
    [READ, FAILING],
    [{ name: "ToolSearch", input: { query: "select:Monitor" } }, { name: "mcp__openovai__stop_session", input: {} }],
    [{ ...READ, parent: "call-0-0" }],
    [READ, READ],
  ]);

  let logged;

  before(async () => {
    remove(panelFile(instance, LEADER), panelFile(instance, WORKER));
    logged = said.length;
    superman = await seatUp(LEADER, { OPENOVAI_STAND_IN_REPLY: "noted", OPENOVAI_STAND_IN_CALLS: CALLS });
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_REPLY: "on it", OPENOVAI_STAND_IN_CALLS: CALLS });
    client = await listen();
    await until(client, (event) => event.name === "asking");
  });

  after(async () => {
    for (const opened of open.splice(0)) {
      opened.close();
    }
    await endEvery(500);
  });

  // The rows a turn wrote on a seat's panel: everything after `from`, once the reply is there.
  async function turn(seat, from, text) {
    await page("POST", `/sessions/${seat}/message`, { text });
    await waitFor(() => {
      const last = panel(instance, seat).at(-1);
      return panel(instance, seat).length > from && last.from === seat && typeof last.text === "string" ? true : null;
    });
    return panel(instance, seat).slice(from);
  }

  it("writes one line per call on the Worker's panel as it is made, before the reply: the summary and the call, never the input", async () => {
    const rows = await turn(WORKER, 0, "go");
    assert.deepEqual(rows.map((row) => row.from), ["user", WORKER, WORKER, WORKER]);
    assert.deepEqual(rows.map((row) => row.line), [undefined, "Reading /srv/app/lib/chat/session.mjs", "Run the suite", undefined]);
    assert.deepEqual(rows.map((row) => row.call), [undefined, "call-1-0", "call-1-1", undefined]);
    assert.deepEqual(rows.map((row) => row.text), ["go", undefined, undefined, "on it"]);
    for (const row of rows.slice(1, 3)) {
      assert.deepEqual(Object.keys(row).filter((key) => !["at", "from", "line", "call", "err", "why"].includes(key)), [], JSON.stringify(row));
      assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.equal(rows[1].err, undefined, "a call that went well carries no flag");
  });

  it("marks the line of a call that failed, in the file and on the stream, with the first line its result said as the reason", async () => {
    const rows = panel(instance, WORKER);
    assert.equal(rows[2].line, "Run the suite");
    assert.equal(rows[2].err, true);
    assert.equal(rows[2].why, "Exit code 1", "the reason is the first line with anything on it, trimmed");
    assert.equal(rows[1].err, undefined);
    assert.equal(rows[1].why, undefined);
    // The page was told the row twice: as the line was written, and again — at the same index,
    // marked and explained — as its result came back.
    await until(client, (event) => event.name === "row" && event.data.seat === WORKER && event.data.index === 2 && event.data.row.err === true);
    const told = about(client, WORKER, "row").filter((event) => event.data.index === 2).map((event) => [event.data.row.line, event.data.row.err, event.data.row.why]);
    assert.deepEqual(told, [["Run the suite", undefined, undefined], ["Run the suite", true, "Exit code 1"]]);
    // The reply came after the mark, so a page drawing the file draws the line red from the start.
    const indexes = about(client, WORKER, "row").map((event) => [event.data.index, event.data.row.err ?? event.data.row.text ?? event.data.row.line]);
    assert.deepEqual(indexes, [[0, "go"], [0, "go"], [1, "Reading /srv/app/lib/chat/session.mjs"], [2, "Run the suite"], [2, true], [3, "on it"]], "the User's row is told twice, typed and delivered, before anything the seat did");
  });

  it("writes no line for the Leader's own calls", async () => {
    // The Leader's panel already holds what was typed to the Worker and what the Leader made of it.
    const rows = await turn(LEADER, panel(instance, LEADER).length, "go");
    assert.deepEqual(rows.map((row) => [row.from, row.text]), [["user", "go"], [LEADER, "noted"]]);
    assert.ok(rows.every((row) => row.line === undefined && row.call === undefined), JSON.stringify(rows));
  });

  // The log takes every seat's calls, the Leader's included — with the path or the command whole,
  // which the panel never shows — and a call that failed with the reason its result gave.
  it("logs every seat's calls, the Leader's included, and a failed one with its reason", async () => {
    const lines = said.slice(logged).filter((line) => line.startsWith(`called: ${LEADER} `) || line.startsWith(`failed: ${LEADER} `));
    // The Leader's second turn: its first was the event that the Worker had been typed to.
    assert.deepEqual(lines, [
      `called: ${LEADER} Read /srv/app/lib/chat/session.mjs (call-2-0)`,
      `called: ${LEADER} Bash: npm test (call-2-1)`,
      `failed: ${LEADER} call-2-1: Exit code 1`,
    ]);
    assert.ok(said.slice(logged).includes(`called: ${WORKER} Read /srv/app/lib/chat/session.mjs (call-1-0)`), "the Worker's call is drawn but not logged");
  });

  it("draws nothing for a search of the tool list or a session's own stop", async () => {
    const rows = await turn(WORKER, panel(instance, WORKER).length, "again");
    assert.deepEqual(rows.map((row) => [row.from, row.text]), [["user", "again"], [WORKER, "on it"]]);
    assert.ok(rows.every((row) => row.line === undefined), JSON.stringify(rows));
    assert.deepEqual(await told(paul.log, 2), ["<user>go</user>", "<user>again</user>"]);
  });

  it("draws nothing for a call made under another call", async () => {
    const rows = await turn(WORKER, panel(instance, WORKER).length, "delegate");
    assert.deepEqual(rows.map((row) => [row.from, row.text]), [["user", "delegate"], [WORKER, "on it"]]);
    assert.ok(rows.every((row) => row.line === undefined), JSON.stringify(rows));
  });

  it("writes two entries for two identical calls: the merge into one line is the page's", async () => {
    const rows = await turn(WORKER, panel(instance, WORKER).length, "twice");
    assert.deepEqual(rows.map((row) => row.line), [undefined, "Reading /srv/app/lib/chat/session.mjs", "Reading /srv/app/lib/chat/session.mjs", undefined]);
    assert.deepEqual(rows.map((row) => row.call), [undefined, "call-4-0", "call-4-1", undefined]);
    const shown = JSON.parse((await page("GET", `/sessions/${WORKER}/messages?since=8`)).body).messages;
    assert.deepEqual(shown, rows, "the page is served the file as it is");
  });
});

// ---------------------------------------------------------------------------------------------

// What a seat says is on its panel as it says it — every text block of a turn, the moment the
// process says it, and not once the turn is over: a Leader that says "hiring somebody for this"
// before a long call is read while the call runs. What is left for the end of the turn is how it
// ended when that was not with words: a run that said nothing at all, a run that failed, a turn
// the page stopped.
describe("what a seat says", () => {
  let paul;

  after(async () => {
    await endEvery(500);
  });

  it("lands on the panel as it is said, before the turn ends", async () => {
    remove(panelFile(instance, WORKER));
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_NOISE: "1", OPENOVAI_STAND_IN_SLOW: "400", OPENOVAI_STAND_IN_REPLY: "done" });
    const told_ = tell(WORKER, userFrame("go")).answered;
    const early = await waitFor(() => panel(instance, WORKER).find((row) => row.from === WORKER) ?? null);
    assert.deepEqual([early.from, early.text], [WORKER, "thinking"], "the first text of the turn is not on the panel");
    assert.equal(panel(instance, WORKER).length, 1, "more than the first text landed before the wait");
    const reply = await told_;
    assert.deepEqual(reply, { text: "done", failed: false, silent: false });
    assert.deepEqual(panel(instance, WORKER).map((row) => [row.from, row.text]), [[WORKER, "thinking"], [WORKER, "done"]]);
    assert.equal(heardIn(paul.log).length, 1);
  });

  it("is silent only when it said nothing in the whole turn, not when its last words were none", async () => {
    await endSeat(WORKER, 500);
    remove(panelFile(instance, WORKER));
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_NOISE: "1", OPENOVAI_STAND_IN_EMPTY: "1" });
    const reply = await tell(WORKER, userFrame("go")).answered;
    assert.deepEqual(reply, { text: "", failed: false, silent: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(panel(instance, WORKER).map((row) => [row.from, row.text, row.silent]), [[WORKER, "thinking", undefined]]);
  });
});

// ---------------------------------------------------------------------------------------------

// Only one module writes to a session's stdin, and only in the places that put a frame or a
// permission answer there. Read off the code, because the rule is about the code.
// ---------------------------------------------------------------------------------------------

// What the page is made of, beside the script: the modules it draws from, served open beside it,
// the manifest an installed page carries, and what the page never says or loads. The page script
// is read as text and never run here; what a browser alone can show is measured, not claimed.
describe("what the page is made of", () => {
  const source = fs.readFileSync(path.join(repo, "lib", "chat", "page.html"), "utf8");
  const opened = source.indexOf('<script type="module">');
  const script = source.slice(opened, source.indexOf("</script>", opened));
  const modules = ["panels.mjs", "render.mjs"].map((name) => [name, fs.readFileSync(path.join(repo, "lib", "chat", name), "utf8")]);

  it("draws from the two tested modules and the dialog module", () => {
    assert.match(script, /import \{[^}]*\bapplyEvent\b[^}]*\bplace\b[^}]*\} from "\.\/panels\.mjs"/);
    assert.match(script, /import \{[^}]*\brow as rowOf\b[^}]*\} from "\.\/render\.mjs"/);
    assert.match(script, /import \{ dialogOf \} from "\.\/dialog\.mjs"/);
    assert.match(script, /place\(/);
    assert.match(script, /rowOf\(/);
  });

  it("serves each module and the parser open, as the file, and nothing else on those routes", async () => {
    for (const name of ["dialog.mjs", "panels.mjs", "render.mjs", "marked.mjs"]) {
      const answered = await fetchPlain(`${url}/${name}`);
      assert.equal(answered.status, 200, name);
      assert.equal(answered.body, fs.readFileSync(path.join(repo, "lib", "chat", name), "utf8"), name);
    }
    assert.equal((await fetchPlain(`${url}/server.mjs`)).status, 401);
    assert.equal((await fetchPlain(`${url}/icons/other.png`)).status, 401);
  });

  it("installs as a standalone app: a manifest with three icons that are PNGs of the size they say, one of them maskable, and no service worker", async () => {
    const answered = await fetchPlain(`${url}/manifest.webmanifest`);
    assert.equal(answered.status, 200);
    const manifest = JSON.parse(answered.body);
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.name, "OpenOv AI");
    assert.equal(manifest.icons.length, 3);
    for (const icon of manifest.icons) {
      const image = await fetch(`${url}${icon.src}`);
      assert.equal(image.status, 200, icon.src);
      assert.equal(image.headers.get("content-type"), "image/png", icon.src);
      assert.equal(icon.type, "image/png", icon.src);
      const bytes = new Uint8Array(await image.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], icon.src);
      // The IHDR chunk is always first: width and height are the big-endian words at 16 and 20.
      const view = new DataView(bytes.buffer);
      assert.equal(`${view.getUint32(16)}x${view.getUint32(20)}`, icon.sizes, icon.src);
    }
    // One icon is for a mask: an installed app on a platform that cuts icons to its own shape
    // uses it, full-bleed at 512, and is not letterboxed; the other two are for any use.
    assert.deepEqual(manifest.icons.map((icon) => icon.purpose), ["any", "any", "maskable"]);
    assert.equal(manifest.icons[2].sizes, "512x512");
    assert.match(source, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.ok(!source.includes("serviceWorker"));
  });

  it("carries no lifecycle button and no lifecycle word, and the stop glyph is its one lifecycle control", () => {
    const { words } = JSON.parse(fs.readFileSync(path.join(repo, "tests", "forbidden-words.json"), "utf8"));
    for (const [name, text] of [["page.html", source], ...modules]) {
      for (const word of words) {
        const found = new RegExp(`\\b${word.replace(/ /g, "\\s+")}`, "i").exec(text);
        assert.equal(found, null, `${name} carries "${word}": ${found !== null ? text.slice(Math.max(0, found.index - 40), found.index + 40) : ""}`);
      }
    }
    const labels = [...script.matchAll(/\.textContent = "([^"]*)"/g)].map((found) => found[1]);
    assert.deepEqual(labels, ["Waiting for the transcript…", "↓ new messages"], "a word of the page's own other than the empty state and the pill (the dialog buttons come from dialog.mjs)");
    const buttons = [...script.matchAll(/\.className = "(stop|theme)";/g)].map((found) => found[1]);
    assert.deepEqual(buttons, ["theme", "stop"], "a button of the page's own other than the theme toggle and the stop glyph");
    assert.equal(source.split("<button").length - 1, 0, "a button in the markup");
  });

  it("never reads how a process is going: no ending on the page or in panels.mjs, no running read on the page", () => {
    assert.doesNotMatch(source, /\bending\b/);
    assert.doesNotMatch(modules[0][1], /\bending\b/);
    assert.doesNotMatch(source, /\.running\b/);
  });

  it("loads nothing from outside the server and prompts for nothing of its own", () => {
    assert.doesNotMatch(source, /(src|href)="https?:\/\//);
    assert.doesNotMatch(source, /Notification\.requestPermission/);
    assert.doesNotMatch(source, /serviceWorker/);
    assert.doesNotMatch(source, /import\s*\(|from "https?:/);
  });

  it("answers a panel's rows from an index on", async () => {
    remove(panelFile(instance, OTHER));
    const { append: appendRow } = await import("../lib/chat/conversation.mjs");
    for (const text of ["one", "two", "three"]) {
      appendRow(instance, OTHER, { from: "user", text });
    }
    const all = JSON.parse((await page("GET", `/sessions/${OTHER}/messages`)).body).messages;
    assert.deepEqual(all.map((row) => row.text), ["one", "two", "three"]);
    const rest = JSON.parse((await page("GET", `/sessions/${OTHER}/messages?since=2`)).body).messages;
    assert.deepEqual(rest.map((row) => row.text), ["three"]);
    assert.deepEqual(JSON.parse((await page("GET", `/sessions/${OTHER}/messages?since=9`)).body).messages, []);
  });
});

// ---------------------------------------------------------------------------------------------

// The stream: the page is told what happens as it happens, on one connection, and asks for what
// it missed with the counts it has. Read here with fetch on the body, the way a browser's
// EventSource would read it, except that a browser sends no header — which is why the secret is
// on the query of this one route (measured: the check below sends the bearer and is refused).
describe("the stream", () => {
  let superman;
  let paul;

  before(async () => {
    remove(panelFile(instance, LEADER), panelFile(instance, WORKER), panelFile(instance, OTHER));
    superman = await seatUp(LEADER, { OPENOVAI_STAND_IN_REPLY: "noted" });
  });

  after(async () => {
    for (const client of open) {
      client.close();
    }
    chat.stopping = false;
    await endEvery(500);
  });

  it("opens to the page secret on its query, and to nothing else — not even the bearer", async () => {
    const bare = await fetch(`${url}/events`);
    assert.equal(bare.status, 401);
    const bearer = await fetch(`${url}/events`, { headers: { authorization: `Bearer ${pageSecret()}` } });
    assert.equal(bearer.status, 401);
    const client = await listen();
    assert.equal(client.status, 200);
    assert.match(client.type, /^text\/event-stream/);
    await until(client, (event) => event.name === "asking");
    const names = client.events.map((event) => event.name);
    assert.equal(names[0], "snapshot");
    assert.deepEqual(names.slice(1), ["rows", "rows", "rows", "asking", "asking", "asking"]);
    assert.deepEqual(client.events.map((event) => event.id), [1, 2, 3, 4, 5, 6, 7]);
    const { data } = client.events[0];
    assert.equal(data.user, USER);
    assert.equal(data.leader, LEADER);
    assert.equal(data.chat, SERVER);
    assert.deepEqual(data.sessions.map((seat) => [seat.name, seat.running, seat.busy]), [[LEADER, true, false], [OTHER, false, false], [WORKER, false, false]]);
    assert.deepEqual(client.events[1].data, { seat: LEADER, since: 0, rows: [] });
    assert.ok(!said.some((line) => line.includes("page=")), "the stream's URL was logged");
  });

  it("a new row reaches the page without a poll", async () => {
    const client = await listen();
    await until(client, (event) => event.name === "asking");
    await page("POST", `/sessions/${LEADER}/message`, { text: "hello" });
    await until(client, (event) => event.name === "row" && event.data.seat === LEADER && event.data.row.from === LEADER);
    const rows = about(client, LEADER, "row");
    // The User's row twice at its index: once as it was typed, once more once its frame went in.
    assert.deepEqual(rows.map((event) => [event.data.index, event.data.row.from, event.data.row.text, event.data.row.delivered]), [[0, "user", "hello", undefined], [0, "user", "hello", true], [1, LEADER, "noted", undefined]]);
  });


  it("a client connecting with counts gets only the rows after them", async () => {
    const client = await listen(`&since=${encodeURIComponent(`${LEADER}:1`)}`);
    await until(client, (event) => event.name === "asking");
    const rows = about(client, LEADER, "rows")[0].data;
    assert.equal(rows.since, 1);
    assert.deepEqual(rows.rows.map((row) => row.text), ["noted"]);
  });

  it("tells of a seat's process starting, a turn under way and over, and the process gone", async () => {
    const client = await listen();
    await until(client, (event) => event.name === "asking");
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_REPLY: "on it" });
    await until(client, (event) => event.name === "seat" && event.data.name === WORKER && event.data.running === true);
    await page("POST", `/sessions/${WORKER}/message`, { text: "go" });
    await until(client, (event) => event.name === "row" && event.data.seat === WORKER && event.data.row.from === WORKER);
    const busy = about(client, WORKER).map((event) => [event.data.running, event.data.busy]);
    assert.deepEqual(busy.slice(0, 3), [[true, false], [true, true], [true, false]], JSON.stringify(busy));
    await end(WORKER, 500);
    await until(client, (event) => event.name === "seat" && event.data.name === WORKER && event.data.running === false);
    assert.ok(client.events.every((event) => ["snapshot", "rows", "asking", "row", "seat"].includes(event.name)));
  });

  it("a restart of seconds is two seat events, gone then back, and nothing else for the page", async () => {
    const client = await listen();
    await until(client, (event) => event.name === "asking");
    paul = await seatUp(WORKER, {
      OPENOVAI_STAND_IN_TOOL: JSON.stringify([
        { name: "write_desk", arguments: { title: "restart by the stand-in", status: "going", body: "## State\nx\n" } },
        { name: "restart_session", arguments: {} },
      ]),
    });
    const first = paul.secret;
    const spawned = secretsIn(unarranged).length;
    await page("POST", `/sessions/${WORKER}/message`, { text: "go" });
    await until(client, (event) => event.name === "seat" && event.data.name === WORKER && event.data.running === false);
    await until(client, (event) => event.name === "seat" && event.data.name === WORKER && event.data.running === true && about(client, WORKER).some((seen) => seen.data.running === false));
    // The successor is the chat's own spawn: a new process under a new secret, in the log nobody
    // arranged for it, and running.
    const successor = await waitFor(() => secretsIn(unarranged)[spawned] ?? null);
    assert.notEqual(successor, null, `no successor was started for ${WORKER}`);
    assert.notEqual(successor, first);
    assert.equal(running(WORKER), true);
    const flags = about(client, WORKER).map((event) => event.data.running);
    assert.ok(flags.indexOf(false) < flags.lastIndexOf(true), JSON.stringify(flags));
    assert.ok(client.events.every((event) => ["snapshot", "rows", "asking", "row", "seat"].includes(event.name)));
    await end(WORKER, 500);
  });

  it("the page's stop glyph interrupts the turn, and the row says so rather than the seat", async () => {
    const client = await listen();
    await until(client, (event) => event.name === "asking");
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_SLOW: "4000", OPENOVAI_STAND_IN_REPLY: "late" });
    await page("POST", `/sessions/${WORKER}/message`, { text: "slowly" });
    await until(client, (event) => event.name === "seat" && event.data.name === WORKER && event.data.busy === true);
    const stopped = await page("POST", `/sessions/${WORKER}/stop`);
    assert.deepEqual(JSON.parse(stopped.body), { interrupted: true });
    await until(client, (event) => event.name === "row" && event.data.seat === WORKER && event.data.row.from === WORKER);
    // The seat's own row; the chat's line about the queue follows it.
    const row = about(client, WORKER, "row").findLast((event) => event.data.row.from === WORKER).data.row;
    assert.equal(row.interrupted, true);
    assert.equal(row.text, "interrupted");
    await until(client, (event) => event.name === "row" && event.data.seat === WORKER && event.data.row.text === "stopped; nothing waiting");
    await until(client, (event) => event.name === "seat" && event.data.name === WORKER && event.data.busy === false && about(client, WORKER).some((seen) => seen.data.busy === true));
    await end(WORKER, 500);
  });

  // A seat with a queue is busy again the moment it is stopped — with the next frame, which may be
  // older than the press. The panel says so under the stop: how many wait and which goes in next —
  // here the User's own line, typed after a colleague's message and ahead of it.
  it("a stop says on the panel how many wait and what goes in next, with when it was told", async () => {
    const client = await listen();
    await until(client, (event) => event.name === "asking");
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_SLOW: "4000", OPENOVAI_STAND_IN_REPLY: "late" });
    const from = panel(instance, WORKER).length;
    try {
      await page("POST", `/sessions/${WORKER}/message`, { text: "slowly" });
      await until(client, (event) => event.name === "seat" && event.data.name === WORKER && event.data.busy === true);
      tell(WORKER, messageFrame(OTHER, "from a colleague"));
      await page("POST", `/sessions/${WORKER}/message`, { text: "and this" });
      const stopped = await page("POST", `/sessions/${WORKER}/stop`);
      assert.deepEqual(JSON.parse(stopped.body), { interrupted: true });
      const rows = panel(instance, WORKER).slice(from);
      const said_ = rows.findIndex((row) => row.from === SERVER && row.text.startsWith("stopped;"));
      assert.notEqual(said_, -1, JSON.stringify(rows.map((row) => row.text)));
      assert.match(rows[said_].text, /^stopped; 2 waiting, next: line from the User \(\d{2}:\d{2}\)$/);
      assert.ok(rows.slice(0, said_).some((row) => row.interrupted === true), "the stop's own row is not above the line about the queue");
    } finally {
      await end(WORKER, 500);
    }
  });

  it("a stop with no turn under way says so on the panel and in the log, and answers interrupted false", async () => {
    const client = await listen();
    await until(client, (event) => event.name === "asking");
    paul = await seatUp(WORKER);
    try {
      const before_ = said.length;
      const stopped = await page("POST", `/sessions/${WORKER}/stop`);
      assert.deepEqual(JSON.parse(stopped.body), { interrupted: false });
      const row = panel(instance, WORKER).at(-1);
      assert.deepEqual([row.from, row.text], [SERVER, "no turn to stop"]);
      assert.ok(said.slice(before_).includes(`no turn to stop: ${WORKER}`), said.slice(before_).join("\n"));
    } finally {
      await end(WORKER, 500);
    }
  });

  // A row typed while a turn is under way waits: the stream says it is there, and says it is
  // delivered only once the turn before it has answered and its frame has gone in.
  it("a row typed behind a turn under way is told again as delivered only once that turn is over", async () => {
    const client = await listen();
    await until(client, (event) => event.name === "asking");
    paul = await seatUp(WORKER, { OPENOVAI_STAND_IN_SLOW: "600", OPENOVAI_STAND_IN_REPLY: "done" });
    await page("POST", `/sessions/${WORKER}/message`, { text: "first" });
    await page("POST", `/sessions/${WORKER}/message`, { text: "second" });
    await until(client, (event) => event.name === "row" && event.data.seat === WORKER && event.data.row.text === "second");
    const typed = () => about(client, WORKER, "row").filter((event) => event.data.row.from === "user").map((event) => [event.data.row.text, event.data.row.delivered]);
    assert.deepEqual(typed(), [["first", undefined], ["first", true], ["second", undefined]], "the second row read delivered while the first turn was still under way");
    await until(client, (event) => event.name === "row" && event.data.seat === WORKER && event.data.row.text === "second" && event.data.row.delivered === true);
    const replies = about(client, WORKER, "row").filter((event) => event.data.row.from === WORKER).length;
    assert.equal(replies, 1, "the second frame went in before the first turn had answered, or after the second had");
    await until(client, (event) => event.name === "seat" && event.data.name === WORKER && event.data.busy === false && about(client, WORKER, "row").filter((event) => event.data.row.from === WORKER).length === 2);
    await end(WORKER, 500);
  });

  it("a call stop is pushed as it is parked, and taken down as it is answered", async () => {
    const client = await listen();
    await until(client, (event) => event.name === "asking");
    const jane = await seatUp(OTHER, { OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_ASKS_INPUT: "git status", OPENOVAI_STAND_IN_ASKS_WAITS: "10000" });
    assert.notEqual(jane.secret, undefined);
    await page("POST", `/sessions/${OTHER}/message`, { text: "look" });
    await until(client, (event) => event.name === "asking" && event.data.seat === OTHER && event.data.pending.length === 1);
    const asked = about(client, OTHER, "asking").at(-1).data.pending[0];
    assert.equal(asked.tool, "Bash");
    assert.deepEqual(asked.input, { command: "git status" });
    // The take-down has to be an asking event AFTER the one that listed the stop: the stream opened
    // with an empty list for this seat, and that one must not count.
    const listed = about(client, OTHER, "asking").length;
    await page("POST", `/sessions/${OTHER}/permission`, { id: asked.id, decision: "allow" });
    await until(client, () => about(client, OTHER, "asking").length > listed && about(client, OTHER, "asking").at(-1).data.pending.length === 0);
    await end(OTHER, 500);
  });

  // A card that was answered leaves no row of its own, so a turn that stood still on one reads,
  // afterwards, as a run that took that long. The wait is written down at both ends in the log;
  // the panel says how long it was only once it is a gap worth explaining (ten seconds, checked on
  // the injected clock in lifecycle.test.mjs) — a card answered at once, as here, draws no row.
  it("a permission wait is logged as asked and answered, and one answered at once draws no row", async () => {
    const client = await listen();
    await until(client, (event) => event.name === "asking");
    const jane = await seatUp(OTHER, { OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_ASKS_INPUT: "git status", OPENOVAI_STAND_IN_ASKS_WAITS: "10000" });
    assert.notEqual(jane.secret, undefined);
    const logged = said.length;
    const from = panel(instance, OTHER).length;
    try {
      await page("POST", `/sessions/${OTHER}/message`, { text: "look" });
      await until(client, (event) => event.name === "asking" && event.data.seat === OTHER && event.data.pending.length === 1);
      assert.ok(said.slice(logged).includes(`permission asked: ${OTHER} Bash: git status`), said.slice(logged).join("\n"));
      assert.ok(!said.slice(logged).some((line) => line.startsWith("permission answered:")), "answered before anybody did");
      const asked = about(client, OTHER, "asking").at(-1).data.pending[0];
      await page("POST", `/sessions/${OTHER}/permission`, { id: asked.id, decision: "allow" });
      const answered = await waitFor(() => said.slice(logged).find((line) => line.startsWith("permission answered:")) ?? null);
      assert.match(answered ?? "", new RegExp(`^permission answered: ${OTHER} allow after \\d+ s$`));
      // The row, when there is one, is appended in the same step as the answered line — so once
      // that line is in the log, a missing row is missing for good.
      assert.equal(panel(instance, OTHER).slice(from).find((one) => one.from === SERVER && one.text.startsWith("waited ")), undefined, "a wait of no time drew a row");
    } finally {
      await end(OTHER, 500);
    }
  });

  it("the Leader's close is told like anybody's, and nothing follows it for the Leader", async () => {
    const client = await listen();
    await until(client, (event) => event.name === "asking");
    await end(LEADER, 500);
    await until(client, (event) => event.name === "seat" && event.data.name === LEADER && event.data.running === false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(about(client, LEADER).at(-1).data.running, false);
    assert.equal(running(LEADER), false);
  });

  it("the page is told the instance is stopping, and every page route answers 503 from then on", async () => {
    const client = await listen();
    await until(client, (event) => event.name === "asking");
    const { stopping } = await import("../lib/chat/lifecycle.mjs");
    stopping(chat);
    await until(client, (event) => event.name === "stopping");
    assert.equal((await page("POST", `/sessions/${LEADER}/message`, { text: "x" })).status, 503);
    assert.equal((await fetch(`${url}/events?page=${pageSecret()}`)).status, 503);
    chat.stopping = false;
  });
});

describe("who writes to a session", () => {
  it("is session.mjs, through the frame writer, the two permission answers and the interrupt, and nobody else", () => {
    const found = spawnSync("grep", ["-rn", "stdin.write", path.join(repo, "lib")], { encoding: "utf8" });
    const lines = found.stdout.trim().split("\n");
    assert.equal(lines.length, 4, found.stdout);
    for (const line of lines) {
      assert.match(line, /^.*lib\/chat\/session\.mjs:\d+:/, line);
    }
  });
});

// ---------------------------------------------------------------------------------------------

// The chat as a person starts it: a process of its own, whose secrets die with it.
describe("the chat as a process", () => {
  const own = `${base}-own`;
  let child = null;
  let address = null;
  let firstPage = null;

  before(async () => {
    remove(own);
    installed(options(own));
    child = startChat(own, process.env);
    address = await waitForAddress(child);
    assert.ok(address, `the chat never said where it was listening:\n${child.output}`);
  });

  after(async () => {
    await stopChat(child);
    remove(own);
  });

  function secretIn(pageText) {
    return /<meta name="openovai-secret" content="([^"]*)">/.exec(pageText)[1];
  }

  // The one line a start says: the address. Not the instruction files above the instance — every
  // session is started with that list whether or not anybody read it here — and not the quota
  // windows, which have a default each.
  it("says where it listens, and nothing else", () => {
    assert.equal(child.output.trim(), `Serving ${own} at ${address}`);
  });

  it("hands the page a secret that opens the page routes", async () => {
    firstPage = secretIn((await fetchPlain(`${address}/`)).body);
    assert.match(firstPage, SECRET_SHAPE);
    const answered = await fetch(`${address}/sessions`, { headers: { authorization: `Bearer ${firstPage}` } });
    assert.equal(answered.status, 200);
  });

  it("prints no request and no secret, whatever the page or a caller asks for", async () => {
    await postPlain(`${address}/mcp/${firstPage}`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await fetch(`${address}/sessions`, { headers: { authorization: `Bearer ${firstPage}` } });
    await fetch(`${address}/events?page=not-the-secret`);
    assert.doesNotMatch(child.output, /^(GET|POST) /m, child.output);
    assert.ok(!child.output.includes(firstPage), "the page secret is in the output");
  });

  it("starts with nothing when started again: the page secret of the last run opens nothing", async () => {
    await stopChat(child);
    assert.equal(child.exitCode, 0, `the chat did not stop cleanly:\n${child.output}`);
    child = startChat(own, process.env);
    address = await waitForAddress(child);
    assert.ok(address, `the chat never came back:\n${child.output}`);
    const answered = await fetch(`${address}/sessions`, { headers: { authorization: `Bearer ${firstPage}` } });
    assert.equal(answered.status, 401);
    const secondPage = secretIn((await fetchPlain(`${address}/`)).body);
    assert.notEqual(secondPage, firstPage);
    assert.equal((await fetch(`${address}/sessions`, { headers: { authorization: `Bearer ${secondPage}` } })).status, 200);
  });
});
