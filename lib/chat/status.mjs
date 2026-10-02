// The Leader's status, on its panel: STATUS.md on the Leader's desk, where things stand for the
// User, shown as it stood when the Leader last said it is current — the text and the time of that
// confirmation always one pair, since the file is read at the confirmation and not after it. An
// edit the Leader has not confirmed changes nothing shown.
//
// Beside it, how many things have reached the Leader since: one for each child of a queue written
// to its process — a line of the User's, a message, a server event — counted at the write, so
// what waits in the queue has not reached it yet. The page reads the label off that count and the
// Leader's state (panels.mjs, statusLabel). Before the first confirmation there is nothing to show
// and nothing is counted.
//
// The confirmation and the count are kept in the chat's file on the Leader's desk, so a server
// started again shows what the last one showed. Whether the User asked for a check that has not
// reached the Leader yet is the one thing kept in memory: a check asked of a server that stopped
// went with it.

import fs from "node:fs";
import path from "node:path";

import { shownStatusFile, statusFile } from "../desks.mjs";
import { maskProse } from "../mask.mjs";
import { publish } from "./events.mjs";

// The event the User's click on the status's stamp sends the Leader, and what it says.
export const STATUS_CHECK = "status-check";
export const BODY_STATUS_CHECK = (leader) =>
  `The User asks you to check your status: edit desks/${leader}/STATUS.md if it is out of date, call confirm_status, and reply <noop/>.`;

// The roots whose User asked for a check that is not yet written to the Leader.
const asking = new Set();

function kept(root, leader) {
  try {
    const shown = JSON.parse(fs.readFileSync(shownStatusFile(root, leader), "utf8"));
    return typeof shown?.at === "string" && typeof shown.text === "string" && Number.isInteger(shown.since) ? shown : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function keep(root, leader, shown) {
  const target = shownStatusFile(root, leader);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(shown, null, 2)}\n`);
}

// What the panel shows: `{ at, text, since, checking }`, or null before the first confirmation.
export function statusOf(root, leader) {
  const shown = kept(root, leader);
  return shown === null ? null : { ...shown, checking: asking.has(root) };
}

function told(root, leader) {
  publish("status", statusOf(root, leader));
}

// The Leader says STATUS.md is current: the file as it stands now, masked as a reply is, with the
// time of the call, and nothing reached it since. Answers the refusal when there is no file or
// nothing in it, and null when it was taken.
export function confirm(root, leader, at) {
  let text;
  try {
    text = fs.readFileSync(statusFile(root, leader), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return `there is no desks/${leader}/STATUS.md: write it with the file tools first`;
  }
  if (text.trim() === "") {
    return `desks/${leader}/STATUS.md is empty: say where things stand in it first`;
  }
  keep(root, leader, { at: new Date(at).toISOString(), text: maskProse(text.trim()), since: 0 });
  asking.delete(root);
  told(root, leader);
  return null;
}

// Frames went to the Leader's process, one per child of the queue written. A check among them has
// reached it, so the label is the count's again.
export function delivered(root, leader, frames) {
  const shown = kept(root, leader);
  if (shown === null || frames.length === 0) {
    return;
  }
  keep(root, leader, { ...shown, since: shown.since + frames.length });
  if (frames.some((frame) => frame.kind === "server-event" && frame.event.type === STATUS_CHECK)) {
    asking.delete(root);
  }
  told(root, leader);
}

// The User asked for a check: the label says checking while it waits to reach the Leader, and the
// count says the rest from the write on. Nothing is asked before the first confirmation, since
// there is nothing shown to check. Answers whether it was asked.
export function asked(root, leader) {
  if (kept(root, leader) === null) {
    return false;
  }
  asking.add(root);
  told(root, leader);
  return true;
}

// A check that could not be sent is not waited on.
export function unasked(root, leader) {
  if (asking.delete(root)) {
    told(root, leader);
  }
}
