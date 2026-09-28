// An instance is one person's: its desks, its conversations, its account and the keys its page is
// signed in with. The root and the Claude Code home under it are closed to everybody else, which is
// what keeps every file inside them private whatever mode it was written with; the files that hold
// an address or a key are written 0600 besides, for a root somebody opens up by hand.

import fs from "node:fs";
import path from "node:path";

import { HOME } from "./claude.mjs";

export const PRIVATE_DIRECTORY = 0o700;
export const PRIVATE_FILE = 0o600;

// Made private at install and again at every update, since an instance installed before this ran
// has its directories as the umask left them. A mode given to mkdir applies only to what it
// creates, so this is a chmod.
export function keepPrivate(root) {
  for (const directory of [root, path.join(root, HOME)]) {
    if (fs.existsSync(directory)) {
      fs.chmodSync(directory, PRIVATE_DIRECTORY);
    }
  }
}

// A file only its owner reads: written, and then its mode set, since the mode given to a write
// applies only when the write creates the file.
export function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: PRIVATE_FILE });
  fs.chmodSync(file, PRIVATE_FILE);
}
