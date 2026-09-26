// The hook that lets a compound of allowed commands through: what it answers for a command against
// a settings object, what it says on stdout when run the way the harness runs it, and how an
// update wires it into settings that lack it and says which rules they lack.
//
// Every mutation in tests/mutations-hook.json names the check it was written to redden.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { COMPOUND_REASON, HIDDEN_REASON, HOOK_COMMAND, HOOK_ENTRY, answerFor, decide } from "../lib/hooks/compound.mjs";
import { SUBAGENT_HOOK_COMMAND, SUBAGENT_HOOK_ENTRY } from "../lib/hooks/subagent.mjs";
import { hooksWired, rulesMissing, rulesStale, wireHooks } from "../lib/seed.mjs";
import { readSettings, settingsFile, writeSettings } from "../lib/settings.mjs";
import { remove, repo, scratch } from "./helpers.mjs";

// The settings a fresh instance is born with, cut down to what these checks turn on: a few of the
// seeded commands, git by its subcommand, and the three refusals.
const SETTINGS = {
  permissions: {
    allow: ["mcp__openovai", "Read(/**)", "Edit(/projects/**)", "Bash(git:*)", "Bash(cd:*)", "Bash(npm:*)", "Bash(node:*)", "Bash(cmp:*)", "Bash(ls:*)", "Bash(echo:*)", "Bash(rm:*)", "Bash(find:*)", "Bash(grep:*)", "Bash(make test)"],
    deny: ["Edit(/.claude/**)", "Bash(git push:*)", "Bash(sudo:*)", "Bash(ssh:*)"],
  },
};

