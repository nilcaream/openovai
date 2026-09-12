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

// Where this session's panel is kept. Somebody putting a desk away files the panel with it, and
// the alternative — a second module that knows how a chat lays its directories out — is a word
// spelled in two places that would go wrong the day one of them changed.
// Who a line in a transcript is from when it is not from anybody: the chat saying what became of
// a message. It has a space in it, so no session can ever be called this — a name is a directory
// under work/ and cannot hold one.
//
// Here rather than beside the first thing that writes one, because it is a property of a
// conversation and there is now more than one module that has something to say in it. Two copies
// of a name are two things to keep in step.
export const THE_CHAT = "the chat";

export function panelFile(root, session) {
  return file(root, session);
}

// And the directory it is kept in, which is everything the server holds about this session: the
// panel and the persona it was last started with. Whoever frees a name has to know it is gone,
// and whoever opens a desk has to know it is not still here.
export function panelDirectory(root, session) {
  return path.dirname(file(root, session));
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
