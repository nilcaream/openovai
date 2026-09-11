// tests/install.test.mjs — install an instance, check it is the one that was asked for, remove it.
//
// It needs Node.js and nothing else. Claude Code is only needed to run an instance, so the
// checks that would start one are skipped when it is not installed, and the run still says so.
//
// Run it with: node --test tests/install.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, it } from "node:test";

import {
  claudeIsInstalled,
  install,
  installed,
  remove,
  repo,
  runOvai,
  scratch,
  writeNodeStandIn,
} from "./helpers.mjs";
import { configProblems, settingsProblems } from "./inspect.mjs";
import { CUSTOMIZATION, persona } from "../tools/desks.mjs";
import { PAYLOAD } from "../tools/payload.mjs";
import { RELEASE_NOTES } from "../tools/release.mjs";

const HUMAN = "Mike";
const LEADER = "Superman";
const LEADER_MODEL = "sonnet";
const WORKER_MODEL = "haiku";
const PORT = 7801;
const AUTH = "inherit";

const instance = scratch("install-test");
const chosen = `${instance}-chosen`;

// Everything the Node checks need: one stand-in node per version they pretend to have, and one
// instance root per install that is expected to go through.
const versions = `${instance}-versions`;

// A source that is this workspace in every way except the version, so a check can ask what the
// installer does about one. Everything else is COPIED rather than made empty: a source of empty
// directories is refused later anyway, when a template it needs turns out not to be there, and a
// check that cannot tell those two refusals apart is not about the version at all.
const versionless = `${instance}-versionless`;

// The instances are removed however this run ends, including one that fails half way through.
process.on("exit", () => remove(instance, chosen, versions, versionless, `${instance}-over`));

// A full command line, which a check then spoils in one place to ask what is refused.
function options(root, changes = {}) {
  return {
    "--root": root,
    "--source": repo,
    "--human": HUMAN,
    "--leader": LEADER,
    "--leader-model": LEADER_MODEL,
    "--worker-model": WORKER_MODEL,
    "--port": PORT,
    "--auth": AUTH,
    ...changes,
  };
}

