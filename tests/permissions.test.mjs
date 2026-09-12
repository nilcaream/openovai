// Being asked whether a session may use a tool: what the page is shown, what answering does, and
// which rule a button could grant for good.
//
// The first half calls tools/chat/permissions.mjs directly for the rule a request composes; the
// second serves a chat in this process, starts a seat whose stand-in asks before every answer,
// and drives the page's own routes. The desktop pop is checked here too, because a session
// stopped on a question is what it is for.
//
// Every mutation in tests/mutations-permissions.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { shapeOf } from "../tools/chat/permissions.mjs";
import { QUIET_HOURS, quietHoursProblem, withinQuietHours } from "../tools/chat/pop.mjs";
import { pageSecret } from "../tools/chat/secrets.mjs";
import { endSeat, serve, startSeat } from "../tools/chat/server.mjs";
import { endEvery } from "../tools/chat/session.mjs";
import { LEDGER } from "../tools/desks.mjs";
import { CONFIG_FILE } from "../tools/seed.mjs";
import { installed, remove, repo, scratch, secretsIn, waitFor, writeStandIn } from "./helpers.mjs";
import { settingsProblems } from "./inspect.mjs";

const USER = "Mike";
const LEADER = "Superman";

const base = scratch("permissions-test");
const instance = `${base}-instance`;
const standIn = `${base}-stand-in`;
const AT = instance;

process.on("exit", () => {
  remove(instance, standIn);
});

// ---------------------------------------------------------------------------------------------
// The rule a request could be allowed by: composed from what was asked, never from what the page
// says was asked.

describe("the rule a call could be allowed by", () => {
  const composed = [
    ["a command", "Bash", { command: "node --test tests" }, "Bash(node:*)"],
    ["a command with nothing after it", "Bash", { command: "ls" }, "Bash(ls:*)"],
    ["the same command, spaced oddly", "Bash", { command: "  node   --test tests " }, "Bash(node:*)"],
    // A rule is a literal prefix rather than a path or a command line, so a first word carrying a
    // slash, a tilde, a dollar or a quote makes a rule that matches something other than what the
    // person read on the button.
    ["a script somewhere", "Bash", { command: "~/bin/deploy --now" }, null],
    ["a script here", "Bash", { command: "./release.sh" }, null],
    ["a command out of a variable", "Bash", { command: "$TOOL --go" }, null],
    ["a quoted first word", "Bash", { command: '"a b" c' }, null],
    ["nothing at all", "Bash", { command: "   " }, null],
    ["a command that is not one", "Bash", { file_path: "notes.txt" }, null],
    // Reading is never stopped, so a rule for it is a grant nobody was ever asked for; Glob and
    // Grep do not exist in the harness at all, and a session asking for either is told so.
    ["reading a file", "Read", { file_path: "notes.txt" }, null],
    ["a search", "Grep", { pattern: "needle" }, null],
    // Granted the moment the chat offers it, and a rule can name a server and a tool, never an
    // argument — so there is nothing narrower here to offer.
    ["one of the chat's own tools", "mcp__openovai__message", { to: LEADER }, null],
  ];

  for (const [what, tool, input, rule] of composed) {
    it(rule === null ? `offers nothing for ${what}` : `offers ${rule} for ${what}`, () => {
      assert.equal(shapeOf({ id: "request-1", tool, input }, AT), rule);
    });
  }
});

