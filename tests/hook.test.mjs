// The hook the toolkit wires into an instance's settings: how an update wires it into settings that
// lack it and takes out the hooks the toolkit no longer runs, what it hands a subagent, the node it
// runs on, and which rules an update says the settings lack.
//
// Every mutation in tests/mutations-hook.json names the check it was written to redden.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { SUBAGENT_HOOK_COMMAND, SUBAGENT_HOOK_ENTRY } from "../lib/hooks/subagent.mjs";
import { IGNORED_DEFAULTS } from "../lib/desks.mjs";
import { defaultsIgnored, hooksWired, ignoreDefault, rulesMissing, rulesStale, wireHooks } from "../lib/seed.mjs";
import { readSettings, settingsFile, writeSettings } from "../lib/settings.mjs";
import { remove, repo, runtimeData, scratch, standInEnvironment } from "./helpers.mjs";

// A missing default as the update used to print it: the list, then the rule.
const spelt = (missing) => missing.map(({ list, rule }) => `${list} ${rule}`);

// The settings a fresh instance is born with, cut down to what these checks turn on: a few of the
// seeded commands, git by its subcommand, and the three refusals.
const SETTINGS = {
  permissions: {
    allow: ["mcp__openovai", "Read(/**)", "Edit(/projects/**)", "Bash(git:*)", "Bash(cd:*)", "Bash(npm:*)", "Bash(cmp:*)", "Bash(ls:*)", "Bash(echo:*)", "Bash(rm:*)", "Bash(find:*)", "Bash(grep:*)", "Bash(make test)"],
    deny: ["Edit(/.claude/**)", "Bash(git push:*)", "Bash(sudo:*)", "Bash(ssh:*)"],
  },
};

describe("wiring the hook at update", () => {
  const root = scratch("hook-wire-instance");
  before(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  after(() => {
    remove(root);
  });

  // What the settings of an instance carry from the versions that ran a hook before every shell
  // command, on the machine's node and then on the toolkit's, and from the version that ran the
  // subagent hook on the machine's node.
  const OLD_COMPOUND = 'node "${CLAUDE_PROJECT_DIR}/lib/hooks/compound.mjs"';
  const COMPOUND = 'sh "${CLAUDE_PROJECT_DIR}/lib/hooks/run.sh" compound';
  const COMPOUND_ENTRY = { matcher: "Bash", hooks: [{ type: "command", command: COMPOUND }] };
  const OLD_SUBAGENT = 'node "${CLAUDE_PROJECT_DIR}/lib/hooks/subagent.mjs"';

  it("adds the hook to settings that lack it, wires nothing before a tool call, and leaves the rest as it was", () => {
    writeSettings(root, { permissions: SETTINGS.permissions, hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "theirs" }] }] } });
    assert.deepEqual(wireHooks(root), [settingsFile(root)]);
    const after = readSettings(root);
    assert.equal(hooksWired(after), true);
    assert.deepEqual(after.permissions, SETTINGS.permissions);
    assert.deepEqual(after.hooks.PostToolUse, [{ matcher: "Edit", hooks: [{ type: "command", command: "theirs" }] }]);
    assert.equal(after.hooks.PreToolUse, undefined);
    assert.deepEqual(after.hooks.SubagentStart, [SUBAGENT_HOOK_ENTRY]);
  });

  it("keeps a PreToolUse hook of theirs as it is", () => {
    writeSettings(root, { permissions: SETTINGS.permissions, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "theirs" }] }] } });
    wireHooks(root);
    assert.deepEqual(readSettings(root).hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "theirs" }] }]);
  });

  // The hook that let a compound of allowed commands through is gone, file and all: settings that
  // still name it would run a file that is not there before every shell command.
  it("takes the compound hook out of settings that carry it beside the subagent one, and the event with it when nothing else is left", () => {
    writeSettings(root, { permissions: SETTINGS.permissions, hooks: { PreToolUse: [COMPOUND_ENTRY], SubagentStart: [SUBAGENT_HOOK_ENTRY] } });
    assert.deepEqual(wireHooks(root), [settingsFile(root)]);
    const after = readSettings(root);
    assert.deepEqual(after.hooks, { SubagentStart: [SUBAGENT_HOOK_ENTRY] });
    assert.deepEqual(after.permissions, SETTINGS.permissions);
  });

  it("writes nothing when the hook is there and nothing retired is", () => {
    writeSettings(root, { permissions: SETTINGS.permissions, hooks: { SubagentStart: [SUBAGENT_HOOK_ENTRY] } });
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

  it("takes out the hooks wired to run on the machine's node and wires the subagent one once, on the toolkit's", () => {
    writeSettings(root, {
      permissions: SETTINGS.permissions,
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: OLD_COMPOUND }] }], SubagentStart: [{ hooks: [{ type: "command", command: OLD_SUBAGENT }] }] },
    });
    assert.deepEqual(wireHooks(root), [settingsFile(root)]);
    const after = readSettings(root);
    assert.deepEqual(after.hooks, { SubagentStart: [SUBAGENT_HOOK_ENTRY] });
    assert.deepEqual(after.permissions, SETTINGS.permissions);
  });

  it("takes a retired hook out of settings that already carry the current one, and keeps theirs from the same entry", () => {
    writeSettings(root, {
      permissions: SETTINGS.permissions,
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "theirs" }, { type: "command", command: OLD_COMPOUND }] }, COMPOUND_ENTRY],
        SubagentStart: [SUBAGENT_HOOK_ENTRY],
      },
    });
    assert.deepEqual(wireHooks(root), [settingsFile(root)]);
    const after = readSettings(root);
    assert.deepEqual(after.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "theirs" }] }]);
    assert.deepEqual(after.hooks.SubagentStart, [SUBAGENT_HOOK_ENTRY]);
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

  // A subagent has no panel, so ovai's own common frame, which is about the panel, is not for it.
  it("hands the subagent nothing of ovai's lib/templates/common.md", () => {
    fs.writeFileSync(common, "1. A line the person set.\n");
    const said = JSON.parse(run().stdout).hookSpecificOutput;
    assert.equal(said.additionalContext.includes("<ovai"), false);
    assert.equal(said.additionalContext.includes("<noop/>"), false);
  });

  it("answers nothing when the instance has no common.md, and exits 0", () => {
    fs.rmSync(common, { force: true });
    const ran = run();
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, "");
  });
});