// A PATH whose node reports the version given. The installer only asks node what version it
// is, so this is enough to put it in front of a Node nobody here has installed.
function pretending(version) {
  const directory = path.join(versions, "node", version);
  writeNodeStandIn(directory, version);
  return { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` };
}

function rootFor(version) {
  return path.join(versions, "root", version);
}

// Built once, on first use: the checks that want it are two, and building it in each of them
// would say the same thing twice.
function withoutVersion() {
  if (!fs.existsSync(versionless)) {
    for (const entry of ["bin", "tools", "templates"]) {
      fs.cpSync(path.join(repo, entry), path.join(versionless, entry), { recursive: true });
    }
  }
  return versionless;
}

function inside(...parts) {
  return path.join(instance, ...parts);
}

function contentOf(...parts) {
  return fs.readFileSync(inside(...parts), "utf8");
}

// What the lead is told, rendered the way the chat renders it when the lead's first conversation
// starts: from the templates the installer put in place, with the names written in. The installer
// writes no persona file, so this is the one way to read what a lead of this instance would be told.
function leadPersona(root = instance) {
  return persona(root, LEADER, { human: HUMAN, leader: LEADER });
}

remove(instance, chosen);
const made = installed(options(instance));

describe("what the installer made", () => {
  it("writes the instance its own description", () => {
    assert.ok(fs.existsSync(inside("openovai.json")));
  });

  it("copies the launcher in", () => {
    assert.ok(fs.existsSync(inside("bin", "ovai")));
  });

  it("leaves the launcher executable", () => {
    assert.doesNotThrow(() => fs.accessSync(inside("bin", "ovai"), fs.constants.X_OK));
  });

  it("copies the installer in", () => {
    assert.ok(fs.existsSync(inside("tools", "install.mjs")));
  });

  it("copies the instance command in", () => {
    assert.ok(fs.existsSync(inside("tools", "ovai.mjs")));
  });

  it("copies the version in", () => {
    assert.ok(fs.existsSync(inside("VERSION")));
  });

  // Read out of the source rather than compared with a literal. A version written into the check
  // as well as into the file would agree with itself on the day it was written and never again.
  it("carries the version the source is on", () => {
    assert.equal(contentOf("VERSION").trim(), fs.readFileSync(path.join(repo, "VERSION"), "utf8").trim());
  });

  it("copies the desk template in", () => {
    assert.ok(fs.existsSync(inside("templates", "STATE.md")));
  });

  it("copies the memory index template in", () => {
    assert.ok(fs.existsSync(inside("templates", "MEMORY.md")));
  });

  // Where a session reads it is not the installer's choice — it is inside the instance's own
  // Claude Code home, under the fixed name that survives the instance being moved. The path is
  // spelled out here rather than asked of the code, so that moving the index and moving the check
  // cannot be one edit.
  it("gives the instance an index of what it knows, where its sessions read it", () => {
    assert.ok(fs.existsSync(inside(".claude-home", "projects", "workspace", "memory", "MEMORY.md")));
  });

  it("says in that index what belongs in it", () => {
    assert.match(
      contentOf(".claude-home", "projects", "workspace", "memory", "MEMORY.md"),
      /work it out again/,
    );
  });

  it("says it wrote the index", () => {
    assert.ok(made.stdout.includes(inside(".claude-home", "projects", "workspace", "memory", "MEMORY.md")));
  });

  // The path is spelled out rather than asked of the code. The key is only honoured in the home's
  // settings, so a check that followed the code would go on passing if the file moved to the
  // instance's own settings and stopped meaning anything.
  it("brings a refused session back by itself rather than leaving it on a dialog", () => {
    const settings = JSON.parse(contentOf(".claude-home", "settings.json"));
    assert.equal(settings.autoContinueAtUsageLimit, true);
  });

  it("says it wrote those settings", () => {
    assert.ok(made.stdout.includes(inside(".claude-home", "settings.json")));
  });

  it("makes a directory for the settings", () => {
    assert.ok(fs.statSync(inside(".claude")).isDirectory());
  });

  it("makes the instance its own Claude Code home", () => {
    assert.ok(fs.statSync(inside(".claude-home")).isDirectory());
  });

  it("gives the leader a desk", () => {
    assert.ok(fs.existsSync(inside("work", LEADER, "STATE.md")));
  });

  it("names the leader on that desk", () => {
    assert.match(contentOf("work", LEADER, "STATE.md"), new RegExp(`^# ${LEADER}$`, "m"));
  });

  // The header is one line holding one field, and that is the whole definition of it: the title is
  // what anything outside the desk reads, so it is what the header carries and there is nothing
  // else in there for a session to keep true for nobody.
  it("opens that desk with a header holding the title and nothing else", () => {
    assert.equal(contentOf("work", LEADER, "STATE.md").split("\n")[0], "<!-- DESK | title: -->");
  });

  it("leaves no unfilled placeholder on the desk", () => {
    assert.ok(!contentOf("work", LEADER, "STATE.md").includes("{{"));
  });

  it("copies the leader persona template in", () => {
    assert.ok(fs.existsSync(inside("templates", "leader.md")));
  });

  it("copies the worker persona template in", () => {
    assert.ok(fs.existsSync(inside("templates", "worker.md")));
  });

  // The skill a lead answers "what may be done here" from is payload: placed where a session
  // reads a skill from, and replaced by an update, which is what keeps an instance from carrying a
  // year-old account of a runtime that has been measured to do something else since.
  it("places the skill an instance explains itself with where a session reads it", () => {
    assert.ok(fs.existsSync(inside(".claude", "skills", "allowed", "SKILL.md")));
  });

  it("names the skill among what it wrote", () => {
    assert.ok(made.stdout.includes(inside(".claude", "skills", "allowed")));
  });

  // The one sentence in the persona for it. A persona is rendered when a conversation starts and
  // read as it is until the conversation ends, so this is the half that has to be right in the
  // template as well: a lead reading only the block pushed into its first turn would answer the
  // question from memory on every turn after it.
  it("tells the leader to answer what the workspace allows from the skill, never from memory", () => {
    const persona = leadPersona();
    assert.match(persona, /run the\s+`allowed` skill and report what it answers/);
    assert.match(persona, /Never answer that question from memory/);
  });

  // Who the lead is gets rendered when its first conversation starts, from the templates just put
  // in place — so there is nothing here to say who anybody was, and nothing for an update to leave
  // stale.
  it("writes no persona, and makes no directory for one", () => {
    assert.equal(fs.existsSync(inside("personas")), false);
    assert.equal(fs.existsSync(inside("chat")), false);
  });

  it("says in the persona who the leader is", () => {
    assert.ok(leadPersona().includes(`You are ${LEADER}, ${HUMAN}'s lead`));
  });

  it("points the persona at the leader's own desk", () => {
    assert.ok(leadPersona().includes(`work/${LEADER}/STATE.md`));
  });

  // The same budget the workspace writes into every other persona. It is one block from one place,
  // so the lead and the workers cannot end up telling agents two different things — and the lead is
  // the one here who hands out the most work, so a lead without it is the expensive half.
  it("tells the lead how much a brief it writes may spend", () => {
    const persona = leadPersona();
    assert.match(persona, /at most 15 tool calls/);
    assert.match(persona, /report what you have and say what is missing/);
  });
  it("leaves no unfilled placeholder in the persona", () => {
    assert.ok(!leadPersona().includes("{{"));
  });

  // What the person adds to a persona. Their file, at the root beside work/, read as it is and put
  // after everything the toolkit puts in — so it can add to what a session is told and cannot take
  // any of it away, and an update, which replaces the templates, never reaches it.
  describe("what the person adds to a persona", () => {
    const ADDED = "Always answer in French. Keep {{THIS}} as it is.\n";
    const file = inside(CUSTOMIZATION, "leader.md");
    let plain;
    let added;

    before(() => {
      plain = leadPersona();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, ADDED);
      added = leadPersona();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });

    it("is the template alone while there is nothing added", () => {
      assert.ok(!plain.includes("Always answer in French"));
    });

    it("comes after everything the toolkit puts in, the budget included", () => {
      assert.ok(added.startsWith(plain.replace(/\s*$/, "")));
      assert.ok(added.indexOf("Always answer in French") > added.indexOf("at most 15 tool calls"));
    });

    it("is read as it is, braces and all", () => {
      assert.ok(added.endsWith("Keep {{THIS}} as it is.\n"));
    });

    it("is the person's, so the installer does not make the directory for it", () => {
      assert.equal(fs.existsSync(inside(CUSTOMIZATION)), false);
    });
  });

  it("gives the instance settings of its own", () => {
    assert.ok(fs.existsSync(inside(".claude", "settings.json")));
  });

  it("writes those settings as valid JSON", () => {
    assert.doesNotThrow(() => JSON.parse(contentOf(".claude", "settings.json")));
  });

  it("lets the leader write its own desk, and nothing wider", () => {
    assert.deepEqual(settingsProblems(inside(".claude", "settings.json"), [LEADER]), []);
  });

  // A lead that cannot reach the team has to do the work itself. The rule is relative, like the
  // desk rules, because a session is started with the instance root as its working directory.
  it("names each file it wrote once, however many things went into it", () => {
    const settings = inside(".claude", "settings.json");
    assert.equal(made.stdout.split("\n").filter((line) => line.trim() === settings).length, 1);
  });

  // What a session calls to reach another. Without the rule the call is refused outright, or parks
  // a request on a panel nobody may be watching — for every message a session sends.
  it("lets a session say something to another without being asked", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(allow.includes("mcp__openovai"));
  });

  // The other half of the file, and the only refusals a fresh instance holds. The rules are spelled
  // out here rather than asked of the code: a check that read the list it is checking would agree
  // with itself the day somebody widened it.
  //
  // What they are worth is narrower than it looks and the workspace says so where it says anything
  // about them: `Edit(...)` binds the tools that write a file, so a granted shell rule reaches
  // these paths whatever the refusal says.
  it("closes its own account of what it allows to the tools that write files", () => {
    const deny = JSON.parse(contentOf(".claude", "settings.json")).permissions.deny;
    assert.deepEqual(deny, [
      "Edit(.claude/**)",
      "Edit(.claude-home/settings.json)",
      "Edit(.claude-home/.claude.json)",
    ]);
  });

  // The trap in writing a second key into that file: the desk rules and the refusals are written
  // into it by the same run, one after the other, and a writer that replaced the object rather than
  // merging into it would take whichever went first away again.
  it("keeps what it grants while writing what it refuses", () => {
    const permissions = JSON.parse(contentOf(".claude", "settings.json")).permissions;
    assert.deepEqual(permissions.allow, [`Edit(work/${LEADER}/STATE.md)`, "mcp__openovai"]);
  });

  // A refusal is absolute: no rule overrides it, the call never reaches a panel, and somebody who
  // works differently is blocked rather than defaulted away. So these name the workspace's account
  // of itself and nothing anybody works on.
  it("refuses nothing about anybody's work", () => {
    const deny = JSON.parse(contentOf(".claude", "settings.json")).permissions.deny;
    assert.deepEqual(deny.filter((rule) => !rule.startsWith("Edit(.claude")), []);
  });

  // And the subtree deliberately left open, because the memory index and the transcripts live in
  // it: refusing that one would break memory to protect nothing.
  it("leaves what the instance remembers alone", () => {
    const deny = JSON.parse(contentOf(".claude", "settings.json")).permissions.deny;
    assert.deepEqual(deny.filter((rule) => rule.includes("projects")), []);
  });

  // The ledger is what this workspace allows beyond a desk, and a refusal is not a grant. A fresh
  // instance has nothing to account for, which is also what the first turn of one reads to decide
  // whether it has ever settled anything.
  it("accounts for none of them, since a refusal is not something somebody asked for", () => {
    assert.ok(!fs.existsSync(inside(".claude", "allowed.md")));
  });

  // It replaced two rules, one per spelling of a command. Nothing should be left granting a shell
  // line no persona names any more: a grant nobody uses is a grant nobody is watching.
  it("no longer grants the command it replaced", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(!allow.some((rule) => rule.includes("ovai say")));
  });

  // Seeing who else works here is a tool now, under the one rule above. Watched before there was
  // any rule for it: a lead sat parked on `bin/ovai status` for six and a half minutes and would not
  // have stopped, so nothing may be left telling a session to type it.
  it("no longer grants the command that listed who works here", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(!allow.some((rule) => rule.includes("ovai status")));
  });

  it("tells the leader how to say something to somebody", () => {
    assert.match(leadPersona(), /the `say` tool says something to one of them/);
  });

  // A persona that still named the command would be telling a session to type a shell line the
  // instance no longer grants, which is a session stopped for doing as it was told.
  it("does not tell the leader to type the command it replaced", () => {
    assert.ok(!leadPersona().includes("ovai say"));
  });

  it("tells the leader how to see who works here", () => {
    assert.match(leadPersona(), /The `status` tool lists who\s+works here/);
  });

  it("does not tell the leader to type the command that listed who works here", () => {
    assert.ok(!leadPersona().includes("ovai status"));
  });

  // The two tools that change who works here. A tool is offered whether or not the persona says a
  // word about it, so what is checked here is that the lead is TOLD — a lead reaching for something
  // it has only inferred from a tool list reaches for it the way it guessed.
  it("tells the leader it can open a desk, and what that opens", () => {
    assert.match(leadPersona(), /`hire` opens a desk for somebody new/);
    assert.match(leadPersona(), /Nothing is started by\s+it/);
  });

  // What somebody runs on is the lead's too, and a tool is offered whether or not the persona says
  // so — a lead that has only inferred the argument from a schema reaches for it the way it
  // guessed, or never reaches for it at all.
  it("tells the leader that hiring takes a model beside the name", () => {
    assert.match(leadPersona(), /`hire` takes a model beside the\s+name/);
  });

  // And the half that keeps it a default rather than a decision to be taken every time.
  it("tells the leader that leaving it out uses the workspace's own", () => {
    assert.match(leadPersona(), /leaving it out puts them on the one this workspace runs its workers on/);
  });

  // The cost, and what to do about it. A stronger model comes out of the window everybody here
  // shares, so the choice is one the human is entitled to see a reason for.
  it("tells the leader to say why, on its own panel, when it chooses one", () => {
    assert.match(leadPersona(), /say on\s+your own panel why/);
  });

  // The check that keeps one workspace's policy out of everybody's product. `templates/` ships
  // with the toolkit and is rendered into every instance, so a model named in it would be this
  // workspace's answer written into everybody's — and it would go stale the week the service
  // renames something. What the models here are is `openovai.json`'s to say, not the persona's.
  it("names the leader no model at all", () => {
    const persona = leadPersona();
    assert.ok(!persona.includes(LEADER_MODEL), persona);
    assert.ok(!persona.includes(WORKER_MODEL), persona);
    assert.doesNotMatch(persona, /\b(opus|sonnet|haiku)\b/i);
  });

  // The half that has to survive an edit: filed, not thrown away. Without it the paragraph reads as
  // deletion, and a lead that reads it as deletion will not use it when it should.
  it("tells the leader that putting a desk away files it rather than throws it away", () => {
    assert.match(leadPersona(), /`retire` is the other end of it/);
    assert.match(leadPersona(), /files rather than throws away/);
  });

  // What the tool refuses, said as whose it is rather than as a rule. A lead told only that the
  // name was refused goes looking for a way round it, and there is one — moving the conversation —
  // which is exactly the thing that is not the lead's to do.
  it("tells the leader that a conversation somebody left behind is not its to move", () => {
    assert.match(
      leadPersona(),
      /A conversation somebody left behind is\s+a person's to move out of the way/,
    );
  });

  // The one that bites the copy-paste. A worker told about a tool it cannot call goes hunting for
  // it, and what it finds is the refusal naming the lead — a whole turn spent on a sentence.
  it("tells a worker about neither of them", () => {
    const worker = contentOf("templates", "worker.md");
    assert.ok(!worker.includes("`hire`"), "the worker template names hire");
    assert.ok(!worker.includes("`retire`"), "the worker template names retire");
  });

  // And the other direction: the sentence that tells a worker whose these are is the WORKER's. A
  // lead reading it would be told the thing it does is somebody else's, which is the one reading
  // of it that is wrong.
  it("does not tell the leader the workspace is somebody else's", () => {
    assert.doesNotMatch(
      contentOf("templates", "leader.md"),
      /who is asked to join and who leaves/,
    );
  });

  // The block is pushed into a turn; the template is what a lead is running when it reads it. An
  // update ships new templates and re-renders nobody's persona, so the three things a lead got
  // wrong on a real instance have to be in both or a lead hired today reads only half of them.
  it("tells the leader that a trip only counts when the call stops", () => {
    const leader = contentOf("templates", "leader.md");
    assert.match(leader, /only counts when it stops/);
    assert.match(leader, /allows commands but names none/);
    assert.match(leader, /never what they said/);
  });

  // And the fourth, found by the re-test: a lead told to watch the panel guesses, because it is
  // never shown one. Here too the template has to say it, or a lead hired today is the one still
  // reporting a press it cannot see.
  it("tells the leader the panel is not shown to it and the ledger is the record", () => {
    const leader = contentOf("templates", "leader.md");
    assert.match(leader, /not shown their panel/);
    assert.match(leader, /allowed\.md/);
  });

  // The room watch acts by itself now — it ends a cold conversation and hands seats over under an
  // account hold, and it spends no lead turn doing either. The template used to say the opposite:
  // that the watch gave the lead a turn and that nothing stopped running because of any of the four
  // readings. A persona is rendered once per conversation and read as it is until that ends, so a
  // template that lies about what the chat does is a lie every conversation started on it keeps.
  // Held here to the three things the pass does, and against the two sentences it retired.
  it("tells the leader what the room watch does by itself, and no longer that it gives a turn", () => {
    const leader = contentOf("templates", "leader.md");
    assert.match(leader, /reads the room itself and acts on what it reads/);
    assert.match(leader, /ended there and then/);
    assert.match(leader, /hands each conversation over to its desk itself/);
    assert.match(leader, /sitting on a permission prompt is left alone/);
    assert.doesNotMatch(leader, /gives you a turn to hear it/);
    assert.doesNotMatch(leader, /Nobody typed that turn/);
    assert.doesNotMatch(leader, /nothing stops running because of any of/);
  });

  // The room is the third of them, and the only one the lead alone is offered. Watched here as
  // well as on the endpoint: what the instance grants and what the persona names have to move
  // together, or a lead is told to ask for something nothing will serve it.
  it("no longer grants the command that showed the room", () => {
    const allow = JSON.parse(contentOf(".claude", "settings.json")).permissions.allow;
    assert.ok(!allow.some((rule) => rule.includes("ovai room")));
  });

  // What the lead cannot see for itself: its own lines wait while the person it is talking to is
  // writing. A lead that did not know would read a panel that had gone quiet as a person who had
  // stopped listening, and say it all again.
  it("tells the leader that what it says waits while the human is writing", () => {
    assert.match(leadPersona(), /panel stops moving for them/);
    assert.match(leadPersona(), /how many\s+are waiting and who from/);
  });

  // The exception, and the whole of it. The tool is offered to the lead whether or not the persona
  // says a word about it, so what is checked here is that the CLASS is written down: a tool with no
  // rule beside it is a tool used for whatever seems worth it at the time.
  it("tells the leader the one class it may break in for", () => {
    assert.match(leadPersona(), /`interrupt`/);
    assert.match(
      leadPersona(),
      /makes the answer they are writing pointless, or\s+something needs them now/,
    );
  });

  // The rest of that rule, and the half the popup made necessary. The chat pops the person's
  // desktop itself on the two transitions, so a lead that also raises one has taken a channel
  // nobody granted it — and a second way in is what teaches somebody to stop trusting the first.
  // Whatever notification tool the harness hands the lead is in its hands whether or not this
  // file says a word, which is exactly why this file has to say one.
  it("tells the leader it has no channel to the human but the one", () => {
    assert.match(leadPersona(), /There is no other channel either/);
    assert.match(leadPersona(), /`PushNotification`, `notify-send`/);
    assert.match(
      leadPersona(),
      /is not a second way to reach them, and you do not use it/,
    );
  });

  // The other half of the same rule, and the reason the channel is worth protecting at all. The
  // lead is the stateful one here, so holding the rest of the questions costs it a line on its desk
  // and costs the person nothing.
  it("tells the leader to ask one question at a time and hold the rest on its desk", () => {
    assert.match(leadPersona(), new RegExp(`Ask ${HUMAN} one thing at a time`));
    assert.match(leadPersona(), /hold the rest of them on it, and ask the first/);
  });
  it("tells the leader that a message from a session comes wrapped", () => {
    assert.match(leadPersona(), /<from-session name=/);
  });

  it("tells the leader that what is outside a wrapper is the human", () => {
    assert.match(leadPersona(), new RegExp(`outside a wrapper is\\s+${HUMAN}`));
  });

  // The finding of the measurement: on a real lead, four worker turns out of five ended with a
  // sentence addressed to the human that only the worker could read. The tool split is invisible
  // from inside a turn, so the persona has to name who the answer reaches.
  it("tells the leader that its answer reaches whoever spoke to it", () => {
    assert.match(
      leadPersona(),
      /goes back to whoever spoke to you in it, and to nobody else/,
    );
    assert.match(leadPersona(), new RegExp(`a line you address to\\s+${HUMAN}`));
  });

  // And what to do instead, which is the whole point of saying it: the worker gets the answer, the
  // human gets a break-in when it cannot wait. Without this line the rule reads as a prohibition.
  it("tells the leader where each thing goes instead", () => {
    assert.match(leadPersona(), /answer the worker in the answer/);
    assert.match(
      leadPersona(),
      new RegExp(`if\\s+${HUMAN} has to know before you are next asked, \`interrupt\``),
    );
  });

  it("tells the leader that the chat says what was typed on another panel", () => {
    assert.match(leadPersona(), /<overheard on="[^"]*" from="Mike">/);
  });

  // An update ships new templates and re-renders nothing, so this paragraph is for the sessions
  // hired after one — the lead that was running through the update is told in the wrapper itself.
  it("tells the leader that the chat says when the toolkit under it was replaced", () => {
    assert.match(leadPersona(), /<update from="[^"]*" to="[^"]*">/);
  });

  it("tells the leader that an update leaves the desks and the personas alone", () => {
    assert.match(leadPersona(), /desks, the personas and what this workspace has learned are\s+untouched/);
  });

  it("tells the leader when it will hear it, since it is not at the moment it was said", () => {
    assert.match(leadPersona(), /at the start of your\s+next turn/);
  });

  // The lead used to be told the workers would pass it on. They no longer do, and a persona still
  // saying so would have it waiting for something that is not coming.
  it("no longer tells the leader that workers pass it on themselves", () => {
    assert.ok(!leadPersona().includes("Workers are told to tell you"));
  });

  // The lead keeps a desk and is handed over exactly as everybody else is, so it is told the same
  // thing — and told to write the part of the desk only a lead has, which is the room.
  it("tells the leader what a handover arrives as", () => {
    assert.match(leadPersona(), /<handover>/);
  });

  it("tells the leader which file to write when one does", () => {
    assert.match(leadPersona(), new RegExp(`<handover>[\\s\\S]*work/${LEADER}/STATE.md`));
  });

  it("tells the leader that the thread ends when it answers", () => {
    assert.match(leadPersona(), /the\s+thread ends when you answer/);
  });

  // The lead is not exempt from the ending nobody announces, and is the session it takes most from:
  // what goes is who it had waiting on what, which is nowhere else unless its desk says so.
  it("tells the leader that a conversation can also end unannounced", () => {
    assert.match(leadPersona(), /<pick-up>/);
  });

  it("tells the leader which file to read when one does", () => {
    assert.match(leadPersona(), new RegExp(`<pick-up>[\\s\\S]*work/${LEADER}/STATE.md`));
  });

  it("tells the leader that everybody here reads what the workspace has learned", () => {
    assert.match(leadPersona(), /everybody\s+here reads the same thing/);
  });

  it("tells the leader what belongs in the memory rather than on a desk", () => {
    assert.match(leadPersona(), /the memory is the workspace/);
  });

  it("tells the leader to keep the desk current before one is ever asked for", () => {
    assert.match(leadPersona(), /kept current as you go and not only then/);
  });

  // What the lead is on has to come from somewhere, and the only thing that knows it is the lead.
  // One field of the desk header, named in the persona, is the whole of the arrangement.
  // The lead is the one session that cannot look at the page, because it is on it. Naming the
  // command in its persona is the whole of how it finds out; a command a persona names and an
  // instance does not grant is the failure this repo has already had twice.
  it("tells the leader how to see the room", () => {
    assert.match(leadPersona(), /The `room` tool is the other half of that/);
  });

  it("does not tell the leader to type the command that showed the room", () => {
    assert.ok(!leadPersona().includes("ovai room"));
  });

  // Said in the persona because it is not said anywhere else the lead reads: a tool it is offered
  // and the others are not is the only asymmetry in this instance, and a lead that did not know
  // would tell a worker to go and look for itself.
  it("tells the leader the room is its own to look at", () => {
    assert.match(leadPersona(), /it is yours alone/);
  });

  it("tells the leader the room is true at the moment it asks", () => {
    assert.match(leadPersona(), /true at the moment you ask/);
  });

  // The rule the lead is held to about a room it did not ask for, and the one exception to it.
  //
  // The rule was in this persona from the day the room was, and nothing in any suite read it — so
  // the day something WAS handed over unasked, the sentence forbidding it could have been left
  // standing beside the thing that made it false, and no check would have said a word. This is
  // that sentence getting the check it was believed to have.
  it("tells the leader a room it did not ask for is not handed to it, and names every exception", () => {
    const persona = leadPersona();
    assert.match(persona, /The room is not handed to you unasked/);
    assert.match(persona, /Four things are handed to you without your asking/);
    assert.match(persona, /who has stopped/);
    assert.match(persona, /how big the conversations here have grown/);
    assert.match(persona, /where the account's usage window stands/);
    // And what the last of them can actually ask for, which is the whole workspace stopped and every
    // conversation in it ended. A persona that named the reading without naming what it says would
    // leave the lead reading an instruction it had been told nothing about.
    assert.match(persona, /tell you to stop the tasks and put everybody down/);
    // Three of them are advice; the fourth acts. The sentence that made all four advice was the one
    // the room watch made false the day it began parking, so the persona is held to the split.
    assert.match(persona, /Three of the four are advice and not\s+rules the toolkit keeps/);
    assert.match(persona, /The\s+fourth acts/);
    // And the fourth, which is the one that does not ride on a turn the lead was having anyway. A
    // persona that named three while the chat handed over four would leave the lead reading a block
    // its own instructions say it does not get.
    assert.match(persona, /The fourth is the room watch/);
    // And what the middle one can ask for, which is a person being sent to a panel — so the persona
    // has to say that pressing it is not the lead's, or it would read as something it could do.
    assert.match(persona, /You cannot hand a session over/);
  });

  it("tells the leader which one field of its header is read by anybody else", () => {
    assert.match(leadPersona(), /the `title:` in it is the one field/);
  });

  it("tells the leader to keep that field saying what it is on", () => {
    assert.match(leadPersona(), /Keep it saying what you are on/);
  });

  // And that there is nothing else in that header to keep true for anybody else's sake.
  it("tells the leader its header holds nothing else", () => {
    assert.match(leadPersona(), /header holds nothing else/);
  });

  it("warns the leader that asking somebody waits for them", () => {
    assert.match(leadPersona(), /waits for them/);
  });

  it("describes the instance that was asked for", () => {
    assert.deepEqual(
      configProblems(inside("openovai.json"), {
        human: HUMAN,
        leader: LEADER,
        leaderModel: LEADER_MODEL,
        workerModel: WORKER_MODEL,
        port: PORT,
        auth: AUTH,
      }),
      [],
    );
  });
});

