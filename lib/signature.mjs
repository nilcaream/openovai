// Whether a release package is one the toolkit's own release workflow signed.
//
// A release carries three files beside its notes: the package, `SHA256SUMS` — one line, the
// package's digest and its name — and a signature over that line made with `ssh-keygen -Y sign`.
// The name has the version in it, so the signature says which bytes ARE which version, and a
// package signed as one version cannot be handed out as another.
//
// An SSH signature rather than anything else because it is the one both sides can check with what
// they already have: the command that installs checks it with `ssh-keygen -Y verify` before there
// is any Node, and an update checks it here, with node:crypto and nothing else. The format is
// OpenSSH's PROTOCOL.sshsig; only what `ssh-keygen -Y sign` makes with an Ed25519 key is read, and
// anything else is not a signature this accepts.
//
// The keys it is checked against are the ones the RUNNING instance carries (RELEASE_KEYS), never
// the ones in the package being checked: a package that brought its own key would vouch for itself.

import crypto from "node:crypto";
import path from "node:path";

// The keys a release may be signed with, in the allowed_signers format `ssh-keygen -Y verify -f`
// reads, so the same file serves the installer's check and this one.
export const RELEASE_KEYS = path.join("lib", "RELEASE_KEYS");

// Who the keys are pinned for and what they sign. The namespace is what keeps a signature made for
// something else with the same key — a commit, a file — from passing as a release.
export const SIGNER = "openovai-release";
export const NAMESPACE = "openovai-release";

// The one hash a signature is taken with: what `ssh-keygen -Y sign` uses unless told otherwise.
const HASH = "sha512";

// The package's name, which is what the signed line binds the version to.
export function packageName(version) {
  return `openovai-${version}.tar.gz`;
}

// A release that is not signed, or not signed by a pinned key, or whose files do not agree.
export class SignatureError extends Error {}

// The Ed25519 keys an allowed_signers file pins for SIGNER and NAMESPACE, as the key blobs a
// signature carries. A line for somebody else, a line limited to other namespaces and a key of
// another type are not keys a release is taken on.
export function pinnedKeys(text) {
  const keys = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const words = line.split(/\s+/);
    if (!words[0].split(",").includes(SIGNER)) {
      continue;
    }
    const at = words.indexOf("ssh-ed25519");
    if (at < 1 || words[at + 1] === undefined) {
      continue;
    }
    const options = words.slice(1, at).join(" ");
    const namespaces = options.match(/namespaces="([^"]*)"/);
    if (namespaces !== null && !namespaces[1].split(",").includes(NAMESPACE)) {
      continue;
    }
    keys.push(Buffer.from(words[at + 1], "base64"));
  }
  return keys;
}

// A reader over the SSH wire format: a 32-bit length, then that many bytes. It throws on a length
// that runs past the end, so a cut or padded signature is refused rather than read short.
function reader(buffer) {
  let at = 0;
  const take = (length) => {
    if (at + length > buffer.length) {
      throw new SignatureError("the signature ends early");
    }
    const part = buffer.subarray(at, at + length);
    at += length;
    return part;
  };
  return {
    take,
    string: () => take(take(4).readUInt32BE(0)),
    done: () => at === buffer.length,
  };
}

function wire(bytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

// An Ed25519 public key blob as node:crypto takes one: the 32 bytes behind the fixed SPKI header.
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

function publicKey(blob) {
  const key = reader(blob);
  if (key.string().toString() !== "ssh-ed25519") {
    throw new SignatureError("the signature is not made with an Ed25519 key");
  }
  const raw = key.string();
  if (raw.length !== 32 || !key.done()) {
    throw new SignatureError("the signature carries a key that is not an Ed25519 key");
  }
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: "der", type: "spki" });
}

// Whether `armored` — a `-----BEGIN SSH SIGNATURE-----` block — is a signature over `message` in
// NAMESPACE by one of `keys`. False for anything else, including something that is no signature.
export function signedBy(message, armored, keys) {
  try {
    const body = armored.match(/^-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=\n]+)-----END SSH SIGNATURE-----\n?$/);
    if (body === null) {
      return false;
    }
    const signature = reader(Buffer.from(body[1].replace(/\n/g, ""), "base64"));
    if (signature.take(6).toString() !== "SSHSIG" || signature.take(4).readUInt32BE(0) !== 1) {
      return false;
    }
    const key = signature.string();
    // The namespace and the hash it names are not compared here: what is verified below is built
    // from NAMESPACE and HASH, so a signature made with any other fails there.
    signature.string();
    signature.string();
    signature.string();
    const made = reader(signature.string());
    if (!signature.done()) {
      return false;
    }
    if (!keys.some((pinned) => pinned.equals(key))) {
      return false;
    }
    if (made.string().toString() !== "ssh-ed25519") {
      return false;
    }
    const bytes = made.string();
    if (!made.done()) {
      return false;
    }
    const signed = Buffer.concat([
      Buffer.from("SSHSIG"),
      wire(Buffer.from(NAMESPACE)),
      wire(Buffer.alloc(0)),
      wire(Buffer.from(HASH)),
      wire(crypto.createHash(HASH).update(message).digest()),
    ]);
    return crypto.verify(null, signed, publicKey(key), bytes);
  } catch {
    return false;
  }
}

// The digest `SHA256SUMS` gives for the package of `version`: exactly one line, in the shape
// `sha256sum` writes, naming exactly that package. Anything else is refused, and says why.
export function digestIn(sums, version) {
  const lines = sums.split("\n").filter((line) => line !== "");
  if (lines.length !== 1) {
    throw new SignatureError(`SHA256SUMS holds ${lines.length} lines, and a release's holds one`);
  }
  const line = lines[0].match(/^([0-9a-f]{64}) [ *](\S+)$/);
  if (line === null) {
    throw new SignatureError("SHA256SUMS does not read as a digest and a name");
  }
  if (line[2] !== packageName(version)) {
    throw new SignatureError(`SHA256SUMS names ${line[2]}, not ${packageName(version)}`);
  }
  return line[1];
}

// The whole check, on the files as they were fetched: `sums` as bytes or text, each of `signatures`
// as text, the package as bytes. A release signed with a key being retired carries a second signature by the key
// replacing it, so any one signature by any one pinned key is enough. Throws when the package is not
// the one the release workflow signed as `version`; returns nothing when it is.
export function checkRelease({ version, sums, signatures, pack, keys }) {
  if (keys.length === 0) {
    throw new SignatureError(`${RELEASE_KEYS} pins no key, so no release can be checked`);
  }
  const signed = Buffer.from(sums);
  if (!signatures.some((armored) => signedBy(signed, armored, keys))) {
    throw new SignatureError(`the release of ${version} is not signed by a key in ${RELEASE_KEYS}`);
  }
  const expected = digestIn(signed.toString("utf8"), version);
  const actual = crypto.createHash("sha256").update(pack).digest("hex");
  if (actual !== expected) {
    throw new SignatureError(`${packageName(version)} is not the package SHA256SUMS names`);
  }
}
