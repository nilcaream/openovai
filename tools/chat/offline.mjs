// Whether anything may start a run right now.
//
// One fact, for a room rather than for a person. It exists because of a measured morning: a
// workspace its owner believed was off was re-entered by something armed inside it, hours later,
// and paid the whole of a large conversation again at write price to say nothing. The thing that
// went wrong was not the stopping. It was that "off" was the END OF A HANDSHAKE — a run was asked
// to park, the account refused that run, and the intent went down with it — so the room was neither
// on nor off, and nothing said which.
//
// So the intent is SET, never negotiated. Taking the room off runs nothing, asks nobody, and cannot
// be turned away; bringing it back runs nothing either. There is no state between the two and no
// way to be half in one, which is the whole of what this file is for.
//
// It is not a mode, not a screen and not a word on anybody's row. What a session is doing and
// whether the room will start anything are different questions, and one word could not say both.
//
// A FILE, AND THE ONLY RECORD. `chat/offline`, an empty marker beside the hold: its existence is
// the fact and its content nothing. This once stood in the process, on the ground that a chat which
// is not running starts nothing to be gated, and the only thing that begins a run is a message from
// a person or from a session mid-turn — neither of which a restarted chat has. It has a third thing
// now: a watch on its own clock, armed the moment the chat comes up, and its first pass ends and
// parks whatever it finds. A person who took the room off and then restarted the chat — which
// taking a newer version does — had said a thing the next chat could not hear. So the word is left
// where the next chat reads it. What stays true is the argument against two records: the day a copy
// in memory and a file disagreed, the room would be confidently wrong about whether it was off. So
// there is no copy. Every question is put to the disk, and a press writes or removes the file, and
// nothing else reads or writes it.
//
// No field inside it, deliberately. Nothing reads one; the day the room's line wants "off since
// 14:02", the file grows a field and a reader together.
import fs from "node:fs";
import path from "node:path";

const FILE = "offline";

function file(root) {
  return path.join(root, "chat", FILE);
}

// Whether anything may start a run. Read, never remembered by a caller: the answer is a moment's
// truth and a copy of it taken a line earlier is the beginning of two records again.
export function offline(root) {
  return fs.existsSync(file(root));
}

// Take the room off. Idempotent on purpose rather than by accident — a press that reports what it
// did rather than what it changed can be made twice by a person who did not see the first one land,
// and there is no state in which the second press is wrong.
export function goOffline(root) {
  fs.mkdirSync(path.dirname(file(root)), { recursive: true });
  fs.writeFileSync(file(root), "");
}

// And bring it back. This one is the exit, and the reason it is written as plainly as it is: an exit
// with a condition on it is an exit that some state does not have. There is nothing here to refuse
// with, nothing to wait for and nothing that can fail, so there is no room the room cannot come back
// from.
export function goOnline(root) {
  fs.rmSync(file(root), { force: true });
}

// What the queue answers instead of a turn, while the room is off.
//
// A frozen constant compared by IDENTITY, never by shape. Every caller of the queue already returns
// an object of its own, and one of them could grow a field called `offline` on any day for a reason
// of its own — so a check on the shape would be a check that quietly stops holding. There is one of
// these and it is this one.
//
// It carries the same word the routes answer with, so the value a caller passes on is the value it
// was handed rather than one it wrote out again.
export const OFFLINE = Object.freeze({ offline: true });