// What the skill makes a lead do, read from the copy the instance was shipped. It is a procedure
// rather than an answer, and the parts of the procedure that keep the answer honest are the parts
// worth watching: the blocks it must not skip, and the three sentences that stop each of the three
// ways this report can be confidently wrong.
describe("what the skill tells a lead to report", () => {
  const skill = () => contentOf(".claude", "skills", "allowed", "SKILL.md");

  it("is found under the name the workspace sends a session to", () => {
    assert.match(skill(), /^name: allowed$/m);
  });

  it("says it is the toolkit's and an edit to it lasts until the next update", () => {
    assert.match(skill(), /taking a newer toolkit replaces it/);
    assert.match(skill(), /lasts\s+until the next update/);
  });

  it("has the lead read the files in the turn it is asked, never remember", () => {
    assert.match(skill(), /\*\*Read now, in this turn\.\*\*/);
    assert.match(skill(), /Never answer from the conversation/);
  });

  it("carries on past a file it cannot read rather than dying on the first one", () => {
    assert.match(skill(), /a line in the report, never the end of it/);
  });

  it("makes every claim carry its line", () => {
    assert.match(skill(), /Every claim carries `path:line`/);
  });

  // The whole point of the feature, in the file that has to say it.
  it("keeps what is written apart from what is honoured", () => {
    assert.match(skill(), /Never merge what is written with what is honoured/);
  });

  // The order is the shape: a report that leaves one out is wrong about a mechanism rather than
  // short of a paragraph, and the two most likely to be dropped are the ones with no rule in them.
  it("lays down seven blocks and their order", () => {
    const blocks = [...skill().matchAll(/^### ([A-G])\. /gm)].map(([, letter]) => letter);
    assert.deepEqual(blocks, ["A", "B", "C", "D", "E", "F", "G"]);
  });

  // A hook runs shell on a tool event with no permission decision at all, so nothing in the other
  // blocks would ever mention it. A report on what an instance may do that omits the one mechanism
  // able to run a command without being asked is not the report this feature promises.
  it("has the mode block name what the hooks are", () => {
    assert.match(skill(), /one line for \*\*hooks\*\*/);
    assert.match(skill(), /run a command without being asked/);
  });

  // The correction a reviewer forced: a deny rule binds the tools its matcher names. An Edit rule
  // closes those paths to the file-writing tools and a granted shell rule walks straight past it,
  // so the report crosses the two lists rather than saying the instance cannot widen itself.
  it("has the denied block cross its paths against the shell rules that reach them", () => {
    assert.match(skill(), /a rule binds the tools its matcher names, and\s+no others/);
    assert.match(skill(), /does not stop a shell command from\s+reaching it/);
    assert.match(skill(), /`Bash\(sed:\*\)` reaches the paths\s+`Edit\(\.claude\/\*\*\)` protects/);
  });

  it("has the allowed block say when nothing accounts for a rule", () => {
    assert.match(skill(), /nothing accounts for this rule/);
  });

  // What a person is never asked about is not what they cannot forbid, and reading the first as
  // the second is how somebody concludes a whole class of calls is out of their hands.
  it("says the calls that never stop are out of reach of allow and not of deny", () => {
    assert.match(skill(), /out of reach of\s+`allow`; it is \*\*not\*\* out of reach of `deny`/);
  });

  // The second mechanism. A report built only on the rules would be confidently wrong about the
  // thing people ask about most, which is whether a write will go through.
  it("names the working directory as a refusal with no rule in it", () => {
    assert.match(skill(), /no permission rule involved and no permission decision to point at/);
    assert.match(skill(), /may not claim a write will be allowed on rule evidence alone/);
  });

  // The trust check is an inference from two measured facts, and the runtime's own statement of it
  // is a stderr line nothing here reads. A block that quietly read as measured would be this
  // feature's own failure, one level up.
  it("makes the trust check admit it is a reconstruction", () => {
    assert.match(skill(), /our reconstruction and not the runtime speaking/);
    assert.match(skill(), /mark it Assumes/);
  });

  it("says an untrusted workspace loses its allow entries and keeps the rest", () => {
    assert.match(skill(), /and only the allow\s+entries/);
    assert.match(skill(), /can still forbid and can no longer permit/);
  });

  // Silence is not proof: the line counts only the ignored allows, so a file with none produces no
  // line either way and a report reading that as confirmation would invent what it is here to stop.
  it("says the runtime's one statement of it proves nothing by its absence", () => {
    assert.match(skill(), /counts only the \*ignored allows\*/);
  });

  it("says a settings file that fails to parse grants nothing and says nothing", () => {
    assert.match(skill(), /silently ignored in that mode/);
  });

  // Version-sensitive and measured on one bundle. A check that asserted it on every version would
  // be the file claiming something about a runtime nobody had measured.
  it("skips the auto-mode stripping outside auto mode, and dates what it knows", () => {
    assert.match(skill(), /\*Only when block A says the mode is `auto`\.\*/);
    assert.match(skill(), /unverified on this version/);
  });

  // The exception a competent person gets caught by: a tightened persona is additive in effect
  // until the conversation is replaced, because the session read the old one and resumes from it.
  it("says a resumed conversation keeps what it has already read", () => {
    assert.match(skill(), /tightening a persona is additive in effect until a handover replaces the/);
    assert.match(skill(), /What clears it is replacing the conversation/);
  });

  it("says a change to the settings is honoured from each session's next turn", () => {
    assert.match(skill(), /honoured from each session's next turn/);
  });

  // It is a report and not advice. The moment it names rules worth pressing it is a lead
  // improvising grants, which is the one thing the first turn forbids.
  it("names no rule the person could press next", () => {
    assert.match(skill(), /It is a report, not advice/);
  });

  // A workspace's own policy is not the product's. The skill describes mechanism and names no
  // model, no cadence and nobody's habits.
  it("names no model", () => {
    assert.doesNotMatch(skill(), /\b(opus|sonnet|haiku)\b/i);
  });
});

// Installing over an instance is the same act as taking a newer version of it: the payload is
// replaced whole, the person's files are kept whatever is in them, and a file of theirs that a
// fresh install would have given them is seeded if it is missing. Each file is marked with a line
// no template holds, so the check reads content rather than counting files. The one file that is
// read rather than kept is the instance's own description: what the command line says is written
// into it, what it leaves off is taken from it.
describe("installing over an instance", () => {
  const root = `${instance}-over`;
  const MARK = "kept by the person\n";
  const USER_FILES = [
    [".claude", "settings.json"],
    [".claude-home", "settings.json"],
    [".claude-home", "projects", "workspace", "memory", "MEMORY.md"],
    ["work", LEADER, "STATE.md"],
  ];
  let again;
  let before_;

  remove(root);
  installed(options(root));
  for (const parts of USER_FILES) {
    fs.appendFileSync(path.join(root, ...parts), MARK);
  }
  // Something the person added to their description, which no answer names and which has to
  // survive the answers being written in.
  before_ = JSON.parse(fs.readFileSync(path.join(root, "openovai.json"), "utf8"));
  fs.writeFileSync(path.join(root, "openovai.json"), `${JSON.stringify({ ...before_, quietHours: "22-07" }, null, 2)}\n`);
  // What an older toolkit rendered, and what a person may have written into it: read by nothing
  // now, and not the installer's to take away.
  fs.mkdirSync(path.join(root, "personas"), { recursive: true });
  fs.writeFileSync(path.join(root, "personas", `${LEADER}.md`), MARK);
  fs.writeFileSync(path.join(root, "tools", "left-behind.mjs"), "// not in the source\n");
  fs.rmSync(path.join(root, ".claude", "allowed.md"), { force: true });
  again = install(options(root, { "--force": true, "--port": 4242, "--leader-model": "haiku" }));

  it("goes through", () => {
    assert.equal(again.status, 0, again.stderr);
  });

  for (const parts of USER_FILES) {
    it(`keeps ${parts.join("/")} as the person left it`, () => {
      assert.ok(fs.readFileSync(path.join(root, ...parts), "utf8").endsWith(MARK));
    });
  }

  // An answer given over an instance is written into its description — a person typing a port
  // means the port — and everything the answer does not name is left as it was, the person's own
  // additions included.
  it("writes the answers given into the description the instance has, and keeps the rest of it", () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, "openovai.json"), "utf8"));
    assert.deepEqual(
      [config.port, config.models.leader, config.models.worker, config.createdAt, config.quietHours],
      [4242, "haiku", WORKER_MODEL, before_.createdAt, "22-07"],
    );
  });

  it("names the description among what it wrote, since it changed it", () => {
    assert.ok(again.stdout.includes(path.join(root, "openovai.json")));
  });

  // What is not given is not missing: the instance's own description answers for it.
  it("takes an answer left off the command line from the description the instance has", () => {
    const fewer = install({ "--root": root, "--source": repo, "--force": true });
    const config = JSON.parse(fs.readFileSync(path.join(root, "openovai.json"), "utf8"));
    assert.equal(fewer.status, 0, fewer.stderr);
    assert.deepEqual([config.port, config.models.leader, config.human], [4242, "haiku", HUMAN]);
    assert.ok(!fewer.stdout.includes(path.join(root, "openovai.json")));
  });

  it("replaces the payload whole, taking away what the source has not got", () => {
    assert.ok(!fs.existsSync(path.join(root, "tools", "left-behind.mjs")));
  });

  it("leaves what an older toolkit rendered under personas/ exactly as it found it", () => {
    assert.equal(fs.readFileSync(path.join(root, "personas", `${LEADER}.md`), "utf8"), MARK);
  });

  it("names what it seeded and what it replaced, and nothing it kept", () => {
    assert.ok(again.stdout.includes(path.join(root, "tools")));
    assert.ok(!again.stdout.includes(path.join(root, "personas")));
    assert.ok(!again.stdout.includes(path.join(root, ".claude", "settings.json")));
    assert.ok(!again.stdout.includes(path.join(root, ".claude-home", "settings.json")));
  });

  // A file the person has not got is placed as a fresh install places it — the case of an
  // instance made before the toolkit wrote that file at all.
  describe("a file of the person's that is missing", () => {
    let seeded;

    before(() => {
      fs.rmSync(path.join(root, ".claude-home", "settings.json"));
      fs.rmSync(path.join(root, "work", LEADER, "STATE.md"));
      seeded = install(options(root, { "--force": true }));
    });

    it("is seeded as a fresh install would seed it", () => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude-home", "settings.json"), "utf8"));
      assert.equal(settings.autoContinueAtUsageLimit, true);
      assert.ok(fs.readFileSync(path.join(root, "work", LEADER, "STATE.md"), "utf8").includes(LEADER));
    });

    it("is named among what was written", () => {
      assert.ok(seeded.stdout.includes(path.join(root, ".claude-home", "settings.json")));
      assert.ok(seeded.stdout.includes(path.join(root, "work", LEADER, "STATE.md")));
    });

    it("leaves the rest of the person's files as they were", () => {
      assert.ok(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8").endsWith(MARK));
    });
  });
});

