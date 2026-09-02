// What the lead has not been told yet, kept where a restart cannot lose it.
//
// The other queue in this directory — overheard.mjs — is in memory on purpose: it holds what a
// session has not heard YET, and a chat stopped and started again has nobody waiting to be told.
// This one is the opposite case and needs the opposite answer. An update is precisely the thing
// that stops the chat, and what it has to say survives that or is never said at all.
//
// It holds FACTS and no wrapper text. The server is the only thing that writes a wrapper, and that
// is what makes "anything outside a wrapper is the human speaking" true by construction — so a note
// written here by a command outside the chat says what happened, and the chat decides how a session
// is told about it.

import fs from "node:fs";
import path from "node:path";

const FILE = "untold.json";

function file(root) {
  return path.join(root, "chat", FILE);
}

// Something happened to this instance that the lead is going to want to know. Written where the
// chat looks, not handed to anybody: whoever calls this may be running while no chat is.
export function leaveWord(root, note) {
  const target = file(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(note, null, 2)}\n`);
  return target;
}

// What has not been told yet, and it has now been told. Read and deleted in one, because a note
// left behind is one the lead would be handed again every time the chat started — and a session
// told twice that the toolkit under it changed has no way of knowing it was the same change.
//
// Nothing here if there is nothing to say, which is the ordinary case: every chat that starts asks
// this and almost none of them find anything.
export function takeWord(root) {
  const target = file(root);
  let said;
  try {
    said = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  // Deleted before it is read for meaning, so a note nothing can make sense of is a chat that
  // fails once rather than a chat that cannot be started again.
  fs.rmSync(target, { force: true });
  return JSON.parse(said);
}
