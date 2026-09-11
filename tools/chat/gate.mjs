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
import { accountStanding } from "./session.mjs";

// Whether nothing new may be started right now, as the facts a refusal is worded from, or null
// when a spawn goes through. Facts and not a sentence, for `holdSaid`'s reason: the sentence is
// worded where the caller's other refusals are worded, in the reader's own hours.
//
// The reading is null below the plan line, so "there is a reading at all" is the whole of the
// test: `accountStanding` is written to answer nothing until there is something to plan around,
// and this asks it nothing more.
export function spawnHeld(instance) {
  const standing = accountStanding(instance);
  if (standing === null) {
    return null;
  }
  return { fullness: standing.fullness, window: standing.window, resetsAt: standing.resetsAt };
}
