// What a release of this tree would be: the tag, the name, and the notes it carries.
//
// `tools/release.mjs` is the other side of this — where a release is taken — and it says what a
// release is: a tag plus the source archive GitHub makes for it. Nothing is built and nothing is
// uploaded, so cutting one is deciding a tag and finding some notes. That is all this does.
//
// It exists as a file rather than as lines inside the workflow because everything here can be got
// wrong — a version nobody bumped, a tag that is already out, notes for a version that is not this
// one — and every one of those is worth a check that runs on a laptop in a second, without a
// runner, a token or a network. What is left in the workflow is git and gh, which nothing here
// could check anyway.
//
// It sits here rather than in tools/ because tools/ is payload: it is copied into every instance
// and replaced whole when one takes a newer version. Cutting a release is something this
// repository does, not something an instance does, and nothing an instance installs should be
// code it can never run.
//
//   node .github/tag.mjs [--repo <dir>] [--notes-file <path>]
//
// It prints what the release would be and writes the notes to a file, because that is the shape
// `gh release create --notes-file` wants and the shape a person wants to read before clicking.
// Under GitHub Actions it also writes tag, name and notes-file to the step's outputs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { RELEASE_NOTES } from "../tools/release.mjs";
import { VERSION_FILE, version } from "../tools/version.mjs";

// Where the notes go when nobody says. Inside the clone and disposable, like everything else the
// toolkit writes while it is working.
export const DEFAULT_NOTES_FILE = path.join(".tmp", "release-notes.md");

// A release cannot be cut, and why. Separate from ReleaseError because that one is about taking a
// release that exists; this one is about a release that does not exist yet and should not.
export class TagError extends Error {}

// Three numbers. Not because anything here needs to order them — the toolkit compares versions for
// equality and never for order — but because a tag is forever and a typo in one is a tag nobody
// can take back.
const A_VERSION = /^\d+\.\d+\.\d+$/;

// The tag a version is released under: the version with a v in front, which is the one difference
// between how a person writes a version and how the file holds one.
export function tagFor(said) {
  if (typeof said !== "string" || !A_VERSION.test(said)) {
    throw new TagError(`${VERSION_FILE} says ${JSON.stringify(said)}, which is not a version like 1.2.3`);
  }
  return `v${said}`;
}

// The part of the notes that is about this version: everything under its own heading, up to the
// next one. The file keeps every version's notes and the release page shows one of them.
//
// A missing section is refused rather than published empty. The notes are the whole reason a
// person taking the release reads the page at all, and a release that says nothing is the one
// thing nobody notices until it is out.
export function notesFor(notes, said) {
  const lines = notes.split("\n");
  const heading = `## ${said}`;
  const start = lines.findIndex((line) => line.trim() === heading);

  if (start < 0) {
    const found = lines.filter((line) => line.startsWith("## ")).map((line) => line.trim());
    throw new TagError(
      `${RELEASE_NOTES} has no "${heading}" section, so the release page would say nothing about ${said}. `
        + `It has: ${found.join(", ") || "no version heading at all"}`,
    );
  }

  let end = lines.length;
  for (let line = start + 1; line < lines.length; line += 1) {
    if (lines[line].startsWith("## ")) {
      end = line;
      break;
    }
  }

  const section = lines.slice(start + 1, end).join("\n").trim();
  if (section === "") {
    throw new TagError(`the "${heading}" section of ${RELEASE_NOTES} is empty, so the release page would say nothing`);
  }
  return section;
}

// The tag, if this repository already has it. Asked of git rather than of GitHub: the runner
// checks out every tag before this runs, so the answer is the same one and it needs no token.
//
// This is the refusal that matters most. A tag is what a release IS here, so a second release of
// the same version is not a mistake somebody fixes later — the archive an instance downloads is
// made from the tag, and moving one changes what people already took.
export function alreadyTagged(tree, tag) {
  const asked = spawnSync("git", ["-C", tree, "rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    encoding: "utf8",
  });

  if (asked.error?.code === "ENOENT") {
    throw new TagError("git is required to cut a release and is not on your PATH");
  }
  if (asked.status === 0) {
    return asked.stdout.trim();
  }
  return null;
}

// Everything the release needs, or the reason there is not one. The order is deliberate: the
// cheapest and most likely mistake first, so the message a person gets is the one thing to fix.
export function releaseOf(tree) {
  const said = version(tree);
  if (said === null) {
    throw new TagError(`${tree} has no ${VERSION_FILE} in it, so there is no version to release`);
  }

  const tag = tagFor(said);

  const already = alreadyTagged(tree, tag);
  if (already !== null) {
    throw new TagError(
      `${tag} is already a tag (${already.slice(0, 7)}), so ${said} is already released. `
        + `Bump ${VERSION_FILE} and write its ${RELEASE_NOTES} section first.`,
    );
  }

  let notes;
  try {
    notes = fs.readFileSync(path.join(tree, RELEASE_NOTES), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new TagError(`${tree} has no ${RELEASE_NOTES} in it, and that file is what the release page says`);
    }
    throw error;
  }

  return { version: said, tag, name: said, notes: notesFor(notes, said) };
}

// ---------------------------------------------------------------- the command

function parse(argv) {
  const options = { repo: process.cwd(), notesFile: null };
  for (let at = 0; at < argv.length; at += 1) {
    const next = () => {
      if (at + 1 >= argv.length) {
        throw new TagError(`${argv[at]} needs a value`);
      }
      at += 1;
      return argv[at];
    };
    if (argv[at] === "--repo") {
      options.repo = path.resolve(next());
    } else if (argv[at] === "--notes-file") {
      options.notesFile = path.resolve(next());
    } else {
      throw new TagError(`unknown argument ${argv[at]}`);
    }
  }
  return options;
}

// GitHub reads a step's outputs out of a file, one `name=value` line each, and a value with
// newlines in it needs a delimiter around it. Only the paths and the tag go through here; the
// notes go in a file precisely so that nothing has to quote them.
function tellTheStep(outputs) {
  const where = process.env.GITHUB_OUTPUT;
  if (!where) {
    return;
  }
  fs.appendFileSync(where, `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

export function main(argv, out = console.log, error = console.error) {
  let options;
  let release;
  try {
    options = parse(argv);
    release = releaseOf(options.repo);
  } catch (raised) {
    if (raised instanceof TagError) {
      // An Actions annotation when there is a workflow reading, a plain line when a person is.
      error(process.env.GITHUB_ACTIONS ? `::error::${raised.message}` : `tag: ${raised.message}`);
      return 1;
    }
    throw raised;
  }

  const notesFile = options.notesFile ?? path.join(options.repo, DEFAULT_NOTES_FILE);
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.writeFileSync(notesFile, `${release.notes}\n`);

  out(`tag    ${release.tag}`);
  out(`name   ${release.name}`);
  out(`notes  ${notesFile}`);
  out("");
  out(release.notes);

  tellTheStep({ tag: release.tag, name: release.name, "notes-file": notesFile });
  return 0;
}

// Run as a command rather than imported. process.argv[1] is the path this was started with, and
// comparing the resolved paths keeps a symlinked checkout from looking like an import.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  process.exit(main(process.argv.slice(2)));
}
