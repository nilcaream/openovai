// How a browser is signed in to the page: with a one-time link, once, and then a cookie.
//
// The page drives every seat — it answers cards, writes rules, speaks as the User, opens files on
// the desktop — so it is served only to a browser that holds the session key. The key is 32 random
// bytes in `page-session` at the root, readable by the instance's owner alone, made at the first
// start and kept: a browser signed in stays signed in across restarts and updates. It travels in
// one HttpOnly cookie and is never printed.
//
// A browser gets the cookie from a link. `ovai start` and `ovai url` write a fresh link token to
// `page-link` beside it, 0600, good for LINK_LIFETIME, and print the address with it. The server
// takes the token once: a match within its lifetime deletes the file and signs the browser in, and
// a new link replaces the one before it, so at most one is ever pending. A link copied out of the
// scrollback or the history afterwards opens nothing.
//
// Both files are the instance owner's: the root is 0700 and the files 0600 (lib/private.mjs). Who
// reads them as that user can sign in, sessions included; that is the line this draws.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writePrivate } from "../private.mjs";
import { mint } from "./secrets.mjs";

export const SESSION_FILE = "page-session";
export const LINK_FILE = "page-link";

// How long a printed link opens the page: enough to copy it into a browser, not enough to be worth
// finding in a scrollback.
export const LINK_LIFETIME = 10 * 60_000;

// The cookie's own lifetime, renewed on every load of the page: 400 days, the longest a browser
// keeps one, so a page in use never runs out.
export const COOKIE_AGE = 400 * 24 * 60 * 60;

// Compared in constant time, because the one thing a comparison must not do is take longer when
// more of the guess is right.
function same(presented, expected) {
  if (typeof presented !== "string") {
    return false;
  }
  const given = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

// The session key, made the first time and read ever after. Read from the file at every call
// rather than kept, so a key deleted to sign every browser out is gone at the next request.
export function sessionKey(root) {
  const file = path.join(root, SESSION_FILE);
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  writePrivate(file, `${mint()}\n`);
  return fs.readFileSync(file, "utf8").trim();
}

// Whether any of the values a browser sent under the cookie's name is the key. Any, not the first:
// a page on another port of this address can set a cookie of the same name with a longer path, and
// the browser then sends that one first.
export function isSession(root, values) {
  const key = sessionKey(root);
  return values.some((value) => same(value, key));
}

// A fresh link token, replacing whatever link was pending. Written by the command, whether or not a
// server is running: the server reads the file when the link is opened.
export function writeLink(root, now = Date.now()) {
  const token = mint();
  writePrivate(path.join(root, LINK_FILE), `${JSON.stringify({ token, expires: new Date(now + LINK_LIFETIME).toISOString() })}\n`);
  return token;
}

// Whether the presented token is the pending link's, within its lifetime. A match is taken: the
// file is deleted, so the same link never opens the page twice. A link past its lifetime is deleted
// too, since it will never open anything; a wrong token leaves the pending link as it is.
export function takeLink(root, presented, now = Date.now()) {
  const file = path.join(root, LINK_FILE);
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  const expired = !(Date.parse(pending?.expires) > now);
  if (expired) {
    fs.rmSync(file, { force: true });
    return false;
  }
  if (!same(presented, String(pending.token))) {
    return false;
  }
  fs.rmSync(file, { force: true });
  return true;
}

// The address that signs a browser in: the server's own, with the token on it.
export function linkTo(url, token) {
  return `${url}/?token=${token}`;
}
