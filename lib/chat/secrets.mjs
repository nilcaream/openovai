// The secrets the server knows its sessions by.
//
// Names are for people; secrets are for the machinery. When the server spawns a session it mints
// a secret, hands it to that one process and remembers which seat and which role it was issued
// for. The MCP endpoint is keyed by the secret, so a session never says who it is — the server
// knows, from the one thing only that process was given. When the process ends its secret is
// revoked, and a call carrying it afterwards is a call from nobody.
//
// The page is known by a key of the instance's own (signin.mjs), which is not in the map below and
// never resolves to a seat: a session's secret opens the MCP path and nothing else, the key opens
// the page routes and nothing else, and either on the wrong side is the same unknown as a secret
// nobody issued.
//
// Everything here is memory. No log line carries a secret, and a server that restarts starts with
// nothing — every session with it, which is what a restart means. The one file that carries one is
// how a session is handed its own, and it is removed at the secret's first use (`issue`'s `used`).

import crypto from "node:crypto";

// 32 random bytes, written as base64url: 43 characters, safe in a URL path and in an
// environment variable, with no padding to trip either.
export function mint() {
  return crypto.randomBytes(32).toString("base64url");
}

const issued = new Map();

// `used` is called once, the first time the secret resolves: the moment somebody has it in hand.
export function issue(seat, role, used = () => {}) {
  const secret = mint();
  issued.set(secret, { seat, role, used });
  return secret;
}

export function resolve(secret) {
  const known = issued.get(secret);
  if (known === undefined) {
    return null;
  }
  const { used } = known;
  known.used = null;
  used?.();
  return { seat: known.seat, role: known.role };
}

export function revoke(secret) {
  issued.delete(secret);
}