describe("what the installer refuses", () => {
  it("refuses a directory that is not empty", () => {
    assert.notEqual(install(options(instance)).status, 0);
  });

  it("installs into a directory that is not empty when told to", () => {
    assert.equal(install(options(instance, { "--force": true })).status, 0);
  });

  it("refuses a command line with an option missing", () => {
    const asked = {
      "--root": instance,
      "--source": repo,
      "--human": HUMAN,
      "--leader": LEADER,
    };
    assert.notEqual(install(asked).status, 0);
  });

  // A source with no version in it is not a version of the toolkit, whatever else is in it. The
  // same function answers for a clone and for an unpacked release, so this is also what stops an
  // update taking a package that is something else entirely.
  // One check and not two. A refusal and the reason for it are separate things wherever a refusal
  // can arrive for more than one reason, and here it cannot: with the version in the payload, a
  // source without one cannot be installed successfully whatever this function does, so a check on
  // the exit status alone would pass on a crash. Both in one expression, so neither half can go
  // missing quietly.
  //
  // And it reads the installer's OWN sentence, not the word VERSION anywhere in the output. An
  // installer that carried on past this would fall over copying the file that is not there, and
  // that crash names the same path on stderr — so a looser check passes on the failure it exists
  // to rule out. Measured: both a removed refusal and one downgraded to a warning went unnoticed
  // until this was anchored on the line the installer writes itself.
  it("refuses a source with no version in it, saying which entry that is", () => {
    const refused = install(options(`${instance}-noversion`, { "--source": withoutVersion() }));
    const said = /^install: .*does not look like an OpenOv AI instance.*VERSION/m.test(refused.stderr);
    assert.equal([refused.status === 0, said].join(" "), "false true");
  });

  it("refuses a port below 1024", () => {
    assert.notEqual(install(options(`${instance}-lowport`, { "--port": 80 })).status, 0);
  });

  it("refuses a port that is not a number", () => {
    assert.notEqual(install(options(`${instance}-badport`, { "--port": "banana" })).status, 0);
  });

  it("refuses a way of signing in that does not exist", () => {
    assert.notEqual(install(options(`${instance}-badauth`, { "--auth": "sometimes" })).status, 0);
  });

  it("refuses a port that is not written in digits", () => {
    assert.notEqual(install(options(`${instance}-hexport`, { "--port": "0x1f90" })).status, 0);
  });

  it("refuses a command line with no way of signing in", () => {
    assert.notEqual(install(options(`${instance}-noauth`, { "--auth": undefined })).status, 0);
  });
});

