// The room watch: the one thing in this toolkit whose input is the clock.
//
// THE ARGUMENT FOR IT, AND IT IS THE ONLY ONE. Every other reading in this toolkit rides on a turn
// the lead was having anyway and costs nothing — the size of a conversation, how long somebody has
// been quiet, where the account stands. That is why "no sweep, no timer, nothing to clear" is the
// right rule for all of them, and it stays the right rule for all of them. It is wrong for exactly
// one case: the room nobody has typed into for an hour is the room that most needs something done
// about it, and that is precisely when there is no turn to ride on. The readings are free when they
// are not needed and unavailable when they are. If that does not hold, none of this should exist.
//
// AND IT NO LONGER BUYS A TURN TO SAY SO. What this used to do was hand the lead a block and leave
// the acting to it. That spent a run nobody asked for, at the one moment the account is most likely
// to be spent — and it reached nobody at all whenever the room was off, which is exactly when a
// strong band gets crossed. What happens now is that the pass acts on the session concerned and
// leaves a line: the panel for the person, and the debt in overheard.mjs for the lead's model, on
// the next turn the lead takes for its own reasons. Both are a map write or a file append. Neither
// starts a run.
//
// WHAT IT IS NOT. It hires and retires nobody, it refuses no message, and it takes no room off.
// Handing a session over is still a press on that session's panel. The one conversation the pass
// ends is one that could not have been carried on anyway, and server.mjs says why where it does it.
//
// ON THE TRANSITION, NEVER ON THE CONDITION — for what is only ANNOUNCED. The failure that rule
// exists for is written down in pop.mjs: a page asks what is parked once a second, and a doorbell
// driven off that answer would go up sixty times a minute for one stopped session. So this holds a
// map of the band each name was last seen in, and it names a session only when its band CHANGED
// into a strong one since the last read. A session sitting at ninety per cent for two hours is
// said once.
//
// ON THE CONDITION, NEVER ON THE TRANSITION — for what is ACTED ON, and it needs no map at all. A
// condition that is acted on is cleared BY the act: the pass reads a cold conversation, ends it,
// and there is no longer a cold conversation to read. Remembering that one had been seen would be
// a second record of a fact the tree already holds, and it would be the record that goes wrong —
// held across an act that never happened, it is the "handled" that handled nothing.
//
// IN MEMORY AND NOT IN A FILE, for offline.mjs's reason. What a session has not been told yet is
// held in the process, because a chat stopped and started again has told nobody anything — so
// saying it once more after a restart is correct rather than a duplicate. Nothing here survives the
// chat, and there is nothing to clean up when it goes.

import { bandIn } from "./session.mjs";

// How often the room is read when the instance does not say. Five minutes, and it is a JUDGMENT
// rather than a measurement — the same honesty the bands are written with. It is short enough that
// a crossing is said while something can still be done about it and long enough that a room where
// nothing is happening costs nothing at all, which it does: a tick that finds nothing starts no run
// and writes nothing.
const EVERY = 5 * 60 * 1000;

// How often this workspace wants its room read, as it writes it in its own description of itself.
// Absent from most of them, which means five minutes.
//
// AN INSTANCE'S FIELD, and not a constant, because a tick is a thing a workspace is entitled to
// have an opinion about: it decides how soon a conversation nobody is carrying on is ended, and how
// soon a room that has changed is said to have changed. A workspace that wants neither has to be
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

// How long to wait between reads. ALWAYS A NUMBER, because the room is always read.
//
// `0` IS NOT ABSENT, AND IT IS NOT SILENCE EITHER. It is a workspace saying "do not spend a turn on
// me", which is the whole of what the field was ever documented to mean — and the reading, the
// ending of a conversation nobody can carry on, and the line on a panel all spend nothing. A `0`
// that switched those off would be a field that said one thing and did a larger one, and the larger
// one arrives silently: nobody who wrote `0` to decline a run asked to have their conversations
// stopped being managed.
//
// So the cadence a `0` workspace is read at is the default, exactly as an absent field is. What `0`
// buys is asked separately, by whatever is about to spend, and never here.
export function howOften(config) {
  const said = config?.[WATCH_EVERY];
  if (typeof said !== "number" || said === 0) {
    return EVERY;
  }
  return said * 1000;
}

// Whether a pass may spend a turn on this workspace, which is the half of the field `howOften`
// above says it does not answer. `0` and nothing else: a workspace that wrote it declined a run, not
// a reading, and every other value — absent, malformed, a cadence — declined nothing.
//
// ASKED BY WHATEVER IS ABOUT TO SPEND, at the moment it is about to, and by nothing that only reads
// or only writes a line. The first thing that spends is handing a session over on where the account
// stands — a turn on that session, to write its desk — and it arrived with this rather than before
// it, because a gate with nothing behind it is a promise about code that does not exist yet.
export function buysATurn(config) {
  return config?.[WATCH_EVERY] !== 0;
}

// What band each name was last seen in — the whole of what makes an announcement fire on a
// transition — and nothing else. One entry per session that has been read, holding the band's name
// or nothing at all for a session that is in none.
//
// Keyed by name alone, for turns.mjs's reason: one of these serves one instance, because the
// process running it IS that instance's chat.
const seen = new Map();

