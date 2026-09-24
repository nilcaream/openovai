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
import { mask } from "../mask.mjs";
import { publish } from "./events.mjs";

// The fields of a row that carry what a session or the User said — a reply, a tool call's line with
// its Bash command whole, a tool error's reason. They are masked as the row is made, so the file
// and the row the page is told are the same masked row; nothing unmasked is kept to show later.
const SAID = ["text", "line", "why"];

function masked(message) {
  const row = { ...message };
  for (const field of SAID) {
    if (typeof row[field] === "string") {
      row[field] = mask(row[field]);
    }
  }
  return row;
}

// Who a line in a transcript is from when it is not from anybody: the server saying what became
// of a message. It is the word a person reads on the panel, so it is capitalised like a name; a
// seat is a directory under desks/ and nothing stops one from being called this too, so do not.
//
// Here rather than beside the first thing that writes one, because it is a property of a
// conversation and there is now more than one module that has something to say in it. Two copies
// of a name are two things to keep in step.
export const SERVER = "Server";

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

// Answers the index the entry sits at, which is how a later write finds it again.
export function append(root, session, message) {
  const messages = read(root, session);
  const entry = { at: new Date().toISOString(), ...masked(message) };
  messages.push(entry);

  const target = file(root, session);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(messages, null, 2)}\n`);
  // The page is told the row and where it sits, so a panel appends rather than re-reads.
  publish("row", { seat: session, index: messages.length - 1, row: entry });
  return messages.length - 1;
}

// A row the User typed, once the frame it became was written to the process: the entry at that
// index is marked in place and the page is told the row again, so the status on it goes from
// waiting to delivered — and a page that loads later draws it delivered from the start. Nothing
// happens for an index the conversation has not got. The time of the write goes with it, so a row
// that waited behind a turn can say when it went in.
export function delivered(root, session, index) {
  const messages = read(root, session);
  if (messages[index] === undefined) {
    return null;
  }
  messages[index].delivered = true;
  messages[index].deliveredAt = new Date().toISOString();
  fs.writeFileSync(file(root, session), `${JSON.stringify(messages, null, 2)}\n`);
  publish("row", { seat: session, index, row: messages[index] });
  return messages[index];
}

// A turn that failed in the words it had already said — a run that cannot go on says why as text
// and then results in the same text as an error: the row those words landed as is marked failed
// in place and the page is told it again, rather than the same words appended a second time. The
// row has to be the last thing the session said, word for word, and not marked yet; anything else
// answers null and the caller appends. Written for the failed ending only: a turn that ends well
// results in what it said too, and that row stays as it landed. The row was masked as it landed,
// so the words are masked before they are compared.
export function failedAsSaid(root, session, text) {
  const messages = read(root, session);
  const index = messages.findLastIndex((entry) => entry.from === session);
  if (index === -1 || messages[index].text !== mask(text) || messages[index].failed !== undefined) {
    return null;
  }
  messages[index].failed = true;
  fs.writeFileSync(file(root, session), `${JSON.stringify(messages, null, 2)}\n`);
  publish("row", { seat: session, index, row: messages[index] });
  return messages[index];
}

// A tool call whose result came back as an error, after its line was written: the entry is marked
// in place, with the one line the result gave as the reason, so a page that loads later draws
// the line red from the start with the reason on it, and the page that is open is told the row
// again at its index. A call that drew no line — one the summary says nothing about — is the
// usual case, and nothing. A result that gave no reason marks the line and explains nothing.
export function amend(root, session, call, why = "") {
  const messages = read(root, session);
  const index = messages.findLastIndex((entry) => entry.call === call);
  if (index === -1) {
    return null;
  }
  messages[index].err = true;
  if (why !== "") {
    messages[index].why = mask(why);
  }
  fs.writeFileSync(file(root, session), `${JSON.stringify(messages, null, 2)}\n`);
  publish("row", { seat: session, index, row: messages[index] });
  return messages[index];
}
