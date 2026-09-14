// Where the server is running, written down: `runtime.json` at the instance root — and what it
// said while running, `runtime.log` beside it.
//
// An instance is normally installed with --port 0, which is a request rather than a port: the
// address exists only once the server has bound one, and nothing outside that process can work
// it out. So the server writes it down, and anything in the instance that needs to reach the chat
// reads it here: the commands, and the configuration a session is started with, which carries the
// address of that session's own tools. This file is the one place a running address lives. It is at
// the root beside `openovai.json`, because the two are the instance's own account of itself: what
// it is, and what of it is running now.
//
// Nothing removes it. A server that was killed leaves an address that answers nothing, and a
// reader finds that out by trying: a refused connection is the truth, where a file that was
// tidied up on the way out would only be the truth when the way out was graceful.

import fs from "node:fs";
import path from "node:path";

export const RUNTIME_FILE = "runtime.json";

// What the server process says, from the moment `ovai start` starts it: one file per run,
// written over at the next start, so what is in it is always the last run's account of itself.
export const LOG_FILE = "runtime.log";

// A workspace is one person's machine, and a chat that can drive a Claude Code session is not
// something to put on a network by accident. Both the binding and the address read back come
// from here, so there is one answer to where the chat is.
export const HOST = "127.0.0.1";

function file(root) {
  return path.join(root, RUNTIME_FILE);
}

export function logFile(root) {
  return path.join(root, LOG_FILE);
}

// The pid says which process wrote this: `ovai start` waits for the record its own child wrote
// and not for one an earlier run left, and somebody looking at a misbehaving workspace knows
// which process to look at, and which to stop.
export function record(root, port) {
  const target = file(root);
  fs.writeFileSync(
    target,
    `${JSON.stringify({ url: `http://${HOST}:${port}`, pid: process.pid, since: new Date().toISOString() }, null, 2)}\n`,
  );
  return target;
}

// The record as written — { url, pid, since } — or null when there is none worth reading.
// Anything unreadable answers null too: a caller that cannot find the server says the same thing
// either way, and a half-written file is not worth a different sentence.
export function recorded(root) {
  let read;
  try {
    read = JSON.parse(fs.readFileSync(file(root), "utf8"));
  } catch {
    return null;
  }

  return typeof read?.url === "string" && read.url !== "" ? read : null;
}

// The address of the server serving this instance, or null when none has recorded one.
export function listening(root) {
  return recorded(root)?.url ?? null;
}
