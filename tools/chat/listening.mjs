// Where the chat is listening, written down.
//
// An instance is normally installed with --port 0, which is a request rather than a port: the
// address exists only once the server has bound one, and nothing outside that process can work
// it out. So the server writes it down, and anything in the instance that needs to reach the chat
// reads it here: the commands, and the configuration a session is started with, which carries the
// address of that session's own tools. This file is the one place a running address lives.
//
// Nothing removes it. A chat that was killed leaves an address that answers nothing, and a
// reader finds that out by trying: a refused connection is the truth, where a file that was
// tidied up on the way out would only be the truth when the way out was graceful.

import fs from "node:fs";
import path from "node:path";

const FILE = "listening.json";

// A workspace is one person's machine, and a chat that can drive a Claude Code session is not
// something to put on a network by accident. Both the binding and the address read back come
// from here, so there is one answer to where the chat is.
export const HOST = "127.0.0.1";

function file(root) {
  return path.join(root, "chat", FILE);
}

// The pid is there for somebody looking at a workspace that is misbehaving: it says which
// process to look at, and which to stop. Nothing here reads it back.
export function record(root, port) {
  const target = file(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `${JSON.stringify({ url: `http://${HOST}:${port}`, pid: process.pid, since: new Date().toISOString() }, null, 2)}\n`,
  );
  return target;
}

// The address of the chat serving this instance, or null when none has recorded one. Anything
// unreadable answers null too: a caller that cannot find the chat says the same thing either
// way, and a half-written file is not worth a different sentence.
export function listening(root) {
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(file(root), "utf8"));
  } catch {
    return null;
  }

  return typeof recorded?.url === "string" && recorded.url !== "" ? recorded.url : null;
}