describe("the decision for a command", () => {
  const allowed = [
    ["one allowed command", "npm test"],
    ["a compound of allowed commands", "cd /x && npm test"],
    ["a compound joined every way the shell joins", "cd /x; npm ci && npm test || echo failed | grep -c failed"],
    ["a loop over allowed commands", "for f in a b; do cmp x/$f $f; done"],
    ["a loop written on lines", "for f in a b\ndo\n  cmp x/$f $f\ndone"],
    ["a branch over allowed commands", "if grep -q x f; then echo yes; else echo no; fi"],
    ["a while over an allowed command", "while cmp a b; do echo same; done"],
    ["a negated allowed command", "! cmp a b"],
    ["an assignment in front of an allowed command", "CI=1 NODE_ENV=test npm test"],
    ["an assignment alone", "X=1"],
    ["redirections around an allowed command", "npm test > out.txt 2>&1 && grep x out.txt < in.txt"],
    ["a quoted argument with a separator in it", 'git commit -m "fix: a; b && c | d"'],
    ["an escaped separator, which is text", "echo a \\; b"],
    ["a redirection with its own target word", "node x.mjs 2> /dev/null"],
    ["git by an allowed subcommand", "cd /x && git status && git log --oneline -3"],
    ["a command put in the background", "node serve.mjs &"],
    ["a command that ends with a semicolon", "npm test;"],
    ["an exact rule holding exactly that command", "cd /x && make test"],
    ["a quoted argument that closes", 'echo "a && b"'],
  ];
  for (const [name, command] of allowed) {
    it(`allows ${name}`, () => {
      assert.equal(decide(command, SETTINGS), "allow");
    });
  }

  const silent = [
    ["a command nothing holds", "make build"],
    ["a side that is refused by rule", "cd /x && git push origin main"],
    ["a refused command alone", "sudo ls"],
    ["a refused command inside a loop", "for h in a b; do ssh $h ls; done"],
    ["a side nothing holds beside a side that is refused", "make build && git push"],
    ["a side nothing holds beside a side that is not read", "make build && $TOOL --go"],
    ["git without a subcommand", "git"],
    ["git with a subcommand that is not a word", "git -C /x status"],
    ["a hidden program that is refused by rule", "echo `git push`"],
    ["a quote left open", 'echo "a && rm -rf /'],
    ["a quote left open in a compound nothing holds", "make a && make 'b"],
    ["a first word with a slash", "./release.sh && npm test"],
    ["a first word out of a variable", "$TOOL --go"],
    ["a case, which is not read", "case $x in a) ls;; esac"],
    ["a function, which is not read", "function f { ls; }"],
    ["a timed command, which is not read", "time npm test"],
    ["a test bracket, which is not read", "[[ -f x ]] && ls"],
    ["a compound with nothing after the operator", "npm test &&"],
    ["an exact rule and a longer command", "make test --verbose"],
    ["find running what it finds", "find . -name '*.tmp' -exec rm {} ;"],
    ["find deleting what it finds", "find . -name '*.tmp' -delete"],
    ["nothing at all", "   "],
    ["a command that is not a string", undefined],
  ];
  for (const [name, command] of silent) {
    it(`answers nothing for ${name}`, () => {
      assert.equal(decide(command, SETTINGS), null);
    });
  }

  const refused = [
    ["a grep whose double-quoted pattern holds a backtick", 'grep -n -e "content: `Use the" /x/rig.mjs'],
    ["a grep whose pattern holds a $(", 'grep -n "console.log($(" /x/ovai.mjs'],
    ["a substitution whose program is allowed", "ls `ls x`"],
    ["a process substitution over allowed commands", "cmp <(ls a) <(ls b)"],
  ];
  for (const [name, command] of refused) {
    it(`refuses ${name}`, () => {
      assert.equal(decide(command, SETTINGS), "hidden");
    });
  }

  // More than one plain command, with a side no rule holds: refused toward a script, not carded.
  const compound = [
    ["a compound one side of which nothing holds", "cd /x && make build"],
    ["a pipe into a program nothing holds", "grep -c x /x/f | sort"],
    ["a loop over a command nothing holds", "for f in a b; do make $f; done"],
    ["an assignment in front of a command nothing holds", "CI=1 make build"],
    ["a negated command nothing holds", "! make build"],
    ["a command that hides a program in a substitution", "ls $(cat x)"],
    ["a command that hides a program in backticks", "ls `cat x`"],
    ["a hidden program nothing holds, behind an allowed one", "grep x $(make build)"],
    ["a here-document", "cat <<EOF\nhello\nEOF"],
    ["a sweep over files named in a list", "cd /x/notes/ && grep -ohE '\\b[A-Z][a-z]{2,}\\b' $(cat /x/list-D.txt) | sort | uniq -c | sort -rn | awk '{printf \"%s:%s \",$2,$1}'"],
    ["an assignment then a grep through a cut", "cd /x/notes/ && N='Kris|Carlos'; grep -nwE \"$N\" $(cat /x/list-D.txt) | cut -c1-400"],
  ];
  for (const [name, command] of compound) {
    it(`refuses toward a script ${name}`, () => {
      assert.equal(decide(command, SETTINGS), "compound");
    });
  }

  it("reads the rules it is given, not a list of its own", () => {
    assert.equal(decide("npm test", { permissions: { allow: ["Bash(cd:*)"], deny: [] } }), null);
    assert.equal(decide("cd /x && npm test", { permissions: { allow: ["Bash(cd:*)"], deny: [] } }), "compound");
    assert.equal(decide("cd /x && npm test", { permissions: { allow: ["Bash(cd:*)", "Bash(npm:*)"] } }), "allow");
    assert.equal(decide("npm test", {}), null);
  });

  it("holds a side against a refusal before a grant, whichever list is longer", () => {
    const both = { permissions: { allow: ["Bash(git:*)"], deny: ["Bash(git push:*)"] } };
    assert.equal(decide("git push", both), null);
    assert.equal(decide("git push --force", both), null);
    assert.equal(decide("git pushes", both), "allow");
  });
});

