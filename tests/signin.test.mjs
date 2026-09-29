// How a browser is signed in, asked directly: the session key an instance keeps, and the one-time
// link the command writes and the server takes. Whether the server answers its routes by them is
// the chat suite's question.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import { LINK_FILE, LINK_LIFETIME, SESSION_FILE, isSession, linkTo, sessionKey, takeLink, writeLink } from "../lib/chat/signin.mjs";
import { remove, scratch } from "./helpers.mjs";

const BASE64URL = /^[A-Za-z0-9_-]{43}$/;

const root = scratch("signin-test");
remove(root);
fs.mkdirSync(root, { recursive: true });
after(() => remove(root));

const modeOf = (file) => fs.statSync(path.join(root, file)).mode & 0o777;

describe("the session key", () => {
  it("is made the first time, 43 characters of base64url, for its owner alone", () => {
    const key = sessionKey(root);
    assert.match(key, BASE64URL);
    assert.equal(modeOf(SESSION_FILE), 0o600);
  });

  it("is the one it was every time after, so a browser stays signed in across a restart", () => {
    assert.equal(sessionKey(root), sessionKey(root));
    assert.equal(fs.readFileSync(path.join(root, SESSION_FILE), "utf8").trim(), sessionKey(root));
  });

  it("is a new one once its file is deleted, which signs every browser out", () => {
    const before = sessionKey(root);
    fs.rmSync(path.join(root, SESSION_FILE));
    assert.notEqual(sessionKey(root), before);
    assert.equal(isSession(root, [before]), false);
  });

  it("is a new one when its file is empty, and an empty cookie is not it", () => {
    fs.writeFileSync(path.join(root, SESSION_FILE), "");
    assert.equal(isSession(root, [""]), false);
    assert.match(sessionKey(root), BASE64URL);
    fs.writeFileSync(path.join(root, SESSION_FILE), "\n");
    assert.equal(isSession(root, [""]), false);
    assert.match(sessionKey(root), BASE64URL);
    assert.equal(modeOf(SESSION_FILE), 0o600);
  });

  it("is presented when any value sent under the cookie's name is it, and no other way", () => {
    const key = sessionKey(root);
    assert.equal(isSession(root, [key]), true);
    assert.equal(isSession(root, ["planted", key]), true);
    assert.equal(isSession(root, [key, "planted"]), true);
    assert.equal(isSession(root, []), false);
    assert.equal(isSession(root, [key.slice(0, -1)]), false);
    assert.equal(isSession(root, [`${key}x`]), false);
  });
});

describe("a link", () => {
  it("is written for its owner alone, good for ten minutes", () => {
    const now = Date.parse("2026-09-28T10:00:00.000Z");
    const token = writeLink(root, now);
    assert.match(token, BASE64URL);
    assert.equal(modeOf(LINK_FILE), 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, LINK_FILE), "utf8")), { token, expires: "2026-09-28T10:10:00.000Z" });
    assert.equal(LINK_LIFETIME, 600_000);
  });

  it("opens once: taken, it is gone", () => {
    const token = writeLink(root);
    assert.equal(takeLink(root, token), true);
    assert.equal(fs.existsSync(path.join(root, LINK_FILE)), false);
    assert.equal(takeLink(root, token), false);
  });

  it("is left pending by a wrong token", () => {
    const token = writeLink(root);
    assert.equal(takeLink(root, `${token.slice(0, -1)}x`), false);
    assert.equal(takeLink(root, undefined), false);
    assert.equal(takeLink(root, token), true);
  });

  it("is replaced by the next one", () => {
    const first = writeLink(root);
    const second = writeLink(root);
    assert.equal(takeLink(root, first), false);
    assert.equal(takeLink(root, second), true);
  });

  it("opens nothing once out of time, and is deleted then", () => {
    const now = Date.now();
    const token = writeLink(root, now);
    assert.equal(takeLink(root, token, now + LINK_LIFETIME), false);
    assert.equal(fs.existsSync(path.join(root, LINK_FILE)), false);
  });

  it("opens just inside its time", () => {
    const now = Date.now();
    const token = writeLink(root, now);
    assert.equal(takeLink(root, token, now + LINK_LIFETIME - 1), true);
  });

  it("is the server's address with the token on it", () => {
    assert.equal(linkTo("http://127.0.0.1:7799", "abc"), "http://127.0.0.1:7799/?token=abc");
  });
});
