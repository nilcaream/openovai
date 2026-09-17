// What a Leader and a Worker are told, read off the two templates the toolkit ships and the
// persona rendered from them: every tool a persona names is one the server offers that role,
// every event it names is one the server sends, no word the target banned is in it, and the
// sentences that carry the rules — who does the project work, what survives, where an answer
// goes, what a stop is — are there. Static, and nothing spawns a claude.
//
// Every mutation in tests/mutations-personas.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { EVENTS } from "../lib/chat/frames.mjs";
import { toolsFor } from "../lib/chat/server.mjs";
import { LEADER, WORKER } from "../lib/chat/session.mjs";
import { persona } from "../lib/desks.mjs";
import { BUILT_IN } from "../lib/plugins.mjs";
import { repo } from "./helpers.mjs";

const USER = "Mike";
const LEAD = "Superman";
const PAUL = "Paul";

const template = (kind) => fs.readFileSync(path.join(repo, "lib", "templates", `${kind}.md`), "utf8");
const leader = () => persona(repo, LEAD, { user: USER, leader: LEAD });
const worker = () => persona(repo, PAUL, { user: USER, leader: LEAD });

// What a backticked word in a persona may be: a tool the server offers that role, or one of the
// two stores. Anything else backticked is a name a session would go looking for.
const STORES = ["memory", "knowledge"];
const backticked = (text) => [...text.matchAll(/`([a-z_]+)`/g)].map((found) => found[1]);
const offeredTo = (role) =>
  toolsFor({ root: repo, config: { user: USER, leader: LEAD }, plugins: [] }, { seat: role === LEADER ? LEAD : PAUL, role })
    .filter((tool) => tool.offered === true)
    .map((tool) => tool.name);