// The other shape, which names a path rather than a call. A rule naming a DIRECTORY is honoured as
// the whole subtree under it, a rule naming one FILE is that file alone, and `Edit(...)` is what
// governs a write whatever tool made it — a `Write(...)` rule matches nothing.
describe("the rule a write could be allowed by", () => {
  function forWriting(tool, file_path) {
    return shapeOf({ id: "request-1", tool, input: { file_path } }, AT);
  }

  it("composes the rule that governs writing, and never one that matches nothing", () => {
    assert.match(forWriting("Write", `${AT}/work/Wren/notes.md`), /^Edit\(/);
  });

  it("composes a rule for the directory the write was in", () => {
    assert.equal(forWriting("Edit", `${AT}/work/Wren/notes.md`), "Edit(work/Wren/**)");
  });

  it("composes the spelling that says a subtree out loud", () => {
    const rule = forWriting("Write", `${AT}/work/Wren/sub/deep.md`);
    assert.equal(rule, "Edit(work/Wren/sub/**)");
    assert.ok(rule.endsWith("/**)"), rule);
  });

  it("composes a rule at the root with no ./ in front of it", () => {
    assert.equal(forWriting("Write", `${AT}/notes.md`), "Edit(**)");
  });

  it("composes no rule for a write outside the instance", () => {
    assert.equal(forWriting("Write", "/etc/hosts"), null);
    assert.equal(forWriting("Edit", `${AT}/../elsewhere/notes.md`), null);
    assert.equal(forWriting("Write", AT), null);
  });

  it("names no place on this machine in the rule it composes", () => {
    const rule = forWriting("Edit", `${AT}/work/Wren/notes.md`);
    assert.ok(!rule.includes(AT), rule);
    assert.ok(!/\((\/|~|\/\/)/.test(rule), rule);
  });

  it("offers a button only where the request says what the class of calls is", () => {
    assert.equal(forWriting("NotebookEdit", `${AT}/work/Wren/notes.ipynb`), null);
    assert.equal(forWriting("MultiEdit", `${AT}/work/Wren/notes.md`), null);
    assert.equal(forWriting("Read", `${AT}/work/Wren/notes.md`), null);
  });

  it("composes nothing for a write that names no path", () => {
    assert.equal(shapeOf({ id: "request-1", tool: "Write", input: { command: "ls" } }, AT), null);
    assert.equal(forWriting("Write", "   "), null);
  });
});

// ---------------------------------------------------------------------------------------------
// The window in which nobody's desktop is disturbed.

describe("the hours a workspace is not to be woken", () => {
  // The machine's own clock: a moment is built from local hours, the way the window reads them.
  function at(hours, minutes) {
    const moment = new Date();
    moment.setHours(hours, minutes, 0, 0);
    return moment;
  }

  it("takes a window as two times of day and a hyphen, or nothing at all", () => {
    assert.equal(quietHoursProblem("22:00-08:00"), null);
    assert.equal(quietHoursProblem(undefined), null);
  });

  it("refuses a window it cannot read, naming the field", () => {
    assert.match(quietHoursProblem("22-08"), new RegExp(`^${QUIET_HOURS} is "22-08", which is not a window`));
    assert.match(quietHoursProblem({ from: "22:00", to: "08:00" }), new RegExp(`^${QUIET_HOURS} is `));
    assert.match(quietHoursProblem("22:00-22:00"), /no time at all/);
  });

  it("is half-open, and a window whose end is before its start wraps midnight", () => {
    assert.equal(withinQuietHours("22:00-08:00", at(23, 30)), true);
    assert.equal(withinQuietHours("22:00-08:00", at(3, 0)), true);
    assert.equal(withinQuietHours("22:00-08:00", at(22, 0)), true);
    assert.equal(withinQuietHours("22:00-08:00", at(8, 0)), false);
    assert.equal(withinQuietHours("22:00-08:00", at(12, 0)), false);
    assert.equal(withinQuietHours("13:00-14:00", at(13, 30)), true);
    assert.equal(withinQuietHours("13:00-14:00", at(14, 0)), false);
    assert.equal(withinQuietHours(undefined, at(23, 30)), false);
  });
});

// ---------------------------------------------------------------------------------------------
// Over the chat.

function options(root) {
  return {
    "--root": root,
    "--source": repo,
    "--user": USER,
    "--leader": LEADER,
    "--leader-model": "sonnet",
    "--worker-model": "sonnet",
    "--port": 0,
    "--auth": "login",
  };
}

const pops = [];
let chat = null;
let server = null;
let url = null;
let log_ = null;

function page(method, route, body) {
  return fetch(`${url}${route}`, {
    method,
    headers: { authorization: `Bearer ${pageSecret()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (answered) => ({ status: answered.status, body: await answered.text() }));
}

let logs = 0;
async function leaderAsking(knobs) {
  logs += 1;
  const log = path.join(standIn, `asking-${logs}.txt`);
  const before_ = { ...process.env };
  Object.assign(process.env, { OPENOVAI_STAND_IN_LOG: log, PATH: `${standIn}${path.delimiter}${before_.PATH}`, ...knobs });
  let started;
  try {
    started = startSeat(chat, LEADER);
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in before_)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, before_);
  }
  assert.ok(await waitFor(() => secretsIn(log).length > 0), "the Leader never logged its secret");
  return { ...started, log };
}

// Type to the Leader and answer with the row its reply lands in.
async function say(text) {
  const rows = JSON.parse((await page("GET", `/sessions/${LEADER}/messages`)).body).messages.length;
  const answered = await page("POST", `/sessions/${LEADER}/message`, { text });
  assert.equal(answered.status, 200, answered.body);
  return async () => {
    const reply = await waitFor(async () => {
      const { messages } = JSON.parse((await page("GET", `/sessions/${LEADER}/messages`)).body);
      return messages.length >= rows + 2 ? messages[rows + 1] : null;
    });
    assert.ok(reply !== null, "the Leader never answered");
    return reply;
  };
}

async function waitingOn() {
  const found = await waitFor(async () => {
    const { permissions } = JSON.parse((await page("GET", `/sessions/${LEADER}/permissions`)).body);
    return permissions.length > 0 ? permissions : null;
  });
  assert.ok(found !== null, "nothing was ever shown as waiting");
  return found;
}

describe("asking to be allowed", () => {
  before(async () => {
    remove(instance, standIn);
    writeStandIn(standIn);
    installed(options(instance));
    chat = { root: instance, config: JSON.parse(fs.readFileSync(path.join(instance, CONFIG_FILE), "utf8")), plugins: [], pop: (asked) => pops.push(asked) };
    log_ = console.log;
    console.log = () => {};
    server = await serve(chat);
    url = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await endEvery(500);
    await new Promise((resolve) => server.close(resolve));
    console.log = log_;
  });

  describe("what the page is shown", () => {
    let asking;
    let reply;

    before(async () => {
      await leaderAsking({ OPENOVAI_STAND_IN_ASKS: "Bash" });
      reply = await say("go and look");
      asking = await waitingOn();
    });

    after(async () => {
      await page("POST", `/sessions/${LEADER}/permission`, { id: asking[0].id, decision: "deny" });
      await reply();
      await endSeat(LEADER, 500);
    });

    it("shows the request while the run waits on it, and answers nothing on its own", async () => {
      assert.equal(asking.length, 1);
      assert.equal(asking[0].tool, "Bash");
      assert.deepEqual(asking[0].input, { command: "the one it wanted to run" });
      const still = JSON.parse((await page("GET", `/sessions/${LEADER}/permissions`)).body).permissions;
      assert.equal(still.length, 1, "something answered it that was not a person");
    });

    it("pops the desktop once, saying who is stopped and on what", () => {
      assert.equal(pops.length, 1);
      assert.equal(pops[0].on, LEADER);
      assert.match(pops[0].why, new RegExp(`^${LEADER} is stopped, waiting to be allowed to use Bash$`));
    });
  });

  describe("what the page is shown about a different request", () => {
    let asking;
    let reply;

    before(async () => {
      await leaderAsking({ OPENOVAI_STAND_IN_ASKS: "Read", OPENOVAI_STAND_IN_ASKS_INPUT: "the other one it wanted" });
      reply = await say("go and read");
      asking = await waitingOn();
    });

    after(async () => {
      await page("POST", `/sessions/${LEADER}/permission`, { id: asking[0].id, decision: "deny" });
      await reply();
      await endSeat(LEADER, 500);
    });

    it("says which tool that one wants, and what it was going to be given", () => {
      assert.equal(asking[0].tool, "Read");
      assert.deepEqual(asking[0].input, { command: "the other one it wanted" });
    });
  });

  describe("allowing it", () => {
    let replied;

    before(async () => {
      await leaderAsking({ OPENOVAI_STAND_IN_ASKS: "Bash" });
      const reply = await say("this one is allowed");
      const asking = await waitingOn();
      const said = await page("POST", `/sessions/${LEADER}/permission`, { id: asking[0].id, decision: "allow" });
      assert.deepEqual(JSON.parse(said.body), { answered: asking[0].id, decision: "allow" });
      replied = await reply();
    });

    after(async () => {
      await endSeat(LEADER, 500);
    });

    it("tells the run it was allowed, and the run finishes", () => {
      assert.equal(replied.from, LEADER);
      assert.equal(replied.text, "I was told allow");
    });

    it("stops showing the request once a person has answered", async () => {
      const { permissions } = JSON.parse((await page("GET", `/sessions/${LEADER}/permissions`)).body);
      assert.equal(permissions.length, 0);
    });
  });

  describe("refusing it", () => {
    let replied;

    before(async () => {
      await leaderAsking({ OPENOVAI_STAND_IN_ASKS: "Bash" });
      const reply = await say("this one is not");
      const asking = await waitingOn();
      await page("POST", `/sessions/${LEADER}/permission`, { id: asking[0].id, decision: "deny", why: "not from here" });
      replied = await reply();
    });

    after(async () => {
      await endSeat(LEADER, 500);
    });

    it("tells the run it was refused, and why", () => {
      assert.equal(replied.text, "I was told deny: not from here");
    });
  });

  describe("refusing it without a word", () => {
    let replied;

    before(async () => {
      await leaderAsking({ OPENOVAI_STAND_IN_ASKS: "Bash" });
      const reply = await say("this one is not either");
      const asking = await waitingOn();
      await page("POST", `/sessions/${LEADER}/permission`, { id: asking[0].id, decision: "deny" });
      replied = await reply();
    });

    after(async () => {
      await endSeat(LEADER, 500);
    });

    it("gives the run the chat's own reason", () => {
      assert.equal(replied.text, "I was told deny: not allowed from the chat");
    });
  });

  describe("answering what nobody asked", () => {
    it("is refused, with nothing to answer", async () => {
      const said = await page("POST", `/sessions/${LEADER}/permission`, { id: "request-99", decision: "allow" });
      assert.equal(said.status, 409);
      const always = await page("POST", `/sessions/${LEADER}/permission`, { id: "request-99", decision: "always" });
      assert.equal(always.status, 409);
    });

    it("is refused when the answer is not one of the three, or names no request", async () => {
      assert.equal((await page("POST", `/sessions/${LEADER}/permission`, { id: "request-1", decision: "maybe" })).status, 400);
      assert.equal((await page("POST", `/sessions/${LEADER}/permission`, { decision: "allow" })).status, 400);
    });
  });

  describe("allowing the shape and not only the call", () => {
    const RULE = "Bash(node:*)";
    const settings = path.join(instance, ".claude", "settings.json");
    const ledger = path.join(instance, LEDGER);
    let shown;
    let replied;
    let said;

    function allowed() {
      return JSON.parse(fs.readFileSync(settings, "utf8")).permissions.allow;
    }

    function lines() {
      return fs.readFileSync(ledger, "utf8").split("\n").filter((line) => line.startsWith("- `"));
    }

    before(async () => {
      await leaderAsking({ OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_ASKS_INPUT: "node --test tests" });
      const reply = await say("this one is worth allowing for good");
      shown = (await waitingOn())[0];
      said = await page("POST", `/sessions/${LEADER}/permission`, { id: shown.id, decision: "always" });
      replied = await reply();
    });

    after(async () => {
      await endSeat(LEADER, 500);
    });

    it("tells the page which rule would allow it", () => {
      assert.equal(shown.shape, RULE);
    });

    it("lets the run finish, allowed", () => {
      assert.equal(replied.text, "I was told allow");
    });

    it("says which rule it granted", () => {
      assert.deepEqual(JSON.parse(said.body), { answered: shown.id, decision: "always", granted: RULE });
    });

    it("grants exactly that rule and nothing else", () => {
      assert.ok(allowed().includes(RULE), allowed().join(", "));
      assert.deepEqual(allowed().filter((rule) => rule.startsWith("Bash(")), [RULE]);
    });

    it("writes down who asked for it, when, and what for", () => {
      const written = lines();
      assert.equal(written.length, 1, written.join(" / "));
      assert.ok(written[0].startsWith(`- \`${RULE}\` `), written[0]);
      assert.match(written[0], new RegExp(LEADER));
      assert.match(written[0], /node --test tests/);
      assert.match(written[0], new RegExp(new Date().toISOString().slice(0, 10)));
    });

    it("still adds up", () => {
      assert.ok(!settingsProblems(settings, [LEADER]).join(" ").includes("Bash("), "the rule it granted is not accounted for");
    });

    it("grants it to the workspace and remembers who asked", () => {
      assert.ok(!RULE.includes(LEADER));
      assert.match(lines()[0], new RegExp(LEADER));
    });
  });

  describe("allowing a write, and not only the file it named", () => {
    const RULE = "Edit(.tmp/onboarding/**)";
    const settings = path.join(instance, ".claude", "settings.json");
    const ledger = path.join(instance, LEDGER);
    let shown;
    let said;

    before(async () => {
      await leaderAsking({ OPENOVAI_STAND_IN_ASKS: "Write", OPENOVAI_STAND_IN_ASKS_FILE: path.join(instance, ".tmp", "onboarding", "notes.md") });
      const reply = await say("write it down");
      shown = (await waitingOn())[0];
      said = await page("POST", `/sessions/${LEADER}/permission`, { id: shown.id, decision: "always" });
      await reply();
    });

    after(async () => {
      await endSeat(LEADER, 500);
    });

    it("offers the directory the write was in, and grants it", () => {
      assert.equal(shown.shape, RULE);
      assert.deepEqual(JSON.parse(said.body), { answered: shown.id, decision: "always", granted: RULE });
      assert.ok(JSON.parse(fs.readFileSync(settings, "utf8")).permissions.allow.includes(RULE));
    });

    it("writes down which write it was for", () => {
      const written = fs.readFileSync(ledger, "utf8").split("\n").filter((line) => line.startsWith(`- \`${RULE}\``));
      assert.equal(written.length, 1);
      assert.match(written[0], /\.tmp\/onboarding\/notes\.md/);
      assert.ok(!written[0].includes(instance), "the ledger names a place on this machine");
    });
  });

  describe("asking to allow a shape that cannot be composed", () => {
    let shown;
    let refused;
    let replied;

    before(async () => {
      await leaderAsking({ OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_ASKS_INPUT: "~/bin/deploy --now" });
      const reply = await say("run the script");
      shown = (await waitingOn())[0];
      refused = await page("POST", `/sessions/${LEADER}/permission`, { id: shown.id, decision: "always" });
      await page("POST", `/sessions/${LEADER}/permission`, { id: shown.id, decision: "deny" });
      replied = await reply();
    });

    after(async () => {
      await endSeat(LEADER, 500);
    });

    it("sends the page no rule to put on a button", () => {
      assert.equal(shown.shape, undefined);
    });

    it("refuses to grant one, and leaves the call unanswered", () => {
      assert.equal(refused.status, 400);
      assert.match(JSON.parse(refused.body).error, /no rule that would allow that/);
      assert.equal(replied.text, "I was told deny: not allowed from the chat");
    });
  });

  describe("a run that ends with its question up", () => {
    it("takes the question down with it", async () => {
      await leaderAsking({ OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_WAITS: "100" });
      const reply = await say("ask and go");
      await waitingOn();
      await reply();
      await endSeat(LEADER, 500);
      const { permissions } = JSON.parse((await page("GET", `/sessions/${LEADER}/permissions`)).body);
      assert.deepEqual(permissions, []);
    });
  });

  describe("a desktop inside its quiet hours", () => {
    let asking;
    let reply;

    before(async () => {
      // A window covering this minute whatever the clock says: from now to the minute before now.
      const now = new Date();
      const before_ = new Date(now.getTime() - 60 * 1000);
      const clock = (moment) => `${String(moment.getHours()).padStart(2, "0")}:${String(moment.getMinutes()).padStart(2, "0")}`;
      chat.config = { ...chat.config, [QUIET_HOURS]: `${clock(now)}-${clock(before_)}` };
      pops.length = 0;
      await leaderAsking({ OPENOVAI_STAND_IN_ASKS: "Bash" });
      reply = await say("quietly");
      asking = await waitingOn();
    });

    after(async () => {
      await page("POST", `/sessions/${LEADER}/permission`, { id: asking[0].id, decision: "deny" });
      await reply();
      await endSeat(LEADER, 500);
      delete chat.config[QUIET_HOURS];
    });

    it("is not popped, though the question is shown", () => {
      assert.equal(asking.length, 1);
      assert.deepEqual(pops, []);
    });
  });
});
