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

// VERSION is in it because the version is a property of what the toolkit ships and not of what the
// instance became: it travels with the code it names, so taking a newer version replaces it along
// with everything else and there is no field anywhere to keep in step.
export const PAYLOAD = ["bin", "tools", "templates", VERSION_FILE];

// Which of them a directory has not got. Empty means it is a workspace to install from, or a
// release to take — installing from a clone and installing from an unpacked release are one code
// path rather than two, and this is where that is decided for both.
export function missingFrom(source) {
  return PAYLOAD.filter((entry) => !fs.existsSync(path.join(source, entry)));
}

// The same question, answered as the sentence a person reads. One wording for every caller: the
// installer and the update are looking at the same kind of directory and have the same complaint
// about it, and two wordings would be two things to keep true.
export function notAWorkspace(source) {
  const missing = missingFrom(source);
  return missing.length === 0
    ? null
    : `${source} does not look like an office workspace: no ${missing.join(", ")} in it`;
}
