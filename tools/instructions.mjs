// An instance owns the instructions its sessions run under.
//
// Claude Code reads CLAUDE.md from the directory a session is started in and from every directory
// above it, all the way to the filesystem root, and concatenates what it finds. A session in this
// instance is started in the instance root, so an instance living under somebody's home or inside
// somebody's project starts every session with that person's house rules in its head — rules
// nobody here wrote, that nobody here can see on the page, and that change under the instance
// when the enclosing directory changes.
//
// Measured, on claude 2.1.258: a session started five directories below a CLAUDE.md obeyed it,
// having been told nothing about it. So this is not a precaution against something that might
// happen; it is a channel that is open by default.
//
// The lever is `claudeMdExcludes`: a list of patterns matched against absolute paths, each naming
// something that is not to be read. Measured, all of it: globs work; a relative path is silently
// ignored, which is why everything here resolves first; and a settings document handed to a run
// with `--settings` is honoured, on a fresh `--print` run and on a resumed one alike (measured on
// claude 2.1.259: a run resumed with it answered NONE to what the file above said, and the same
// conversation resumed without it read the file again).
//
// It is handed to every run rather than written into the instance's `.claude/settings.json`,
// because that file is the person's. The toolkit writes it once, when the instance is made, and
// what the person makes of it afterwards is theirs; a product default rewritten into it at every
// start would be the toolkit's hand in their file for the life of the instance. The list is
// absolute paths worked out from where the instance sits now, so it is computed for each run and
// kept under `chat/` with the rest of what the chat keeps for itself — an instance that was moved
// carries no list for where it used to be.
//
// One thing this cannot close, and the claim we make says so: a managed policy CLAUDE.md —
// /etc/claude-code/CLAUDE.md on Linux — is deliberately not excludable, so an organisation's own
// instructions always apply. An instance owns its instructions except that one.

import fs from "node:fs";
import path from "node:path";

// The key Claude Code reads the list under.
export const EXCLUDES = "claudeMdExcludes";

// The settings document a run is started with, under the directory the chat keeps for itself.
// Named for what it holds rather than as "settings", so that nobody reads it for the instance's
// settings — those are in `.claude/settings.json` and are the person's.
const FILE = path.join("chat", "instructions.json");

// What is read out of one directory, and so what has to be named to keep it out. The first two
// are the walk itself; `.claude/CLAUDE.md` is the other spelling of a directory's instructions,
// which a sweep naming only the first two misses; the rules directory is a glob because its
// contents are not knowable and each file in it counts.
//
// AGENTS.md is deliberately absent: Claude Code does not read it. It arrives only where a
// CLAUDE.md imports it, and excluding that CLAUDE.md already takes the import with it.
const PER_DIRECTORY = [["CLAUDE.md"], ["CLAUDE.local.md"], [".claude", "CLAUDE.md"], [".claude", "rules", "**"]];

// Every directory above the instance, from its parent up to and including the filesystem root.
//
// The instance root itself is never in here. Its own .claude/CLAUDE.md is the instance's to write
// and is the one set of instructions a session is meant to have.
export function above(root) {
  const walked = [];
  let at = path.dirname(path.resolve(root));

  for (;;) {
    walked.push(at);
    const up = path.dirname(at);
    if (up === at) {
      return walked;
    }
    at = up;
  }
}

// The whole list, absolute, whether or not anything is there.
//
// Excluding only what exists at this moment would leave a file dropped into a parent directory
// tomorrow in play, and nothing would say so: the instance would simply start reading it. The
// list costs four strings per directory and is written every time the chat starts, so it is
// always the list for where the instance is now, even if somebody moved it.
export function excludes(root) {
  return above(root).flatMap((directory) => PER_DIRECTORY.map((parts) => path.join(directory, ...parts)));
}

// Which of them are actually there today. A glob names a directory rather than a file, so it
// counts as present when the directory is; the rest are files.
export function found(patterns) {
  return patterns.filter((pattern) =>
    pattern.endsWith(`${path.sep}**`) ? fs.existsSync(path.dirname(pattern)) : fs.existsSync(pattern),
  );
}

// Write the settings document a run is to be started with, and answer with where it is. Written
// on every call, so a run is always started with the list for where the instance is now; the
// file is tiny and the write is cheaper than any reasoning about whether it is current.
export function ownInstructions(root) {
  const target = path.join(root, FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ [EXCLUDES]: excludes(root) }, null, 2)}\n`);
  return target;
}

// What is on the list and what of it exists, so the chat can say so out loud at start: a person
// who wonders why a session is not following the rules of the project the instance sits in
// should be able to see, there, that it is not reading them.
export function instructionsAbove(root) {
  const patterns = excludes(root);
  return { patterns, existing: found(patterns) };
}