describe("the node a hook runs on", () => {
  // The command run the way the harness runs it — by a shell, with the instance root as
  // CLAUDE_PROJECT_DIR — in a scratch instance with lib/ copied in, and a PATH whose `node` is the
  // machine's: one that says so in the log and fails.
  const root = scratch("hook-node-instance");
  const machine = scratch("hook-node-machine");
  const log = path.join(machine, "log");
  before(() => {
    remove(root, machine);
    fs.cpSync(path.join(repo, "lib"), path.join(root, "lib"), { recursive: true });
    writeSettings(root, SETTINGS);
    fs.mkdirSync(path.join(root, "customization"), { recursive: true });
    fs.writeFileSync(path.join(root, "customization", "common.md"), "1. A line the person set.\n");
    fs.mkdirSync(machine, { recursive: true });
    fs.writeFileSync(path.join(machine, "node"), `#!/bin/sh\nprintf 'machine node: %s\\n' "$*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  });
  after(() => {
    remove(root, machine);
  });

  const run = (command, input) => {
    fs.rmSync(log, { force: true });
    return spawnSync("sh", ["-c", command], {
      input,
      encoding: "utf8",
      cwd: "/",
      env: standInEnvironment(runtimeData, log, { CLAUDE_PROJECT_DIR: root, PATH: `${machine}:/usr/bin:/bin` }),
    });
  };

  it("runs the subagent hook on the node the toolkit pins, not the one on the PATH", () => {
    const ran = run(SUBAGENT_HOOK_COMMAND, JSON.stringify({ hook_event_name: "SubagentStart", agent_type: "general-purpose" }));
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(JSON.parse(ran.stdout).hookSpecificOutput.hookEventName, "SubagentStart");
    const said = fs.readFileSync(log, "utf8");
    assert.equal(said.includes("machine node"), false, said);
    assert.equal(said.includes(`node: ${path.join(root, "lib", "hooks", "subagent.mjs")}`), true, said);
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
        allow: ["mcp__openovai", "AskUserQuestion", "Read(/**)", "Edit(/reference/**)", "Edit(/projects/**)", "Edit(/temp/**)", "Edit(/knowledge/**)", "Bash(git:*)", "Bash(mkdir:*)", "Bash(cd:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(rm:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(tar:*)", "Bash(diff:*)", "Bash(cmp:*)", "Bash(sha256sum:*)", "Bash(shasum:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(sed:*)", "Bash(awk:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(echo:*)", "Bash(chmod:*)", "Bash(touch:*)", "Bash(curl:*)", "Bash(npm:*)", "Edit(/desks/Bob/**)"],
        deny: ["Edit(/.claude/**)", "Edit(/.local/settings.json)", "Edit(/.local/.claude.json)", "Read(/.local/.credentials.json)", "Edit(/.local/.credentials.json)", "Read(/page-session)", "Edit(/page-session)", "Read(/page-link)", "Edit(/page-link)", "Edit(/openovai.json)", "Bash(git push:*)", "Bash(sudo:*)", "Bash(ssh:*)"],
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
        allow: ["mcp__openovai", "Read(/**)", "Edit(/reference/**)", "Edit(/projects/**)", "Edit(/temp/**)", "Bash(git:*)", "Bash(mkdir:*)", "Bash(cd:*)", "Bash(node:*)", "Bash(bash:*)", "Bash(sh:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(rm:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(tar:*)", "Bash(diff:*)", "Bash(cmp:*)", "Bash(sha256sum:*)", "Bash(shasum:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(sed:*)", "Bash(awk:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(echo:*)", "Bash(chmod:*)", "Bash(touch:*)", "Bash(curl:*)", "Bash(npm:*)"],
        deny: ["Edit(/.claude/**)", "Edit(/.local/settings.json)", "Edit(/.local/.claude.json)", "Bash(git push:*)", "Bash(sudo:*)", "Bash(ssh:*)"],
      },
    });
    const text = fs.readFileSync(settingsFile(root), "utf8");
    assert.deepEqual(spelt(rulesMissing(root)), ["allow AskUserQuestion", "allow Edit(/knowledge/**)", "deny Read(/.local/.credentials.json)", "deny Edit(/.local/.credentials.json)", "deny Read(/page-session)", "deny Edit(/page-session)", "deny Read(/page-link)", "deny Edit(/page-link)", "deny Edit(/openovai.json)", "ask Edit(/customization/**)", "ask Edit(/knowledge/common.md)"]);
    assert.equal(fs.readFileSync(settingsFile(root), "utf8"), text);
  });

  it("names each rule the settings lack, by the list it belongs in, and adds none", () => {
    writeSettings(root, { permissions: { allow: ["mcp__openovai", "Read(/**)", "Edit(/reference/**)", "Edit(/projects/**)", "Edit(/temp/**)"], deny: ["Edit(/.claude/**)", "Edit(/.local/settings.json)", "Edit(/.local/.claude.json)"], ask: ["Edit(/customization/**)"] } });
    const text = fs.readFileSync(settingsFile(root), "utf8");
    const missing = spelt(rulesMissing(root));
    assert.equal(missing.length, 38);
    assert.equal(missing[0], "allow AskUserQuestion");
    assert.equal(missing.includes("deny Bash(git push:*)"), true);
    assert.equal(missing.includes("deny Bash(ssh:*)"), true);
    assert.equal(missing.some((entry) => entry.includes("desks/")), false);
    assert.equal(fs.readFileSync(settingsFile(root), "utf8"), text);
  });

  // Each default carries the words its card says, and nothing else is asked for.
  it("gives every missing rule the why its card shows", () => {
    writeSettings(root, { permissions: {} });
    const missing = rulesMissing(root);
    assert.equal(missing.every(({ why }) => typeof why === "string" && why.length > 20), true);
    assert.equal(missing.find(({ rule }) => rule === "Bash(sudo:*)").why, "Refuses this command to every session: a push is yours to make, and sudo and ssh reach beyond this instance.");
  });

  // A default the person put in another list than the one it is born in is a decision taken:
  // `Bash(curl:*)` asked every time and `Bash(sudo:*)` allowed are not asked for again.
  it("takes a rule held in any list as settled", () => {
    writeSettings(root, { permissions: { ask: ["Bash(curl:*)"], allow: ["Bash(sudo:*)"] } });
    const missing = spelt(rulesMissing(root));
    assert.equal(missing.includes("allow Bash(curl:*)"), false);
    assert.equal(missing.includes("deny Bash(sudo:*)"), false);
    assert.equal(missing.includes("allow Bash(git:*)"), true);
  });

  // Ignore is remembered, privately, once; and an ignored rule is not asked again.
  it("leaves out a rule the User ignored, kept in a private file", () => {
    writeSettings(root, { permissions: {} });
    assert.deepEqual(ignoreDefault(root, { list: "deny", rule: "Bash(ssh:*)" }), [path.join(root, IGNORED_DEFAULTS)]);
    assert.deepEqual(ignoreDefault(root, { list: "deny", rule: "Bash(ssh:*)" }), []);
    assert.equal(fs.statSync(path.join(root, IGNORED_DEFAULTS)).mode & 0o777, 0o600);
    assert.deepEqual(defaultsIgnored(root), [{ list: "deny", rule: "Bash(ssh:*)" }]);
    const missing = spelt(rulesMissing(root));
    assert.equal(missing.includes("deny Bash(ssh:*)"), false);
    assert.equal(missing.includes("deny Bash(sudo:*)"), true);
    fs.writeFileSync(path.join(root, IGNORED_DEFAULTS), "{ not json\n");
    assert.equal(spelt(rulesMissing(root)).includes("deny Bash(ssh:*)"), true);
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
