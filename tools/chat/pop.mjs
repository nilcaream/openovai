// Reaching the person when they are not at the page.
//
// The workspace already knows twice over that a person is needed, and both times it says so on a
// panel. That is right while somebody is reading it and useless while nobody is: a session was
// measured sitting parked for six and a half minutes waiting to be allowed something, and it would
// have sat there for good, because nothing on that path times out and the request was drawn on a
// page nobody had open.
//
// So this carries those two moments off the page. It is a doorbell and not a channel: nothing here
// is a tool, nothing here can be called by a session, and there is nothing new for anybody to say.
// The lead already has its one unprompted line to the person — `interrupt` — and a second way to
// reach them is exactly what "one thing at a time" is there to stop.
//
// WHAT IT FIRES ON, and why those two and nothing else. A popup goes up when a session's `interrupt`
// lands, and when a permission request is parked. Both mean the same thing — this stops until a
// person acts — and they are the only two states in the whole workspace that do. Everything else
// that happens here is a record, and a record is read when somebody reads it.
//
// ON THE TRANSITION, NEVER ON THE CONDITION. Both are one-shot calls: a tool call happens once, and
// a request is parked once. So "one popup per thing waiting" is true because of when this is called
// and not because anything remembers what it has already said — there is no store here, no sweep, no
// timer and nothing to clear. It also settles the loudest way this could have gone wrong: the page
// asks what is parked once a second, and a popup driven off that answer would go up sixty times a
// minute for one stopped session.
//
// AND HOW IT POPS IS NOT THIS TOOLKIT'S BUSINESS. Making a desktop pop is `notify-send` on one
// machine, `osascript` on another and a toast API on a third, and none of that can ship in
// something that installs on machines it knows nothing about. So the toolkit decides WHEN and the
// instance decides HOW, in one file of its own that this reads and calls.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { THE_CHAT, append } from "./conversation.mjs";

// The instance's own file, at its root beside the file describing the instance.
//
// Not under plugins/: that directory IS the list of tools a session may call, and a file in it that
// is not one breaks the sentence the whole directory rests on — while a file in it that IS one
// would hand a session the second way to the person that this design exists without. Not under
// tools/ either, for the reason a plugin is not: taking a newer version of the toolkit replaces
// every payload directory, so a file kept in there would be deleted by the first update.
export const POP_FILE = "pop.mjs";

// The one thing it has to export. A file that is there and exports nothing callable is worse than
// no file at all — it would be read as a working desktop and pop nothing, forever — so it is turned
// away by name while somebody can still be told why.
const EXPORT = "pop";

// When this workspace is not to be woken, as the instance writes it in its own description of
// itself. Absent from most of them, which means nothing is quiet.
export const QUIET_HOURS = "quietHours";

// Two times of day and a hyphen. Anchored and exact: a window is the one field here that decides
// whether somebody's night is interrupted, and something almost right is worse than something
// obviously wrong.
const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

const MINUTES_IN_A_DAY = 24 * 60;

export function popFile(root) {
  return path.join(root, POP_FILE);
}

// What is wrong with a window, in the words somebody can act on, or nothing at all when there is
// nothing wrong with it. Absent is not wrong: most workspaces have no such field and everything
// that qualifies pops at any hour.
//
// It names the field, because the person reading this is looking at a file with a dozen things in
// it and the sentence has to say which one to go and change.
export function quietHoursProblem(window) {
  if (window === undefined || window === null) {
    return null;
  }
  if (typeof window !== "string" || !WINDOW.test(window)) {
    return `${QUIET_HOURS} is ${JSON.stringify(window)}, which is not a window — it is two times of day and a hyphen, like "22:00-08:00"`;
  }
  const [from, to] = window.split("-");
  if (from === to) {
    return `${QUIET_HOURS} begins and ends at ${from}, which is no time at all — a window that says nothing is better left out`;
  }
  return null;
}

