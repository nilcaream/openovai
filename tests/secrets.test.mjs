// The secrets a session is known by, asked directly.
//
// A secret is minted when a process is spawned, handed to that one process, held in the memory of
// the process serving the chat and forgotten when the child ends. These checks are about the store:
// what it mints, what it resolves, what it forgets. Whether the server keys its routes by them, and
// that the page's key never opens a session's door, is the chat suite's question.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { issue, mint, resolve, revoke } from "../lib/chat/secrets.mjs";

const BASE64URL = /^[A-Za-z0-9_-]{43}$/;

describe("what is minted", () => {
  it("is 43 characters of base64url", () => {
    assert.match(mint(), BASE64URL);
  });

  it("differs every time", () => {
    const minted = new Set(Array.from({ length: 50 }, () => mint()));
    assert.equal(minted.size, 50);
  });
});

describe("a secret issued for a seat", () => {
  const paul = issue("Paul", "Worker");
  const leader = issue("Martin", "Leader");

  it("is minted, not chosen", () => {
    assert.match(paul, BASE64URL);
    assert.notEqual(paul, leader);
  });

  it("resolves to the seat and the role it was issued for", () => {
    assert.deepEqual(resolve(paul), { seat: "Paul", role: "Worker" });
    assert.deepEqual(resolve(leader), { seat: "Martin", role: "Leader" });
  });

  it("resolves to nothing once revoked", () => {
    const short = issue("Short", "Worker");
    revoke(short);
    assert.equal(resolve(short), null);
  });

  it("is issued afresh for the same seat", () => {
    const again = issue("Paul", "Worker");
    assert.notEqual(again, paul);
    assert.deepEqual(resolve(again), { seat: "Paul", role: "Worker" });
    revoke(again);
  });

  it("keeps the role it was issued with", () => {
    const fixed = issue("Fixed", "Leader");
    assert.equal(resolve(fixed).role, "Leader");
    revoke(fixed);
  });
});

describe("what is not a session's secret", () => {
  it("resolves nothing for a secret nobody issued", () => {
    assert.equal(resolve(mint()), null);
  });

  it("resolves nothing for a malformed value", () => {
    assert.equal(resolve(""), null);
    assert.equal(resolve(undefined), null);
    assert.equal(resolve("Paul"), null);
  });
});
