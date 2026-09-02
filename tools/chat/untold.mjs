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