describe("what the harness reads back", () => {
  it("is the allow decision in the PreToolUse shape for a compound of allowed commands", () => {
    const said = JSON.parse(answerFor({ tool_name: "Bash", tool_input: { command: "cd /x && npm test" } }, SETTINGS));
    assert.equal(said.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(said.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(typeof said.hookSpecificOutput.permissionDecisionReason, "string");
  });

  it("is the deny decision with a reason naming grep -f and a script for an allowed line that hides a program", () => {
    const said = JSON.parse(answerFor({ tool_name: "Bash", tool_input: { command: 'grep -n "a`b" /x/f' } }, SETTINGS));
    assert.equal(said.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(said.hookSpecificOutput.permissionDecisionReason, HIDDEN_REASON);
    assert.match(HIDDEN_REASON, /grep -f/);
    assert.match(HIDDEN_REASON, /script on your desk/);
  });

  it("is the deny decision with a reason naming the Write tool and bash <file> for a compound with a side nothing holds", () => {
    const said = JSON.parse(answerFor({ tool_name: "Bash", tool_input: { command: "cd /x && make build" } }, SETTINGS));
    assert.equal(said.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(said.hookSpecificOutput.permissionDecisionReason, COMPOUND_REASON);
    assert.match(COMPOUND_REASON, /Create the script with the Write tool, in temp\/ or on your desk, then run only `bash <file>` as its own Bash call/);
  });

  it("is nothing for a command that gets no decision", () => {
    assert.equal(answerFor({ tool_name: "Bash", tool_input: { command: "make build" } }, SETTINGS), "");
  });

  it("is nothing for a call that is not Bash, whatever it carries", () => {
    assert.equal(answerFor({ tool_name: "Edit", tool_input: { command: "npm test", file_path: "x" } }, SETTINGS), "");
    assert.equal(answerFor(null, SETTINGS), "");
  });
});

describe("run as the hook", () => {
  // A copy of lib/ under a scratch root, so the script reads the settings of the instance it sits
  // in — worked out from its own place — and never this checkout's.
  const root = scratch("hook-test-instance");
  before(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(repo, "lib"), path.join(root, "lib"), { recursive: true });
    writeSettings(root, SETTINGS);
  });
  after(() => {
    remove(root);
  });

  const run = (stdin) => spawnSync(process.execPath, [path.join(root, "lib", "hooks", "compound.mjs")], { input: stdin, encoding: "utf8", cwd: "/" });

  it("prints the allow decision for a compound of allowed commands and exits 0", () => {
    const ran = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cd /x && npm test" } }));
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(JSON.parse(ran.stdout).hookSpecificOutput.permissionDecision, "allow");
  });

  it("prints nothing for a command with a refused side and exits 0", () => {
    const ran = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cd /x && git push" } }));
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, "");
  });

  it("prints the deny decision for an allowed line that hides a program and exits 0", () => {
    const ran = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: 'grep -n "a`b" /x/f' } }));
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(JSON.parse(ran.stdout).hookSpecificOutput.permissionDecision, "deny");
  });

  it("prints nothing for input that is not a call and exits 0", () => {
    const ran = run("not json");
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, "");
  });

  it("reads the settings of the instance it sits in, so a rule taken out stops counting", () => {
    writeSettings(root, { permissions: { allow: ["Bash(cd:*)"], deny: [] } });
    const ran = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" } }));
    assert.equal(ran.stdout, "");
    writeSettings(root, SETTINGS);
  });
});

