// Whether a newer release is out, for the Leader's head: when GitHub is asked and when it is not,
// what is announced, and when the page is told.
// Every mutation in tests/mutations-releases.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { subscribe } from "../lib/chat/events.mjs";
import { sink } from "../lib/chat/log.mjs";
import { CHECK_EVERY, check, newer, reset } from "../lib/chat/releases.mjs";
import { RELEASES } from "../lib/release.mjs";
import { VERSION_FILE } from "../lib/version.mjs";
import { remove, scratch } from "./helpers.mjs";

const root = scratch("releases-test");
const T0 = Date.parse("2026-11-12T20:00:00.000Z");

function onVersion(text) {
  fs.mkdirSync(path.join(root, path.dirname(VERSION_FILE)), { recursive: true });
  fs.writeFileSync(path.join(root, VERSION_FILE), `${text}\n`);
}

// GitHub's answer for a tag: the signed package, SHA256SUMS and a signature attached, unless
// `signed` is false.
function release(tag, { signed = true } = {}) {
  const names = signed ? [`openovai-${tag.replace(/^v/, "")}.tar.gz`, "SHA256SUMS", "SHA256SUMS.sig"] : ["notes.txt"];
  return { tag_name: tag, published_at: PUBLISHED, assets: names.map((name) => ({ name, browser_download_url: `https://example.invalid/${name}` })) };
}

// What the head is told of the newer release in every case below: its version and when it went out.
const PUBLISHED = "2026-11-12T19:05:00Z";
const NEWER = { version: "0.27.0", published: PUBLISHED };

// A fetch that answers every ask with `body` and counts the asks, each with its address.
function github(body, { status = 200 } = {}) {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    return { ok: status === 200, status, json: async () => body };
  };
  return { asked, get };
}

describe("a newer release", () => {
  let events;
  let rows;
  let unsubscribe;

  beforeEach(() => {
    remove(root);
    reset();
    events = [];
    rows = [];
    unsubscribe = subscribe((event) => {
      if (event.name === "release") events.push(event.data);
    });
    sink((row) => rows.push(row));
  });

  afterEach(() => {
    unsubscribe();
    sink(null);
  });

  after(() => remove(root));

  it("is asked of the address ovai update asks, and named when it is newer", async () => {
    onVersion("0.26.0");
    const { asked, get } = github(release("v0.27.0"));
    await check({ root, on: true, now: T0, get });
    assert.deepEqual(asked, [RELEASES]);
    assert.deepEqual(newer(), NEWER);
    assert.deepEqual(events, [NEWER]);
    assert.ok(rows.some((row) => row.includes("0.27.0 is out; this instance is on 0.26.0")));
  });

  it("names no release date where GitHub gives none that reads as a moment", async () => {
    onVersion("0.26.0");
    await check({ root, on: true, now: T0, get: github({ ...release("v0.27.0"), published_at: "soon" }).get });
    assert.deepEqual(newer(), { version: "0.27.0", published: null });
  });

  it("is asked once a day, and the page is told only when what it names changes", async () => {
    onVersion("0.26.0");
    const { asked, get } = github(release("v0.27.0"));
    await check({ root, on: true, now: T0, get });
    await check({ root, on: true, now: T0 + CHECK_EVERY - 1, get });
    assert.equal(asked.length, 1);
    await check({ root, on: true, now: T0 + CHECK_EVERY, get });
    assert.equal(asked.length, 2);
    assert.deepEqual(events, [NEWER]);
  });

  it("names nothing for the version the instance is on, or an older one", async () => {
    onVersion("0.26.0");
    await check({ root, on: true, now: T0, get: github(release("v0.26.0")).get });
    assert.equal(newer(), null);
    await check({ root, on: true, now: T0 + CHECK_EVERY, get: github(release("v0.25.0")).get });
    assert.equal(newer(), null);
    assert.deepEqual(events, []);
  });

  it("names nothing the updater would refuse: a release with no signed package", async () => {
    onVersion("0.26.0");
    await check({ root, on: true, now: T0, get: github(release("v0.27.0", { signed: false })).get });
    assert.equal(newer(), null);
    assert.ok(rows.some((row) => row.includes("no newer release could be read: v0.27.0 carries no signed package")));
  });

  it("is never asked on a build from a checkout, whose version is its commit", async () => {
    onVersion("34cab9b1");
    const { asked, get } = github(release("v0.27.0"));
    await check({ root, on: true, now: T0, get });
    assert.deepEqual(asked, []);
    assert.equal(newer(), null);
  });

  it("is not asked with update.check off, and a notice shown goes when it is turned off", async () => {
    onVersion("0.26.0");
    const { asked, get } = github(release("v0.27.0"));
    await check({ root, on: false, now: T0, get });
    assert.deepEqual(asked, []);
    await check({ root, on: true, now: T0, get });
    assert.deepEqual(newer(), NEWER);
    await check({ root, on: false, now: T0 + 1, get });
    assert.equal(newer(), null);
    assert.deepEqual(events, [NEWER, null]);
    // Turned on again, the answer already held is named with no new ask.
    await check({ root, on: true, now: T0 + 2, get });
    assert.deepEqual(newer(), NEWER);
    assert.equal(asked.length, 1);
  });

  it("not answered, is said in the log and not asked again before a day", async () => {
    onVersion("0.26.0");
    const { asked, get } = github(null, { status: 503 });
    await check({ root, on: true, now: T0, get });
    await check({ root, on: true, now: T0 + 1, get });
    assert.equal(asked.length, 1);
    assert.equal(newer(), null);
    assert.equal(rows.filter((row) => row.includes(`no newer release could be read: ${RELEASES} answered 503`)).length, 1);
  });
});