// The toolkit is written against one Node. An older one reads a different language and stops
// on syntax used freely here, so the installer says so in one line rather than leaving an
// instance to fail at its first message.
describe("the Node the installer needs", () => {
  const refused = install(options(rootFor("v20.18.1")), pretending("v20.18.1"));

  it("refuses a Node older than the one it needs", () => {
    assert.notEqual(refused.status, 0);
  });

  it("says which Node it needs", () => {
    assert.match(refused.stderr, /Node\.js 24 or newer is required/);
  });

  it("says which Node it found", () => {
    assert.match(refused.stderr, /v20\.18\.1/);
  });

  it("installs on the Node it needs", () => {
    assert.equal(install(options(rootFor("v24.0.0")), pretending("v24.0.0")).status, 0);
  });

  it("installs on a Node newer than the one it needs", () => {
    assert.equal(install(options(rootFor("v99.0.0")), pretending("v99.0.0")).status, 0);
  });
});

describe("a port the machine picks", () => {
  it("installs with --port 0", () => {
    assert.equal(install(options(chosen, { "--port": 0 })).status, 0);
  });

  it("records the port as 0 rather than one it chose", () => {
    assert.deepEqual(
      configProblems(path.join(chosen, "openovai.json"), {
        human: HUMAN,
        leader: LEADER,
        leaderModel: LEADER_MODEL,
        workerModel: WORKER_MODEL,
        port: 0,
        auth: AUTH,
      }),
      [],
    );
  });
});

