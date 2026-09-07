// The room watch: the one thing in this toolkit that starts a turn nobody asked for.
//
// THE ARGUMENT FOR IT, AND IT IS THE ONLY ONE. Every other reading in this toolkit rides on a turn
// the lead was having anyway and costs nothing — the size of a conversation, how long somebody has
// been quiet, where the account stands. That is why "no sweep, no timer, nothing to clear" is the
// right rule for all of them, and it stays the right rule for all of them. It is wrong for exactly
// one case: the lead nobody has typed to for an hour is the lead that most needs to act, and it is
// precisely the lead that will have no turn to ride on. The readings are free when they are not
// needed and unavailable when they are. If that does not hold, none of this should exist.
//
// WHAT IT IS NOT. It hands nobody over, it hands the lead over least of all, it refuses no message,
// it hires and retires nobody, and it ends no conversation of its own. Handing a session over is a
// press on that session's panel and there is no tool for it — deliberately, because two mechanisms
// for one concern is the thing this whole area is built to avoid. All this does is spend one turn
// telling the lead what a room it cannot see has just become.
//
// ON THE TRANSITION, NEVER ON THE CONDITION. The failure that rule exists for is written down in
// pop.mjs: a page asks what is parked once a second, and a doorbell driven off that answer would go
// up sixty times a minute for one stopped session. So this holds a map of the band each name was
// last seen in, and it names a session only when its band CHANGED into a strong one since the last
// read. A session sitting at ninety per cent for two hours is said once.
//
// IN MEMORY AND NOT IN A FILE, for offline.mjs's reason. What a session has not been told yet is
// held in the process, because a chat stopped and started again has told nobody anything — so
// saying it once more after a restart is correct rather than a duplicate. Nothing here survives the
// chat, and there is nothing to clean up when it goes.

import { shareSaid } from "./room.mjs";
import { bandIn, hasGoneCold } from "./session.mjs";

// How often the room is read when the instance does not say. Five minutes, and it is a JUDGMENT
// rather than a measurement — the same honesty the bands are written with. It is short enough that
// a crossing is said while something can still be done about it and long enough that a room where
// nothing is happening costs nothing at all, which it does: a tick that finds no crossing starts no
// run and writes nothing.
const EVERY = 5 * 60 * 1000;

// How often this workspace wants its room read, as it writes it in its own description of itself.
// Absent from most of them, which means five minutes.
//
// AN INSTANCE'S FIELD, and not a constant, because this is the one reading in the toolkit that
// SPENDS. Every other one rides on a turn the lead was having anyway; this one starts a turn nobody
// asked for, and a run costs money. A workspace that does not buy the argument for that has to be
// able to say so without declining the version it came in, and `0` is how it says so.
//
// ABSENT IS FIVE MINUTES AND NOT NEVER, deliberately. A feature switched off in every workspace is
// one nobody meets, and the person who would have to know to switch it on is exactly the person the
// argument is about: the one who has not typed to their lead for an hour. If five minutes is the
// wrong default the answer is to take the tick out, not to ship it dark.
//
// THE UNIT IS IN THE NAME. A bare `watchEvery: 300` is ambiguous between seconds and milliseconds in
// a file somebody hand-writes, and it fails silent in both directions — a five-minute tick where a
// third of a second was meant, or the reverse. Seconds also give the floor for nothing: a
// millisecond field admits `1`, which is a spin, and a whole number of seconds cannot say it.
export const WATCH_EVERY = "watchEverySeconds";

// What is wrong with a cadence, in the words somebody can act on, or nothing at all when there is
// nothing wrong with it. Absent is not wrong: most workspaces have no such field and every one of
// them reads its room every five minutes.
//
// It names the field, because the person reading this is looking at a file with a dozen things in
// it and the sentence has to say which one to go and change.
export function watchEveryProblem(seconds) {
  if (seconds === undefined || seconds === null) {
    return null;
  }
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0) {
    return `${WATCH_EVERY} is ${JSON.stringify(seconds)}, which is not a cadence — it is a whole number of seconds, like 300, or 0 for never`;
  }
  return null;
}

// How long to wait between reads, or nothing at all when this workspace has asked for none.
//
// `0` IS NOT ABSENT. They are opposite facts — one is a workspace that has said it does not want
// its room read and the other is one that has not said anything — and a reader that folded them
// together would give the tick back to the only person who took the trouble to turn it off.
export function howOften(config) {
  const said = config?.[WATCH_EVERY];
  if (said === 0) {
    return null;
  }
  return typeof said === "number" ? said * 1000 : EVERY;
}

