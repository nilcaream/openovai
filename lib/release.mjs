// Where a newer version of the toolkit comes from, and how it is taken.
//
// A release is a tag, and the package is `git archive` of that tag, made and signed by the release
// workflow and attached to the release with its SHA256SUMS and signature (lib/signature.mjs). The
// package is the whole repository: `lib/payload.mjs` decides what a workspace is by the entries that
// are in it, so an archive is as valid a source as a clone — which the installer relies on too.
//
// GitHub's own source archive of the tag, the `tarball_url` of a release, is never taken: nothing
// vouches for it, and a fallback to it would make taking the signature off a release a way round it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PAYLOAD, RETIRED, notAWorkspace } from "./payload.mjs";
import { SignatureError, checkRelease, packageName } from "./signature.mjs";
import { VERSION_FILE, version } from "./version.mjs";

// The notes a release carries, written for the Leader of a workspace rather than for whoever works
// on the toolkit: what changed in how the workspace runs. Read from the package rather than from the
// release description, so that what an instance was told and what it installed are the same thing.
export const RELEASE_NOTES = "NOTES.md";

// Where an instance looks when it is not told where to look: the toolkit's own releases, asked of
// GitHub, which answers with the latest one.
//
// A tool that updates itself has to know where it lives, and this is the one place that says so. It
// is in the payload rather than in an instance's own description of itself, for the reason the
// version is: what an instance carries here comes from the release it is on, so a fork that changes
// this address updates from its own home without anybody having to remember --from.
export const RELEASES = "https://api.github.com/repos/nilcaream/openovai/releases/latest";

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

// The version a checkout is taken as: the first BUILD_LENGTH characters of the hash of the commit it
// is on, so an instance says exactly which one it runs — a fixed length rather than git's short
// hash, which grows with the repository. Only main, committed and clean, is taken — what is copied is the
// working tree and not the commit, so anything else would put in place something no commit names:
// a feature branch, work in progress, a file nobody added.
const BUILT_FROM = "main";
const BUILD_LENGTH = 8;

function build(tree) {
  const git = (...words) => spawnSync("git", words, { cwd: tree, encoding: "utf8" });
  const asked = (answer) => answer.error?.message ?? answer.stderr.trim();

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch.error !== undefined || branch.status !== 0) {
    throw new ReleaseError(`${tree} is a git checkout git could not read (${asked(branch)}), so the commit it would be cannot be named`);
  }
  if (branch.stdout.trim() !== BUILT_FROM) {
    throw new ReleaseError(`${tree} is on ${branch.stdout.trim()}, not ${BUILT_FROM} — a checkout is taken only as ${BUILT_FROM}, committed and clean`);
  }
  const status = git("status", "--porcelain");
  if (status.status !== 0 || status.stdout.trim() !== "") {
    throw new ReleaseError(`${tree} has changes git status lists — a checkout is taken only as ${BUILT_FROM}, committed and clean`);
  }
  return git("rev-parse", "HEAD").stdout.trim().slice(0, BUILD_LENGTH);
}

// The version an install from a checkout is stamped with: the same eight characters, on ANY branch,
// since an install is where a branch is tried out and what it shows has to be the commit it was made
// from. Still only committed and clean, for the reason `build` gives; anything else — changes git
// status lists, a directory that is no checkout — is installed on the lib/VERSION it carries (null).
export function installStamp(tree) {
  if (!fs.existsSync(path.join(tree, ".git"))) {
    return null;
  }
  const git = (...words) => spawnSync("git", words, { cwd: tree, encoding: "utf8" });
  const status = git("status", "--porcelain");
  if (status.error !== undefined || status.status !== 0 || status.stdout.trim() !== "") {
    return null;
  }
  const head = git("rev-parse", "HEAD");
  return head.status === 0 ? head.stdout.trim().slice(0, BUILD_LENGTH) : null;
}

