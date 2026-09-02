// Where a newer version of the toolkit comes from, and how it is taken.
//
// A release is a tag, and the package is the source archive GitHub makes for that tag. Nothing is
// built or uploaded: `tools/payload.mjs` decides what a workspace is by the entries that are in it,
// so a whole repository in an archive is as valid a source as a clone — which is the same thing the
// installer already relies on. That keeps cutting a release down to a tag and some notes.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PAYLOAD, notAWorkspace } from "./payload.mjs";
import { version } from "./version.mjs";

// The notes a release carries, written for the lead of a workspace rather than for whoever works
// on the toolkit: what changed in how the office works. Read from the package rather than from the
// release description, so that what an instance was told and what it installed are the same thing.
export const RELEASE_NOTES = "NOTES.md";

// Where an instance looks when it is not told where to look: the toolkit's own releases, asked of
// GitHub, which answers with the latest one.
//
// A tool that updates itself has to know where it lives, and this is the one place that says so. It
// is in the payload rather than in an instance's own description of itself, for the reason the
// version is: what an instance carries here comes from the release it is on, so a fork that changes
// this address updates from its own home without anybody having to remember --from.
export const RELEASES = "https://api.github.com/repos/nilcaream/office-workspace/releases/latest";

// Something went wrong finding or taking a release. Nothing to do with the command line.
export class ReleaseError extends Error {}

// A release archive from GitHub holds one directory, named for the repository and the commit, with
// the whole tree inside it. There is nothing to be gained from keeping that name.
const STRIP_THE_WRAPPER = "--strip-components=1";

// Long enough for a slow line, short enough that a command does not simply hang. There is nothing
// else waiting on this, so the person can read the message and run it again.
const GIVE_UP_AFTER = 60_000;

function isDirectory(where) {
  try {
    return fs.statSync(where).isDirectory();
  } catch {
    return false;
  }
}

// The release to take: which version it is, and where the package is.
//
// A directory is a release that is already unpacked — a clone, an archive somebody opened, a copy
// on a disk. Its version is the file it carries, because that is what an instance ends up on.
//
// A URL is asked what the latest release is, and the answer is read for the tag and the archive.
// The TAG is what says whether there is anything to take, so that an instance already on the latest
// version downloads nothing at all; what it ends up on is still the version inside the package.
export async function latestRelease(from) {
  if (isDirectory(from)) {
    const said = version(from);
    if (said === null) {
      throw new ReleaseError(`${from} has no version in it, so there is nothing to compare with`);
    }
    return { version: said, package: from, unpacked: true };
  }

  let answered;
  try {
    answered = await fetch(from, {
      headers: { accept: "application/vnd.github+json", "user-agent": "office-workspace" },
      signal: AbortSignal.timeout(GIVE_UP_AFTER),
    });
  } catch (error) {
    throw new ReleaseError(`${from} did not answer (${error.cause?.code ?? error.message})`);
  }

  if (!answered.ok) {
    throw new ReleaseError(`${from} answered ${answered.status}`);
  }

  let body;
  try {
    body = await answered.json();
  } catch {
    body = null;
  }

  const tag = body?.tag_name;
  const archive = body?.tarball_url;
  if (typeof tag !== "string" || typeof archive !== "string") {
    throw new ReleaseError(`${from} answered with nothing that reads as a release`);
  }

  // A tag is written the way a person writes one and a version is written the way a file holds
  // one, and the only difference anybody uses is the v in front.
  return { version: tag.replace(/^v/, ""), package: archive, unpacked: false };
}

// The package, opened into a directory of its own.
//
// tar rather than anything written here: an archive is what GitHub hands out, Node has no reader
// for one, and every machine that can run this has had tar on it for thirty years. It is named in
// the requirements, and a machine without it is told so rather than left with a stack trace.
export async function unpackInto(url, directory) {
  let answered;
  try {
    answered = await fetch(url, {
      headers: { "user-agent": "office-workspace" },
      signal: AbortSignal.timeout(GIVE_UP_AFTER),
    });
  } catch (error) {
    throw new ReleaseError(`${url} did not answer (${error.cause?.code ?? error.message})`);
  }

  if (!answered.ok) {
    throw new ReleaseError(`${url} answered ${answered.status}`);
  }

  fs.mkdirSync(directory, { recursive: true });
  const done = spawnSync("tar", ["-xz", STRIP_THE_WRAPPER, "-C", directory], {
    input: Buffer.from(await answered.arrayBuffer()),
    encoding: "utf8",
  });

  if (done.error?.code === "ENOENT") {
    throw new ReleaseError("tar is required to open a release package and is not on your PATH");
  }
  if (done.status !== 0) {
    throw new ReleaseError(`the release package could not be opened: ${done.stderr.trim() || "tar failed"}`);
  }

  return directory;
}

// What the release says has changed, for the lead of the workspace taking it. A release with none
// is taken all the same: not saying anything is a poor release and not a broken one.
export function notesIn(tree) {
  try {
    return fs.readFileSync(path.join(tree, RELEASE_NOTES), "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

// Put the new payload in place of the old one.
//
// Replaced rather than copied over: a file the new version dropped has to go, or the instance stops
// being a copy of any version and starts being the union of two. Nothing an instance accumulates is
// in here — no session has ever written inside bin, tools or templates — so there is nothing under
// these names to lose.
//
// Everything is copied in beside what it replaces FIRST, and only then swapped, so the moment in
// which the instance is neither one version nor the other is a remove and a rename rather than a
// recursive copy. It is not a rollback and does not pretend to be one: if it dies in that moment
// the payload is mixed, nothing that cannot be replaced is at risk, and running it again fixes it.
export function replacePayload(root, tree) {
  const wrong = notAWorkspace(tree);
  if (wrong !== null) {
    throw new ReleaseError(wrong);
  }

  const incoming = [];
  for (const entry of PAYLOAD) {
    const beside = path.join(root, `${entry}.incoming`);
    fs.rmSync(beside, { recursive: true, force: true });
    fs.cpSync(path.join(tree, entry), beside, { recursive: true });
    incoming.push([beside, path.join(root, entry)]);
  }

  const replaced = [];
  for (const [beside, target] of incoming) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(beside, target);
    replaced.push(target);
  }

  return replaced;
}
