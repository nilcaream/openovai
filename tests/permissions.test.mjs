// Being asked whether a session may use a tool: what the page is shown, what answering does, and
// which rule a button could grant for good.
//
// The first half calls lib/chat/permissions.mjs directly for the rule a request composes; the
// second serves a chat in this process, starts a seat whose stand-in asks before every answer,
// and drives the page's own routes.
//
// Every mutation in tests/mutations-permissions.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { subscribe } from "../lib/chat/events.mjs";
import { sink } from "../lib/chat/log.mjs";
import { acceptRule, shapeOf } from "../lib/chat/permissions.mjs";
import { pageSecret } from "../lib/chat/secrets.mjs";
import { endSeat, serve, startSeat, toolsFor } from "../lib/chat/server.mjs";
import { LEADER as LEADS, WORKER } from "../lib/desks.mjs";
import { endEvery } from "../lib/chat/session.mjs";
import { LEDGER, ruleAsked } from "../lib/desks.mjs";
import { CONFIG_FILE } from "../lib/seed.mjs";
import { heardIn, installed, post, remove, repo, scratch, secretsIn, waitFor, writeStandIn } from "./helpers.mjs";
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

describe("the rules a call could be allowed by", () => {
  const composed = [
    ["a command", "Bash", { command: "node --test tests" }, ["Bash(node:*)"]],
    ["a command with nothing after it", "Bash", { command: "make" }, ["Bash(make:*)"]],
    ["the same command, spaced oddly", "Bash", { command: "  node   --test tests " }, ["Bash(node:*)"]],
    // A rule is a literal prefix rather than a path or a command line, so a first word carrying a
    // slash, a tilde, a dollar or a quote makes a rule that matches something other than what the
    // person read on the button.
    ["a script somewhere", "Bash", { command: "~/bin/deploy --now" }, null],
    ["a script here", "Bash", { command: "./release.sh" }, null],
    ["a command out of a variable", "Bash", { command: "$TOOL --go" }, null],
    ["a quoted first word", "Bash", { command: '"a b" c' }, null],
    ["nothing at all", "Bash", { command: "   " }, null],
    ["a command that is not one", "Bash", { file_path: "notes.txt" }, null],
    // A rule must match each side of a compound on its own, so one rule per side that nothing
    // matches yet, in the order written, and the sides Claude Code runs without asking — its
    // built-in read-only words — are not offered: a rule for one of those grants nothing.
    ["a compound with two sides nothing matches", "Bash", { command: "npm test && make build" }, ["Bash(npm:*)", "Bash(make:*)"]],
    ["a compound joined every way the shell joins", "Bash", { command: "npm test || make build; node x.mjs | sort" }, ["Bash(npm:*)", "Bash(make:*)", "Bash(node:*)", "Bash(sort:*)"]],
    ["a compound whose first side is a read-only word", "Bash", { command: "cd packages/api && npm test" }, ["Bash(npm:*)"]],
    ["a pipe into a read-only word", "Bash", { command: "npm ls | grep react" }, ["Bash(npm:*)"]],
    ["the same word on two sides", "Bash", { command: "npm ci && npm test" }, ["Bash(npm:*)"]],
    ["read-only words alone", "Bash", { command: "ls -la; cat notes.txt | head" }, null],
    ["a compound one side of which is a script", "Bash", { command: "npm test && ./release.sh" }, null],
    ["a compound with nothing after the operator", "Bash", { command: "npm test &&" }, null],
    ["a redirect, which is not a separator", "Bash", { command: "node run.mjs 2>&1" }, ["Bash(node:*)"]],
    ["a command put in the background", "Bash", { command: "node serve.mjs &" }, ["Bash(node:*)"]],
    // git is granted by its subcommand, the way the instance is born granting it and the way the
    // docs say to put the star: a rule for the bare word would reach git push through git status.
    ["a git subcommand", "Bash", { command: "git push origin main" }, ["Bash(git push:*)"]],
    ["git with an option before the subcommand", "Bash", { command: "git -C projects/app push" }, null],
    ["git alone", "Bash", { command: "git" }, null],
    // Reading is never stopped, so a rule for it is a grant nobody was ever asked for; Glob and
    // Grep do not exist in the harness at all, and a session asking for either is told so.
    ["reading a file", "Read", { file_path: "notes.txt" }, null],
    ["a search", "Grep", { pattern: "needle" }, null],
    // Granted the moment the chat offers it, and a rule can name a server and a tool, never an
    // argument — so there is nothing narrower here to offer.
    ["one of the chat's own tools", "mcp__openovai__message", { to: LEADER }, null],
  ];

  for (const [what, tool, input, rules] of composed) {
    it(rules === null ? `offers nothing for ${what}` : `offers ${rules.join(" and ")} for ${what}`, () => {
      assert.deepEqual(shapeOf({ id: "request-1", tool, input }, AT), rules);
    });
  }

  // The sides the instance already allows are not offered again: what is held is read from the
  // settings as they are now, whichever spelling of the trailing star they use, and a rule for an
  // exact command is that command alone.
  describe("against what the instance holds", () => {
    const root = `${base}-holding`;

    before(() => {
      remove(root);
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: ["mcp__openovai", "Bash(npm:*)", "Bash(git push *)", "Bash(make build)"] } }),
      );
    });

    after(() => remove(root));

    function forCommand(command) {
      return shapeOf({ id: "request-1", tool: "Bash", input: { command } }, root);
    }

    it("offers only the sides nothing held matches", () => {
      assert.deepEqual(forCommand("npm test && make build && node x.mjs"), ["Bash(node:*)"]);
    });

    it("offers nothing when every side is held or read-only", () => {
      assert.equal(forCommand("cd app && npm test"), null);
      assert.equal(forCommand("git push origin main"), null);
    });

    it("reads a rule for an exact command as that command alone", () => {
      assert.deepEqual(forCommand("make build --jobs 4"), ["Bash(make:*)"]);
      assert.equal(forCommand("make build"), null);
    });

    it("reads a held prefix by whole word, so npm does not hold npm-check", () => {
      assert.deepEqual(forCommand("npm-check --update"), ["Bash(npm-check:*)"]);
    });
  });
});