// The release to take: which version it is, and where the package is.
//
// A directory is a release that is already unpacked — a clone, an archive somebody opened, a copy
// on a disk. Its version is the file it carries, because that is what an instance ends up on. It
// is asked whether it is a workspace at all before it is asked its version, so that a directory
// which is something else entirely is refused with what it is missing — and the version lives
// inside the payload, so a directory that passes has one.
//
// A directory that is a git checkout is a build rather than a release: what it holds is named by the
// commit it is on, since its lib/VERSION says the last release and not what came after it (`build`).
//
// A URL is asked what the latest release is, and the answer is read for the tag and the files
// attached to it: the package, SHA256SUMS and every signature over it. A release without them is
// refused here, before anything is downloaded. The TAG is what says whether there is anything to
// take, so that an instance already on the latest version downloads nothing at all.
export async function latestRelease(from) {
  if (isDirectory(from)) {
    const wrong = notAWorkspace(from);
    if (wrong !== null) {
      throw new ReleaseError(wrong);
    }
    if (fs.existsSync(path.join(from, ".git"))) {
      return { version: build(from), package: from, unpacked: true, build: true };
    }
    return { version: version(from), package: from, unpacked: true };
  }

  let answered;
  try {
    answered = await fetch(from, {
      headers: { accept: "application/vnd.github+json", "user-agent": "openovai" },
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
  if (typeof tag !== "string") {
    throw new ReleaseError(`${from} answered with nothing that reads as a release`);
  }

  // A tag is written the way a person writes one and a version is written the way a file holds
  // one, and the only difference anybody uses is the v in front.
  const named = tag.replace(/^v/, "");
  const attached = new Map();
  for (const asset of Array.isArray(body.assets) ? body.assets : []) {
    if (typeof asset?.name === "string" && typeof asset?.browser_download_url === "string") {
      attached.set(asset.name, asset.browser_download_url);
    }
  }
  const signatures = [...attached].filter(([name]) => /^SHA256SUMS(\.[a-z]+)?\.sig$/.test(name)).map(([, url]) => url);
  if (!attached.has(packageName(named)) || !attached.has("SHA256SUMS") || signatures.length === 0) {
    throw new ReleaseError(`${tag} carries no signed package (${packageName(named)}, SHA256SUMS and a signature), so it is not taken`);
  }

  return {
    version: named,
    package: { archive: attached.get(packageName(named)), sums: attached.get("SHA256SUMS"), signatures },
    unpacked: false,
  };
}

async function download(url) {
  let answered;
  try {
    answered = await fetch(url, {
      headers: { "user-agent": "openovai" },
      signal: AbortSignal.timeout(GIVE_UP_AFTER),
    });
  } catch (error) {
    throw new ReleaseError(`${url} did not answer (${error.cause?.code ?? error.message})`);
  }

  if (!answered.ok) {
    throw new ReleaseError(`${url} answered ${answered.status}`);
  }
  return Buffer.from(await answered.arrayBuffer());
}

// The package of `release`, checked against the signatures beside it with `keys` — the running
// instance's, never the package's own — and only then opened into a directory of its own.
//
// tar rather than anything written here: an archive is what a release carries, Node has no reader
// for one, and every machine that can run this has had tar on it for thirty years. It is named in
// the requirements, and a machine without it is told so rather than left with a stack trace.
export async function unpackInto(release, directory, keys) {
  const { archive, sums, signatures } = release.package;
  const pack = await download(archive);
  const signed = await download(sums);
  const armored = [];
  for (const url of signatures) {
    armored.push((await download(url)).toString("utf8"));
  }
  try {
    checkRelease({ version: release.version, sums: signed, signatures: armored, pack, keys });
  } catch (error) {
    if (error instanceof SignatureError) {
      throw new ReleaseError(`${error.message}; nothing was taken`);
    }
    throw error;
  }

  fs.mkdirSync(directory, { recursive: true });
  const done = spawnSync("tar", ["-xz", STRIP_THE_WRAPPER, "-C", directory], {
    input: pack,
    encoding: "utf8",
  });

  if (done.error?.code === "ENOENT") {
    throw new ReleaseError("tar is required to open a release package and is not on your PATH");
  }
  if (done.status !== 0) {
    throw new ReleaseError(`the release package could not be opened: ${done.stderr.trim() || "tar failed"}`);
  }

  // The signature binds the package to the version its name carries; this binds what is inside it
  // to the same one, so a tag put on a tree that says it is something else is not taken as the tag.
  const inside = version(directory);
  if (inside !== release.version) {
    throw new ReleaseError(`the package of ${release.version} holds ${inside ?? "no version"} in ${VERSION_FILE}; nothing was taken`);
  }

  return directory;
}

// What the release says has changed, for the Leader of the workspace taking it. A release with none
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

// The one payload entry that is copied over in place rather than swapped for a new directory.
// bin/ is where a person stands when they run the update, and where the hint at the end sends
// them next; a shell standing in a directory that was removed and put back is standing in no
// directory at all, and its `./ovai start` is "No such file or directory" with the file right
// there. So its files are copied in over the old ones, into a bin/ made when there is none, and
// the directory itself is never touched. What that leaves behind — a file the newer version
// dropped from bin/ — is nothing: bin/ holds the one launcher.
const COPIED_OVER = "bin";

// Replace the payload on disk with the new one.
//
// Replaced rather than copied over: a file the new version dropped has to go, or the instance stops
// being a copy of any version and starts being the union of two — and so has an entry an earlier
// version shipped and this one does not (RETIRED). Nothing an instance accumulates is in here — no
// session has ever written inside bin or lib — so there is nothing under these names
// to lose. An entry may sit below a directory the person also uses, as the retired skill sat under
// `.claude/skills` beside their own; what is removed is the entry, never the directory above it.
//
// Everything is copied in beside what it replaces FIRST, and only then swapped, so the moment in
// which the instance is neither one version nor the other is a remove and a rename rather than a
// recursive copy. It is not a rollback and does not pretend to be one: if it dies in that moment
// the payload is mixed, nothing that cannot be replaced is at risk, and running it again fixes it.
// bin/ is the exception (COPIED_OVER), and goes last: the launcher runs either lib.
//
// A build is given the version it is on (`stamp`), written into what is put in place before the swap,
// so the payload and the version it says it is cannot be seen apart.
export function replacePayload(root, tree, stamp = null) {
  const wrong = notAWorkspace(tree);
  if (wrong !== null) {
    throw new ReleaseError(wrong);
  }

  const incoming = [];
  for (const entry of PAYLOAD.filter((one) => one !== COPIED_OVER)) {
    const beside = path.join(root, `${entry}.incoming`);
    fs.rmSync(beside, { recursive: true, force: true });
    fs.cpSync(path.join(tree, entry), beside, { recursive: true });
    incoming.push([beside, path.join(root, entry)]);
  }
  if (stamp !== null) {
    fs.writeFileSync(path.join(root, `${path.dirname(VERSION_FILE)}.incoming`, path.basename(VERSION_FILE)), `${stamp}\n`);
  }

  const replaced = [];
  for (const [beside, target] of incoming) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(beside, target);
    replaced.push(target);
  }

  const over = path.join(root, COPIED_OVER);
  fs.mkdirSync(over, { recursive: true });
  fs.cpSync(path.join(tree, COPIED_OVER), over, { recursive: true, force: true });
  replaced.push(over);

  retire(root);
  return replaced;
}

// What an earlier version shipped and this one does not, taken away — not listed among what was put
// in place: nothing stands where it was. The list is this version's, so an update runs it again
// from the payload it put in place (`ovai update --finish`), where the new version's list is known.
export function retire(root) {
  for (const entry of RETIRED) {
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}
