// The secrets a session and the page are known by, asked directly.
//
// A secret is minted when a process is spawned, handed to that one process, held in the memory of
// the process serving the chat and forgotten when the child ends. The page has one of its own,
// which is never a session's. These checks are about the store: what it mints, what it resolves,
// what it forgets, and that the two kinds never cross. Whether the server keys its routes by them
// is the chat suite's question.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPageSecret, issue, mint, pageSecret, resolve, revoke } from "../tools/chat/secrets.mjs";

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
  const leader = issue("Superman", "Leader");

  it("is minted, not chosen", () => {
    assert.match(paul, BASE64URL);
    assert.notEqual(paul, leader);
  });

  it("resolves to the seat and the role it was issued for", () => {
    assert.deepEqual(resolve(paul), { seat: "Paul", role: "Worker" });
    assert.deepEqual(resolve(leader), { seat: "Superman", role: "Leader" });
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

  it("resolves nothing for the page's secret", () => {
    assert.equal(resolve(pageSecret()), null);
  });
});

describe("the page's secret", () => {
  it("is minted once for the process", () => {
    assert.match(pageSecret(), BASE64URL);
    assert.equal(pageSecret(), pageSecret());
  });

  it("is known when presented", () => {
    assert.equal(isPageSecret(pageSecret()), true);
  });

  it("is not a session's secret, and a session's is not it", () => {
    const paul = issue("Paul", "Worker");
    assert.equal(isPageSecret(paul), false);
    assert.equal(resolve(pageSecret()), null);
    revoke(paul);
  });

  it("is not matched by anything else", () => {
    assert.equal(isPageSecret(mint()), false);
    assert.equal(isPageSecret(""), false);
    assert.equal(isPageSecret(null), false);
    assert.equal(isPageSecret(pageSecret().slice(0, -1)), false);
    assert.equal(isPageSecret(`${pageSecret()}x`), false);
  });
});
