// The skills an instance's sessions can run, and why they are written rather than installed.
//
// One skill today: `allowed`, the procedure the lead follows to say what this workspace is allowed
// to do. It is the answer to a question a person used to have a panel and a command line for, and
// inside a chat they have neither, so what it says has to be right about the runtime it is
// describing.
//
// WHICH IS WHY IT IS NOT INSTALLED ONCE. Taking a newer toolkit replaces the payload — bin, tools,
// templates and the version — and touches nothing else, which is what makes an update safe for
// everything an instance accumulated. A skill copied into `.claude/skills/` when the instance was
// made would therefore be the one file in it that asserts how the runtime behaves and never gets a
// correction: an instance installed a year ago would go on explaining a Claude Code that has since
// been measured to do something else, in a file nobody has any reason to look at.
//
// So the source is in the payload and the instance's copy is written every time the chat starts,
// which is the same act and the same reason as the excludes list next door: written at start, so it
// is always the file for the toolkit the instance is on now, even if what it says changed under it.
// The consequence belongs to whoever edits the copy and the file says so in its own first lines —
// an edit there lasts until the next start, and the copy that outlives one is in `templates/`.

import path from "node:path";
import fs from "node:fs";

import { readTemplate } from "./desks.mjs";

// The skill this toolkit ships, in the two places it lives: the payload's copy, which an update
// replaces, and the instance's, which a session reads. The name is `allowed`, matching the ledger
// beside it — never `permissions`, because Claude Code has a `/permissions` of its own and two
// things answering to one word is a thing to explain forever.
export const SKILL = "allowed";
const SKILL_FILE = "SKILL.md";

export const SKILL_SOURCE = path.join("templates", "skills", SKILL, SKILL_FILE);
export const SKILL_TARGET = path.join(".claude", "skills", SKILL, SKILL_FILE);

// Write it, replacing whatever is there, and answer with what was written the way everything else
// that puts a file in an instance does.
//
// It is read from the instance and not from wherever the instance was installed from, for the
// reason the desk and persona templates are: an instance runs on machines its source was never on.
//
// A template that is not there stops the chat rather than being skipped. Skipping it would leave a
// lead with no source to read for the one question it must not answer from memory — which is the
// state this file exists to end, and it would be reached silently. The refusal names the path, and
// taking the toolkit again is what puts it back.
export function ownSkills(root) {
  const target = path.join(root, SKILL_TARGET);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, readTemplate(root, `${SKILL} skill`, SKILL_SOURCE));
  return [target];
}