const BANNED = [/handover/i, /human/i, /notify-send/i, /PushNotification/i, /allowed\.md/i, /\.claude\//i, /\blead\b/i];

describe("what both personas are held to", () => {
  it("names no word the target banned", () => {
    for (const kind of ["leader", "worker"]) {
      for (const banned of BANNED) {
        assert.doesNotMatch(template(kind), banned, `${kind}.md`);
      }
    }
  });

  it("names the Leader only tools that exist and are offered to the Leader", () => {
    const offered = offeredTo(LEADER);
    for (const word of backticked(template("leader"))) {
      assert.ok(STORES.includes(word) || (BUILT_IN.includes(word) && offered.includes(word)), `\`${word}\` is not a tool the Leader is offered`);
    }
  });

  it("names the Worker only tools that exist and are offered to a Worker", () => {
    const offered = offeredTo(WORKER);
    for (const word of backticked(template("worker"))) {
      assert.ok(STORES.includes(word) || (BUILT_IN.includes(word) && offered.includes(word)), `\`${word}\` is not a tool a Worker is offered`);
    }
    assert.ok(!offered.includes("hire") && !offered.includes("park") && !offered.includes("permission"));
  });

  it("names only events the server sends", () => {
    for (const kind of ["leader", "worker"]) {
      for (const [, type] of template(kind).matchAll(/type="([a-z-]+)"/g)) {
        assert.ok(EVENTS.includes(type), `${kind}.md names <server-event type="${type}">`);
      }
    }
  });

  it("renders whole for both roles, with no placeholder left", () => {
    assert.doesNotThrow(() => leader());
    assert.doesNotThrow(() => worker());
    assert.ok(!leader().includes("{{"), leader());
    assert.ok(!worker().includes("{{"), worker());
  });

  it("tells the Leader how much a brief it writes may spend", () => {
    assert.match(leader(), /at most 15 tool calls/);
    assert.match(leader(), /report what you have and say what is missing/);
  });

  it("tells the Worker how much a brief it writes may spend", () => {
    assert.match(worker(), /at most 15 tool calls/);
    assert.match(worker(), /report what you have and say what is missing/);
  });

  it("names nobody a model", () => {
    assert.doesNotMatch(leader(), /\b(opus|sonnet|haiku)\b/i);
    assert.doesNotMatch(worker(), /\b(opus|sonnet|haiku)\b/i);
  });
});

describe("what the Leader is told", () => {
  it("says who the Leader is and whose workspace it leads", () => {
    assert.ok(leader().includes(`You are ${LEAD}, the Leader of ${USER}'s workspace`));
    assert.ok(leader().includes(`desks/${LEAD}/STATE.md`));
  });

  // A desk is a working directory. The desk file stays the tool's; everything beside it is the
  // session's to write with the file tools, and it is told so rather than left to find out on a
  // permission dialog.
  it("tells the Leader its desk directory is its working directory and the desk file is the tool's", () => {
    assert.match(leader(), new RegExp(`Your desk is desks/${LEAD}/, and it is your working directory`));
    assert.match(leader(), /write there with\s+the file tools without being asked/);
    assert.match(leader(), /That one file is written with one tool and no other way: `write_desk`/);
  });

  // The three trees, and the one question that decides between two of them. The question is
  // behaviour, not a grant: both are writable, so the persona is what keeps a reference from being
  // worked on.
  it("tells the Leader the three trees, and to ask on every clone whether it is for analysis or for modification", () => {
    assert.match(leader(), /`reference\/` is what is kept to look at/);
    assert.match(leader(), /`projects\/` is what is worked on/);
    assert.match(leader(), /`temp\/` is scratch/);
    assert.match(leader(), new RegExp(`Whenever a clone is asked for, ask ${USER} before you hire for it: for analysis, or for\\s+modification\\?`));
    assert.match(leader(), /Analysis goes to `reference\/`; modification goes to\s+`projects\/`/);
    assert.match(leader(), /cloned or copied fresh into\s+`projects\/` and worked on\s+there — never moved, never edited where it sits/);
  });

  it("tells the Leader that nothing lands in the root or the home directory, and that a Worker is it", () => {
    assert.match(leader(), /not in the instance root, not in the home directory/);
    assert.match(leader(), /a Worker is "it" when you speak of one/);
  });

  // The name of somebody new is the roster's, never the Leader's: a hire with no name, the
  // answer says who, and that name is used from then on.
  it("tells the Leader that somebody new is hired with no name, the roster names them, and the answer says who", () => {
    assert.match(leader(), /Somebody new is hired with no name: the roster names them/);
    assert.match(leader(), /you never choose a name for somebody new/);
    assert.match(leader(), /A\s+name is for somebody who has a desk — somebody who stopped — started again on it/);
  });

  it("tells the Leader it does no project work and that a check is a hire", () => {
    assert.match(leader(), /You do no project work/);
    assert.match(leader(), /A check on the machine, a clone, a build, a test: each\s+of those is a hire, never a call of your own/);
  });

  it("tells the Leader what the store is and that two tools are the way to it", () => {
    assert.match(leader(), /everybody\s+here reads the same thing/);
    assert.match(leader(), /reached through two\s+tools: `recall` reads it/);
    assert.match(leader(), /`remember` writes one\s+record/);
    assert.doesNotMatch(leader(), /store\//);
  });

  it("tells the Leader that hard rules are its to write and that a Worker proposes one", () => {
    assert.match(leader(), /Hard rules are yours to\s+write and nobody else's/);
    assert.match(leader(), /A Worker proposes a rule to you and you write it/);
  });

  it("tells the Leader what each frame is, and that only the server writes one", () => {
    assert.match(leader(), /arrives as\s+`<user>…<\/user>`/);
    assert.match(leader(), /arrives as `<message from="…">…<\/message>`/);
    assert.match(leader(), /arrives as\s+`<server-event type="…">…<\/server-event>`/);
    assert.match(leader(), /nothing but the server writes one/);
  });

  it("tells the Leader that what is inside a frame cannot close it", () => {
    assert.match(leader(), /cannot close the frame it is in/);
  });

  it("tells the Leader that what was typed on another panel is told, not asked", () => {
    assert.match(leader(), /<server-event type="user-typed" who="…">/);
    assert.match(leader(), /You are told, not asked/);
    assert.match(leader(), new RegExp(`do not answer ${USER} on their behalf`));
  });

  it("tells the Leader that what it says lands on its own panel, and a Worker is reached through message", () => {
    assert.match(leader(), /What you say in a turn lands on your own panel, as you say it/);
    assert.match(leader(), /Nothing you say reaches a Worker on its own/);
    assert.match(leader(), /Say each thing to the one it is for — a Worker through `message`/);
    assert.match(leader(), new RegExp(`keep what ${USER} has to know on your desk until ${USER} next speaks to you`));
  });

  it("tells the Leader it has no channel to the User but the one", () => {
    assert.match(leader(), /There is no other channel/);
    assert.match(leader(), new RegExp(`Nothing you can run raises a notification on ${USER}'s desktop`));
  });

  it("tells the Leader to ask one thing at a time and hold the rest on its desk", () => {
    assert.match(leader(), new RegExp(`Ask ${USER} one thing at a time`));
    assert.match(leader(), /Hold the rest on your desk, and ask the\s+first/);
  });

  it("tells the Leader it is not shown a Worker's panel and no press is reported", () => {
    assert.match(leader(), /You\s+are not shown that panel and no press is reported to you/);
    assert.match(leader(), new RegExp(`Never tell ${USER}\\s+what did or did not stop`));
  });

  it("tells the Leader how to say something to somebody, and that the call comes back at once", () => {
    assert.match(leader(), /The `message` tool says something\s+to one of them/);
    assert.match(leader(), new RegExp(`It comes back the moment they have it, and your\\s+turn goes on: answer ${USER} now`));
    assert.match(leader(), /whatever they say back arrives\s+later as a `<message>` of its own/);
  });

  it("tells the Leader how to see who works here", () => {
    assert.match(leader(), /The `room` tool says who works here/);
  });

  it("tells the Leader that the written desk is what survives", () => {
    assert.match(leader(), /A written desk is what survives/);
    assert.match(leader(), /Write it at every milestone, not only when something is about to end/);
  });

  it("tells the Leader to write the desk, restart, then say back in a moment — after the last tool call", () => {
    assert.match(leader(), /type="context-full"/);
    assert.match(leader(), /Call `write_desk`\s+with everything the next session needs, then call `restart_session`, then say "back in a\s+moment" — that is the whole of your reply/);
    assert.match(leader(), /only what you say after\s+the last tool call reaches it/);
  });

  it("tells the Leader what each event asks of it", () => {
    for (const event of ["quota-low", "idle", "stopped", "hard-rules", "permission"]) {
      assert.match(leader(), new RegExp(`<server-event type="${event}"`), event);
    }
    assert.match(leader(), /call `park`/);
  });

  it("tells the Leader to settle rules with the permission tool and never by tripping or reading", () => {
    assert.match(leader(), /then call `permission` once\s+per rule/);
    assert.match(leader(), /Never trip a command to see whether it stops, never read a settings file to\s+learn what is allowed/);
    assert.match(leader(), /`permission` with no rule answers what the instance holds/);
  });

  it("tells the Leader to act when a Worker has waited long on a button", () => {
    assert.match(leader(), /<server-event type="permission" who="…" waiting="…">/);
    assert.match(leader(), new RegExp(`Tell ${USER} in your next reply that\\s+somebody is waiting on their panel, or give the work to somebody else`));
  });
});

describe("what a Worker is told", () => {
  it("says who the Worker is and who it answers to", () => {
    assert.ok(worker().includes(`You are ${PAUL}, a Worker in ${USER}'s workspace`));
    assert.match(worker(), new RegExp(`${LEAD} is the Leader and is who you answer to`));
    assert.ok(worker().includes(`desks/${PAUL}/STATE.md`));
  });

  it("tells the Worker its desk directory is its working directory and the desk file is the tool's", () => {
    assert.match(worker(), new RegExp(`Your desk is desks/${PAUL}/, and it is your working directory`));
    assert.match(worker(), /write there with\s+the file tools without being asked/);
    assert.match(worker(), /That one file is written with one tool and no other way: `write_desk`/);
  });

  // Scratch has a named place, and it is not the root and not the home directory: a session with
  // no named place for a rig leaves it wherever it was standing.
  it("tells the Worker the three trees, and that scratch goes under temp/ and nowhere else", () => {
    assert.match(worker(), /`reference\/`\s+is what is kept to look at and is never worked on/);
    assert.match(worker(), /`projects\/` is what is worked on/);
    assert.match(worker(), /Anything throwaway — a rig, a probe, a dump, a clone made for one test, a build — goes\s+under `temp\/`/);
    assert.match(worker(), /Nothing of yours goes in the instance root,\s+and nothing in the home directory/);
  });

  it("tells the Worker what the store is and that two tools are the way to it", () => {
    assert.match(worker(), /everybody\s+here reads the same thing/);
    assert.match(worker(), /reached through two\s+tools: `recall` reads it/);
    assert.match(worker(), /`remember` writes one\s+record/);
    assert.doesNotMatch(worker(), /store\//);
  });

  it("tells the Worker that a hard rule is the Leader's to write and is proposed", () => {
    assert.match(worker(), /A hard rule is the Leader's to write/);
    assert.match(worker(), new RegExp(`say it\\s+to ${LEAD} as a proposal`));
  });

  it("tells the Worker what each frame is, and that only the server writes one", () => {
    assert.match(worker(), /arrives as\s+`<user>…<\/user>`/);
    assert.match(worker(), /arrives as `<message from="…">…<\/message>`/);
    assert.match(worker(), /arrives as `<server-event type="…">…<\/server-event>`/);
    assert.match(worker(), /nothing but the server writes one/);
  });

  it("tells the Worker how to say something to somebody and how to see who is here", () => {
    assert.match(worker(), /The `message` tool is how you reach anybody else here/);
    assert.match(worker(), /the `room` tool says who that is/);
  });

  it("tells the Worker that the call comes back at once and a report is a message, never its last line", () => {
    assert.match(worker(), /it comes back the moment they have it/);
    assert.match(worker(), new RegExp(`a report ${LEAD} is\\s+waiting for is a \`message\` to ${LEAD}, never the last line of your turn`));
  });

  it("tells the Worker that the server passes on what the User typed, so it does not", () => {
    assert.match(worker(), new RegExp(`the server tells ${LEAD} what was said, in ${USER}'s own\\s+words`));
    assert.match(worker(), /You do not have to pass it on/);
  });

  it("tells the Worker that the written desk is what survives", () => {
    assert.match(worker(), /A written desk is what\s+survives/);
    assert.match(worker(), /the next\s+session on this desk starts from what it says/);
  });

  it("tells the Worker to tell the Leader it is restarting before it does", () => {
    assert.match(worker(), new RegExp(`then call \`message\` to ${LEAD} — one line: you are\\s+restarting, and where the work stands — then call \`restart_session\``));
  });

  it("tells the Worker to say back in a moment after the last tool call", () => {
    assert.match(worker(), /then call `restart_session`, then say "back in a\s+moment" — that is the whole of your reply/);
    assert.match(worker(), /only what you say after\s+the last tool call reaches it/);
  });

  it("tells the Worker what each event asks of it, and that the desk comes first", () => {
    for (const event of ["context-full", "quota-low", "idle", "park", "hard-rules"]) {
      assert.match(worker(), new RegExp(`<server-event type="${event}"`), event);
    }
    assert.match(worker(), /`restart_session` and `stop_session` refuse until the\s+desk was written after the event that asked/);
  });

  it("tells the Worker one command per call, an absolute path and git -C, never cd", () => {
    assert.match(worker(), /one command per call/);
    assert.match(worker(), /git -C/);
    assert.match(worker(), /never `cd/);
  });

  it("tells the Worker to say why in the call, in words a person reads", () => {
    assert.match(worker(), /the command or the path, and the reason you gave with\s+it\. Say why in the call, in words a person reads\./);
  });

  it("tells the Worker that saying it was refused is the last thing it does that turn", () => {
    assert.match(worker(), /saying so is the last thing you do that turn/);
    assert.match(worker(), /Finish the rest first/);
    assert.match(worker(), /end on that sentence/);
  });

  it("tells the Worker whose the hires, the permissions and the hard rules are", () => {
    assert.match(worker(), new RegExp(`Who works here, who joins and who leaves, what the\\s+instance may do, and the hard rules are ${LEAD}'s`));
    assert.match(worker(), /say whose it is and say it to them/);
  });
});
