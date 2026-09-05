// Whether anything may start a run right now.
//
// One boolean, for a room rather than for a person. It exists because of a measured morning: a
// workspace its owner believed was off was re-entered by something armed inside it, hours later,
// and paid the whole of a large conversation again at write price to say nothing. The thing that
// went wrong was not the stopping. It was that "off" was the END OF A HANDSHAKE — a run was asked
// to park, the account refused that run, and the intent went down with it — so the room was neither
// on nor off, and nothing said which.
//
// So the intent is a boolean that is SET, never negotiated. Taking the room off runs nothing, asks
// nobody, and cannot be turned away; bringing it back runs nothing either. There is no state
// between the two and no way to be half in one, which is the whole of what this file is for.
//
// It is not a mode, not a screen and not a word on anybody's row. What a session is doing and
// whether the room will start anything are different questions, and one word could not say both.
//
// KEPT IN THE PROCESS, deliberately, and the instance already owns the rule that decides this: what
// a session has not heard yet is a Map in memory, because a chat stopped and started again has
// nobody waiting to be told, while the word an update leaves behind is a file, because an update is
// precisely the thing that stops the chat. This is the first kind. Nothing about taking the room off
// stops the chat, and a chat that is not running starts nothing to be gated — the only thing that
// begins a run is a message, and the only thing that sends one is a person at a keyboard or a
// session that is itself mid-turn. A restarted chat has neither, so a file here would be a second
// record of one fact and the day the two disagreed the room would be confidently wrong about
// whether it was off.
let off = false;

// Whether anything may start a run. Read, never remembered by a caller: the answer is a moment's
// truth and a copy of it taken a line earlier is the beginning of two records again.
export function offline() {
  return off;
}

// Take the room off. Idempotent on purpose rather than by accident — a press that reports what it
// did rather than what it changed can be made twice by a person who did not see the first one land,
// and there is no state in which the second press is wrong.
export function goOffline() {
  off = true;
}

// And bring it back. This one is the exit, and the reason it is written as plainly as it is: an exit
// with a condition on it is an exit that some state does not have. There is nothing here to refuse
// with, nothing to wait for and nothing that can fail, so there is no room the room cannot come back
// from.
export function goOnline() {
  off = false;
}
