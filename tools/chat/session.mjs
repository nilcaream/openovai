// Asking a session something.
//
// One Claude Code run per message: the process starts, answers, and is closed. It need not be —
// held open, a run answers question after question in one conversation — and it is closed anyway,
// because the conversation surviving in a session id rather than in a running process is what lets
// the server be stopped and started again in the middle of one without losing it. Keeping a
// process per session would trade that away and make this the place that supervises them. The
// price of the trade is a start-up per message, and it is knowingly paid.
//
// Every session in the instance is run through here, the lead included. A session differs from
// another only in its name, the model it runs on and the persona it is given; nothing else about
// the run is anybody's in particular, so there is one way to run one rather than one per kind.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { environment } from "../claude.mjs";
import { listening } from "./listening.mjs";
import { desks } from "../desks.mjs";

// Where a thread lives between runs, under the name of the session having it. One id, written
// after every answer: it is the whole reason a per-message run can still be a conversation.
const SESSION_FILE = "session.json";

// Who a session is, written out when it is opened. A persona is appended to Claude Code's own
// system prompt rather than replacing it, so a session gains a name and a desk without losing
// the instructions that make its tools work.
const PERSONAS = "personas";

// What a session is told its own name in. `ovai say` reads it, so a message one session sends
// another arrives under the name of whoever sent it — and a message nobody signed is the human's,
// which is the whole of how a session tells the two apart.
export const NAME_IN_ENVIRONMENT = "OW_SESSION_NAME";

// How long a session may be kept waiting on one of the instance's own tools. Half an hour, because
// `say` is answered only when the session it reached has finished its turn, and a turn is minutes.
const A_WHOLE_TURN = 30 * 60 * 1000;

function sessionFile(root, name) {
  return path.join(root, "chat", name, SESSION_FILE);
}

function remembered(root, name) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(root, name), "utf8")).sessionId ?? null;
  } catch {
    return null;
  }
}

