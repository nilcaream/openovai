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
export function panelFile(root, session) {
  return file(root, session);
}

// And the directory it is kept in, which is everything the chat holds about this session: the
// panel, and the thread it resumes by id. Whoever frees a name has to know it is gone, and whoever
// opens a desk has to know it is not still here.
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

// When anything last happened on this panel, or nothing if nothing ever has.
//
// The file is rewritten whole on every message and every reply, so its modified time IS that
// moment — one stat, and nothing to parse. The entries carry their own stamps, but reading those
// means reading a conversation that is never trimmed, on every poll, to answer a question the
// filesystem has already answered.
//
// This clock and not the thread's. `chat/<Name>/session.json` is rewritten on every answer, so
// its time is when the session last RAN — but ending a thread deletes that file, so a session
// handed over ten seconds ago would read as having never done anything, at exactly the moment
// somebody is deciding what to do with it. This one survives a handover, exists for everybody who
// has ever been spoken to, and answers the question that was actually asked.
export function lastAt(root, session) {
  try {
    return new Date(fs.statSync(file(root, session)).mtimeMs).toISOString();
  } catch {
    return null;
  }
}
