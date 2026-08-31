// The conversation: an append-only list of messages kept in a file inside the instance.
//
// A file rather than memory, so that stopping the server and starting it again does not
// throw the conversation away. One file rather than a database, because a conversation is
// small and being able to read it with cat is worth more here than anything a database adds.

import fs from "node:fs";
import path from "node:path";

const FILE = path.join("chat", "conversation.json");

function file(root) {
  return path.join(root, FILE);
}

export function read(root) {
  try {
    return JSON.parse(fs.readFileSync(file(root), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function append(root, message) {
  const messages = read(root);
  const entry = { at: new Date().toISOString(), ...message };
  messages.push(entry);

  const target = file(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(messages, null, 2)}\n`);
  return entry;
}
