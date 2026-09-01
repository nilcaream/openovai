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
  waitFor,
  waitForAddress,
  waitForHealth,
  writeStandIn,
} from "./helpers.mjs";

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
const standIn = `${instance}-stand-in`;
const log = path.join(standIn, "calls.txt");

let server;

process.on("exit", () => {
  server?.kill();
  remove(instance, chosen, quiet, standIn);
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

async function start(root, environment) {
  await stopChat(server);
  server = startChat(root, environment);
  return server;
}

remove(instance, chosen, quiet, standIn);
writeStandIn(standIn);
installed(options(instance, PORT));
installed(options(quiet, 0));
runTool(instance, ["hire", WORKER], process.env);

const standIns = standInEnvironment(standIn, log);

// What the chat puts in a session's environment, so a check can run the command the way a session
// runs it: signed with the name of whoever is speaking.
const asLeader = standInEnvironment(standIn, log, { OW_SESSION_NAME: LEADER });
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

  it("keeps that message out of the lead's transcript", async () => {
    assert.ok(!(await transcriptOf(LEADER)).body.includes("what are you working on"));
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

  it("leaves it in the transcript of the session it was said to", async () => {
    assert.ok(!(await transcriptOf(LEADER)).body.includes("how is it going"));
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
    assert.ok(!heardIn(log).at(-1).includes("<from-session"));
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
      assert.ok(heardIn(log).at(-1).includes(`<from-session name="${LEADER}" role="lead">`));
    });

    it("says what the sender is, not only who", () => {
      assert.ok(heardIn(log).at(-1).includes('role="lead"'));
    });

    it("hands over what was said inside the wrapper", () => {
      assert.match(heardIn(log).at(-1), /<from-session[^>]*>this one is mine<\/from-session>/);
    });

    it("keeps it in the transcript under the name of who sent it", async () => {
      const messages = JSON.parse((await transcriptOf(WORKER)).body).messages;
      assert.equal(messages.find((message) => message.text === "this one is mine").from, LEADER);
    });

    it("keeps the wrapper out of the transcript", async () => {
      assert.ok(!(await transcriptOf(WORKER)).body.includes("from-session"));
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
    const order = readLog(slowLog)
      .split("\n")
      .filter((line) => line.includes("one at a time") || line.includes("and me, when"))
      .map((line) => `${line.startsWith("heard") ? "began" : "ended"} ${line.includes("one at a time") ? "first" : "second"}`);
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
describe("one session waiting does not hold up another", () => {
  const bothLog = path.join(standIn, "both.txt");

  before(async () => {
    await start(instance, standInEnvironment(standIn, bothLog, { OW_STAND_IN_SLOW: "700" }));
    assert.ok(await waitForHealth(URL), "the server never answered");
    await Promise.all([say("the worker's own", WORKER), say("the lead's own", LEADER)]);
  });

  it("runs them at the same time", () => {
    const order = readLog(bothLog)
      .split("\n")
      .filter((line) => line.includes("the worker's own") || line.includes("the lead's own"))
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
    assert.ok(heardIn(askedLog).at(-1).includes("a question of its own"));
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

    it("leaves nothing waiting once the run is over", async () => {
      const left = JSON.parse((await get(`${URL}/sessions/${LEADER}/permissions`)).body).permissions;
      assert.deepEqual(left, []);
    });
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

  // A run can end with its question still on the page: it gave up waiting, or it fell over. What
  // must not survive it is the offer to answer — allowing something after the run that asked has
  // gone would be a button that does nothing and says otherwise.
  describe("a run that ends while its question is still up", () => {
    let answered;

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
      await waitingOn(LEADER);
      answered = await exchange;
    });

    after(async () => {
      await start(instance, standInEnvironment(standIn, askedLog, { OW_STAND_IN_ASKS: "Bash" }));
      assert.ok(await waitForHealth(URL), "the server never answered");
    });

    it("finishes without the answer it asked for", () => {
      assert.equal(answered.status, 200);
    });

    it("takes the question down with it", async () => {
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