// The other shape, which names a path rather than a call. A rule naming a DIRECTORY is honoured as
// the whole subtree under it, a rule naming one FILE is that file alone, and `Edit(...)` is what
// governs a write whatever tool made it — a `Write(...)` rule matches nothing. The path is
// anchored with a leading `/`, which Claude Code reads as "from the instance root": a bare path
// is read from the session's current directory, which moves with every `cd`.
describe("the rule a write could be allowed by", () => {
  // A write composes one rule and never a list of them; the one, or nothing.
  function forWriting(tool, file_path) {
    const rules = shapeOf({ id: "request-1", tool, input: { file_path } }, AT);
    if (rules === null) {
      return null;
    }
    assert.equal(rules.length, 1, JSON.stringify(rules));
    return rules[0];
  }

  it("composes the rule that governs writing, and never one that matches nothing", () => {
    assert.match(forWriting("Write", `${AT}/projects/Wren/notes.md`), /^Edit\(/);
  });

  it("composes a rule for the directory the write was in", () => {
    assert.equal(forWriting("Edit", `${AT}/projects/Wren/notes.md`), "Edit(/projects/Wren/**)");
  });

  it("composes the spelling that says a subtree out loud", () => {
    const rule = forWriting("Write", `${AT}/projects/Wren/sub/deep.md`);
    assert.equal(rule, "Edit(/projects/Wren/sub/**)");
    assert.ok(rule.endsWith("/**)"), rule);
  });

  it("composes a rule at the root with no ./ in front of it", () => {
    assert.equal(forWriting("Write", `${AT}/notes.md`), "Edit(/**)");
  });

  it("composes no rule for a write outside the instance", () => {
    assert.equal(forWriting("Write", "/etc/hosts"), null);
    assert.equal(forWriting("Edit", `${AT}/../elsewhere/notes.md`), null);
    assert.equal(forWriting("Write", AT), null);
  });

  it("anchors the rule at the instance root and names no place on this machine", () => {
    const rule = forWriting("Edit", `${AT}/projects/Wren/notes.md`);
    assert.ok(!rule.includes(AT), rule);
    assert.ok(rule.startsWith("Edit(/"), rule);
    assert.ok(!/\((~|\/\/)/.test(rule), rule);
  });

  it("offers a button only where the request says what the class of calls is", () => {
    assert.equal(forWriting("NotebookEdit", `${AT}/projects/Wren/notes.ipynb`), null);
    assert.equal(forWriting("MultiEdit", `${AT}/projects/Wren/notes.md`), null);
    assert.equal(forWriting("Read", `${AT}/projects/Wren/notes.md`), null);
  });

  it("composes nothing for a write that names no path", () => {
    assert.equal(shapeOf({ id: "request-1", tool: "Write", input: { command: "ls" } }, AT), null);
    assert.equal(forWriting("Write", "   "), null);
  });
});

// The rules Claude Code itself would save for a call, carried in the request: the button for a
// tool nothing above composes for, and the button for a command or a write nothing composes for.
describe("the rule Claude Code suggested for a call", () => {
  const suggesting = (toolName, ruleContent) => [{ type: "addRules", behavior: "allow", destination: "localSettings", rules: [ruleContent === undefined ? { toolName } : { toolName, ruleContent }] }];
  const carried = [
    ["a fetch", "WebFetch", { url: "https://example.com/" }, suggesting("WebFetch", "domain:example.com"), ["WebFetch(domain:example.com)"]],
    ["a search", "WebSearch", { query: "needle" }, suggesting("WebSearch"), ["WebSearch"]],
    ["a command nothing here composes for", "Bash", { command: "~/bin/deploy --now" }, suggesting("Bash", "~/bin/deploy --now"), ["Bash(~/bin/deploy --now)"]],
    ["a find with -exec, which no prefix covers", "Bash", { command: "find . -name '*.log' -exec rm {} +" }, suggesting("Bash", "find . -name '*.log' -exec rm {} +"), null],
    ["a loop", "Bash", { command: "for f in a b; do cmp x/$f $f; done" }, suggesting("Bash", "for f in a b; do cmp x/$f $f; done"), ["Bash(for f in a b; do cmp x/$f $f; done)"]],
    ["a write outside the instance", "Write", { file_path: "/etc/hosts" }, suggesting("Edit", "//etc/hosts"), null],
    ["a suggestion the checker refuses", "WebFetch", { url: "https://example.com/" }, suggesting("WebFetch", "example.com"), null],
    ["a suggestion that is not a rule", "WebFetch", { url: "https://example.com/" }, [{ type: "setMode", mode: "acceptEdits", destination: "session" }], null],
    ["a suggestion to deny", "WebFetch", { url: "https://example.com/" }, [{ type: "addRules", behavior: "deny", rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }] }], null],
    ["one of the chat's own tools", "mcp__openovai__message", { to: LEADER }, suggesting("mcp__openovai__message"), ["mcp__openovai__message"]],
    ["the same rule suggested twice", "WebSearch", { query: "needle" }, [...suggesting("WebSearch"), ...suggesting("WebSearch")], ["WebSearch"]],
    ["nothing suggested", "WebFetch", { url: "https://example.com/" }, undefined, null],
  ];

  for (const [what, tool, input, suggestions, rules] of carried) {
    it(rules === null ? `offers nothing for ${what}` : `offers ${rules.join(" and ")} for ${what}`, () => {
      assert.deepEqual(shapeOf({ id: "request-1", tool, input, suggestions }, AT), rules);
    });
  }

  it("composes its own rule for a command before reading what was suggested", () => {
    const request = { id: "request-1", tool: "Bash", input: { command: "npm test" }, suggestions: suggesting("Bash", "npm test") };
    assert.deepEqual(shapeOf(request, AT), ["Bash(npm:*)"]);
  });

  it("composes its own rule for a write before reading what was suggested", () => {
    const request = { id: "request-1", tool: "Write", input: { file_path: `${AT}/projects/Wren/notes.md` }, suggestions: suggesting("Edit", "/projects/Wren/notes.md") };
    assert.deepEqual(shapeOf(request, AT), ["Edit(/projects/Wren/**)"]);
  });
});

