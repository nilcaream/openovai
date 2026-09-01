// The instance's own settings file.
//
// One file, `.claude/settings.json` under the instance root, holding what the instance lets its
// sessions do and — since sessions read instructions from wherever they are started — what it
// keeps out of them. More than one thing writes it: opening a desk grants that desk, starting
// the chat says which instructions above the instance are not to be read. So reading it,
// changing what is ours and writing the rest back untouched lives here, once, rather than in
// every caller that has something to put in it.
//
// The path is relative because it means the instance root to Claude Code, which is started with
// the root as its working directory. It keeps the instance free of absolute paths, so moving one
// does not cost a session its hands.

import fs from "node:fs";
import path from "node:path";

export const SETTINGS_FILE = path.join(".claude", "settings.json");

export function settingsFile(root) {
  return path.join(root, SETTINGS_FILE);
}

// What is in the file now. A file that is not there, or one nothing can parse, reads as an empty
// settings object: writing a fresh one is better than refusing to grant anything over it.
export function readSettings(root) {
  let read;
  try {
    read = JSON.parse(fs.readFileSync(settingsFile(root), "utf8"));
  } catch {
    return {};
  }
  return typeof read === "object" && read !== null && !Array.isArray(read) ? read : {};
}

// Write the whole file back. Answers with what it wrote, the way everything else that puts a file
// in an instance does, so a caller can say so.
export function writeSettings(root, settings) {
  const target = settingsFile(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
  return [target];
}
