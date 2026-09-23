// What admin mode leaves behind: `admin.json` at the instance root, written by `ovai claude` when
// the door closes and read by the server at its next start.
//
// The Leader has to know that admin mode ran, because a permission rule that moved changes what it
// may hand a Worker. The obvious way of telling it — a route on the running server — fails exactly
// when the server is not running, which is when admin work is likeliest. So nothing crosses a
// process boundary here but a file: the command leaves a record at the root, beside `runtime.json`
// and for the same reason, and the server hands it over at its next start. The delay is honest
// rather than merely convenient: a seat reads its configuration when it STARTS, so whatever the
// person changed does not reach anybody until the next start anyway — which is exactly the moment
// the Leader is told about it.
//
// What the record carries is when the session ended and which configuration files changed, by
// name. Not what is in them, not a diff, and not what it means: the name is what sends the Leader
// to read the file, and reading it is the Leader's job rather than this record's.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { HOME } from "./claude.mjs";
import { SETTINGS_FILE } from "./settings.mjs";

export const ADMIN_FILE = "admin.json";

// The configuration admin mode exists to change, named from the instance root: the two files the
// briefing sends the person to — `/mcp` and `/plugin` write the account's settings, `mcp add` at
// user scope writes the account's own record — the permission rules every seat in this instance
// obeys, and the project's MCP file. Claude Code's plugin directory is not among them: it is a
// tree and not a single readable path, and what an install records lands in the account's
// settings, which is here.
export const WATCHED = Object.freeze([path.join(HOME, "settings.json"), path.join(HOME, ".claude.json"), SETTINGS_FILE, ".mcp.json"]);

function file(root) {
  return path.join(root, ADMIN_FILE);
}

// What each watched file is right now: its contents hashed, or null where there is no such file.
// A hash and not a timestamp, so a file rewritten with exactly what it already said is not a
// change; a null and not an absence, so a file created and a file removed are both differences.
export function fingerprint(root) {
  const taken = {};
  for (const name of WATCHED) {
    try {
      taken[name] = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex");
    } catch {
      taken[name] = null;
    }
  }
  return taken;
}

// The names whose fingerprint differs, in the order `WATCHED` names them.
export function changedBetween(before, after) {
  return WATCHED.filter((name) => (before[name] ?? null) !== (after[name] ?? null));
}

// Written whether or not anything changed: that admin mode ran at all is the thing the Leader is
// owed, and an empty list is an answer rather than a reason to stay quiet.
export function record(root, { ended, changed }) {
  const target = file(root);
  fs.writeFileSync(target, `${JSON.stringify({ ended, changed }, null, 2)}\n`);
  return target;
}

// The record as written — { ended, changed } — or null when there is none worth reading. Anything
// unreadable answers null too, the way `runtime.mjs` does: a server with no notice to pass on and
// a server that found half a file say the same thing, and a half-written file is not worth a
// different sentence.
export function recorded(root) {
  let read;
  try {
    read = JSON.parse(fs.readFileSync(file(root), "utf8"));
  } catch {
    return null;
  }

  if (typeof read?.ended !== "string" || !Array.isArray(read?.changed)) {
    return null;
  }
  return { ended: read.ended, changed: read.changed.filter((name) => typeof name === "string") };
}

// Removed once the notice has really reached the Leader, and never before.
export function forget(root) {
  fs.rmSync(file(root), { force: true });
}