function remember(root, name, sessionId, context, quota, refused) {
  const target = sessionFile(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ sessionId, context, quota, refused }, null, 2)}\n`);
}

// How much of itself a thread is carrying, as of the end of its last turn. Read from the same file
// the thread id lives in, so it is what is known about this conversation between runs and goes with
// it when it ends — a session that has just been handed over has no reading, which is the truth.
export function contextIn(root, name) {
  try {
    const held = JSON.parse(fs.readFileSync(sessionFile(root, name), "utf8")).context;
    return typeof held === "number" ? held : null;
  } catch {
    return null;
  }
}

// How full the account's usage windows were when this session last ran, as the service last told
// that run. Read from the same file and with the same honesty as the reading above: what the run
// was told, or nothing.
//
// A list rather than one number, because the frame names its own windows — a five-hour one and a
// seven-day one today — and picking one of them would write a name into this toolkit for a service
// that can rename its windows or add to them. Carrying them all is less code than choosing and
// makes no judgment.
//
// Nothing is NOT zero. A window nobody has been told about and a window that is empty are opposite
// facts, and a row that printed 0% for the first would be inventing the most reassuring possible
// reading out of an absence.
export function quotaIn(root, name) {
  try {
    const held = JSON.parse(fs.readFileSync(sessionFile(root, name), "utf8")).quota;
    return Array.isArray(held) ? held : null;
  } catch {
    return null;
  }
}

// The refusal this session is still under, or nothing.
//
// A refusal is not a fact about a moment the way a reading is; it is a condition that lasts, and
// the service says when it ends. So this is the one thing here that answers differently at
// different times without anything having been written in between: the moment is stored, the
// comparison happens on every read, and there is no timer, nothing scheduled and nothing to clean
// up. Exactly the shape hasGoneCold() already has, for the same reason.
//
// A refusal that named no moment cannot expire this way and stays until a run reports otherwise.
// That is the honest answer rather than a guessed expiry: the service did not say, so neither does
// this, and the next run settles it. Dropping such a refusal for saying less would be the most
// confident possible silence.
export function refusedIn(root, name) {
  let held;
  try {
    held = JSON.parse(fs.readFileSync(sessionFile(root, name), "utf8")).refused;
  } catch {
    return null;
  }
  if (held === null || typeof held !== "object") {
    return null;
  }
  const lifts = typeof held.resetsAt === "number" ? held.resetsAt : null;
  if (lifts !== null && lifts * 1000 <= Date.now()) {
    return null;
  }
  return { kind: held.kind ?? null, resetsAt: lifts };
}

// Whether this session has a conversation to carry on, which is not the same question as how big
// it is. A run that reported no usage is remembered with `context: null`, and so is a session
// that has never answered at all — so a reading of null cannot tell a live thread from no thread,
// and only the id can. The id itself stays in here: what a page or a command wants to know is
// whether there is one.
export function hasThread(root, name) {
  return remembered(root, name) !== null;
}

// When this conversation last ran, or nothing when it has never run or has been ended. The file
// below is rewritten after every answer that reported a session id, so its modified time IS that
// moment — there is nothing to record and nothing that can disagree with it.
//
// The thread's own clock, deliberately, and not the panel's: a panel is appended to outside any
// run, so its time walks forward while the conversation it belongs to sits untouched. The two
// answer different questions and only this one answers "when did this session last think".
//
// Nothing, rather than a guess, when the file is not there or cannot be read. A reading that
// cannot be taken is not a reading that says "old", and every caller is written to do nothing on
// null — the same honesty contextIn already has.
export function ranAt(root, name) {
  try {
    return fs.statSync(sessionFile(root, name)).mtimeMs;
  } catch {
    return null;
  }
}

// How long a conversation can go unanswered before carrying it on certainly costs the whole of it
// again at write price. The cache holding a conversation between runs lives an hour.
//
// Not in openovai.json: it describes the model service rather than this workspace, it is the same number
// everywhere, and a wrong one silently either throws conversations away or pays for them. If it
// ever changes it is this literal and a fresh measurement.
//
// Not shortened for a margin, deliberately. Going under the hour discards conversations that were
// still warm and buys a fresh start for nothing. Being late costs money now and then; being early
// costs a conversation every single time.
const COLD_AFTER = 60 * 60 * 1000;

// Whether carrying this conversation on would certainly cost the whole of it again — which is the
// one question worth asking, because it is the only one that can be answered. The state of the
// cache itself cannot be read: only a run that WROTE reports what it bought, and by then the money
// is spent.
//
// So the rule is one-directional. Past the hour, certainly cold, and something is done about it.
// Inside it, nothing is claimed and nothing is done: a conversation in there may be warm or may
// not, and today's behaviour is already the right answer to not knowing.
//
// A session with no thread is never cold. There is nothing to carry on and so nothing that
// carrying it on could cost, and whatever is built on this would otherwise end a thread that was
// not there and announce a restart nobody made.
export function hasGoneCold(root, name) {
  if (!hasThread(root, name)) {
    return false;
  }
  const ran = ranAt(root, name);
  return ran !== null && Date.now() - ran > COLD_AFTER;
}

// How long a session may be doing nothing before somebody should be told, rather than left to
// look. Half of COLD_AFTER, and read FROM it rather than written down again: the second half of
// the hour is what is left to act in, and it is the same length as the first.
//
// One number and not two. A literal of its own would be a second thing that can be wrong, and it
// would sit still on the day the hour moves on a fresh measurement — which is the one way this
// could come to fire after the thing it exists to give warning of.
//
// It is a choice inside a band and not a measurement, and it is worth saying which. What is
// measured is the hour. That acting on this takes minutes rather than tens of minutes is judgment,
// so the design is one derived number with its arithmetic in the open, and there is one place to
// change it.
const QUIET_AFTER = COLD_AFTER / 2;

// Whether nothing has been run for this session long enough that somebody should look, which is a
// weaker claim than the one above and is never acted on. Nothing in this toolkit reads it to
// decide anything: it is said, and a person judges.
//
// Same shape and same honesty as hasGoneCold, deliberately. A session with no thread is not quiet
// — it has nothing to be quiet with, and nothing that waiting could cost it.
//
// A conversation past the hour is quiet too, and is not excepted. A session named at fifty-five
// minutes and gone from the reading at sixty-one would be the worst of the readings this could
// give: the moment it becomes expensive is the moment it would stop being mentioned.
export function hasGoneQuiet(root, name) {
  if (!hasThread(root, name)) {
    return false;
  }
  const ran = ranAt(root, name);
  return ran !== null && Date.now() - ran > QUIET_AFTER;
}

// The usage window this rule is about, NAMED — which the reading that carries it deliberately never
// does.
//
// The fence at windowsIn() says picking a window writes a name into this toolkit for the service to
// rename underneath it, and that fence is right for a reader that must say every window without
// judging any of them. That is the row, and the row is untouched. It is crossed here for a reader
// that judges: this is one rule somebody decided about one window, and a rule about a particular
// window cannot be written without saying which. Five per cent of a week is a working day, so the
// same two numbers said of a seven-day window would stop everything for something that is not an
// emergency.
//
// Picking it WITHOUT the name was measured and does not work. "The window that lifts soonest" holds
// on four of the five frames we have captured and fails on the first: the seven-day window rolled
// at 17:00Z on 2026-09-02 while the five-hour window then running lifted at 20:20Z, so for those
// hundred minutes the soonest-lifting window was the seven-day one. Roughly a hundred minutes every
// seven days in which a name-free reader hands this rule to somebody about the wrong window. And
// nothing else on the frame says how long a window IS — only the key does — so parsing the key
// would hard-code the naming FORMAT, which is more fragile than the name and fails into the wrong
// window silently.
//
// It fails silent rather than wrong. If the service renames this window nothing matches, this
// answers nothing, and nobody is told anything — while the row goes on naming every window the
// service names. A reading that stops arriving, never an instruction about the wrong window.
const RULED_WINDOW = "five_hour";

// The line above which the work left has to be planned rather than simply done.
//
// This is a judgment and not a measurement, and that is worth saying where it sits: COLD_AFTER
// above is an hour because a cache lives an hour, and this is ninety per cent because that is where
// somebody decided to change what they do. Nothing here can check it and nothing pretends to.
const PLAN_ABOVE = 0.9;

// The line above which there is not enough left to plan around, and the work stops instead.
//
// The other judgment, said beside the first for the same reason. Ninety-five is not five per cent
// of anything anybody measured; it is where somebody decided that finishing what is in flight is no
// longer the right answer.
const STOP_ABOVE = 0.95;

// Where the account stands, as the freshest thing it has told anybody here, or nothing at all.
//
// THE FRESHEST AND NOT THE FULLEST. One account, N sessions, N readings taken at N different
// moments: the most recent one is the only one that describes the account now, and the largest of
// them may be off a window that ended hours ago. In practice the freshest is usually the lead's
// own, because it runs oftenest — and it is the reading its PREVIOUS run was handed, since this is
// read before the current turn writes anything.
//
// Nobody is left out for being mid-turn, and that is the one place this differs from hasGoneQuiet()
// above. There the reading is a fact ABOUT the session, and a session's clock stands still for the
// whole of a turn, so a working session would read as a stopped one. Here the reading is a fact
// about the ACCOUNT that a session happened to be handed, and a run still going was told it as
// truly as one that has finished.
//
// A window whose lift has already passed is dropped: it describes a window that has ended, and
// ninety-six per cent of a window that has reset is nothing. The same comparison-on-read refusedIn()
// makes, for the same reason — the moment is stored, the comparison happens on every read, and
// there is no timer, nothing scheduled and nothing to clean up.
//
// Reading it changes nothing and decides nothing. It is not consulted before delivering a message,
// hiring, handing over, queueing or refusing, and there is a check that says so rather than this
// sentence.
export function accountStanding(instance) {
  const read = sessions(instance)
    .map((session) => ({
      name: session.name,
      at: ranAt(instance.root, session.name),
      windows: quotaIn(instance.root, session.name),
    }))
    .filter((one) => one.at !== null && Array.isArray(one.windows));
  if (read.length === 0) {
    return null;
  }

  const freshest = read.reduce((one, other) => (other.at > one.at ? other : one));
  // A window that named no moment cannot be known to have ended, so it stays. The service did not
  // say, so this does not decide. Asked of every window here rather than of one, so the window this
  // rule is about and the one merely mentioned beside it are dropped by the same comparison.
  const ended = (window) => window.resetsAt !== null && window.resetsAt * 1000 <= Date.now();

  const ruled = freshest.windows.find((window) => window.name === RULED_WINDOW);
  if (ruled === undefined || ended(ruled) || ruled.fullness < PLAN_ABOVE) {
    return null;
  }

  // The window's name goes back with it, spelled as the service spells it, so whoever says this in
  // words says the name of the window that was actually matched. A sentence carrying its own copy
  // of it would be a second place for the two to disagree.
  return {
    on: freshest.name,
    at: freshest.at,
    window: ruled.name,
    fullness: ruled.fullness,
    resetsAt: ruled.resetsAt,
    // Whether there is still something to plan around, or nothing left to plan with.
    stop: ruled.fullness >= STOP_ABOVE,
    // Whether everybody could be carried on where they stand once the wait is over, which is the
    // whole of the choice between pausing people and handing them over.
    //
    // READ OFF COLD_AFTER AND NEVER WRITTEN DOWN AGAIN, the way QUIET_AFTER above is. The hour here
    // and the hour a conversation goes cold in are the same hour for the same reason — a cache
    // lives an hour — and a second copy of it that drifted would tell somebody to pause people it
    // can no longer carry on.
    //
    // Null when the frame named no moment, which is not the same answer as no: nothing is known,
    // so nothing is decided, and whoever says this in words has a third thing to say.
    warm: ruled.resetsAt === null ? null : ruled.resetsAt * 1000 - Date.now() <= COLD_AFTER,
    // The other window beside it, and ONLY when it too is over the stop line.
    //
    // A FACT AND NOT AN INSTRUCTION. What to do about a full week is not a rule anybody here has
    // decided, and inventing one is the misfire this whole reading is built not to make. It is
    // carried at all because it is the one case where the advice above would otherwise be wrong:
    // "pause everybody, it lifts in twenty minutes" is false while a week nobody mentioned is what
    // is actually refusing. Below the stop line it is not carried, because the row already says it
    // and a number handed over with no instruction attached is the one most likely to be acted on.
    alsoWeek:
      freshest.windows.find(
        (window) => window.name !== RULED_WINDOW && !ended(window) && window.fullness >= STOP_ABOVE,
      ) ?? null,
  };
}

// End a thread. The file is the whole of a session's memory between processes, so removing it is
// the whole of starting a new conversation on the same desk: the desk, the persona, the permission
// rule and the panel are all untouched, and the next run has nothing to resume.
//
// There is nothing to kill. A run lives for one message and is already gone.
export function forget(root, name) {
  fs.rmSync(sessionFile(root, name), { force: true });
}

// Which model a session runs on. The instance was installed with one model for the session that
// leads and one for everybody else, and a session's own name is enough to say which it is, so
// there is nothing to record and nothing that can disagree with openovai.json.
function model(instance, name) {
  const models = instance.config.models;
  return name === instance.config.leader ? models.leader : models.worker;
}

// The persona is passed on every run, resumed ones included. Claude Code does keep it with the
// conversation, so a resume would carry it anyway — but a resume that fails is asked again as a
// new conversation, and that one has no history to carry it. Passing it always means there is no
// path through here where a session forgets who it is.
//
// A session may have no persona file: an instance installed before personas were written out has
// none for its lead. Claude Code refuses to start at all when pointed at a file that is not
// there, so the flag is left off instead: a nameless session still answers, and a chat that will
// not answer helps nobody.
function persona(root, name) {
  const file = path.join(root, PERSONAS, `${name}.md`);
  return fs.existsSync(file) ? file : null;
}

// Everybody the chat can host, the lead first and the rest as the desks come. A desk is a
// person, so this is read from work/ every time it is asked for rather than kept anywhere: a desk
// opened while the chat is running is somebody the chat can host from that moment on.
//
// The lead is named whether or not it has a desk. An instance has a lead by definition, and a
// chat that dropped it because a directory went missing would be a chat nobody can reach.
export function sessions(instance) {
  const leader = instance.config.leader;
  const rest = desks(instance.root).filter((name) => name !== leader);

  return [leader, ...rest].map((name) => ({
    name,
    role: name === leader ? "lead" : "worker",
    model: model(instance, name),
    context: contextIn(instance.root, name),
  }));
}

// The frame a question is sent as. Claude Code reads one JSON object per line on stdin; a user
// message is the smallest of them, and `content` is allowed to be the plain string rather than a
// list of blocks, which is all a question from a page ever is.
function question(text) {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

// Everything Claude Code says comes back one JSON object per line, and only the `result` line is
// an answer. The rest is read and handed over all the same — the assistant's own turns,
// `keep_alive` every thirty seconds while a long one runs, `system` notices — because what a frame
// is worth is the caller's business and not the reader's. A line that is not JSON at all is
// skipped rather than fatal: stdout is the protocol, but a stray warning on it should not lose an
// answer that arrived beside it.
function frames(chunk, rest, saw) {
  const lines = (rest + chunk).split("\n");
  const left = lines.pop();

  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    try {
      saw(JSON.parse(line));
    } catch {
      // Not a frame. Nothing on this line is ours to act on.
    }
  }
  return left;
}

// Being asked whether the run may use a tool, and saying.
//
// Only tool calls the instance's own settings leave undecided ever get here: something already
// allowed is not asked about, and something already refused is refused without us. So this is the
// question a person is actually needed for.
//
// Three things about the answer, each of which costs a run that hangs for good if it is got wrong:
// the request id goes back exactly as it came, nothing else about the tool is named alongside it
// (a mismatched name makes the answer be ignored and the request stay open), and one request is
// answered once. Nothing here times out, on this side or the other.
function permission(child, frame, asked) {
  const request = {
    id: frame.request_id,
    tool: frame.request.tool_name,
    input: frame.request.input,
  };

  asked(request).then(
    (decision) => {
      child.stdin.write(
        `${JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: frame.request_id, response: decision },
        })}\n`,
      );
    },
    (error) => {
      // Nobody could be asked. Saying so is an answer; saying nothing leaves the run waiting for
      // one that is never coming.
      child.stdin.write(
        `${JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: frame.request_id,
            response: { behavior: "deny", message: `nobody could be asked: ${error.message}` },
          },
        })}\n`,
      );
    },
  );
}

// Every run this chat has going, under the name of the session it belongs to. A run puts itself
// in when it starts and takes itself out when it is over, so what is in here is what is alive
// right now, and there is one place to look when the chat is asked to stop.
//
// Keyed by name rather than held as a bare set, because one of them can now be asked for by
// itself. That the key is enough is not a hope: a session answers one message at a time, so at
// most one run of a session is alive at once, and the queue is what makes that true rather than
// anything here.
const running = new Map();

// The runs somebody ended, waiting for their own close to be read. A name goes in when the ending
// is asked for and comes out when the run settles, so nothing is left here for a run that is over.
const endedHere = new Set();

// What such a run amounted to. Its own sentence, because the alternative is a lie: a run ended
// before it answered has no result frame, and `interpret` calls a run with no result frame one
// that "ended without answering" — which is true of a run that fell over and not of one somebody
// ended on purpose. Said here so the turn appends it the way it appends any other failed turn,
// and the panel carries ONE line about it rather than a second posted from the side.
const ENDED_BY_HAND = "this run was ended before it answered";

// How long a run is given to go quietly before it is made to.
const PATIENCE = 2000;

// Everything running underneath a process, itself last.
//
// This exists for one case, and the case is measured. A run puts every tool call it makes in a
// session of its own — not merely a process group of its own — so a shell it started is out of
// reach of any signal sent to this chat or to the run itself. Watched: a run doing real work in a
// shell had that shell at sid 765409 while the run was at sid 765091.
//
// Asked to stop, a run takes its own shells with it, so none of this is needed on that path.
// Watched: chat, run, shell, xargs and the command all gone together. FORCED to stop, it cannot —
// it is not running any more to do it. Watched: the run was gone and its `xargs` and a freshly
// started `sha256sum` were still going, orphaned into their own session.
//
// So the tree is read BEFORE the run is forced: killing it first would reparent everything under
// it to init and lose the only thread back to what it started.
function descendants(pid) {
  const asked = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  if (asked.status !== 0 || typeof asked.stdout !== "string") {
    return [];
  }

  const below = new Map();
  for (const line of asked.stdout.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(child) && Number.isInteger(parent)) {
      below.set(parent, [...(below.get(parent) ?? []), child]);
    }
  }

  const found = [];
  const left = [pid];
  while (left.length > 0) {
    for (const under of below.get(left.pop()) ?? []) {
      // A pid cannot be its own ancestor, so nothing here can loop; a table read mid-change
      // could still name one twice, and doing it twice is only a wasted signal.
      found.push(under);
      left.push(under);
    }
  }
  return found;
}

// End one run and wait for it to actually be over. Asked first, because a run told to stop can
// close its own files, write down where its conversation got to, and take its own shells with it;
// made to only if it will not, because a chat that hangs on the way out is worse than a run that
// loses its last few words.
//
// A run that has to be made to go cannot tidy up after itself, so this does it: what was under it
// is read while it is still there to be read, and goes with it.
async function end(child, patience) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const gone = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const made = setTimeout(() => {
    const under = descendants(child.pid);
    child.kill("SIGKILL");
    for (const pid of under) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, or not ours any more. Either way there is nothing to do about it.
      }
    }
  }, patience);
  await gone;
  clearTimeout(made);
}

// How long a run the service turned away is given to leave on the close of its own input before
// it is ended for it.
const GRACE = 2000;

// A run the service refused, seen off.
//
// Its input is closed exactly as it is when an answer arrives, and on everything measured that is
// the whole of it: a refused turn still emits a result frame, so the run ends by the door it
// already has and nothing below this line ever runs. It is here anyway, and deliberately.
//
// All of that rests on a read of the binary rather than on a refused process anybody has watched,
// and the cost of being wrong is one-sided. If some refusal shape does go quiet, without this the
// turn never ends, the queue behind that session stops, and whoever said something waits out the
// half hour. So the close is followed by a bounded grace and then the ending that already exists.
//
// This is not the clock a turn is never given. A watchdog guesses whether work is still happening;
// this starts only after the service has said the run was refused, and a refused run has nothing
// left to lose.
function leave(child) {
  child.stdin.end();
  const made = setTimeout(() => end(child, PATIENCE), GRACE);
  child.once("close", () => clearTimeout(made));
}

// End every run this chat started, and do not return until they are gone.
//
// A ctrl-c in a terminal reaches them without any of this: a child is spawned into the process
// group the terminal signals, so it is sent the same interrupt the chat is. Nothing else is. A
// kill on the chat, or the window it was started in going away, leaves a run with a parent that
// is no longer there — and a run does not notice. Watched: one parked on an approval outlived its
// chat and was reparented to init, still holding the model open, still waiting for an answer
// nobody could give it any more.
//
// So the chat ends what it started rather than trusting whatever stopped it to have done it. The
// one stop this cannot cover is a SIGKILL on the chat itself, where no code of ours runs at all.
export function endEveryRun(patience = PATIENCE) {
  return Promise.all([...running.values()].map((child) => end(child, patience)));
}

// End the one run this session has going, and do not answer until it is gone. Answers whether
// there was one, so a caller can tell "ended it" from "there was nothing to end" rather than
// having to ask first and race its own answer.
//
// It is the ending that already exists, whole: the run is asked, and made to go after PATIENCE if
// it will not, with what it started read out of the process table before the forcing rather than
// after it. Nothing new is written for the ending itself — what is new is only that one of them
// can be named.
export async function endRun(name, patience = PATIENCE) {
  const child = running.get(name);
  if (child === undefined) {
    return false;
  }
  endedHere.add(name);
  await end(child, patience);
  return true;
}

// How many runs are going. The chat says so on the way out: ending them takes a moment, and a
// terminal that sits there saying nothing reads as a hang.
export function runsGoing() {
  return running.size;
}

// Which sessions have one. The count above is what a terminal needs on the way out; this is what a
// census needs, and they are kept apart rather than one being written in terms of the other because
// a caller that wants a number and a caller that wants names should not have to agree on a shape.
export function runsUnderway() {
  return [...running.keys()];
}

// The instance's own tools, handed to a session as it starts.
//
// It is passed as the configuration itself rather than as a file to read, because there is nothing
// here worth a file: the address is only known once the chat has bound a port, and the name in it
// is this session and no other. A file would have to be written at every start to stay true, and a
// stale one would quietly point a session at a chat that is not there.
//
// The name goes in the path, which is how the chat knows who is calling: it comes from here, where
// the session is being started, and never from anything the session says about itself.
//
// Nothing when no chat has recorded an address. A session started with no chat serving the
// instance can still answer; it simply cannot reach the others, which is the truth of its
// situation and not a reason to refuse to start it.
//
// The wait is said out loud because the default is far too short for what `say` does. A call to it
// is answered when the session it reached has finished its turn, and a turn is minutes; measured
// with nothing said, a call was given up on after exactly 60 seconds while the session it asked
// carried on working and wrote its answer where the caller could never see it. This is a
// wall-clock limit rather than no limit at all: a session stopped waiting to be allowed something
// would hold whoever asked it for as long as nobody answered, and half an hour of that is enough
// for the room to have said so and somebody to have looked.
function toolsIn(root, name) {
  const chat = listening(root);
  if (chat === null) {
    return null;
  }

  return JSON.stringify({
    mcpServers: {
      openovai: {
        type: "http",
        url: `${chat}/mcp/${encodeURIComponent(name)}`,
        timeout: A_WHOLE_TURN,
      },
    },
  });
}

// One run, one question, one answer.
//
// The question goes in on stdin rather than in the arguments: with --input-format stream-json a
// prompt argument is read past in silence, so passing one would look right and ask nothing. Stdin
// then stays open until the answer arrives, because a run that is waiting to be told whether it
// may use a tool has to be able to hear the reply, which is what this format is for. Closing it
// once the answer is in is what ends the run: the child would otherwise sit
// there waiting for another question, which is a conversation the chat keeps in a session id
// instead, so that stopping the server never costs one.
function run(instance, name, text, resume, asked) {
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // Ask us rather than refusing on the spot. The literal is reserved: it means "over the pipes
    // to whoever started me", where any other value would have to name a tool from an MCP server
    // and the run would not start without one.
    "--permission-prompt-tool",
    "stdio",
    "--model",
    model(instance, name),
  ];
  const tools = toolsIn(instance.root, name);
  if (tools !== null) {
    args.push("--mcp-config", tools);
  }
  const who = persona(instance.root, name);
  if (who !== null) {
    args.push("--append-system-prompt-file", who);
  }
  if (resume !== null) {
    args.push("--resume", resume);
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("claude", args, {
        cwd: instance.root,
        env: { ...environment(instance.root, instance.config.auth), [NAME_IN_ENVIRONMENT]: name },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      // `refused: null` and not left off. A run that never started cannot have been turned away by
      // anybody, and every reader of this answer asks whether it was — `=== null` on a field that is
      // not there is false, which would make a toolkit that could not be started look like a
      // service that was busy. Nothing was refused here; there was nothing to refuse.
      resolve({ failed: true, refused: null, text: `Claude Code could not be started: ${error.message}` });
      return;
    }

    running.set(name, child);

    let answer = null;
    let limit = null;
    // What the service last said about the account, whatever it said — kept apart from `limit`
    // above on purpose. `limit` is a refusal or it is nothing, and it is what decides how the run
    // ENDED; this is a reading and decides nothing. Two locals rather than one object serving both,
    // so that no reader downstream has to work out which half of it they are allowed to look at.
    let reading = null;
    let rest = "";
    let err = "";

    child.stdout.on("data", (chunk) => {
      rest = frames(String(chunk), rest, (frame) => {
        if (frame.type === "control_request" && frame.request?.subtype === "can_use_tool") {
          permission(child, frame, asked);
          return;
        }
        // The service naming the condition itself, rather than us inferring it. Kept the way the
        // answer is kept and handed on, because what a run amounted to is decided in one place and
        // this is one of the things it is decided from.
        //
        // Only a refusal is kept. The frame is sent whenever the reading changes, so an ordinary
        // run sends one saying it is allowed, and both captures on this machine hold it in exactly
        // that state. Keeping those too would mean a run that was allowed early and turned away
        // later remembers the allowance and reads as an answer.
        if (frame.type === "rate_limit_event") {
          // Every reading, including the ones that say the run is fine. The comment above says why
          // only a refusal may reach the verdict, and that is still true: this one goes nowhere
          // near it. What it is for is the row, where a number that was true a moment ago is worth
          // reading and a number that decides something is not.
          reading = frame.rate_limit_info ?? null;
          if (frame.rate_limit_info?.status === "rejected") {
            limit = frame.rate_limit_info;
            leave(child);
          }
          return;
        }
        if (frame.type !== "result" || answer !== null) {
          return;
        }
        answer = frame;
        child.stdin.end();
      });
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });

    // Writing to a child that is already gone is an error on the pipe, not a throw, and there is
    // nothing to do about it here: the close handler is about to say what happened.
    child.stdin.on("error", () => {});

    child.on("error", (error) => {
      running.delete(name);
      const why =
        error.code === "ENOENT"
          ? "Claude Code is not on the PATH of the process serving this page"
          : error.message;
      // Same reason as the spawn that threw: a run that never reached the service was not turned
      // away by it, and the field says so rather than being absent.
      resolve({ failed: true, refused: null, text: why });
    });

    child.on("close", () => {
      running.delete(name);
      // Ended by somebody rather than over of its own accord, and it says so in its own words. An
      // answer that had already arrived is still the answer: what was ended then was a run with
      // nothing left to say, and reporting it as ended would throw away what it did say.
      if (endedHere.delete(name) && answer === null) {
        resolve({ failed: true, refused: null, ended: true, text: ENDED_BY_HAND });
        return;
      }
      resolve(interpret(answer, err, limit, reading));
    });

    child.stdin.write(question(text));
  });
}

// What the run amounted to. The result frame carries the answer as a plain string in `result`,
// which is the same field and the same string the older whole-of-stdout JSON put it in, so what
// the chat does with an answer did not have to change with how it arrives.
// Whether the service turned this run away, and what it said about it.
//
// Two readings, and neither is a fallback for the other. The frame is the service naming the
// condition and it is the better one, so where it arrives it is what is reported — it says which
// limit and when it lifts, where a status number says neither. The field answers the same question
// on its own, and it is the only thing on a result frame that tells a refusal from a run with no
// credential — both come back spelled `subtype: "success"` with `is_error` set, differing after
// that only in prose.
//
// The two never contradict each other here, because only a refusal is ever kept: `limit` is a
// refusal or it is nothing, so a run that was told it was allowed and then turned away is read
// off the 429 rather than off the reading it was given first.
//
// Nothing here requires the reset time. A refusal that does not say when it lifts is still a
// refusal, and is reported as one with nothing said about the time.
function turnedAway(answer, limit) {
  if (limit !== null) {
    return {
      resetsAt: typeof limit.resetsAt === "number" ? limit.resetsAt : null,
      kind: limit.rateLimitType ?? null,
    };
  }
  return answer?.api_error_status === 429 ? { resetsAt: null, kind: null } : null;
}

// Every window the reading named, in the order it named them, as a name and a fullness.
//
// `fullness` rather than the wire's `utilization` because this is what a row says to a person, and
// a fraction rather than a percentage because that is what arrives — measured on four real frames:
// 0.29, 0.57, 0.04, 0.02. Turning it into a percentage is a thing to do when printing it, not a
// thing to do to it here.
//
// Nothing, rather than an empty list, when there is no reading or it named no windows. An empty
// list is a service that answered "no windows", which is not what a frame that never came means,
// and everything downstream is written to say nothing on null.
function windowsIn(reading) {
  const named = reading?.unifiedWindows;
  if (named === null || typeof named !== "object") {
    return null;
  }
  const windows = Object.entries(named)
    .filter(([, window]) => typeof window?.utilization === "number")
    .map(([name, window]) => ({
      name,
      fullness: window.utilization,
      // When the service says this window ends. Every window on the frame carries its own, and it
      // arrives on ordinary ALLOWED runs — so when a window lifts is known long before anything is
      // refused, which is the half a refusal cannot answer because there has not been one yet.
      //
      // Its own and never the one beside `status`. Those two agree for the window the frame names
      // as the one it is talking about, and for no other, so a reader taking the outer one gives
      // every window the same ending.
      //
      // Nothing rather than a guess when the frame did not say, which is the rule the refusal
      // beside this already follows: the service did not say, so neither do we.
      resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
    }));
  return windows.length === 0 ? null : windows;
}

// `reading` is handed in beside `limit` and goes nowhere near `turnedAway()` below, which is the
// whole of what keeps a gauge from becoming a verdict: an ordinary run is told "allowed" and can be
// turned away moments later, and a function that saw both would have to choose which to believe.
// The signature is the guard. There is a check that goes red if this is ever widened.
function interpret(answer, err, limit = null, reading = null) {
  const refused = turnedAway(answer, limit);
  // No result frame at all: the run was stopped, or it fell over before it could answer. Whatever
  // it has to say about that is on stderr, which is the only stream carrying prose — measured:
  // a model it does not know gives `[claude-code:unrecognized_model] …`, a persona file that is
  // not there gives `Error: Append system prompt file not found: …`, and stdout stays frames.
  //
  // Stdout was once read here too, back when it was one JSON document and a run that fell over
  // could leave the reason in it. Since the switch to stream-json it is frames and nothing else,
  // so falling back to it can only ever put the protocol on the page — watched, 14,546 characters
  // of it, offered as what a session said. Do not put it back.
  if (answer === null) {
    const said = err.trim();
    return {
      failed: true,
      refused,
      quota: windowsIn(reading),
      text: said === "" ? "Claude Code ended without answering" : said,
    };
  }

  const text = typeof answer.result === "string" ? answer.result : JSON.stringify(answer);
  const failed = answer.is_error === true;

  return {
    failed,
    // What the run amounted to, third state: it reached the service and was turned away. Not an
    // answer and not a failure — the thread is perfectly good and the account is what is
    // unavailable — so it is said here rather than worked out again by everybody who asks.
    refused,
    // What the account was told to be at, on this run and no other. Beside the verdict rather than
    // inside it: it is a fact the run was handed, not a thing the run amounted to.
    quota: windowsIn(reading),
    text,
    // A run can end well and say nothing: the result frame arrives, is not an error, and carries
    // an empty string. Twice now that has reached a panel as a blank line, which reads as the
    // chat having lost the reply rather than as the session having had nothing to say. Why a
    // session does it is not known and is not guessed at here; that it did is worth saying.
    silent: !failed && text.trim() === "",
    sessionId: answer.session_id ?? null,
    context: contextAfter(answer),
  };
}

// Where the thread stood when the run ended, in tokens.
//
// `usage.iterations` is one entry per request the turn made, and the LAST of them is the whole of
// the conversation as the model last saw it: what was sent, what was read back out of the cache,
// and what was written into it. The turn after this one opens there.
//
// The top level of `usage` is NOT that. It adds the turn's requests together, so a turn that made
// two of them reports roughly twice what the thread is carrying — measured on a real session,
// 67,090 for a turn that ended at 41,929, and the next turn opened at 42,059. A number that grows
// at twice the rate of the conversation is worse than none, because it looks like an answer.
//
// Nothing here converts it to a share of anything. A percentage needs a table of what each model
// can hold, kept true by somebody, which is a moving part in aid of a decoration; the frame does
// carry `modelUsage[<model>].contextWindow` if that is ever wanted.
function contextAfter(answer) {
  const last = answer.usage?.iterations?.at(-1);
  if (last === undefined) {
    return null;
  }

  const used =
    (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0);
  return used > 0 ? used : null;
}



// What a run is told when nobody has been given a way to answer it. A caller that does not care
// about permissions still gets a session that runs; what it does not get is a session that can sit
// there for good waiting on a question nobody will ever see.
function nobodyToAsk() {
  return Promise.reject(new Error("this chat was not given a way to ask"));
}

export async function ask(instance, name, text, asked = nobodyToAsk) {
  const resume = remembered(instance.root, name);
  let answer = await run(instance, name, text, resume, asked);

  // A remembered thread can go away — the Claude Code home was cleared, or the conversation
  // was never written. Rather than leave the chat permanently broken, drop the id and ask
  // again as a new conversation. Losing the history beats losing the chat.
  //
  // A run the service turned away is not that, and the two used to be the same word here. Failed
  // means the thread could not be used, and asking again without it is the repair; refused means
  // the account is unavailable and the thread is untouched. Retrying a refusal spends a second run
  // that cannot succeed, and forgetting throws a conversation away for a condition that clears by
  // itself. So this fires on what its own comment describes, and on nothing else.
  //
  // A run somebody ENDED is the third of those, and the strongest case of the three: retrying it
  // starts another run of exactly what was just stopped — measured, and on a run that had gone
  // quiet the second one went quiet too — and the forget throws away a conversation that nothing
  // was ever wrong with. Somebody asked for this to stop; asking again is the one thing they did
  // not ask for.
  if (answer.failed && answer.refused === null && answer.ended !== true && resume !== null) {
    forget(instance.root, name);
    answer = await run(instance, name, text, null, asked);
  }

  if (typeof answer.sessionId === "string" && answer.sessionId !== "") {
    // Written together, because they are one fact about one conversation. What this run reported is
    // what is kept, `null` included: a reading that stopped arriving should show as nothing rather
    // than as a number from some earlier turn that is no longer where the thread is.
    remember(
      instance.root,
      name,
      answer.sessionId,
      answer.context ?? null,
      answer.quota ?? null,
      answer.refused ?? null,
    );
  }

  return answer;
}
