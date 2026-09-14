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

import { conversationFile as file } from "../desks.mjs";
import { publish } from "./events.mjs";

// Who a line in a transcript is from when it is not from anybody: the chat saying what became of
// a message. It has a space in it, so no session can ever be called this — a name is a directory
// under desks/ and cannot hold one.
//
// Here rather than beside the first thing that writes one, because it is a property of a
// conversation and there is now more than one module that has something to say in it. Two copies
// of a name are two things to keep in step.
export const THE_CHAT = "the chat";

// The file a session's panel is kept in: inside that person's desk directory, with the desk and
// the persona, so that everything the instance holds about somebody is one directory and filing
// them away is moving it. Where it is is the desk module's word (`conversationFile`), not this
// one's, because that module is what says what a person is made of.
export function panelFile(root, session) {
  return file(root, session);
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
  // The page is told the row and where it sits, so a panel appends rather than re-reads.
  publish("row", { seat: session, index: messages.length - 1, row: entry });
  return entry;
}

// A tool call whose result came back as an error, after its line was written: the entry is marked
// in place, so a page that loads later draws the line red from the start, and the page that is
// open is told the row again at its index. A call that drew no line — one the summary says
// nothing about — is the usual case, and nothing.
export function amend(root, session, call) {
  const messages = read(root, session);
  const index = messages.findLastIndex((entry) => entry.call === call);
  if (index === -1) {
    return null;
  }
  messages[index].err = true;
  fs.writeFileSync(file(root, session), `${JSON.stringify(messages, null, 2)}\n`);
  publish("row", { seat: session, index, row: messages[index] });
  return messages[index];
}
