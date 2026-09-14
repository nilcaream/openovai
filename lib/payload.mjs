// What an instance is made of, as opposed to what it becomes.
//
// The list is here rather than in the installer because two things read it now. Installing copies
// it in; taking a newer version replaces it and nothing else. That split is the whole of why an
// update can be safe: what the toolkit ships and what an instance accumulates live in different
// directories, so replacing the one never reaches into the other.
//
// It is a list and not a walk of the source directory, because a release package is the same list
// in a different wrapper and both have to be read the same way.

import fs from "node:fs";
import path from "node:path";

import { VERSION_FILE } from "./version.mjs";

// The version is not an entry of its own: it is a file inside `lib/`, because it is a property of
// what the toolkit ships and not of what the instance became — it travels with the code it names,
// so taking a newer version replaces it along with everything else and there is no field anywhere
// to keep in step.
//
// No skill is in it. What the workspace allows is a tool's answer now (the Leader's `permission`
// tool, called with no rule), not a procedure a session follows through files it reads.
export const PAYLOAD = ["bin", "lib"];

// What a directory has to have to be a workspace or a release: the payload, and the version inside
// it. The version is asked for by name although `lib/` already covers it, because a `lib/` with no
// version in it is not a version of the toolkit, whatever else is in it — and the sentence a person
// gets should name the file that is missing rather than the directory that is there.
const SHAPE = [...PAYLOAD, VERSION_FILE];

// What an earlier version shipped inside an instance and this one does not: taken away when a
// newer version is taken, so an instance is a copy of one version and never the union of two. The
// one entry is the skill that used to tell a Leader how to report what the workspace allows; it
// sat under `.claude/skills` beside whatever skills the person put there, and it is the one entry
// that goes, never the directory above it.
export const RETIRED = [path.join(".claude", "skills", "allowed")];

// Which of them a directory has not got. Empty means it is a workspace to install from, or a
// release to take — installing from a clone and installing from an unpacked release are one code
// path rather than two, and this is where that is decided for both.
export function missingFrom(source) {
  return SHAPE.filter((entry) => !fs.existsSync(path.join(source, entry)));
}

// The same question, answered as the sentence a person reads. One wording for every caller: the
// installer and the update are looking at the same kind of directory and have the same complaint
// about it, and two wordings would be two things to keep true.
export function notAWorkspace(source) {
  const missing = missingFrom(source);
  return missing.length === 0
    ? null
    : `${source} does not look like an OpenOv AI instance: no ${missing.join(", ")} in it`;
}