// Whether a moment is inside the window.
//
// Half-open, so "22:00-08:00" is quiet at ten at night and awake at eight in the morning, and the
// two ends of a day laid end to end leave no minute in both and none in neither. A window whose end
// is before its start wraps midnight, which is what a night is; one whose end is after its start
// does not, which is what an afternoon is, and both are things somebody may legitimately want.
//
// The machine's own clock, because the person this is about is at that machine.
export function withinQuietHours(window, at = new Date()) {
  if (typeof window !== "string" || !WINDOW.test(window)) {
    return false;
  }

  const [from, to] = window.split("-").map(atMinute);
  if (from === to) {
    return false;
  }

  const now = at.getHours() * 60 + at.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

function atMinute(said) {
  const [hours, minutes] = said.split(":");
  return (Number(hours) * 60 + Number(minutes)) % MINUTES_IN_A_DAY;
}

// The instance's own way of popping, or nothing, and beside it the reason there is nothing when
// there was meant to be something.
//
// Both halves, for the reason the plugin loader answers in both: a desktop that cannot be reached
// is not an error and not nothing. Not an error, because a workspace where nobody can talk to
// anybody is a far worse answer to a typo in one file than a workspace that does not pop. And not
// nothing, because a file that is silently ignored is the failure this arrangement is most likely
// to produce — it is sitting right there, it looks like it works, and the desktop simply never
// lights up.
//
// Read once, by whoever is about to serve, for the reason a plugin is: a module is imported once
// per process, so reading the directory again later would find a NEW file and go on running the old
// code of a CHANGED one. It is picked up when the chat is started, which is already the act that
// replaces everything else the chat is running.
//
// An instance with no such file has no such thing, which is most of them.
export async function popIn(root) {
  const file = popFile(root);
  if (!fs.existsSync(file)) {
    return { pop: null, refused: null };
  }

  // Somebody else's code, and it can do anything at all on the way in — a syntax error, an import
  // of something that is not installed, work at the top level that throws. Caught here rather than
  // left to end the chat, which is what everybody else in the workspace is using.
  let written;
  try {
    written = await import(pathToFileURL(file).href);
  } catch (error) {
    return { pop: null, refused: `it could not be read: ${error.message}` };
  }

  if (typeof written[EXPORT] !== "function") {
    return { pop: null, refused: `a desktop is reached by a function called ${EXPORT}, and this one exports no ${EXPORT}` };
  }

  return { pop: written[EXPORT], refused: null };
}

// What the chat says about it where it was started.
//
// Nothing at all when there is no such file, which is the ordinary case: a line saying no every time
// would be read once and never again. The refusal names the file, because the person who has to fix
// this wrote it, and the terminal the chat was started in is the only place this can be said.
export function describePop({ pop, refused }) {
  if (refused !== null && refused !== undefined) {
    return `${POP_FILE} is not used: ${refused}`;
  }
  return pop === null || pop === undefined ? "" : `This instance pops on the desktop when somebody is needed: ${POP_FILE}`;
}

// Somebody is needed. `on` is whose panel it is about, so the person knows where to look, and `why`
// is the one sentence they read, composed already.
//
// TOLD, NOT ASKED. Whatever it answers is ignored and it is never awaited. `interrupt` promises in
// its own description that it says it and returns at once, and putting somebody else's code inside
// that promise would be putting a hang inside it — a file that never returns would hold the lead
// for as long as it liked. So the call is made, a failure is caught on both paths, and the caller
// carries on in the same tick.
export function popped(instance, { on, why }) {
  if (typeof instance?.pop !== "function") {
    return;
  }
  if (withinQuietHours(instance.config?.[QUIET_HOURS])) {
    return;
  }

  // Both ways it can fail. A function that throws before it returns never makes a promise to
  // reject, so the synchronous case needs its own catch and is not the rarer of the two — it is
  // what a missing command or a bad argument does.
  try {
    Promise.resolve(instance.pop({ on, why }, { root: instance.root, config: instance.config })).catch((error) =>
      notReached(instance, on, error),
    );
  } catch (error) {
    notReached(instance, on, error);
  }
}

// The desktop did not light up, said on the panel it was about.
//
// It is said at all because of who is left believing otherwise: a lead that has just broken in
// thinks the person has it, and a file that has been broken since Tuesday is invisible to everybody
// forever. On the panel rather than in the terminal, because the server prints nothing — the panel
// is where the chat speaks — and on the panel the popup was ABOUT, so the record of somebody being
// needed and the record of them not being reached sit together.
//
// Only the failure. Nothing is written when a popup goes up, for the reason the page's own buttons
// write nothing: whoever saw it already knows.
//
// Flagged, so what a check reads is the flag and not the prose. It cannot loop — appending a line
// pops nothing.
function notReached(instance, on, error) {
  try {
    append(instance.root, on, {
      from: THE_CHAT,
      text: `${POP_FILE} did not reach the desktop: ${error?.message ?? error}`,
      notReached: true,
    });
  } catch {
    // The panel could not be written either. There is nowhere left to say it and nothing this
    // can usefully do about it, and throwing from here would take the chat down over a popup.
  }
}
