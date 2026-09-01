// A session's conversation: an append-only list of messages kept in a file inside the instance.
//
// A file rather than memory, so that stopping the server and starting it again does not throw
// the conversation away. One file per session rather than one shared list, because a session's
// own directory is where somebody looking for what it said will look first, and because two
// sessions writing one file would have to agree on an order that nothing here needs.
//
// Files rather than a database, because a conversation is small and being able to read it with
// cat is worth more here than anything a database adds.

import fs from "node:fs";
import path from "node:path";

const FILE = "conversation.json";

function file(root, session) {
  return path.join(root, "chat", session, FILE);
}

export function read(root, session) {
  try {
    return JSON.parse(fs.readFileSync(file(root, session), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function append(root, session, message) {
  const messages = read(root, session);
  const entry = { at: new Date().toISOString(), ...message };
  messages.push(entry);

  const target = file(root, session);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(messages, null, 2)}\n`);
  return entry;
}