// The one checker for both callers: a rule written by hand for the Leader's permission tool, and
// a rule Claude Code suggested for a button. What Claude Code reads from a settings file, as its
// reference spells it, and nothing it would skip.
describe("the rule a person may be asked to settle", () => {
  it("accepts a command by prefix in either spelling, answered in the one this workspace writes", () => {
    for (const rule of ["Bash(git:*)", "Bash(git push:*)", "Bash(pip install:*)", "Bash(/usr/bin/time:*)", "Bash(temp/shellcheck/shellcheck:*)"]) {
      assert.equal(acceptRule(rule, AT), rule);
    }
    assert.equal(acceptRule("Bash(npm run *)", AT), "Bash(npm run:*)");
    assert.equal(acceptRule("Bash(ls *)", AT), "Bash(ls:*)");
    assert.equal(acceptRule("Bash(*)", AT), "Bash");
  });

  it("accepts a command exactly, star-free", () => {
    for (const rule of ["Bash(git push)", "Bash(find . -name x -exec rm {} +)", "Bash(env X=1 make)", "Bash(echo (a))", "Bash(x)"]) {
      assert.equal(acceptRule(rule, AT), rule);
    }
  });

  it("refuses a star that stands in for a program or a subcommand, and a glued one", () => {
    for (const rule of ["Bash(* --version)", "Bash(git * main)", "Bash(ls*)", "Bash(git:* push)", "Bash(*.sh)", "Bash()", "Bash( )", "Bash( npm:*)", "Bash(npm :*)", "Bash(git:*) ", "Bash(a\nb)"]) {
      assert.equal(acceptRule(rule, AT), null, JSON.stringify(rule));
    }
  });

  it("accepts a subtree under the instance root for Edit and Read, and a read outside it by the machine's path", () => {
    for (const rule of ["Edit(/projects/Paul/**)", "Edit(/**)", "Read(/projects/Paul/**)", "Read(/**)", "Read(//etc/**)", "Read(//home/alice/notes/**)"]) {
      assert.equal(acceptRule(rule, AT), rule);
    }
  });

  it("refuses a path read from wherever the session is, a path on a tool Claude Code never checks, and a write outside", () => {
    // A bare path is read from the session's current directory rather than the instance root, so
    // it is a wrong rule and not an older spelling of the right one.
    for (const rule of [
      "Edit(projects/Paul/**)", "Edit(**)", "Edit(//etc/**)", "Edit(/../**)", "Edit(/./projects/**)", "Edit(/projects/Paul/STATE.md)", "Edit(~/x/**)", "Edit(/src/**/*.ts)", "Edit(/docs/*)",
      "Read(projects/**)", "Read(./.env)", "Read(~/.zshrc)", `Read(/${AT}/projects/**)`, "Read(//**)", "Read(//etc/../root/**)", "Read(//etc/*/**)", "Read(//etc/x.txt)",
      "Write(/docs/**)", "Glob(/docs/**)", "NotebookEdit(/docs/**)", "MultiEdit(/docs/**)",
    ]) {
      assert.equal(acceptRule(rule, AT), null, rule);
    }
  });

  it("accepts a fetch by host with the wildcards the reference names, and a search", () => {
    for (const rule of ["WebFetch", "WebFetch(domain:example.com)", "WebFetch(domain:*.example.com)", "WebFetch(domain:example.*)", "WebFetch(domain:*)", "WebFetch(domain:localhost)", "WebSearch"]) {
      assert.equal(acceptRule(rule, AT), rule);
    }
    for (const rule of ["WebFetch(example.com)", "WebFetch(domain:example.com.)", "WebFetch(domain:*.*)", "WebFetch(domain:https://example.com)", "WebFetch(domain:)", "WebSearch(*)", "WebSearch(needle)"]) {
      assert.equal(acceptRule(rule, AT), null, rule);
    }
  });

  it("accepts a server's tools by name, with a glob only after the server is named in full", () => {
    for (const rule of ["mcp__openovai", "mcp__openovai__message", "mcp__openovai__*", "mcp__github__get_*", "mcp__claude_ai_Claude_Docs__read"]) {
      assert.equal(acceptRule(rule, AT), rule);
    }
    for (const rule of ["mcp__*", "mcp__", "mcp__*__message", "mcp__open*__message", "mcp__openovai(message)", "mcp__openovai__", "mcp"]) {
      assert.equal(acceptRule(rule, AT), null, rule);
    }
  });

  it("accepts a subagent by name and a bare tool name, and refuses a parameter rule and a tool-name glob", () => {
    for (const rule of ["Agent(Explore)", "Agent(my-custom-agent)", "Agent", "Read", "Write", "Bash", "NotebookEdit", "TaskStop", "Skill"]) {
      assert.equal(acceptRule(rule, AT), rule);
    }
    for (const rule of ["Agent(model:opus)", "Agent(isolation:*)", "Agent()", "*", "B*", "bash", "Bash(run_in_background:true) ", "", " ", null, undefined, 3]) {
      assert.equal(acceptRule(rule, AT), null, String(rule));
    }
  });

  it("accepts every rule a button carries", () => {
    for (const request of [
      { id: "r", tool: "Bash", input: { command: "git push origin main" } },
      { id: "r", tool: "Write", input: { file_path: path.join(AT, "desks", "Paul", "notes.md") } },
      { id: "r", tool: "WebFetch", input: { url: "https://example.com/" }, suggestions: [{ type: "addRules", behavior: "allow", rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }] }] },
    ]) {
      for (const composed of shapeOf(request, AT)) {
        assert.equal(acceptRule(composed, AT), composed);
      }
    }
  });
});

