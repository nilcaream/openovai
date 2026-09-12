// The secrets the server knows its callers by.
//
// Names are for people; secrets are for the machinery. When the server spawns a session it mints
// a secret, hands it to that one process and remembers which seat and which role it was issued
// for. The MCP endpoint is keyed by the secret, so a session never says who it is — the server
// knows, from the one thing only that process was given. When the process ends its secret is
// revoked, and a call carrying it afterwards is a call from nobody.
//
// The page has a secret of its own, minted once when the server starts and handed to the page on
// every load. It is not in the map below and never resolves to a seat: a session's secret opens
// the MCP path and nothing else, the page's opens the page routes and nothing else, and either on
// the wrong side is the same unknown as a secret nobody issued.
//
// Everything here is memory. No file, no log line carries a secret, and a server that restarts
// starts with nothing — every session with it, which is what a restart means.

import crypto from "node:crypto";

// 32 random bytes, written as base64url: 43 characters, safe in a URL path and in an
// environment variable, with no padding to trip either.
export function mint() {
  return crypto.randomBytes(32).toString("base64url");
}

const issued = new Map();

let page = null;

export function issue(seat, role) {
  const secret = mint();
  issued.set(secret, { seat, role });
  return secret;
}

export function resolve(secret) {
  const known = issued.get(secret);
  return known === undefined ? null : { seat: known.seat, role: known.role };
}

export function revoke(secret) {
  issued.delete(secret);
}

export function pageSecret() {
  if (page === null) {
    page = mint();
  }
  return page;
}

// Compared in constant time, because the one thing a comparison must not do is take longer when
// more of the guess is right.
export function isPageSecret(presented) {
  if (typeof presented !== "string") {
    return false;
  }
  const expected = Buffer.from(pageSecret());
  const given = Buffer.from(presented);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
