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
import { after, before, describe, it } from "node:test";

import { EVENTS } from "../lib/chat/frames.mjs";
import { toolsFor } from "../lib/chat/server.mjs";
import { GUIDE, INTRODUCTION_TEMPLATE, LEADER, WORKER, introduction } from "../lib/desks.mjs";
import { persona } from "../lib/desks.mjs";
import { BUILT_IN } from "../lib/plugins.mjs";
import { remove, repo, scratch } from "./helpers.mjs";

const USER = "Mike";
const LEAD = "Martin";
const PAUL = "Paul";

const template = (kind) => fs.readFileSync(path.join(repo, "lib", "templates", `${kind}.md`), "utf8");
const leader = () => persona(repo, LEAD, { user: USER, leader: LEAD });
const worker = () => persona(repo, PAUL, { user: USER, leader: LEAD });
// The text with every run of white space one space: a pin on the words, not on where a line wraps.
const flat = (text) => text.replace(/\s+/g, " ");
// The common frame of an assembled persona, and what comes after it.
const commonOf = (text) => text.slice(0, text.indexOf("</ovai>"));
const roleOf = (text) => text.slice(text.indexOf("</ovai>"));

// What a backticked word in a persona may be: a tool the server offers that role, the type of an
// event the server sends, or a field of a note's head, which the session writes and never calls.
// Anything else backticked is a name a session would go looking for.
const NOTE_HEAD = ["summary", "tags", "sources", "updated"];
const backticked = (text) =>
  [...text.matchAll(/`([a-z_]+)`/g)]
    .map((found) => found[1])
    .filter((word) => !EVENTS.includes(word) && !NOTE_HEAD.includes(word));
const offeredTo = (role) =>
  toolsFor({ root: repo, config: { user: USER, leader: LEAD }, plugins: [] }, { seat: role === LEADER ? LEAD : PAUL, role })
    .filter((tool) => tool.offered === true)
    .map((tool) => tool.name);