describe("wiring the hook at update", () => {
  const root = scratch("hook-wire-instance");
  before(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  after(() => {
    remove(root);
  });

  it("names the command by the harness's own name for the root, not by a path on this machine", () => {
    assert.equal(HOOK_COMMAND.includes("${CLAUDE_PROJECT_DIR}"), true);
    assert.equal(HOOK_COMMAND.includes(repo), false);
    assert.deepEqual(HOOK_ENTRY, { matcher: "Bash", hooks: [{ type: "command", command: HOOK_COMMAND }] });
  });

  it("adds the hooks to settings that lack them and leaves the rest as it was", () => {
    writeSettings(root, { permissions: SETTINGS.permissions, hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "theirs" }] }] } });
    assert.deepEqual(wireHooks(root), [settingsFile(root)]);
    const after = readSettings(root);
    assert.equal(hooksWired(after), true);
    assert.deepEqual(after.permissions, SETTINGS.permissions);
    assert.deepEqual(after.hooks.PostToolUse, [{ matcher: "Edit", hooks: [{ type: "command", command: "theirs" }] }]);
    assert.deepEqual(after.hooks.PreToolUse, [HOOK_ENTRY]);
    assert.deepEqual(after.hooks.SubagentStart, [SUBAGENT_HOOK_ENTRY]);
  });

  it("keeps a PreToolUse hook of theirs beside ours", () => {
    writeSettings(root, { permissions: SETTINGS.permissions, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "theirs" }] }] } });
    wireHooks(root);
    assert.deepEqual(readSettings(root).hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "theirs" }] }, HOOK_ENTRY]);
  });

  it("adds the subagent hook to settings that carry only the compound one, and the compound one once", () => {
    writeSettings(root, { permissions: SETTINGS.permissions, hooks: { PreToolUse: [HOOK_ENTRY] } });
    assert.deepEqual(wireHooks(root), [settingsFile(root)]);
    const after = readSettings(root);
    assert.deepEqual(after.hooks.PreToolUse, [HOOK_ENTRY]);
    assert.deepEqual(after.hooks.SubagentStart, [SUBAGENT_HOOK_ENTRY]);
  });

  it("writes nothing when the hooks are there", () => {
    writeSettings(root, { permissions: SETTINGS.permissions, hooks: { PreToolUse: [HOOK_ENTRY], SubagentStart: [SUBAGENT_HOOK_ENTRY] } });
    const text = fs.readFileSync(settingsFile(root), "utf8");
    assert.deepEqual(wireHooks(root), []);
    assert.equal(fs.readFileSync(settingsFile(root), "utf8"), text);
  });

  it("leaves settings it cannot read exactly as they are, and says nothing is missing from them", () => {
    fs.writeFileSync(settingsFile(root), "{ not json\n");
    assert.deepEqual(wireHooks(root), []);
    assert.equal(fs.readFileSync(settingsFile(root), "utf8"), "{ not json\n");
    assert.deepEqual(rulesMissing(root), []);
  });

  it("wires settings that are not there at all, granting nothing", () => {
    fs.rmSync(settingsFile(root), { force: true });
    wireHooks(root);
    const after = readSettings(root);
    assert.equal(hooksWired(after), true);
    assert.equal(after.permissions, undefined);
  });
});

describe("the subagent hook", () => {
  // A scratch instance with lib/ copied in, so the script reads the customization of the instance
  // it sits in, worked out from its own place.
  const root = scratch("subagent-hook-instance");
  const common = path.join(root, "customization", "common.md");
  before(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(repo, "lib"), path.join(root, "lib"), { recursive: true });
    fs.mkdirSync(path.dirname(common), { recursive: true });
  });
  after(() => {
    remove(root);
  });

  const run = () => spawnSync(process.execPath, [path.join(root, "lib", "hooks", "subagent.mjs")], { input: JSON.stringify({ hook_event_name: "SubagentStart", agent_type: "general-purpose" }), encoding: "utf8", cwd: "/" });

  it("names the command by the harness's own name for the root, for every type of subagent", () => {
    assert.equal(SUBAGENT_HOOK_COMMAND.includes("${CLAUDE_PROJECT_DIR}"), true);
    assert.equal(SUBAGENT_HOOK_COMMAND.includes(repo), false);
    assert.deepEqual(SUBAGENT_HOOK_ENTRY, { hooks: [{ type: "command", command: SUBAGENT_HOOK_COMMAND }] });
  });

  it("hands the subagent customization/common.md in its frame, byte for byte, and exits 0", () => {
    const words = "1. A line the person set, with `a backtick` and no newline at the end";
    fs.writeFileSync(common, words);
    const ran = run();
    assert.equal(ran.status, 0, ran.stderr);
    const said = JSON.parse(ran.stdout).hookSpecificOutput;
    assert.equal(said.hookEventName, "SubagentStart");
    assert.equal(said.additionalContext.endsWith(`<customization source="customization/common.md">\n${words}</customization>`), true);
  });

  it("answers nothing when the instance has no common.md, and exits 0", () => {
    fs.rmSync(common, { force: true });
    const ran = run();
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, "");
  });
});