// Every band the room has just ENTERED that is worth a line, or nothing.
//
// STRONG, and only these: a band of 0.90 or 0.95, newly entered. Everything weaker — 0.80, 0.85 —
// says nothing here. It rides on the blocks the lead is handed the next time it is spoken to,
// exactly as it does today. The line is free now, which weakens the old argument for the cut but
// does not remove it: a line that arrives for every band is a line nobody reads by the third one,
// and what is being protected is the lead's attention rather than the lead's account.
//
// NOTHING IS RECORDED HERE FOR A SESSION THAT CROSSED, and that is the invariant rather than an
// implementation detail: a crossing is entered against a name only once the line saying it has
// actually been written. A pass that read a crossing and then could not say it — because it fell
// over, because the process went down between the read and the write — must find that crossing
// still there next pass, not a map claiming it was said. Recording it here would be the same
// mistake as a state that says "handled" when nothing handled it, and the caller closes it by
// calling nowSeen() once the line is on the panel.
//
// A session with nothing to say IS recorded here, immediately, because nothing is owed on it: it
// crossed nothing, no line is going to be written about it, and there is no act whose return could
// be waited for. Holding that back would be a debt against no creditor.
//
// A name that has gone from the roster is dropped, so a desk that is opened again under a recycled
// name is read fresh rather than against whatever the last person there was carrying.
export function whatChanged(instance, room) {
  const crossed = [];

  for (const session of room) {
    const band = bandIn(instance.root, session.name);
    const named = band === null ? null : band.named;

    // Into a strong band, and not merely still in one. A session that was already at 0.95 and is
    // read at 0.95 again has crossed nothing.
    if (band !== null && band.strong && named !== (seen.get(session.name) ?? null)) {
      crossed.push({ name: session.name, band, context: session.context, window: session.window });
      continue;
    }
    seen.set(session.name, named);
  }

  const here = new Set(room.map((session) => session.name));
  for (const name of [...seen.keys()]) {
    if (!here.has(name)) {
      seen.delete(name);
    }
  }

  return crossed;
}

// This crossing has been said, so the name has been seen in that band.
//
// EXACTLY THE BAND THAT WAS SAID, handed back rather than read again. Reading `bandIn` a second
// time here would record whatever the session happens to be in at this instant, which is not what
// the line on the panel claims — and on a session that grew between the two reads it would enter a
// band nobody was ever told about and swallow the next crossing. This is overheard.mjs's rule on a
// different channel: what is cleared is what was carried.
export function nowSeen(name, band) {
  seen.set(name, band === null ? null : band.named);
}

// That the pass happened, and almost nothing about what it found.
//
// ONE OBJECT, REPLACED EACH PASS, IN MEMORY. Never appended to and never written to disk, for the
// reason `seen` is not either: this is a reading about a running process and a chat that has been
// started again has had no passes. A file would also be the one thing this feature is not allowed
// to grow — something to clean up.
//
// COUNTS AND NOT NAMES. Names would be a log, and a log is a thing to grow, to rotate and to argue
// about the retention of. What a reader needs from here is whether the pass is alive at all; what
// it decided is on the panels, which is where the durable record belongs.
//
// `armedAt` IS NOT DECORATION, and it is the state a reading built on `at` alone gets wrong. A
// timer that has been armed and has not yet fired has no `at` for up to a whole cadence — five
// minutes by default, longer where the instance says so — and that is every restart of the chat,
// which is the documented repair for a stale server. Without `armedAt` a healthy boot is
// indistinguishable from a watch that was armed and died on arrival, and a liveness reading that
// cries fault every time somebody restarts the chat is worse than none at all.
//
// It is a TIMESTAMP AND NOT A HEALTH INDICATOR. There is no threshold here and no colour: "older
// than about two cadences" is a judgment, the cadence belongs to the instance, and both belong to
// whoever is reading rather than to this.
let record = null;

// The timer has been armed. Called where it is armed and nowhere else, so that "no record at all"
// keeps its own meaning: a chat that armed nothing, which is a workspace that asked for no watch
// and a `serve()` that never got as far as arming, and those are told apart by the config rather
// than by guessing here.
export function armTheWatch() {
  record = { armedAt: Date.now(), at: null, sessions: 0, decided: 0, acted: 0 };
}

// A pass finished. `sessions` is how many it read, `decided` how many of them it found something
// to do about, and `acted` how many of those the act actually returned on — which are three
// different numbers on the pass where the room was off, and the gap between the last two is the
// only thing that says so.
export function tickRead({ sessions, decided, acted }) {
  if (record === null) {
    return;
  }
  record = { ...record, at: Date.now(), sessions, decided, acted };
}

// What is known about the watch of this chat, or nothing at all when none was armed.
//
// A copy, so that a reader is holding what it read and not something a pass can move underneath it.
export function theWatchRecord() {
  return record === null ? null : { ...record };
}

// Forget the whole room. Called where the chat closes, so that nothing here outlives the process
// that owns it, and so that a suite starting a second chat in one process is not answered out of
// the first one's memory. The record goes with it for the same reason and one more: a record left
// behind would say a watch was armed for a server that has been closed.
export function forgetTheRoom() {
  seen.clear();
  record = null;
}