// What each name was last seen to be, and the whole of what makes this fire on a transition. One
// entry per session that has been read, holding the band it was in and whether its conversation had
// gone cold — the two things a crossing can be into.
//
// Keyed by name alone, for turns.mjs's reason: one of these serves one instance, because the process
// running it IS that instance's chat.
const seen = new Map();

// Everything the room has just BECOME, as a list of things worth a turn, or nothing.
//
// STRONG, and only these, because a turn nobody asked for is a run the account pays for:
//
//   a band of 0.90 or 0.95, newly entered
//   a conversation newly gone cold
//
// Everything weaker — 0.80, 0.85, and a session merely gone quiet — buys no turn. It rides on the
// blocks the lead is handed the next time it is spoken to, exactly as it does today.
//
// The judgment is one sentence long: a turn is spent only where the thing about to be lost is
// larger than the turn. A conversation at ninety per cent of its window is two turns from losing
// whatever its desk does not say; one at eighty is not.
//
// The map is written whether or not anything is returned, and that is what bounds the cost: a
// crossing is entered once, so at most one turn is spent per session per crossing, and a workspace
// where nothing crosses spends nothing at all.
//
// A name that has gone from the roster is dropped, so a desk that is opened again under a recycled
// name is read fresh rather than against whatever the last person there was carrying.
export function whatChanged(instance, room) {
  const strong = [];

  for (const session of room) {
    const band = bandIn(instance.root, session.name);
    const cold = hasGoneCold(instance.root, session.name);
    const was = seen.get(session.name) ?? { band: null, cold: false };

    // Into a strong band, and not merely still in one. A session that was already at 0.95 and is
    // read at 0.95 again has crossed nothing.
    if (band !== null && band.strong && band.named !== was.band) {
      strong.push({ name: session.name, band, context: session.context, window: session.window });
    }
    // And newly cold, which is the other half. It is worth a turn for the reason the hour exists at
    // all: the next message to it ends that conversation and begins a new one from the desk, and
    // whatever it never wrote down goes with it.
    if (cold && !was.cold) {
      strong.push({ name: session.name, cold: true });
    }

    seen.set(session.name, { band: band === null ? null : band.named, cold });
  }

  const here = new Set(room.map((session) => session.name));
  for (const name of [...seen.keys()]) {
    if (!here.has(name)) {
      seen.delete(name);
    }
  }

  return strong;
}

// Forget the whole room. Called where the chat closes, so that nothing here outlives the process
// that owns it, and so that a suite starting a second chat in one process is not answered out of
// the first one's memory.
export function forgetTheRoom() {
  seen.clear();
}

// What the lead is told, in the shape every pushed block in this toolkit has.
//
// It says who is speaking, for the reason all of them do: an update ships new templates and
// re-renders nobody's persona, so a session reading this may be running one written before any of
// it existed and has nothing to look it up in. It carries the moment it was read, because an undated
// line handed to somebody unasked reads as now. And it says what can be done about it, which is
// nothing this can do alone — that is not a hedge, it is the state of the toolkit.
//
// The lead is in its own list and in the second person, for sizeWrapper's reason: it is the reader,
// it is the one that cannot press its own button, and a block naming everybody except the session
// that most needs handing over would be the worst reading this could give.
export function watchWrapper(instance, leader, changed, said) {
  const each = changed.map((one) => {
    const yours = one.name === leader;
    if (one.cold === true) {
      return yours
        ? "your own conversation has gone cold, so the next thing said to you ends it and begins a new one from your desk"
        : `${one.name} has gone cold, so the next thing said to it ends that conversation and begins a new one from its desk`;
    }
    // The share said off the reading the room was read with, in the wording the row and the size
    // block already say it in: a sentence carrying its own copy of a number, or its own copy of a
    // phrasing, is a second place for one fact to be said two ways.
    const held = `${one.context.toLocaleString("en-US")} tokens, ${shareSaid(one.context, one.window)}`;
    return yours
      ? `you have reached ${held}`
      : `${one.name} has reached ${held}`;
  });

  return [
    "<watch>",
    "The chat is telling you this. Nobody typed it.",
    `${each.join(", and ")}. Read at ${said}, and nobody asked for this turn — the room changed while you were not being spoken to.`,
    `Handing a session over is ${instance.config.human}'s to press, on that session's panel. Yours included. Say which panels and why. Nothing here does it for you: nothing has stopped running and no conversation has been ended by this.`,
    "</watch>",
  ].join("\n\n");
}
