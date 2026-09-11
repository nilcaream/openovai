// The spawn-point gate: the one place the account's reading becomes a decision, and the only kind
// of decision it is allowed to become.
//
// WHAT IT GATES. Starting something that is not running yet — a desk being opened by the session
// that leads, a conversation being started from nothing by a colleague. That is all. Everything the
// account's reading was built NOT to change is still unchanged: a message is delivered, a turn is
// queued behind another, a session is handed over, a refusal is said, and a run already going runs
// to its end. A refused SPAWN costs nothing and loses nothing — the work is still asked for, a
// moment later, and the caller is told when. A refused TURN strands a conversation mid-thought,
// which is the failure the service does to us and the one nothing here may do to anybody.
//
// AND NEVER THE PERSON. What a person presses or types goes through, whatever the account reads:
// the reading exists for the person, and a chat that turned its owner's own button away on that
// reading would have stopped being an assistant. A person who starts something the account then
// refuses gets the account's own refusal, which is the truth rather than a guess of ours.
//
// FROM THE PLAN LINE, NOT THE STOP LINE. Above the plan line what is left has to be planned, and
// "start no new front and take nobody new on" is what the lead's own reading already tells it in
// words; this is that sentence with a mechanism behind it, so that it is true whether or not the
// lead reads it. Above the stop line the room watch takes over for what is already running, and
// this goes on refusing beside it — a spawn is no better an idea at ninety-six than at ninety-one.
//
// NOTHING IS SAID TO ANYBODY. A refusal here is the answer the caller gets to its own call, and
// that is all it is: no line on any panel, nothing for the lead's next turn, nothing for the
// person. The room watch spends nothing to read; this spends nothing to refuse. What is asked
// spends, and what is asked is refused before it is started.
//
// DECIDED ONCE, WHERE THE SPAWN IS ASKED FOR. A spawn let through is a run in flight, and a run in
// flight is never touched — so nothing re-reads the account inside the turn, and a reading that
// crosses the line while a run is going changes nothing about that run.
//
// THE HOLD BEFORE THE READINGS, and it is not a tidiness. Where the account stands is folded out of
// each session's own file, and a park ends by removing that file — so the moment the room watch has
// parked the room on an account that is stopping, there are no readings left, and a gate that read
// them alone would open desks and start conversations at exactly the instant the account was most
// spent: not because it recovered but because the parks destroyed what said otherwise. The hold is
// the record that survives a park, latched on the moment its window lifts, and while one stands the
// answer is no whatever the readings have left to say.
import { holdIn, holdLifted } from "./hold.mjs";
import { RULED_WINDOW, accountStanding } from "./session.mjs";

// Whether nothing new may be started right now, as the facts a refusal is worded from, or null
// when a spawn goes through. Facts and not a sentence, for `holdSaid`'s reason: the sentence is
// worded where the caller's other refusals are worded, in the reader's own hours.
//
// A hold that has lifted is read as no hold: the pass that removes it may not have run yet, and a
// spawn refused on a window that has already turned over would be refused on nothing. A hold with
// no moment never lifts by this test — it stands until a later reading no longer says the account
// is stopping, and the pass ends it then. The hold is always about the ruled window, because it is
// entered from the reading of it, so the window's name is the one the reading rules on.
//
// The reading is null below the plan line, so "there is a reading at all" is the whole of the
// second test: `accountStanding` is written to answer nothing until there is something to plan
// around, and this asks it nothing more.
// What a room under a hold says about this, and the one place the words are. The room's line used
// to say only what the hold DOES — hands everybody over, carries everybody — because a line saying
// no new work was being started would have been believed and, before this file, false. Now it is
// true, and it is true only because this file is consulted: so the sentence lives here, beside the
// mechanism, the two wordings that can import it do, the page copies it by hand and is held to
// the copy, and the check that reads the words is the check that watches the refusals. Words and
// mechanism ship together or not at all.
export const NO_NEW_WORK =
  "No new work is being started: for as long as this stands, the session that leads is refused a new desk and any conversation it would have to start from nothing, and only what a person starts goes through.";

export function spawnHeld(instance) {
  const hold = holdIn(instance.root);
  if (hold !== null && !holdLifted(hold)) {
    return { fullness: hold.fullness, window: RULED_WINDOW, resetsAt: hold.resetsAt };
  }
  const standing = accountStanding(instance);
  if (standing === null) {
    return null;
  }
  return { fullness: standing.fullness, window: standing.window, resetsAt: standing.resetsAt };
}
