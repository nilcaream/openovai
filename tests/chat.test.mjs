// tests/chat.test.mjs — start the chat server, talk to it, stop it.
//
// It needs Node.js and nothing else. Claude Code is never really run: the stand-in from
// helpers.mjs answers in the shape the real one answers in, which keeps the suite
// deterministic and lets it check the parts that are ours — the arguments a session is run
// with, the thread being resumed, and what the transcript says when Claude Code is missing
// altogether.
//
// A worker is hired into the instance before anything else runs, because the interesting
// question about a chat that hosts more than one session is whether two of them stay apart.
//
// It reaches the server through tools/ow.mjs rather than bin/ow, because bin/ow refuses to run
// without Claude Code installed, which is the right behaviour for a person and the wrong one
// for this suite.
//
// Run it with: node --test tests/chat.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  alive,
  callsIn,
  heardIn,
  pidsIn,
  shellsIn,
  get,
  installed,
  post,
  readLog,
  remove,
  repo,
  runTool,
  runToolLater,
  scratch,
  standInEnvironment,
  startChat,
  stopChat,
  stuckRunsIn,
  waitFor,
  waitForAddress,
  waitForHealth,
  writeStandIn,
  driveStandIn,
} from "./helpers.mjs";

// The reader this suite checks directly. No route says this number, and a check that read the
// file itself would pass with nothing written at all.
import { ranAt } from "../tools/chat/session.mjs";

// The kinds themselves, read from where they are named rather than written out again here. Two
// copies of a list are two things that drift, and a check comparing what it saw against its own
// copy would agree with itself for good while the chat grew a fifth kind nobody reached.
import { KINDS } from "../tools/chat/unfinished.mjs";

// The states a room can say, for the same reason: the list is the check's other source, and a copy
// of it here would be a list that agrees with itself while the room learned a seventh state nobody
// had ever been in.
import { STATES } from "../tools/chat/room.mjs";

const HUMAN = "Mike";
const LEADER = "Superman";
const LEADER_MODEL = "sonnet";
const WORKER_MODEL = "haiku";
const WORKER = "Paul";

// A port nobody else on this machine is likely to be holding.
const PORT = 20000 + (process.pid % 20000);
const URL = `http://127.0.0.1:${PORT}`;

const instance = scratch("chat-test");
const chosen = `${instance}-chosen`;

// An instance no chat is ever started for, so the checks about not reaching one have somewhere
// to run that cannot disturb the chat the rest of the suite is talking to.
const quiet = `${instance}-quiet`;

// An instance a couple of directories down, so the sweep over what sits above it has a parent
// this suite owns. The directory the other instances are installed in is shared with whatever
// else is running, and is nowhere to be dropping a CLAUDE.md.
const nested = `${instance}-owned`;
const owned = path.join(nested, "deep", "instance");
const overhead = path.dirname(owned);
const standIn = `${instance}-stand-in`;
const log = path.join(standIn, "calls.txt");

let server;

process.on("exit", () => {
  server?.kill();
  remove(instance, chosen, quiet, nested, standIn);
});

after(async () => {
  await stopChat(server);
});

function options(root, port) {
  return {
    "--root": root,
    "--source": repo,
    "--human": HUMAN,
    "--leader": LEADER,
    "--leader-model": LEADER_MODEL,
    "--worker-model": WORKER_MODEL,
    "--port": port,
    "--auth": "login",
  };
}

function say(text, to = LEADER) {
  return post(`${URL}/sessions/${to}/message`, { text });
}

// Put an address in an instance nothing is serving, so a check can ask what happens when the
// chat that wrote one is not there any more. The directory is made here because an instance only
// grows a chat/ once something has served it.
function pretendChatAt(root, url) {
  const target = path.join(root, "chat", "listening.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ url, pid: 1, since: new Date().toISOString() }, null, 2)}\n`);
}

function transcriptOf(name) {
  return get(`${URL}/sessions/${name}/messages`);
}

// A call to the tools the chat serves, posted to the door a session is given. The name in the
// path is who the caller IS — the chat puts it there — which is what lets a check post as a
// session at all.
function call(as, method, params) {
  return post(`${URL}/mcp/${as}`, {
    jsonrpc: "2.0",
    id: 1,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

// What a tool call answered, in the three shapes a caller has to tell apart: what it said, and
// whether it was a refusal — which is an answer — or a protocol error, which is not.
function answerOf(said) {
  const body = JSON.parse(said.body);
  return {
    text: body.result?.content?.[0]?.text,
    refused: body.result?.isError === true,
    error: body.error ?? null,
  };
}

// The stand-in's log, whole entries rather than lines. A question can carry what a session
// overheard and what it is asked about its desk in front of it, so an entry runs to several lines
// and anything line-based sees only the first of them. The log is split on the lines that begin an
// entry, which is the only place a new one can start.
function entriesIn(log) {
  return readLog(log)
    .split(/^(?=(?:call|pid|heard|told|said|shell|answered|stdin|left): )/m)
    .map((entry) => entry.trimEnd());
}

// Every question the stand-in was handed, whole.
function questionsIn(log) {
  return entriesIn(log)
    .filter((entry) => entry.startsWith("heard: "))
    .map((entry) => entry.slice("heard: ".length));
}

async function start(root, environment) {
  await stopChat(server);
  server = startChat(root, environment);
  return server;
}

remove(instance, chosen, quiet, nested, standIn);
const standInCommand = writeStandIn(standIn);
installed(options(instance, PORT));
installed(options(quiet, 0));
runTool(instance, ["hire", WORKER], process.env);

const standIns = standInEnvironment(standIn, log);

// What the chat puts in a session's environment, so a check can run the command the way a session
// runs it: signed with the name of whoever is speaking.
const asLeader = standInEnvironment(standIn, log, { OW_SESSION_NAME: LEADER });
const asWorker = standInEnvironment(standIn, log, { OW_SESSION_NAME: WORKER });
await start(instance, standIns);
assert.ok(await waitForHealth(URL), "the server never answered");

describe("what the chat serves", () => {
  it("names the instance in its health", async () => {
    assert.ok((await get(`${URL}/health`)).body.includes(instance));
  });

  it("names the leader in its health", async () => {
    assert.ok((await get(`${URL}/health`)).body.includes(LEADER));
  });

  it("serves a page with something to type in", async () => {
    assert.ok((await get(`${URL}/`)).body.includes('composer.className = "composer"'));
  });

  it("answers 404 where there is nothing", async () => {
    assert.equal((await get(`${URL}/nowhere`)).status, 404);
  });
});

// An instance installed with --port 0 has no address until the server has bound one, so the
// server writes down where it ended up. Everything in the instance that has to reach the chat
// reads it there.
describe("where the chat says it is listening", () => {
  let recorded;

  before(() => {
    recorded = JSON.parse(fs.readFileSync(path.join(instance, "chat", "listening.json"), "utf8"));
  });

  it("records the address it is serving on", () => {
    assert.equal(recorded.url, URL);
  });

  it("records which process is serving it", () => {
    assert.equal(recorded.pid, server.pid);
  });

  it("says when it started listening", () => {
    assert.match(recorded.since, /^\d{4}-\d{2}-\d{2}T/);
  });
});

// A desk is a person, so what the chat can host is read from work/ rather than registered
// anywhere. Everybody with a desk gets a panel.
describe("who the chat can host", () => {
  let listed;

  before(async () => {
    listed = JSON.parse((await get(`${URL}/sessions`)).body).sessions;
  });

  it("hosts the lead", () => {
    assert.ok(listed.some((session) => session.name === LEADER));
  });

  it("hosts a worker who has been hired", () => {
    assert.ok(listed.some((session) => session.name === WORKER));
  });

  it("puts the lead first", () => {
    assert.equal(listed[0].name, LEADER);
  });

  it("says which of them leads", () => {
    assert.equal(listed.find((session) => session.name === LEADER).role, "lead");
  });

  it("says the others are workers", () => {
    assert.equal(listed.find((session) => session.name === WORKER).role, "worker");
  });

  it("says which model the lead runs on", () => {
    assert.equal(listed.find((session) => session.name === LEADER).model, LEADER_MODEL);
  });

  it("says which model a worker runs on", () => {
    assert.equal(listed.find((session) => session.name === WORKER).model, WORKER_MODEL);
  });

  it("will not open a conversation with somebody who does not work here", async () => {
    assert.equal((await say("hello", "Nobody")).status, 404);
  });
});

describe("a worker answers on its own panel", () => {
  before(async () => {
    await say("what are you working on", WORKER);
  });

  it("keeps the worker's message in the worker's transcript", async () => {
    assert.ok((await transcriptOf(WORKER)).body.includes("what are you working on"));
  });

  // The lead does now hear this, as the chat's own overheard line further down. What has to stay
  // true is that the message itself went to one session: the lead was never asked it.
  it("does not deliver that message to the lead as well", async () => {
    const { messages } = JSON.parse((await transcriptOf(LEADER)).body);
    assert.ok(!messages.some((message) => message.from === "human" && message.text.includes("what are you working on")));
  });

  it("runs the worker on the model workers were installed for", () => {
    assert.ok(callsIn(log).at(-1).includes(`--model ${WORKER_MODEL}`));
  });

  it("tells the worker who it is", () => {
    assert.ok(
      callsIn(log).at(-1).includes(path.join(instance, "personas", `${WORKER}.md`)),
    );
  });

  it("gives the worker a thread of its own", () => {
    assert.ok(fs.existsSync(path.join(instance, "chat", WORKER, "session.json")));
  });
});

// One session talking to another. It goes through the same route the page posts to, so the
// exchange lands in the addressed session's transcript and its panel shows it like any other.
describe("one session says something to another", () => {
  let said;

  before(() => {
    said = runTool(instance, ["say", WORKER, "how", "is", "it", "going"], standIns);
  });

  it("prints the reply on its own output", () => {
    assert.match(said.stdout, /a reply/);
  });

  it("succeeds", () => {
    assert.equal(said.status, 0);
  });

  it("says the whole message rather than the first word of it", async () => {
    assert.ok((await transcriptOf(WORKER)).body.includes("how is it going"));
  });

  it("delivers it to the session it was said to and to nobody else", async () => {
    const { messages } = JSON.parse((await transcriptOf(LEADER)).body);
    assert.ok(!messages.some((message) => message.from === "human" && message.text.includes("how is it going")));
  });

  it("refuses somebody who does not work here", () => {
    assert.notEqual(runTool(instance, ["say", "Nobody", "hello"], standIns).status, 0);
  });

  it("says who does not work here", () => {
    assert.match(runTool(instance, ["say", "Nobody", "hello"], standIns).stderr, /nobody called Nobody/);
  });

  // Refused here rather than by the chat: the name goes into a URL, and a message with nothing
  // in it is a round trip to be told what we already knew.
  it("refuses a name a session could not have", () => {
    assert.match(runTool(instance, ["say", "../elsewhere", "hello"], standIns).stderr, /must start with a letter/);
  });

  it("refuses to say nothing", () => {
    assert.match(runTool(instance, ["say", WORKER], standIns).stderr, /needs something to say/);
  });

  it("refuses to say it to nobody", () => {
    assert.match(runTool(instance, ["say"], standIns).stderr, /needs somebody to say it to/);
  });
});

// The address is written down by a chat that was running, and nothing takes it away when one
// stops. So every way of not reaching a chat has to end in a sentence rather than in a stack.
describe("when the chat cannot be reached", () => {
  it("says no chat is running when none ever was", () => {
    assert.match(runTool(quiet, ["say", LEADER, "hello"], standIns).stderr, /no chat is running/);
  });

  it("refuses rather than looking like it was heard", () => {
    assert.notEqual(runTool(quiet, ["say", LEADER, "hello"], standIns).status, 0);
  });

  // Half of a room is only in the running process — how many turns are going, who is held up
  // waiting for whom, what is stopped waiting to be allowed something. So there is no room to show
  // without a chat, and an empty one printed as though it were the truth would be worse than none.
  it("says there is no room to show when no chat is running", () => {
    assert.match(runTool(quiet, ["room"], standIns).stderr, /no room to show/);
  });

  it("refuses rather than printing an empty room", () => {
    const said = runTool(quiet, ["room"], standIns);
    assert.notEqual(said.status, 0);
    assert.equal(said.stdout.trim(), "");
  });

  describe("the address belongs to a chat that has stopped", () => {
    let said;

    before(() => {
      pretendChatAt(quiet, "http://127.0.0.1:1");
      said = runTool(quiet, ["say", LEADER, "hello"], standIns);
    });

    it("says the chat did not answer", () => {
      assert.match(said.stderr, /did not answer/);
    });

    it("says which address it tried", () => {
      assert.match(said.stderr, /127\.0\.0\.1:1\b/);
    });
  });

  describe("what is listening is not a chat", () => {
    let impostor;
    let said;

    before(async () => {
      impostor = http.createServer((request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
      await new Promise((resolve) => impostor.listen(0, "127.0.0.1", resolve));
      pretendChatAt(quiet, `http://127.0.0.1:${impostor.address().port}`);

      // Not runTool: this process is the one serving the impostor, and a blocking run would
      // leave the two of them waiting for each other.
      said = await runToolLater(quiet, ["say", LEADER, "hello"], standIns);
    });

    after(() => {
      impostor.close();
    });

    it("prints nothing as though it were an answer", () => {
      assert.equal(said.stdout.trim(), "");
    });

    it("says it got nothing that reads as a reply", () => {
      assert.match(said.stderr, /nothing that reads as a reply/);
    });
  });
});

// Who a message is from is the whole of slice three. The page signs nothing, so an unsigned
// message is the human; a session signs with its own name, and what reaches the other session is
// wrapped under that name. A turn with no wrapper is therefore the human's by construction.
describe("who a message is from", () => {
  before(async () => {
    await say("straight from the page", WORKER);
  });

  it("tells a session its own name when it starts it", () => {
    assert.match(readLog(log), new RegExp(`OW_SESSION_NAME: ${WORKER}`));
  });

  it("hands the page's own message over unwrapped", () => {
    assert.ok(!questionsIn(log).at(-1).includes("<from-session"));
  });

  it("keeps the page's own message under the human's name", async () => {
    const messages = JSON.parse((await transcriptOf(WORKER)).body).messages;
    assert.equal(messages.find((message) => message.text === "straight from the page").from, "human");
  });

  describe("one session speaking to another", () => {
    before(() => {
      runTool(instance, ["say", WORKER, "this", "one", "is", "mine"], asLeader);
    });

    it("hands it over wrapped, under the name of who sent it", () => {
      assert.ok(questionsIn(log).at(-1).includes(`<from-session name="${LEADER}" role="lead">`));
    });

    it("says what the sender is, not only who", () => {
      assert.ok(questionsIn(log).at(-1).includes('role="lead"'));
    });

    it("hands over what was said inside the wrapper", () => {
      assert.match(questionsIn(log).at(-1), /<from-session[^>]*>this one is mine<\/from-session>/);
    });

    it("keeps it in the transcript under the name of who sent it", async () => {
      const messages = JSON.parse((await transcriptOf(WORKER)).body).messages;
      assert.equal(messages.find((message) => message.text === "this one is mine").from, LEADER);
    });

    it("keeps the wrapper out of the transcript", async () => {
      assert.ok(!(await transcriptOf(WORKER)).body.includes("from-session"));
    });
  });

  // And the other way about. Every wrapper this suite read was written for the lead until it was
  // measured: one that named a sender of its own satisfied both checks above, because the only
  // sender any fixture had was the one they asserted. Two senders is what makes them prove the
  // wrapper was built from who spoke.
  describe("a worker speaking to the lead", () => {
    before(() => {
      runTool(instance, ["say", LEADER, "and", "this", "one", "is", "mine"], asWorker);
    });

    it("hands it over under that sender's name and what that sender is", () => {
      assert.ok(questionsIn(log).at(-1).includes(`<from-session name="${WORKER}" role="worker">`));
    });
  });

  it("refuses a message signed by nobody who works here", async () => {
    assert.equal((await post(`${URL}/sessions/${WORKER}/message`, { text: "hello", from: "Nobody" })).status, 400);
  });

  it("says whose signature it did not recognise", async () => {
    const refused = await post(`${URL}/sessions/${WORKER}/message`, { text: "hello", from: "Nobody" });
    assert.match(refused.body, /nobody called Nobody/);
  });

  it("takes a command run from a terminal as the human, since nobody signed it", async () => {
    runTool(instance, ["say", WORKER, "typed", "by", "hand"], standIns);
    const messages = JSON.parse((await transcriptOf(WORKER)).body).messages;
    assert.equal(messages.find((message) => message.text === "typed by hand").from, "human");
  });
});

describe("a message and its reply", () => {
  let said;

  before(async () => {
    said = await say("hello");
  });

  it("accepts a message", () => {
    assert.equal(said.status, 200);
  });

  it("keeps the message in the transcript", async () => {
    assert.ok((await transcriptOf(LEADER)).body.includes("hello"));
  });

  it("keeps the reply in the transcript", async () => {
    assert.ok((await transcriptOf(LEADER)).body.includes("a reply"));
  });

  it("keeps the conversation under the name of the session having it", () => {
    assert.ok(fs.existsSync(path.join(instance, "chat", LEADER, "conversation.json")));
  });

  it("runs the leader on the model the instance installed it for", () => {
    assert.ok(readLog(log).includes(`--model ${LEADER_MODEL}`));
  });

  it("refuses a message with nothing in it", async () => {
    assert.equal((await say("  ")).status, 400);
  });
});

describe("the conversation carries on", () => {
  let again;

  before(async () => {
    again = await say("again");
  });

  it("remembers the thread", () => {
    assert.ok(fs.existsSync(path.join(instance, "chat", LEADER, "session.json")));
  });

  it("accepts a second message", () => {
    assert.equal(again.status, 200);
  });

  it("resumes the thread for the second message", () => {
    assert.ok(readLog(log).includes("--resume test-thread"));
  });
});

describe("the leader is told who it is", () => {
  it("carries the persona on the first message", () => {
    const opening = callsIn(log).filter((call) => !call.includes("--resume"));
    assert.ok(
      opening.some((call) =>
        call.includes(`--append-system-prompt-file ${path.join(instance, "personas", `${LEADER}.md`)}`),
      ),
    );
  });

  it("carries the persona on a resumed message", () => {
    assert.ok(
      readLog(log).includes(
        `--append-system-prompt-file ${path.join(instance, "personas", `${LEADER}.md`)} --resume test-thread`,
      ),
    );
  });
});

describe("an instance with no persona still answers", () => {
  let answered;

  before(async () => {
    fs.rmSync(path.join(instance, "personas", `${LEADER}.md`), { force: true });
    answered = await say("and now");
  });

  it("accepts a message without a persona", () => {
    assert.equal(answered.status, 200);
  });

  it("leaves the persona off when the file is gone", () => {
    assert.ok(!callsIn(log).at(-1).includes("--append-system-prompt-file"));
  });

  it("still replies without a persona", async () => {
    assert.ok((await transcriptOf(LEADER)).body.includes("and now"));
  });
});

describe("Claude Code is missing", () => {
  let answered;

  before(async () => {
    // Node's own directory, so the server still runs, and nothing that would find Claude Code.
    const withoutClaude = {
      ...process.env,
      PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    };
    await start(instance, withoutClaude);
    assert.ok(await waitForHealth(URL), "the server never answered");
    answered = await say("anyone there");
  });

  it("says so in the transcript rather than failing silently", () => {
    assert.ok(answered.body.includes("not on the PATH"));
  });
});

describe("a chat installed with --port 0", () => {
  let address;

  before(async () => {
    installed(options(chosen, 0));
    await start(chosen, standIns);
    address = await waitForAddress(server);
    assert.ok(address, "the server never said where it was listening");
  });

  it("prints the port it got rather than the 0 it was asked for", () => {
    assert.notEqual(address, "http://127.0.0.1:0");
  });

  it("is listening on the address it printed", async () => {
    assert.ok(await waitForHealth(address));
  });

  it("serves this instance on that address", async () => {
    assert.ok((await get(`${address}/health`)).body.includes(chosen));
  });

  it("writes down the address it got rather than the 0 it was asked for", () => {
    const recorded = JSON.parse(fs.readFileSync(path.join(chosen, "chat", "listening.json"), "utf8"));
    assert.equal(recorded.url, address);
  });

  it("says in status that the port is chosen at start", () => {
    const asked = runTool(chosen, ["status"], standIns);
    assert.match(asked.stdout, /chosen when the chat starts/);
  });
});

// A session reads CLAUDE.md from the directory it is started in and from every directory above
// it, so an instance installed under somebody's project would start every session with that
// project's rules in its head. The chat writes the list of what is not to be read before it
// serves anything, every time it starts.
describe("the instructions an instance runs under", () => {
  let excluded;
  let said;

  before(async () => {
    installed(options(owned, 0));
    // Something above the instance for the sweep to find. Its neighbours on the list —
    // CLAUDE.local.md beside it, the .claude/ spellings — are deliberately not created, because
    // the interesting half of the line is what it does not claim.
    fs.writeFileSync(path.join(overhead, "CLAUDE.md"), "# the rules of the house\n");
    // And something stale in the settings, from an instance that was somewhere else when it last
    // started, to see the list written fresh rather than added to.
    const settings = path.join(owned, ".claude", "settings.json");
    const before_ = JSON.parse(fs.readFileSync(settings, "utf8"));
    fs.writeFileSync(settings, JSON.stringify({ ...before_, claudeMdExcludes: ["/somewhere/else/CLAUDE.md"] }, null, 2));

    await start(owned, standIns);
    assert.ok(await waitForAddress(server), "the server never said where it was listening");
    excluded = JSON.parse(fs.readFileSync(settings, "utf8")).claudeMdExcludes;
    said = server.output;
  });

  it("keeps every way a directory above it can hold instructions out", () => {
    assert.deepEqual(excluded.slice(0, 4), [
      path.join(overhead, "CLAUDE.md"),
      path.join(overhead, "CLAUDE.local.md"),
      path.join(overhead, ".claude", "CLAUDE.md"),
      path.join(overhead, ".claude", "rules", "**"),
    ]);
  });

  it("sweeps every directory from its parent to the filesystem root", () => {
    assert.ok(excluded.includes("/CLAUDE.md"), `nothing for the filesystem root in ${JSON.stringify(excluded)}`);
    assert.equal(excluded.length, 4 * (owned.split(path.sep).length - 1));
  });

  it("names them absolutely, since a relative pattern excludes nothing", () => {
    assert.deepEqual(excluded.filter((pattern) => !path.isAbsolute(pattern)), []);
  });

  it("keeps out what is not there yet as well as what is", () => {
    assert.ok(excluded.includes(path.join(overhead, "CLAUDE.local.md")));
  });

  it("leaves the instance's own instructions alone", () => {
    for (const mine of [path.join(owned, "CLAUDE.md"), path.join(owned, ".claude", "CLAUDE.md")]) {
      assert.ok(!excluded.includes(mine), `${mine} is the instance's own and is on the list`);
    }
  });

  it("writes the list fresh rather than adding to what was there", () => {
    assert.ok(!excluded.includes("/somewhere/else/CLAUDE.md"));
  });

  it("leaves what the instance grants its sessions alone", () => {
    const allow = JSON.parse(fs.readFileSync(path.join(owned, ".claude", "settings.json"), "utf8")).permissions.allow;
    assert.ok(allow.includes(`Edit(work/${LEADER}/STATE.md)`), JSON.stringify(allow));
  });

  it("says at start what it found up there", () => {
    assert.match(said, new RegExp(`^This instance's instructions are its own; not read: [^\\n]*${path.join(overhead, "CLAUDE.md")}`, "m"));
  });

  it("claims nothing about the ones that are not there", () => {
    assert.ok(!said.includes(path.join(overhead, "CLAUDE.local.md")), said);
  });
});

describe("the port is already taken", () => {
  let refused;

  before(async () => {
    await start(instance, standIns);
    assert.ok(await waitForHealth(URL), "the server never answered");
    refused = runTool(instance, ["chat"], standIns);
  });

  it("refuses to start a second chat on it", () => {
    assert.match(refused.stderr, /already taken/);
  });

  it("names the process holding the port", () => {
    assert.match(refused.stderr, new RegExp(`pid ${server.pid}\\b`));
  });

  it("says what that process is", () => {
    assert.match(refused.stderr, /ow\.mjs/);
  });

  it("offers a port that is free", () => {
    assert.match(refused.stderr, /--port \(0 takes a free one\)/);
  });
});

// The human types on a worker's panel and the lead is not in the exchange at all. The chat is the
// only party that can see it happen, so the chat says so, on the lead's own panel and at the moment
// it is said rather than whenever the worker gets round to passing it on.
//
// The check that matters is not that the lead is told — it is WHEN. A busy addressee is what tells
// the two designs apart: written from inside the addressee's turn the line joins that session's
// queue, and the lead hears it only after the thing it was about. So the worker is given something
// slow to answer first, and what is asserted is the ORDER: the lead was told before the worker had
// even been handed the message. A check that only waited for the line to turn up would pass either
// way, which is the shape that has already cost this repo two real checks.
describe("the lead hears what was said on another panel", () => {
  const overheardLog = path.join(standIn, "overheard.txt");
  const SLOW_ENOUGH_TO_QUEUE_BEHIND = "1500";
  let line;
  let theSlowOneWasStillGoing;
  let afterSigned;
  let afterOwnPanel;
  let onThePanelItWasTypedOn;

  // Everything on the lead's panel that nobody said to anybody: the chat's own lines.
  async function chatLinesTo(name) {
    const { messages } = JSON.parse((await transcriptOf(name)).body);
    return messages.filter((message) => message.from === "the chat");
  }

  before(async () => {
    await start(instance, standInEnvironment(standIn, overheardLog, { OW_STAND_IN_SLOW: SLOW_ENOUGH_TO_QUEUE_BEHIND }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // Everything before this describe is on the lead's panel already — the suite has been typing on
    // the worker's panel since it started. Only what THIS one adds is being asserted about.
    const before = (await chatLinesTo(LEADER)).length;
    const since = async () => (await chatLinesTo(LEADER)).slice(before);

    // Neither is awaited: the worker is meant to be busy with the first when the second arrives.
    const slow = say("something that takes a while", WORKER);
    await waitFor(() => heardIn(overheardLog).some((heard) => heard.includes("takes a while")) || null);
    const second = say("the boiler is making a noise", WORKER);

    line = await waitFor(async () => (await since()).find((told) => told.text.includes("boiler")) ?? null);

    // Read at the moment the lead was told, not afterwards: this is the whole check. The stand-in
    // writes `answered:` when a slow run finishes, so this asks whether the worker was still busy
    // with the FIRST message. Written from inside the addressee's turn the line could not exist
    // yet — it would be behind that message in the queue — and the window is the whole of the
    // stand-in's delay, so it is an order this cannot get wrong by a fraction of a second.
    theSlowOneWasStillGoing = !readLog(overheardLog).includes("answered: something that takes a while");

    await Promise.all([slow, second]);
    onThePanelItWasTypedOn = await chatLinesTo(WORKER);

    // What the lead has been told by the time both of those are done. Nothing after this should
    // add to it.
    const settled = (await since()).length;

    // A session speaking is not something the lead overhears: it either sent this or can be told
    // by whoever did.
    runTool(instance, ["say", WORKER, "and", "this", "one", "is", "signed"], asLeader);
    afterSigned = { told: (await since()).length, settled };

    // Nor is the human on the lead's own panel, which the lead is not overhearing but hearing.
    await say("this one is on your own panel", LEADER);
    afterOwnPanel = { told: (await since()).length, settled };
  });

  it("tells the lead at all", () => {
    assert.ok(line !== null, "the lead was never told");
  });

  it("tells the lead while the addressee is still busy with an earlier message", () => {
    assert.equal(theSlowOneWasStillGoing, true);
  });

  it("says who it was said to, and what was typed", () => {
    assert.equal(line?.text, `${HUMAN} said to ${WORKER}: the boiler is making a noise`);
  });

  it("puts it under the chat's own name, since nobody said it to anybody", () => {
    assert.equal(line?.from, "the chat");
  });

  it("marks the line for what it is, rather than leaving it to be read out of the words", () => {
    assert.equal(line?.overheard, true);
  });

  it("says nothing on the panel it was typed on", () => {
    assert.deepEqual(onThePanelItWasTypedOn, []);
  });

  it("does not overhear one session speaking to another", () => {
    assert.equal(afterSigned.told, afterSigned.settled);
  });

  it("does not overhear the human on the lead's own panel", () => {
    assert.equal(afterOwnPanel.told, afterOwnPanel.settled);
  });
});

// A line on the lead's panel is what a person reads, and it is not what the lead's model hears:
// the panel is a file, the model's context is the thread a run resumes. So what was overheard
// waits until the lead runs for its own reasons and rides in front of whatever it is asked.
//
// The stand-in logs the whole question it was handed, and a question with overheard lines in front
// of it runs to several lines — so these read the log rather than heardIn(), which is line-based
// and would see only the first of them.
describe("what the lead overheard reaches it on its next turn", () => {
  const carriedLog = path.join(standIn, "carried.txt");
  let workersOwnTurn;
  let asked;
  let theTurnAfter;

  before(async () => {
    await start(instance, standInEnvironment(standIn, carriedLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    await say("the kettle is broken", WORKER);
    await say("and the lift is out", WORKER);
    workersOwnTurn = questionsIn(carriedLog).at(-1);

    await say("what is going on out there", LEADER);
    asked = questionsIn(carriedLog).at(-1);

    await say("anything else", LEADER);
    theTurnAfter = questionsIn(carriedLog).at(-1);
  });

  it("hands the lead what was said on the other panel", () => {
    assert.ok(asked.includes("the kettle is broken"));
  });

  it("says whose panel it was said on, and who said it", () => {
    assert.ok(asked.includes(`<overheard on="${WORKER}" from="${HUMAN}">the kettle is broken</overheard>`));
  });

  it("hands over everything it overheard, in the order it was said", () => {
    assert.deepEqual(
      [...asked.matchAll(/<overheard[^>]*>([^<]*)<\/overheard>/g)].map((found) => found[1]),
      ["the kettle is broken", "and the lift is out"],
    );
  });

  it("puts them in front of the message the turn is actually about", () => {
    assert.ok(asked.endsWith("what is going on out there"));
  });

  it("leaves the human's own message outside every wrapper, which is what makes it the human's", () => {
    assert.equal(asked.slice(asked.lastIndexOf(">") + 1).trim(), "what is going on out there");
  });

  it("hands it over once, not on every turn afterwards", () => {
    assert.ok(!theTurnAfter.includes("overheard"));
  });

  it("hands the addressee only the message it was sent", () => {
    assert.ok(!workersOwnTurn.includes("overheard"));
  });

  it("still writes it on the lead's panel as well", async () => {
    const { messages } = JSON.parse((await transcriptOf(LEADER)).body);
    assert.ok(messages.some((message) => message.overheard === true && message.text.includes("the kettle is broken")));
  });
});

// An update replaces the toolkit while nothing is running, so whatever it has to say cannot be
// handed to anybody: what a session is owed is held in memory and dies with the chat the update
// stopped. It is left in a file instead, and the chat is what finds it.
//
// The lead is the only one told, because the lead is what tells everybody else. Nothing here
// re-renders a persona, so the wrapper has to explain itself to a session running the instructions
// written before any of this existed.
describe("what the chat tells the lead when the toolkit under it was replaced", () => {
  const updateLog = path.join(standIn, "update.txt");
  const WORD = path.join(instance, "chat", "untold.json");
  const FROM = "0.1.0";
  const TO = "0.2.0";
  const NOTES = "Hiring happens on the page now, and a worker is asked for its desk on every turn.";

  let beforeAnybodySaidAnything;
  let told;
  let leadsNextTurn;
  let wrapper;
  let theTurnAfter;
  let workersOwnTurn;
  let addedByStartingAgain;

  // A panel read over the chat rather than off disk, because that is what a person looking at it
  // sees.
  async function panelOf(name) {
    return JSON.parse((await transcriptOf(name)).body).messages;
  }

  before(async () => {
    // Everything on the lead's panel before this describe touches anything. Counted rather than
    // matched on what it says, so a mutation to the words of a line cannot also hide the line.
    const previously = (await panelOf(LEADER)).length;

    // Written the way `ow update` leaves it and then the chat is started, which is the whole
    // arrangement: whatever wrote this is not running any more.
    fs.writeFileSync(WORD, `${JSON.stringify({ from: FROM, to: TO, notes: NOTES }, null, 2)}\n`);

    await start(instance, standInEnvironment(standIn, updateLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // Read with the chat up and nobody having said anything to it. Told at the start and told on
    // the first message are the same thing once a message has been sent, and this is the state
    // only the first of them reaches. It holds for as long as nobody types, so nothing here is
    // racing the thing it is measuring.
    beforeAnybodySaidAnything = (await panelOf(LEADER)).slice(previously);
    told = beforeAnybodySaidAnything.at(-1) ?? null;

    await say("what is going on", LEADER);
    leadsNextTurn = questionsIn(updateLog).at(-1);

    // Up to the FIRST closing tag, which is the whole of what being inside the wrapper means. Read
    // to the last one instead and a wrapper closed early still has something after the notes to
    // match against — so the check would pass on the very mistake it exists to rule out.
    const closes = leadsNextTurn.indexOf("</update>");
    wrapper = closes === -1 ? "" : leadsNextTurn.slice(leadsNextTurn.indexOf("<update"), closes + "</update>".length);

    await say("anything else", LEADER);
    theTurnAfter = questionsIn(updateLog).at(-1);

    await say("carry on", WORKER);
    workersOwnTurn = questionsIn(updateLog).at(-1);

    // Started again with nothing having happened in between. Whether the word was taken or only
    // read is indistinguishable inside one run of the chat — what a session is owed drains either
    // way — and a second start is the only place the difference shows.
    const settled = (await panelOf(LEADER)).length;
    await start(instance, standInEnvironment(standIn, updateLog));
    assert.ok(await waitForHealth(URL), "the server never answered");
    addedByStartingAgain = (await panelOf(LEADER)).length - settled;
  });

  it("says on the lead's panel that an update ran, before anybody has said anything to it", () => {
    assert.equal(beforeAnybodySaidAnything.length, 1);
  });

  it("puts it under the chat's own name, since nobody said it to anybody", () => {
    assert.equal(told?.from, "the chat");
  });

  it("marks the line for what it is, rather than leaving it to be read out of the words", () => {
    assert.equal(told?.update, true);
  });

  it("says which versions the instance moved between, and what the release said changed", () => {
    assert.ok(told?.text.includes(`from ${FROM} to ${TO}`), told?.text);
    assert.ok(told?.text.includes(NOTES), told?.text);
  });

  it("hands the lead the notes on its next turn", () => {
    assert.ok(leadsNextTurn.includes(NOTES), leadsNextTurn);
  });

  it("puts the notes inside the wrapper, so they are not read as the human having typed them", () => {
    assert.match(wrapper, new RegExp(`^<update from="${FROM}" to="${TO}">[\\s\\S]*${NOTES}[\\s\\S]*</update>$`));
  });

  // An update ships new templates and re-renders no persona, so the session reading this is
  // running the instructions written before the wrapper existed. It has to say what it is.
  it("says in the wrapper itself what the update left alone", () => {
    assert.match(wrapper, /desks/);
    assert.match(wrapper, /personas/);
    assert.match(wrapper, /learned/);
  });

  it("says that nobody else here has been told, which is what makes it the lead's to pass on", () => {
    assert.match(wrapper, /nobody else has been told/);
  });

  it("puts it in front of the message the turn is actually about", () => {
    assert.ok(leadsNextTurn.endsWith("what is going on"), leadsNextTurn);
  });

  it("hands it over once, not on every turn afterwards", () => {
    assert.ok(!theTurnAfter.includes("<update"), theTurnAfter);
  });

  it("tells nobody but the lead, since the lead is what tells everybody else", () => {
    assert.ok(!workersOwnTurn.includes("<update"), workersOwnTurn);
  });

  it("tells the lead once, and not again the next time the chat starts", () => {
    assert.equal(addedByStartingAgain, 0);
    assert.equal(fs.existsSync(WORD), false);
  });
});

// Drained where the turn BEGINS, not where the message arrived. A lead that is already busy has its
// next turn waiting in the queue, and anything said while it waits belongs to that turn rather than
// to the one after it. With an idle lead the two moments are the same instant, which is why this
// needs a busy one: it is the only case that tells the two apart.
describe("a line said while the lead's next turn is already waiting", () => {
  const queuedLog = path.join(standIn, "queued.txt");
  let theWaitingTurn;

  before(async () => {
    await start(instance, standInEnvironment(standIn, queuedLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // None of these is awaited on its own: the whole point is what overlaps what.
    const busy = say("something that takes a while", LEADER);
    await waitFor(() => questionsIn(queuedLog).some((question) => question.includes("takes a while")) || null);

    // This one queues behind it, and at the moment it arrives nothing has been overheard.
    const waiting = say("and then this one", LEADER);
    // Long enough that the two POSTs cannot land the other way round, and far short of the delay
    // the slow one is still sitting in. Without the gap the check passes whichever way it is
    // built, because a line already pending when the message arrives is carried by either.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Said while that one is still waiting its turn.
    const meanwhile = say("the roof is leaking", WORKER);

    await Promise.all([busy, waiting, meanwhile]);
    theWaitingTurn = questionsIn(queuedLog).find((question) => question.includes("and then this one"));
  });

  it("goes with the turn that was waiting, not the one after it", () => {
    assert.ok(theWaitingTurn?.includes("the roof is leaking"));
  });
});

// One session answers one message at a time. Without it a second message arriving mid-run starts a
// second child for the same session, both resuming the same thread, and the transcript comes out as
// two questions followed by two answers nobody can pair up.
//
// The stand-in takes its time here, and records the moment it starts as well as the moment it is
// done, so the log says whether the two runs overlapped rather than only that both happened.
describe("a session answers one message at a time", () => {
  const slowLog = path.join(standIn, "slow.txt");
  let answered;

  before(async () => {
    await start(instance, standInEnvironment(standIn, slowLog, { OW_STAND_IN_SLOW: "700" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    const first = say("one at a time, please", WORKER);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = say("and me, when you are done", WORKER);
    answered = await Promise.all([first, second]);
  });

  it("answers both of them", () => {
    assert.deepEqual(
      answered.map((exchange) => exchange.status),
      [200, 200],
    );
  });

  it("does not begin the second before the first is done", () => {
    const order = entriesIn(slowLog)
      .filter((entry) => entry.includes("one at a time") || entry.includes("and me, when"))
      .map((entry) => `${entry.startsWith("heard") ? "began" : "ended"} ${entry.includes("one at a time") ? "first" : "second"}`);
    assert.deepEqual(order, ["began first", "ended first", "began second", "ended second"]);
  });

  it("keeps a transcript that can be read in order", async () => {
    const messages = JSON.parse((await transcriptOf(WORKER)).body).messages.slice(-4);
    assert.deepEqual(
      messages.map((message) => (message.from === WORKER ? "answer" : "question")),
      ["question", "answer", "question", "answer"],
    );
  });
});

// The queue is one per session, not one for the instance. A page with two panels on it is worth
// nothing if a busy session holds up everybody else.
// A session is put to work by another session as much as by the person at the page, so a panel
// has to be able to say that its session is busy without having been the one that made it busy.
describe("what the page is told about a session mid-turn", () => {
  const busyLog = path.join(standIn, "busy.txt");
  let idle;
  let mid;
  let after;

  // What /sessions says about one name right now.
  async function stateOf(name) {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    return rows.find((row) => row.name === name) ?? null;
  }

  before(async () => {
    await start(instance, standInEnvironment(standIn, busyLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    idle = await stateOf(WORKER);
    // Not awaited: the point is what the page is told WHILE the turn is going.
    const answering = say("take your time", WORKER);
    mid = await waitFor(async () => {
      const row = await stateOf(WORKER);
      return row?.busy === true ? row : null;
    });
    const alongside = await stateOf(LEADER);
    await answering;
    after = await stateOf(WORKER);
    mid = { worker: mid, leader: alongside };
  });

  it("says nothing is going on when nothing is", () => {
    assert.equal(idle.busy, false);
  });

  it("says the session is busy while it is answering", () => {
    assert.equal(mid.worker?.busy, true);
  });

  it("says it about the session that is busy and not the others", () => {
    assert.equal(mid.leader.busy, false);
  });

  it("stops saying it once the turn is over", () => {
    assert.equal(after.busy, false);
  });

  it("still says who works here and what they are", () => {
    assert.deepEqual(
      [idle.name, idle.role, idle.model],
      [WORKER, "worker", WORKER_MODEL],
    );
  });

  it("gives the page a word to put beside the name", async () => {
    assert.ok((await get(`${URL}/`)).body.includes("(answering…)"));
  });
});

// How deep the pile behind a session is, and who is holding it up.
//
// `busy` answers the panel's question — is it my turn yet — and cannot answer either of these. A
// session answering with two more waiting looks exactly like one answering with nothing behind it,
// and a session blocked on somebody else's answer looks exactly like one thinking hard. Both are
// worked out from the same count the busy sign is, so there is nothing that can disagree.
//
// Every check here needs the wrong answer to be observably wrong, which means holding the session
// in the state being asked about: a slow run, and a second message sent while the first is still
// going. An idle session cannot tell any of these apart.
describe("what the page is told about the pile behind a session", () => {
  const pileLog = path.join(standIn, "pile.txt");
  let alone;
  let piled;
  let drained;

  async function stateOf(name) {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    return rows.find((row) => row.name === name) ?? null;
  }

  before(async () => {
    await start(instance, standInEnvironment(standIn, pileLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // Neither is awaited: the first has to still be going when the second arrives, or there is
    // never a pile to be asked about and every check below passes on an idle session.
    const answering = say("the one being answered", WORKER);
    alone = await waitFor(async () => {
      const row = await stateOf(WORKER);
      return row?.busy === true ? row : null;
    });

    const behind = say("the one behind it", WORKER);
    piled = await waitFor(async () => {
      const row = await stateOf(WORKER);
      return row?.queued === 1 ? row : null;
    });

    await Promise.all([answering, behind]);
    drained = await stateOf(WORKER);
  });

  it("says nothing is waiting when one turn is going on its own", () => {
    assert.deepEqual([alone?.busy, alone?.queued], [true, 0]);
  });

  it("says how many are waiting behind the one being answered", () => {
    assert.equal(piled?.queued, 1);
  });

  it("still says the session is busy while they are waiting", () => {
    assert.equal(piled?.busy, true);
  });

  it("says nothing is waiting once the pile has gone", () => {
    assert.deepEqual([drained.busy, drained.queued], [false, 0]);
  });
});

// Who is held up by whom. The lead asks a worker something from inside its own turn and is stopped
// there for the whole of the worker's — which from outside is indistinguishable from a lead taking
// a long time to think, and is the difference between somebody to chase and somebody to leave be.
describe("what the page is told about who is waiting for whom", () => {
  const heldLog = path.join(standIn, "held.txt");
  let held;
  let afterwards;

  async function stateOf(name) {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    return rows.find((row) => row.name === name) ?? null;
  }

  before(async () => {
    // The lead really runs the instance's own command from inside its turn, and the worker takes
    // its time answering — so the lead is genuinely stopped, and stopped long enough for the row
    // to be read while it is. Without the slow worker the wait is over before anything can look.
    await start(
      instance,
      standInEnvironment(standIn, heldLog, {
        OW_STAND_IN_CALLS: `${LEADER}>${WORKER}`,
        OW_STAND_IN_SLOW: "1500",
      }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");

    const asking = say("go and ask him", LEADER);
    held = await waitFor(async () => {
      const row = await stateOf(LEADER);
      return row?.waitingFor === WORKER ? row : null;
    });
    const alongside = await stateOf(WORKER);
    await asking;
    afterwards = await stateOf(LEADER);
    held = { lead: held, worker: alongside };
  });

  it("names who the lead is waiting for while it is waiting", () => {
    assert.equal(held.lead?.waitingFor, WORKER);
  });

  it("says the worker it is waiting for is not itself waiting for anybody", () => {
    assert.equal(held.worker?.waitingFor ?? null, null);
  });

  it("stops naming anybody once the answer has come back", () => {
    assert.equal(afterwards.waitingFor, null);
  });
});

describe("one session waiting does not hold up another", () => {
  const bothLog = path.join(standIn, "both.txt");

  before(async () => {
    await start(instance, standInEnvironment(standIn, bothLog, { OW_STAND_IN_SLOW: "700" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await Promise.all([say("the worker's own", WORKER), say("the lead's own", LEADER)]);
  });

  // Read by what the stand-in logged rather than by which message it was: a question can now carry
  // what the lead overheard in front of it, over several lines, so a filter on the text of one
  // message finds the other one's lines too.
  it("runs them at the same time", () => {
    const order = readLog(bothLog)
      .split("\n")
      .filter((line) => /^(heard|answered): /.test(line))
      .map((line) => (line.startsWith("heard") ? "began" : "ended"));
    assert.deepEqual(order, ["began", "began", "ended", "ended"]);
  });
});

// The circle the queue makes possible: the lead's turn is held open waiting for a worker, and the
// worker, before answering, says something back to the lead. Waiting for that would stop both of
// them for good — nothing here times out — so it is refused with what to do instead.
//
// The stand-in really runs the instance's command from inside its turn, so this is the whole path
// and not a stub of it.
describe("a message that would wait for the sender's own turn", () => {
  const circleLog = path.join(standIn, "circle.txt");

  // The stand-in gives up on its own call after five seconds, which is the only reason a circle
  // ends at all when nothing notices it. So how long this took is the check: the real thing has no
  // timeout anywhere, and there a circle nobody notices never ends.
  const PATIENCE_OF_THE_STAND_IN = 5000;
  let asked;
  let took;

  before(async () => {
    await start(
      instance,
      standInEnvironment(standIn, circleLog, { OW_STAND_IN_CALLS: `${LEADER}>${WORKER},${WORKER}>${LEADER}` }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");
    const started = Date.now();
    asked = await say("ask the worker something", LEADER);
    took = Date.now() - started;
  });

  it("answers the message that started it", () => {
    assert.equal(asked.status, 200);
  });

  it("does not get there by waiting the circle out", () => {
    assert.ok(took < PATIENCE_OF_THE_STAND_IN, `the exchange took ${took} ms`);
  });

  it("lets the lead reach the worker", () => {
    assert.match(readLog(circleLog), new RegExp(`said by ${LEADER} to ${WORKER}: status=0`));
  });

  it("refuses the worker's message back", () => {
    assert.match(readLog(circleLog), new RegExp(`said by ${WORKER} to ${LEADER}: status=1`));
  });

  it("says why, and what to do instead", () => {
    assert.match(readLog(circleLog), /is waiting for your answer.*say this in your reply instead/);
  });

  it("says so in the transcript of whoever tried, not only on their command", async () => {
    const messages = JSON.parse((await transcriptOf(WORKER)).body).messages;
    const said = messages.find((message) => message.from === "the chat");
    assert.ok(said !== undefined, "nothing in the transcript says what became of it");
    assert.match(said.text, new RegExp(`not delivered to ${LEADER}`));
  });
});

// The chain, not only the direct edge: the lead waits for one worker, that worker waits for
// another, and the second one speaks to the lead.
describe("a message that would wait for the sender further up the chain", () => {
  const chainLog = path.join(standIn, "chain.txt");
  const SECOND = "Ann";

  before(async () => {
    runTool(instance, ["hire", SECOND], process.env);
    await start(
      instance,
      standInEnvironment(standIn, chainLog, {
        OW_STAND_IN_CALLS: `${LEADER}>${WORKER},${WORKER}>${SECOND},${SECOND}>${LEADER}`,
      }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("start the chain", LEADER);
  });

  it("lets each link that is not a circle through", () => {
    assert.match(readLog(chainLog), new RegExp(`said by ${WORKER} to ${SECOND}: status=0`));
  });

  it("refuses the one that closes the circle", () => {
    assert.match(readLog(chainLog), new RegExp(`said by ${SECOND} to ${LEADER}: status=1`));
  });

  it("says the same thing about a circle three sessions long", () => {
    const refused = readLog(chainLog)
      .split("\n")
      .find((line) => line.startsWith(`said by ${SECOND}`));
    assert.match(refused, /is waiting for your answer/);
  });
});

// How a session is run, now that a question is a frame and not an argument. The format is what
// makes a run able to be asked whether it may use a tool, which is what the page is for; and the
// question moving to stdin is not a nicety but the only way it is read at all, because a prompt
// argument is passed over in silence once the input format is streaming.
//
// This block runs a chat of its own so that what it reads is its own question and nobody else's.
describe("a session is asked over the streaming protocol", () => {
  const askedLog = path.join(standIn, "asked.txt");

  before(async () => {
    await start(instance, standInEnvironment(standIn, askedLog));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("a question of its own");
  });

  it("reads its questions as frames", () => {
    assert.ok(callsIn(askedLog).at(-1).includes("--input-format stream-json"));
  });

  it("answers in frames too", () => {
    assert.ok(callsIn(askedLog).at(-1).includes("--output-format stream-json"));
  });

  it("says enough for the format to be allowed at all", () => {
    const call = callsIn(askedLog).at(-1);
    assert.ok(call.includes("--print"), "the run is not in print mode");
    assert.ok(call.includes("--verbose"), "streaming output is refused without it");
  });

  it("is run so that it can ask to use a tool at all", () => {
    assert.ok(callsIn(askedLog).at(-1).includes("--permission-prompt-tool stdio"));
  });

  it("does not put the question in the arguments, where it would not be read", () => {
    assert.ok(!callsIn(askedLog).at(-1).includes("a question of its own"));
  });

  it("hands the question over on stdin", () => {
    assert.ok(questionsIn(askedLog).at(-1).includes("a question of its own"));
  });

  it("closes the run's stdin once the answer is in", () => {
    assert.ok(
      !readLog(askedLog).includes("stdin was never closed"),
      "a run left holding stdin open waits for a question that is never coming",
    );
  });
});

// A result arrives among everything else the format carries: a keep-alive while a long turn runs,
// a system notice, the assistant's own turn, and — stdout being a stream and not only frames — the
// odd line that is not JSON at all. Losing an answer because something harmless came out beside it
// would be the whole slice undone.
describe("an answer among the noise", () => {
  const noisyLog = path.join(standIn, "noisy.txt");
  let answered;

  before(async () => {
    await start(instance, standInEnvironment(standIn, noisyLog, { OW_STAND_IN_NOISE: "yes" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    answered = await say("through the noise");
  });

  it("accepts the message", () => {
    assert.equal(answered.status, 200);
  });

  it("keeps the answer that came out after all of it", async () => {
    const messages = JSON.parse((await transcriptOf(LEADER)).body).messages;
    assert.equal(messages.at(-1).text, "a reply");
  });
});

// A run can end without ever framing an answer — it fell over, or it was never going to start.
// Reading only frames would leave a session with nothing to say about it, so what came out in
// prose is what the transcript gets.
describe("a run that frames nothing at all", () => {
  const brokenLog = path.join(standIn, "broken.txt");
  let answered;

  before(async () => {
    await start(instance, standInEnvironment(standIn, brokenLog, { OW_STAND_IN_BROKEN: "yes" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    answered = await say("is anybody home");
  });

  it("says what came out instead of an answer", () => {
    assert.ok(answered.body.includes("a model was never reached"));
  });

});

// The shape that put the protocol on a panel: stopped mid-turn, so the frames it had already
// emitted are on stdout, there is no result frame, and stderr is empty. Stopping the chat does
// this to a run on purpose, so it is the ordinary case and not an exotic one.
describe("a run stopped in the middle of its turn", () => {
  const halfLog = path.join(standIn, "half.txt");
  let answered;

  before(async () => {
    await start(instance, standInEnvironment(standIn, halfLog, { OW_STAND_IN_HALF: "yes" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    answered = await say("this one gets cut off");
  });

  it("never offers the protocol as the answer", () => {
    assert.ok(
      !answered.body.includes(String.raw`\"type\":\"system\"`) &&
        !answered.body.includes("half a thought"),
      `the frames were put on the page as the reply: ${answered.body.slice(0, 200)}`,
    );
  });

  it("says the run ended without answering", () => {
    assert.ok(
      answered.body.includes("Claude Code ended without answering"),
      `nothing said what happened: ${answered.body.slice(0, 200)}`,
    );
  });
});

describe("a run that falls over saying nothing at all", () => {
  const muteLog = path.join(standIn, "mute.txt");
  let answered;

  before(async () => {
    await start(instance, standInEnvironment(standIn, muteLog, { OW_STAND_IN_MUTE: "yes" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    answered = await say("is anybody home");
  });

  it("says the run ended without answering", () => {
    assert.ok(
      answered.body.includes("Claude Code ended without answering"),
      `nothing said what happened: ${answered.body.slice(0, 200)}`,
    );
  });

  it("marks it as a failure", () => {
    assert.equal(JSON.parse(answered.body).reply.failed, true);
  });
});

// A run can end well and say nothing: the result frame arrives, is not an error, and carries an
// empty string. It has happened twice with a real session and the cause is not known; what is
// settled is that it must not reach a panel as a blank line, which reads as the chat having lost
// the reply rather than as the session having had nothing to say.
describe("a run that answers with nothing", () => {
  const emptyLog = path.join(standIn, "empty.txt");
  let answered;

  before(async () => {
    await start(instance, standInEnvironment(standIn, emptyLog, { OW_STAND_IN_EMPTY: "yes" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    answered = await say("say nothing at all");
  });

  it("keeps the reply as empty as it came", () => {
    assert.equal(JSON.parse(answered.body).reply.text, "");
  });

  it("marks the row as having said nothing", () => {
    assert.equal(JSON.parse(answered.body).reply.silent, true);
  });

  it("does not call a run that ended well a failure", () => {
    assert.equal(JSON.parse(answered.body).reply.failed, undefined);
  });

  // The panel is built from the transcript, not from the answer to the post, so the mark has to
  // have been written down and not merely returned.
  it("marks it in the transcript too, not only in the answer to the post", async () => {
    const { messages } = JSON.parse((await transcriptOf(LEADER)).body);
    const last = messages.at(-1);
    assert.equal(last.from, LEADER);
    assert.equal(last.silent, true);
  });
});

// Approvals. A run that wants a tool the instance has not already settled stops and asks; the
// request is shown on that session's panel, and what a person answers is what the run is told.
// Nothing on that path times out on either side, which is what makes it answerable by a person
// and what makes an unanswered one a hang — so every check here answers, or checks the refusing.
//
// The message is posted without being waited for: it does not come back until the whole exchange
// is over, and the answering is the middle of it.
describe("asking to be allowed", () => {
  const askedLog = path.join(standIn, "asking.txt");

  async function waitingOn(name) {
    return waitFor(async () => {
      const { permissions } = JSON.parse((await get(`${URL}/sessions/${name}/permissions`)).body);
      return permissions.length > 0 ? permissions : null;
    });
  }

  before(async () => {
    await start(instance, standInEnvironment(standIn, askedLog, { OW_STAND_IN_ASKS: "Bash" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
  });

  describe("what the page is shown", () => {
    let asking;
    let exchange;

    before(async () => {
      exchange = say("go and look");
      asking = await waitingOn(LEADER);
    });

    after(async () => {
      await post(`${URL}/sessions/${LEADER}/permission`, { id: asking[0].id, decision: "deny" });
      await exchange;
    });

    it("shows the request while the run waits on it", () => {
      assert.ok(asking !== null, "nothing was ever shown as waiting");
      assert.equal(asking.length, 1);
    });

    it("says which tool it wants", () => {
      assert.equal(asking[0].tool, "Bash");
    });

    it("says what the tool was going to be given", () => {
      assert.deepEqual(asking[0].input, { command: "the one it wanted to run" });
    });

    it("does not answer it on its own while it sits there", async () => {
      const still = JSON.parse((await get(`${URL}/sessions/${LEADER}/permissions`)).body).permissions;
      assert.equal(still.length, 1, "something answered it that was not a person");
    });
  });

  // The same request, for another tool and another argument. Every fixture here asked for Bash and
  // the same command until it was measured: a page that named a tool and an argument of its own
  // satisfied the two checks above, because the page and the fixture had been given the same two
  // constants and neither had to read anything. Two requests is what makes the pair prove it.
  describe("what the page is shown about a different request", () => {
    const otherLog = path.join(standIn, "asking-otherwise.txt");
    let asking;
    let exchange;

    before(async () => {
      await start(
        instance,
        standInEnvironment(standIn, otherLog, {
          OW_STAND_IN_ASKS: "Read",
          OW_STAND_IN_ASKS_INPUT: "the other one it wanted",
        }),
      );
      assert.ok(await waitForHealth(URL), "the server never answered");
      exchange = say("go and read");
      asking = await waitingOn(LEADER);
    });

    after(async () => {
      await post(`${URL}/sessions/${LEADER}/permission`, { id: asking[0].id, decision: "deny" });
      await exchange;
      await start(instance, standInEnvironment(standIn, askedLog, { OW_STAND_IN_ASKS: "Bash" }));
      assert.ok(await waitForHealth(URL), "the server never came back");
    });

    it("says which tool that one wants", () => {
      assert.equal(asking[0].tool, "Read");
    });

    it("says what that tool was going to be given", () => {
      assert.deepEqual(asking[0].input, { command: "the other one it wanted" });
    });
  });

  describe("allowing it", () => {
    let answered;

    before(async () => {
      const exchange = say("this one is allowed");
      const asking = await waitingOn(LEADER);
      await post(`${URL}/sessions/${LEADER}/permission`, { id: asking[0].id, decision: "allow" });
      answered = await exchange;
    });

    it("lets the run finish", () => {
      assert.equal(answered.status, 200);
    });

    it("tells the run it was allowed", () => {
      assert.ok(answered.body.includes("I was told allow"));
    });

    // A third check stood here, reading the waiting list once the turn was over and asserting it
    // was empty. It is gone rather than renamed, because there is nothing it could be renamed to
    // that would be true. It cannot be about a run ending with something still parked: the request
    // in this describe was answered before the run finished. And it cannot be about the answering
    // either, because reading the list AFTER the turn cannot see what answering did — the turn
    // gives up everything still parked on its way out, so the list is empty whether the answer took
    // the request away or not. Measured both ways: it survived deleting the giving-up, and it
    // survived answering being made to leave the request where it was.
    //
    // Both of the things it meant to say are held elsewhere, by checks that reach them.
    // `stops counting it once a person has answered, before the turn is over` reads the count while
    // the run is still going, which is what makes it about the answer and not about the turn, and
    // `takes the question down with it` reaches a run that really does end with its question up.
  });

  describe("refusing it", () => {
    let answered;

    before(async () => {
      const exchange = say("this one is not");
      const asking = await waitingOn(LEADER);
      await post(`${URL}/sessions/${LEADER}/permission`, {
        id: asking[0].id,
        decision: "deny",
        why: "not from here",
      });
      answered = await exchange;
    });

    it("lets the run finish all the same", () => {
      assert.equal(answered.status, 200);
    });

    it("tells the run it was refused, and why", () => {
      assert.ok(answered.body.includes("I was told deny"), answered.body);
      assert.ok(answered.body.includes("not from here"), answered.body);
    });
  });

  // Refused with nothing said about why. The chat has a sentence of its own for that, and it is
  // the second value the field takes: without it, the check above is a page and a run agreeing on
  // one string, and a chat that answered every refusal with that string passed it.
  describe("refusing it without saying why", () => {
    let answered;

    before(async () => {
      const exchange = say("this one is refused without a word");
      const asking = await waitingOn(LEADER);
      await post(`${URL}/sessions/${LEADER}/permission`, { id: asking[0].id, decision: "deny" });
      answered = await exchange;
    });

    it("tells the run it was refused, in the chat's own words", () => {
      assert.ok(answered.body.includes("I was told deny"), answered.body);
      assert.ok(answered.body.includes("not allowed from the chat"), answered.body);
    });
  });

  // A run can end with its question still on the page: it gave up waiting, or it fell over. What
  // must not survive it is the offer to answer — allowing something after the run that asked has
  // gone would be a button that does nothing and says otherwise.
  describe("a run that ends while its question is still up", () => {
    let answered;
    let asked;
    let took;

    before(async () => {
      await start(
        instance,
        standInEnvironment(standIn, path.join(standIn, "unanswered.txt"), {
          OW_STAND_IN_ASKS: "Bash",
          OW_STAND_IN_WAITS: "300",
        }),
      );
      assert.ok(await waitForHealth(URL), "the server never answered");
      const exchange = say("nobody will answer this one");
      asked = await waitingOn(LEADER);

      const at = Date.now();
      answered = await exchange;
      took = Date.now() - at;
    });

    after(async () => {
      await start(instance, standInEnvironment(standIn, askedLog, { OW_STAND_IN_ASKS: "Bash" }));
      assert.ok(await waitForHealth(URL), "the server never answered");
    });

    it("finishes without the answer it asked for", () => {
      assert.equal(answered.status, 200);
    });

    // This is where a run really does end with a question still up, so this is where the list is
    // read. Three lines, and each one closes a way of passing without proving anything.
    //
    // That there was a question at all: an empty list means nothing on its own, because a list
    // emptied by the ending and a list that never held anything compare equal.
    //
    // That it was gone by the time the turn came back: read on the turn's own clock rather than
    // after a wait, so a chat that cleared the list on some later sweep of its own could not pass
    // this — a page offering to answer a run that left is a page that lies for as long as it does
    // it, and a check that waits long enough for anything to be true says nothing about when.
    it("takes the question down with it", async () => {
      assert.equal(asked?.length, 1, "no question was ever asked, so this proved nothing");
      assert.ok(took < 5000, `the turn took ${took}ms, long enough for something other than the ending to have cleared it`);

      const left = JSON.parse((await get(`${URL}/sessions/${LEADER}/permissions`)).body).permissions;
      assert.deepEqual(left, [], "the page is still offering to answer a run that has gone");
    });
  });

  describe("answering one that is not waiting", () => {
    it("refuses an id nobody is waiting on", async () => {
      const answered = await post(`${URL}/sessions/${LEADER}/permission`, {
        id: "nothing-like-it",
        decision: "allow",
      });
      assert.equal(answered.status, 409);
    });

    it("refuses a decision that is neither", async () => {
      const answered = await post(`${URL}/sessions/${LEADER}/permission`, {
        id: "request-1",
        decision: "maybe",
      });
      assert.equal(answered.status, 400);
    });
  });
});

// Ending a run that will not end itself.
//
// Every other press on a panel is a turn and waits in the same queue. This one cannot: it is for
// the session whose queue has stopped moving, and the thing that has stopped it is a run with no
// way out. A run answers, or falls over, or is turned away, or the whole chat is stopped — and
// until this there was nothing between those and killing the chat, which takes every other
// session's work with it.
//
// The state is reached with a stand-in that goes quiet and never comes back, which is what the
// real one does while it waits to be allowed something nobody is going to answer. Nothing here
// can pass by waiting: there is no ending for these runs but the one being checked.
describe("ending a run that will not end itself", () => {
  // Raced against a clock, and the clock is not decoration. Every check below is about a request
  // coming back; a chat that never answers one would hang the whole suite instead of failing a
  // check, and a mutation that cannot be watched failing is not a proof of anything.
  async function within(ms, what, made) {
    return Promise.race([
      made,
      new Promise((resolve) => setTimeout(() => resolve({ status: 0, body: `${what} never came back` }), ms)),
    ]);
  }

  async function rowFor(name) {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    return rows.find((row) => row.name === name) ?? null;
  }

  function untilAnswering(name) {
    return waitFor(async () => {
      const row = await rowFor(name);
      return row !== null && row.busy ? row : null;
    });
  }

  // The fixture ends what the fixture started. A run in this state has no ending of its own — it
  // goes because the chat ends it — and whether the chat does is the whole of what is checked
  // below, so the suite cannot lean on it having happened. Measured: with the forcing broken, the
  // two checks about it went red and were never printed, because the run left behind holds this
  // process's own output open and the reporter waits on it forever. A check that cannot be watched
  // failing proves nothing, so the clearing up happens here, by pid, after every check has read
  // what it needed. The shell a DEAF run leaves needs no help: it is detached, it holds nothing
  // open and it ends on its own clock.
  after(async () => {
    for (const entry of fs.readdirSync(standIn)) {
      if (!entry.startsWith("stuck")) {
        continue;
      }
      for (const pid of stuckRunsIn(path.join(standIn, entry))) {
        if (alive(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
    }

    await start(instance, standIns);
    assert.ok(await waitForHealth(URL), "the server never came back");
  });

  describe("a run that has gone quiet", () => {
    const quietLog = path.join(standIn, "stuck.txt");
    let answering;
    let ended;
    let answered;
    let refused;

    before(async () => {
      await start(instance, standInEnvironment(standIn, quietLog, { OW_STAND_IN_STUCK: "yes" }));
      assert.ok(await waitForHealth(URL), "the server never answered");

      // Not awaited: this is the message whose run never comes back on its own. Its answer is
      // collected further down, after the thing that lets it come back at all.
      const exchange = say("something that will never be answered");
      answering = await untilAnswering(LEADER);

      // Asked of a session nothing is running for, while another session's run IS going, so the
      // refusal is about this name and not about the chat being quiet.
      refused = await within(5000, "the refusal", post(`${URL}/sessions/${WORKER}/end`, {}));

      ended = await within(20000, "the ending", post(`${URL}/sessions/${LEADER}/end`, {}));
      answered = await within(5000, "the message", exchange);
    });

    it("ends a run that would not end on its own", () => {
      // The fixture, said before the thing it makes possible. Without this line a run that ended
      // on its own a moment after it started would satisfy the assertion below, and the ending
      // would be proving nothing — which is the one case this check exists to catch.
      assert.equal(answering?.busy, true, "no run was ever going, so there was nothing to end");
      assert.equal(ended.status, 200, ended.body);
    });

    // Named for the retry, because that is what it protects. A run that fails is asked again
    // without its thread — the repair for a conversation that cannot be resumed — and a run
    // somebody ended looks exactly like one of those from here. Measured before this guard
    // existed: the second run went quiet in the same way the first had, the message never came
    // back at all, and the conversation was thrown away on the way.
    it("does not start the run again once somebody has ended it", () => {
      assert.equal(answered.status, 200, answered.body);
      assert.equal(callsIn(quietLog).filter((call) => call.includes("--model")).length, 1);
    });

    // Read off the panel and not off what the route answered: a route that built the right object
    // and never wrote a row would satisfy a check on its own reply.
    it("says on the panel that the run was ended", async () => {
      const { messages } = JSON.parse((await transcriptOf(LEADER)).body);
      const last = messages.at(-1);
      assert.equal(last?.text, "this run was ended before it answered", JSON.stringify(last));
    });

    it("marks that line as a turn that did not answer", async () => {
      const { messages } = JSON.parse((await transcriptOf(LEADER)).body);
      assert.equal(messages.at(-1)?.failed, true);
    });

    it("refuses when nothing is running there", () => {
      assert.equal(refused.status, 409, refused.body);
    });
  });

  // A second message behind the first. The press that gets out of this has to reach the session
  // WITHOUT joining the queue it is unsticking — a way out that waits in the queue is not one.
  describe("with something else waiting behind it", () => {
    const behindLog = path.join(standIn, "stuck-queue.txt");
    let queued;
    let took;

    before(async () => {
      await start(instance, standInEnvironment(standIn, behindLog, { OW_STAND_IN_STUCK: "yes" }));
      assert.ok(await waitForHealth(URL), "the server never answered");

      const first = say("the one that gets stuck");
      await untilAnswering(LEADER);
      const second = say("the one waiting behind it");
      queued = await waitFor(async () => {
        const row = await rowFor(LEADER);
        return row !== null && row.queued > 0 ? row : null;
      });

      const at = Date.now();
      await within(20000, "the ending", post(`${URL}/sessions/${LEADER}/end`, {}));
      took = Date.now() - at;

      // Both are ended before this describe gives the chat back: the second message starts a run
      // of its own, and it is stuck in exactly the way the first one was.
      await within(20000, "the second ending", post(`${URL}/sessions/${LEADER}/end`, {}));
      await Promise.all([within(5000, "the first message", first), within(5000, "the second", second)]);
    });

    // On the clock rather than on the answer, because a route that joined the queue would not
    // answer WRONG — it would not answer at all, until a run that is never going to end ended.
    it("does not wait its turn behind the run it is ending", () => {
      assert.equal(queued?.queued, 1, "nothing was ever queued, so nothing was queued past");
      assert.ok(took < 5000, `the ending took ${took}ms, which is long enough to have waited in the queue`);
    });
  });

  // Two sessions in the same state, and one of them ended. The ending that already exists takes
  // every run at once, which is right on the way out of the chat and wrong here.
  describe("with another session in the same state", () => {
    const bothLog = path.join(standIn, "stuck-both.txt");
    let others;
    let runs;
    let theirsAfterwards;

    before(async () => {
      await start(instance, standInEnvironment(standIn, bothLog, { OW_STAND_IN_STUCK: "yes" }));
      assert.ok(await waitForHealth(URL), "the server never answered");

      const mine = say("the one that is ended");
      await untilAnswering(LEADER);
      const theirs = say("the one that is left alone", WORKER);
      await untilAnswering(WORKER);

      // Waited for rather than read, and the difference is not theoretical: a row says busy as soon
      // as the turn is counted, which is before the run behind it has started and said which
      // process it is. Measured — the log held one pid where the rows said two sessions were
      // answering. What this check reads is the process, so the process is what is waited for.
      // Oldest first, and the second of them is the one that is meant to be left alone.
      runs = await waitFor(() => {
        const said = pidsIn(bothLog);
        return said.length === 2 ? said : null;
      });

      await within(20000, "the ending", post(`${URL}/sessions/${LEADER}/end`, {}));
      others = await rowFor(WORKER);
      theirsAfterwards = runs === null ? null : alive(runs[1]);

      await within(20000, "the other ending", post(`${URL}/sessions/${WORKER}/end`, {}));
      await Promise.all([within(5000, "one message", mine), within(5000, "the other", theirs)]);
    });

    // The row is the guard here rather than a check of its own, because nothing can make it fail.
    // `busy` is how many turns a session has going, and a turn outlives the run that was serving it
    // by however long the answer takes to come back — so a run killed a moment ago still reads as
    // busy. Measured: an ending that took every run in the chat left that row saying exactly what
    // it says when the ending stayed where it was aimed.
    //
    // Asking the chat instead does not settle it either: the ending resolves on the process being
    // gone, and the run is taken out of the map by the close that follows, so the other session's
    // own ending still answers 200 for a run that is already dead. Only the machine knows. The pid
    // is what the fixture wrote down before it went quiet, and signal 0 asks about that process and
    // nothing else.
    it("leaves the other session's run running", () => {
      assert.equal(runs?.length, 2, `two runs should have started; the fixture recorded ${runs?.length}`);
      assert.equal(others?.busy, true, "the other session was not answering anything, so this proved nothing");
      assert.equal(theirsAfterwards, true, "ending one session's run ended the other session's too");
    });
  });

  // Asked and not going. Being asked is the whole of what a well behaved run needs, and the chat
  // has no way of knowing it is dealing with one that is not — so the forcing is what these are
  // about, and one of them is on the clock rather than on the outcome.
  describe("a run that will not go when it is asked", () => {
    const deafLog = path.join(standIn, "stuck-deaf.txt");
    let took;

    before(async () => {
      await start(
        instance,
        standInEnvironment(standIn, deafLog, { OW_STAND_IN_STUCK: "yes", OW_STAND_IN_DEAF: "yes" }),
      );
      assert.ok(await waitForHealth(URL), "the server never answered");

      const exchange = say("the one that will not go quietly");
      await untilAnswering(LEADER);

      const at = Date.now();
      await within(30000, "the ending", post(`${URL}/sessions/${LEADER}/end`, {}));
      took = Date.now() - at;
      await within(5000, "the message", exchange);
    });

    // The two seconds the chat waits before forcing one, and room around it. A run that will not
    // go has no other ending at all, so anything past this means the forcing never happened and
    // the check would otherwise sit there proving nothing.
    it("does not sit there waiting for a run that is never going to go", () => {
      assert.ok(took < 8000, `ending took ${took}ms, longer than the forcing should ever need`);
    });

    // A forced run cannot take its own shells with it — it is not running any more to do it — so
    // what it started is read out of the process table before it is forced rather than after,
    // where everything under it has been reparented and the way back to it is gone.
    it("leaves nothing the run had started behind either", async () => {
      const shells = shellsIn(deafLog);
      assert.ok(shells.length > 0, "the run started nothing, so this proved nothing");
      for (const shell of shells) {
        const gone = await waitFor(() => (alive(shell) ? null : true));
        assert.ok(gone, `the shell at ${shell} outlived the run that started it`);
      }
    });
  });
});

// How much of itself a session's conversation is carrying, so a person can tell when it is worth
// handing one over rather than finding out from the answers.
//
// The reading is real and comes off the result frame the chat already reads. It is the LAST request
// the turn made — that is the whole conversation as the model last saw it, and the turn after it
// opens there. The top level of `usage` adds the turn's requests together, so a turn that made two
// of them reports about twice what the thread holds; measured on a real session, 67,090 for a turn
// that ended at 41,929, with the next turn opening at 42,059. That is why the stand-in reports two
// requests of different sizes: a check that cannot tell the sum from the last of them is a check
// that would pass on a number growing at twice the rate of the conversation.
// What the chat has started and not finished.
//
// Two checks, and between them they pin the census from both sides. A reading that answered nothing
// whatever the chat was holding would satisfy the second on its own, and a reading that answered
// something whatever the chat was holding would satisfy the first — so neither is worth anything
// without the other, and both are here rather than one being called enough.
//
// The state is reached with a run that asks to be allowed something and waits: that is a run, the
// turn carrying it and the request it is waiting on, three of the four kinds at once and all of
// them ended by the same answer. The fourth is a call between sessions, and it is reached where the
// checks about every kind live rather than here — this slice is about the reading existing and
// being real, not about the kinds being complete.
describe("what the chat has not finished", () => {
  const censusLog = path.join(standIn, "census.txt");
  let idle;
  let holding;

  before(async () => {
    await start(instance, standInEnvironment(standIn, censusLog, { OW_STAND_IN_ASKS: "Bash" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    idle = JSON.parse((await get(`${URL}/unfinished`)).body).unfinished;

    // Not awaited: it does not come back until somebody answers the request, and what the chat is
    // holding while it waits is the whole subject here.
    const exchange = say("something it has to ask about first");
    const waited = await waitFor(async () => {
      const { permissions } = JSON.parse((await get(`${URL}/sessions/${LEADER}/permissions`)).body);
      return permissions.length > 0 ? permissions : null;
    });

    // A second message, queued behind a turn that cannot move. Two turns on one session are two
    // things the chat has not finished, and a census that named the session rather than the things
    // would report one — hiding the one that has been waiting longest.
    const behind = say("and this one waits behind it");
    await waitFor(async () => {
      const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
      return rows.find((row) => row.name === LEADER)?.queued === 1 ? true : null;
    });

    holding = JSON.parse((await get(`${URL}/unfinished`)).body).unfinished;

    // Both are let go the same way, oldest first: the second run asks in its turn, as this stand-in
    // always does, and neither comes back until it has been answered.
    await post(`${URL}/sessions/${LEADER}/permission`, { id: waited[0].id, decision: "allow" });
    await exchange;

    const next = await waitFor(async () => {
      const { permissions } = JSON.parse((await get(`${URL}/sessions/${LEADER}/permissions`)).body);
      return permissions.length > 0 ? permissions : null;
    });
    await post(`${URL}/sessions/${LEADER}/permission`, { id: next[0].id, decision: "allow" });
    await behind;
  });

  it("says nothing when the chat is holding nothing", () => {
    assert.deepEqual(idle, [], "the chat says it has not finished something nobody started");
  });

  it("names what it is holding, whose it is, and what would end it", () => {
    const mine = holding.filter((held) => held.name === LEADER);
    assert.ok(mine.length > 0, "the chat was holding nothing while a run waited to be allowed something");

    const kinds = [...new Set(mine.map((held) => held.kind))].sort();
    assert.deepEqual(kinds, ["request", "run", "turn"], JSON.stringify(mine));

    for (const held of mine) {
      assert.ok(
        typeof held.endedBy === "string" && held.endedBy !== "",
        `nothing says what ends a ${held.kind}: ${JSON.stringify(held)}`,
      );
    }
  });

  // One entry per thing, and this is the difference it makes. There were two messages on this
  // session and only one of them could move; a census keyed by session would answer that the
  // session had a turn going, which is true and useless, because the thing worth seeing is that
  // something has been waiting behind it the whole time.
  it("counts each thing it is holding rather than each session", () => {
    const turns = holding.filter((held) => held.name === LEADER && held.kind === "turn");
    assert.equal(turns.length, 2, `two messages were in flight, the chat says ${turns.length}`);
  });
});

// Every kind of thing the chat holds, reached at once, and every one of them let go.
//
// One scenario rather than a list of them. A kind's exit does not vary with how the turn went —
// the count comes down on one handler whether a turn answered or failed, and a request is taken
// off the same way whether it was allowed or denied — so a second scenario down the same exit
// catches nothing the first does not. Measured, by taking each exit out in turn: the turn, the
// request and the call are each already red on checks that exist. What nothing catches is a run
// left in the map, and there are two ways to leave one there — after it closes, and after it
// never started. Only the first is reachable: a spawn that fails emits `error` and then `close`
// — measured on 24.20.0 — so both handlers run on a run that never started and either one alone
// puts it away. A check on that state would have nothing that could break it.
//
// All four are held open together: the lead's run says something to the worker with the
// instance's own command and waits for the answer, and the worker's run, answering it, stops to
// ask to be allowed something. While that request sits there nothing moves anywhere — two runs,
// two turns, one call, one request — so this is a state to read rather than a moment to catch.
describe("every kind of thing the chat holds, and letting go of all of them", () => {
  const everyLog = path.join(standIn, "every.txt");
  let kinds;
  let afterwards;

  before(async () => {
    await start(
      instance,
      standInEnvironment(standIn, everyLog, {
        OW_STAND_IN_CALLS: `${LEADER}>${WORKER}`,
        OW_STAND_IN_ASKS: "Bash",
        // Longer than the stand-in's own default, because two requests are answered in turn here
        // and the second one is not even asked until the first has been.
        OW_STAND_IN_WAITS: "30000",
      }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");

    // Not awaited: it does not come back until both sessions are done, and what the chat is
    // holding while they are not is the whole subject.
    const asking = say("go and ask him", LEADER);

    // The worker's request is where everything is in flight at once. The worker only reaches it by
    // having been called, so the lead is waiting on the worker by the time this comes back — the
    // one wait here is the one the check needs, rather than a sleep hoping for it.
    const workers = await waitFor(async () => {
      const { permissions } = JSON.parse((await get(`${URL}/sessions/${WORKER}/permissions`)).body);
      return permissions.length > 0 ? permissions : null;
    });
    const held = JSON.parse((await get(`${URL}/unfinished`)).body).unfinished;
    kinds = [...new Set(held.map((one) => one.kind))].sort();

    // Let go from the inside out, the way the chat itself would: the worker is answered, its
    // answer ends the lead's call, and the lead then asks its own — this stand-in always does —
    // and is answered too, so the last turn ends of its own accord rather than being cut off.
    await post(`${URL}/sessions/${WORKER}/permission`, { id: workers[0].id, decision: "allow" });
    const leads = await waitFor(async () => {
      const { permissions } = JSON.parse((await get(`${URL}/sessions/${LEADER}/permissions`)).body);
      return permissions.length > 0 ? permissions : null;
    });
    await post(`${URL}/sessions/${LEADER}/permission`, { id: leads[0].id, decision: "allow" });
    await asking;

    afterwards = JSON.parse((await get(`${URL}/unfinished`)).body).unfinished;
  });

  // The kinds are named in one place and observed in another, and this is where the two are made
  // to agree. A fifth kind named without a scenario that reaches it goes red here and nowhere
  // else — which is the whole point of naming them: a state nobody can get to is a state nobody
  // has written an exit for.
  it("reaches every kind the chat names", () => {
    assert.deepEqual(kinds, [...KINDS].sort(), JSON.stringify(kinds));
  });

  it("has let go of every one of them once the last turn is over", () => {
    assert.deepEqual(afterwards, [], "the chat is still holding something nobody is waiting on");
  });
});

describe("how much of itself a session is carrying", () => {
  const sizeLog = path.join(standIn, "size.txt");
  const REQUESTS = [25142, 41929];
  const LAST = REQUESTS[REQUESTS.length - 1];
  const NEW_HAND = "Wren";

  async function stateOf(name) {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    return rows.find((row) => row.name === name) ?? null;
  }

  let neverAsked;
  let answered;
  let held;
  let onceHandedOver;

  before(async () => {
    runTool(instance, ["hire", NEW_HAND], process.env);
    await start(instance, standInEnvironment(standIn, sizeLog, { OW_STAND_IN_USAGE: REQUESTS.join(",") }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    neverAsked = await stateOf(NEW_HAND);
    await say("a first message", NEW_HAND);
    answered = await stateOf(NEW_HAND);
    // Read before the handover, which takes the file with it — that is the next check but one.
    held = JSON.parse(fs.readFileSync(path.join(instance, "chat", NEW_HAND, "session.json"), "utf8"));
    await post(`${URL}/sessions/${NEW_HAND}/handover`, {});
    onceHandedOver = await stateOf(NEW_HAND);
  });

  it("says nothing about a session that has never answered", () => {
    assert.equal(neverAsked.context, null);
  });

  it("says where the thread stood at the end of its last turn", () => {
    assert.equal(answered.context, LAST);
  });

  it("does not add the turn's requests together", () => {
    assert.notEqual(answered.context, REQUESTS.reduce((all, size) => all + size, 0));
  });

  it("keeps it with the thread it is about", () => {
    assert.equal(held.context, LAST);
  });

  it("has nothing to say once that thread has been handed over", () => {
    assert.equal(onceHandedOver.context, null);
  });

  // Read as text, like everything on that page.
  it("gives the page the words to put it in", async () => {
    assert.ok((await get(`${URL}/`)).body.includes("tokens after its last turn"));
  });

  it("gives the page the reading to put in them", async () => {
    assert.ok((await get(`${URL}/`)).body.includes("panel.carrying(row?.context)"));
  });
});

// Handing a session over from the page.
//
// A session's judgment goes as its thread fills, and the answer is not to summarise it: the desk
// carries the work, so a new conversation that reads it can carry on with nothing lost. The thread
// is one id in a file, so ending one is deleting that file — there is no process to stop, because a
// run lives for one message and is over long before this is asked for.
//
// The one thing that cannot be done from the server is writing the desk: the only permission an
// instance grants a person is `Edit(work/<Name>/STATE.md)`, so preparing is a question, and a
// question is a turn.
//
// These run on a desk of their own, opened here, so that ending its thread cannot disturb what the
// rest of the suite is in the middle of. A desk opened while the chat runs is somebody it can host
// from that moment, which is why this needs no restart.
// The room, on the page. No suite runs page.html — it is served and read as TEXT — so what is
// checked here is that the room is BUILT and that it is PUT somewhere, which are two different
// things: a section built and never attached is invisible to a check that only looks for it being
// built, and that has cost this repo a real check before.
//
// What the room actually says is proven on the rows behind it, in the three describes above. This
// is the seam between them and a browser, and it is not a substitute for opening one.
describe("what the page does with the room", () => {
  let page;

  before(async () => {
    page = (await get(`${URL}/`)).body;
  });

  it("gives the room somewhere to go on the page", () => {
    assert.ok(page.includes('<div id="room"></div>'));
  });

  // Repaired for feature 13, which gave the room a line of its own above the rows: the call now
  // spreads two lists, not one. What this check has always been about is that the rows are PUT
  // somewhere rather than merely built, so it still names `replaceChildren` and still names the
  // rows going into it, and only stops insisting they are the sole argument.
  it("puts what it builds into it, rather than only building it", () => {
    assert.match(page, /room\.replaceChildren\(.*sessions\.map\(inTheRoom\)\)/);
  });

  // At load and not only on the first tick: a room that is blank for a second every time the page
  // opens is a room nobody trusts. The check names the line it is filled from, because the tick
  // fills it too and a looser one would pass on that.
  // Repaired for feature 13: the load hands `showTheRoom` the whole answer rather than its rows,
  // because the room now draws one fact that is not on any row. The argument is still named, for
  // the reason it always was — the tick fills the room too, and a check that did not name the
  // argument would pass on a page that only ever filled it a second late.
  it("fills it when the page opens, not a second later", () => {
    assert.ok(page.includes("panels.replaceChildren(...built.map(({ section }) => section));\n  showTheRoom(atLoad);"));
  });

  // The reason the room is free: it reads the rows the panels were already being told about once a
  // second. A room with a poll of its own would be a request per second whether anybody was
  // reading it or not.
  it("asks for nothing of its own to keep it current", () => {
    assert.equal((page.match(/setInterval/g) ?? []).length, 1);
    assert.equal((page.match(/fetch\("\/sessions"\)/g) ?? []).length, 2);
  });

  it("says what each session is on", () => {
    assert.match(page, /row\.doing/);
  });

  // The order the phrases are tried in is the whole of what makes the room worth reading: the one
  // thing the person at the page can end comes before the ones they cannot.
  it("says a session waiting on a person before anything else about it", () => {
    const said = page.indexOf('"needs you"');
    const held = page.indexOf("`waiting for ${row.waitingFor}`");
    const busy = page.indexOf('"answering"');
    assert.ok(said > 0 && said < held && held < busy);
  });

  it("says how long since a panel last moved", () => {
    assert.match(page, /last moved \$\{when\}/);
  });

  it("says when a session has no thread to carry on", () => {
    assert.match(page, /"nothing to carry on"/);
  });
});

// What a panel does with a transcript. No suite runs page.html — it is served and read as TEXT —
// so these say that the lines ship and that they are in the tick rather than merely in the file.
// The same kind, and the same weakness, as the room describe above; step 3 of the manual test is
// what closes it, and nothing here stands in for opening a browser.
//
// The body of the one setInterval on the page, so that a check about what the tick does reads the
// tick and not the file. A string that merely appears somewhere in the script would pass on a
// function nothing calls — which is the shape this repo has already paid for once, when a button
// was built and never attached.
function theTick(page) {
  const from = page.indexOf("setInterval(");
  const to = page.indexOf("}, EVERY);", from);
  assert.ok(from > 0 && to > from, "the page has no tick to read");
  return page.slice(from, to);
}

// And the submit handler's body, for the same reason: the first `await show();` after the POST
// is not necessarily inside the handler that made it — the handover button has one too, and a
// check that searched on from there passed on that when the send's own draw was deleted. This was
// watched happening; the mutation reported nothing until the search was bounded to the handler.
function theSend(page) {
  const from = page.indexOf(`composer.addEventListener("submit"`);
  const to = page.indexOf(`hand.addEventListener("click"`, from);
  assert.ok(from > 0 && to > from, "the page has no send to read");
  return page.slice(from, to);
}

describe("what the page does with a transcript", () => {
  let page;

  before(async () => {
    page = (await get(`${URL}/`)).body;
  });

  // Until this line exists, a panel shows what happened when this page last spoke, and anything
  // caused by anybody else — the lead answering a worker, a line from the chat — is invisible
  // until somebody sends something or reloads.
  it("asks for a transcript on the tick, not only when this page caused something", () => {
    assert.match(theTick(page), /show\(\)/);
  });

  // At load and not a second later, for the reason the room is filled at load: a panel that is
  // blank for a second every time the page opens is a panel nobody trusts. The check names the
  // line it is filled from, because the tick fills it too and a looser one would pass on that.
  it("draws every panel when the page opens, not on the first tick", () => {
    assert.ok(page.includes("await Promise.all(built.map(({ show }) => show()));"));
  });

  // Sending is the one moment a person is waiting on a specific answer, and a second of nothing
  // there reads as a message that did not go.
  it("still draws the panel as soon as this page's own message has been answered", () => {
    const sent = theSend(page);
    const posted = sent.indexOf("fetch(`/sessions/${session.name}/message`");
    const redrawn = sent.indexOf("await show();", posted);
    assert.ok(posted > 0 && redrawn > posted, "the send does not draw the panel afterwards");
  });

  // A panel redrawn every second cannot be read from: a selection does not survive
  // replaceChildren, so copying a line out of a running chat would be a race with the clock.
  it("does not redraw a panel that has not changed", () => {
    assert.match(page, /if \(messages\.length === shown\) \{\s*return;\s*\}/);
  });

  it("remembers how much of a panel it has drawn", () => {
    assert.match(page, /shown = messages\.length;/);
  });
});

// The room on the command line. The lead is a session on the page and so cannot look at the page,
// which is the whole reason this exists; the person at a terminal gets it for nothing.
//
// It asks the chat rather than reading the instance, because half of a room is only in the running
// process — how many turns are going, who is held up waiting for whom, what is stopped waiting to
// be allowed something. So it is the same rows the page uses, laid out for a terminal.
describe("showing the room on the command line", () => {
  const roomLog = path.join(standIn, "room.txt");
  const IN_THE_ROOM = "Lark";
  let shown;
  let held;
  let here;

  before(async () => {
    runTool(instance, ["hire", IN_THE_ROOM], process.env);
    const desk = path.join(instance, "work", IN_THE_ROOM, "STATE.md");
    const lines = fs.readFileSync(desk, "utf8").split("\n");
    lines[0] = `<!-- DESK | name: ${IN_THE_ROOM} | title: reading the water meter | status: at it -->`;
    fs.writeFileSync(desk, lines.join("\n"));

    await start(instance, standInEnvironment(standIn, roomLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    shown = runTool(instance, ["room"], standIns);
    here = JSON.parse((await get(`${URL}/sessions`)).body).sessions.length;

    // And again while somebody is actually mid-turn, because a room that only ever reports an
    // empty office says nothing worth reading. Not awaited: the point is what it says WHILE.
    const answering = say("take your time", WORKER);
    held = await waitFor(() => {
      const said = runTool(instance, ["room"], standIns);
      return said.stdout.includes("answering") ? said : null;
    });
    await answering;
  });

  it("answers at all", () => {
    assert.equal(shown.status, 0);
  });

  it("gives one line to each person who works here", () => {
    assert.equal(shown.stdout.trim().split("\n").length, here);
  });

  it("names everybody in it", () => {
    assert.ok(shown.stdout.includes(LEADER) && shown.stdout.includes(WORKER));
  });

  it("says what each of them is on", () => {
    assert.match(shown.stdout, /reading the water meter/);
  });

  it("says so about somebody who has not filled it in", () => {
    assert.match(shown.stdout, /has not said what it is on/);
  });

  it("says which of them is answering, while one is", () => {
    assert.match(held.stdout, new RegExp(`${WORKER}[^\\n]*answering`));
  });

  it("says the others are idle at the same moment", () => {
    assert.match(held.stdout, new RegExp(`${LEADER}[^\\n]*idle`));
  });

  it("says how long since a panel last moved", () => {
    assert.match(shown.stdout, /last moved |nothing said yet/);
  });

  it("takes no arguments", () => {
    assert.match(runTool(instance, ["room", "Paul"], standIns).stderr, /takes no arguments/);
  });

  it("is offered in the usage", () => {
    assert.match(runTool(instance, ["--help"], standIns).stdout, /ow room/);
  });
});

const AT_WORK = "Rook";

// What each session is on. Nothing else on the row can answer it: a name says who somebody is and
// a transcript says what they were last asked, and neither is the work.
//
// It comes from the one header field the personas ask a session to keep current, so this is as
// much about the desk file being read correctly as about the field being there — a header is one
// line of separators and it is easy to read one field and get the next one with it.
describe("what the page is told about what each session is on", () => {
  const doingLog = path.join(standIn, "doing.txt");

  function header(name, title) {
    writeHeader(name, `<!-- DESK | title: ${title} -->`);
  }

  function writeHeader(name, line) {
    const desk = path.join(instance, "work", name, "STATE.md");
    const lines = fs.readFileSync(desk, "utf8").split("\n");
    lines[0] = line;
    fs.writeFileSync(desk, lines.join("\n"));
  }

  async function doingOf(name) {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    return rows.find((row) => row.name === name)?.doing;
  }

  before(async () => {
    runTool(instance, ["hire", AT_WORK], process.env);
    await start(instance, standInEnvironment(standIn, doingLog));
    assert.ok(await waitForHealth(URL), "the server never answered");
  });

  it("says what a session put in its header", async () => {
    header(AT_WORK, "counting the doors on the second floor");
    assert.equal(await doingOf(AT_WORK), "counting the doors on the second floor");
  });

  // A header the instance ships holds one field, but one written before that does not, and a desk
  // is a file a person may have written anything into. So a header carrying more still reads.
  it("says what a session put in a header that holds more than the title", async () => {
    writeHeader(AT_WORK, `<!-- DESK | name: ${AT_WORK} | title: reading the water meter | status: at it -->`);
    assert.equal(await doingOf(AT_WORK), "reading the water meter");
  });

  // The fields are divided by pipes, so a reader that does not stop at the next one hands back the
  // status and the date as though the session had written them.
  it("stops at the end of that field and does not read the next one", async () => {
    writeHeader(AT_WORK, `<!-- DESK | name: ${AT_WORK} | title: counting the doors | status: at it | updated: 2026-01-01 -->`);
    assert.equal(await doingOf(AT_WORK), "counting the doors");
  });

  // A title written last has the comment's own ending after it, which is not part of what anybody
  // typed.
  it("does not read the end of the header line as part of it", async () => {
    const desk = path.join(instance, "work", AT_WORK, "STATE.md");
    const lines = fs.readFileSync(desk, "utf8").split("\n");
    lines[0] = `<!-- DESK | title: last of all -->`;
    fs.writeFileSync(desk, lines.join("\n"));
    assert.equal(await doingOf(AT_WORK), "last of all");
  });

  it("says nothing about a session that has not filled it in", async () => {
    header(AT_WORK, "");
    assert.equal(await doingOf(AT_WORK), "");
  });

  it("says nothing when the desk has no header at all", async () => {
    const desk = path.join(instance, "work", AT_WORK, "STATE.md");
    fs.writeFileSync(desk, "# Rook\n\nno header on this one\n");
    assert.equal(await doingOf(AT_WORK), "");
  });

  it("says nothing when there is no desk file to read", async () => {
    fs.rmSync(path.join(instance, "work", AT_WORK, "STATE.md"));
    assert.equal(await doingOf(AT_WORK), "");
  });
});

const SPEAKS = "Wren";
const SILENT = "Jay";
const UNMEASURED = "Fern";

// Whether a session has a conversation to carry on, and when anything last happened on its panel.
//
// The two are read from different files on purpose and neither can stand in for the other. A
// thread is a session.json with an id in it; a panel's clock is the conversation file's modified
// time. The interesting session is the one that has just been handed over, because that is where
// every cheaper answer goes wrong: it has a full panel and no thread, and its session.json — the
// obvious place to read a time from — has just been deleted.
describe("what the page is told about a session's thread and when it last moved", () => {
  const threadLog = path.join(standIn, "thread.txt");
  let never;
  let spoken;
  let unmeasured;
  let handed;
  let before1;
  let before2;
  let panel;

  async function stateOf(name) {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    return rows.find((row) => row.name === name) ?? null;
  }

  before(async () => {
    runTool(instance, ["hire", SPEAKS], process.env);
    runTool(instance, ["hire", SILENT], process.env);
    runTool(instance, ["hire", UNMEASURED], process.env);

    // First, a session whose run says nothing about how big it got. It is the state where having
    // a thread and having a reading come apart, and without it every cheaper answer to "has a
    // thread" agrees with the right one and nothing here would be proving anything.
    await start(instance, standInEnvironment(standIn, threadLog));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("something, and nothing about the size of it", UNMEASURED);
    unmeasured = await stateOf(UNMEASURED);

    await start(instance, standInEnvironment(standIn, threadLog, { OW_STAND_IN_USAGE: "4000" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    never = await stateOf(SILENT);

    await say("the first thing anybody said here", SPEAKS);
    before1 = (await stateOf(SPEAKS)).active;

    // A second message, so the clock has somewhere to move to. Two appends within the same
    // millisecond would make a moving clock and a stuck one look identical, and the run in
    // between takes longer than that.
    await say("and a second thing", SPEAKS);
    spoken = await stateOf(SPEAKS);
    before2 = spoken.active;

    await post(`${URL}/sessions/${SPEAKS}/handover`, {});
    handed = await stateOf(SPEAKS);
    panel = JSON.parse((await transcriptOf(SPEAKS)).body).messages;
  });

  it("says a session that has answered has a thread", () => {
    assert.equal(spoken.thread, true);
  });

  it("says a session nobody has spoken to has none", () => {
    assert.equal(never.thread, false);
  });

  // Ada's trap, and the reason this is its own field. A run that reported no usage is remembered
  // with no reading, so `context` is null here — exactly as it is for a session with no thread at
  // all. Anything that reads the reading to answer this question gets this one wrong.
  it("says a session has a thread even when nothing was reported about its size", () => {
    assert.deepEqual([unmeasured.thread, unmeasured.context], [true, null]);
  });

  // The one the cheaper answer gets wrong. `context` is null for a session that has no thread AND
  // for a run that reported no usage, so it cannot be read as this — and here the panel is full,
  // which is what makes a session with nothing to resume look like an ordinary one.
  it("says a session that was handed over has no thread, though its panel is not empty", () => {
    assert.equal(handed.thread, false);
    assert.ok(panel.length > 0);
  });

  it("says when a session's panel last moved", () => {
    assert.ok(!Number.isNaN(Date.parse(spoken.active)));
  });

  it("moves that time on when something else is said", () => {
    assert.ok(Date.parse(before2) > Date.parse(before1));
  });

  // The check the choice of clock rests on. The session ran a moment ago and its panel says so;
  // reading the time off the thread's own file would say it had never done anything at all,
  // because ending a thread deletes that file.
  it("still says when a handed-over session's panel last moved", () => {
    assert.ok(!Number.isNaN(Date.parse(handed.active)));
    assert.ok(Date.parse(handed.active) >= Date.parse(before2));
  });

  it("says nothing at all about a session nobody has spoken to", () => {
    assert.equal(never.active, null);
  });
});

// When a conversation last RAN, which is a different question from when its panel last moved and
// is answered by a different file. The panel is appended to outside any run — an overheard line
// is — so its clock walks forward on a session that has not thought since. Anything deciding what
// to do about a conversation itself has to ask this one.
function threadFile(name) {
  return path.join(instance, "chat", name, "session.json");
}

function panelFile(name) {
  return path.join(instance, "chat", name, "conversation.json");
}

// Age a file by hand. The state these checks act on is a real modified time on a real file, so they
// make a genuinely old one rather than telling the code what time it is — a knob the check and the
// code both read would prove nothing.
function age(file, minutes) {
  const when = new Date(Date.now() - minutes * 60 * 1000);
  fs.utimesSync(file, when, when);
}

const RAN = "Curlew";
const NEVER_RAN = "Dunlin";

describe("when a conversation last ran", () => {
  const ranLog = path.join(standIn, "ran.txt");
  let afterATurn;

  before(async () => {
    runTool(instance, ["hire", RAN], process.env);
    runTool(instance, ["hire", NEVER_RAN], process.env);
    await start(instance, standInEnvironment(standIn, ranLog));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("something, so there is a thread at all", RAN);
    afterATurn = ranAt(instance, RAN);
  });

  // Mutation: return a fixed time.
  it("is within seconds of now, straight after a turn", () => {
    assert.equal(typeof afterATurn, "number");
    assert.ok(Math.abs(Date.now() - afterATurn) < 30_000, `read ${afterATurn}, now ${Date.now()}`);
  });

  // Mutation: read a field written into session.json rather than the file's own time. A workspace
  // installed before this reader existed has no such field, and the modified time is right on
  // every one of them from the first day. Ageing the real file is what tells the two apart.
  it("moves back when the thread's own file is older", () => {
    age(threadFile(RAN), 90);
    assert.ok(ranAt(instance, RAN) < afterATurn - 80 * 60 * 1000);
  });

  // Mutation: read conversation.json's modified time. The whole reason this reader exists.
  it("is the thread's clock and not the panel's", () => {
    age(threadFile(RAN), 90);
    const now = new Date();
    fs.utimesSync(panelFile(RAN), now, now);
    assert.ok(Date.now() - ranAt(instance, RAN) > 80 * 60 * 1000);
  });

  // Mutation: answer Date.now() when the file is missing. A session that never ran has to read as
  // nothing and never as "just now": whatever is built on this reads a time as a fact.
  it("is nothing for a session that has never run", () => {
    assert.equal(ranAt(instance, NEVER_RAN), null);
  });

  // Mutation: leave session.json behind in forget(). A session handed over has no conversation
  // left to say anything about, and a file that survived would carry the old time forward.
  it("is nothing again once the thread has been ended", async () => {
    await post(`${URL}/sessions/${RAN}/handover`, {});
    assert.equal(ranAt(instance, RAN), null);
  });
});

const COLD = "Plover";

describe("a message to a conversation that has gone cold", () => {
  const log = path.join(standIn, "cold.txt");
  let answered;
  let rows;

  before(async () => {
    runTool(instance, ["hire", COLD], process.env);
    await start(instance, standInEnvironment(standIn, log));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A thread to go cold. Without a first message there is nothing here to end.
    await say("the first thing, which starts a thread", COLD);
    assert.ok(fs.existsSync(threadFile(COLD)), "no thread to age");

    // Ninety minutes, which is past any TTL this design would name.
    age(threadFile(COLD), 90);

    answered = await say("and now, hours later, this", COLD);

    const panel = JSON.parse((await transcriptOf(COLD)).body).messages;
    rows = panel;
  });

  // THE behaviour. Mutation: deliver without testing the age at all — which is today's code, so
  // this check must fail before the feature exists.
  it("starts a new conversation rather than resuming the old one", () => {
    const since = callsIn(log).slice(-1)[0];
    assert.ok(!since.includes("--resume"), `the run still resumed: ${since}`);
  });

  // Mutation: end the thread on every message. The saving is worthless if it costs every
  // conversation in the workspace.
  it("still answers the message", () => {
    assert.equal(answered.status, 200);
  });

  it("leaves the desk where it was", () => {
    assert.ok(fs.existsSync(path.join(instance, "work", COLD, "STATE.md")));
  });

  // Mutation: append the line after the reply. A person reading this panel has to find the reason
  // the memory stops BEFORE the answer that came from a fresh head, or the record reads backwards.
  it("says on the panel that the conversation was ended, before the question", () => {
    const said = rows.findIndex((row) => row.cold === true);
    const asked = rows.findIndex((row) => row.text?.includes("hours later"));
    assert.ok(said !== -1, "nothing on the panel says the thread was ended");
    assert.ok(said < asked, "the panel says it after the question rather than before");
  });

  // Mutation: build the wrapper and never pass it to inFrontOf. Feature 3's measured trap — a
  // thing built and never attached is invisible to a check that only looks for it being built.
  it("hands the new conversation an instruction to pick up from its desk", () => {
    const asked = questionsIn(log).find((question) => question.includes("hours later"));
    assert.match(asked ?? "", /<pick-up>[\s\S]*<\/pick-up>/);
  });

  it("names the desk in that instruction", () => {
    const asked = questionsIn(log).find((question) => question.includes("hours later"));
    assert.match(asked ?? "", new RegExp(`<pick-up>[\\s\\S]*work/${COLD}/STATE.md[\\s\\S]*</pick-up>`));
  });

  // Mutation: hand it over bare rather than wrapped. Anything outside a wrapper is the human
  // speaking on this session's own panel, so an unwrapped instruction arrives as the human's.
  it("wraps it, so it does not arrive as though the human had typed it", () => {
    const asked = questionsIn(log).find((question) => question.includes("hours later"));
    assert.match(asked ?? "", /^<pick-up>/);
  });

  // Mutation: set the flag and have the result drop it. The caller of say is a different session
  // and never reads the addressee's panel, so without this the one reader who most needs to know
  // is the only one not told.
  it("tells whoever asked that the answer comes from a fresh head", () => {
    assert.equal(JSON.parse(answered.body).restarted, true);
  });
});

// ---------------------------------------------------------------------------------------------
// The clock, which is the mistake this design exists to avoid
// ---------------------------------------------------------------------------------------------

const PANEL_MOVED = "Finch";

describe("a conversation whose panel moved but which has not run for hours", () => {
  const log = path.join(standIn, "clock.txt");

  before(async () => {
    runTool(instance, ["hire", PANEL_MOVED], process.env);
    await start(instance, standInEnvironment(standIn, log));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("the first thing", PANEL_MOVED);

    // The thread is old; the PANEL is fresh. This is the lead's situation exactly: an overheard
    // line is appended to its panel outside any turn, so conversation.json's mtime walks forward
    // while the conversation itself sits untouched.
    age(threadFile(PANEL_MOVED), 90);
    const now = new Date();
    fs.utimesSync(panelFile(PANEL_MOVED), now, now);

    await say("and now this", PANEL_MOVED);
  });

  // Mutation: read conversation.json's mtime instead. This check fails outright under it, which
  // is the entire point of writing it.
  it("is treated as cold, because the clock is the thread's and not the panel's", () => {
    const since = callsIn(log).slice(-1)[0];
    assert.ok(!since.includes("--resume"), `the panel clock was used: ${since}`);
  });
});

const WARM = "Merle";

describe("a message to a conversation that ran a moment ago", () => {
  const log = path.join(standIn, "warm.txt");
  let answered;
  let rows;

  before(async () => {
    runTool(instance, ["hire", WARM], process.env);
    await start(instance, standInEnvironment(standIn, log));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("the first thing", WARM);
    answered = await say("and the second, moments later", WARM);
    rows = JSON.parse((await transcriptOf(WARM)).body).messages;
  });

  // Mutation: end the thread on every message.
  it("carries the conversation on", () => {
    const since = callsIn(log).slice(-1)[0];
    assert.ok(since.includes("--resume"), `a live conversation was thrown away: ${since}`);
  });

  // Mutation: pass the pick-up wrapper on every turn. It costs a sentence in every turn forever
  // if it is not gated, and it tells a session to re-read a desk it is already working from.
  it("is handed no instruction to pick up from a desk", () => {
    const asked = questionsIn(log).find((question) => question.includes("second, moments later"));
    assert.doesNotMatch(asked ?? "", /<pick-up>/);
  });

  it("says nothing on the panel about a thread being ended", () => {
    assert.equal(rows.some((row) => row.cold === true), false);
  });

  it("tells whoever asked nothing about a fresh head", () => {
    assert.notEqual(JSON.parse(answered.body).restarted, true);
  });
});

const UNREADABLE = "Avocet";

describe("a session whose thread cannot be read", () => {
  const log = path.join(standIn, "unreadable.txt");

  before(async () => {
    runTool(instance, ["hire", UNREADABLE], process.env);
    await start(instance, standInEnvironment(standIn, log));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("the first thing", UNREADABLE);
    fs.writeFileSync(threadFile(UNREADABLE), "this is not JSON");

    // Aged, or this proves nothing: the write above leaves the clock seconds old, so the gate
    // would decline for the ordinary reason and the check would pass with the rule inverted.
    age(threadFile(UNREADABLE), 90);

    await say("and now this", UNREADABLE);
  });

  // Mutation: treat unreadable as cold. There is no thread here to end — hasThread already reads
  // false — so the run starts fresh whatever this feature does. What must not happen is the
  // feature ending a thread that was not there and announcing a restart nobody made.
  it("is left exactly as it was, and nothing is ended", () => {
    assert.ok(fs.existsSync(threadFile(UNREADABLE)));
  });

  it("is told nothing about picking up from a desk", () => {
    const asked = questionsIn(log).find((question) => question.includes("and now this"));
    assert.doesNotMatch(asked ?? "", /<pick-up>/);
  });

  it("has nothing said on its panel about a thread being ended", async () => {
    const rows = JSON.parse((await transcriptOf(UNREADABLE)).body).messages;
    assert.equal(rows.some((row) => row.cold === true), false);
  });
});

describe("the session that leads, after hours of quiet", () => {
  const log = path.join(standIn, "lead.txt");

  before(async () => {
    await start(instance, standInEnvironment(standIn, log));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("the first thing", LEADER);
    age(threadFile(LEADER), 90);
    await say("and now this", LEADER);
  });

  // Mutation: exempt the lead. It is the session with the largest conversation and therefore the
  // one this feature saves most on; a special case for it would be the wrong special case.
  it("takes the same path as anybody else", () => {
    const since = callsIn(log).slice(-1)[0];
    assert.ok(!since.includes("--resume"), `the lead was exempted: ${since}`);
  });
});

const ON_THE_ROW = "Knot";

describe("what the room says about a conversation that has gone cold", () => {
  const log = path.join(standIn, "row.txt");
  let cold;
  let never;
  let room;

  before(async () => {
    runTool(instance, ["hire", ON_THE_ROW], process.env);
    await start(instance, standInEnvironment(standIn, log));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("the first thing", ON_THE_ROW);
    age(threadFile(ON_THE_ROW), 90);

    const { sessions } = JSON.parse((await get(`${URL}/sessions`)).body);
    cold = sessions.find((row) => row.name === ON_THE_ROW);
    never = sessions.find((row) => row.name === WARM);

    room = runTool(instance, ["room"], standInEnvironment(standIn, log)).stdout;
  });

  // Mutation: compute it from active. The row and the chat have to be reading the same number, or
  // the room is a guess again rather than a description of what the next message will do.
  it("carries the flag, true past the constant", () => {
    assert.equal(cold?.cold, true);
  });

  // Mutation: default it to true. A session with no conversation has nothing that can be cold.
  it("is false for a session with no thread at all", () => {
    assert.equal(never?.cold, false);
  });

  // Mutation: say it in room.mjs only. The page lays the same rows out in its own script, and the
  // two have to say the same word.
  it("says cold where it would have said idle", () => {
    assert.match(room ?? "", new RegExp(`${ON_THE_ROW}\\s.*cold`));
  });

  // No suite runs page.html — it is read as text — so the page's copy is proven by reading it,
  // and the check is that the word is BUILT and ATTACHED, not merely present in a string.
  it("says the same word in the page's own copy of the room", () => {
    const page = fs.readFileSync(path.join(instance, "tools", "chat", "page.html"), "utf8");
    assert.match(page, /row\.cold/);
    assert.match(page, /"cold"|'cold'|`cold`/);
  });
});


const REFUSED_ON_THE_ROW = "Wigeon";
const LIFTED = "Gadwall";
const NO_RESET_GIVEN = "Pintail";
const NEVER_REFUSED = "Shoveler";

const GAUGED = "Dipper";
const NEVER_GAUGED = "Ouzel";
const GAUGED_REFUSED = "Bittern";

// What a session's row says about the usage window its last run was told about.
//
// The reading is a fact about a RUN, so it is kept where a run's facts are kept and read back the
// way context is. Everything here is read off the row and off session.json both, because the two
// answer different questions and only the file proves the write survived the process.
//
// The whole of the risk in this feature is that a reading and a verdict are different things: the
// service says "allowed" on an ordinary run and can turn the same run away moments later, and a
// gauge that let its reading reach the verdict would report an answer for a run that never
// happened. Check "still reports a refusal" below is what holds them apart.
describe("what a row says about the usage window its last run was told about", () => {
  const gaugeLog = path.join(standIn, "gauge.txt");
  const gauged = (extra) => standInEnvironment(standIn, gaugeLog, extra);
  let told;
  let neverRan;
  let afterSilence;
  let refusedRow;
  let refusedOutcome;
  let allowedOutcome;
  let survived;
  let ranAtMs;
  let held;

  before(async () => {
    runTool(instance, ["hire", GAUGED], process.env);
    runTool(instance, ["hire", NEVER_GAUGED], process.env);
    runTool(instance, ["hire", GAUGED_REFUSED], process.env);

    // A run the service allowed, carrying a fullness this suite chose rather than one the fixture
    // had written down.
    await start(instance, gauged({ OW_STAND_IN_LIMIT: "allowed", OW_STAND_IN_FULLNESS: "0.71" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    allowedOutcome = await say("the first thing", GAUGED);

    ranAtMs = fs.statSync(threadFile(GAUGED)).mtimeMs;
    held = JSON.parse(fs.readFileSync(threadFile(GAUGED), "utf8"));

    let rows = JSON.parse((await get(`${URL}/sessions`)).body).sessions;
    told = rows.find((row) => row.name === GAUGED);
    neverRan = rows.find((row) => row.name === NEVER_GAUGED);

    // The same instance, served by a new process. A reading held in memory would go here.
    await start(instance, gauged({ OW_STAND_IN_LIMIT: "allowed", OW_STAND_IN_FULLNESS: "0.71" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    survived = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((row) => row.name === GAUGED);

    // Told it was allowed, and turned away all the same. Both frames travel, in that order, which
    // is the run this whole design is built not to misreport.
    await start(instance, gauged({ OW_STAND_IN_LIMIT: "allowed", OW_STAND_IN_FULLNESS: "0.42", OW_STAND_IN_REFUSED: "1" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    refusedOutcome = await say("something while the account is out", GAUGED_REFUSED);
    refusedRow = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((row) => row.name === GAUGED_REFUSED);

    // And a later run on the gauged session carrying no reading at all: the frame simply does not
    // arrive, which is what an ordinary run does once the reading has stopped moving.
    await start(instance, gauged());
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("the second thing", GAUGED);
    afterSilence = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((row) => row.name === GAUGED);
  });

  // Mutation: have the reader return a fixed number. The number on the row is the number that was
  // on the frame, or the row is decoration.
  //
  // The whole shape and not just the number, which is why this had to be repaired when the reading
  // learned to carry the moment its window ends: a check written against the exact object is the
  // one that notices a field arriving, and that is the check working rather than a check in the
  // way. The moment itself is asserted next door, where two windows can be put in front of it.
  it("carries the fullness the frame gave, for the window the frame named", () => {
    const five = told?.quota?.windows?.find((window) => window.name === "five_hour");
    assert.equal(five?.name, "five_hour");
    assert.equal(five?.fullness, 0.71);
    assert.deepEqual(Object.keys(five ?? {}).sort(), ["fullness", "name", "resetsAt"]);
  });

  // Mutation: keep only the five-hour window. Picking one would write a window's name into this
  // toolkit for the service to rename underneath it.
  it("carries every window the frame named, in the frame's own order", () => {
    assert.deepEqual(
      told?.quota?.windows?.map((window) => window.name),
      ["five_hour", "seven_day"],
    );
  });

  // Mutation: take the moment from Date.now(). The reading is as old as the run that took it, and
  // the file the run wrote IS that moment — a clock of our own would read as now and be wrong by
  // however long the session has been quiet.
  it("says when the reading was taken, and it is the thread file's own moment", () => {
    assert.equal(told?.quota?.at, ranAtMs);
  });

  // Mutation: default the field to an object. A session that has never run has not been told
  // anything, and nothing is what it should say.
  it("says nothing at all about a session that has never run", () => {
    assert.equal(neverRan?.quota, null);
  });

  // Mutation: keep the previous quota when a run reports none. This is the same trap as letting a
  // reading reach a verdict, in different clothes: a number from a turn that is no longer where
  // the thread is, presented as what is true now.
  it("writes nothing over rather than carrying the last number forward", () => {
    assert.equal(afterSilence?.quota, null);
    assert.equal(JSON.parse(fs.readFileSync(threadFile(GAUGED), "utf8")).quota, null);
  });

  // Mutation: hand the reading to turnedAway(). THIS IS THE GUARD, and it is this direction of it
  // that bites.
  //
  // `limit` is a refusal or it is nothing; a reading is sent on every ordinary run and says
  // "allowed". A verdict that could see the reading would find something non-null on every single
  // run and call all of them refusals — so it is the ALLOWED run that goes red first, not the
  // refused one. The refused direction below stays green under that mutation (the last reading on
  // a refused run IS the rejected one), which is exactly why it cannot be the check that holds
  // this: it agrees with the trap.
  it("does not report a refusal for a run the service allowed, however full the window was", () => {
    assert.equal(allowedOutcome.status, 200);
    assert.equal(JSON.parse(allowedOutcome.body).refused, undefined);
  });

  // And the other direction, which is feature 9's rule restated from this side: a run that was
  // told it was allowed and then turned away is a refusal, and the allowance it was given first
  // does not soften it into an answer.
  it("still reports a refusal for a run that was told allowed and then turned away", () => {
    assert.equal(refusedOutcome.status, 503);
    assert.equal(JSON.parse(refusedOutcome.body).refused, true);
  });

  // Mutation: drop the reading on the refused path. A refused run was still told how full the
  // window was, and that reading is the most interesting one there is.
  it("carries the fullness of a run that was refused", () => {
    assert.equal(
      refusedRow?.quota?.windows?.find((window) => window.name === "five_hour")?.fullness,
      0.42,
    );
  });

  // Mutation: hold the reading in memory instead of writing it. The row is served by whatever
  // process is up, and a reading that lives in one of them is a reading that is gone.
  it("is on disk, so a row still carries it after the server has been restarted", () => {
    // Said before the comparison, and not for tidiness: two rows that both carry nothing are equal,
    // so a check that only compared them would pass most loudly in the one case it exists to catch
    // — the reading never reaching the file at all. Measured: without this line the mutation that
    // drops the reading from what is written leaves this check green.
    assert.ok(Array.isArray(survived?.quota?.windows), "the reading did not survive the restart");
    assert.deepEqual(survived.quota.windows, told?.quota?.windows);
    assert.deepEqual(held.quota, told?.quota?.windows);
  });
});


const LIFT_ON_THE_ROW = "Godwit";
const LIFT_NOT_GIVEN = "Ruff";

// When each window the frame named comes to an end.
//
// The moment is on every window of every frame, on ordinary allowed runs — which is what makes it
// worth keeping: whether a limit has been hit is answerable only after one has, and when a window
// ends is answerable before.
//
// TWO windows throughout, never one. The frame carries a moment beside `status` as well as one
// inside each window, and for the window it names as the one it is talking about the two are the
// same number — measured on every capture we have. So a reader that took the outer moment and gave
// it to every window would be right about the first window in every single-window fixture, and
// wrong about the second. The second window is the check.
describe("what a row says about when each usage window ends", () => {
  const liftLog = path.join(standIn, "lift.txt");
  let both;
  let unsaid;
  let takenAt;

  before(async () => {
    runTool(instance, ["hire", LIFT_ON_THE_ROW], process.env);
    runTool(instance, ["hire", LIFT_NOT_GIVEN], process.env);

    await start(instance, standInEnvironment(standIn, liftLog, { OW_STAND_IN_LIMIT: "allowed" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    takenAt = Math.floor(Date.now() / 1000);
    await say("something, so the window is read", LIFT_ON_THE_ROW);
    both = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((row) => row.name === LIFT_ON_THE_ROW);

    // A frame that says nothing about when it lifts. The stand-in drops the moment from the
    // five-hour window and from beside `status`, and leaves the seven-day one saying when it ends
    // — so one row carries both answers and nothing can satisfy the check by writing one of them.
    await start(instance, standInEnvironment(standIn, liftLog, { OW_STAND_IN_REFUSED: "yes", OW_STAND_IN_NO_RESET: "yes" }));
    assert.ok(await waitForHealth(URL), "the server never came back");
    await say("something while the account is out", LIFT_NOT_GIVEN);
    unsaid = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((row) => row.name === LIFT_NOT_GIVEN);
  });

  // Mutation: give every window the moment beside `status` instead of its own. The five-hour window
  // stays right — those two are the same number — and the seven-day one is handed the five-hour
  // ending, so it is the SECOND window that goes red. A one-window fixture would have missed it.
  //
  // Asserted against this suite's own clock and against the two windows' distance from each other,
  // never against a number written down here: the stand-in computes both from the moment it runs.
  it("carries when each window the frame named comes to an end", () => {
    const five = both?.quota?.windows?.find((window) => window.name === "five_hour");
    const week = both?.quota?.windows?.find((window) => window.name === "seven_day");
    assert.ok(typeof five?.resetsAt === "number", `no five-hour moment in: ${JSON.stringify(both?.quota)}`);
    assert.ok(typeof week?.resetsAt === "number", `no seven-day moment in: ${JSON.stringify(both?.quota)}`);

    // Three hours off and five days off, as the stand-in built them, read against the moment this
    // fixture started the run rather than against either number.
    assert.ok(Math.abs(five.resetsAt - (takenAt + 3 * 60 * 60)) < 120, `five-hour lifts at ${five.resetsAt}`);
    assert.ok(Math.abs(week.resetsAt - (takenAt + 5 * 24 * 60 * 60)) < 120, `seven-day lifts at ${week.resetsAt}`);
    assert.notEqual(five.resetsAt, week.resetsAt);
  });

  // Mutation: invent a moment when a window did not say — an hour from now. The service did not
  // say when this one ends, so neither do we; and the window beside it DID say, so this cannot
  // pass by dropping every moment either.
  //
  // MEASURED, so that nobody spends another mutation on it: this does NOT hold the other wrong
  // answer, falling back to the moment beside `status`. That mutation reports nothing noticed,
  // because the frame drops both moments together — every capture we have carries a moment on the
  // outside and one inside each window, and the only shape that separates them is one nobody has
  // seen. The state where a reader taking the outer one is wrong is not reachable from any frame
  // this suite can build, so what is held here is "not a moment of our own" and not "not that one".
  // The neighbouring check holds the same field being read off the window in every state that IS
  // reachable.
  it("says nothing about when a window ends if the frame did not say", () => {
    const five = unsaid?.quota?.windows?.find((window) => window.name === "five_hour");
    const week = unsaid?.quota?.windows?.find((window) => window.name === "seven_day");
    assert.equal(five?.resetsAt, null);
    assert.ok(typeof week?.resetsAt === "number", `no seven-day moment in: ${JSON.stringify(unsaid?.quota)}`);
  });
});

// A refusal on the row, and how it goes away.
//
// Feature 9 says a refusal on the PANEL, once, at the moment it happens. It is gone the next time
// anybody looks, which is how a workspace could sit refused with a room full of rows saying idle.
// This puts it where the room reads, and the whole question is then what takes it off again.
//
// The service says when the limit lifts, so that moment is what clears it: one stored moment, one
// comparison, one direction, no timer and nothing scheduled — the shape hasGoneCold() already has.
// A refusal that named no moment cannot expire that way and is cleared by the next run instead.
describe("what a row says about a refusal, and what takes it off again", () => {
  const refusalLog = path.join(standIn, "refusal.txt");
  const refusing = (extra) => standInEnvironment(standIn, refusalLog, { OW_STAND_IN_REFUSED: "yes", ...extra });
  let onTheRow;
  let neverRefused;
  let noReset;
  let lifted;
  let cleared;
  let attempted;
  let attemptedStatus;

  before(async () => {
    runTool(instance, ["hire", REFUSED_ON_THE_ROW], process.env);
    runTool(instance, ["hire", LIFTED], process.env);
    runTool(instance, ["hire", NO_RESET_GIVEN], process.env);
    runTool(instance, ["hire", NEVER_REFUSED], process.env);

    // Turned away, with a reset moment the fixture computed rather than one written down, and
    // under a window that is deliberately NOT the common one. Every refusal fixture here named
    // five_hour until it was measured, and a reader that hard-coded that string passed all of
    // them; the seven-day window refuses too, and naming it is what makes the row prove it
    // carried what the frame said rather than what the reader assumed.
    await start(instance, refusing({ OW_STAND_IN_LIMIT_KIND: "seven_day" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("ask while the account is out", REFUSED_ON_THE_ROW);
    await say("ask while the account is out", LIFTED);

    // Turned away saying nothing about when it lifts. The schema does not promise the field.
    await start(instance, refusing({ OW_STAND_IN_NO_RESET: "yes" }));
    assert.ok(await waitForHealth(URL), "the server never came back");
    await say("ask while the account is out", NO_RESET_GIVEN);

    // Time passing, made rather than waited for: the moment this refusal named is moved into the
    // past on the file that holds it, which is the state a row is in an hour later. The same idea
    // as age() above, on stored content rather than on an mtime.
    const held = JSON.parse(fs.readFileSync(threadFile(LIFTED), "utf8"));
    held.refused = { ...held.refused, resetsAt: Math.floor(Date.now() / 1000) - 60 };
    fs.writeFileSync(threadFile(LIFTED), `${JSON.stringify(held, null, 2)}\n`);

    let rows = JSON.parse((await get(`${URL}/sessions`)).body).sessions;
    onTheRow = rows.find((row) => row.name === REFUSED_ON_THE_ROW);
    neverRefused = rows.find((row) => row.name === NEVER_REFUSED);
    noReset = rows.find((row) => row.name === NO_RESET_GIVEN);
    lifted = rows.find((row) => row.name === LIFTED);

    // A message to a session whose row says refused. Nothing may consult that row to decide
    // whether to try, so what is read here is the stand-in's own call log and not the answer.
    const beforeTry = callsIn(refusalLog).length;
    const answered = await say("say it again anyway", REFUSED_ON_THE_ROW);
    attemptedStatus = answered.status;
    attempted = callsIn(refusalLog).length - beforeTry;

    // And a run that answers, on a session whose row said refused a moment ago.
    await start(instance, standInEnvironment(standIn, refusalLog));
    assert.ok(await waitForHealth(URL), "the server never came back");
    await say("and now it works", REFUSED_ON_THE_ROW);
    cleared = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((row) => row.name === REFUSED_ON_THE_ROW);
  });

  // Mutation: read the moment out of the service's prose instead of the field. The stand-in's
  // sentence deliberately names a different hour from its own resetsAt, so a row built from the
  // words rather than the number is caught saying the wrong one.
  it("carries the moment the frame said the limit lifts", () => {
    assert.equal(typeof onTheRow?.refused?.resetsAt, "number");
    assert.ok(onTheRow.refused.resetsAt > Math.floor(Date.now() / 1000), "the reset moment is not ahead");
  });

  // Mutation: hard-code five_hour. The service names its own windows and can rename them.
  //
  // The window asserted here is the seven-day one, and that is the whole of what makes this check
  // work. It read five_hour first, against a fixture that also said five_hour, and the mutation
  // that hard-codes the string left it GREEN — the reader and the fixture agreeing on a constant
  // neither of them had to read. The other refusal below still names five_hour, so both windows
  // are exercised and only a row built from the field satisfies the pair.
  it("carries the kind of limit the frame named", () => {
    assert.equal(onTheRow?.refused?.kind, "seven_day");
  });

  // Mutation: drop the expiry. A refusal is true until the moment it named, and a row still saying
  // it an hour later is the room lying in the one direction nobody checks.
  it("is off the row once the moment it named has passed", () => {
    assert.equal(lifted?.refused, null);
  });

  // Mutation: require resetsAt to record it. A refusal that says less is still a refusal, and one
  // the row dropped for saying less would be the most confident silence there is.
  it("stays on the row when the frame named no moment at all", () => {
    assert.equal(noReset?.refused?.resetsAt, null);
    assert.equal(noReset?.refused?.kind, "five_hour");
  });

  // Mutation: keep the previous refusal when the run reported none. Same rule as the reading: what
  // this run reported is what is kept, null included.
  it("is off the row after a run that answered", () => {
    assert.equal(cleared?.refused, null);
  });

  // Mutation: default the field to an object.
  it("says nothing about a session that has never been refused", () => {
    assert.equal(neverRefused?.refused, null);
  });

  // Mutation: answer the 503 out of the row's own refused field, before running anything. THIS IS
  // THE NEVER-A-GATE CHECK and it is read from the call log rather than from the status, because a
  // real refusal answers 503 too: a gate would return the same number without running anything at
  // all, and a check that only read the response would call that a pass.
  it("still attempts a message to a session whose row says refused", () => {
    assert.equal(attempted, 1, "the stand-in was not called again");
    assert.equal(attemptedStatus, 503);
  });
});

// Every state the room can say, and somebody who has been in it.
//
// The states are named in one place now, which makes a question askable that was not before: is
// every one of them a state a session actually reaches? A phrase written into a branch could be
// dead for years and nothing would say so — and a state nobody can get into is a state nobody has
// had to write an exit for, which is the whole of what this feature is about.
//
// So the table is one source and real rows off real scenarios are the other, and the check is that
// the set of states reached is the whole table. A seventh entry added without a scenario that
// enters it goes red here and nowhere else.
//
// Two starts rather than one, because the conditions are tried in order and the early ones hide the
// late ones: a session stopped to ask permission reads `needs you` whatever else is true of it, so
// a fixture that makes every run ask can never show one merely answering. The first start is a slow
// turn with a second message behind it, the second is a call with a question in the middle of it.
//
// What is NOT here: a check that each state has an exit. Every exit was taken out in turn and every
// one of them is already red on checks that exist — a request answered, an addressee settling, the
// turn ahead settling, the run settling, a cold thread forgotten. The sixth state is rest, which has
// no exit by design and needs none. A check over them would restate five things and invent a sixth.
describe("every state the room can say, and somebody who has been in it", () => {
  const statesLog = path.join(standIn, "states.txt");
  let seen;

  before(async () => {
    const found = new Set();
    const note = (row) => {
      assert.ok(row !== null && row !== undefined, "there was no row to read a state off");
      found.add(STATES.find((state) => state.when(row)).named);
    };
    const rowFor = async (name) => {
      const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
      return rows.find((row) => row.name === name) ?? null;
    };

    await start(instance, standInEnvironment(standIn, statesLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // Nothing has been said to this one yet, and nothing ever is on this start.
    note(await rowFor(LEADER));

    // Slow enough to be read while it is going, and slow enough to put a second message behind it.
    const answering = say("take your time", WORKER);
    note(
      await waitFor(async () => {
        const row = await rowFor(WORKER);
        return row?.busy === true ? row : null;
      }),
    );
    const behind = say("and one behind it", WORKER);
    note(
      await waitFor(async () => {
        const row = await rowFor(WORKER);
        return row?.queued === 1 ? row : null;
      }),
    );
    await Promise.all([answering, behind]);

    // Cold is the thread file's own clock and nothing else, so the whole of reaching it is pushing
    // that file back past the hour. It has a thread by here because it has just answered twice.
    age(threadFile(WORKER), 90);
    note(await rowFor(WORKER));

    // The lead calls the worker with the instance's own command and waits; the worker, answering
    // it, stops to ask to be allowed something. Nothing moves while that request sits there, so
    // both rows are read off a stopped world rather than caught in passing.
    await start(
      instance,
      standInEnvironment(standIn, statesLog, {
        OW_STAND_IN_CALLS: `${LEADER}>${WORKER}`,
        OW_STAND_IN_ASKS: "Bash",
        OW_STAND_IN_WAITS: "30000",
      }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");

    const calling = say("go and ask him", LEADER);
    const workers = await waitFor(async () => {
      const { permissions } = JSON.parse((await get(`${URL}/sessions/${WORKER}/permissions`)).body);
      return permissions.length > 0 ? permissions : null;
    });
    note(await rowFor(WORKER));
    note(await rowFor(LEADER));

    // Answered in the order they were asked, so both turns end of their own accord and this leaves
    // the chat with nothing going for whatever runs next.
    await post(`${URL}/sessions/${WORKER}/permission`, { id: workers[0].id, decision: "allow" });
    const leads = await waitFor(async () => {
      const { permissions } = JSON.parse((await get(`${URL}/sessions/${LEADER}/permissions`)).body);
      return permissions.length > 0 ? permissions : null;
    });
    await post(`${URL}/sessions/${LEADER}/permission`, { id: leads[0].id, decision: "allow" });
    await calling;

    seen = [...found].sort();
  });

  it("reaches every state the room can say", () => {
    assert.ok(seen.length > 0, "no state was reached at all, so this compares two empty lists");
    assert.deepEqual(seen, STATES.map((state) => state.named).sort(), JSON.stringify(seen));
  });
});

const GAUGED_IN_ROOM = "Garganey";
const NEVER_IN_ROOM = "Smew";
const REFUSED_IN_ROOM = "Scaup";

// What the ROOM says about a usage window, which is where a person actually looks.
//
// Both facts are already on the row by here; this is only about the two places that lay a row out
// in words — `ow room` and the page's own script. They are not shared code and cannot be, one of
// them being a page served as text, so the duplication is proven rather than trusted: every check
// that reads the command has a partner that reads `page.html` as a string.
//
// The age is the load-bearing part of this slice. One account means N rows carrying N readings of
// N different ages, and the misreading this feature can cause is a low number off a row that has
// not run for hours being taken for the account's current state. Check 5 is the whole mitigation,
// and it is written as "never printed without" rather than "printed", because the way this fails
// is a phrase that keeps the number and loses the age.
describe("what the room says about a usage window and a refusal", () => {
  const roomLog = path.join(standIn, "roomquota.txt");
  let room;
  let page;

  // One line of the room, by name. The name is padded to the room's width, so there is always a
  // space after it — matching on the bare name would also match a longer name starting with it.
  const lineFor = (name) => (room ?? "").split("\n").find((line) => line.startsWith(`${name} `));

  before(async () => {
    runTool(instance, ["hire", GAUGED_IN_ROOM], process.env);
    runTool(instance, ["hire", NEVER_IN_ROOM], process.env);
    runTool(instance, ["hire", REFUSED_IN_ROOM], process.env);

    // A run the service allowed, with a fullness this suite chose rather than one the fixture had
    // written down.
    await start(instance, standInEnvironment(standIn, roomLog, { OW_STAND_IN_LIMIT: "allowed", OW_STAND_IN_FULLNESS: "0.71" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("the first thing", GAUGED_IN_ROOM);

    // And a run the service turned away, which carries a reading of its own on the way past.
    await start(instance, standInEnvironment(standIn, roomLog, { OW_STAND_IN_REFUSED: "yes" }));
    assert.ok(await waitForHealth(URL), "the server never came back");
    await say("ask while the account is out", REFUSED_IN_ROOM);

    room = runTool(instance, ["room"], standInEnvironment(standIn, roomLog)).stdout;
    page = fs.readFileSync(path.join(instance, "tools", "chat", "page.html"), "utf8");
  });

  // Mutation: say it in page.html only. The command is where somebody at a terminal reads the
  // room, and a phrase that exists only on the page is a phrase half the readers never see.
  it("prints the fullness the frame gave, for every window it named", () => {
    assert.match(lineFor(GAUGED_IN_ROOM) ?? "", /five-hour window 71% full/);
    assert.match(lineFor(GAUGED_IN_ROOM) ?? "", /seven-day window 36% full/);
  });

  // Mutation: print 0% for a null reading. A session that has never run has not been told
  // anything, and 0% is a number — the most reassuring one there is, invented by us.
  it("says nothing about a window on a row that has no reading", () => {
    const line = lineFor(NEVER_IN_ROOM) ?? "";
    assert.ok(line !== "", "the session was not in the room at all");
    assert.doesNotMatch(line, /window/);
    assert.doesNotMatch(line, /% full/);
  });

  // Mutation: drop the moment from the phrase. "refused" alone tells somebody they can do nothing
  // and not when they can do it again, which is the only actionable half.
  it("says the refusal with the moment the limit lifts", () => {
    assert.match(lineFor(REFUSED_IN_ROOM) ?? "", /refused until \d\d:\d\d/);
  });

  // Mutation: drop the age from the phrase. THIS IS THE ONE MITIGATION THIS DESIGN HAS for the
  // trap it knowingly leaves — the same account read at N different moments on N rows — and it is
  // asserted as "never without", because the failure is a phrase that keeps the number and loses
  // the age, which reads perfectly well and is wrong.
  it("never prints a fullness without saying when it was read", () => {
    const line = lineFor(GAUGED_IN_ROOM) ?? "";
    assert.match(line, /% full/, "there was no fullness on the line to begin with");
    assert.match(line, /% full[^·]*, read (just now|\d+[mh] ago)/);
  });

  // Mutation: move the refusal into stateOf(). Decision 6 as a check: a later change that folds
  // either fact into the state word has to argue with a red test rather than with a comment. A
  // session whose last run was refused is not DOING anything different, and both are worth saying.
  //
  // The state word ALONE is asserted here, deliberately. This check also asserted that the line
  // still said "refused until" — which read as the other half of the same point and was in fact
  // an assertion that could never fail, because the check above makes the identical match on the
  // identical line and is strictly stronger. All it did was put this check in that one's bite
  // list, where it failed for somebody else's reason. That the refusal is still said is that
  // check's job; that the state word survived is this one's.
  it("leaves the state phrase alone: a refused session that is idle still reads idle", () => {
    assert.match(lineFor(REFUSED_IN_ROOM) ?? "", /\bidle\b/);
  });

  // No suite runs page.html — it is read as text — so the page's copy is proven by reading it, and
  // the check is that both phrases are BUILT from the row's own fields, not merely present as
  // words in a string.
  it("builds the same two phrases in the page's own copy of the room", () => {
    assert.match(page, /row\.quota/);
    assert.match(page, /row\.refused/);
    assert.match(page, /refused until/);
    assert.match(page, /% full/);
    assert.match(page, /, read /);
  });
});



// What a session is waiting to be ALLOWED to do. It is held up by a person rather than by another
// session, and until now that was visible only on the panel it happened on — which is the one
// place somebody looking for who needs them is not looking.
describe("what the page is told about a session waiting to be allowed", () => {
  const askingLog = path.join(standIn, "asking.txt");
  let quiet;
  let stopped;
  let answered;

  async function stateOf(name) {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    return rows.find((row) => row.name === name) ?? null;
  }

  before(async () => {
    // It parks a request and then, once it has been answered, takes its time finishing — so there
    // is a stretch where the request is settled and the turn is still going. Without it, "stopped
    // counting" could not be told apart from "the turn ended", which is a check that passes by
    // waiting.
    await start(
      instance,
      standInEnvironment(standIn, askingLog, { OW_STAND_IN_ASKS: "Bash", OW_STAND_IN_SLOW: "1500" }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");

    quiet = await stateOf(WORKER);

    const going = say("do the thing", WORKER);
    stopped = await waitFor(async () => {
      const row = await stateOf(WORKER);
      return row?.asking === 1 ? row : null;
    });

    const { permissions } = JSON.parse((await get(`${URL}/sessions/${WORKER}/permissions`)).body);
    await post(`${URL}/sessions/${WORKER}/permission`, { id: permissions[0].id, decision: "allow" });

    // Read while the run is still going, which is what makes this about the request being
    // answered rather than about the turn being over.
    answered = await waitFor(async () => {
      const row = await stateOf(WORKER);
      return row?.asking === 0 && row?.busy === true ? row : null;
    });
    await going;
  });

  it("counts nothing when a session is not waiting to be allowed anything", () => {
    assert.equal(quiet.asking, 0);
  });

  it("counts what a session is waiting to be allowed to do", () => {
    assert.equal(stopped?.asking, 1);
  });

  it("stops counting it once a person has answered, before the turn is over", () => {
    assert.deepEqual([answered?.asking, answered?.busy], [0, true]);
  });
});

// What a session is asked about its own desk.
//
// The header's title: is the one field of a desk anything outside it reads, and a persona line
// asking for it is not what gets it written: a session given work keeps the work. What fires is an
// ask in the turn, so it goes in front of the message, wrapped, on any turn where the desk still
// says nothing.
//
// Both states have to be reachable here or the check is about a session that never had a title at
// all: one desk is left exactly as hiring wrote it, and one has a title written into its header
// before a word is said to it.
const SAYS_NOTHING = "Wren";
const SAYS_SO = "Heron";

describe("what a session is asked about its desk", () => {
  const deskLog = path.join(standIn, "desk.txt");
  let asked;
  let notAsked;

  before(async () => {
    runTool(instance, ["hire", SAYS_NOTHING], process.env);
    runTool(instance, ["hire", SAYS_SO], process.env);

    const desk = path.join(instance, "work", SAYS_SO, "STATE.md");
    const lines = fs.readFileSync(desk, "utf8").split("\n");
    lines[0] = "<!-- DESK | title: reading the water meter -->";
    fs.writeFileSync(desk, lines.join("\n"));

    await start(instance, standInEnvironment(standIn, deskLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    await say("count the doors on the second floor", SAYS_NOTHING);
    asked = questionsIn(deskLog).at(-1);
    await say("carry on with the meter", SAYS_SO);
    notAsked = questionsIn(deskLog).at(-1);
  });

  it("asks for the title on a turn where the desk does not say what it is on", () => {
    assert.match(asked ?? "", /the one field of it anybody outside this desk reads/);
  });

  it("names the desk it is asking about", () => {
    assert.ok((asked ?? "").includes(`work/${SAYS_NOTHING}/STATE.md`));
  });

  // The state the ask exists to end is "nobody can see what this one is on", so a desk that says
  // hears nothing about it — and goes on hearing nothing, which is what makes the ask free.
  it("says nothing about the desk to a session whose desk already says", () => {
    assert.ok(!(notAsked ?? "").includes("<desk>"));
  });

  it("wraps the ask, so nothing reaches the session as though the human had typed it", () => {
    assert.match(asked ?? "", /<desk>[\s\S]*<\/desk>/);
  });

  // Both halves, because an ask that is not there at all has no place in the turn either, and a
  // check that only compared two positions would read the missing one as being in front.
  it("asks in front of the message rather than after it", () => {
    const wrapped = asked.indexOf("</desk>");
    assert.ok(wrapped > -1 && wrapped < asked.indexOf("count the doors on the second floor"));
  });

  it("still hands the session the message it was sent", () => {
    assert.ok((asked ?? "").includes("count the doors on the second floor"));
  });
});

// WHEN the ask is put together, which is not the same question as whether it is asked at all. It
// is decided where the turn begins and not where the message arrived, so a desk filled in by the
// turn ahead of this one in the queue is not asked about again.
//
// The state that tells the two apart is a session with no title when the message arrives and a
// title by the time its turn comes, and it is only reachable while something else is holding the
// queue — hence the slow turn in front, and the wait for the message to be sitting behind it.
const FILLED_IN = "Teal";

describe("a message queued behind a turn that fills the desk in", () => {
  const queuedDeskLog = path.join(standIn, "queued-desk.txt");
  let asked;

  async function queuedFor(name) {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    return rows.find((row) => row.name === name) ?? null;
  }

  before(async () => {
    runTool(instance, ["hire", FILLED_IN], process.env);
    await start(instance, standInEnvironment(standIn, queuedDeskLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    const answering = say("this one takes a while", FILLED_IN);
    await waitFor(() => questionsIn(queuedDeskLog).some((question) => question.includes("takes a while")) || null);

    const queued = say("and now this one", FILLED_IN);
    await waitFor(async () => ((await queuedFor(FILLED_IN))?.queued === 1 ? true : null));

    // What the turn ahead of it would have done: the desk says what it is on before the queued turn
    // begins, and said nothing when its message arrived.
    const desk = path.join(instance, "work", FILLED_IN, "STATE.md");
    const lines = fs.readFileSync(desk, "utf8").split("\n");
    lines[0] = "<!-- DESK | title: counting the doors -->";
    fs.writeFileSync(desk, lines.join("\n"));

    await Promise.all([answering, queued]);
    asked = questionsIn(queuedDeskLog).find((question) => question.includes("and now this one"));
  });

  it("does not ask about a desk that was filled in while the message waited", () => {
    assert.ok(!(asked ?? "").includes("<desk>"));
  });
});

// A session leaving, which is the exit a handover is not: the desk is not being taken over by
// somebody else, it is being put away.
//
// The record has to be the desk as the session LAST wrote it and filed under what it ended up being
// on, so the order is the whole feature: ask first, read the title after the answer, write the last
// line on the panel before the panel is moved. The session here writes its title in the leave turn
// itself — held open by a slow stand-in — because a desk that already said what it was on cannot
// tell a reader from a guesser.
const LEAVES = "Quill";
const LEAVES_QUIETLY = "Marten";

describe("a session leaving", () => {
  const leaveLog = path.join(standIn, "leave.txt");
  const TITLE = "counting the doors on the second floor";
  let done;
  let asked;
  let thread;
  let filed;
  let panel;

  before(async () => {
    runTool(instance, ["hire", LEAVES], process.env);
    await start(instance, standInEnvironment(standIn, leaveLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A thread to end, and a desk that says nothing yet.
    await say("something worth remembering", LEAVES);

    const leaving = post(`${URL}/sessions/${LEAVES}/leave`, {});
    await waitFor(() => questionsIn(leaveLog).some((question) => question.includes("<leave>")) || null);

    // What the session does with the turn it was given: it writes its desk, title and all. Done
    // here rather than beforehand so that anything reading the title before asking is filing a desk
    // under what it used to be on.
    const desk = path.join(instance, "work", LEAVES, "STATE.md");
    fs.writeFileSync(desk, `<!-- DESK | title: ${TITLE} -->\n# ${LEAVES}\n\nthe doors are counted\n`);

    done = JSON.parse((await leaving).body);
    asked = questionsIn(leaveLog).find((question) => question.includes("<leave>"));
    thread = fs.existsSync(path.join(instance, "chat", LEAVES, "session.json"));
    filed = path.join(instance, done.archived);
    // Read so that a panel that was never filed is an empty one rather than an exception: a
    // mutation that breaks this setUP would take every check in here down with it and prove
    // nothing about any of them.
    const kept = path.join(filed, "conversation.json");
    panel = fs.existsSync(kept) ? JSON.parse(fs.readFileSync(kept, "utf8")) : [];
  });

  it("asks the session to write its desk", () => {
    assert.ok(asked?.includes(`work/${LEAVES}/STATE.md`));
  });

  it("asks it to say what the desk was on, which is what it is filed under", () => {
    assert.match(asked ?? "", /header's title:/);
  });

  it("asks it for what it worked out that the next person would work out again", () => {
    assert.match(asked ?? "", /memory/);
  });

  it("asks for it inside the wrapper rather than after it", () => {
    assert.match(asked ?? "", /<leave>[\s\S]*memory[\s\S]*<\/leave>/);
  });

  it("wraps what it asks, so nothing reaches the session as though the human had typed it", () => {
    assert.match(asked ?? "", /^<leave>[\s\S]*<\/leave>/);
  });

  it("files the desk beside work/ rather than in it", () => {
    assert.match(done.archived, /^archive\//);
  });

  it("files it under the day, the name and what the desk ended up on", () => {
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(done.archived, `archive/${day}-${LEAVES}-counting-the-doors-on-the-second-floor`);
  });

  it("keeps the desk as the session last wrote it", () => {
    assert.match(fs.readFileSync(path.join(filed, "STATE.md"), "utf8"), /the doors are counted/);
  });

  it("keeps the panel with the desk", () => {
    assert.ok(panel.some((message) => message.text === "something worth remembering"));
  });

  // What is filed is what a person would want to read. A thread id is a pointer to a conversation
  // that has been ended, so filing one away is filing something that cannot be true.
  it("does not file the thread away with it", () => {
    assert.equal(fs.existsSync(path.join(filed, "session.json")), false);
  });

  // The record ends at the moment it ends at, which it can only do if the line is written before
  // the panel is moved.
  it("ends that panel with the line saying the session has left", () => {
    assert.deepEqual([panel.at(-1)?.leaving, panel.at(-1)?.text?.includes(done.archived)], [true, true]);
  });

  it("takes the desk out of work/, so nobody works here under that name", () => {
    assert.equal(fs.existsSync(path.join(instance, "work", LEAVES)), false);
  });

  it("takes the persona with it, because it names somebody who is not here", () => {
    assert.equal(fs.existsSync(path.join(instance, "personas", `${LEAVES}.md`)), false);
  });

  // A rule for a desk nobody has is a grant the instance cannot account for, and the inspector
  // reads these settings as one rule per desk and nothing wider.
  it("takes back the right to write that desk", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(instance, ".claude", "settings.json"), "utf8"));
    assert.ok(!settings.permissions.allow.includes(`Edit(work/${LEAVES}/STATE.md)`));
  });

  it("leaves everybody else's right where it was", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(instance, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.permissions.allow.includes(`Edit(work/${LEADER}/STATE.md)`));
  });


  it("ends the thread", () => {
    assert.equal(thread, false);
  });

  it("says where the desk was filed", () => {
    assert.ok(fs.existsSync(filed));
  });

  it("is nobody the chat can be asked about any more", async () => {
    assert.equal((await get(`${URL}/sessions/${LEAVES}/messages`)).status, 404);
  });

  // The desks under work/ ARE the roster, so where a desk is filed to is not a matter of taste: a
  // directory in there is somebody who works here, with a panel, a row in the room and a name that
  // can be spoken to.
  it("puts nobody new in the room by filing a desk away", async () => {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    assert.deepEqual(
      rows.map((row) => row.name).filter((name) => name === "archive" || name === LEAVES),
      [],
    );
  });
});

// Two people of one name leaving on one day with one title is unlikely. Two records written
// quietly into one directory is not a way to find that out.
describe("a session leaving into a name that is already taken", () => {
  const takenLog = path.join(standIn, "leave-taken.txt");
  const TAKEN = "Pika";
  let done;
  let first;

  before(async () => {
    runTool(instance, ["hire", TAKEN], process.env);
    await start(instance, standInEnvironment(standIn, takenLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // What a desk filed away earlier would have left behind, with something in it.
    first = path.join(instance, "archive", `${new Date().toISOString().slice(0, 10)}-${TAKEN}`);
    fs.mkdirSync(first, { recursive: true });
    fs.writeFileSync(path.join(first, "STATE.md"), "the one that was here before\n");

    done = JSON.parse((await post(`${URL}/sessions/${TAKEN}/leave`, {})).body);
  });

  it("files the new one beside it rather than into it", () => {
    assert.equal(done.archived, `archive/${new Date().toISOString().slice(0, 10)}-${TAKEN}-2`);
  });

  it("leaves what was already filed there alone", () => {
    assert.equal(fs.readFileSync(path.join(first, "STATE.md"), "utf8"), "the one that was here before\n");
  });
});

// The point of all of it: a name that has left can be hired again, and what comes back under it
// starts on nothing. It is its own describe because hiring is a change of state, and everything
// asserted about what leaving left behind has to be read before that happens.
describe("hiring a name that has left", () => {
  let hired;

  before(() => {
    hired = runTool(instance, ["hire", LEAVES], process.env);
  });

  it("opens the desk", () => {
    assert.deepEqual([hired.status, fs.existsSync(path.join(instance, "work", LEAVES, "STATE.md"))], [0, true]);
  });

  it("starts on no conversation and no thread", () => {
    assert.equal(fs.existsSync(path.join(instance, "chat", LEAVES)), false);
  });

  it("says nothing on the new desk about what the old one was on", () => {
    const desk = fs.readFileSync(path.join(instance, "work", LEAVES, "STATE.md"), "utf8");
    assert.equal(desk.split("\n")[0], "<!-- DESK | title: -->");
  });
});

// A desk that never said what it was on is filed under the day and the name alone. Saying nothing
// is what everything else here does with an empty title, and a guess in a directory name is a guess
// somebody has to live with afterwards.
describe("a session leaving a desk that never said what it was on", () => {
  const quietLog = path.join(standIn, "leave-quiet.txt");
  let done;

  before(async () => {
    runTool(instance, ["hire", LEAVES_QUIETLY], process.env);
    await start(instance, standInEnvironment(standIn, quietLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    done = JSON.parse((await post(`${URL}/sessions/${LEAVES_QUIETLY}/leave`, {})).body);
  });

  it("files it under the day and the name alone", () => {
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(done.archived, `archive/${day}-${LEAVES_QUIETLY}`);
  });
});

// The lead is not a desk that can be put away. An instance has one by definition and the chat hosts
// it whether or not it has a desk, so a lead that left would still be here with nothing to read.
describe("asking the session that leads to leave", () => {
  const leadLog = path.join(standIn, "leave-lead.txt");
  let refused;

  before(async () => {
    await start(instance, standInEnvironment(standIn, leadLog));
    assert.ok(await waitForHealth(URL), "the server never answered");
    refused = await post(`${URL}/sessions/${LEADER}/leave`, {});
  });

  it("refuses", () => {
    assert.equal(refused.status, 400);
  });

  it("says why", () => {
    assert.match(JSON.parse(refused.body).error, /leads here/);
  });

  it("leaves the desk where it is", () => {
    assert.ok(fs.existsSync(path.join(instance, "work", LEADER, "STATE.md")));
  });
});

// A message that arrived while a session was leaving.
//
// The route asks whether somebody works here when the message ARRIVES, and one waiting behind a
// leave arrived while they still did. Answered as usual it would open a thread and a panel under a
// name that had just been freed — the bug this whole exit exists to close, coming back through the
// queue instead of through hiring. So the question is asked again where the turn begins.
//
// It only comes apart while something is holding the queue, hence the slow turn in front and the
// wait for each message to be sitting behind the one before it.
const LEAVES_MID_QUEUE = "Vole";

describe("a message queued behind a session leaving", () => {
  const behindLog = path.join(standIn, "behind-leave.txt");
  let refused;

  async function queuedFor(name) {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    return rows.find((row) => row.name === name) ?? null;
  }

  before(async () => {
    runTool(instance, ["hire", LEAVES_MID_QUEUE], process.env);
    await start(instance, standInEnvironment(standIn, behindLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    const answering = say("this one takes a while", LEAVES_MID_QUEUE);
    await waitFor(() => questionsIn(behindLog).some((question) => question.includes("takes a while")) || null);

    const leaving = post(`${URL}/sessions/${LEAVES_MID_QUEUE}/leave`, {});
    await waitFor(async () => ((await queuedFor(LEAVES_MID_QUEUE))?.queued === 1 ? true : null));

    const behind = say("and one more thing", LEAVES_MID_QUEUE);
    await waitFor(async () => ((await queuedFor(LEAVES_MID_QUEUE))?.queued === 2 ? true : null));

    const [, , said] = await Promise.all([answering, leaving, behind]);
    refused = said;
  });

  it("is refused rather than answered", () => {
    assert.equal(refused.status, 409);
  });

  it("says the session left before it could be delivered", () => {
    assert.match(JSON.parse(refused.body).error, /left before this could be delivered/);
  });

  // The mutation that matters: answering it would put the panel and the thread back under a name
  // that had just been given up.
  it("does not put the session's panel back", () => {
    assert.equal(fs.existsSync(path.join(instance, "chat", LEAVES_MID_QUEUE)), false);
  });
});

const HANDS_OVER = "Robin";

describe("handing a session over", () => {
  const handoverLog = path.join(standIn, "handover.txt");
  let done;
  let rows;
  let thread;
  let afterwards;

  before(async () => {
    runTool(instance, ["hire", HANDS_OVER], process.env);
    await start(instance, standInEnvironment(standIn, handoverLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A thread to end. Without a message first there is nothing here that a handover changes.
    await say("something worth remembering", HANDS_OVER);
    done = JSON.parse((await post(`${URL}/sessions/${HANDS_OVER}/handover`, {})).body);
    // Read before the next message, which starts a thread of its own and would put the file back.
    thread = fs.existsSync(path.join(instance, "chat", HANDS_OVER, "session.json"));

    // What a PERSON is left looking at. Read from the panel and not from what the route answered:
    // a route that reports a row it never wrote is exactly the failure worth catching, and a
    // mutation that stopped the appending went unnoticed by every check that read the answer.
    const panel = JSON.parse((await transcriptOf(HANDS_OVER)).body).messages;
    rows = panel.slice(panel.findIndex((message) => message.handover === true));

    afterwards = await say("and now who are you", HANDS_OVER);
  });

  it("asks the session for its desk", () => {
    const asked = questionsIn(handoverLog).find((question) => question.includes("<handover>"));
    assert.ok(asked?.includes(`work/${HANDS_OVER}/STATE.md`));
  });

  // The one moment a whole desk is rewritten is the one moment a title left as it was would
  // survive a change of subject, so the handover asks for it by name along with everything else.
  it("asks the session to leave its header title saying what the desk is on", () => {
    const asked = questionsIn(handoverLog).find((question) => question.includes("<handover>"));
    assert.match(asked ?? "", /header's title:/);
  });

  // A thread ending is the moment anything the session worked out is about to be lost with it, so
  // it is asked for that too — not only for the desk, which is this task, but for the memory, which
  // is the workspace and outlives the desk.
  it("asks the session for what it worked out that the next one would work out again", () => {
    const asked = questionsIn(handoverLog).find((question) => question.includes("<handover>"));
    assert.match(asked ?? "", /memory/);
  });

  // Inside the wrapper, not after it. The wrapping check below is a match rather than the whole
  // string, so an ask appended after the closing tag passes it — and an instruction from the chat
  // arriving outside a wrapper is the human's words, which is the one guarantee here that must not
  // be got wrong. Written as one expression so it cannot pass with the ask missing altogether.
  it("asks for it inside the wrapper rather than after it", () => {
    const asked = questionsIn(handoverLog).find((question) => question.includes("<handover>"));
    assert.match(asked ?? "", /<handover>[\s\S]*memory[\s\S]*<\/handover>/);
  });

  it("wraps what it asks, so nothing reaches the session as though the human had typed it", () => {
    const asked = questionsIn(handoverLog).find((question) => question.includes("<handover>"));
    assert.match(asked ?? "", /^<handover>[\s\S]*<\/handover>/);
  });

  it("ends the thread", () => {
    assert.equal(thread, false);
  });

  it("starts a new conversation for the message after it", () => {
    const since = callsIn(handoverLog).slice(-1)[0];
    assert.ok(!since.includes("--resume"));
  });

  it("still answers that message", () => {
    assert.equal(afterwards.status, 200);
  });

  it("leaves the desk where it was", () => {
    assert.ok(fs.existsSync(path.join(instance, "work", HANDS_OVER, "STATE.md")));
  });

  it("leaves the transcript where it was", async () => {
    assert.ok((await transcriptOf(HANDS_OVER)).body.includes("something worth remembering"));
  });

  it("puts two lines of its own on the panel, one at each end of it", () => {
    assert.equal(rows.slice(0, 3).filter((message) => message.handover === true).length, 2);
  });

  it("says who asked for it, in the words a person reads", () => {
    assert.ok(rows[0]?.text.startsWith(`${HUMAN} asked ${HANDS_OVER} to hand over`));
  });

  it("puts that line under nobody, because nobody said it", () => {
    assert.equal(rows[0]?.from, "the chat");
  });

  it("keeps what the session answered", () => {
    assert.equal(rows[1]?.from, HANDS_OVER);
  });

  it("says on the panel that the thread is gone", () => {
    assert.equal(rows[2]?.handover, true);
  });

  it("says what the next message will read first", () => {
    assert.ok(rows[2]?.text.includes(`work/${HANDS_OVER}/STATE.md`));
  });

  it("does not call it a failure", () => {
    assert.equal(rows[2]?.failed, undefined);
  });

  it("hands the three of them back to whoever asked for the handover", () => {
    assert.deepEqual(
      [done.asked.handover, done.reply.from, done.ended.handover],
      [true, HANDS_OVER, true],
    );
  });

  it("writes the three of them to the panel in the order they happened", () => {
    assert.deepEqual(
      rows.slice(0, 3).map((message) => message.from),
      ["the chat", HANDS_OVER, "the chat"],
    );
  });

  it("refuses to hand over somebody who does not work here", async () => {
    assert.equal((await post(`${URL}/sessions/Nobody/handover`, {})).status, 404);
  });

  // Read as text, the way everything on that page is: no suite runs its script, so what is proven
  // here is that the page carries the button, and what it does when pressed is proven on the route
  // above rather than in a browser.
  it("gives the page something to press", async () => {
    assert.ok((await get(`${URL}/`)).body.includes('hand.textContent = "Hand over"'));
  });

  it("gives that button the route to press it against", async () => {
    assert.ok((await get(`${URL}/`)).body.includes("/handover`, { method: \"POST\" }"));
  });

  // A button that is built and never attached is invisible to a check that reads the page for what
  // it says. Text is all there is here, so the text says it is put on the panel.
  it("puts that button on the panel", async () => {
    assert.match((await get(`${URL}/`)).body, /composer\.append\(box, send, hand[,)]/);
  });
});

// The thread goes whatever happens, and that is not this route's doing: a run that cannot be
// resumed is dropped where it is asked, because losing the history beats losing the chat. What is
// lost when a session cannot be asked at all is the desk being written, so that is what is said.
describe("a session that cannot be asked to hand over", () => {
  const brokenLog = path.join(standIn, "broken-handover.txt");
  let rows;

  before(async () => {
    await start(instance, standInEnvironment(standIn, brokenLog, { OW_STAND_IN_BROKEN: "yes" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await post(`${URL}/sessions/${HANDS_OVER}/handover`, {});
    // The last three: this desk has been handed over before, so the panel holds earlier ones too.
    rows = JSON.parse((await transcriptOf(HANDS_OVER)).body).messages.slice(-3);
  });

  it("marks the answer as a failure", () => {
    assert.equal(rows[1]?.failed, true);
  });

  it("says on the panel that the handover did not go as asked", () => {
    assert.equal(rows[2]?.failed, true);
  });

  it("says what was lost by it", () => {
    assert.ok(rows[2]?.text.includes(`work/${HANDS_OVER}/STATE.md`));
  });

  it("still marks the line as being about a handover", () => {
    assert.equal(rows[2]?.handover, true);
  });
});

// WHEN, not whether. A session answers one message at a time, and a handover is one of them, so it
// waits its turn like everything else — which is the whole reason nothing new had to be locked.
//
// The mutation this is written against is a forget where the handover ARRIVES rather than where its
// turn runs. It is not a slower version of the same thing: `ask()` writes the thread id down after
// its run returns, so the turn already going puts the file straight back, and a check that only
// looked once both were over would find it there and pass. Both states are reached here — the file
// present while the turn ahead runs, gone once it is done — and the stand-in is slow enough to hold
// the wrong one open long enough to see.
describe("a handover asked for while the session is answering", () => {
  const queuedLog = path.join(standIn, "queued-handover.txt");
  const thread = () => path.join(instance, "chat", HANDS_OVER, "session.json");
  let midTurn;
  let order;

  before(async () => {
    await start(instance, standInEnvironment(standIn, queuedLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A thread to end, and a slow one to end it behind.
    await say("give me a thread", HANDS_OVER);
    const answering = say("this one takes a while", HANDS_OVER);
    await waitFor(() => questionsIn(queuedLog).some((question) => question.includes("takes a while")) || null);

    const handover = post(`${URL}/sessions/${HANDS_OVER}/handover`, {});
    // Long enough that the chat has taken the handover, and far short of the delay the turn ahead
    // of it is still sitting in. This is where a forget at arrival shows: the file would be gone.
    await new Promise((resolve) => setTimeout(resolve, 300));
    midTurn = fs.existsSync(thread());

    await Promise.all([answering, handover]);
    order = entriesIn(queuedLog)
      .filter((entry) => entry.includes("takes a while") || entry.includes("<handover>"))
      .map((entry) => `${entry.startsWith("heard") ? "began" : "ended"} ${entry.includes("<handover>") ? "handover" : "turn"}`);
  });

  it("leaves the thread alone while the turn ahead of it is still running", () => {
    assert.equal(midTurn, true);
  });

  it("does not ask for the desk until that turn is done", () => {
    assert.deepEqual(order, ["began turn", "ended turn", "began handover", "ended handover"]);
  });

  it("ends the thread once its own turn has run", () => {
    assert.equal(fs.existsSync(thread()), false);
  });
});

// WHETHER. What a session was told about and has not run since is held in memory under its name,
// and a thread ending does not clear it — so without this the session that follows is handed lines
// the one before it was owed, about things that happened before it existed.
//
// A handover is a turn and drains what is pending like any other, so the thread hears its debts on
// its way out. Both states are reachable and neither is a race: with the drain the handover turn
// carries the line and the message after it does not, and without it the handover turn carries
// nothing and the new thread is handed the lot.
describe("what a session was owed when it was handed over", () => {
  const owedLog = path.join(standIn, "owed.txt");
  let theHandover;
  let theNextTurn;

  before(async () => {
    await start(instance, standInEnvironment(standIn, owedLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // Something the lead is told about but has not run since: the human on somebody else's panel.
    await say("the roof is leaking", WORKER);
    await post(`${URL}/sessions/${LEADER}/handover`, {});
    await say("anything for me", LEADER);

    const asked = questionsIn(owedLog);
    theHandover = asked.find((question) => question.includes("<handover>"));
    theNextTurn = asked.find((question) => question.includes("anything for me"));
  });

  it("tells the thread on its way out", () => {
    assert.ok(theHandover?.includes("the roof is leaking"));
  });

  it("leaves the session that follows it owing nothing", () => {
    assert.ok(!theNextTurn?.includes("the roof is leaking"));
  });
});

// Hiring from the page. The other end of the exit: a name that has left can be given to somebody
// new without anybody going to a terminal for it.
//
// It writes what the command writes because it calls the same function, and the checks say so by
// reading the files rather than the answer. What the route adds over the command is that a chat
// already running hosts the new desk from the next load of the page, which is the last check here.
const HIRED_FROM_THE_PAGE = "Snipe";

describe("hiring from the page", () => {
  const hiringLog = path.join(standIn, "hiring.txt");
  let hired;

  before(async () => {
    await start(instance, standInEnvironment(standIn, hiringLog));
    assert.ok(await waitForHealth(URL), "the server never answered");
    hired = await post(`${URL}/sessions`, { name: HIRED_FROM_THE_PAGE });
  });

  // The one route that makes something that was not there before.
  it("answers that somebody was made", () => {
    assert.equal(hired.status, 201);
  });

  it("opens the desk", () => {
    assert.ok(fs.existsSync(path.join(instance, "work", HIRED_FROM_THE_PAGE, "STATE.md")));
  });

  it("opens it on a header that says nothing about what they are on yet", () => {
    const desk = fs.readFileSync(path.join(instance, "work", HIRED_FROM_THE_PAGE, "STATE.md"), "utf8");
    assert.equal(desk.split("\n")[0], "<!-- DESK | title: -->");
  });

  it("writes the persona that says who they are", () => {
    const persona = path.join(instance, "personas", `${HIRED_FROM_THE_PAGE}.md`);
    assert.ok(fs.readFileSync(persona, "utf8").includes(HIRED_FROM_THE_PAGE));
  });

  // A session that cannot write its own desk cannot keep it, and the inspector reads these
  // settings as one rule per desk and nothing wider.
  it("grants them the right to write that desk", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(instance, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.permissions.allow.includes(`Edit(work/${HIRED_FROM_THE_PAGE}/STATE.md)`));
  });

  it("says what it wrote, in the instance's own terms", () => {
    const { wrote } = JSON.parse(hired.body);
    assert.deepEqual(wrote.slice(0, 2), [
      path.join("work", HIRED_FROM_THE_PAGE, "STATE.md"),
      path.join("personas", `${HIRED_FROM_THE_PAGE}.md`),
    ]);
  });

  // Nothing is started and nothing is registered. The chat reads who works here from work/ each
  // time it is asked, so a desk opened while it runs is somebody it can host from that moment.
  it("is somebody the chat can be asked about, without a restart", async () => {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    assert.ok(rows.some((row) => row.name === HIRED_FROM_THE_PAGE && row.role === "worker"));
  });

  it("has said nothing yet", async () => {
    assert.deepEqual(JSON.parse((await transcriptOf(HIRED_FROM_THE_PAGE)).body).messages, []);
  });
});

// What a name is refused for has one answer, and this is the check that says so: every refusal
// here is compared with the one `ow hire` prints for the same name. Two copies of these guards
// would be two answers the day one of them changed, which is the bug the route was written around.
describe("what hiring from the page refuses", () => {
  const refusedLog = path.join(standIn, "hiring-refused.txt");
  const CAME_BACK = "Merlin";

  // Somebody at a desk who has never been spoken to, which is the only state in which the desk is
  // the FIRST thing in the way. Asking about the lead instead looks like the same check and is not:
  // the lead has a conversation, so the guard after this one refuses it and this one is never
  // reached — a mutation that took the desk guard away noticed nothing until this name existed.
  const AT_A_DESK = "Godwit";

  // What the command says about the same name, with the `ow: ` it prefixes every reason with
  // taken off, so the two can be compared as reasons rather than as output.
  function whatTheCommandSays(name) {
    return runTool(instance, ["hire", name], process.env).stderr.replace(/^ow: /, "").trim();
  }

  before(async () => {
    await start(instance, standInEnvironment(standIn, refusedLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // With something written on it, so that a refusal that did not refuse would be visible as
    // work lost rather than only as a status code.
    runTool(instance, ["hire", AT_A_DESK], process.env);
    fs.writeFileSync(
      path.join(instance, "work", AT_A_DESK, "STATE.md"),
      "<!-- DESK | title: draining the second cistern -->\n# Godwit\nthe cistern is half down\n",
    );

    // The state the bug actually looked like: a desk gone and a conversation still here.
    runTool(instance, ["hire", CAME_BACK], process.env);
    fs.rmSync(path.join(instance, "work", CAME_BACK), { recursive: true, force: true });
    fs.mkdirSync(path.join(instance, "chat", CAME_BACK), { recursive: true });
    fs.writeFileSync(path.join(instance, "chat", CAME_BACK, "conversation.json"), "[]\n");
  });

  it("refuses to hire nobody", async () => {
    const refused = await post(`${URL}/sessions`, {});
    assert.deepEqual([refused.status, JSON.parse(refused.body).error], [400, "hiring needs a name"]);
  });

  it("refuses a name that is nothing but space", async () => {
    assert.equal((await post(`${URL}/sessions`, { name: "   " })).status, 400);
  });

  it("refuses a name a directory could not be", async () => {
    const refused = await post(`${URL}/sessions`, { name: "../elsewhere" });
    assert.equal(refused.status, 400);
    assert.equal(JSON.parse(refused.body).error, whatTheCommandSays("../elsewhere"));
  });

  it("refuses somebody who already has a desk, in the words the command uses", async () => {
    const refused = await post(`${URL}/sessions`, { name: AT_A_DESK });
    assert.equal(refused.status, 400);
    assert.match(JSON.parse(refused.body).error, new RegExp(`${AT_A_DESK} already has a desk`));
    assert.equal(JSON.parse(refused.body).error, whatTheCommandSays(AT_A_DESK));
  });

  // The half of that refusal that matters. A route that opened the desk anyway would answer
  // cheerfully and take somebody's work with it.
  it("leaves the desk that was in the way as it found it", () => {
    const desk = fs.readFileSync(path.join(instance, "work", AT_A_DESK, "STATE.md"), "utf8");
    assert.match(desk, /the cistern is half down/);
  });

  it("refuses a name whose conversation is still here, in the words the command uses", async () => {
    const refused = await post(`${URL}/sessions`, { name: CAME_BACK });
    assert.equal(refused.status, 400);
    assert.match(JSON.parse(refused.body).error, new RegExp(`conversation here.*chat/${CAME_BACK}`));
    assert.equal(JSON.parse(refused.body).error, whatTheCommandSays(CAME_BACK));
  });

  it("leaves that conversation alone rather than clearing it to get its own job done", () => {
    assert.ok(fs.existsSync(path.join(instance, "chat", CAME_BACK, "conversation.json")));
  });

  it("puts nobody in the room by refusing", async () => {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    assert.deepEqual(
      rows.map((row) => row.name).filter((name) => name === CAME_BACK || name === "../elsewhere"),
      [],
    );
  });
});

// Hiring and leaving, on the page. No suite runs page.html — it is served and read as TEXT — so
// what is checked here is that each is OFFERED and that it goes to the route behind it. What the
// routes do is proven above, on their own data; this is the seam between them and a browser, and
// it is not a substitute for opening one.
describe("what the page offers", () => {
  let page;

  before(async () => {
    page = (await get(`${URL}/`)).body;
  });

  // The form is markup and not something the script builds, so it cannot be built and never
  // attached — the trap the room's checks exist to catch. What can go wrong instead is the wiring,
  // and that is the check under this one.
  it("offers to hire somebody", () => {
    assert.match(page, /<form id="hiring">/);
    assert.match(page, /<button id="hire" type="submit">Hire<\/button>/);
  });

  it("hires over the route rather than anywhere else", () => {
    assert.match(page, /fetch\("\/sessions", \{\n\s+method: "POST"/);
  });

  it("shows a refusal in the words it came in", () => {
    assert.match(page, /refusal\.textContent = \(await answered\.json\(\)\)\.error;/);
  });

  // Built per panel, so this one CAN be built and never attached. The check reads the line that
  // puts it beside the other buttons, not the line that makes it.
  it("offers a worker the way out, beside the handover", () => {
    assert.match(page, /composer\.append\(box, send, hand, endRun, \.\.\.\(leave === null \? \[\] : \[leave\]\)\);/);
  });

  // On every panel and not only a worker's: a lead's run can stop moving exactly as anybody
  // else's can, and the lead is the session a page cannot afford to lose.
  it("offers the way out of a run to every panel", () => {
    assert.match(page, /const endRun = document\.createElement\("button"\);/);
    assert.match(page, /endRun\.textContent = "End this run";/);
  });

  // An instance has a lead by definition and this page is hosted by it. The route refuses it too;
  // this is so nobody is offered a button that cannot work.
  it("does not offer it to the session that leads", () => {
    assert.match(page, /const leave = session\.role === "lead" \? null : document\.createElement\("button"\);/);
  });

  it("asks the route to retire the session, and not something of its own", () => {
    assert.match(page, /fetch\(`\/sessions\/\$\{session\.name\}\/leave`, \{ method: "POST" \}\)/);
  });

  // Who works here is a load-time fact: the panels are built once from /sessions. So both of the
  // things that change it load the page again rather than growing a panel lifecycle.
  it("loads again when who works here has changed", () => {
    assert.equal((page.match(/whoWorksHereChanged\(\);/g) ?? []).length, 2);
    assert.match(page, /function whoWorksHereChanged\(\) \{\n\s+location\.reload\(\);/);
  });
});

// A chat is stopped by a person, in a terminal, with ctrl-c — and by whatever else stops a
// process: a kill, or the window it was started in going away. What is checked here is the same
// thing each time, which is that nothing it started is left behind.
//
// The run these checks leave parked is one that will not end on its own for a full minute: it is
// waiting to be told whether it may use a tool, and nobody is going to tell it. So a pid that is
// gone afterwards is the chat having ended it, and not the run having finished anyway.
//
// The signal goes to the chat's own pid, never to its process group. That is deliberate: a
// terminal's ctrl-c does reach the group, so a check that signalled the group would pass with
// none of this code in place and prove nothing. Every other way a chat is stopped reaches this
// process alone, and that is the case worth a check.
describe("stopping the chat", () => {
  // Long enough that a run giving up on its own cannot be mistaken for the chat having ended it.
  const GIVES_UP = 60000;
  const parked = { OW_STAND_IN_ASKS: "Bash", OW_STAND_IN_WAITS: String(GIVES_UP) };

  // The two signals a person and a system send, and — on the last of them — a run that has been
  // asked to stop and is not going to. Being asked is the whole of what a well behaved run needs;
  // the third case is there because the chat has no way of knowing it is dealing with one.
  // The last number is how long stopping may take. A run that is merely asked goes at once, so
  // anything near the two seconds the chat waits before forcing one would mean the asking did
  // nothing and the force did all the work. The run that will not go is the one case allowed to
  // cost that wait.
  const ways = [
    ["SIGINT", "SIGINT", parked, 1000],
    ["SIGTERM", "SIGTERM", parked, 1000],
    ["SIGHUP, as when the window it was started in goes away", "SIGHUP", parked, 1000],
    ["SIGINT and a run that will not go quietly", "SIGINT", { ...parked, OW_STAND_IN_DEAF: "yes" }, GIVES_UP / 4],
  ];

  for (const [way, signal, how, within] of ways) {
    describe(`with ${way}`, () => {
      const stopLog = path.join(standIn, `stopping-${way.replace(/ /g, "-")}.txt`);
      let run;
      let stopped;
      let took;

      before(async () => {
        const chat = await start(instance, standInEnvironment(standIn, stopLog, how));
        assert.ok(await waitForHealth(URL), "the server never answered");

        // Not awaited: this is the message that never gets its answer. Its own failure is the
        // point — the chat is stopped out from under it — so it is caught here rather than left
        // to come back later as an unhandled rejection against whatever check is running then.
        say(`something to be stopped in the middle of, over ${way}`).catch(() => {});

        const waiting = await waitFor(async () => {
          const { permissions } = JSON.parse((await get(`${URL}/sessions/${LEADER}/permissions`)).body);
          return permissions.length > 0 ? permissions : null;
        });
        assert.ok(waiting !== null, "no run was ever parked, so there is nothing to leave behind");

        [run] = pidsIn(stopLog);
        assert.ok(alive(run), `the run at ${run} was already gone before anything was stopped`);

        const ended = new Promise((resolve) => chat.once("close", resolve));
        const at = Date.now();
        chat.kill(signal);
        stopped = await ended;
        took = Date.now() - at;
      });

      // Exit code null means the signal cut it down where it stood, which is what happens when
      // nothing is listening for one. A chat that handled it stops itself, and says 0.
      it("stops itself rather than being cut down where it stands", () => {
        assert.equal(stopped, 0, `the chat did not stop itself on ${way}`);
      });

      it("leaves nothing of the run behind", async () => {
        const gone = await waitFor(() => (alive(run) ? null : true));
        assert.ok(gone, `the run at ${run} outlived the chat that started it`);
      });

      // Without this the checks above pass by waiting: the parked run gives up on its own after a
      // minute, so a chat that merely sat there until it did would look exactly like a chat that
      // ended it. Watched — with the escalation taken out, this describe went from 2.2s to 60.2s
      // and every other check in it still passed.
      it("does not sit there until the run gives up on its own", () => {
        assert.ok(took < within, `stopping took ${took}ms, longer than the ${within}ms it should`);
      });

      // Only the run that has to be forced starts one of these. A run that is merely asked takes
      // its own shells with it, which is measured and is why nothing here reaches for them on
      // that path; a forced one cannot, because it is not running any more to do it.
      it("leaves nothing the run had started behind either", async () => {
        const shells = shellsIn(stopLog);
        if (shells.length === 0) {
          return;
        }
        for (const shell of shells) {
          const gone = await waitFor(() => (alive(shell) ? null : true));
          assert.ok(gone, `the shell at ${shell} outlived the run that started it`);
        }
      });
    });
  }
});

// The instance's own commands, called as tools rather than typed as shell lines.
//
// Everything here is posted to the endpoint a session is handed the address of when it starts. The
// name in the path is who the caller IS — the chat puts it there — which is what lets a check post
// as a session at all, and is the whole of how a message arrives signed.
describe("a session calls the tools the chat serves it", () => {
  const toolLog = path.join(standIn, "tool-calls.txt");

  // Everything a shell line cannot carry, in one message: an apostrophe, which ends the quoting; a
  // backtick, which is run and its output sent instead of what was written; a real newline; and a
  // pipe, a hash and a bare $HOME, each of which means something to a shell and nothing here.
  const AWKWARD = "it's `two` lines\nand a $HOME | a # of its own";

  async function messagesOf(name) {
    return JSON.parse((await transcriptOf(name)).body).messages;
  }

  before(async () => {
    await start(instance, standInEnvironment(standIn, toolLog));
    assert.ok(await waitForHealth(URL), "the server never came back");
  });

  it("offers say among the tools it serves", async () => {
    const { tools } = JSON.parse((await call(WORKER, "tools/list")).body).result;
    assert.ok(tools.some((tool) => tool.name === "say"));
  });

  it("says what say takes", async () => {
    const { tools } = JSON.parse((await call(WORKER, "tools/list")).body).result;
    assert.deepEqual(tools.find((tool) => tool.name === "say").inputSchema.required, ["to", "message"]);
  });

  // The description is what a session reads before it decides whether to call. Measured: a session
  // that cannot see a tool goes looking for another way round the same thing, where one that can
  // see it and reads what it will not do simply does not call it.
  it("says in the description what the tool will not do", async () => {
    const { tools } = JSON.parse((await call(WORKER, "tools/list")).body).result;
    assert.match(tools.find((tool) => tool.name === "say").description, /nothing here starts, ends or files/);
  });

  it("says what it is when asked", async () => {
    const { result } = JSON.parse((await call(WORKER, "initialize", { protocolVersion: "2025-06-18" })).body);
    assert.equal(result.serverInfo.name, "office");
  });

  // Asked both ways. One version asked for and asserted is a caller and a server agreeing on a
  // string the server never had to read — a server answering in a version of its own passed it —
  // and one of the two here is the server's own, so answering in that instead is caught as well.
  it("answers in the version the caller asked for", async () => {
    const older = JSON.parse((await call(WORKER, "initialize", { protocolVersion: "2024-11-05" })).body).result;
    const newer = JSON.parse((await call(WORKER, "initialize", { protocolVersion: "2025-06-18" })).body).result;
    assert.deepEqual([older.protocolVersion, newer.protocolVersion], ["2024-11-05", "2025-06-18"]);
  });

  it("says so when asked for something it does not serve", async () => {
    assert.equal(answerOf(await call(WORKER, "tools/rename")).error.code, -32601);
  });

  // Who works here, which is the half of the command a session can act on: the names it can say
  // something to. The other half is about the machine, and one of its rows starts Claude Code to
  // answer it — which is not a thing to do before every message.
  describe("a session asks who works here", () => {
    let listed;

    before(async () => {
      listed = answerOf(await call(WORKER, "tools/call", { name: "status", arguments: {} })).text;
    });

    it("offers status among the tools it serves", async () => {
      const { tools } = JSON.parse((await call(WORKER, "tools/list")).body).result;
      assert.ok(tools.some((tool) => tool.name === "status"));
    });

    it("names everybody who works here", () => {
      for (const name of [LEADER, WORKER]) {
        assert.match(listed, new RegExp(`^${name}\\b`, "m"), `${name} is not in it`);
      }
    });

    // Read against the desks on disk rather than against a number: a desk is a person here, so
    // the list is right when it is exactly the desks and wrong the moment it is anything else.
    it("names nobody else", () => {
      const named = listed.split("\n").map((line) => line.split(/\s+/)[0]).sort();
      assert.deepEqual(named, fs.readdirSync(path.join(instance, "work")).sort());
    });

    it("says which of them leads", () => {
      assert.match(listed, new RegExp(`^${LEADER}\\s+lead\\b`, "m"));
    });

    it("says the others are not the lead", () => {
      assert.match(listed, new RegExp(`^${WORKER}\\s+worker\\b`, "m"));
    });

    it("says what each of them runs on", () => {
      assert.match(listed, new RegExp(`^${LEADER}\\s+lead\\s+${LEADER_MODEL}\\s*$`, "m"));
      assert.match(listed, new RegExp(`^${WORKER}\\s+worker\\s+${WORKER_MODEL}\\s*$`, "m"));
    });

    // What it is not: the live half of the room — who is answering, who is queued behind, who is
    // held up waiting — is a different question and a different tool.
    it("says nothing about who is busy", () => {
      assert.ok(!/answering|waiting|queued/i.test(listed));
    });
  });

  describe("one session says something to another", () => {
    let answered;

    before(async () => {
      answered = answerOf(await call(LEADER, "tools/call", { name: "say", arguments: { to: WORKER, message: AWKWARD } }));
    });

    it("delivers it to the panel of whoever it was said to", async () => {
      assert.ok((await messagesOf(WORKER)).some((message) => message.text === AWKWARD));
    });

    // The whole point of the feature, and the reason it is a tool: every character of it survives,
    // including the three a shell would have eaten before it ever left the session.
    it("keeps every character of what was said", async () => {
      const said = (await messagesOf(WORKER)).find((message) => message.text.includes("two"));
      assert.equal(said.text, AWKWARD);
    });

    it("hands the answer back to whoever called", () => {
      assert.match(answered.text, /a reply/);
    });

    it("puts it under the name of whoever called", async () => {
      assert.equal((await messagesOf(WORKER)).find((message) => message.text === AWKWARD).from, LEADER);
    });

    // The name comes from the path the chat gave this session and from nothing it says. A session
    // that names somebody else is still itself: there is no argument here that could sign it.
    it("signs it with who called and not with what they said", async () => {
      const claimed = "signed by nobody";
      await call(WORKER, "tools/call", {
        name: "say",
        arguments: { to: LEADER, message: claimed, from: LEADER, caller: LEADER },
      });
      assert.equal((await messagesOf(LEADER)).find((message) => message.text === claimed).from, WORKER);
    });
  });

  describe("what it refuses", () => {
    it("refuses to say it to somebody who does not work here", async () => {
      const said = answerOf(await call(LEADER, "tools/call", { name: "say", arguments: { to: "Nobody", message: "hello" } }));
      assert.ok(said.refused);
      assert.match(said.text, /nobody called Nobody works here/);
    });

    // A refusal is a refusal all the way down: nothing was delivered anywhere, so nothing was
    // written down anywhere either. Read on the caller's own panel, which is where a message that
    // could not be delivered leaves its line.
    it("writes nothing down when it refuses", async () => {
      const before = (await messagesOf(LEADER)).length;
      await call(LEADER, "tools/call", { name: "say", arguments: { to: "Nobody", message: "hello" } });
      assert.equal((await messagesOf(LEADER)).length, before);
    });

    it("refuses to say nothing", async () => {
      const said = answerOf(await call(LEADER, "tools/call", { name: "say", arguments: { to: WORKER, message: "" } }));
      assert.ok(said.refused);
      assert.match(said.text, /needs some text/);
    });

    it("refuses a name nobody could have", async () => {
      const said = answerOf(
        await call(LEADER, "tools/call", { name: "say", arguments: { to: "../elsewhere", message: "hello" } }),
      );
      assert.match(said.text, /must start with a letter/);
    });

    // The other half of the signature: a path naming somebody who does not work here is not a
    // caller, whatever it asks for. Nothing in the instance writes such an address, so this is the
    // check that says what happens when something else posts one.
    it("refuses a caller who does not work here", async () => {
      const said = answerOf(await call("Nobody", "tools/call", { name: "say", arguments: { to: WORKER, message: "hello" } }));
      assert.ok(said.refused);
      assert.match(said.text, /nobody called Nobody works here/);
    });

    it("says so when asked for a tool it does not serve", async () => {
      const said = answerOf(await call(WORKER, "tools/call", { name: "archive", arguments: {} }));
      assert.ok(said.refused);
      assert.match(said.text, /no archive tool/);
    });
  });

  describe("what a session is started with", () => {
    before(async () => {
      await say("something to answer", WORKER);
    });

    // The address carries this session's own name, which is what makes the signature the chat's
    // word rather than the model's. Passed as the configuration itself and not as a file: the port
    // is only known once the chat has bound one, and a file written before that is a lie.
    it("hands a session the address of the tools under its own name", () => {
      assert.match(callsIn(toolLog).at(-1), new RegExp(`--mcp-config .*/mcp/${WORKER}`));
    });

    // How long it may be kept waiting is said out loud, because `say` is answered only once the
    // session it reached has finished its turn. Left unsaid the call is given up on after a
    // minute — measured — and the caller is told it failed while the answer it asked for is still
    // being written, into a transcript it will never see.
    it("gives a session long enough for another one to answer it", () => {
      const handed = callsIn(toolLog).at(-1).match(/--mcp-config (\S+)/)[1];
      assert.equal(JSON.parse(handed).mcpServers.office.timeout, 30 * 60 * 1000);
    });
  });

  // The chat can be stopped and started again in the middle of a session's thread — it is how the
  // toolkit is taken to a newer version — and the tools have to be there afterwards without the
  // session knowing anything happened. Nothing is remembered between requests, which is what makes
  // that true; a server holding a handshake would meet the next call as a stranger.
  //
  // Both states are reached here on purpose: the introduction is made to one process and the call
  // is answered by another. A check that introduced itself and called in the same breath would
  // pass just as happily with the whole thing remembered.
  describe("the chat is stopped and started again under a session", () => {
    let answered;

    const servingNow = () => JSON.parse(fs.readFileSync(path.join(instance, "chat", "listening.json"), "utf8")).pid;

    before(async () => {
      await call(LEADER, "initialize", { protocolVersion: "2025-06-18" });
      const introduced = servingNow();
      await start(instance, standInEnvironment(standIn, toolLog));
      assert.ok(await waitForHealth(URL), "the server never came back");
      // Said out loud, because the whole check rests on it: the process answering below is not the
      // one that was introduced to above. Without this the two states are the same state.
      assert.notEqual(servingNow(), introduced, "the same process answered, so nothing was proven");
      answered = answerOf(
        await call(LEADER, "tools/call", { name: "say", arguments: { to: WORKER, message: "still here?" } }),
      );
    });

    it("answers a call the process it introduced itself to never saw", async () => {
      assert.ok(!answered.refused, `the call was refused: ${answered.text}`);
      assert.ok((await messagesOf(WORKER)).some((message) => message.text === "still here?"));
    });
  });

  // The room, which is the one thing here that is not served to everybody. Both halves of that are
  // checked: what a session is OFFERED, and what it gets if it asks anyway. Offering alone is
  // advice — a session that heard about the room from somewhere else asks for it regardless — and
  // refusing alone leaves every worker reading about something it may not have.
  describe("the session that leads looks at the room", () => {
    const ON_IT = "counting the doors";
    let shown;
    let printed;

    async function offeredTo(who) {
      return JSON.parse((await call(who, "tools/list")).body).result.tools.map((tool) => tool.name);
    }

    // What is on a desk, which is the one part of a room that is not in the chat's own head. One
    // desk says and one does not, because a check that only ever saw the empty one would pass with
    // the column dropped altogether.
    function writeTitle(name, title) {
      const desk = path.join(instance, "work", name, "STATE.md");
      const lines = fs.readFileSync(desk, "utf8").split("\n");
      lines[0] = `<!-- DESK | title: ${title} -->`;
      fs.writeFileSync(desk, lines.join("\n"));
    }

    before(async () => {
      writeTitle(WORKER, ON_IT);
      shown = answerOf(await call(LEADER, "tools/call", { name: "room", arguments: {} })).text;
      printed = runTool(instance, ["room"], standIns);
    });

    it("offers room to the session that leads", async () => {
      assert.ok((await offeredTo(LEADER)).includes("room"));
    });

    // The check this arrangement exists for. One that only asked whether the lead is offered it
    // passes just as happily when everybody is, which is the way this can go wrong without anybody
    // noticing until a worker is reading somebody else's room.
    it("offers it to nobody else", async () => {
      assert.ok(!(await offeredTo(WORKER)).includes("room"));
    });

    it("still offers everybody else everything else", async () => {
      assert.deepEqual((await offeredTo(WORKER)).sort(), ["say", "status"]);
    });

    // Refused in the tool's own words rather than as a tool that does not exist, because it does
    // exist — and a session told there is no such thing goes looking for another way to the same
    // answer, where one told whose it is asks that person.
    it("refuses anybody else who asks for it anyway", async () => {
      const asked = answerOf(await call(WORKER, "tools/call", { name: "room", arguments: {} }));
      assert.ok(asked.refused);
      assert.match(asked.text, new RegExp(`the room is the lead's to look at, so ask ${LEADER}`));
    });

    it("has a line for everybody who works here", () => {
      const named = shown.split("\n").map((line) => line.split(/\s+/)[0]).sort();
      assert.deepEqual(named, fs.readdirSync(path.join(instance, "work")).sort());
    });

    it("says what each of them is on", () => {
      assert.match(shown, new RegExp(`^${WORKER}\\b.*${ON_IT}`, "m"));
    });

    it("says so about a desk that has not said what it is on", () => {
      assert.match(shown, new RegExp(`^${LEADER}\\b.*has not said what it is on`, "m"));
    });

    // One room, whoever is asking. The clock is taken out of both before they are compared: the
    // two renders are milliseconds apart and would still disagree across a minute boundary, which
    // is a flake rather than a finding.
    it("says the same thing the command says", () => {
      const withoutTheClock = (text) => text.split("\n").map((line) => line.replace(/last moved .*$/, "")).join("\n");
      assert.equal(printed.status, 0, printed.stderr);
      assert.equal(withoutTheClock(printed.stdout.trimEnd()), withoutTheClock(shown));
    });
  });

  // What a room says that nothing on disk knows: who is answering and who is stopped waiting for
  // whom. One state gives both — the lead is held inside its own turn waiting on the worker, and
  // the worker is mid-turn answering it — so it is built once and read once.
  describe("the room while somebody is answering and somebody is waiting", () => {
    const heldLog = path.join(standIn, "room-held.txt");
    let shown;

    before(async () => {
      await start(
        instance,
        standInEnvironment(standIn, heldLog, {
          OW_STAND_IN_CALLS: `${LEADER}>${WORKER}`,
          OW_STAND_IN_SLOW: "1500",
        }),
      );
      assert.ok(await waitForHealth(URL), "the server never came back");

      const asking = say("go and ask him", LEADER);
      shown = await waitFor(async () => {
        const room = answerOf(await call(LEADER, "tools/call", { name: "room", arguments: {} })).text;
        return new RegExp(`^${LEADER}\\b.*waiting for ${WORKER}`, "m").test(room) ? room : null;
      });
      await asking;
    });

    it("names who the lead is held up waiting for", () => {
      assert.match(shown ?? "", new RegExp(`^${LEADER}\\b.*waiting for ${WORKER}`, "m"));
    });

    it("says the one it is waiting for is answering", () => {
      assert.match(shown ?? "", new RegExp(`^${WORKER}\\b.*answering`, "m"));
    });
  });
});

// A thread that cannot be resumed. The chat drops the id and asks again as a new conversation, and
// every later check about a run the service refused stands on the stand-in framing this the way
// the real one does — so the shape is checked here, on the stand-in's own output, before anything
// is built on it.
//
// Measured on Claude Code 2.1.259 by resuming an id no conversation was ever written under: the
// message is an array of plain strings under `errors`, there is no `result` field at all, and
// `session_id` is the id that was asked for rather than null. The same message goes to stderr.
describe("a thread that is not there any more", () => {
  const gone = "a-thread-nobody-ever-wrote";
  const goneLog = path.join(standIn, "gone.txt");
  let refused;

  before(async () => {
    refused = await driveStandIn(
      standInCommand,
      ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--resume", gone],
      standInEnvironment(standIn, goneLog, { OW_STAND_IN_RESUME_FAILS: "yes" }),
    ).ended;
  });

  it("says which run it is, rather than nothing at all", () => {
    const frame = refused.frames.find((one) => one.type === "result");
    assert.equal(typeof frame?.session_id, "string");
    assert.notEqual(frame?.session_id, "");
    assert.equal(frame?.session_id, gone, "the run adopts the id it was asked to resume");
  });

  it("puts what went wrong in errors, and not in a result", () => {
    const frame = refused.frames.find((one) => one.type === "result");
    assert.ok(Array.isArray(frame?.errors), `errors is ${JSON.stringify(frame?.errors)}`);
    assert.ok(frame.errors.length > 0, "nothing was said about the failure");
    assert.ok(!("result" in frame), "a result field the real one does not send");
  });

  it("says it in prose as well, where a run that framed nothing would say it", () => {
    assert.match(refused.err, /No conversation found with session ID/);
  });
});

// What the chat does with that frame, which is the behaviour slice 2 is about to narrow: drop the
// id and ask again as a new conversation. Pinned here, before it is touched.
describe("a chat asked to carry on a thread that is gone", () => {
  const lostLog = path.join(standIn, "lost.txt");
  let carried;

  before(async () => {
    // A first conversation, under an id of its own, so that what is remembered afterwards cannot
    // be the same string by coincidence.
    await start(instance, standInEnvironment(standIn, lostLog, { OW_STAND_IN_SESSION: "old-thread" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("open a thread");

    await start(
      instance,
      standInEnvironment(standIn, lostLog, { OW_STAND_IN_SESSION: "new-thread", OW_STAND_IN_RESUME_FAILS: "yes" }),
    );
    assert.ok(await waitForHealth(URL), "the server never came back");
    await say("carry it on");

    // Read here, at the moment being checked, and not in the `it` below: a third message follows
    // and its ordinary answer would sit at the end of the transcript, so a check reading the last
    // message afterwards would be looking at somebody else's reply and passing whatever happened
    // to this one. It was written that way first, and the mutation that keeps the thread went
    // unnoticed by it.
    carried = JSON.parse((await transcriptOf(LEADER)).body).messages.at(-1);

    // A third message, with the stand-in resuming normally again. What the chat kept is not read
    // out of the file here — no route and no reader says it — but out of what the next run is
    // asked to resume, which is the code using it rather than the check reading around it.
    await start(instance, standInEnvironment(standIn, lostLog, { OW_STAND_IN_SESSION: "new-thread" }));
    assert.ok(await waitForHealth(URL), "the server never came back a second time");
    await say("and once more");
  });

  it("tried the thread it had", () => {
    assert.ok(
      callsIn(lostLog).some((call) => call.includes("--resume old-thread")),
      "the failed resume never happened, so nothing below is about anything",
    );
  });

  it("asks again without the thread it could not resume", () => {
    const calls = callsIn(lostLog);
    const failed = calls.findIndex((call) => call.includes("--resume old-thread"));
    const next = calls[failed + 1];
    assert.notEqual(next, undefined, "there was no second run at all");
    assert.ok(!next.includes("--resume"), `asked to resume anyway: ${next}`);
  });

  it("carries on the thread the second run opened, and not the one that was gone", () => {
    const last = callsIn(lostLog).at(-1);
    assert.ok(last.includes("--resume new-thread"), `the next run was called ${last}`);
    assert.ok(!last.includes("old-thread"));
  });

  it("still answers the person who asked", () => {
    assert.equal(carried?.text, "a reply");
  });
});

// A run the service turned away. Not an answer and not a failure: it reached the service and was
// refused. The state has to be reachable before any check about what the chat does with it can
// mean anything, so this builds it and checks the stand-in's OWN output — going through the chat
// would be reading the value the code was kind enough to hand back.
//
// The shape is the published one: a rate_limit_event whose rate_limit_info.status is "rejected",
// and then a result frame spelled subtype "success" while carrying is_error true. A refusal
// differs from an ordinary answer only in is_error, which is why the spelling is checked here and
// not taken on trust further up.
describe("a stand-in the service refused", () => {
  const refusedLog = path.join(standIn, "refused.txt");
  let wentEarly;
  let refused;

  before(async () => {
    const run = driveStandIn(
      standInCommand,
      ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      standInEnvironment(standIn, refusedLog, { OW_STAND_IN_REFUSED: "yes" }),
    );
    run.ask("something that costs a request");

    const said = await run.waitForFrame((one) => one.type === "result");
    assert.ok(said !== null, "no result frame ever came");

    // Held in the refused state on purpose, with the run still going. A check that closed stdin
    // the instant the result arrived could not tell "goes when it is told to" from "goes on its
    // own the moment it is refused" — both would end at 1 and both would look right.
    wentEarly = await Promise.race([
      run.ended.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 300)),
    ]);

    run.close();
    refused = await run.ended;
  });

  it("says it was refused before it says how the run ended", () => {
    const limit = refused.frames.findIndex((one) => one.type === "rate_limit_event");
    const result = refused.frames.findIndex((one) => one.type === "result");
    assert.notEqual(limit, -1, "there was no rate-limit frame at all");
    assert.notEqual(result, -1, "there was no result frame at all");
    assert.ok(limit < result, `the refusal came at ${limit} and the result at ${result}`);
  });

  it("says the service rejected it in the fields, where nobody has to read prose", () => {
    const limit = refused.frames.find((one) => one.type === "rate_limit_event");
    assert.equal(limit?.rate_limit_info?.status, "rejected");
    assert.equal(limit?.rate_limit_info?.rateLimitType, "five_hour");
    assert.equal(typeof limit?.rate_limit_info?.resetsAt, "number");
  });

  it("spells the refusal a success that is an error, which is the whole trap", () => {
    const said = refused.frames.find((one) => one.type === "result");
    assert.equal(said?.subtype, "success", "spelled as something a refusal is not");
    assert.equal(said?.is_error, true);
  });

  it("carries the one field that tells a refusal from a signed-out run", () => {
    const said = refused.frames.find((one) => one.type === "result");
    assert.equal(said?.api_error_status, 429);
  });

  it("carries the field that sits beside status and is not it", () => {
    const limit = refused.frames.find((one) => one.type === "rate_limit_event");
    assert.equal(limit?.rate_limit_info?.overageStatus, "rejected");
  });

  it("does not go the moment it has been refused", () => {
    assert.equal(wentEarly, false, "it ended without being told the run was over");
  });

  it("exits 1 once stdin is closed", () => {
    assert.equal(refused.code, 1);
  });
});

// The same reading, on a run that was NOT refused — and the trap that makes it worth a block of its
// own. `overageStatus` sits directly beside `status`, reads "rejected" on every capture taken on
// this machine, and every one of those runs was allowed: it is about whether the account may spend
// past its plan, not about whether this run may happen.
//
// So the two fields are the same word on an ordinary run and mean opposite things, and a reader of
// the wrong one calls every run in this workspace a refusal. This block is here so that reader
// cannot pass: it pins what the fixture sends, and the checks about an allowed run are what go red.
describe("a stand-in the service allowed", () => {
  const allowedLog = path.join(standIn, "allowed.txt");
  let reading;

  before(async () => {
    const run = driveStandIn(
      standInCommand,
      ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      standInEnvironment(standIn, allowedLog, { OW_STAND_IN_LIMIT: "allowed" }),
    );
    run.ask("something ordinary");
    await run.waitForFrame((one) => one.type === "result");
    run.close();
    reading = (await run.ended).frames.find((one) => one.type === "rate_limit_event")?.rate_limit_info;
  });

  it("says the run is allowed", () => {
    assert.equal(reading?.status, "allowed");
  });

  it("says rejected in the field beside it, which is about the account and not the run", () => {
    assert.equal(reading?.overageStatus, "rejected");
  });

  it("carries the windows the frame names, rather than one this suite made up", () => {
    assert.equal(typeof reading?.unifiedWindows?.five_hour?.utilization, "number");
    assert.equal(typeof reading?.unifiedWindows?.seven_day?.utilization, "number");
  });
});

// The fullness is the one thing on that frame this feature reads, so the fixture has to be able to
// say a number nobody wrote down twice. Driven directly rather than through the chat: what is being
// proven is what goes ON the wire, and reading it back off a row would be reading the value the
// code was kind enough to hand back.
describe("a stand-in told how full the window is", () => {
  const toldLog = path.join(standIn, "told.txt");
  let reading;

  before(async () => {
    const run = driveStandIn(
      standInCommand,
      ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      standInEnvironment(standIn, toldLog, { OW_STAND_IN_LIMIT: "allowed", OW_STAND_IN_FULLNESS: "0.71" }),
    );
    run.ask("something ordinary");
    await run.waitForFrame((one) => one.type === "result");
    run.close();
    reading = (await run.ended).frames.find((one) => one.type === "rate_limit_event")?.rate_limit_info;
  });

  // Mutation: hard-code the fullness in the fixture. Every check below about a number on a row
  // stands on the fixture being able to say a number of its own, and a constant would pass them
  // all without anything having read the frame.
  it("reports the fullness it was told, and not one written into the fixture", () => {
    assert.equal(reading?.unifiedWindows?.five_hour?.utilization, 0.71);
  });
});

// What the chat does with a run the service turned away. Slice 1 built the state; this is the
// behaviour it was built for, and all of it is read from what the NEXT run was asked to do rather
// than from anything the code was kind enough to hand back.
//
// A refusal and a lost thread arrive at ask() looking alike — both are `failed` — and the whole of
// this feature is that they stop being treated alike. So the pair matters more than either half:
// every block here says what a refusal does NOT do, and the block above about a thread that is
// gone says the same things happening to a failure that really is one. Apply either behaviour to
// the other and one of the two goes red.
describe("a chat whose run the service refused", () => {
  const outLog = path.join(standIn, "refused-chat.txt");
  let answered;
  let calls;

  before(async () => {
    // A thread first, under an id of its own, so that what is kept afterwards cannot be that
    // string by coincidence.
    await start(instance, standInEnvironment(standIn, outLog, { OW_STAND_IN_SESSION: "live-thread" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("open a thread");

    await start(
      instance,
      standInEnvironment(standIn, outLog, { OW_STAND_IN_SESSION: "live-thread", OW_STAND_IN_REFUSED: "yes" }),
    );
    assert.ok(await waitForHealth(URL), "the server never came back");
    answered = await say("ask while the account is out");

    calls = callsIn(outLog);
  });

  it("answers rather than sitting on a run that will not end itself", () => {
    // 503 since slice 3, which is what a refusal is answered with. What this check is about is
    // that it was answered AT ALL: the run it is waiting on is one nothing else would end.
    assert.equal(answered.status, 503);
  });

  it("asked on the thread it had, so what follows is about a refused resume", () => {
    assert.ok(
      calls.some((call) => call.includes("--resume live-thread")),
      "the refused run never carried the thread, so nothing below is about anything",
    );
  });

  it("does not spend a second run on a refusal the first one already got", () => {
    const refused = calls.findIndex((call) => call.includes("--resume live-thread"));
    assert.equal(calls[refused + 1], undefined, `it ran again: ${calls[refused + 1]}`);
  });
});

// There is no check here for the thread still being on disk afterwards, and that is deliberate.
// One was written, and no mutation could make it fail: `forget` and the re-ask are the same branch
// in `ask()`, so a run that was not asked again was not forgotten either — and the stand-in reports
// the id it was given, so a re-ask under the same name would remember the same string anyway. The
// check said something true that could not go wrong, which is the shape this repo has twice paid to
// learn. What the thread being kept looks like from outside is the check above: no second run.

// A refusal that says nothing about when it lifts. The schema does not promise `resetsAt`, and a
// chat that needed it to recognise a refusal at all would go back to forgetting the thread the
// first time one came without it.
describe("a chat refused without being told when the limit lifts", () => {
  const quietLog = path.join(standIn, "no-reset.txt");
  let calls;

  before(async () => {
    await start(instance, standInEnvironment(standIn, quietLog, { OW_STAND_IN_SESSION: "timeless-thread" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("open a thread");

    await start(
      instance,
      standInEnvironment(standIn, quietLog, {
        OW_STAND_IN_SESSION: "timeless-thread",
        OW_STAND_IN_REFUSED: "yes",
        OW_STAND_IN_NO_RESET: "yes",
      }),
    );
    assert.ok(await waitForHealth(URL), "the server never came back");
    await say("ask while the account is out");
    calls = callsIn(quietLog);
  });

  it("is still a refusal: no second run", () => {
    const refused = calls.findIndex((call) => call.includes("--resume timeless-thread"));
    assert.notEqual(refused, -1, "the refused run never carried the thread");
    assert.equal(calls[refused + 1], undefined, `it ran again: ${calls[refused + 1]}`);
  });
});

// A refusal that reaches the chat as the 429 alone. The rejected reading has never been watched on
// the wire — the design says so in those words — so the field on the result frame answers the same
// question by itself, and this is the check that says so.
//
// The allowed reading is sent first on purpose. That is what an ordinary run sends, both captures
// on this machine hold the frame in exactly that state, and a chat that remembered it would read
// the allowance and call the refusal an answer.
describe("a chat refused after being told it was allowed", () => {
  const lateLog = path.join(standIn, "late-refusal.txt");
  let calls;

  before(async () => {
    await start(instance, standInEnvironment(standIn, lateLog, { OW_STAND_IN_SESSION: "late-thread" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("open a thread");

    await start(
      instance,
      standInEnvironment(standIn, lateLog, {
        OW_STAND_IN_SESSION: "late-thread",
        OW_STAND_IN_LIMIT: "allowed",
        OW_STAND_IN_REFUSED_QUIETLY: "yes",
      }),
    );
    assert.ok(await waitForHealth(URL), "the server never came back");
    await say("ask while the account is out");
    calls = callsIn(lateLog);
  });

  it("reads the refusal off the status, and not off the reading it was given first", () => {
    const refused = calls.findIndex((call) => call.includes("--resume late-thread"));
    assert.notEqual(refused, -1, "the refused run never carried the thread");
    assert.equal(calls[refused + 1], undefined, `it ran again: ${calls[refused + 1]}`);
  });
});

// The other half of the pair, twice: a reading that is NOT a refusal changes nothing at all. The
// thread really is gone in both, so the forget-and-retry has to happen exactly as it does without
// any reading at all — which is what fails the moment a rate_limit_event is treated as a refusal
// for its own sake rather than for what it says.
for (const state of ["allowed", "allowed_warning"]) {
  describe(`a chat told it was ${state} while its thread was gone`, () => {
    const okLog = path.join(standIn, `limit-${state}.txt`);
    let calls;

    before(async () => {
      await start(instance, standInEnvironment(standIn, okLog, { OW_STAND_IN_SESSION: "kept-thread" }));
      assert.ok(await waitForHealth(URL), "the server never answered");
      await say("open a thread");

      await start(
        instance,
        standInEnvironment(standIn, okLog, {
          OW_STAND_IN_SESSION: "fresh-thread",
          OW_STAND_IN_LIMIT: state,
          OW_STAND_IN_RESUME_FAILS: "yes",
        }),
      );
      assert.ok(await waitForHealth(URL), "the server never came back");
      await say("carry it on");
      calls = callsIn(okLog);
    });

    it("still drops the thread it could not resume and asks again", () => {
      const failed = calls.findIndex((call) => call.includes("--resume kept-thread"));
      assert.notEqual(failed, -1, "the failed resume never happened");
      const next = calls[failed + 1];
      assert.notEqual(next, undefined, "there was no second run, so the reading was read as a refusal");
      assert.ok(!next.includes("--resume"), `asked to resume anyway: ${next}`);
    });
  });
}

// A run with no usable credential. Every field a refusal has, spelled the same way, except the
// 429 — and a chat that called this a refusal would keep a thread it can never use and stop
// repairing itself, for a condition that does not clear on any timer.
describe("a chat whose run had no credential", () => {
  const outLog = path.join(standIn, "signed-out.txt");
  let calls;

  before(async () => {
    await start(instance, standInEnvironment(standIn, outLog, { OW_STAND_IN_SESSION: "stale-thread" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("open a thread");

    await start(
      instance,
      standInEnvironment(standIn, outLog, { OW_STAND_IN_SESSION: "stale-thread", OW_STAND_IN_SIGNED_OUT: "yes" }),
    );
    assert.ok(await waitForHealth(URL), "the server never came back");
    await say("ask with nothing to ask with");
    calls = callsIn(outLog);
  });

  it("is a failure and not a refusal, so the thread is dropped and it asks again", () => {
    const failed = calls.findIndex((call) => call.includes("--resume stale-thread"));
    assert.notEqual(failed, -1, "the run never carried the thread");
    const next = calls[failed + 1];
    assert.notEqual(next, undefined, "there was no second run, so a signed-out run was read as a refusal");
    assert.ok(!next.includes("--resume"), `asked to resume anyway: ${next}`);
  });
});

// How a refused run ends. On everything measured it ends itself, and the first block here says so:
// its input is closed exactly as it is when an answer arrives and it goes by the door it already
// has, unsignalled. The second is the shape nobody has watched — refused and then deaf to its
// input being closed — where without the grace the turn never ends, the queue behind that session
// stops, and whoever said something waits out the limit.
//
// Both are bounded by the check rather than by the code. A check about something that would
// otherwise never return has to carry its own bound, or a red suite becomes a wedged one.
describe("a refused run that goes when it is told the turn is over", () => {
  const goneLog = path.join(standIn, "refused-leaves.txt");

  before(async () => {
    await start(
      instance,
      standInEnvironment(standIn, goneLog, { OW_STAND_IN_SESSION: "leaving-thread", OW_STAND_IN_REFUSED: "yes" }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("ask while the account is out");
  });

  it("is never signalled: it left on the close of its own input", () => {
    assert.match(readLog(goneLog), /^left: /m);
  });
});

describe("a refused run that ignores its input being closed", () => {
  const deafLog = path.join(standIn, "refused-deaf.txt");
  let ended;
  let ran;

  before(async () => {
    await start(
      instance,
      standInEnvironment(standIn, deafLog, {
        OW_STAND_IN_SESSION: "deaf-thread",
        OW_STAND_IN_REFUSED: "yes",
        OW_STAND_IN_REFUSED_DEAF: "yes",
      }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");

    // The bound is here and not in the toolkit. Fifteen seconds is far longer than the grace plus
    // the patience that follows it, and short enough that a suite says so rather than hanging.
    ended = await Promise.race([
      say("ask while the account is out").then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
    ]);
    ran = pidsIn(deafLog).at(-1);

    // Whatever the check finds, nothing is left running behind it.
    if (typeof ran === "number" && alive(ran)) {
      try {
        process.kill(ran, "SIGKILL");
      } catch {}
    }
  });

  it("ends the turn rather than waiting on a run that will not end itself", () => {
    assert.equal(ended, true, "the turn never came back");
  });

  it("makes the run go, since closing its input did not", () => {
    assert.equal(typeof ran, "number", "the run never said which process it was");
    assert.equal(alive(ran), false, "it is still running");
  });

  it("did not leave on its own, which is what makes the ending the thing that ended it", () => {
    assert.doesNotMatch(readLog(deafLog), /^left: /m);
  });
});

// Slice 3: what the chat SAYS about a run the service turned away.
//
// Slice 2 stopped a refusal costing the conversation; none of it was visible to anybody. The panel
// still showed the service's own sentence under the session's name, which is the original complaint
// in full: a worker credited with saying something it never said, about a limit it has nothing to
// do with. So the record is written by the chat, in the chat's voice, from the fields the frame
// carried and never from the prose.
//
// Everything about the panel here is read out of the TRANSCRIPT rather than out of what the route
// handed back. A check reading the route's own return value would pass with nothing written down at
// all, which is the check this repo has already paid for twice.
describe("a message the service turned away", () => {
  const awayLog = path.join(standIn, "turned-away.txt");
  let answered;
  let panel;

  before(async () => {
    await start(
      instance,
      standInEnvironment(standIn, awayLog, { OW_STAND_IN_SESSION: "away-thread", OW_STAND_IN_REFUSED: "yes" }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");
    // Where this exchange starts. The panel is the whole of what this suite has said to this
    // session, and a check reading all of it would be reading somebody else block.
    const before = JSON.parse((await transcriptOf(WORKER)).body).messages.length;
    answered = await say("a message that will not get through", WORKER);
    panel = JSON.parse((await transcriptOf(WORKER)).body).messages.slice(before);
  });

  it("writes the refusal on the panel, flagged rather than left to be read out of the words", () => {
    assert.equal(panel.at(-1)?.refused, true, `the last line was ${JSON.stringify(panel.at(-1))}`);
  });

  it("puts it under the chat, since nobody said it to anybody", () => {
    assert.equal(panel.at(-1)?.from, "the chat");
  });

  it("writes the question down first, so the record reads in the order it happened", () => {
    assert.equal(panel.at(-2)?.text, "a message that will not get through");
    assert.equal(panel.at(-2)?.from, "human");
  });

  it("never puts the service's own sentence on the panel", () => {
    const prose = panel.filter((message) => (message.text ?? "").includes("session limit"));
    assert.deepEqual(prose, [], "the service's prose reached the panel");
  });

  it("credits the session with nothing, since it never said anything", () => {
    assert.deepEqual(
      panel.filter((message) => message.from === WORKER),
      [],
      "something was written under the session's name",
    );
  });

  it("says when the limit lifts, in the reading of whoever is looking at the panel", () => {
    // The stand-in refuses with a reset three hours out and puts a DIFFERENT hour in its prose, so
    // a sentence built by reading the message rather than the field says the wrong one and is
    // caught saying it.
    const lifts = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const hour = `${String(lifts.getHours()).padStart(2, "0")}:`;
    assert.ok(panel.at(-1).text.includes(hour), `the line said ${JSON.stringify(panel.at(-1).text)}`);
    assert.ok(!panel.at(-1).text.includes("9am"), "it read the hour out of the service's prose");
  });

  it("names the kind of limit the service named, and no friendlier word of ours", () => {
    assert.match(panel.at(-1).text, /five-hour limit/);
  });

  it("tells whoever asked, rather than handing back a reply that is not one", () => {
    assert.equal(answered.status, 503);
    const body = JSON.parse(answered.body);
    assert.equal(body.refused, true);
    assert.match(body.error, /turned the run away/);
  });
});

// The same, with nothing said about when it lifts. A refusal that names no time is still a refusal
// and is still written down; the sentence simply says less.
describe("a message turned away without a time", () => {
  const timelessLog = path.join(standIn, "away-timeless.txt");
  let panel;

  before(async () => {
    await start(
      instance,
      standInEnvironment(standIn, timelessLog, {
        OW_STAND_IN_SESSION: "timeless-away",
        OW_STAND_IN_REFUSED: "yes",
        OW_STAND_IN_NO_RESET: "yes",
        // Under the other window, because the panel check below is the only reader of the kind in
        // prose and every fixture reaching it named the five-hour one: a sentence with that window
        // written into it passed, whatever the frame said.
        OW_STAND_IN_LIMIT_KIND: "seven_day",
      }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");
    const before = JSON.parse((await transcriptOf(WORKER)).body).messages.length;
    await say("another that will not get through", WORKER);
    panel = JSON.parse((await transcriptOf(WORKER)).body).messages.slice(before);
  });

  it("still says it was turned away", () => {
    assert.equal(panel.at(-1)?.refused, true);
    assert.match(panel.at(-1).text, /turned the run away/);
  });

  it("says nothing about a time it was not given", () => {
    assert.ok(!panel.at(-1).text.includes("lifts at"), `the line said ${JSON.stringify(panel.at(-1).text)}`);
  });

  it("names the window this one was refused under, which is not the other one's", () => {
    assert.match(panel.at(-1).text, /seven-day limit/);
  });
});

// A session that said something to another session. It never reads that session's panel, so the
// panel line is no use to it at all — and it is the reader most in need of knowing, because a lead
// that takes a refusal for an answer acts on a sentence its worker never wrote.
describe("a session told that what it said did not get through", () => {
  const toldLog = path.join(standIn, "away-tool.txt");
  let answered;

  before(async () => {
    await start(
      instance,
      standInEnvironment(standIn, toldLog, { OW_STAND_IN_SESSION: "tool-away", OW_STAND_IN_REFUSED: "yes" }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");
    const said = await post(`${URL}/mcp/${LEADER}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "say", arguments: { to: WORKER, message: "did this reach you" } },
    });
    answered = JSON.parse(said.body);
  });

  it("answers it as something that did not happen, and not as a reply", () => {
    assert.equal(answered.result?.isError, true, `the tool answered ${JSON.stringify(answered.result)}`);
  });

  it("says so in words, since what reads this is a model and not a branch", () => {
    assert.match(answered.result?.content?.[0]?.text ?? "", /turned the run away/);
  });
});

// The other half of the pair. A row that is written whether or not anything was refused says
// nothing, and a check that only looks for the row firing cannot tell the difference.
describe("a message that got through", () => {
  const throughLog = path.join(standIn, "away-not.txt");
  let panel;

  before(async () => {
    await start(instance, standInEnvironment(standIn, throughLog, { OW_STAND_IN_SESSION: "ordinary-thread" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    const before = JSON.parse((await transcriptOf(WORKER)).body).messages.length;
    await say("a message that gets through", WORKER);
    panel = JSON.parse((await transcriptOf(WORKER)).body).messages.slice(before);
  });

  it("has nothing said on its panel about anything being turned away", () => {
    assert.deepEqual(
      panel.filter((message) => message.refused === true),
      [],
    );
  });

  it("still answers under the session's own name", () => {
    assert.equal(panel.at(-1)?.from, WORKER);
  });
});

// Two messages, the second sent while the first is still being refused. The queue drains: each is
// attempted on its own and each sender is told about its own message. Holding the second would need
// a clock or a gate on the delivery path, which is the parked queue this feature exists to end.
describe("a message sent while another is being turned away", () => {
  const bothLog = path.join(standIn, "away-both.txt");
  let answered;
  let panel;

  before(async () => {
    await start(
      instance,
      standInEnvironment(standIn, bothLog, { OW_STAND_IN_SESSION: "both-away", OW_STAND_IN_REFUSED: "yes" }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");

    const before = JSON.parse((await transcriptOf(WORKER)).body).messages.length;
    const first = say("the first one", WORKER);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = say("and the second", WORKER);
    answered = await Promise.all([first, second]);
    panel = JSON.parse((await transcriptOf(WORKER)).body).messages.slice(before);
  });

  it("attempts the second rather than holding it behind the first", () => {
    assert.ok(
      callsIn(bothLog).length >= 2,
      `the second message was never run: ${callsIn(bothLog).length} run(s)`,
    );
  });

  it("tells each sender about its own message", () => {
    assert.deepEqual(
      answered.map((exchange) => exchange.status),
      [503, 503],
    );
  });

  it("writes each question down, and a refusal of its own under each", () => {
    const asked = panel.filter((message) => message.from === "human").map((message) => message.text);
    assert.deepEqual(asked, ["the first one", "and the second"]);
    assert.equal(panel.filter((message) => message.refused === true).length, 2);
  });
});

// Slice 3.5: the two routes that end something.
//
// A handover ends a thread and a leave files a desk away, and both do it on the strength of a run
// that has just been asked to write down where the work stands. When the service turns that run
// away, the writing never happened — and until this slice the ending happened anyway. That is the
// one place this toolkit was worse than the office it is modelled on under the same trigger: there,
// a refused handover cost a frozen button and no data; here it cost the conversation, on the very
// turn whose replacement was never written.
//
// So both routes ask the same question and give the same answer: refused means nothing happened.
const REFUSED_HAND = "Sable";
const FAILED_HAND = "Otto";
const REFUSED_LEAVE = "Perry";

describe("a handover the service turned away", () => {
  const handLog = path.join(standIn, "handover-refused.txt");
  let posted;
  let thread;
  let rows;
  let afterwards;

  before(async () => {
    runTool(instance, ["hire", REFUSED_HAND], process.env);
    await start(
      instance,
      standInEnvironment(standIn, handLog, { OW_STAND_IN_SESSION: "hand-thread" }),
    );
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A thread to lose. Without a message first there is nothing here a handover could cost.
    await say("something worth remembering", REFUSED_HAND);

    await start(
      instance,
      standInEnvironment(standIn, handLog, { OW_STAND_IN_SESSION: "hand-thread", OW_STAND_IN_REFUSED: "yes" }),
    );
    assert.ok(await waitForHealth(URL), "the server never came back");

    const before = JSON.parse((await transcriptOf(REFUSED_HAND)).body).messages.length;
    posted = await post(`${URL}/sessions/${REFUSED_HAND}/handover`, {});

    // Read before anything else runs: the next message would start a thread of its own and put the
    // file back, which would make a check that ran afterwards pass whatever had happened here.
    thread = fs.existsSync(path.join(instance, "chat", REFUSED_HAND, "session.json"));
    rows = JSON.parse((await transcriptOf(REFUSED_HAND)).body).messages.slice(before);

    await start(
      instance,
      standInEnvironment(standIn, handLog, { OW_STAND_IN_SESSION: "hand-thread" }),
    );
    assert.ok(await waitForHealth(URL), "the server never came back a second time");
    afterwards = await say("and are you still the same conversation", REFUSED_HAND);
  });

  it("keeps the thread it was about to end", () => {
    assert.equal(thread, true, "the conversation was thrown away for a limit that clears by itself");
  });

  it("carries on that same thread on the next message, so it was kept usable and not merely kept", () => {
    assert.equal(afterwards.status, 200);
    assert.ok(
      callsIn(handLog).at(-1).includes("--resume hand-thread"),
      `the next run was called ${callsIn(handLog).at(-1)}`,
    );
  });

  it("says on the panel that it was turned away, flagged", () => {
    assert.equal(rows.at(-1)?.refused, true, `the last row was ${JSON.stringify(rows.at(-1))}`);
    assert.equal(rows.at(-1)?.from, "the chat");
    assert.match(rows.at(-1).text, /turned the run away/);
  });

  it("does not tell the person the thread is gone, because it is not", () => {
    assert.ok(!rows.at(-1).text.includes("thread is gone"), `the line said ${JSON.stringify(rows.at(-1).text)}`);
    assert.deepEqual(
      rows.filter((row) => (row.text ?? "").includes("handed over")),
      [],
      "it said the handover happened",
    );
  });

  it("says when the limit lifts, so the person knows when to press it again", () => {
    const lifts = new Date(Date.now() + 3 * 60 * 60 * 1000);
    assert.ok(rows.at(-1).text.includes(`${String(lifts.getHours()).padStart(2, "0")}:`));
  });

  it("credits the session with nothing, since it never answered", () => {
    assert.deepEqual(rows.filter((row) => row.from === REFUSED_HAND), []);
  });

  it("tells whoever pressed the button, rather than reporting a handover that did not happen", () => {
    assert.equal(posted.status, 503);
    assert.equal(JSON.parse(posted.body).refused, true);
  });
});

// The other half of the pair. A handover whose run failed for any ordinary reason still ends the
// thread, exactly as it did before this slice: the thread is what could not be used, and there is
// nothing to keep. Only a refusal is different, and a guard that fired on `failed` instead would
// quietly stop every handover from ever ending anything.
describe("a handover that failed for an ordinary reason", () => {
  const failedLog = path.join(standIn, "handover-failed.txt");
  let thread;
  let rows;

  before(async () => {
    runTool(instance, ["hire", FAILED_HAND], process.env);
    await start(instance, standInEnvironment(standIn, failedLog, { OW_STAND_IN_SESSION: "failing-thread" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("something worth remembering", FAILED_HAND);

    await start(instance, standInEnvironment(standIn, failedLog, { OW_STAND_IN_BROKEN: "yes" }));
    assert.ok(await waitForHealth(URL), "the server never came back");

    const before = JSON.parse((await transcriptOf(FAILED_HAND)).body).messages.length;
    await post(`${URL}/sessions/${FAILED_HAND}/handover`, {});
    thread = fs.existsSync(path.join(instance, "chat", FAILED_HAND, "session.json"));
    rows = JSON.parse((await transcriptOf(FAILED_HAND)).body).messages.slice(before);
  });

  it("still ends the thread", () => {
    assert.equal(thread, false, "the handover kept a thread it was asked to end");
  });

  it("still says the thread is gone, which is true here", () => {
    assert.ok(
      rows.some((row) => (row.text ?? "").includes("thread is gone")),
      `the rows said ${JSON.stringify(rows.map((row) => row.text))}`,
    );
  });

  it("is not called a refusal", () => {
    assert.deepEqual(rows.filter((row) => row.refused === true), []);
  });
});

// A leave, where what is at stake is the desk itself. The guard sits higher up this route than on a
// handover and for a reason worth writing down: the function that works out where a desk would be
// filed also MAKES the directory. A refused leave that got as far as asking would leave an empty
// archive behind for somebody still sitting at their desk.
describe("a leave the service turned away", () => {
  const leaveLog = path.join(standIn, "leave-refused.txt");
  let posted;
  let desk;
  let archives;
  let rows;

  before(async () => {
    runTool(instance, ["hire", REFUSED_LEAVE], process.env);
    await start(instance, standInEnvironment(standIn, leaveLog, { OW_STAND_IN_SESSION: "leave-thread" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await say("something worth remembering", REFUSED_LEAVE);

    const before = JSON.parse((await transcriptOf(REFUSED_LEAVE)).body).messages.length;
    // Where a desk really is filed. Written wrong the first time — work/archive, which does not
    // exist — so the check read an empty listing both times and could not fail. The mutation that
    // files a desk early said nothing about it, which is how it was caught.
    const filed = path.join(instance, "archive");
    const had = fs.existsSync(filed) ? fs.readdirSync(filed) : [];

    await start(
      instance,
      standInEnvironment(standIn, leaveLog, { OW_STAND_IN_SESSION: "leave-thread", OW_STAND_IN_REFUSED: "yes" }),
    );
    assert.ok(await waitForHealth(URL), "the server never came back");

    posted = await post(`${URL}/sessions/${REFUSED_LEAVE}/leave`, {});
    desk = fs.existsSync(path.join(instance, "work", REFUSED_LEAVE, "STATE.md"));
    archives = (fs.existsSync(filed) ? fs.readdirSync(filed) : []).filter((one) => !had.includes(one));
    rows = JSON.parse((await transcriptOf(REFUSED_LEAVE)).body).messages.slice(before);
  });

  it("leaves the desk where it was", () => {
    assert.equal(desk, true, "the desk was filed away for a limit that clears by itself");
  });

  it("files nothing, not even the empty directory it would have filed it into", () => {
    assert.deepEqual(archives, [], "an archive was made for a session that never left");
  });

  it("keeps the name taken, since nobody left", async () => {
    assert.equal((await get(`${URL}/sessions/${REFUSED_LEAVE}/messages`)).status, 200);
  });

  it("says on the panel that it was turned away, flagged", () => {
    assert.equal(rows.at(-1)?.refused, true, `the last row was ${JSON.stringify(rows.at(-1))}`);
    assert.equal(rows.at(-1)?.from, "the chat");
    assert.match(rows.at(-1).text, /turned the run away/);
  });

  it("does not say the desk was filed, because it was not", () => {
    assert.ok(!rows.at(-1).text.includes("filed under"), `the line said ${JSON.stringify(rows.at(-1).text)}`);
  });

  it("tells whoever pressed the button", () => {
    assert.equal(posted.status, 503);
    assert.equal(JSON.parse(posted.body).refused, true);
  });
});

// Holding a panel while somebody is writing on it. The whole of it is in the READ: a page says how
// much it has drawn and whether there is text in its box, and the answer is cut to that. Nothing is
// queued on the way in, nothing is remembered between requests, and no clock runs anywhere — so
// most of what these checks are about is what does NOT happen elsewhere while a panel holds.
describe("what a panel answers while somebody is writing on it", () => {
  const LANDED = "something that landed while a sentence was half written";

  let drawn;
  let holding;
  let released;
  let whole;
  let beyond;
  let writingFirst;
  let backwards;
  let spokenTo;
  let onDisk;
  let room;
  let roomPlain;

  before(async () => {
    await start(instance, standIns);
    assert.ok(await waitForHealth(URL), "the server never answered");

    // What the page has drawn. Everything below is answered against this one number.
    drawn = JSON.parse((await transcriptOf(WORKER)).body).messages.length;

    // Two rows land: what was said, and the answer to it. Neither was caused by the page, which is
    // the only kind of row this feature is about.
    await say(LANDED, WORKER);

    // Both states are reachable without racing anything: the rows are already on disk, and which
    // of them comes back is decided by what the request says, not by when it is made. The released
    // one is fetched second on purpose — if anything were being remembered, this order would be
    // the order that broke it.
    holding = JSON.parse((await get(`${URL}/sessions/${WORKER}/messages?shown=${drawn}&writing=1`)).body);
    released = JSON.parse((await get(`${URL}/sessions/${WORKER}/messages?shown=${drawn}`)).body);
    whole = JSON.parse((await transcriptOf(WORKER)).body);
    beyond = await get(`${URL}/sessions/${WORKER}/messages?shown=99999&writing=1`);
    writingFirst = JSON.parse((await get(`${URL}/sessions/${WORKER}/messages?writing=1`)).body);
    // Minus ONE and not some larger negative: slicing a short list at a big negative is the empty
    // list either way, so a bigger number would make this check agree with the bug it is here to
    // catch. Watched: at minus five it noticed nothing.
    backwards = JSON.parse((await get(`${URL}/sessions/${WORKER}/messages?shown=-1&writing=1`)).body);

    // Read here and not at the end of this block: the panel is append-only, so a row added by
    // anything below would be on disk and not in what was fetched above, and the check comparing
    // them would be reading two different moments.
    onDisk = JSON.parse(fs.readFileSync(path.join(instance, "chat", WORKER, "conversation.json"), "utf8"));

    // Said to the panel that is being held, because that is where a hold on the delivery path
    // would bite: this call would be the one waiting on somebody's keyboard.
    spokenTo = await say("and this is asked while that page is holding", WORKER);

    // Both ways round, and compared with each other rather than with a list written here. Who works
    // in this instance depends on what ran before this describe, and a check that named names would
    // be about that instead of about the room.
    room = JSON.parse((await get(`${URL}/sessions?shown=0&writing=1`)).body);
    roomPlain = JSON.parse((await get(`${URL}/sessions`)).body);
  });

  it("does not answer with a row that landed after the page last drew, while somebody is writing", () => {
    assert.equal(holding.messages.length, drawn);
  });

  // The pair. Each of these fails if the other's behaviour is applied to it, and one check saying
  // "holding works" would pass with the two of them conflated.
  it("answers with that same row as soon as there is nothing in the box", () => {
    assert.ok(released.messages.some((message) => message.text?.includes(LANDED)));
  });

  it("says how many rows it is holding back", () => {
    assert.equal(holding.held, released.messages.length - drawn);
  });

  // Who is calling, never what they said. The count alone cannot be judged, so it would be looked
  // at every time, which is a hold nobody uses.
  it("says who the held rows are from", () => {
    assert.deepEqual(holding.from, [...new Set(released.messages.slice(drawn).map((message) => message.from))]);
  });

  it("holds nothing back when there is nothing in the box", () => {
    assert.equal(released.held, 0);
  });

  // The feature is a view of the panel and not a queue in front of it. If the held rows were being
  // written anywhere but into the panel, in order, at the moment they happened, this is the check
  // that would say so.
  it("writes every row into the panel, in order, whether or not a page was holding", () => {
    assert.deepEqual(
      onDisk.map((message) => [message.from, message.text]),
      released.messages.map((message) => [message.from, message.text]),
    );
  });

  // What `ow` at a terminal gets, and anything else that asks for a transcript without knowing
  // this feature exists.
  it("answers a reader that says neither with the whole panel", () => {
    assert.deepEqual([whole.messages.length, whole.held], [released.messages.length, 0]);
  });

  // The number came off a page and names a position in a file the page cannot see. Out of range it
  // is a reader that has fallen behind or run ahead, and neither is worth refusing a transcript
  // over.
  // A page that has text in its box before it has drawn anything — the first tick after a reload
  // onto a restored draft. It has fallen behind nothing, so there is nothing to keep from it.
  it("holds nothing from a page that is writing but has not drawn anything yet", () => {
    assert.deepEqual([writingFirst.messages.length, writingFirst.held], [released.messages.length, 0]);
  });

  // Below zero would cut rows off the END of the panel and call them held: the reader would be
  // shown all but the last few and told those few were waiting, which is not a hold, it is a lie
  // about where it is.
  it("holds nothing extra from a reader whose position is below the start of the panel", () => {
    assert.deepEqual([backwards.messages.length, backwards.held], [0, released.messages.length]);
  });

  it("answers a reader that has run past the end of the panel, rather than refusing it", () => {
    assert.deepEqual([beyond.status, JSON.parse(beyond.body).held], [200, 0]);
  });

  // The seam is the read and never the write, so nothing on the delivery path learned about any of
  // this. A hold put there instead would make one person's typing a state another session is stuck
  // behind, which is the failure the delivery path exists to forbid.
  it("still answers somebody speaking to that session while a page is holding its panel", () => {
    assert.equal(spokenTo.status, 200);
  });

  // Never held: a room is how somebody sees that a session needs them. Holding it would hide the
  // one thing on the page that says a run has stopped and is waiting.
  it("answers the room in full, whatever a panel was asked", () => {
    assert.deepEqual(
      room.sessions.map((session) => session.name),
      roomPlain.sessions.map((session) => session.name),
    );
    assert.ok(room.sessions.length > 0, "the room was empty both ways, so this proved nothing");
  });
});

// The other thing that is never held, and it is the one that matters most: a run asking to be
// allowed something has STOPPED until a person answers it. Holding that would make somebody's
// half-written sentence the reason a session cannot be reached.
describe("what is never held back from a panel", () => {
  const askedLog = path.join(standIn, "asking-while-writing.txt");

  let parked;

  before(async () => {
    await start(instance, standInEnvironment(standIn, askedLog, { OW_STAND_IN_ASKS: "Bash" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // Not waited for: it does not come back until the whole exchange is over, and the asking is
    // the middle of it.
    const asked = say("do something that needs asking", WORKER);

    parked = await waitFor(async () => {
      const { permissions } = JSON.parse(
        (await get(`${URL}/sessions/${WORKER}/permissions?shown=0&writing=1`)).body,
      );
      return permissions.length > 0 ? permissions : null;
    });

    // Answered, because nothing on this path times out on either side. A request left parked is a
    // run left stopped and a message that never comes back, which is a hang in this suite and a
    // hang for a person.
    await post(`${URL}/sessions/${WORKER}/permission`, { id: parked[0].id, decision: "deny" });
    await asked;
  });

  it("shows a session waiting to be allowed something, whatever the page said it was doing", () => {
    assert.equal(parked.length, 1);
  });
});

// And what the page does with the same thing, read as text for the reason the room describe says:
// a listener built and never attached is invisible to a check like this. What a held page LOOKS
// like to the person doing the writing is a person's reading, and only the manual test gives it.
describe("what the page does while somebody is writing on it", () => {
  let page;

  before(async () => {
    page = (await get(`${URL}/`)).body;
  });

  // Both facts, because either alone is useless: how much has been drawn without whether the box
  // has anything in it holds every reader, and the other way round holds nothing.
  // Read between building the query and reading the answer, so that the fetch itself is inside
  // what is checked. Asserting that the page BUILDS a query passes on a query it never sends —
  // built and never attached, which is the shape this repo has paid for before. Watched: the
  // mutation that dropped the query from the fetch noticed nothing until this was bounded.
  it("asks with what it has drawn and with whether there is anything in the box", () => {
    const asked = page.slice(
      page.indexOf("const query = new URLSearchParams"),
      page.indexOf("const { messages, held, from }"),
    );
    assert.deepEqual(
      [
        asked.includes("shown: String(Math.max(shown, 0))"),
        asked.includes(`query.set("writing", "1")`),
        asked.includes("messages?${query}"),
      ],
      [true, true, true],
    );
  });

  // Always there, empty when nothing is held. A line that appears would move the box out from
  // under a cursor that is half way through a sentence, which is the thing this whole feature is
  // for.
  it("keeps the line that says who is waiting in the document, held or not", () => {
    assert.ok(page.includes("section.append(heading, transcript, asking, waitingLine, composer);"));
  });

  it("says how many are waiting and who from", () => {
    assert.ok(page.includes("`${held} waiting \u2014 ${from.map(nameOf).join(\", \")} `"));
  });

  // The order is the check. While a panel holds, its row count is unchanged by definition, so a
  // count drawn after the redraw guard is a count that is never drawn — and the hold would read as
  // a page that had stopped working.
  it("says who is waiting before it decides whether the transcript needs redrawing", () => {
    const counted = page.indexOf("whoIsWaiting.textContent =");
    const guard = page.indexOf("if (messages.length === shown)");
    assert.ok(counted > 0 && counted < guard, "the count is drawn after the guard, so never");
  });

  // Read inside the submit handler and not across the file, for the reason the draw-after-send
  // check is bounded there: another fetch on the page carries the same shape.
  it("says what it had drawn when it sends, so the row can record which line it answers", () => {
    assert.ok(theSend(page).includes("JSON.stringify({ text, shown })"));
  });

  // Measured on the live page before this: with the button out of the document the line was
  // zero-height, its margins collapsed, and the first held row pushed the composer down 37 px under
  // a moving cursor. Always IN the document was never the requirement; always occupying its space
  // is.
  it("keeps the space the waiting line takes, held or not", () => {
    assert.deepEqual(
      [page.includes("showThem.style.visibility"), page.includes("showThem.hidden")],
      [true, false],
    );
  });

  // The other 34 px, and a fix for the line alone leaves it: the panels sit in one flow, so a row
  // landing on the panel ABOVE moved the box too — and holding does nothing about that, because
  // nobody is writing in the other panel.
  it("gives a panel a height that does not depend on what is in it", () => {
    assert.deepEqual(
      [page.includes('transcript.style.height = "18em"'), page.includes('transcript.style.overflowY = "auto"')],
      [true, true],
    );
  });

  // Which a scrolling transcript now has to decide. Being dragged back down to the newest line is
  // the same interruption as the box moving.
  it("leaves a transcript where the reader left it, unless they were at the newest line", () => {
    const decided = page.indexOf("const atTheNewest = shown === -1 ||");
    const acted = page.indexOf("transcript.scrollTop = transcript.scrollHeight;");
    assert.ok(decided > 0 && acted > decided, "the panel never decides where to leave the transcript");
  });

  // Pete watched slice 4 in a real browser and read the breaking row back: it is drawn in the same
  // weight and colour as the rows held behind it, and arrives in the same tick. The answer is not a
  // style — this page has none — it is that a line that broke in is the one redraw allowed to move
  // a reader who had scrolled up. A row drawn where nobody is looking is the one place no wording
  // could have saved it. Bound to the `if`: a brokeIn nothing acts on would pass on the value alone.
  it("drags a reader back down for a line that broke in, and for nothing else", () => {
    assert.match(
      page,
      /const brokeIn = messages\.slice\(Math\.max\(shown, 0\)\)\.some\(\(message\) => typeof message\.breaking === "string"\)/,
    );
    assert.ok(page.includes("if (atTheNewest || brokeIn) {"), "nothing acts on a line that broke in");
  });

  // One page, one name for one person. The chat records the human as `human` because it cannot
  // know what to call them until an instance is installed, and the waiting line was printing that
  // raw two inches under a transcript saying their name.
  it("calls the people in the waiting line what the transcript calls them", () => {
    assert.match(page, /\$\{from\.map\(nameOf\)\.join\(", "\)\}/);
  });

  // Pressing it must not send, must not clear the box, and must not ask for anything of its own:
  // it says "next time round, do not hold", and the tick that was already running does the rest.
  it("shows what is held without sending anything", () => {
    const from = page.indexOf('showThem.addEventListener("click"');
    const body = page.slice(from, page.indexOf("});", from));
    assert.deepEqual([body.includes("showThemAnyway = true;"), body.includes("fetch")], [true, false]);
  });
});

// What a message says it answers.
//
// A person types a reply to the last line they were shown. By the time it is delivered that panel
// may have moved on, so the message carries the position the page had drawn and the row records
// which line of that session's the sender was looking at. An index into an append-only file is the
// whole of it: no id is minted, no counter has to survive a restart, and no field is added to every
// row for the benefit of one.
//
// A fresh desk, so that the panel starts with nothing on it and "this session has said nothing yet"
// is a state these checks can reach.
const ANSWERS = "Kestrel";

describe("what a message says it answers", () => {
  const answersLog = path.join(standIn, "answers.txt");

  let onAnEmptyPanel;
  let lookingBack;
  let lookingAtTheLast;
  let sayingNothing;
  let askedLookingBack;
  let askedAtTheLast;
  let pointedAt;
  let expected;
  let lastBefore;

  function rowsOf(panel) {
    return JSON.parse(fs.readFileSync(path.join(instance, "chat", panel, "conversation.json"), "utf8"));
  }

  function lastSaidBy(rows, name) {
    return rows.map((row, at) => [row.from, at]).findLast(([from]) => from === name)?.[1] ?? null;
  }

  before(async () => {
    runTool(instance, ["hire", ANSWERS], process.env);
    await start(instance, standInEnvironment(standIn, answersLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // Nothing has been said on this panel by anybody, so there is no line of its own to point at.
    await say("the first thing anybody has said here", ANSWERS);
    onAnEmptyPanel = rowsOf(ANSWERS).at(-2);

    await say("a second thing", ANSWERS);

    // Pointed just after a line the HUMAN said, and deliberately not at the end of an exchange. At
    // the end of one, the last row and the last row this session said are the same row, so a check
    // written there passes on an implementation that never looks at who said it. Watched: with the
    // position at the end of an exchange, replacing the whole search with "the row before this one"
    // noticed nothing.
    const wasLookingAt = rowsOf(ANSWERS).length - 1;
    expected = lastSaidBy(rowsOf(ANSWERS).slice(0, wasLookingAt), ANSWERS);

    // And one more exchange after that, so the line being answered is demonstrably not the last one
    // on the panel. No slow turn is needed to reach this: the position travels with the message,
    // and the file it points into is only ever appended to, so what sits at that index cannot move.
    await say("a third thing", ANSWERS);

    await post(`${URL}/sessions/${ANSWERS}/message`, { text: "answering something older", shown: wasLookingAt });
    lookingBack = rowsOf(ANSWERS).findLast((row) => row.text === "answering something older");
    pointedAt = rowsOf(ANSWERS)[lookingBack.answers];
    askedLookingBack = questionsIn(answersLog).at(-1);

    // And the ordinary case, which is nearly every case: the sender is answering the last thing
    // that session said.
    await post(`${URL}/sessions/${ANSWERS}/message`, { text: "answering the last line", shown: rowsOf(ANSWERS).length });
    lookingAtTheLast = rowsOf(ANSWERS).findLast((row) => row.text === "answering the last line");
    askedAtTheLast = questionsIn(answersLog).at(-1);

    // What `ow` at a terminal sends, and what a page sends before it has drawn anything.
    lastBefore = lastSaidBy(rowsOf(ANSWERS), ANSWERS);
    await say("said without saying what was in front of me", ANSWERS);
    sayingNothing = rowsOf(ANSWERS).findLast((row) => row.text === "said without saying what was in front of me");
  });

  it("records the line of that session's the sender was looking at", () => {
    assert.equal(pointedAt.from, ANSWERS);
  });

  // The point of the whole slice, and the reason the position travels with the message: two more
  // things were said between what the sender was reading and what was delivered.
  // Both halves, because either alone agrees with a bug: naming the right line is nothing if it
  // happens to be the latest one anyway, and "not the latest" is satisfied by naming nothing at
  // all. Watched: with no such field written, "not the latest" passed on its own.
  it("names that line and not the latest, when the session has said more since", () => {
    assert.deepEqual(
      [lookingBack.answers, lookingBack.answers < lastSaidBy(rowsOf(ANSWERS), ANSWERS)],
      [expected, true],
    );
  });

  // The honest reading of "what was in front of them": everything there was. Not nothing — a
  // terminal and a page that has just opened are both answering the last thing that was said.
  it("takes the last line now when a message says nothing about what was in front of it", () => {
    assert.equal(sayingNothing.answers, lastBefore);
  });

  it("records nothing on a panel where that session has not said anything yet", () => {
    assert.equal("answers" in onAnEmptyPanel, false);
  });

  // Told only when it is not the obvious one. Nearly always a session is being answered on the last
  // thing it said, and a sentence in every turn forever in aid of the rare case is a trade this
  // repo has turned down before.
  it("tells the session which line, when it is not the last one it said", () => {
    assert.match(askedLookingBack, /<answering>/);
  });

  it("tells it nothing when the line is the last one it said", () => {
    assert.ok(!askedAtTheLast.includes("<answering>"));
  });

  // The words and not the number. A position is what the server holds; what locates a line for
  // somebody reading a thread is what that line said.
  it("carries the first line of the row it points at", () => {
    assert.ok(askedLookingBack.includes(`<answering>${pointedAt.text.split("\n")[0]}</answering>`));
  });
});

// The lead breaking in on somebody who is writing.
//
// The one line the lead has to the human without being asked, and it IS the exception: there is no
// ordinary version of it, on purpose, because a second quiet channel for news that can wait is a
// lead that narrates. What can wait goes in its next answer.
//
// It appends to the lead's own panel and returns at once. No turn is started, nothing is waited
// for, and nothing is deleted, archived or spawned — which is what lets it join one server under
// one permission rule.
//
// And it ENDS the hold rather than jumping it: everything that was waiting arrives with it, in the
// order the panel already has, the breaking line last.
describe("the lead breaks in on somebody who is writing", () => {
  const brokeLog = path.join(standIn, "breaking-in.txt");
  const ROUTINE = "a line that landed while a sentence was half written";
  const BREAKING = "the settings file is in the instance root, so the question you are answering is answered";
  const WHY = "it answers the very thing you are writing about";
  const ANOTHER_WHY = "and this one is stale for a reason of its own";
  const LATER = "and this one lands after the break, with nothing breaking in behind it";

  let page;
  let offeredToTheLead;
  let offeredToAWorker;
  let drawn;
  let heldBeforeTheBreak;
  let turnsBefore;
  let turnsAfter;
  let answered;
  let released;
  let onDisk;
  let heldAfterTheBreak;
  let refusedAWorker;
  let noReason;
  let spacesForAReason;
  let noMessage;
  let reasons;

  async function offeredTo(who) {
    return JSON.parse((await call(who, "tools/list")).body).result.tools.map((tool) => tool.name);
  }

  function breakIn(as, args) {
    return call(as, "tools/call", { name: "interrupt", arguments: args });
  }

  before(async () => {
    await start(instance, standInEnvironment(standIn, brokeLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    page = (await get(`${URL}/`)).body;
    offeredToTheLead = await offeredTo(LEADER);
    offeredToAWorker = await offeredTo(WORKER);

    // What the page has drawn. Everything below is answered against this one number.
    drawn = JSON.parse((await transcriptOf(LEADER)).body).messages.length;

    // Two rows land on the panel somebody is writing on, and neither of them breaks in: what was
    // said, and the answer to it.
    await say(ROUTINE, LEADER);
    heldBeforeTheBreak = JSON.parse((await get(`${URL}/sessions/${LEADER}/messages?shown=${drawn}&writing=1`)).body);

    turnsBefore = questionsIn(brokeLog).length;
    answered = answerOf(await breakIn(LEADER, { message: BREAKING, why: WHY }));

    released = JSON.parse((await get(`${URL}/sessions/${LEADER}/messages?shown=${drawn}&writing=1`)).body);

    // Read here rather than lower down: the panel is append-only, so a row landing below would be
    // on disk and not in what was fetched above, and the two would be different moments.
    onDisk = JSON.parse(fs.readFileSync(path.join(instance, "chat", LEADER, "conversation.json"), "utf8"));

    // The hold begins again from where the break left it: the page has now drawn everything, one
    // more ordinary row lands, and nothing behind it breaks in.
    await say(LATER, LEADER);

    // Counted AFTER a message that does start a turn and is waited for, and against a number rather
    // than against no change at all. A turn started by the break-in is started without being waited
    // for, so a count read the instant the call returned saw nothing either way — watched: the
    // mutation that answered it through the delivery path noticed nothing until this moved down
    // here, because the stand-in had not been asked yet.
    turnsAfter = questionsIn(brokeLog).length;

    heldAfterTheBreak = JSON.parse(
      (await get(`${URL}/sessions/${LEADER}/messages?shown=${released.messages.length}&writing=1`)).body,
    );

    refusedAWorker = answerOf(await breakIn(WORKER, { message: BREAKING, why: WHY }));
    noReason = answerOf(await breakIn(LEADER, { message: BREAKING }));
    spacesForAReason = answerOf(await breakIn(LEADER, { message: BREAKING, why: "   " }));
    noMessage = answerOf(await breakIn(LEADER, { why: WHY }));

    // A second break-in, with a reason of its own, read after everything above has been sampled.
    // One stored reason cannot tell a row that carried what was said from a row carrying a word
    // this toolkit wrote down — the mutation that hard-coded the first one left the check green.
    // A break-in starts no turn, so nothing is left running by this.
    await breakIn(LEADER, { message: BREAKING, why: ANOTHER_WHY });
    reasons = JSON.parse(fs.readFileSync(path.join(instance, "chat", LEADER, "conversation.json"), "utf8"))
      .filter((row) => typeof row.breaking === "string")
      .map((row) => row.breaking);
  });

  // On the lead's OWN panel, which is the panel the human reads. Nothing is delivered anywhere:
  // the human is not a session, and there is nobody to wait for.
  it("puts the line on the lead's own panel", () => {
    const last = onDisk[onDisk.length - 1];
    assert.deepEqual([last.from, last.text], [LEADER, BREAKING]);
  });

  // The reason is a field on the row and not a sentence folded into the words, because what it
  // makes stale is shown to the person being interrupted, beside the line rather than inside it.
  it("carries the reason on the row, each break-in its own", () => {
    assert.deepEqual(reasons.slice(-2), [WHY, ANOTHER_WHY]);
  });

  // Both halves required, so there is no way to break in without saying what it makes stale.
  it("refuses a break-in with no reason, in its own words", () => {
    assert.ok(noReason.refused);
    assert.match(noReason.text, /needs a reason/);
  });

  // Trimmed, or the requirement is a space bar.
  it("refuses a reason that is all spaces", () => {
    assert.ok(spacesForAReason.refused);
    assert.match(spacesForAReason.text, /needs a reason/);
  });

  it("refuses a break-in with nothing to say", () => {
    assert.ok(noMessage.refused);
    assert.match(noMessage.text, /needs something to say/);
  });

  // It appends and returns. A break-in that went through the delivery path would start the lead's
  // own turn, nested inside whatever it was already doing, to say something to somebody who is not
  // a session at all.
  it("starts no turn", () => {
    assert.ok(turnsBefore > 0, "nothing had started a turn before this, so the count proves nothing");
    assert.equal(turnsAfter, turnsBefore + 1, "the one turn between the two counts is the message after the break");
  });

  // In the tool's own words, before the caller waits for something that is never coming: what
  // comes back here is read by a model, and an empty result is a thing it has to guess about.
  it("tells the caller it landed and that no answer is coming back", () => {
    assert.deepEqual(
      [answered.refused, new RegExp(`Broke in on ${HUMAN}`).test(answered.text ?? ""), /nothing comes back/.test(answered.text ?? "")],
      [false, true, true],
    );
  });

  it("offers interrupt to the session that leads", () => {
    assert.ok(offeredToTheLead.includes("interrupt"));
  });

  // The check the split exists for. One that only asked whether the lead is offered it passes just
  // as happily when everybody is.
  it("offers it to nobody else", () => {
    assert.ok(!offeredToAWorker.includes("interrupt"));
  });

  // Refused in the tool's own words rather than as a tool that does not exist, because it does
  // exist. A session told there is no such thing goes looking for another way to the same place.
  it("refuses a worker that posts for it anyway", () => {
    assert.ok(refusedAWorker.refused);
    assert.match(refusedAWorker.text, new RegExp(`breaking in on ${HUMAN} is the lead's, so ask ${LEADER}`));
  });

  // The exception itself, and the pair to the check below: this one fails if the hold is applied
  // to a break-in, and that one fails if the release is applied to everything.
  it("delivers the line to a page somebody is writing on", () => {
    assert.ok(released.messages.some((message) => message.text === BREAKING));
    assert.equal(released.held, 0);
  });

  // It ends the hold, it does not jump it. Nothing is reordered and there is no second render
  // path: what arrives is the panel, and the breaking line is last because that is where it is.
  it("delivers everything that was held with it, in the panel's own order, the break last", () => {
    assert.deepEqual(
      released.messages.map((message) => [message.from, message.text]),
      onDisk.map((message) => [message.from, message.text]),
    );
    assert.equal(released.messages.at(-1).text, BREAKING);
  });

  // A thing that fires when it should not is invisible to a check that only watches it firing.
  // Without this one, releasing every row reads exactly like releasing the right ones.
  it("still holds a row that is not a break-in", () => {
    assert.ok(heldBeforeTheBreak.held > 0, "nothing was behind the page, so this proved nothing");
    assert.equal(heldBeforeTheBreak.messages.length, drawn);
  });

  // Nothing was remembered about the release, so there is nothing to reset. The next row is held
  // like any other.
  it("holds again from where the break released it", () => {
    assert.ok(heldAfterTheBreak.held > 0, "nothing landed after the break, so this proved nothing");
    assert.equal(heldAfterTheBreak.messages.length, released.messages.length);
  });

  // Read as text, for the reason every page check here is: no suite runs page.html. What a person
  // makes of the row is the manual test.
  it("shows the reason in the same row on the page", () => {
    const row = page.slice(page.indexOf("function said(message)"), page.indexOf("// The room: one line per session"));
    assert.ok(row.includes("message.breaking"), "the page draws the row without the reason on it");
  });

  // The list a session reads before it decides what it can do here, and the one place a person
  // reading the repo is told what the fourth tool is.
  it("says in the README what the fourth tool is", () => {
    const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
    assert.match(readme, /Four of them/);
    assert.match(readme, /`interrupt`/);
  });
});

// Feature 13, slice 1: the room has a switch, and nothing reads it yet.
//
// A room that is off is one that will start nothing — and the whole reason it is a boolean set by a
// press, rather than the end of a handshake, is that a handshake can be turned away half way and
// leave the room neither on nor off. So the switch comes first and alone: it is proved that it can
// be thrown, that it says which way it is thrown, and above all that throwing it back is taken in
// every state there is. The gate that reads it is the next slice, and these checks are written so
// that they would still be true after it.
//
// The mid-turn case is here rather than with the gate on purpose. "It gates NEW turns only" is a
// claim about a turn that is already going, and the cheapest place to hold it is the switch itself:
// if throwing it ever touched a run, this is where it would show.
const OFF_MID_TURN = "Redshank";

describe("the room can be taken off and brought back", () => {
  const offLog = path.join(standIn, "offline-switch.txt");
  let atFirst;
  let tookOff;
  let afterOff;
  let tookOffTwice;
  let broughtBack;
  let afterOn;
  let broughtBackTwice;
  let wasAnswering;
  let tookOffMidTurn;
  let broughtBackMidTurn;
  let midTurn;
  let rows;

  before(async () => {
    runTool(instance, ["hire", OFF_MID_TURN], process.env);
    // Slow enough that a press can land while a run is genuinely going, which is the one state
    // worth asking about and the one a fast stand-in never stays in long enough to be asked in.
    await start(instance, standInEnvironment(standIn, offLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    atFirst = JSON.parse((await get(`${URL}/sessions`)).body).offline;

    tookOff = await post(`${URL}/offline`, {});
    afterOff = JSON.parse((await get(`${URL}/sessions`)).body).offline;
    tookOffTwice = await post(`${URL}/offline`, {});

    broughtBack = await post(`${URL}/online`, {});
    afterOn = JSON.parse((await get(`${URL}/sessions`)).body).offline;
    broughtBackTwice = await post(`${URL}/online`, {});

    // A turn that is already going, and the press thrown across it in both directions.
    const going = say("something that takes a while", OFF_MID_TURN);
    wasAnswering = await waitFor(async () => {
      const row = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find(
        (session) => session.name === OFF_MID_TURN,
      );
      return row?.busy === true ? row : null;
    });
    tookOffMidTurn = await post(`${URL}/offline`, {});
    broughtBackMidTurn = await post(`${URL}/online`, {});
    midTurn = await going;
    rows = JSON.parse((await get(`${URL}/sessions`)).body).sessions;
  });

  // The positive half, said first. A check that only asserted the room can be taken off would pass
  // on a chat that reported itself off from the moment it started.
  it("says it is on before anybody has touched it", () => {
    assert.equal(atFirst, false);
  });

  it("says it is off once it is taken off", () => {
    assert.equal(tookOff.status, 200);
    assert.equal(JSON.parse(tookOff.body).offline, true);
    assert.equal(afterOff, true);
  });

  it("says it is on again once it is brought back", () => {
    assert.equal(broughtBack.status, 200);
    assert.equal(JSON.parse(broughtBack.body).offline, false);
    assert.equal(afterOn, false);
  });

  // The exit, and the reason it is asserted as a status rather than as an effect: a press that can
  // be refused in some state is a state the room cannot come back from, and that is the whole shape
  // of the failure this feature was paid for.
  it("takes either press in the state it is already in", () => {
    assert.equal(tookOffTwice.status, 200);
    assert.equal(broughtBackTwice.status, 200);
  });

  it("takes either press while a session is mid-turn", () => {
    assert.ok(wasAnswering !== null, "no turn was ever going, so this proved nothing");
    assert.equal(tookOffMidTurn.status, 200);
    assert.equal(broughtBackMidTurn.status, 200);
  });

  // It gates NEW turns only. The press landed across a run that was already going, and the run
  // finished and ANSWERED as if nothing had happened — which it should, because nothing did.
  //
  // The answer's own words, not its status and not who it is from. Measured: a version of this
  // check that read the status and the name reported NOTHING NOTICED against a press that ended
  // every run on the way past, because a run somebody kills still writes a row under the session's
  // name and the route still answers 200 — it just says "Claude Code ended without answering"
  // instead of what the session said. The wrong code reached the right shape.
  it("leaves the turn that was already going to finish", () => {
    assert.equal(midTurn.status, 200);
    const reply = JSON.parse(midTurn.body).reply;
    assert.equal(reply.from, OFF_MID_TURN);
    assert.notEqual(reply.failed, true, `the run did not answer: ${JSON.stringify(reply.text)}`);
    assert.equal(reply.text, "a reply");
  });

  // On the room and not on anybody. Whether the room will start anything is one fact about the
  // room; a copy of it per row is N places to disagree, and it would also read as a state a session
  // is in, which is the one thing this feature is not.
  it("says it on the room and never on a row", () => {
    assert.ok(rows.length > 0, "there were no rows, so this proved nothing");
    assert.deepEqual(rows.filter((row) => "offline" in row), []);
  });
});

// Feature 13, slice 2: the gate, which is the whole feature.
//
// One describe and one offline room, with every way in tried against it. Four ways rather than four
// describes, because they are not four properties: they are one gate, sitting where all of them pass
// through, and a scenario per way in would be four fixtures proving the same edit. What differs
// between them is only what each one would have COST — a message costs a run, a handover was about
// to end a conversation, a leave was about to file a desk away — and that is what the separate
// checks below are for.
//
// The lever is the stand-in's own call log. A gate that did not gate shows up as a call, and no
// amount of the right sentence on a panel can hide one. Every count is asserted against a reading
// taken while the room was still on, never against zero: two zeros compare equal, and a fixture that
// never ran anything would agree with a gate that let everything through.
const GATED = "Whimbrel";
const GATED_LEAVE = "Turnstone";

describe("nothing is run for anybody while the room is off", () => {
  const gateLog = path.join(standIn, "offline-gate.txt");
  let ranWhileOn;
  let ranWhileOff;
  let sentAMessage;
  let calledTheTool;
  let handedOver;
  let letGo;
  let threadKept;
  let deskKept;
  let archives;
  let gatedRowsAtOnce;
  let gatedRows;
  let leaveRows;
  let ranAfterwards;
  let backAgain;

  // Read defensively. A gate that let everything through files the desk away and takes the panel
  // with it, and a read that threw would take the whole `before` down — leaving every check below
  // unrun and the failure reported against the describe instead of against the one check that
  // knows what went wrong. Measured: without this, three of the mutations here said only that the
  // fixture had fallen over.
  function panelRows(answered) {
    if (answered.status !== 200) {
      return [];
    }
    return JSON.parse(answered.body).messages;
  }

  before(async () => {
    runTool(instance, ["hire", GATED], process.env);
    runTool(instance, ["hire", GATED_LEAVE], process.env);
    await start(instance, standInEnvironment(standIn, gateLog, { OW_STAND_IN_SESSION: "gate-thread" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // While the room is on: a thread for the handover to have something to end, a desk for the leave
    // to have something to file, and a call count that is not zero.
    await say("something worth remembering", GATED);
    await say("and something here too", GATED_LEAVE);
    ranWhileOn = callsIn(gateLog).length;

    const gatedBefore = panelRows(await transcriptOf(GATED)).length;
    const leaveBefore = panelRows(await transcriptOf(GATED_LEAVE)).length;
    // Where a desk really is filed. Read before and after, so an archive made for somebody who never
    // left is the difference rather than an absence.
    const filed = path.join(instance, "archive");
    const had = fs.existsSync(filed) ? fs.readdirSync(filed) : [];

    await post(`${URL}/offline`, {});

    sentAMessage = await say("this should reach nobody", GATED);
    // Read HERE, before anything else writes to this panel. The handover below leaves a line of its
    // own that is flagged the same way, and a check reading "the first flagged row" after both would
    // pass on the wrong one — measured: taking the message's line out entirely reported NOTHING
    // NOTICED, because the handover's line stood in for it.
    gatedRowsAtOnce = panelRows(await transcriptOf(GATED)).slice(gatedBefore);
    calledTheTool = answerOf(
      await call(LEADER, "tools/call", { name: "say", arguments: { to: GATED, message: "nor should this" } }),
    );
    handedOver = await post(`${URL}/sessions/${GATED}/handover`, {});
    letGo = await post(`${URL}/sessions/${GATED_LEAVE}/leave`, {});

    ranWhileOff = callsIn(gateLog).length;
    threadKept = fs.existsSync(path.join(instance, "chat", GATED, "session.json"));
    deskKept = fs.existsSync(path.join(instance, "work", GATED_LEAVE, "STATE.md"));
    archives = (fs.existsSync(filed) ? fs.readdirSync(filed) : []).filter((one) => !had.includes(one));
    gatedRows = panelRows(await transcriptOf(GATED)).slice(gatedBefore);
    leaveRows = panelRows(await transcriptOf(GATED_LEAVE)).slice(leaveBefore);

    await post(`${URL}/online`, {});
    backAgain = await say("and now?", GATED);
    ranAfterwards = callsIn(gateLog).length;
  });

  // The whole feature, in one number. Everything else here is about saying it well.
  it("runs nothing, whichever way in was tried", () => {
    assert.ok(ranWhileOn > 0, "nothing ran while the room was on, so this proved nothing");
    assert.equal(ranWhileOff, ranWhileOn, "a run was started for a room that was off");
  });

  it("tells whoever sent a message, and writes it on the panel in the chat's own voice", () => {
    assert.equal(sentAMessage.status, 503);
    assert.equal(JSON.parse(sentAMessage.body).offline, true);
    assert.equal(gatedRowsAtOnce.length, 1, `the panel got ${JSON.stringify(gatedRowsAtOnce)}`);
    assert.equal(gatedRowsAtOnce.at(0)?.offline, true);
    assert.equal(gatedRowsAtOnce.at(0)?.from, "the chat");
    assert.match(gatedRowsAtOnce.at(0)?.text ?? "", new RegExp(`^Nothing reached ${GATED}: the room is offline`));
  });

  // Never under the session's own name. A room that is off is the chat's fact about itself, and a
  // line credited to somebody who was never asked anything is a panel saying a session said
  // something it did not.
  it("credits the session with nothing, since it was never asked", () => {
    assert.ok(gatedRows.length > 0, "nothing was written to the panel at all, so this proved nothing");
    assert.deepEqual(gatedRows.filter((row) => row.from === GATED), []);
  });

  // A session mid-turn reaching for another one is the cross-session message this exists to stop,
  // and it is refused in the tool's own words rather than as a tool that is not there.
  it("refuses the say tool, in words a session can act on", () => {
    assert.ok(calledTheTool.refused, `the tool answered ${JSON.stringify(calledTheTool)}`);
    assert.match(calledTheTool.text, /the room is offline/);
  });

  it("keeps the thread the handover was about to end", () => {
    assert.equal(handedOver.status, 503);
    assert.equal(JSON.parse(handedOver.body).offline, true);
    assert.equal(threadKept, true, "the conversation was thrown away for a room that is simply off");
  });

  // The pair to it: a refusal that reported a handover would be worse than one that did nothing,
  // because the person believes the desk was written.
  it("never says the handover happened", () => {
    assert.deepEqual(gatedRows.filter((row) => (row.text ?? "").includes("handed over")), []);
  });

  it("keeps the desk the leave was about to file away", () => {
    assert.equal(letGo.status, 503);
    assert.equal(JSON.parse(letGo.body).offline, true);
    assert.equal(deskKept, true, "the desk was filed away for a room that is simply off");
    assert.deepEqual(archives, [], "an archive was made for a session that never left");
    assert.equal(leaveRows.at(-1)?.offline, true, `the last row was ${JSON.stringify(leaveRows.at(-1))}`);
  });

  // The exit, proved by using it. Without this the whole describe would pass on a chat that had
  // simply stopped working.
  it("runs again the moment the room is brought back", () => {
    assert.equal(backAgain.status, 200);
    assert.equal(JSON.parse(backAgain.body).reply.text, "a reply");
    assert.ok(ranAfterwards > ranWhileOff, "nothing ran once the room was back on");
  });
});

// The other half of the gate, and the half a count cannot see: it is asked BEFORE the queue.
//
// A gate written inside the queue refuses the same messages and runs the same nothing, so the call
// log says the two are identical. What differs is when the person hears about it: a refusal that
// joined the queue waits for whatever is ahead of it, and "the room is off" is the one answer that
// has no reason to wait for anything. So this is proved by ORDER — the refusal comes back before
// the turn it would have queued behind — rather than by a duration, which would pass on a machine
// having a slow afternoon.
const OFF_BEHIND_A_TURN = "Sanderling";

describe("a message refused because the room is off does not wait behind the turn ahead of it", () => {
  const behindLog = path.join(standIn, "offline-behind.txt");
  const settled = [];
  let slowTurn;
  let refused;

  before(async () => {
    runTool(instance, ["hire", OFF_BEHIND_A_TURN], process.env);
    await start(instance, standInEnvironment(standIn, behindLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    const going = say("something that takes a while", OFF_BEHIND_A_TURN).then((answered) => {
      settled.push("the turn");
      return answered;
    });
    // Only once the run is really going, or there is nothing for the second message to be ahead of.
    const answering = await waitFor(async () => {
      const row = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find(
        (session) => session.name === OFF_BEHIND_A_TURN,
      );
      return row?.busy === true ? row : null;
    });
    assert.ok(answering !== null, "the first turn never started, so this would prove nothing");

    await post(`${URL}/offline`, {});
    refused = await say("and this one arrives while the room is off", OFF_BEHIND_A_TURN).then((answered) => {
      settled.push("the refusal");
      return answered;
    });
    slowTurn = await going;
    await post(`${URL}/online`, {});
  });

  it("answers the second one first, without waiting for the first", () => {
    assert.deepEqual(settled, ["the refusal", "the turn"]);
  });

  it("refuses it for the room being off, and lets the turn ahead finish in its own words", () => {
    assert.equal(refused.status, 503);
    assert.equal(JSON.parse(refused.body).offline, true);
    assert.equal(slowTurn.status, 200);
    assert.equal(JSON.parse(slowTurn.body).reply.text, "a reply");
  });
});

// Feature 13, slice 3: the room says it is off.
//
// The switch and the gate are both invisible. A room that is off looks exactly like a room where
// nobody happens to be saying anything — right up to the moment somebody sends a message and is
// turned away, which is the worst place to find out. This slice is what makes it readable before it
// is discovered, in the two places a room is laid out in words: `ow room`, which is where a person
// at a terminal reads it, and the page's own script, which is where everybody else does.
//
// Said ABOVE the rows and never on one. "Never a UI state" is already held from the other side —
// feature 12's `the room says every state it knows how to say` goes red on a seventh entry in
// `STATES`, so a state word for this could not be added quietly — but that check reads the state
// table and not the wording, and a room whose rows had all started saying "offline" beside their
// state would sail past it. That is what the third check below is for.
const OFF_IN_ROOM = "Dunlin";

describe("the room says it is off", () => {
  const offRoomLog = path.join(standIn, "offline-room.txt");
  let whileOn;
  let whileOff;
  let toldTheLead;
  let page;

  // One line of the room, by name. The name is padded to the room's width, so there is always a
  // space after it — matching on the bare name would also match a longer name starting with it.
  const lineFor = (room, name) => (room ?? "").split("\n").find((line) => line.startsWith(`${name} `));

  before(async () => {
    runTool(instance, ["hire", OFF_IN_ROOM], process.env);
    await start(instance, standInEnvironment(standIn, offRoomLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // The same room read twice, either side of one press. Both readings, never just the off one:
    // a line printed unconditionally reads exactly like a line printed because the room is off.
    whileOn = runTool(instance, ["room"], standInEnvironment(standIn, offRoomLog)).stdout;
    await post(`${URL}/offline`, {});
    whileOff = runTool(instance, ["room"], standInEnvironment(standIn, offRoomLog)).stdout;
    toldTheLead = answerOf(await call(LEADER, "tools/call", { name: "room", arguments: {} })).text;
    // Brought back before anything else runs. The switch is the instance's, not this describe's,
    // and a room left off would turn away a check that has nothing to do with this one.
    await post(`${URL}/online`, {});

    page = fs.readFileSync(path.join(instance, "tools", "chat", "page.html"), "utf8");
  });

  // Mutation: say it on the page only. The terminal is where the person who took the room off is
  // most likely to be standing, and a room that looks ordinary there is the whole failure again.
  it("says the room is offline, in the room a person reads at a terminal", () => {
    assert.match(whileOff, /room is offline/);
  });

  // The other half, and the one that makes the first mean anything.
  it("says nothing about it while the room is on", () => {
    assert.ok(lineFor(whileOn, OFF_IN_ROOM) !== undefined, "the session was not in the room at all");
    assert.doesNotMatch(whileOn, /offline/);
  });

  // Mutation: fold `offline` into `stateOf`. A row is what a session is doing; whether the room
  // will start anything is not something any session is doing, and a word for it on a row reads as
  // a state that session is in. The row is asserted to be UNCHANGED — same state phrase as before
  // the press, and nothing about the room anywhere on it.
  it("leaves every row alone: a session idle in an offline room still reads idle", () => {
    const line = lineFor(whileOff, OFF_IN_ROOM) ?? "";
    assert.ok(line !== "", "the session was not in the room at all");
    assert.match(line, /\bidle\b/);
    assert.doesNotMatch(line, /offline/);
  });

  // The fourth surface, and it is here because an edit that dropped it was watched going
  // unnoticed. `says the same thing the command says` already holds the tool and the command in
  // step for everything else a room says — but it reads a room that is ON, so the one line this
  // feature adds was outside it, and the tool could have quietly stopped saying it.
  //
  // The lead is the reader this matters most to: it is the session whose next message will be
  // turned away, so a room that read as ordinary here is the one place the silence would have had
  // no explanation.
  it("says it to the lead too, in the same words the command uses", () => {
    assert.match(toldTheLead ?? "", /room is offline/);
  });

  // No suite runs page.html — it is read as text — so the page's copy is proven by reading it.
  //
  // Bounded to the block that draws the room, deliberately. An unbounded `assert.match(page, ...)`
  // runs on through everything else the page does and would pass on a page that had lost the room
  // altogether, which is not a check.
  it("builds the sentence and the label from the one field, in the page's own copy of the room", () => {
    const from = page.indexOf("const OFF =");
    const to = page.indexOf("function panel(session)");
    assert.ok(from !== -1 && to !== -1 && from < to, "the page's room block is not where this check looks for it");
    const theRoom = page.slice(from, to);

    assert.match(theRoom, /room is offline/);
    // Declared AND put on the page. Measured: dropping the line from `replaceChildren` while
    // leaving the constant above it noticed NOTHING — which is the same failure this file already
    // pays for elsewhere, a thing built and never attached being invisible to a check that only
    // looks for it being built.
    assert.ok((theRoom.match(/\bOFF\b/g) ?? []).length > 1, "the sentence is declared and never put on the page");
    // One control, not two: the label says the state and pressing it is the way out of that state.
    // A page that can say "off" is a page that can be pressed back, with nothing to keep in step.
    assert.match(theRoom, /Go online/);
    assert.match(theRoom, /Go offline/);
    assert.match(theRoom, /"\/online"/);
    assert.match(theRoom, /"\/offline"/);
  });
});

const QUIET_SHORT = "Siskin";
const QUIET_LONG = "Twite";
const HANDED_ON = "Redpoll";

// How long a session has been doing nothing, said on its row.
//
// The clock is the thread's and not the panel's, so every fixture here ages the thread AND touches
// the panel to now: that is the one state where the two answers come apart, and without it a row
// built from either clock would read the same and this describe would be proving that they are
// usually equal.
//
// Two sessions aged to two different ages, both asserted. One would prove the duration is present;
// it would never prove it was read, because a hard-coded phrase satisfies a single fixture.
describe("how long a session has been doing nothing", () => {
  const quietLog = path.join(standIn, "quiet.txt");
  let shortly;
  let longer;
  let handed;
  let room;

  async function stateOf(name) {
    const { sessions: rows } = JSON.parse((await get(`${URL}/sessions`)).body);
    return rows.find((row) => row.name === name) ?? null;
  }

  const lineFor = (name) => (room ?? "").split("\n").find((line) => line.startsWith(`${name} `));

  before(async () => {
    runTool(instance, ["hire", QUIET_SHORT], process.env);
    runTool(instance, ["hire", QUIET_LONG], process.env);
    runTool(instance, ["hire", HANDED_ON], process.env);
    await start(instance, standInEnvironment(standIn, quietLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A turn each, so there is a thread with a clock at all.
    await say("something, so this one has run", QUIET_SHORT);
    await say("something, so this one has run too", QUIET_LONG);
    await say("and this one, which is about to lose it again", HANDED_ON);

    // Handed over: the panel stays and the thread is removed, which is the state where the obvious
    // place to read a time from has just been deleted.
    await post(`${URL}/sessions/${HANDED_ON}/handover`, {});

    // Aged last and read at once, so nothing between the two can carry a reading over a minute
    // boundary. The half-minutes are the cushion: rounded down, twenty and a half minutes reads as
    // twenty whether the next line runs now or in twenty seconds.
    age(threadFile(QUIET_SHORT), 20.5);
    age(threadFile(QUIET_LONG), 40.5);
    const now = new Date();
    fs.utimesSync(panelFile(QUIET_SHORT), now, now);
    fs.utimesSync(panelFile(QUIET_LONG), now, now);
    fs.utimesSync(panelFile(HANDED_ON), now, now);

    shortly = await stateOf(QUIET_SHORT);
    longer = await stateOf(QUIET_LONG);
    handed = await stateOf(HANDED_ON);
    room = runTool(instance, ["room"], standInEnvironment(standIn, quietLog)).stdout;
  });

  // Mutation: build the field from `lastAt`. Every panel here was touched to now, so a row built
  // from the panel's clock says "just now" for both of these and neither age survives.
  it("carries when each session last ran, and not when its panel last moved", () => {
    assert.equal(typeof shortly?.ran, "string", "no reading at all on the row");
    assert.equal(typeof longer?.ran, "string", "no reading at all on the row");
    assert.ok(Math.abs(Date.now() - Date.parse(shortly.ran) - 20.5 * 60_000) < 60_000, shortly.ran);
    assert.ok(Math.abs(Date.now() - Date.parse(longer.ran) - 40.5 * 60_000) < 60_000, longer.ran);
  });

  // Mutation: say a fixed duration, or none at all. Two ages, both asserted, so no single written
  // phrase satisfies this.
  it("says how long each has been doing nothing, in the room a person reads at a terminal", () => {
    assert.match(lineFor(QUIET_SHORT) ?? "", /idle, last ran 20m ago/);
    assert.match(lineFor(QUIET_LONG) ?? "", /idle, last ran 40m ago/);
  });

  // Mutation: fall back to the panel's clock when there is no thread, or to "just now". A session
  // that has just been handed over has a full panel and nothing to say about a conversation, and
  // inventing an age for it is the most reassuring possible reading of not knowing.
  it("says nothing about it for a session with no conversation to carry on", () => {
    assert.equal(handed?.ran, null, `read ${handed?.ran}`);
    const line = lineFor(HANDED_ON) ?? "";
    assert.ok(line !== "", "the session was not in the room at all");
    assert.match(line, /\bidle\b/);
    assert.doesNotMatch(line, /last ran/);
  });

  // No suite runs page.html — it is read as text — so the page's copy is proven by reading it, and
  // the check is bounded to the block that says what a row is doing. Unbounded, it would run on
  // into the room command's own wording quoted nowhere and pass on a page that had lost this.
  //
  // The phrase is asserted to be BUILT and USED: a source-text check that matches a literal is
  // satisfied by the literal's own declaration, which is the failure this file has already paid
  // for twice.
  it("says the same phrase in the page's own copy of the room", () => {
    const page = fs.readFileSync(path.join(instance, "tools", "chat", "page.html"), "utf8");
    const from = page.indexOf("function state(row)");
    const to = page.indexOf("function inTheRoom(row)");
    assert.ok(from !== -1 && to !== -1 && from < to, "the page's state block is not where this check looks for it");
    const theState = page.slice(from, to);

    assert.match(theState, /last ran/);
    assert.match(theState, /row\.ran/);
    assert.ok((theState.match(/\bidleSaid\b/g) ?? []).length > 1, "the phrase is built and never returned");
  });
});

const STILL_ANSWERING = "Brambling";

// The one state the ordering of the room's table has to keep this out of.
//
// A session's clock stands still for the whole of a turn — the file it is read from is rewritten
// when a run ENDS — so a duration printed beside the state phrase rather than inside it would tell
// a session answering right now that it had been doing nothing for as long as it had been working.
describe("what the room says about a session answering with an old clock behind it", () => {
  const answeringLog = path.join(standIn, "answering.txt");
  let mid;
  let room;

  const lineFor = (name) => (room ?? "").split("\n").find((line) => line.startsWith(`${name} `));

  before(async () => {
    runTool(instance, ["hire", STILL_ANSWERING], process.env);
    await start(instance, standInEnvironment(standIn, answeringLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A first turn for the clock to belong to, then an age well past anything this feature would
    // call quiet — and short of the hour, so the row is answering and not cold.
    await say("the first thing, so there is a thread", STILL_ANSWERING);
    age(threadFile(STILL_ANSWERING), 40.5);

    // And a second, left running. The file is not touched again until the run ends, so for the
    // whole of this turn the clock behind the row says forty minutes.
    const running = say("the second thing, which takes a while", STILL_ANSWERING);
    const { sessions: rows } = await waitFor(async () => {
      const body = JSON.parse((await get(`${URL}/sessions`)).body);
      return body.sessions.find((row) => row.name === STILL_ANSWERING)?.busy === true ? body : null;
    });
    mid = rows.find((row) => row.name === STILL_ANSWERING);
    room = runTool(instance, ["room"], standInEnvironment(standIn, answeringLog)).stdout;
    await running;
  });

  // Mutation: say the duration as a fact of its own beside the state phrase, in the position the
  // usage reading is said in. The row then carries forty minutes of doing nothing on a session
  // that is working, and this is the only check that sees it.
  it("says it is answering and nothing about how long it has been doing nothing", () => {
    assert.equal(mid?.busy, true, "the session was never mid-turn");
    const line = lineFor(STILL_ANSWERING) ?? "";
    assert.ok(line !== "", "the session was not in the room at all");
    assert.match(line, /\banswering\b/);
    // The AGE and not the wording. A duration moved out of the state phrase would be said in
    // whatever words its new position used, and a check anchored on this feature's own phrase
    // would go green on every one of them. Forty minutes cannot honestly appear on this line: the
    // panel moved when the message arrived, so the only other age here says just now.
    assert.doesNotMatch(line, /40m/, "a session working for the whole of its turn is not doing nothing");
  });
});

const STOPPED_SHORT = "Linnet";
const STOPPED_LONG = "Serin";
const STILL_GOING = "Crossbill";

// Who has stopped, told to the session that leads without it having asked.
//
// The room is deliberately never carried into a turn, and this is the one exception to that: one
// line, absent while nobody has stopped, dated so it cannot be read as now, about the one state
// that is not moving. So the fixtures here have to reach both states — somebody stopped, and
// nobody stopped — or the check that it is said proves only that it is always said.
describe("what the lead is told about who has stopped", () => {
  const stoppedLog = path.join(standIn, "stopped.txt");
  let toldWhenStopped;
  let toldWhenNobodyHas;
  let toldAWorker;
  let toldWhenTheLeadIsTheOldOne;

  // The question a session was handed on its last turn, whole.
  const lastQuestion = (log) => questionsIn(log).slice(-1)[0] ?? "";

  before(async () => {
    runTool(instance, ["hire", STOPPED_SHORT], process.env);
    runTool(instance, ["hire", STOPPED_LONG], process.env);
    runTool(instance, ["hire", STILL_GOING], process.env);
    await start(instance, standInEnvironment(standIn, stoppedLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A turn each, so every one of them has a clock at all.
    await say("something, so this one has run", STOPPED_SHORT);
    await say("something, so this one has run too", STOPPED_LONG);
    await say("and this one, which stays fresh", STILL_GOING);
    await say("and the lead, so it has one as well", LEADER);

    // Nobody has stopped yet. This is the state that makes the check below mean anything.
    await say("a first question, with the room busy and nobody stopped", LEADER);
    toldWhenNobodyHas = lastQuestion(stoppedLog);

    // Two of them stopped, to two different ages, and the panels touched to now so a reading off
    // the panel's clock could not reach either answer.
    age(threadFile(STOPPED_SHORT), 35.5);
    age(threadFile(STOPPED_LONG), 50.5);
    const now = new Date();
    fs.utimesSync(panelFile(STOPPED_SHORT), now, now);
    fs.utimesSync(panelFile(STOPPED_LONG), now, now);

    await say("a second question, with two of them stopped", LEADER);
    toldWhenStopped = lastQuestion(stoppedLog);

    // The same state, seen from a worker's turn. A worker has one task and the others are not its
    // business.
    await say("and a worker is asked something, with the same two stopped", STILL_GOING);
    toldAWorker = lastQuestion(stoppedLog);

    // And the lead's own clock older than anybody's. It is mid-turn whenever this is composed, so
    // its own reading is the end of its PREVIOUS run and is always stale.
    age(threadFile(LEADER), 55.5);
    fs.utimesSync(panelFile(LEADER), now, now);
    await say("a third question, with the lead the oldest clock in the room", LEADER);
    toldWhenTheLeadIsTheOldOne = lastQuestion(stoppedLog);
  });

  // Mutation: build the wrapper and never push it into what the session is handed — the shape this
  // repo has already paid for twice, a thing built and never attached. Two names and two different
  // ages are asserted, so no single written sentence satisfies this.
  it("names who has stopped, and how long each has been doing nothing", () => {
    assert.match(toldWhenStopped, /<quiet>[\s\S]*<\/quiet>/);
    assert.match(toldWhenStopped, new RegExp(`${STOPPED_SHORT} last ran 35m ago`));
    assert.match(toldWhenStopped, new RegExp(`${STOPPED_LONG} last ran 50m ago`));
  });

  // Mutation: drop the test on how long it has been, and everybody with a thread is named on every
  // turn. The other half of the WHETHER rule, and without it the check above proves only that a
  // sentence is always there.
  //
  // Read against THESE two and never against the whole line. The suites install one instance and
  // every describe before this one hires into it, so by the time this runs there are sessions with
  // genuinely old threads that this is right to name — a check asserting the wrapper is absent
  // altogether passes alone and fails in a full run, which is exactly what it did.
  it("does not name a session that has not stopped", () => {
    assert.doesNotMatch(toldWhenNobodyHas, new RegExp(`${STOPPED_SHORT} last ran`));
    assert.doesNotMatch(toldWhenNobodyHas, new RegExp(`${STOPPED_LONG} last ran`));
  });

  // Mutation: drop the test on who is being handed this. The room is the lead's, and this is the
  // same fact pushed.
  it("never says it to a worker", () => {
    assert.doesNotMatch(toldAWorker, /<quiet>/, "a worker was told who has stopped");
    // And the state it would have been told about was really there, or this passes on a quiet
    // moment rather than on the rule it is named for.
    assert.match(toldWhenStopped, /<quiet>/, "nobody had stopped when the worker was asked");
  });

  // Mutation: drop `turnsGoing(...) === 0`. A session's clock stands still for the whole of a turn,
  // and this is composed inside the reader's own turn — so without that one predicate the lead is
  // told it has stopped, on every turn it ever runs, for as long as it is the oldest clock here.
  it("does not name a session that is mid-turn, the one reading it, included", () => {
    assert.match(toldWhenTheLeadIsTheOldOne, /<quiet>/, "nobody was named at all");
    assert.doesNotMatch(toldWhenTheLeadIsTheOldOne, new RegExp(`${LEADER} last ran `));
  });

  // Mutation: drop the moment. It is the whole of why this may be handed over unasked at all: a
  // dated line cannot be read as the room now, and an undated one is exactly the stale snapshot
  // the room is deliberately never carried as. Asserted against the clock and never a literal.
  it("says the moment the reading was taken", () => {
    const said = toldWhenStopped.match(/read at (\d\d):(\d\d)/);
    assert.ok(said !== null, `no moment in: ${toldWhenStopped}`);
    const when = new Date();
    when.setHours(Number(said[1]), Number(said[2]), 0, 0);
    assert.ok(Math.abs(Date.now() - when.getTime()) < 5 * 60_000, `said ${said[0]}, now ${new Date()}`);
  });

  // Mutation: say the name of the wrapper and nothing about who is speaking. An update ships new
  // templates and re-renders nobody's persona, so a session reading this may be running one
  // written before any of it existed and has nothing to look it up in.
  it("says the chat is the one speaking, and not the person at the page", () => {
    assert.match(toldWhenStopped, /The chat is telling you this\. Nobody typed it\./);
  });
});

const STOPS_WHILE_A_MESSAGE_WAITS = "Fieldfare";

// Where the reading is taken, which is the half of this feature a wrapper check cannot see.
//
// Composing the list is one line either way, and both places produce a correct-looking sentence.
// What differs is a message that waited: the lead's panel is the busiest in the room, so a question
// typed while a long turn is going is routinely answered minutes later. A list built where the
// message ARRIVED describes the room as it was before the wait; a list built where the TURN BEGINS
// describes it as it is when the lead reads it. Every other reading on this path — whether the
// conversation has gone cold, which line is being answered, whether the session is still here — is
// taken at the turn, and this one has to be taken with them or the lead is handed one stale fact
// in among the fresh ones and no way to tell which.
//
// So the fixture holds the system in the wrong state long enough for the difference to show: the
// session goes quiet while the second message is already queued and cannot yet have been read.
describe("who has gone quiet is read where the turn begins and not where the message arrived", () => {
  const waitedLog = path.join(standIn, "waited.txt");
  let deepEnough;
  let stillGoing;
  let toldBeforeItStopped;
  let toldAfterTheWait;

  before(async () => {
    runTool(instance, ["hire", STOPS_WHILE_A_MESSAGE_WAITS], process.env);
    await start(instance, standInEnvironment(standIn, waitedLog, { OW_STAND_IN_SLOW: "1500" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A turn each, so both have a clock at all. Fresh at this point, so nothing here is quiet yet.
    await say("something, so this one has run", STOPS_WHILE_A_MESSAGE_WAITS);
    await say("and the lead, so it has one too", LEADER);

    // The lead's first message, left running. Not awaited: the second one has to arrive while this
    // one still holds the turn.
    const going = say("the first thing, which takes a while", LEADER);
    await waitFor(async () => {
      const row = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((session) => session.name === LEADER);
      return row?.busy === true ? row : null;
    });

    // The second, which joins the queue behind it. Waited for as a DEPTH and not as a duration: the
    // row says how many are behind the one being answered, so this is the server telling us the
    // message is in and has not been read, rather than a sleep hoping it is.
    const queued = say("the second thing, which waits behind the first");
    deepEnough = await waitFor(async () => {
      const row = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((session) => session.name === LEADER);
      return (row?.queued ?? 0) >= 1 ? row : null;
    });

    // And NOW it stops — after its message was taken, before its turn begins. The panel is touched
    // to now with it, so a reading off the panel's clock could not reach this answer either.
    age(threadFile(STOPS_WHILE_A_MESSAGE_WAITS), 35.5);
    const now = new Date();
    fs.utimesSync(panelFile(STOPS_WHILE_A_MESSAGE_WAITS), now, now);

    // The first turn is still the one running, or the wait proved nothing: a session answers one
    // message at a time, so the second cannot have been read while this is true.
    stillGoing = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((session) => session.name === LEADER);

    await going;
    await queued;

    // Both by POSITION and neither by "the last one". The second turn starts the moment the first
    // finishes, so a reading taken when the first settles is a race with the question that follows
    // it. This log belongs to this describe alone and holds these four questions in the order they
    // were asked: the two that gave each session a clock, then the one that ran long, then the one
    // that waited behind it.
    const asked = questionsIn(waitedLog);
    assert.equal(asked.length, 4, `expected the four questions of this describe, got ${asked.length}`);
    toldBeforeItStopped = asked[2];
    toldAfterTheWait = asked[3];
  });

  // Mutation: compose the list in the route handler, where the message arrives, and pass it down
  // into the turn. Nobody had stopped when this message was taken, so the lead is told nothing
  // about a session that stopped while its question sat in the queue — and the wrapper checks above
  // all stay green, because every one of them asks a question whose message was answered at once.
  it("names a session that stopped while the message was waiting to be read", () => {
    assert.equal(stillGoing?.busy, true, "the first turn had already finished, so nothing waited");
    assert.ok((deepEnough?.queued ?? 0) >= 1, "the second message never queued behind the first");
    assert.match(toldAfterTheWait, /<quiet>[\s\S]*<\/quiet>/);
    assert.match(toldAfterTheWait, new RegExp(`${STOPS_WHILE_A_MESSAGE_WAITS} last ran 35m ago`));
  });

  // The other half of it, and what stops the check above passing on a session that was quiet all
  // along. Read against THIS name and never against the whole wrapper: the suite installs one
  // instance and everything before this hires into it, so there are genuinely old threads by now
  // that the lead is right to be told about.
  it("said nothing about it on the turn that began before it stopped", () => {
    assert.doesNotMatch(toldBeforeItStopped, new RegExp(`${STOPS_WHILE_A_MESSAGE_WAITS} last ran`));
  });
});


const FILLING_UP = "Nuthatch";
const STILL_ROOM = "Treecreeper";
const NOT_THE_LEAD = "Chiffchaff";

// Staging a stored reading, which is what these checks act on.
//
// Setting state up through the filesystem is what age() beside it is for; asserting through it is
// the thing that goes wrong, and nothing below reads this file back — every assertion reads the
// question a session was handed. Writing it also sets the moment the reading was taken, since the
// file's own modified time IS that moment, so the age is given here rather than arranged for.
//
// It reaches three states no run can be made to produce: a seven-day window over the stop line (the
// stand-in derives its fullness by halving, so it would need a utilization above one), a seven-day
// window that lifts sooner than the five-hour one, and a five-hour window lifting inside the hour.
function stageWindows(name, windows, minutesAgo = 0) {
  const file = threadFile(name);
  const held = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, `${JSON.stringify({ ...held, quota: windows }, null, 2)}\n`);
  age(file, minutesAgo);
}

// The <usage> block alone, cut out by hand.
//
// The question a session is handed carries other blocks, and one of them says a sentence this one
// also says word for word: who-has-stopped opens with the same line about who is speaking. By the
// time this describe runs there are genuinely old threads in the shared instance, so that block is
// really there — and a match against the whole question is satisfied by the neighbour. MEASURED:
// the mutation that deletes the line from THIS block reported nothing noticed until this existed.
//
// The cutting is done here rather than left to a regex, because a match spanning two delimiters
// chooses the LAST closing one and would swallow whatever sits between.
function usageBlock(question) {
  const from = question.indexOf("<usage>");
  if (from === -1) {
    return "";
  }
  const to = question.indexOf("</usage>", from);
  return to === -1 ? "" : question.slice(from, to + "</usage>".length);
}

// A window, as the reading carries one. In seconds from now, because that is the shape the service
// sends and the shape the file keeps.
const window = (name, fullness, liftsInMinutes) => ({
  name,
  fullness,
  resetsAt: liftsInMinutes === null ? null : Math.floor(Date.now() / 1000) + Math.round(liftsInMinutes * 60),
});

// What the lead is told when the five-hour window is filling up.
//
// The account is one thing and the rows are many: every session carries the reading its own last run
// was handed, at its own age. So the whole of what these checks are about is WHICH reading is picked
// and WHICH window in it is read, and both are staged in states where a wrong answer differs from
// the right one rather than coinciding with it.
describe("what the lead is told when the usage window is filling up", () => {
  const fillingLog = path.join(standIn, "filling.txt");
  let toldWhenFillingUp;
  let toldWhenThereIsRoom;
  let toldWhenTheWeekIsTheFullOne;
  let toldAWorker;

  const lastQuestion = (log) => questionsIn(log).slice(-1)[0] ?? "";

  before(async () => {
    runTool(instance, ["hire", FILLING_UP], process.env);
    runTool(instance, ["hire", STILL_ROOM], process.env);
    runTool(instance, ["hire", NOT_THE_LEAD], process.env);
    await start(instance, standInEnvironment(standIn, fillingLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A turn each, so every one of them has a thread and a clock to stage against.
    await say("something, so this one has run", FILLING_UP);
    await say("something, so this one has run too", STILL_ROOM);
    await say("and this one as well", NOT_THE_LEAD);
    await say("and the lead, so it has one", LEADER);

    // Nothing is near the line. The state that makes the check below mean anything.
    stageWindows(LEADER, [window("five_hour", 0.71, 180), window("seven_day", 0.36, 5 * 24 * 60)]);
    await say("a first question, with room left in the window", LEADER);
    toldWhenThereIsRoom = lastQuestion(fillingLog);

    // The lead's own run just rewrote its reading, so the fullest is staged on a worker and the
    // lead's own is pushed back behind it. Two sessions, two fullnesses, two ages.
    stageWindows(FILLING_UP, [window("five_hour", 0.91, 180), window("seven_day", 0.36, 5 * 24 * 60)]);
    stageWindows(STILL_ROOM, [window("five_hour", 0.71, 180), window("seven_day", 0.36, 5 * 24 * 60)], 12);
    stageWindows(LEADER, [window("five_hour", 0.71, 180), window("seven_day", 0.36, 5 * 24 * 60)], 6);
    await say("a second question, with the window filling up", LEADER);
    toldWhenFillingUp = lastQuestion(fillingLog);

    // The same standing, read from a worker's turn.
    stageWindows(FILLING_UP, [window("five_hour", 0.91, 180), window("seven_day", 0.36, 5 * 24 * 60)]);
    await say("and a worker is asked something, with the window just as full", NOT_THE_LEAD);
    toldAWorker = lastQuestion(fillingLog);

    // And the week both fuller AND sooner than the five-hour window, which is the ordering the
    // service really produces for about a hundred minutes once a week.
    stageWindows(FILLING_UP, [window("five_hour", 0.40, 6 * 24 * 60), window("seven_day", 0.96, 60)]);
    stageWindows(LEADER, [window("five_hour", 0.40, 6 * 24 * 60), window("seven_day", 0.96, 60)], 6);
    await say("a third question, with the week the full one", LEADER);
    toldWhenTheWeekIsTheFullOne = lastQuestion(fillingLog);
  });

  // Mutation: build the wrapper and never push it into what the session is handed — the shape this
  // repo has paid for three times now. The number, whose reading it is and how old it is are all
  // asserted, so no single written sentence satisfies this.
  it("tells the lead how full the window was, whose reading it is and when it was read", () => {
    const block = usageBlock(toldWhenFillingUp);
    assert.notEqual(block, "", `no block at all in: ${toldWhenFillingUp}`);
    assert.match(block, /five-hour usage window was 91% full/);
    assert.match(block, new RegExp(`when ${FILLING_UP} last ran`));
    assert.match(block, /read just now/);
  });

  // Mutation: drop the moment this turn began. It is half of what makes this safe to hand over
  // unasked: "read just now" is a duration with nothing to measure from, and a line that cannot be
  // placed in time is exactly the stale snapshot a room is deliberately never carried as.
  // Asserted against the clock and never against a literal.
  it("says the moment the turn it rode in on began", () => {
    const said = usageBlock(toldWhenFillingUp).match(/as this turn began at (\d\d):(\d\d)/);
    assert.ok(said !== null, `no moment in: ${toldWhenFillingUp}`);
    const when = new Date();
    when.setHours(Number(said[1]), Number(said[2]), 0, 0);
    assert.ok(Math.abs(Date.now() - when.getTime()) < 3 * 60 * 1000, `the moment was ${said[0]}`);
  });

  // Mutation: drop the test on how full it is, and this is said on every turn forever. The other
  // half of the WHETHER rule — without it the check above proves only that a sentence is always
  // there. Read against THIS state's own words and never against the wrapper being absent: the
  // suites install one instance and every describe before this one has been writing into it.
  it("says nothing while there is room left in the window", () => {
    assert.doesNotMatch(toldWhenThereIsRoom, /five-hour usage window was/);
    assert.doesNotMatch(toldWhenThereIsRoom, /Plan what is left wisely/);
  });

  // Mutation: read whichever window lifts soonest instead of the one this rule is about.
  //
  // THE CHECK THIS FEATURE'S WHOLE SHAPE RESTS ON, and the state it stages is one the service really
  // produces: the seven-day window rolled at 17:00Z on 2026-09-02 while the five-hour window then
  // running lifted at 20:20Z, so for those hundred minutes the soonest-lifting window was the week.
  // Five per cent of a week is a working day, so a rule about five hours said of it would stop
  // everything for something that is not an emergency.
  //
  // Two windows with two fullnesses and two lift moments in front of one assertion, and the wrong
  // one is BOTH fuller and sooner — so neither "the fullest" nor "the soonest" can reach the right
  // answer here by luck.
  it("reads the window this rule is about and not whichever is fuller or sooner", () => {
    assert.doesNotMatch(toldWhenTheWeekIsTheFullOne, /96% full/);
    assert.doesNotMatch(toldWhenTheWeekIsTheFullOne, /seven-day usage window was/);
    assert.doesNotMatch(toldWhenTheWeekIsTheFullOne, /Plan what is left wisely/);
  });

  // Mutation: drop the test on who is being handed this. The room is the lead's, and this is one
  // more fact about the whole workspace pushed to the one session it is the business of.
  it("never says it to a worker", () => {
    assert.doesNotMatch(toldAWorker, /<usage>/, "a worker was told where the account stands");
    // And the state it would have been told about was really there, or this passes on a quiet
    // moment rather than on the rule it is named for.
    assert.match(toldWhenFillingUp, /<usage>/, "the window was not filling up when the worker was asked");
  });

  // Mutation: drop the line. An update ships new templates and re-renders nobody's persona, so a
  // session reading this may be running one written before any of it existed.
  it("says the chat is the one speaking, and not the person at the page", () => {
    assert.match(usageBlock(toldWhenFillingUp), /The chat is telling you this\. Nobody typed it\./);
  });
});

const FRESHEST_ONE = "Wryneck";
const OLDER_ONE = "Hoopoe";
const LIFTED_AND_FULL = "Wagtail";

// Which of the readings on the rows is the one the account is judged by.
//
// One account, N sessions, N readings taken at N different moments — feature 11's stated trap, and
// the reason every row prints its number's age. A glance has to pick ONE, and the only honest pick
// is the most recent: the largest of them may be off a window that ended hours ago.
//
// Both directions are staged on ONE session, which is what stops the repair being "always take the
// first row" or "always take the lead's own": the same name carries the full reading in one half
// and the fine one in the other, and only the age tells them apart.
//
// AND THE AGE IS AGAINST THE WHOLE INSTANCE, not against this describe. The suites install one
// instance and every describe before this one has hired into it and run, so those sessions carry
// readings of their own from seconds ago. A reading staged a minute old is not the freshest thing
// here however this describe is written — measured, and it cost this check one red run. So the one
// under test is staged at NOW and every other named here is pushed behind it.
describe("which reading the lead is told the account stands at", () => {
  const pickLog = path.join(standIn, "pick.txt");
  let toldWhenTheFullOneIsStale;
  let toldWhenTheFullOneIsFresh;
  let toldWhenItHasLifted;

  const lastQuestion = (log) => questionsIn(log).slice(-1)[0] ?? "";
  const fine = () => [window("five_hour", 0.71, 180), window("seven_day", 0.36, 5 * 24 * 60)];
  const full = (liftsIn = 180) => [window("five_hour", 0.93, liftsIn), window("seven_day", 0.36, 5 * 24 * 60)];

  before(async () => {
    runTool(instance, ["hire", FRESHEST_ONE], process.env);
    runTool(instance, ["hire", OLDER_ONE], process.env);
    runTool(instance, ["hire", LIFTED_AND_FULL], process.env);
    await start(instance, standInEnvironment(standIn, pickLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    await say("something, so this one has run", FRESHEST_ONE);
    await say("something, so this one has run too", OLDER_ONE);
    await say("and this one as well", LIFTED_AND_FULL);
    await say("and the lead, so it has one", LEADER);

    // The full reading is the OLDER one and the newest says there is room, so the account is not
    // where the biggest number on any row says it is.
    stageWindows(OLDER_ONE, full(), 14);
    stageWindows(LIFTED_AND_FULL, fine(), 20);
    stageWindows(LEADER, fine(), 7);
    stageWindows(FRESHEST_ONE, fine());
    await say("a first question, with the full reading the older one", LEADER);
    toldWhenTheFullOneIsStale = lastQuestion(pickLog);

    // The same two readings the other way round, on the same two names.
    stageWindows(OLDER_ONE, fine(), 14);
    stageWindows(LIFTED_AND_FULL, fine(), 20);
    stageWindows(LEADER, fine(), 7);
    stageWindows(FRESHEST_ONE, full());
    await say("a second question, with the full reading the newer one", LEADER);
    toldWhenTheFullOneIsFresh = lastQuestion(pickLog);

    // And the newest reading of all, on a window that has already ended.
    stageWindows(OLDER_ONE, fine(), 14);
    stageWindows(FRESHEST_ONE, fine(), 9);
    stageWindows(LEADER, fine(), 7);
    stageWindows(LIFTED_AND_FULL, full(-40));
    await say("a third question, with the newest reading off a window that has ended", LEADER);
    toldWhenItHasLifted = lastQuestion(pickLog);
  });

  // Mutation: take the highest fullness across the rows rather than the most recent reading. The
  // first half goes red; the second half is what stops the repair being "always take the first row"
  // or "always take the lead's own", since the same name carries both readings.
  it("reads the freshest reading and not the fullest", () => {
    assert.doesNotMatch(toldWhenTheFullOneIsStale, /93% full/);
    assert.match(usageBlock(toldWhenTheFullOneIsFresh), /93% full/);
    assert.match(usageBlock(toldWhenTheFullOneIsFresh), new RegExp(`when ${FRESHEST_ONE} last ran`));
  });

  // Mutation: drop the test on whether the window has already ended. Ninety-three per cent of a
  // window that has reset is nothing, and acting on it would stop the work for a limit that is gone.
  it("says nothing about a window that has already ended", () => {
    assert.doesNotMatch(toldWhenItHasLifted, /93% full/);
    assert.doesNotMatch(toldWhenItHasLifted, /Plan what is left wisely/);
  });
});


const NEARLY_GONE = "Redpoll";
const STILL_RUNS = "Brambling";

// What the lead is told to DO once the window is nearly gone, and which way to put people down.
//
// The reading beside this one is a number and an age; this is the office's rule on top of it, and
// the whole of the rule is a choice between two ways of stopping. Pausing people leaves their
// conversations where they stand and costs nothing to undo; parking them ends every one of them and
// is paid for in everything nobody wrote down. Getting the choice the wrong way round is expensive
// in one direction and irreversible in the other, so both states of it are staged here, either side
// of the hour a conversation stays carriable — and never either side of an hour written down twice.
describe("what the lead is told to do once the window is nearly gone", () => {
  const stopLog = path.join(standIn, "stop.txt");
  let toldWhileThereIsRoomToPlan;
  let toldToPause;
  let toldToPark;
  let toldWithNoMoment;
  let toldTheWeekIsFullToo;
  let toldWhenTheWeekHasEnded;
  let ranBeforeTheWorkerWasAsked;
  let ranAfterTheWorkerWasAsked;
  let askedTheWorker;

  const lastQuestion = (log) => questionsIn(log).slice(-1)[0] ?? "";
  const nearlyGone = (liftsIn) => [window("five_hour", 0.96, liftsIn), window("seven_day", 0.36, 5 * 24 * 60)];
  const roomLeft = () => [window("five_hour", 0.91, 180), window("seven_day", 0.36, 5 * 24 * 60)];

  // The clock this describe reads lift moments against. Written as minutes into the day so that a
  // run started at ten to midnight compares the same way as one at noon.
  const intoTheDay = (hours, minutes) => (Number(hours) * 60 + Number(minutes)) % (24 * 60);
  const liftsIn = (block, minutes) => {
    const said = block.match(/It lifts at (\d\d):(\d\d)/);
    assert.ok(said !== null, `no lift moment in: ${block}`);
    const expected = new Date(Date.now() + minutes * 60 * 1000);
    const apart = Math.abs(intoTheDay(said[1], said[2]) - intoTheDay(expected.getHours(), expected.getMinutes()));
    assert.ok(Math.min(apart, 24 * 60 - apart) <= 2, `it said ${said[0]}, and the window lifts in ${minutes}m`);
  };

  // The reading under test is staged on a worker and the lead's own is pushed behind it, because
  // the lead's turn rewrites its own thread the moment it runs — so the freshest reading in the
  // instance has to be one nothing here is about to touch.
  const stage = (windows) => {
    stageWindows(NEARLY_GONE, windows);
    stageWindows(LEADER, roomLeft(), 6);
  };

  before(async () => {
    runTool(instance, ["hire", NEARLY_GONE], process.env);
    runTool(instance, ["hire", STILL_RUNS], process.env);
    await start(instance, standInEnvironment(standIn, stopLog));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A turn each, so every one of them has a thread and a clock to stage against.
    await say("something, so this one has run", NEARLY_GONE);
    await say("something, so this one has run too", STILL_RUNS);
    await say("and the lead, so it has one", LEADER);

    // Over the plan line and under the stop line. The other state of the stop line, without which
    // the checks below prove only that a sentence is always there.
    stage(roomLeft());
    await say("a first question, with room left to plan with", LEADER);
    toldWhileThereIsRoomToPlan = lastQuestion(stopLog);

    // Over the stop line, lifting well inside the hour a conversation stays carriable — and inside
    // it by less than an hour's worth of margin, which is what lets the hour be watched.
    stage(nearlyGone(45));
    await say("a second question, with the window nearly gone and a short wait", LEADER);
    toldToPause = lastQuestion(stopLog);

    // Over the stop line and lifting further off than that hour.
    stage(nearlyGone(90));
    await say("a third question, with the window nearly gone and a long wait", LEADER);
    toldToPark = lastQuestion(stopLog);

    // Over the stop line with the frame naming no moment at all.
    stage([window("five_hour", 0.96, null), window("seven_day", 0.36, 5 * 24 * 60)]);
    await say("a fourth question, with nothing said about when it lifts", LEADER);
    toldWithNoMoment = lastQuestion(stopLog);

    // Both windows over the stop line, the week five days off. The one ordering in which the advice
    // above would be wrong on its own.
    stage([window("five_hour", 0.96, 20), window("seven_day", 0.97, 5 * 24 * 60)]);
    await say("a fifth question, with the week over the line as well", LEADER);
    toldTheWeekIsFullToo = lastQuestion(stopLog);

    // The week over the line on a reading that describes a week already gone. Ninety-seven per cent
    // of a week that rolled is nothing, and saying it does not lift until a moment in the past is
    // worse than saying nothing.
    stage([window("five_hour", 0.96, 20), window("seven_day", 0.97, -30)]);
    await say("a sixth question, with the week over the line but already rolled", LEADER);
    toldWhenTheWeekHasEnded = lastQuestion(stopLog);

    // And a worker asked something with the account still over the stop line. The stand-in's own
    // call log is what says the run happened, rather than anything the answer contains.
    stage(nearlyGone(90));
    ranBeforeTheWorkerWasAsked = callsIn(stopLog).length;
    await say("a worker is asked something while the account is nearly out", STILL_RUNS);
    ranAfterTheWorkerWasAsked = callsIn(stopLog).length;
    askedTheWorker = lastQuestion(stopLog);
  });

  // Mutations, and it takes one each way:
  //   the stop line written as 95 rather than 0.95, which is the shape of every off-by-a-hundred a
  //     fullness between nought and one invites → nothing ever crosses it, and the window at 96% is
  //     told to plan around what is not there;
  //   the stop test made against the plan line → the window at 91% is told to stop everything, which
  //     is the expensive direction and the one no check beside this one would notice.
  it("says to stop once the window is nearly gone, and to plan while it is not", () => {
    const nearlyOut = usageBlock(toldToPark);
    assert.notEqual(nearlyOut, "", `no block at all in: ${toldToPark}`);
    assert.match(nearlyOut, /five-hour usage window was 96% full/);
    assert.match(nearlyOut, /Stop the tasks/);
    assert.doesNotMatch(nearlyOut, /Plan what is left wisely/);

    const roomToPlan = usageBlock(toldWhileThereIsRoomToPlan);
    assert.match(roomToPlan, /five-hour usage window was 91% full/);
    assert.match(roomToPlan, /Plan what is left wisely/);
    assert.doesNotMatch(roomToPlan, /Stop the tasks/);
  });

  // Mutation: turn the comparison on the hour round. Every conversation in the workspace is ended
  // and rebuilt off its desk over a wait it would have sat through, which is the cost this whole
  // choice exists to avoid paying twice.
  it("says to park everybody when it lifts further off than a conversation lasts", () => {
    const block = usageBlock(toldToPark);
    assert.match(block, /further off than the hour a conversation here stays carriable/);
    assert.match(block, /park everybody, yourself included/);
    assert.doesNotMatch(block, /pause everybody where they are/);
    liftsIn(block, 90);
  });

  // Mutations, and the second is the one this check is really for:
  //   turn the comparison round → this fixture is told to park;
  //   MOVE COLD_AFTER, and nothing else. Half an hour instead of an hour, and this fixture at
  //     forty-five minutes is on the other side of it → told to park. That is the whole of what
  //     "the hour is read off COLD_AFTER" means as something watchable: an implementation with the
  //     hour written down here instead would sail through it green. The fixture sits at 45 minutes
  //     and not at 20 for exactly that reason — 20 is inside both hours and watches nothing.
  it("says to pause everybody in place when it lifts inside the hour one lasts", () => {
    const block = usageBlock(toldToPause);
    assert.match(block, /inside the hour a conversation here stays carriable/);
    assert.match(block, /pause everybody where they are/);
    assert.doesNotMatch(block, /park everybody, yourself included/);
    liftsIn(block, 45);
  });

  // Mutation: take a missing moment for an answer — either one. Nothing is known, so the third
  // thing is said, and this asserts that third thing rather than the absence of the other two: an
  // absence is satisfied by a block that says nothing at all.
  it("says to find out when it lifts when the frame did not say", () => {
    const block = usageBlock(toldWithNoMoment);
    assert.match(block, /It did not say when it lifts\./);
    assert.match(block, /Stop the tasks\./);
    assert.match(block, /find that out before choosing/);
    assert.doesNotMatch(block, /inside the hour/);
    assert.doesNotMatch(block, /further off than the hour/);
  });

  // Mutation: let the week into the choice about when everything lifts. The five-hour window is
  // twenty minutes off here and the week is five days off, so a choice that reads both tells the
  // lead to end every conversation in the workspace over a wait of twenty minutes.
  //
  // The week's own sentence is cut out and read alone, because what is being asserted about it is
  // that it carries NO instruction — and the block it sits in is nothing but instructions.
  it("says the week is nearly gone too, and tells the lead nothing to do about it", () => {
    const block = usageBlock(toldTheWeekIsFullToo);
    assert.match(block, /five-hour usage window was 96% full/);
    assert.match(block, /pause everybody where they are/);
    assert.doesNotMatch(block, /park everybody, yourself included/);

    const week = block.split("\n\n").find((said) => said.startsWith("The seven-day usage window was"));
    assert.ok(week !== undefined, `nothing said about the week in: ${block}`);
    assert.match(week, /97% full in the same reading/);
    assert.match(week, /Nothing here tells you what to do about that/);
    assert.doesNotMatch(week, /Stop the tasks|pause everybody|park everybody|Plan what is left|hand each one over/);
  });

  // Mutation: name the week without asking whether it is still running. MEASURED: before this check
  // existed, removing that test from the search changed nothing anywhere in the suite — the guard was
  // there and right and nothing watched it. The window this rule is about has the same check beside
  // it; this is the same rule asked of the window merely mentioned, which is why both are dropped by
  // one comparison rather than two.
  it("says nothing about a week that has already ended", () => {
    const block = usageBlock(toldWhenTheWeekHasEnded);
    assert.match(block, /five-hour usage window was 96% full/, "the fixture said nothing at all");
    assert.doesNotMatch(block, /seven-day usage window was/);
    assert.doesNotMatch(block, /97% full/);
  });

  // Mutation: refuse in inTurn when the account is over the stop line — the one funnel the offline
  // gate already runs through, which is exactly where somebody would put this if they read it as a
  // rule the toolkit enforces rather than one it tells a person about.
  //
  // It is a reading and the software parks nobody: the lead decides, and everything goes on working
  // meanwhile, including the turns the lead needs in order to act on it.
  it("runs a message for a worker as usual while the account is over the stop line", () => {
    assert.equal(ranAfterTheWorkerWasAsked, ranBeforeTheWorkerWasAsked + 1, "the worker's turn never ran");
    assert.match(askedTheWorker, /a worker is asked something while the account is nearly out/);
  });
});


const WAITS_WHILE_IT_FILLS = "Siskin";

// Where the account stands is read where the turn begins, and not where the message arrived.
//
// The other reading pushed at the lead has the same check for the same reason, and this one matters
// more: a message that waits behind a long turn is waiting on the very thing that is spending the
// window. By the time it is answered the account can be somewhere else entirely, and the whole
// worth of this reading is that it describes the account the turn is about to spend from.
//
// The stand-in is set to report a nearly-gone window here, so the thing that crosses the line is the
// turn ahead — the account really is filled up by the run that is holding this message in the
// queue, which is the case this is about rather than a stand-in for it.
describe("where the account stands is read where the turn begins and not where the message arrived", () => {
  const filledLog = path.join(standIn, "filled.txt");
  let deepEnough;
  let stillGoing;
  let toldBeforeItFilled;
  let toldAfterTheWait;

  before(async () => {
    runTool(instance, ["hire", WAITS_WHILE_IT_FILLS], process.env);
    await start(instance, standInEnvironment(standIn, filledLog, { OW_STAND_IN_SLOW: "1500", OW_STAND_IN_FULLNESS: "0.96" }));
    assert.ok(await waitForHealth(URL), "the server never answered");

    // A turn each, so both have a thread and a clock.
    await say("something, so this one has run", WAITS_WHILE_IT_FILLS);
    await say("and the lead, so it has one too", LEADER);

    // And now the account is put back under the line, on the freshest readings in the instance —
    // so nothing is said on the turn below, and the state that makes this check mean anything is
    // that the line is crossed AFTER its message was taken.
    stageWindows(WAITS_WHILE_IT_FILLS, [window("five_hour", 0.31, 180), window("seven_day", 0.15, 5 * 24 * 60)], 1);
    stageWindows(LEADER, [window("five_hour", 0.31, 180), window("seven_day", 0.15, 5 * 24 * 60)]);

    // The lead's first message, left running. Not awaited: the second has to arrive while this one
    // still holds the turn.
    const going = say("the first thing, which takes a while and spends the window", LEADER);
    await waitFor(async () => {
      const row = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((session) => session.name === LEADER);
      return row?.busy === true ? row : null;
    });

    // The second, joining the queue behind it. Waited for as a DEPTH and not as a duration: the row
    // says how many are behind the one being answered, so this is the server saying the message is
    // in and has not been read, rather than a sleep hoping it is.
    const queued = say("the second thing, which waits behind the first");
    deepEnough = await waitFor(async () => {
      const row = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((session) => session.name === LEADER);
      return (row?.queued ?? 0) >= 1 ? row : null;
    });

    // The first turn is still the one running, or the wait proved nothing: a session answers one
    // message at a time, so the second cannot have been read while this is true. The line is crossed
    // when this turn ends and writes what the service told it — after its message was taken.
    stillGoing = JSON.parse((await get(`${URL}/sessions`)).body).sessions.find((session) => session.name === LEADER);

    await going;
    await queued;

    // Both by POSITION and neither by "the last one". The second turn starts the moment the first
    // finishes, so a reading taken when the first settles is a race with the question after it. This
    // log belongs to this describe alone and holds these four questions in the order they were
    // asked: the two that gave each session a clock, then the one that ran long, then the one that
    // waited behind it.
    const asked = questionsIn(filledLog);
    assert.equal(asked.length, 4, `expected the four questions of this describe, got ${asked.length}`);
    toldBeforeItFilled = asked[2];
    toldAfterTheWait = asked[3];
  });

  // Mutation: compose what goes in front of a turn in the route handler, where the message arrives,
  // and pass it down into the turn. The account was a third full when this message was taken, so the
  // lead is handed nothing about a window its own last turn finished off — and every check above
  // stays green, because each of them asks a question that was answered at once.
  it("says where the account stands when the waiting message is finally read", () => {
    assert.equal(stillGoing?.busy, true, "the first turn had already finished, so nothing waited");
    assert.ok((deepEnough?.queued ?? 0) >= 1, "the second message never queued behind the first");
    const block = usageBlock(toldAfterTheWait);
    assert.notEqual(block, "", `no block at all in: ${toldAfterTheWait}`);
    assert.match(block, /five-hour usage window was 96% full/);
    assert.match(block, /Stop the tasks/);
  });

  // The other half of it, and what stops the check above passing on an account that was nearly gone
  // all along. Read against THIS state's own words: the suite installs one instance and everything
  // before this has been writing into it.
  it("said nothing about it on the turn that began before the line was crossed", () => {
    assert.doesNotMatch(toldBeforeItFilled, /96% full/);
    assert.doesNotMatch(toldBeforeItFilled, /Stop the tasks/);
  });
});


// Tools an instance serves that the toolkit did not ship: one file in plugins/, its name the
// tool's name, read when the chat starts and served beside the four the repository decides.
//
// The suite installs ONE instance and one chat, so this writes its files, starts the chat again to
// pick them up, and takes them away again afterwards — a plugin left behind would be a tool every
// check written after this one was silently offered.
describe("an instance serves a tool of its own", () => {
  const directory = path.join(instance, "plugins");
  const written = `// A tool this instance serves itself.
export const description = "Say a word back, with the name of whoever asked.";
export const inputSchema = {
  type: "object",
  properties: { word: { type: "string", description: "The word to say back." } },
  required: ["word"],
  additionalProperties: false,
};
export function run({ word }, { caller }) {
  return { text: \`\${caller} said \${word}\` };
}
`;

  async function offeredTo(who) {
    return JSON.parse((await call(who, "tools/list")).body).result.tools.map((tool) => tool.name);
  }

  let offered;
  let answered;

  before(async () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "echo.mjs"), written);
    // Beside it, what somebody leaves beside a plugin. It is not a module and must not become a
    // tool called notes.
    fs.writeFileSync(path.join(directory, "notes.txt"), "what this one is for\n");
    // And a module one directory down, which is a plugin's working parts and not a plugin: a
    // plugin is a file in this directory, never anything underneath it.
    fs.mkdirSync(path.join(directory, "lib"), { recursive: true });
    fs.writeFileSync(path.join(directory, "lib", "helper.mjs"), "export const description = \"not a tool\";\n");
    await start(instance, standIns);
    assert.ok(await waitForHealth(URL), "the server never came back with the plugin in place");

    offered = JSON.parse((await call(WORKER, "tools/list")).body).result.tools;
    answered = answerOf(await call(WORKER, "tools/call", { name: "echo", arguments: { word: "hello" } }));
  });

  // Put back what this describe put there, so that nothing after it is offered a tool it never
  // asked for and the instance is the one every other check was written against.
  after(async () => {
    fs.rmSync(directory, { recursive: true, force: true });
    await start(instance, standIns);
    assert.ok(await waitForHealth(URL), "the server never came back without the plugin");
  });

  it("offers it with the description it was written with", () => {
    assert.equal(offered.find((tool) => tool.name === "echo")?.description, "Say a word back, with the name of whoever asked.");
  });

  // The census, and the check the whole arrangement rests on: a plugin joins the list a session
  // reads, and joining it is the whole of being granted, so a tool appearing there unnoticed is
  // the way this goes wrong. Everything beside a plugin that is not one stays out — a file that is
  // not a module is not a tool called notes.
  it("offers a worker the tools it always did and this one, and nothing else", async () => {
    assert.deepEqual((await offeredTo(WORKER)).sort(), ["echo", "say", "status"]);
  });

  it("serves the input schema the plugin declared", () => {
    assert.deepEqual(offered.find((tool) => tool.name === "echo")?.inputSchema.required, ["word"]);
  });

  // Read as the whole sentence rather than as a name in it. The handler is handed the arguments of
  // the call and the name of whoever made it, and the caller here is a worker — so a context built
  // out of the instance's own leader name answers with somebody who never called, and a call made
  // with nothing answers about a word nobody said. One check, because a looser one asserting only
  // that the word came back would be reddened by no edit this one does not already catch.
  it("answers with what the handler made of the arguments and of who called", () => {
    assert.equal(answered.text, `${WORKER} said hello`);
  });

  // What stands where a permission rule cannot. A plugin runs in the chat rather than in a
  // session, so nothing stops it once it is there; what a session may do is write its own desk and
  // nothing else, which is why a session cannot give itself a tool. Read off the rules the
  // instance actually launches its sessions with, never assumed.
  it("grants no session the right to write a tool of the instance's own", () => {
    const granted = JSON.parse(fs.readFileSync(path.join(instance, ".claude", "settings.json"), "utf8")).permissions.allow;
    const writes = granted.filter((rule) => rule.startsWith("Edit("));
    assert.ok(writes.length > 0, "the instance granted nothing at all, so this proves nothing");
    const reaching = writes.filter((rule) => {
      const target = path.resolve(instance, rule.slice("Edit(".length, -1));
      return !path.relative(directory, target).startsWith("..");
    });
    assert.deepEqual(reaching, []);
  });
});
