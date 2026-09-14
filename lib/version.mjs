// What version of the toolkit an instance is on.
//
// It is a file in the payload rather than a field in openovai.json, and that is what makes taking a
// newer version need no migration of anything: the version travels with the code it names, so
// replacing the payload replaces it too and the two cannot disagree. There is no field to rewrite
// and nothing to look up.
//
// It could not have gone in openovai.json in any case. That file is the instance's description of
// itself and holds no path and no URL at all, deliberately, so that an instance can be moved and
// still be itself — and everything release-shaped is one or the other.

import fs from "node:fs";
import path from "node:path";

export const VERSION_FILE = "VERSION";

// The version the toolkit at `root` is: one line, trimmed. A file rather than a JSON field
// because it is read from a shell as often as from here, and there is nothing else it has to say.
//
// Nothing when there is no such file. An instance made before the toolkit carried a version is a
// real thing to be standing in front of, and `ovai status` is the command somebody runs when they
// are trying to work out what they have — it should answer that question rather than die of it.
export function version(root) {
  try {
    return fs.readFileSync(path.join(root, VERSION_FILE), "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// Whether `candidate` names an earlier version than `installed`, so that an update can refuse to
// take an instance backwards. An instance ahead of what is published is an ordinary thing to be
// standing in front of — a release taken from a directory, or one built where somebody was
// working — and without this the only question asked is whether the two differ, which replaces
// the payload in either direction and reports the fall in the same words as the rise.
//
// The numbers are compared as numbers. Compared as words, 0.10.0 comes before 0.5.0, and the one
// release where that starts being true is the one where a wrong answer here is a downgrade.
//
// Nothing that is not a row of numbers is placed at all, and neither is a missing version: a
// refusal has to be certain of what it is refusing, and an instance made before the toolkit
// carried a version has nothing to be placed after. Where it cannot say, it says no, and the
// update goes on as it did before there was anything here to ask.
export function isOlderThan(candidate, installed) {
  const one = numbers(candidate);
  const other = numbers(installed);

  if (one === null || other === null) {
    return false;
  }

  for (let at = 0; at < Math.max(one.length, other.length); at += 1) {
    // A version with fewer numbers in it is that version with zeros after it: 0.5 and 0.5.0 are
    // the same version written two ways, and neither is older than the other.
    const mine = one[at] ?? 0;
    const theirs = other[at] ?? 0;
    if (mine !== theirs) {
      return mine < theirs;
    }
  }

  return false;
}

// The numbers a version is made of, or nothing when it is not made of numbers.
function numbers(text) {
  if (typeof text !== "string" || !/^\d+(\.\d+)*$/.test(text.trim())) {
    return null;
  }
  return text.trim().split(".").map(Number);
}