describe("the rules an update says are missing", () => {
  const root = scratch("hook-missing-instance");
  before(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  after(() => {
    remove(root);
  });

  it("is nothing for settings that hold every rule a fresh instance is born with", () => {
    writeSettings(root, {
      permissions: {
        allow: ["mcp__openovai", "AskUserQuestion", "Read(/**)", "Edit(/reference/**)", "Edit(/projects/**)", "Edit(/temp/**)", "Edit(/knowledge/**)", "Bash(git:*)", "Bash(mkdir:*)", "Bash(cd:*)", "Bash(node:*)", "Bash(bash:*)", "Bash(sh:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(rm:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(tar:*)", "Bash(diff:*)", "Bash(cmp:*)", "Bash(sha256sum:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(sed:*)", "Bash(awk:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(echo:*)", "Bash(chmod:*)", "Bash(touch:*)", "Bash(curl:*)", "Bash(npm:*)", "Edit(/desks/Bob/**)"],
        deny: ["Edit(/.claude/**)", "Edit(/.local/settings.json)", "Edit(/.local/.claude.json)", "Bash(git push:*)", "Bash(sudo:*)", "Bash(ssh:*)"],
        ask: ["Edit(/customization/**)", "Edit(/knowledge/common.md)"],
      },
    });
    assert.deepEqual(rulesMissing(root), []);
    assert.deepEqual(rulesStale(root), []);
  });

  // An instance made before there was an ask rule, or before there was a `knowledge/` to write in,
  // holds every other rule and not those, which is the case the update exists for: each is named,
  // in the list it belongs in, and added to nothing. A rule the person took out of the list
  // afterwards is named the same way, and stays out — saying is all an update does here.
  it("names the rules an instance born earlier has not got, each in its own list", () => {
    writeSettings(root, {
      permissions: {
        allow: ["mcp__openovai", "Read(/**)", "Edit(/reference/**)", "Edit(/projects/**)", "Edit(/temp/**)", "Bash(git:*)", "Bash(mkdir:*)", "Bash(cd:*)", "Bash(node:*)", "Bash(bash:*)", "Bash(sh:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(rm:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(tar:*)", "Bash(diff:*)", "Bash(cmp:*)", "Bash(sha256sum:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(sed:*)", "Bash(awk:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(echo:*)", "Bash(chmod:*)", "Bash(touch:*)", "Bash(curl:*)", "Bash(npm:*)"],
        deny: ["Edit(/.claude/**)", "Edit(/.local/settings.json)", "Edit(/.local/.claude.json)", "Bash(git push:*)", "Bash(sudo:*)", "Bash(ssh:*)"],
      },
    });
    const text = fs.readFileSync(settingsFile(root), "utf8");
    assert.deepEqual(rulesMissing(root), ["allow AskUserQuestion", "allow Edit(/knowledge/**)", "ask Edit(/customization/**)", "ask Edit(/knowledge/common.md)"]);
    assert.equal(fs.readFileSync(settingsFile(root), "utf8"), text);
  });

  it("names each rule the settings lack, by the list it belongs in, and adds none", () => {
    writeSettings(root, { permissions: { allow: ["mcp__openovai", "Read(/**)", "Edit(/reference/**)", "Edit(/projects/**)", "Edit(/temp/**)"], deny: ["Edit(/.claude/**)", "Edit(/.local/settings.json)", "Edit(/.local/.claude.json)"], ask: ["Edit(/customization/**)"] } });
    const text = fs.readFileSync(settingsFile(root), "utf8");
    const missing = rulesMissing(root);
    assert.equal(missing.length, 33);
    assert.equal(missing[0], "allow AskUserQuestion");
    assert.equal(missing.includes("deny Bash(git push:*)"), true);
    assert.equal(missing.includes("deny Bash(ssh:*)"), true);
    assert.equal(missing.some((entry) => entry.includes("desks/")), false);
    assert.equal(fs.readFileSync(settingsFile(root), "utf8"), text);
  });

  // The desk file was refused to the file tools by earlier releases, and an instance born then
  // still holds the rule: the update names it as stale, spelt as it stands, and removes nothing.
  it("names the desk-file deny rule an earlier release wrote as stale, and removes none", () => {
    writeSettings(root, { permissions: { allow: ["mcp__openovai"], deny: ["Edit(/.claude/**)", "Edit(/desks/*/STATE.md)", "Bash(git push:*)"] } });
    const text = fs.readFileSync(settingsFile(root), "utf8");
    assert.deepEqual(rulesStale(root), ["deny Edit(/desks/*/STATE.md)"]);
    assert.equal(fs.readFileSync(settingsFile(root), "utf8"), text);
    fs.writeFileSync(settingsFile(root), "{ not json\n");
    assert.deepEqual(rulesStale(root), []);
  });
});
