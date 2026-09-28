// tests/signature.test.mjs — check which release packages count as signed, and which do not.
//
// Every signature here is made by `ssh-keygen -Y sign` with a key made here, because that is what
// the release workflow signs with: a check against signatures written by hand would prove this reads
// something nobody makes. No key of the toolkit's own is used or needed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { remove, repo, scratch } from "./helpers.mjs";
import { NAMESPACE, SIGNER, SignatureError, checkRelease, digestIn, packageName, pinnedKeys, signedBy } from "../lib/signature.mjs";

const here = scratch("signature-test");

after(() => remove(here));

function keygen(...words) {
  const done = spawnSync("ssh-keygen", words, { encoding: "utf8" });
  assert.equal(done.status, 0, `ssh-keygen ${words.join(" ")}: ${done.stderr}`);
  return done;
}

// A key pair on disk, and its allowed_signers line.
function aKey(name) {
  const file = path.join(here, name);
  keygen("-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file);
  const [type, blob] = fs.readFileSync(`${file}.pub`, "utf8").trim().split(/\s+/);
  return { file, line: `${SIGNER} namespaces="${NAMESPACE}" ${type} ${blob}` };
}

// A signature over `text`, made the way the release workflow makes one.
function sign(key, text, namespace = NAMESPACE) {
  const file = path.join(here, `message-${crypto.randomUUID()}`);
  fs.writeFileSync(file, text);
  keygen("-Y", "sign", "-q", "-f", key.file, "-n", namespace, file);
  return fs.readFileSync(`${file}.sig`, "utf8");
}

const VERSION = "1.2.0";
const PACK = Buffer.from("the bytes of a package");
const SUMS = `${crypto.createHash("sha256").update(PACK).digest("hex")}  ${packageName(VERSION)}\n`;

let pinned;
let stranger;
let keys;

before(() => {
  fs.mkdirSync(here, { recursive: true });
  pinned = aKey("pinned");
  stranger = aKey("stranger");
  keys = pinnedKeys(`${pinned.line}\n`);
});

describe("the keys a release is checked against", () => {
  it("are the Ed25519 lines pinned for the release signer", () => {
    assert.equal(pinnedKeys(`# a comment\n\n${pinned.line}\n${stranger.line}\n`).length, 2);
  });

  it("leave out a line for somebody else", () => {
    assert.equal(pinnedKeys(pinned.line.replace(SIGNER, "somebody")).length, 0);
  });

  it("leave out a line limited to other namespaces", () => {
    assert.equal(pinnedKeys(pinned.line.replace(`namespaces="${NAMESPACE}"`, 'namespaces="git"')).length, 0);
  });

  it("leave out a key of another type", () => {
    assert.equal(pinnedKeys(pinned.line.replace("ssh-ed25519", "ssh-rsa")).length, 0);
  });
});

describe("a signature", () => {
  it("is taken when a pinned key made it over these bytes", () => {
    assert.equal(signedBy(Buffer.from(SUMS), sign(pinned, SUMS), keys), true);
  });

  it("is refused over other bytes", () => {
    assert.equal(signedBy(Buffer.from(SUMS.replace("1.2.0", "1.2.1")), sign(pinned, SUMS), keys), false);
  });

  it("is refused when the key that made it is not pinned", () => {
    assert.equal(signedBy(Buffer.from(SUMS), sign(stranger, SUMS), keys), false);
  });

  it("is refused when it was made for something other than a release", () => {
    assert.equal(signedBy(Buffer.from(SUMS), sign(pinned, SUMS, "git"), keys), false);
  });

  it("is refused when its bytes were changed", () => {
    const armored = sign(pinned, SUMS);
    const lines = armored.split("\n");
    const at = lines.length - 4;
    lines[at] = lines[at].slice(0, 10) + (lines[at][10] === "A" ? "B" : "A") + lines[at].slice(11);
    assert.equal(signedBy(Buffer.from(SUMS), lines.join("\n"), keys), false);
  });

  it("is refused when it is not a signature at all", () => {
    assert.equal(signedBy(Buffer.from(SUMS), "", keys), false);
    assert.equal(signedBy(Buffer.from(SUMS), "-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n", keys), false);
  });
});

describe("the digest SHA256SUMS gives", () => {
  it("is the one line's, for the package of the version asked", () => {
    assert.equal(digestIn(SUMS, VERSION), SUMS.slice(0, 64));
  });

  it("is refused when the line names another version's package", () => {
    assert.throws(() => digestIn(SUMS, "1.3.0"), /names openovai-1\.2\.0\.tar\.gz, not openovai-1\.3\.0\.tar\.gz/);
  });

  it("is refused when there is more than one line", () => {
    assert.throws(() => digestIn(`${SUMS}${SUMS}`, VERSION), /holds 2 lines/);
  });

  it("is refused when the line is not a digest and a name", () => {
    assert.throws(() => digestIn(`not-a-digest  ${packageName(VERSION)}\n`, VERSION), /does not read as a digest/);
  });
});

// The keys are pinned twice: in lib/RELEASE_KEYS, which an update checks with, and in the command
// that installs, which checks before there is any Node. Two places holding one fact stay one fact
// only while something asks.
describe("the keys the toolkit ships", () => {
  const shipped = pinnedKeys(fs.readFileSync(path.join(repo, "lib", "RELEASE_KEYS"), "utf8"));
  const command = /^release_keys='([^']*)'$/m.exec(fs.readFileSync(path.join(repo, "openovai"), "utf8"));

  it("pin at least one key", () => {
    assert.ok(shipped.length > 0, "lib/RELEASE_KEYS pins no key, so no release would be taken");
  });

  it("are the keys the command that installs pins", () => {
    assert.ok(command !== null, "openovai has no release_keys line");
    const hex = (keys) => keys.map((key) => key.toString("hex"));
    assert.deepEqual(hex(pinnedKeys(command[1])), hex(shipped));
  });
});

describe("a release", () => {
  const release = (changes = {}) => ({ version: VERSION, sums: SUMS, signatures: [sign(pinned, SUMS)], pack: PACK, keys, ...changes });

  it("is taken when a pinned key signed its sums and the package is the one they name", () => {
    assert.doesNotThrow(() => checkRelease(release()));
  });

  it("is taken when any one of its signatures is by a pinned key", () => {
    assert.doesNotThrow(() => checkRelease(release({ signatures: [sign(stranger, SUMS), sign(pinned, SUMS)] })));
  });

  it("is refused when no signature is by a pinned key", () => {
    assert.throws(() => checkRelease(release({ signatures: [sign(stranger, SUMS)] })), SignatureError);
  });

  it("is refused with no signature", () => {
    assert.throws(() => checkRelease(release({ signatures: [] })), /not signed by a key in lib\/RELEASE_KEYS/);
  });

  it("is refused when the package is not the one the sums name", () => {
    assert.throws(() => checkRelease(release({ pack: Buffer.from("other bytes") })), /is not the package SHA256SUMS names/);
  });

  it("is refused when it is served as a version it was not signed as", () => {
    assert.throws(() => checkRelease(release({ version: "1.3.0" })), /not openovai-1\.3\.0\.tar\.gz/);
  });

  it("is refused when nothing is pinned", () => {
    assert.throws(() => checkRelease(release({ keys: [] })), /pins no key/);
  });
});