// Claude Code is a prerequisite of running an instance, not of making one.
describe("the instance runs", { skip: claudeIsInstalled() ? false : "Claude Code is not on the PATH" }, () => {
  it("answers ovai status", () => {
    assert.equal(runOvai(instance, ["status"], process.env).status, 0);
  });

  it("names the human in ovai status", () => {
    assert.match(runOvai(instance, ["status"], process.env).stdout, new RegExp(HUMAN));
  });
});

// One version, written in two places for two readers: the file the payload carries, and the
// package declaration for tooling that reads that instead. Nothing makes one follow the other, so
// this is what says they have not drifted.
describe("the version the toolkit is on", () => {
  it("says the same thing in the payload and in the package", () => {
    const declared = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
    assert.equal(fs.readFileSync(path.join(repo, "VERSION"), "utf8").trim(), declared);
  });
});

// A release is cut from the repository, and what it carries for the lead of a workspace taking it
// is a file in that repository. A release cut without one tells the lead an update happened and
// nothing about what it was — which is the whole of what this feature is for.
describe("what a release says for itself", () => {
  it("carries notes for the lead at the root of the repository", () => {
    assert.match(fs.readFileSync(path.join(repo, RELEASE_NOTES), "utf8").trim(), /\S/);
  });

  it("says something about the version being released", () => {
    assert.match(fs.readFileSync(path.join(repo, RELEASE_NOTES), "utf8"), new RegExp(fs.readFileSync(path.join(repo, "VERSION"), "utf8").trim()));
  });

  it("is not in the payload, since it describes a release rather than an instance", () => {
    assert.equal(PAYLOAD.includes(RELEASE_NOTES), false);
  });
});
