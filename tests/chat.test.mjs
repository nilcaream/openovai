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

// Every question the stand-in was handed, whole. A question can now carry what a session overheard
// in front of it, so it runs to several lines and heardIn(), which is line-based, would see only
// the first of them. The log is split on the lines that begin an entry.
function questionsIn(log) {
  return readLog(log)
    .split(/^(?=(?:call|pid|heard|told|said|shell|answered|stdin): )/m)
    .filter((entry) => entry.startsWith("heard: "))
    .map((entry) => entry.slice("heard: ".length).trimEnd());
}

async function start(root, environment) {
  await stopChat(server);
  server = startChat(root, environment);
  return server;
}

remove(instance, chosen, quiet, nested, standIn);
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
    assert.ok(!asked.split("</overheard>").at(-1).includes("<"));
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

  it("wraps what it asks, so nothing reaches the session as though the human had typed it", () => {
    const asked = questionsIn(handoverLog).find((question) => question.includes("STATE.md"));
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
    assert.ok((await get(`${URL}/`)).body.includes("composer.append(box, send, hand)"));
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
    order = readLog(queuedLog)
      .split("\n")
      .filter((line) => line.includes("takes a while") || line.includes("<handover>"))
      .map((line) => `${line.startsWith("heard") ? "began" : "ended"} ${line.includes("<handover>") ? "handover" : "turn"}`);
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