// The one writer of a settled rule: the list it names, and the ledger line beside it.
describe("settling a rule in the settings", () => {
  const root = `${base}-settling`;
  const settings = () => JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8")).permissions;
  const ledger = () => fs.readFileSync(path.join(root, LEDGER), "utf8").split("\n").filter((line) => line.startsWith("- `"));

  before(() => {
    remove(root);
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["mcp__openovai"], deny: ["Edit(/.claude/**)"] } }));
  });

  after(() => remove(root));

  it("moves a rule settled again into the new list and out of the one it was in", () => {
    ruleAsked(root, { rule: "Bash(pip:*)", list: "ask", session: LEADER, call: "pip is too much", day: "2026-09-13" });
    assert.deepEqual(settings().ask, ["Bash(pip:*)"]);
    assert.deepEqual(settings().allow, ["mcp__openovai"]);
    ruleAsked(root, { rule: "Bash(pip:*)", list: "allow", session: LEADER, call: "pip install", day: "2026-09-13" });
    assert.deepEqual(settings().allow, ["mcp__openovai", "Bash(pip:*)"]);
    assert.deepEqual(settings().ask, []);
    assert.deepEqual(settings().deny, ["Edit(/.claude/**)"]);
    assert.deepEqual(ledger().map((line) => line.slice(0, line.indexOf(" — "))), ["- `Bash(pip:*)` (ask)", "- `Bash(pip:*)` (allow)"]);
    // The same thing again is one line and one entry.
    ruleAsked(root, { rule: "Bash(pip:*)", list: "allow", session: LEADER, call: "pip install", day: "2026-09-13" });
    assert.equal(ledger().length, 2);
    assert.deepEqual(settings().allow, ["mcp__openovai", "Bash(pip:*)"]);
  });

  it("refuses a list that is not one of the three", () => {
    assert.throws(() => ruleAsked(root, { rule: "Bash(x:*)", list: "always", session: LEADER, call: "x", day: "d" }), /allow, deny, ask/);
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

let chat = null;
let server = null;
let url = null;

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
  Object.assign(process.env, { OPENOVAI_STAND_IN_LOG: log, XDG_DATA_HOME: standIn, ...knobs });
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

// Type to the Leader and answer with the row its reply lands in: the first row of the Leader's
// after the line typed — a wait on a card puts a line of the chat's between the two.
async function say(text) {
  const rows = JSON.parse((await page("GET", `/sessions/${LEADER}/messages`)).body).messages.length;
  const answered = await page("POST", `/sessions/${LEADER}/message`, { text });
  assert.equal(answered.status, 200, answered.body);
  return async () => {
    const reply = await waitFor(async () => {
      const { messages } = JSON.parse((await page("GET", `/sessions/${LEADER}/messages`)).body);
      return messages.slice(rows + 1).find((row) => row.from === LEADER && typeof row.text === "string") ?? null;
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
    chat = { root: instance, config: JSON.parse(fs.readFileSync(path.join(instance, CONFIG_FILE), "utf8")), plugins: [] };
    sink(() => {});
    server = await serve(chat);
    url = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await endEvery(500);
    await new Promise((resolve) => server.close(resolve));
    sink(null);
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
      assert.equal(replied.text, "I was told deny: not allowed by the Server");
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
      // "ask" settles a rule, never a call: a call that stopped is already being asked.
      assert.equal((await page("POST", `/sessions/${LEADER}/permission`, { id: "request-1", decision: "ask" })).status, 400);
      assert.equal((await page("POST", `/sessions/${LEADER}/permission`, { decision: "allow" })).status, 400);
    });
  });

  describe("allowing the shape and not only the call", () => {
    // One rule per side of the command that nothing allows yet: the cd is held by the instance from
    // birth, make and cmake are not, and the two rules land in the order they were written.
    const RULES = ["Bash(make:*)", "Bash(cmake:*)"];
    const CALL = "cd projects/app && make build && cmake --build out";
    // The shell rules an instance is born with, spelled out rather than imported so that a press
    // which widened the list beyond its one rule is caught here and not agreed with.
    const BORN_WITH = [
      "Bash(git:*)",
      "Bash(mkdir:*)",
      "Bash(cd:*)",
      "Bash(node:*)",
      "Bash(bash:*)",
      "Bash(sh:*)",
      "Bash(cp:*)",
      "Bash(mv:*)",
      "Bash(rm:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(tar:*)",
      "Bash(diff:*)",
      "Bash(cmp:*)",
      "Bash(sha256sum:*)",
      "Bash(grep:*)",
      "Bash(find:*)",
      "Bash(sed:*)",
      "Bash(awk:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(wc:*)",
      "Bash(echo:*)",
      "Bash(chmod:*)",
      "Bash(touch:*)",
      "Bash(curl:*)",
      "Bash(npm:*)",
    ];
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
      await leaderAsking({ OPENOVAI_STAND_IN_ASKS: "Bash", OPENOVAI_STAND_IN_ASKS_INPUT: CALL });
      const reply = await say("this one is worth allowing for good");
      shown = (await waitingOn())[0];
      said = await page("POST", `/sessions/${LEADER}/permission`, { id: shown.id, decision: "always" });
      replied = await reply();
    });

    after(async () => {
      await endSeat(LEADER, 500);
    });

    it("tells the page which rules would allow it, one per side nothing holds yet", () => {
      assert.deepEqual(shown.shape, RULES);
    });

    it("lets the run finish, allowed", () => {
      assert.equal(replied.text, "I was told allow");
    });

    it("says which rules it granted", () => {
      assert.deepEqual(JSON.parse(said.body), { answered: shown.id, decision: "always", granted: RULES });
    });

    it("grants exactly those rules and nothing else beyond what the instance was born with", () => {
      assert.deepEqual(allowed().filter((rule) => rule.startsWith("Bash(")), [...BORN_WITH, ...RULES]);
    });

    it("writes down who asked for each, when, and what for", () => {
      const written = lines();
      assert.equal(written.length, 2, written.join(" / "));
      for (const [at, rule] of RULES.entries()) {
        assert.ok(written[at].startsWith(`- \`${rule}\` `), written[at]);
        assert.match(written[at], new RegExp(LEADER));
        assert.ok(written[at].includes(CALL), written[at]);
        assert.match(written[at], new RegExp(new Date().toISOString().slice(0, 10)));
      }
    });

    it("still adds up", () => {
      assert.ok(!settingsProblems(settings, [LEADER]).join(" ").includes("Bash("), "the rule it granted is not accounted for");
    });

    it("grants them to the workspace and remembers who asked", () => {
      assert.ok(RULES.every((rule) => !rule.includes(LEADER)));
      assert.match(lines()[0], new RegExp(LEADER));
    });
  });

  describe("allowing a write, and not only the file it named", () => {
    const RULE = "Edit(/.tmp/onboarding/**)";
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
      assert.deepEqual(shown.shape, [RULE]);
      assert.deepEqual(JSON.parse(said.body), { answered: shown.id, decision: "always", granted: [RULE] });
      assert.ok(JSON.parse(fs.readFileSync(settings, "utf8")).permissions.allow.includes(RULE));
    });

    it("writes down which write it was for", () => {
      const written = fs.readFileSync(ledger, "utf8").split("\n").filter((line) => line.startsWith(`- \`${RULE}\``));
      assert.equal(written.length, 1);
      assert.match(written[0], /\.tmp\/onboarding\/notes\.md/);
      assert.ok(!written[0].includes(instance), "the ledger names a place on this machine");
    });
  });

  describe("allowing a fetch, by the rule Claude Code itself would save", () => {
    const RULE = "WebFetch(domain:example.com)";
    const settings = path.join(instance, ".claude", "settings.json");
    const ledger = path.join(instance, LEDGER);
    let shown;
    let said;

    before(async () => {
      await leaderAsking({
        OPENOVAI_STAND_IN_ASKS: "WebFetch",
        OPENOVAI_STAND_IN_ASKS_INPUT: JSON.stringify({ url: "https://example.com/", prompt: "the title" }),
        OPENOVAI_STAND_IN_SUGGESTS: JSON.stringify([{ type: "addRules", destination: "localSettings", rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }], behavior: "allow" }]),
      });
      const reply = await say("read the page");
      shown = (await waitingOn())[0];
      said = await page("POST", `/sessions/${LEADER}/permission`, { id: shown.id, decision: "always" });
      await reply();
    });

    after(async () => {
      await endSeat(LEADER, 500);
    });

    it("offers the rule Claude Code suggested, and grants it", () => {
      assert.deepEqual(shown.shape, [RULE]);
      assert.deepEqual(JSON.parse(said.body), { answered: shown.id, decision: "always", granted: [RULE] });
      assert.ok(JSON.parse(fs.readFileSync(settings, "utf8")).permissions.allow.includes(RULE));
    });

    it("writes down which fetch it was for", () => {
      const written = fs.readFileSync(ledger, "utf8").split("\n").filter((line) => line.startsWith(`- \`${RULE}\``));
      assert.equal(written.length, 1);
      assert.match(written[0], /for `https:\/\/example\.com\/`/);
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
      assert.equal(replied.text, "I was told deny: not allowed by the Server");
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

  // The Leader's permission tool: the ask is the tool call, the write is the User's press, and
  // the press reaches the Leader as an event.
  describe("settling a rule", () => {
    const settings = () => JSON.parse(fs.readFileSync(path.join(instance, ".claude", "settings.json"), "utf8")).permissions;
    const ledger = () => fs.readFileSync(path.join(instance, LEDGER), "utf8").split("\n").filter((line) => line.startsWith("- `"));
    let leader;
    let said = {};
    let listedOnPanel;
    let pressed;
    let heardBefore;

    async function permission(args) {
      const answered = await post(`${url}/mcp/${leader.secret}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "permission", arguments: args } });
      const body = JSON.parse(answered.body);
      return { text: body.result?.content?.[0]?.text, refused: body.result?.isError === true };
    }

    before(async () => {
      leader = await leaderAsking({});
      leader.secret = secretsIn(leader.log)[0];
      ruleAsked(instance, { rule: "Bash(git:*)", list: "deny", session: LEADER, call: "settled by hand for the check", day: "2026-09-13" });
      said.noWhy = await permission({ rule: "Bash(pip:*)" });
      said.badShape = await permission({ rule: "Write(/docs/**)", why: "anything" });
      said.held = await permission({ rule: "Bash(git:*)", why: "the User asked" });
      said.asked = await permission({ rule: "Bash(pip:*)", why: "pip install is too much" });
      said.again = await permission({ rule: "Bash(pip:*)", why: "pip install is too much" });
      listedOnPanel = JSON.parse((await page("GET", `/sessions/${LEADER}/permissions`)).body).permissions;
      said.listing = await permission({});
      heardBefore = heardIn(leader.log).length;
      pressed = await page("POST", `/sessions/${LEADER}/permission`, { id: listedOnPanel[0].id, decision: "ask" });
      await waitFor(() => (heardIn(leader.log).length > heardBefore ? true : null));
    });

    after(async () => {
      await endSeat(LEADER, 500);
    });

    it("refuses a Worker the permission tool", () => {
      const tools = toolsFor(chat, { seat: "Paul", role: WORKER });
      const forWorker = tools.find((tool) => tool.name === "permission");
      assert.equal(forWorker.offered, false);
      assert.deepEqual(forWorker.run({ rule: "Bash(pip:*)", why: "x" }), { refused: "permission is not offered to you" });
      assert.equal(toolsFor(chat, { seat: LEADER, role: LEADS }).find((tool) => tool.name === "permission").offered, true);
    });

    it("refuses a rule without a why, a rule already pending, and a shape it does not accept", () => {
      assert.equal(said.noWhy.refused, true);
      assert.match(said.noWhy.text, /say why/);
      assert.equal(said.badShape.refused, true);
      assert.match(said.badShape.text, /^Write\(\/docs\/\*\*\) is not a rule Claude Code reads/);
      assert.match(said.badShape.text, /Bash\(word:\*\)/);
      assert.match(said.badShape.text, /Edit\(\/dir\/\*\*\)/);
      assert.match(said.badShape.text, /WebFetch\(domain:host\)/);
      assert.equal(said.again.refused, true);
      assert.match(said.again.text, /already asked on your panel/);
    });

    it("refuses a rule the instance already holds, naming how it is held", () => {
      assert.equal(said.held.refused, true);
      assert.match(said.held.text, /Bash\(git:\*\) is already denied/);
    });

    it("answers at once that the rule is asked on the panel", () => {
      assert.equal(said.asked.refused, false, said.asked.text);
      assert.match(said.asked.text, /^asked on your panel: Bash\(pip:\*\) \(.+\)$/);
    });

    it("lists the rule request on the Leader's panel with the rule and the why", () => {
      assert.equal(listedOnPanel.length, 1, JSON.stringify(listedOnPanel));
      const [request] = listedOnPanel;
      assert.equal(request.kind, "rule");
      assert.equal(request.rule, "Bash(pip:*)");
      assert.equal(request.why, "pip install is too much");
      assert.equal(request.from, LEADER);
      assert.ok(said.asked.text.includes(request.id));
    });

    it("answers the three lists and the pending dialogs when called with no rule", () => {
      assert.equal(said.listing.refused, false, said.listing.text);
      const listing = JSON.parse(said.listing.text);
      assert.deepEqual(Object.keys(listing).sort(), ["allow", "ask", "deny", "pending"]);
      assert.ok(listing.allow.some((entry) => entry.rule === "mcp__openovai"));
      const denied = listing.deny.find((entry) => entry.rule === "Bash(git:*)");
      assert.ok(denied !== undefined, said.listing.text);
      assert.match(denied.line, /^- `Bash\(git:\*\)` \(deny\) — /);
      assert.deepEqual(listing.pending, [{ rule: "Bash(pip:*)", why: "pip install is too much" }]);
    });

    it("writes an ask decision to the ask list, and the ledger says so", () => {
      assert.equal(pressed.status, 200, pressed.body);
      assert.deepEqual(JSON.parse(pressed.body), { answered: listedOnPanel[0].id, decision: "ask", settled: "Bash(pip:*)" });
      assert.ok(settings().ask.includes("Bash(pip:*)"), JSON.stringify(settings()));
      assert.ok(!settings().allow.includes("Bash(pip:*)"));
      assert.ok(!settings().deny.includes("Bash(pip:*)"));
      const line = ledger().find((held) => held.startsWith("- `Bash(pip:*)`"));
      assert.equal(line, `- \`Bash(pip:*)\` (ask) — ${LEADER}, ${new Date().toISOString().slice(0, 10)}, for \`pip install is too much\``);
    });

    it("tells the Leader what the User pressed, as an event with the rule in it", () => {
      const heard = heardIn(leader.log);
      assert.equal(heard.length, heardBefore + 1, heard.join(" / "));
      assert.equal(heard.at(-1), `<server-event type="permission" decision="ask" who="${LEADER}">Bash(pip:*)</server-event>`);
    });

    it("takes the dialog down once pressed, and refuses a second press", async () => {
      assert.deepEqual(JSON.parse((await page("GET", `/sessions/${LEADER}/permissions`)).body).permissions, []);
      assert.equal((await page("POST", `/sessions/${LEADER}/permission`, { id: listedOnPanel[0].id, decision: "deny" })).status, 409);
    });

    it("refuses a decision that is not one of the three for that kind of question", async () => {
      const asked = await permission({ rule: "Bash(pip3:*)", why: "the User said pip3 is fine" });
      assert.equal(asked.refused, false, asked.text);
      const [request] = JSON.parse((await page("GET", `/sessions/${LEADER}/permissions`)).body).permissions;
      assert.equal(request.rule, "Bash(pip3:*)");
      const always = await page("POST", `/sessions/${LEADER}/permission`, { id: request.id, decision: "always" });
      assert.equal(always.status, 400, always.body);
      assert.match(always.body, /allow, deny or ask/);
      const denied = await page("POST", `/sessions/${LEADER}/permission`, { id: request.id, decision: "deny" });
      assert.equal(denied.status, 200, denied.body);
      assert.ok(settings().deny.includes("Bash(pip3:*)"));
    });
  });

  // The reply goes first: a rule asked in the middle of a turn is listed once the turn has ended.
  describe("a rule asked in the middle of a turn", () => {
    let leader;
    let during;
    let after_;
    let reply;
    let later;
    // The page is told when what the Leader's panel asks has changed: once at the park, and again
    // when the turn ends and the dialog is listed.
    const told = [];
    let toldDuring;
    let toldAfter;
    let unsubscribe;

    async function permission(args) {
      const answered = await post(`${url}/mcp/${leader.secret}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "permission", arguments: args } });
      return JSON.parse(answered.body).result?.content?.[0]?.text;
    }

    before(async () => {
      leader = await leaderAsking({ OPENOVAI_STAND_IN_SLOW: "1500" });
      leader.secret = secretsIn(leader.log)[0];
      unsubscribe = subscribe((event) => {
        if (event.name === "asking" && event.data.seat === LEADER) {
          told.push(event);
        }
      });
      reply = await say("take your time");
      await waitFor(() => (heardIn(leader.log).length > 0 ? true : null));
      assert.match(await permission({ rule: "Bash(cargo:*)", why: "the build is cargo" }), /^asked on your panel/);
      during = JSON.parse((await page("GET", `/sessions/${LEADER}/permissions`)).body).permissions;
      toldDuring = told.length;
      await reply();
      after_ = await waitFor(async () => {
        const { permissions } = JSON.parse((await page("GET", `/sessions/${LEADER}/permissions`)).body);
        return permissions.length > 0 ? permissions : null;
      });
      toldAfter = told.length;
      // A later turn, with the dialog standing: what it lists is read while that turn runs.
      const heard = heardIn(leader.log).length;
      const again = await say("and once more");
      await waitFor(() => (heardIn(leader.log).length > heard ? true : null));
      later = JSON.parse((await page("GET", `/sessions/${LEADER}/permissions`)).body).permissions;
      await again();
    });

    after(async () => {
      unsubscribe();
      await page("POST", `/sessions/${LEADER}/permission`, { id: after_[0].id, decision: "deny" });
      await endSeat(LEADER, 500);
    });

    it("tells the page again once the turn has ended, so the dialog is drawn then", () => {
      assert.equal(toldDuring, 1);
      assert.equal(toldAfter, 2, JSON.stringify(told));
    });

    it("lists a rule request only after the turn that raised it ended", () => {
      assert.deepEqual(during, []);
      assert.equal(after_.length, 1);
      assert.equal(after_[0].rule, "Bash(cargo:*)");
    });

    // A press on a card is a turn of its own: the cards beside it stay listed while it runs.
    it("keeps a rule request listed while a later turn runs", () => {
      assert.deepEqual(later.map(({ rule }) => rule), ["Bash(cargo:*)"]);
    });

  });
});
