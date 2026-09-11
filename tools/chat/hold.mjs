// The account hold: the record that the account is at its stop line, and what was done about it.
//
// A FILE, beside the address the chat leaves behind, for the reason `offline.mjs` gives when it
// argues the other way about the room being off: the word an update leaves behind is a file,
// because an update is precisely the thing that stops the chat. An account hold is that kind more
// plainly than the room being off is — an update does not refill the account. Held in memory, a
// restart in the middle of a quota cut would forget it, and the next pass would read a room with
// no readings left and no record of why, and park it a second time on the account that is
// stopping. Nothing here is a second record of a fact the tree already holds: the readings say
// where the account stood, and this says what was decided on them, which the readings cannot say
// because parking destroys them.
//
// LATCHED ON A MOMENT, NEVER ON THE ABSENCE OF A READING. Where the account stands is folded out
// of each session's own file, and a park ends by removing that file, so a hold that waited for the
// readings to clear would be released the instant the first park destroyed its own evidence — not
// because the account recovered but because nothing was left to say it had not. So the hold
// carries the moment its window lifts and stands until that moment passes. The one hold with no
// moment is the one the account gave none for, and that one parks nobody, so its readings keep
// arriving and it is re-decided from them on every pass: that exit exists in that branch and in
// no other, and the asymmetry is the point.
//
// ONE PARK PER SEAT PER HOLD. The hold remembers which seats it has parked, so a seat that was
// handed over and then spoken to again inside the same window is not handed over a second time —
// a park is entered once per window, not once per thread. A seat whose park the service turned
// away is NOT in that list: it is tried again on the next pass for as long as the seat is warm,
// because a refused park latched as done is a seat that is never parked at all.
import fs from "node:fs";
import path from "node:path";

const FILE = "hold.json";

function file(root) {
  return path.join(root, "chat", FILE);
}

// The hold as it stands on disk, or nothing at all. Reading it decides nothing — an ended hold is
// still handed back, because the pass that finds it ended is the one that says so and removes it.
export function holdIn(root) {
  let held;
  try {
    held = JSON.parse(fs.readFileSync(file(root), "utf8"));
  } catch {
    return null;
  }
  if (held === null || typeof held !== "object" || typeof held.since !== "string") {
    return null;
  }
  return {
    since: held.since,
    resetsAt: typeof held.resetsAt === "number" ? held.resetsAt : null,
    fullness: typeof held.fullness === "number" ? held.fullness : null,
    parking: held.parking === true,
    parked: Array.isArray(held.parked) ? held.parked.filter((name) => typeof name === "string") : [],
  };
}

// Enter a hold, on a reading. Written whole, and written over whatever stood there: a hold with no
// moment is re-decided from a later reading, and that is the one case this is called on a hold
// that already stands.
export function enterHold(root, { resetsAt, fullness, parking }) {
  const target = file(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const held = {
    since: new Date().toISOString(),
    resetsAt: typeof resetsAt === "number" ? resetsAt : null,
    fullness,
    parking: parking === true,
    parked: [],
  };
  fs.writeFileSync(target, `${JSON.stringify(held, null, 2)}\n`);
  return held;
}

// A seat was parked under this hold. Read back and written whole, so that what is on disk is the
// list as it is and not as a caller remembered it.
export function markParked(root, name) {
  const held = holdIn(root);
  if (held === null || held.parked.includes(name)) {
    return;
  }
  fs.writeFileSync(file(root), `${JSON.stringify({ ...held, parked: [...held.parked, name] }, null, 2)}\n`);
}

// The hold is over. Removing the file is the whole of it; there is nothing to say and nowhere to
// say it from here — whoever ends a hold says so where a pass says things.
export function endHold(root) {
  fs.rmSync(file(root), { force: true });
}

// Whether this hold's window has lifted. A hold with no moment never has, by this test — it ends
// the other way, when a later reading no longer says the account is stopping.
export function holdLifted(hold) {
  return hold.resetsAt !== null && hold.resetsAt * 1000 <= Date.now();
}

// Whether THIS hold still stands: the one on disk is the same one, and it has not lifted. Asked
// inside a park's turn, which may run long after the pass that decided it — behind whatever was
// queued on that seat — by which time the window may have lifted and parking would spend the new
// window to save nothing.
export function holdStands(root, hold) {
  const now = holdIn(root);
  return now !== null && now.since === hold.since && !holdLifted(now);
}
