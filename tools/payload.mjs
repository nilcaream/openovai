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
//
// The skill is in it because a skill is machinery: the procedure a lead follows to say what the
// workspace allows asserts how the runtime behaves, that is measured, and the measurement travels
// with the version — a copy written once and never corrected would be the one file in an instance
// explaining a Claude Code that has since been measured to do something else. It is the ONE
// directory and never `.claude/skills`: the directory beside it holds whatever skills the person
// put there, and a payload entry is removed whole before the new one is put in its place.
//
// The name is `allowed`, matching the ledger beside the settings — never `permissions`, because
// Claude Code has a `/permissions` of its own and two things answering to one word is a thing to
// explain forever.
export const SKILL_NAME = "allowed";
export const SKILL = path.join(".claude", "skills", SKILL_NAME);
export const PAYLOAD = ["bin", "tools", "templates", SKILL, VERSION_FILE];

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
    : `${source} does not look like an OpenOv AI instance: no ${missing.join(", ")} in it`;
}