const BANNED = [/handover/i, /human/i, /notify-send/i, /PushNotification/i, /allowed\.md/i, /\.claude\//i, /\blead\b/i];

describe("what both personas are held to", () => {
  it("names no word the target banned", () => {
    for (const kind of ["common", "leader", "worker"]) {
      for (const banned of BANNED) {
        assert.doesNotMatch(template(kind), banned, `${kind}.md`);
      }
    }
  });

  it("names the Leader only tools that exist and are offered to the Leader", () => {
    const offered = offeredTo(LEADER);
    for (const word of backticked(template("leader"))) {
      assert.ok(BUILT_IN.includes(word) && offered.includes(word), `\`${word}\` is not a tool the Leader is offered`);
    }
  });

  it("names the Worker only tools that exist and are offered to a Worker", () => {
    const offered = offeredTo(WORKER);
    for (const word of backticked(template("worker"))) {
      assert.ok(BUILT_IN.includes(word) && offered.includes(word), `\`${word}\` is not a tool a Worker is offered`);
    }
    assert.ok(!offered.includes("hire") && !offered.includes("park") && !offered.includes("permission"));
  });

  // Both roles read common.md, so a tool it names has to be one each of them is offered — a
  // tool named with its call, `index()`, as well.
  it("names in the common frame only tools that exist and are offered to both roles", () => {
    const text = template("common");
    const words = [...backticked(text), ...[...text.matchAll(/`([a-z_]+)\(/g)].map((found) => found[1])];
    assert.deepEqual([...new Set(words)].sort(), ["index", "message", "room", "validate", "write_desk"]);
    for (const role of [LEADER, WORKER]) {
      const offered = offeredTo(role);
      for (const word of words) {
        assert.ok(BUILT_IN.includes(word) && offered.includes(word), `\`${word}\` is not a tool the ${role} is offered`);
      }
    }
  });

  it("names only events the server sends", () => {
    for (const kind of ["common", "leader", "worker"]) {
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
    assert.match(leader(), /Report after N tool calls/);
    assert.match(leader(), /done or not: where it stands and what is left/);
  });

  it("tells the Worker how much a brief it writes may spend", () => {
    assert.match(worker(), /Report after N tool calls/);
    assert.match(worker(), /done or not: where it stands and what is left/);
  });

  it("names nobody a model", () => {
    assert.doesNotMatch(leader(), /\b(opus|sonnet|haiku)\b/i);
    assert.doesNotMatch(worker(), /\b(opus|sonnet|haiku)\b/i);
  });

  // The one placement rule, in one sentence, the same for both: everything is one queue, its
  // children in arrival order, also one alone — and the shape
  // shown once, in the common frame, as the reader will see it: a bare `<queue>`, children
  // indented and stamped `at="HH:MM"`.
  it("tells both that everything they receive is one queue in arrival order, and nothing else places a frame", () => {
    const rule = /Everything you receive is one `<queue>` element whose children are those frames as they arrived, each with `at="HH:MM"` and ordered by it — always, also when there is exactly one, and no other placement rule exists:\n\n```/;
    const shape = ["<queue>", '  <message from="…" at="17:41">…</message>', '  <server-event type="restarted" at="17:42">…</server-event>', '  <user at="17:44">…</user>', "</queue>"].join("\n");
    for (const text of [leader(), worker()]) {
      assert.match(commonOf(text).replace(/(\S)\n(\S)/g, "$1 $2"), rule);
      assert.ok(commonOf(text).includes(shape));
      assert.equal(text.split("\n<queue>\n").length, 2);
    }
    for (const text of [leader(), worker()]) {
      assert.doesNotMatch(text, /in front of a turn|on top of|come first|events first|<queue n=/);
    }
  });
});

describe("what the Leader is told", () => {
  // A model may carry an effort, and the Leader is the one who hires onto one: the persona and the
  // tool both say what a model with an effort is written as.
  it("says a hire's model may name an effort, model/effort, in the persona and in the tool", () => {
    assert.match(leader(), /A\s+model beside that when not the usual one, written as model or model\/effort\./);
    const hire = toolsFor({ root: repo, config: { user: USER, leader: LEAD }, plugins: [] }, { seat: LEAD, role: LEADER }).find((tool) => tool.name === "hire");
    assert.match(hire.description, /as "model" or "model\/effort" \("opus", "claude-opus-5\/low"\)/);
    assert.match(hire.inputSchema.properties.model.description, /"model" or "model\/effort"/);
  });

  it("says who the Leader is and whose workspace it leads", () => {
    assert.ok(leader().includes(`You are ${LEAD}, the Leader of ${USER}'s workspace`));
    assert.ok(leader().includes(`desks/${LEAD}/STATE.md`));
  });

  // A desk is a directory of the session's own. The desk file stays the tool's; everything beside it is the
  // session's to write with the file tools, and it is told so rather than left to find out on a
  // permission dialog.
  it("tells the Leader what it keeps lives in its desk directory, the header the tool's and the body edited in place", () => {
    assert.ok(leader().includes(`Your desk is ${path.join(repo, "desks", LEAD)}/: what you keep lives there`));
    assert.match(leader(), /write there with\s+the file tools without being asked/);
    assert.match(leader(), /Its first line is the server's header, and\s+`write_desk` is what writes it/);
    assert.match(leader(), /edited in place with the file tools like any other file:\s+change the line that changed, never the whole desk\. Edit the body first and call `write_desk`/);
    assert.match(roleOf(leader()), new RegExp(`What you keep on your desk: notes, what you are waiting on, drafts for ${USER}`));
    assert.doesNotMatch(leader(), /no other way/);
  });

  // The three trees, and the one question that decides between two of them. The question is
  // behaviour, not a grant: both are writable, so the persona is what keeps a reference from being
  // worked on.
  it("tells the Leader the three trees, and to ask on every clone whether it is for analysis or for modification", () => {
    assert.match(leader(), /`reference\/`\s+is what is kept to look at/);
    assert.match(leader(), /`projects\/` is what is worked on/);
    assert.match(leader(), /`temp\/` is scratch/);
    assert.match(leader(), new RegExp(`Whenever a clone is asked for, ask ${USER} before you hire for it: for analysis, or for\\s+modification\\?`));
    assert.match(leader(), /Analysis goes to `reference\/`; modification goes to\s+`projects\/`/);
    assert.match(leader(), /cloned or copied fresh into\s+`projects\/` and worked on\s+there — never moved, never edited where\s+it sits/);
  });

  it("tells the Leader that nothing lands in the root or the home directory, and that a Worker is it", () => {
    assert.match(leader(), /Nothing goes in the\s+instance root, in the home directory or in `\/tmp`/);
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
    assert.match(leader(), /A check on the machine, a clone, a build, a test: each of those is a hire,\s+never a call of your own/);
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

  it("tells the Leader that a line of the User's its turn put no words on the panel for is answered now", () => {
    assert.ok(
      flat(leader()).includes(`\`<server-event type="unanswered">\` — the turn before this one held a line from ${USER}, at the time the event names, and put no words on your panel: nothing, only \`<noop/>\`, or only calls. Answer that line now, in words, in this reply. It comes once for that turn and never again for it.`),
    );
  });

  it("tells the Leader that a word between two Workers is heard, not asked", () => {
    assert.match(leader(), /<server-event type="overheard" from="…" to="…">/);
    assert.match(leader(), new RegExp(`It is heard, not asked: nobody is waiting on you, so unless ${USER}\\s+needs it, it is a \`<noop/>\` turn\\.`));
  });

  it("tells the Leader that what it says lands on its own panel, and a Worker is reached through message", () => {
    assert.match(leader(), /What you say in a turn lands on your own panel and nowhere else\. Nothing you say there reaches\s+another session: whatever is for one goes through `message`\./);
    assert.match(leader(), new RegExp(`a line you address to a Worker at the end of\\s+its message's turn lands there, in front of ${USER}, and the Worker never sees it`));
    assert.match(leader(), new RegExp(`Keep what\\s+${USER} has to know on your desk until ${USER} next speaks to you`));
  });

  it("points the Leader to the <noop/> turn for a turn with nothing in it for the User", () => {
    assert.match(leader(), new RegExp(`A turn with nothing in it for\\s+${USER} is a \`<noop/>\` turn\\.`));
    assert.match(leader(), /With nothing left in flight, do nothing:\s+it is a `<noop\/>` turn\./);
    assert.match(leader(), new RegExp(`Nothing to acknowledge: unless ${USER}\\s+needs it, it is a \`<noop/>\` turn\\.`));
  });

  // The Leader's panel fills with Workers' messages: a list pointed back to is a list the User
  // cannot find, and a quote in inline code runs off the side instead of wrapping.
  it("tells the Leader to give the whole open list each time, and what code formatting is for", () => {
    assert.match(leader(), new RegExp(`When ${USER} asks where things stand, or when you ask ${USER} what to take next, give the whole open list as it is now, every item in order\\.`));
    assert.match(leader(), /Never point back to a list you wrote earlier/);
    assert.match(leader(), /Whatever you ask them to choose from has to be in the message that asks\./);
    assert.match(leader(), new RegExp(`The last thing you say before ${USER} next speaks is the one they read first: it stands alone — where things are now and the one question open — and nothing above it needs reading to act on it\\.`));
    assert.match(leader(), /Code formatting is for code\./);
    assert.match(leader(), /goes in a blockquote, which wraps like prose/);
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
    assert.match(leader(), /When a Worker's run stops on a card, you are not shown that panel and no press is reported to you/);
    assert.match(leader(), new RegExp(`Never tell ${USER}\\s+what did or did not stop`));
  });

  it("tells the Leader how to say something to somebody, and that the call comes back at once", () => {
    assert.match(leader(), /The `message` tool is how you reach anybody else here/);
    assert.match(leader(), /it comes back the moment they have it/);
    assert.match(leader(), new RegExp(`A message you send leaves your turn going on: answer ${USER} now — who you asked, for what\\.`));
    assert.match(leader(), /whatever they say back arrives\s+later as a `<message>` of its own/);
    assert.match(leader(), /A\s+Worker that is not running is hired first, then messaged\./);
  });

  it("tells the Leader how to see who works here", () => {
    assert.match(leader(), /the `room` tool says who that is/);
    assert.match(leader(), /how long it has been idle/);
  });

  it("tells the Leader that the written desk is what survives", () => {
    assert.match(leader(), /A written desk is what survives/);
    assert.match(leader(), /at every point the work moves, not only when something is about to end/);
    assert.doesNotMatch(leader(), /milestone/);
  });

  it("tells the Leader to write the desk, restart, then say back in a moment", () => {
    assert.match(leader(), /type="context" stage="error"/);
    assert.match(leader(), /Call `write_desk`\s+with everything the next session needs, then call `restart_session`, then say "Back in a\s+moment" — that is the whole of your reply, and it goes to your panel\./);
  });

  // Every text block of a turn is a row on the panel (lib/chat/session.mjs), before a tool call as
  // much as after the last one. A Leader told otherwise wrote each reply twice.
  it("never tells a session that only the words after its last tool call reach the panel", () => {
    for (const text of [leader(), worker()]) assert.doesNotMatch(flat(text), /last tool call/);
  });

  it("tells the Leader what each event asks of it", () => {
    for (const event of ["overheard", "quota-low", "idle", "stopped", "permission", "admin-closed"]) {
      assert.match(leader(), new RegExp(`<server-event type="${event}"`), event);
    }
    assert.match(leader(), /call `park`/);
  });

  // The Worker has no ending of its own: the Leader holds it, and hears of a Worker's context,
  // its word that it is done, and every close.
  it("tells the Leader that a Worker's session is its to end, with the events that bear on it", () => {
    assert.match(leader(), /A Worker's session is yours to end, never its own: `stop_worker` stops one and `restart_worker`\s+restarts one on its desk/);
    assert.match(leader(), /so its work is never cut in the middle unless you say interrupt/);
    for (const event of ["context\" who=", "done", "died"]) {
      assert.match(leader(), new RegExp(`<server-event type="${event}`), event);
    }
    assert.match(leader(), /At the error\s+size it is past the size a session wraps up at: restart it with `restart_worker`/);
  });

  it("tells the Leader to settle rules with the permission tool and never by tripping or reading", () => {
    assert.match(leader(), /when their request needs it, call `permission` once\s+per rule/);
    assert.match(leader(), /Then\s+answer them in plain language, as the turn's last text/);
    assert.match(leader(), /Never trip a command to see whether it stops, never read a settings file to\s+learn what is allowed/);
    assert.match(leader(), /`permission` with no rule answers what the instance holds/);
  });

  it("tells the Leader to act when a Worker's card timed out", () => {
    assert.match(leader(), /<server-event type="permission" who="…" minutes="…">/);
    assert.match(leader(), new RegExp(`Tell ${USER} in your next reply that the card timed out and what it asked`));
  });
});

describe("what a Worker is told", () => {
  it("says who the Worker is and who it answers to", () => {
    assert.ok(worker().includes(`You are ${PAUL}, a Worker in ${USER}'s workspace`));
    assert.match(worker(), new RegExp(`${LEAD} is the Leader and is who you answer to`));
    assert.ok(worker().includes(`desks/${PAUL}/STATE.md`));
  });

  // A desk named by `desks/<Name>/` alone leaves the session to work out what it is under, and a
  // session of an instance that sits inside another has guessed the outer one's root: the same
  // names, somebody else's desks. So both kinds are told the whole path, the root joined.
  it("gives each seat its desk and desk file as the whole path, the instance root joined", () => {
    for (const [text, name] of [[flat(leader()), LEAD], [flat(worker()), PAUL]]) {
      const desk = path.join(repo, "desks", name);
      assert.ok(path.isAbsolute(desk));
      assert.ok(text.includes(`Your desk is ${desk}/`), `${name} is told the desk directory as a whole path`);
      assert.ok(text.includes(`The desk file is ${desk}/STATE.md`), `${name} is told the desk file as a whole path`);
      assert.doesNotMatch(text, /(?:Your desk is|The desk file is) desks\//, `${name} is never told a desk relative to a root it has to guess`);
    }
  });

  // Told only its desk, a session has taken the instance around it for its root and looked for
  // `projects/` there. So both kinds are told the root by its whole path, and that every path the
  // instructions name is under it.
  it("gives each seat the instance root as its whole path, as the directory every named path is under", () => {
    for (const [text, name] of [[flat(leader()), LEAD], [flat(worker()), PAUL]]) {
      assert.ok(
        text.includes(`The instance root is ${repo}/, and it is your working directory: every path in these instructions — \`desks/\`, \`projects/\`, \`temp/\`, \`knowledge/\` — is under it.`),
        `${name} is not told the instance root`,
      );
    }
  });

  it("tells the Worker what it keeps lives in its desk directory, the header the tool's and the body edited in place", () => {
    assert.ok(worker().includes(`Your desk is ${path.join(repo, "desks", PAUL)}/: what you keep lives there`));
    assert.match(worker(), /write there with\s+the file tools without being asked/);
    assert.match(worker(), /Its first line is the server's header, and\s+`write_desk` is what writes it/);
    assert.match(worker(), /change the line that changed, never the whole desk\. Edit the body first and call `write_desk`\s+after it/);
    assert.match(roleOf(worker()), /Its sections:\s+what the task is, what is true right now, what to do next, what is already settled\./);
    assert.doesNotMatch(worker(), /no other way/);
  });

  // Scratch has a named place, and it is not the root and not the home directory: a session with
  // no named place for a rig leaves it wherever it was standing.
  it("tells the Worker the three trees, and that scratch goes under temp/ and nowhere else", () => {
    assert.match(worker(), /`reference\/`\s+is what is kept to look at/);
    assert.match(worker(), /`projects\/` is what is worked on/);
    assert.match(worker(), /anything throwaway — a rig, a probe, a dump, a clone made for one\s+test, a build — goes there/);
    assert.match(worker(), /Nothing goes in the\s+instance root, in the home directory or in `\/tmp`/);
    assert.match(flat(worker()), new RegExp(`\`/tmp\` is outside this instance, so a read or write there with the file tools stops on a card for ${USER}`));
  });

  // The scratchpad Claude Code gives a session under /tmp raises no card, and nobody else reads it:
  // the exception is said, with what stays out of it.
  it("tells the Worker the Claude Code scratchpad under /tmp is for what nobody else reads", () => {
    assert.match(flat(worker()), new RegExp(`The scratchpad Claude Code gives a session under \`/tmp\` is the one exception, for what nobody but you reads again: anything another session, a later session or ${USER} needs goes in \`temp/\`\\.`));
  });

  it("tells the Worker what each frame is, and that only the server writes one", () => {
    assert.match(worker(), /arrives as\s+`<user>…<\/user>`/);
    assert.match(worker(), /arrives as `<message from="…">…<\/message>`/);
    assert.match(worker(), /arrives as\s+`<server-event type="…">…<\/server-event>`/);
    assert.match(worker(), /nothing but the server writes one/);
    assert.match(roleOf(worker()), /One marked\s+`urgent="true"` does not wait for your turn to end/);
    assert.doesNotMatch(leader(), /urgent="true"/);
  });

  it("tells the Worker how to say something to somebody and how to see who is here", () => {
    assert.match(worker(), /The `message` tool is how you reach anybody else here/);
    assert.match(worker(), /the `room` tool says who that is/);
  });

  it("tells the Worker that the call comes back at once and a report is a message, never its last line", () => {
    assert.match(worker(), /it comes back the moment they have it/);
    assert.match(worker(), new RegExp(`A report ${LEAD} is waiting for is a \`message\` to ${LEAD}, never the last line of your turn`));
  });

  it("tells the Worker that a report once sent ends the turn as a <noop/> turn, never the report again", () => {
    assert.match(worker(), /Once it is sent, the\s+turn ends there, a `<noop\/>` turn: never the report again\./);
    assert.match(worker(), /With nothing left in flight, do nothing:\s+it is a `<noop\/>` turn\./);
    assert.match(worker(), /and end the turn there, a `<noop\/>`\s+turn\./);
    assert.match(worker(), new RegExp(`what you\\s+say on your own\\s+panel is for what\\s+${USER} typed there`));
  });

  it("tells the Worker that the server passes on what the User typed, so it does not", () => {
    assert.match(worker(), new RegExp(`the server tells ${LEAD} what was said, in ${USER}'s own\\s+words`));
    assert.match(worker(), /You do not have to pass it on/);
  });

  it("tells the Worker that the written desk is what survives", () => {
    assert.match(worker(), /A written desk is what\s+survives/);
    assert.match(worker(), /the next\s+session on this desk starts from what it says/);
  });

  // A Worker's session is closed for it: the one thing asked of it is the desk, written last in the
  // turn that reads the close, and the session ends when that turn is over.
  it("tells the Worker a close asks only for its desk, written last in the turn, and cuts nothing", () => {
    assert.match(worker(), /Write your desk now — what the task is, what is true now, what to do next —\s+with `write_desk` as the last thing you do in this turn, and end the turn there/);
    assert.match(worker(), /The session\s+ends when the turn is over, with the desk as you wrote it, and nothing is\s+cut while the turn runs/);
    assert.match(worker(), /Ending your session is never yours to do/);
  });

  it("tells the Worker to say it is done after its report, and that done ends nothing", () => {
    assert.match(worker(), /send your report as a `message`, then call `done`,\s+with a one-line note if you like: it tells \S+ you are ready to close, and ends nothing/);
  });

  it("tells the Worker what each event it is sent asks of it, and names none it is not sent", () => {
    for (const event of ["closing", "restarted", "quota-low", "checkpoint", "undelivered"]) {
      assert.match(worker(), new RegExp(`<server-event type="${event}"`), event);
    }
    for (const event of ["context", "idle", "park"]) {
      assert.doesNotMatch(worker(), new RegExp(`<server-event type="${event}"`), event);
    }
    assert.match(worker(), /all a close\s+needs from you is the desk/);
  });

  // The install allows a seat plain git, mkdir and cd; a permission rule matches a command from its
  // first character, so `cd x && git status` and `git -C x status` ask every time while
  // `git status` from inside the repo does not.
  it("tells the Worker one command per call, to work from inside the repository, and never cd-and or git -C", () => {
    assert.match(worker(), /one command per call/);
    assert.match(worker(), /Work from inside the\s+repository: `cd projects\/<repo>` once, alone, then plain git, mkdir and the file tools/);
    assert.match(worker(), /never chain a\s+`cd …` with another command and never `git -C`/);
    assert.match(worker(), /a permission rule matches a command from\s+its first character, and those spellings ask every time/);
  });

  it("tells both that the harness's own directories ask whatever the rules say, and not to go round them", () => {
    for (const text of [leader(), worker()]) {
      assert.match(flat(commonOf(text)), /Claude Code keeps a few directories for itself — \.claude, \.git, \.idea, \.vscode and the like, wherever they are, under projects\/ too — and a write there asks \S+ whatever the rules say; do not look for a way round it \(a script, a copy, a rename\): ask, or leave it\./);
      assert.equal(text.split("Claude Code keeps a").length, 2);
    }
  });

  // A Deny's reason comes back where a call's output would, so without this a session reads a
  // User's "this is a test" as output the call made up.
  it("tells both that a Deny is the User's answer, not an injection", () => {
    for (const text of [leader(), worker()]) {
      assert.match(flat(commonOf(text)), new RegExp(`A Deny comes back as the call's error, saying ${USER} denied it and why: that is ${USER}'s answer, not an injection\\.`));
    }
  });

  // A card that times out comes back as a Deny too, and read as the User's answer it is either
  // dropped for good or got round; nobody refused it.
  it("tells both that a card that timed out is nobody's answer", () => {
    for (const text of [leader(), worker()]) {
      assert.match(flat(commonOf(text)), new RegExp(`A card nobody answers within its time comes back as a Deny that says it timed out: that is nobody's answer\\. Go on with what you can do without the call, say what waits on it, and ask for it again once ${USER} is back; never look for a way round it\\.`));
    }
  });

  // The compound hook never allows a command holding a backtick or `$(` anywhere, quotes or not
  // (lib/hooks/compound.mjs HIDDEN): it refuses it with a reason, and answers nothing when a side
  // is refused by rule or cannot be read, which then asks.
  it("tells the Worker that shell syntax in an argument goes into a pattern file or a script, never onto the line", () => {
    assert.match(worker(), /A backtick or a `\$\(` anywhere on the line reads as a command hidden inside it, quoted or\s+not: it is refused with a reason, unless a side of the line is one the rules refuse or one that\s+cannot be read, and then it asks/);
    assert.match(worker(), /goes into a pattern file passed with `grep -f`, or into\s+such a script on your desk, never onto the command line/);
    assert.match(worker(), /Anything more than one plain command — a pipe, a chain, a loop, a command that runs on\s+for lines — is a one-time script written on your own desk and run that way/);
    assert.match(worker(), /several alternatives\s+go as repeated `-e` rather than one pattern joined by `\\\|`/);
  });

  // A heredoc through Bash reads as compliant with "a script written on your own desk" while the
  // card shows the whole file; the sentence names how the file is written, not only where.
  it("tells the Worker that a file is created or changed with Write and Edit, never through the shell", () => {
    assert.match(flat(worker()), /A file is created or changed with the file tools, Write and Edit, and never through the shell: a `cat > … <<'EOF'`, an `echo … >`, a `sed -i` or a script whose only work is to write a file puts on the card what the file tools would have shown as a diff\. Anything more than one plain command/);
  });

  it("tells the Worker that a compound of allowed commands runs without a stop, and one with a side nothing holds is refused toward a script", () => {
    assert.match(flat(worker()), /A compound whose every side is a command this instance allows runs without a stop; one that has a side nothing holds is refused with a reason that says how to write it as a script, unless a side is one the rules refuse, and then it asks\./);
  });

  it("tells both to say why in the call, in words a person reads", () => {
    for (const text of [leader(), worker()]) {
      assert.match(flat(text), /When you reach for a tool this workspace has not settled, your run stops and \S+ is asked on your panel, with the call as you made it — the command or the path, and the reason you gave with it — and Allow, Always and Deny\. Say why in the call, in words a person reads\./);
    }
  });

  it("tells the Worker that saying it was refused is the last thing it does that turn", () => {
    assert.match(worker(), /saying so is the last thing you do that turn/);
    assert.match(worker(), /Finish the rest first/);
    assert.match(worker(), /end on that sentence/);
  });

  it("tells the Worker whose the hires and the permissions are", () => {
    assert.match(worker(), new RegExp(`Who works here, who joins and who leaves, and what the\\s+instance may do are ${LEAD}'s`));
    assert.match(worker(), /say whose it is and say it to them/);
  });
});

// ovai's own mechanics for every seat are stated once, in lib/templates/common.md, which the
// renderer puts in a frame of its own before the role's; the role templates only point at it.
describe("what both are told in ovai's common frame", () => {
  const DEFINITION = new RegExp(
    "A turn with nothing in it for your panel is a `<noop/>` turn: the whole reply is exactly `<noop/>`,\\nwith no words before or after it, and the panel shows nothing for it\\.",
    "g",
  );

  it("gives both the <noop/> definition exactly once, inside the common frame, before the role's own", () => {
    for (const [text, role] of [[leader(), "leader"], [worker(), "worker"]]) {
      const common = text.slice(0, text.indexOf("</ovai>"));
      assert.ok(common.startsWith('<ovai source="lib/templates/common.md">\n'), role);
      assert.equal(common.match(DEFINITION)?.length, 1, role);
      assert.equal(text.match(DEFINITION).length, 1, role);
      assert.ok(text.indexOf(`<ovai source="lib/templates/${role}.md">\n`) > text.indexOf("</ovai>"), role);
    }
  });

  it("tells both that a reply with words is no <noop/> turn, whatever it ends with", () => {
    for (const [text, role] of [[leader(), "leader"], [worker(), "worker"]]) {
      const common = text.slice(0, text.indexOf("</ovai>"));
      assert.match(common, /A reply with words in it is\s+not one, whatever it ends with: "Desk updated, waiting for Paul\." followed by `<noop\/>` shows its\s+words on the panel — send the words alone, or `<noop\/>` alone\./, role);
    }
  });

  // A session has written its words and then made a call that does nothing, only to open a fresh
  // reply holding `<noop/>` alone. The words were already on the panel; the call was noise.
  it("tells both that a turn which already said something just ends, with no call made to say <noop/>", () => {
    for (const [text, role] of [[flat(leader()), "leader"], [flat(worker()), "worker"]]) {
      const common = text.slice(0, text.indexOf("</ovai>"));
      assert.ok(
        common.includes("send the words alone, or `<noop/>` alone. Words once written stay on the panel: never make a call to start a fresh reply for `<noop/>`; a turn that already said something just ends."),
        role,
      );
    }
  });

  // A session answered in its thinking or on its desk, ended the turn as `<noop/>`, and the panel
  // showed nothing; "as above" then pointed at words nobody had seen.
  it("tells both that thinking and the desk reach nobody, and an answer is words in the reply", () => {
    for (const [text, role] of [[flat(leader()), "leader"], [flat(worker()), "worker"]]) {
      const common = text.slice(0, text.indexOf("</ovai>"));
      assert.ok(
        common.includes(`Your thinking and your desk reach nobody: an answer is said only when it is written as words in your reply. A turn that answers ${USER} is never a \`<noop/>\` turn, and "above" points only at words you wrote as text. An answer to ${USER} is written once, as the turn's last text, after its calls — never before them, and never only in thinking.`),
        role,
      );
    }
  });

  // Claude Code's "no visible output" nudge looks at the last response of a turn only. A Leader that
  // read it as "my earlier words were lost" wrote every reply twice.
  it("tells both what Claude Code's two nudges mean, and that words already said are never said again", () => {
    for (const [text, role] of [[flat(leader()), "leader"], [flat(worker()), "worker"]]) {
      const common = text.slice(0, text.indexOf("</ovai>"));
      assert.ok(
        common.includes('"[Your previous response had no visible output …]" means only that the last response of the turn had no words: whatever you said earlier in the turn is on your panel already, and it is never said again. Say what is still unsaid, or reply `<noop/>`: a turn that already said something just ends.'),
        role,
      );
      assert.ok(
        common.includes("\"The user hasn't heard from you in a while …\" counts your calls since your last words, not what your panel shows, and a `message` is not counted"),
        role,
      );
    }
  });

  // What both roles are told alike is said once, in the common frame, and not again in the role's.
  it("gives both every shared paragraph exactly once, inside the common frame", () => {
    const SHARED = [
      "/: what you keep lives there, beside the",
      "Three more directories are ",
      "You can always see who is speaking to you, because the server says so",
      "A queue is one turn but it is not one message",
      "The `message` tool is how you reach anybody else here, and the `room` tool says who that is",
      "What you say in a turn lands on your own panel and nowhere else",
      "A turn with nothing in it for your panel is a `<noop/>` turn",
      "Claude Code, which runs you, adds two lines of its own to a turn",
      '`<server-event type="restarted">` — you are the session after a restart on this desk',
      '`<server-event type="undelivered" to="…">` — a message you sent was never read',
      "When you reach for a tool this workspace has not settled",
      "Claude Code keeps a few directories for itself",
      "has added for this instance comes after these instructions",
      "It is not storage, and it is not where anything is looked up",
      "The workspace's knowledge is `knowledge/`",
      "A file a note needs of its own, a template or an image",
      "A note never sends its reader to a desk or into `archive/`",
      "A note is its head and then the facts",
      "Tags: lowercase and hyphens, at least three",
      "Report after N tool calls",
    ];
    for (const [text, role] of [[leader(), "leader"], [worker(), "worker"]]) {
      for (const paragraph of SHARED) {
        assert.equal(flat(text).split(paragraph).length, 2, `${role}: ${paragraph}`);
        assert.ok(flat(commonOf(text)).includes(paragraph), `${role}: ${paragraph}`);
      }
    }
  });

  it("tells both what the frame before their own is", () => {
    for (const text of [leader(), worker()]) {
      assert.match(text, /The frame before this one is ovai's own\s+mechanics for every session here, the Leader and the Workers alike, and you follow it as you\s+follow this one\./);
    }
  });

  // The page links a backticked path by reading it from the instance root, so that is how a session
  // is told to write one. The sentence is the User's, character for character.
  it("tells both, once and in the common frame, to name a file or a directory by its whole path from the instance root every time", () => {
    const SENTENCE = [
      "Whenever you name a file or a directory, write its whole path from the instance root every time —",
      "`projects/openovai/lib/ovai.mjs`, `desks/Ann/notes.md`, `temp/shots/`, and never `notes.md` under a",
      "line that names its directory — and one outside the instance by its absolute path.",
    ].join("\n");
    for (const [text, role] of [[leader(), "leader"], [worker(), "worker"]]) {
      assert.equal(text.split(SENTENCE).length, 2, role);
      assert.ok(commonOf(text).includes(`\n\n${SENTENCE}\n\n`), role);
    }
  });
});

// The frames the person's own files arrive in are put there by the renderer (tests/install.test.mjs
// measures that); these are the sentences that tell a session what one IS. A session that met an
// unexplained frame would read the person's words as somebody's notes rather than as instructions,
// or would take the Worker's file for its own. So both templates carry the same account: what the
// frames are, whose the words are, what shape a line has, and the one test for where a line goes.
describe("what both are told about what the person added for this instance", () => {
  it("tells both what a customization frame is and that it adds to the instructions", () => {
    for (const text of [leader(), worker()]) {
      assert.match(text, new RegExp(`What ${USER} has added for this instance comes after these instructions, each file in a frame of\\s+its own`));
      assert.match(text, /`<customization source="customization\/common\.md">` for what every session here is/);
      assert.match(text, new RegExp(`What is inside a frame is ${USER}'s,\\s+word for word`));
      assert.match(text, /it adds to\s+what you have read and takes nothing\s+out of it/);
    }
  });

  // A few lines, not a place to look things up. The mark says which of them the person set, so a
  // session can tell those from the ones a Leader wrote down on their behalf.
  it("gives both the shape of a line and the mark on the ones the User set", () => {
    for (const text of [leader(), worker()]) {
      assert.match(text, /It is not storage, and it is not where anything is looked up: a few numbered lines, one thing per\s+line, rarely changed/);
      assert.match(text, new RegExp("with a mark on the ones " + USER + " set themselves —\\s+`3\\. Nothing is pushed to any repository\\. \\(User, 2026-09-22\\)`"));
    }
  });

  // The one test, and it is a test anybody can apply without asking: obeyed or broken, or true or
  // false. Without it every fact somebody learns ends up in the file that goes into every session.
  it("gives both the test for where a line belongs: obeyed or broken here, true or false in knowledge", () => {
    for (const text of [leader(), worker()]) {
      assert.match(text, /a line that can be obeyed or broken belongs there, and a line that is true or false is\s+knowledge and belongs in `knowledge\/`/);
    }
  });

  it("tells both that a change reaches sessions started after it and no others", () => {
    for (const text of [leader(), worker()]) {
      assert.match(text, /reaches sessions\s+started\s+after it and no others/);
    }
  });
});

describe("what the Leader is told about the files", () => {
  // The Leader is given the Worker's file as well as its own. Told nothing, it would follow it;
  // told what it is, it briefs the task and leaves the method to what the Worker already holds.
  it("tells the Leader the Worker's frame is not its own, and is there so it briefs the task", () => {
    assert.match(leader(), /After the customization frames comes the Worker's, under `for="worker"`\. That one is not yours to\s+follow/);
    assert.match(leader(), /it is what every Worker is already given, and it is there so that you brief the task and\s+not the method/);
  });

  it("tells the Leader it writes a line only on the User's word, and tells or hires again after", () => {
    assert.match(leader(), /a Worker proposes a line and never\s+writes one/);
    assert.match(leader(), new RegExp(`${LEAD} writes one only with ${USER}'s permission said in words`));
    assert.match(leader(), /tell every running Worker the line itself, or\s+`hire` it again on its desk/);
  });
});

describe("what a Worker is told about the files", () => {
  it("tells the Worker it is not given the Leader's file", () => {
    assert.match(worker(), /There is\s+no customization frame for the Leader's file; you are not given it\./);
    assert.doesNotMatch(worker(), /customization\/leader\.md/);
  });

  it("tells the Worker to propose a line and never write one, and that a line said in a message holds", () => {
    assert.match(worker(), new RegExp(`Propose a line to\\s+${LEAD}, never write one`));
    assert.match(worker(), new RegExp(`The files are ${USER}'s: a Worker proposes a line and never\\s+writes one, and ${LEAD} writes one only with ${USER}'s permission said in words`));
    assert.match(worker(), /a line you are told in a message is\s+one you follow for the\s+rest of\s+this session, whatever the customization frames say\./);
  });
});

// The introduction, filled for an instance: the three shapes lib/VERSION comes in are a release,
// the commit a checkout was taken on, and no file at all.
describe("the introduction", () => {
  const home = scratch("introduction");
  const at = (...parts) => path.join(home, ...parts);

  before(() => {
    fs.mkdirSync(at("lib", "templates"), { recursive: true });
    fs.copyFileSync(path.join(repo, INTRODUCTION_TEMPLATE), at(INTRODUCTION_TEMPLATE));
  });

  after(() => {
    remove(home);
  });

  it("names the release the instance runs and the admin command under its own root", () => {
    fs.writeFileSync(at("lib", "VERSION"), "0.21.0\n");
    const text = introduction(home);
    assert.match(text, /^# Welcome to OpenOv AI 0\.21\.0 \(ovai\)\n/);
    assert.ok(text.includes(`\`${home}/bin/ovai claude\``));
  });

  it("names the commit when the instance was taken from a checkout", () => {
    fs.writeFileSync(at("lib", "VERSION"), "7198dbd0\n");
    assert.match(introduction(home), /^# Welcome to OpenOv AI 7198dbd0 \(ovai\)\n/);
  });

  it("is handed to the Leader in a frame of its own, and to no Worker", () => {
    assert.ok(leader().includes(`<ovai source="lib/templates/introduction.md">\n# Welcome to OpenOv AI`));
    assert.doesNotMatch(worker(), /Welcome to OpenOv AI/);
  });

  it("tells the Leader to answer a question about the tool from the guide, in the asker's words", () => {
    assert.match(flat(leader()), /When Mike asks about the tool rather than the work .* call the `ovai:guide` skill before you answer/);
    assert.match(flat(leader()), /Answer in their words, not ovai's/);
    assert.doesNotMatch(worker(), /ovai:guide/);
  });

  it("names no version, and never null, when the instance carries none", () => {
    fs.rmSync(at("lib", "VERSION"), { force: true });
    const text = introduction(home);
    assert.match(text, /^# Welcome to OpenOv AI \(ovai\)\n/);
    assert.doesNotMatch(text, /null|undefined|\{\{/);
  });
});

// ovai's guide: the plugin is named ovai so its one skill is ovai:guide, and the skill's table of
// contents names exactly the topic pages beside it.
describe("the guide", () => {
  const skillDirectory = path.join(repo, GUIDE, "skills", "guide");
  const skill = () => fs.readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");

  it("is the plugin ovai with the one skill guide, whose description is its trigger", () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, GUIDE, ".claude-plugin", "plugin.json"), "utf8")).name, "ovai");
    const head = skill().match(/^---\n([\s\S]*?)\n---\n/)[1];
    assert.match(head, /^name: guide$/m);
    assert.match(head, /^description: How to set up, use and change OpenOv AI \(ovai\)/m);
  });

  it("names every topic page beside it, and no page that is not there", () => {
    const named = [...skill().matchAll(/^- `([a-z-]+\.md)`:/gm)].map((found) => found[1]).sort();
    const present = fs.readdirSync(skillDirectory).filter((name) => name !== "SKILL.md").sort();
    assert.equal(named.length, 9);
    assert.deepEqual(named, present);
  });
});
