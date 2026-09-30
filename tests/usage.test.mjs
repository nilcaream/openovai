// The account's usage windows, as the head shows them: where the token comes from, how the
// endpoint is asked and how often, what the reading says and when the page is told — and how
// fable's own weekly window, which only this endpoint carries, reaches the quota gate.
// Every mutation in tests/mutations-usage.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { home } from "../lib/claude.mjs";
import { subscribe } from "../lib/chat/events.mjs";
import { sink } from "../lib/chat/log.mjs";
import * as quota from "../lib/chat/quota.mjs";
import { BACKOFF, CREDENTIALS_FILE, MACHINE_TOKEN, OLD, POLL, SPACING, USAGE_FILE, USAGE_URL, configure, format, noToken, pageClosed, pageOpened, reading, refresh, reset, tick, token, turnEnded, until } from "../lib/chat/usage.mjs";
import { remove, scratch } from "./helpers.mjs";

const root = scratch("usage-test");
const T0 = Date.parse("2026-09-14T15:45:00.000Z");

// A payload as the endpoint answers it: the limits list, and the older flat keys beside it.
function payload({ session = 8, sessionResets = "2026-09-14T19:20:00.000Z", all = 86, allResets = "2026-09-19T21:00:00.000Z", fable = 20, fableResets = "2026-09-19T21:00:00.000Z" } = {}) {
  const limits = [
    { kind: "session", group: "session", percent: session, resets_at: sessionResets, scope: null },
    { kind: "weekly_all", group: "weekly", percent: all, resets_at: allResets, scope: null },
  ];
  if (fable !== null) {
    limits.push({ kind: "weekly_scoped", group: "weekly", percent: fable, resets_at: fableResets, scope: { model: { id: null, display_name: "Fable" } } });
  }
  return { five_hour: { utilization: session, resets_at: sessionResets }, seven_day: { utilization: all, resets_at: allResets }, limits };
}

// A tick starts an ask it does not wait for; this waits for it.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function credentials(kept) {
  fs.mkdirSync(home(root), { recursive: true });
  fs.writeFileSync(path.join(home(root), CREDENTIALS_FILE), JSON.stringify(kept));
}

// A stand-in for fetch: answers what it is told, and keeps what it was asked.
function answering({ ok = true, status = 200, body = payload(), headers = {}, fails = null } = {}) {
  const asked = [];
  const get = async (url, options) => {
    asked.push({ url, options });
    if (fails !== null) throw new Error(fails);
    return { ok, status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body };
  };
  get.asked = asked;
  return get;
}

before(() => {
  remove(root);
  fs.mkdirSync(root, { recursive: true });
});

after(() => {
  remove(root);
});

// Every check starts with one page open that asked nothing (no reading is a minute old at the
// epoch), since the clock asks only while somebody is looking; a check about no page closes it.
beforeEach(() => {
  reset();
  quota.reset();
  quota.configure({ clock: () => T0 });
  remove(path.join(root, USAGE_FILE));
  pageOpened({ root, config: { auth: "login" } }, { now: () => 0 });
});

describe("the token", () => {
  it("is the machine's when the instance inherits it, and nothing when the machine has none", () => {
    assert.equal(token(root, "inherit", { [MACHINE_TOKEN]: "token-machine" }), "token-machine");
    assert.equal(token(root, "inherit", {}), null);
    assert.equal(token(root, "inherit", { [MACHINE_TOKEN]: "" }), null);
  });

  it("is otherwise the one Claude Code keeps in the instance's home, skipped once expired, nothing when there is none", () => {
    remove(path.join(home(root), CREDENTIALS_FILE));
    assert.equal(token(root, "login", {}, T0), null, "no file");
    assert.equal(token(root, "login", { [MACHINE_TOKEN]: "token-machine" }, T0), null, "no file, and the machine's token is not this instance's");
    credentials({ claudeAiOauth: { accessToken: "token-own", expiresAt: T0 + 60_000 } });
    assert.equal(token(root, "login", { [MACHINE_TOKEN]: "token-machine" }, T0), "token-own", "the instance's own, never the machine's");
    assert.equal(token(root, "login", {}, T0 + 60_000), null, "expired");
    credentials({ claudeAiOauth: { accessToken: "token-fresh" } });
    assert.equal(token(root, "login", {}, T0), "token-fresh", "no expiry given is not expired");
    credentials({ claudeAiOauth: {} });
    assert.equal(token(root, "login", {}, T0), null, "no token in the file");
    fs.writeFileSync(path.join(home(root), CREDENTIALS_FILE), "{");
    assert.equal(token(root, "login", {}, T0), null, "a file nothing can parse");
  });
});

describe("asking the endpoint", () => {
  const instance = { root, config: { auth: "login" } };

  before(() => {
    credentials({ claudeAiOauth: { accessToken: "token-own" } });
  });

  it("sends the token as a bearer with the beta the endpoint wants", async () => {
    const get = answering();
    await refresh(instance, { get, now: () => T0, version: "1.2.3" });
    assert.equal(get.asked.length, 1);
    assert.equal(get.asked[0].url, USAGE_URL);
    assert.equal(get.asked[0].options.headers.authorization, "Bearer token-own");
    assert.equal(get.asked[0].options.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(get.asked[0].options.headers["user-agent"], "claude-code/1.2.3");
    assert.ok(get.asked[0].options.signal instanceof AbortSignal, "no timeout on the request");
    assert.equal(reading(T0).session, "8%");
  });

  it("names the version the server was armed with, when the call names none", async () => {
    configure({ version: "4.5.6" });
    const get = answering();
    await refresh(instance, { get, now: () => T0 });
    assert.equal(get.asked[0].options.headers["user-agent"], "claude-code/4.5.6");
  });

  it("hands fable's own window to the gate with every answer — a fraction, its own reset, from usage — and the account's two stay the frames'", async () => {
    await refresh(instance, { get: answering(), now: () => T0 });
    assert.deepEqual(quota.standing(T0), {
      seven_day_fable: { key: "7d-fable", utilization: 0.2, resetsAt: "2026-09-19T21:00:00.000Z", resets: quota.hhmm("2026-09-19T21:00:00.000Z"), at: new Date(T0).toISOString(), from: "usage", stage: null },
    });
    assert.equal(quota.mayStart("fable", T0), null);
    await refresh(instance, { get: answering({ body: payload({ fable: 99.5 }) }), now: () => T0 + SPACING });
    assert.equal(quota.standing(T0 + SPACING).seven_day_fable.utilization, 0.995);
    assert.deepEqual(quota.mayStart("fable", T0 + SPACING), { window: "7d-fable", resets: "2026-09-19T21:00:00.000Z" }, "held at the 7d pair, 97/99");
    assert.equal(quota.mayStart("opus", T0 + SPACING), null);
  });

  it("hands the gate nothing when the account has no window of fable's own", async () => {
    await refresh(instance, { get: answering({ body: payload({ fable: null }) }), now: () => T0 });
    assert.deepEqual(quota.standing(T0), {});
    assert.equal(reading(T0).fable, "-");
  });

  it("asks nothing without a token, and not again for the backoff", async () => {
    const get = answering();
    const noToken = { root, config: { auth: "inherit" } };
    await refresh(noToken, { get, now: () => T0 });
    assert.equal(get.asked.length, 0);
    credentials({ claudeAiOauth: { accessToken: "token-own" } });
    tick(instance, { get, now: () => T0 + BACKOFF - 1 });
    assert.equal(get.asked.length, 0, "asked again before the backoff passed, though a token is there now");
    tick(instance, { get, now: () => T0 + BACKOFF });
    assert.equal(get.asked.length, 1, "not asked once the backoff passed");
  });

  it("says once why there is no reading, and on a Mac that Claude Code keeps the sign-in in the Keychain", async () => {
    const said = [];
    sink((row) => said.push(row));
    try {
      remove(path.join(home(root), CREDENTIALS_FILE));
      await refresh(instance, { get: answering(), now: () => T0, platform: "darwin" });
      await refresh(instance, { get: answering(), now: () => T0 + BACKOFF, platform: "darwin" });
      assert.equal(said.length, 1, said.join("\n"));
      assert.match(said[0], /no unexpired token in \.credentials\.json .*: on a Mac, Claude Code keeps the sign-in in the Keychain, which ovai does not read/);
      assert.equal(reading(T0 + BACKOFF), null);

      credentials({ claudeAiOauth: { accessToken: "token-own" } });
      await refresh(instance, { get: answering({ ok: false, status: 401 }), now: () => T0 + 2 * BACKOFF, platform: "linux" });
      remove(path.join(home(root), CREDENTIALS_FILE));
      await refresh(instance, { get: answering(), now: () => T0 + 3 * BACKOFF, platform: "linux" });
      const why = said.filter((line) => /no usage reading/.test(line));
      assert.equal(why.length, 2, "not said again once a token had been read and was gone again");
      assert.doesNotMatch(why[1], /Keychain/);
    } finally {
      sink(null);
      credentials({ claudeAiOauth: { accessToken: "token-own" } });
    }
    assert.equal(noToken("inherit", "darwin"), `${MACHINE_TOKEN} is not set, so there is no usage reading`);
  });

  it("backs off after a refusal, for the backoff or the retry-after the answer names, and keeps the last reading", async () => {
    const good = answering();
    await refresh(instance, { get: good, now: () => T0 });
    const refused = answering({ ok: false, status: 429, headers: { "retry-after": "900" } });
    await refresh(instance, { get: refused, now: () => T0 + SPACING });
    assert.equal(reading(T0 + SPACING).session, "8%", "a refusal threw the reading away");
    tick(instance, { get: refused, now: () => T0 + SPACING + 900_000 - 1 });
    assert.equal(refused.asked.length, 1, "asked again before the retry-after passed");
    tick(instance, { get: refused, now: () => T0 + SPACING + 900_000 });
    assert.equal(refused.asked.length, 2, "not asked once the retry-after passed");
    await settle();
    const denied = answering({ ok: false, status: 401 });
    await refresh(instance, { get: denied, now: () => T0 + 2_000_000 });
    assert.equal(denied.asked.length, 1);
    tick(instance, { get: denied, now: () => T0 + 2_000_000 + BACKOFF - 1 });
    assert.equal(denied.asked.length, 1, "a refusal without retry-after was not left alone for the backoff");
    const soon = answering({ ok: false, status: 429, headers: { "retry-after": "60" } });
    await refresh(instance, { get: soon, now: () => T0 + 4_000_000 });
    assert.equal(soon.asked.length, 1);
    tick(instance, { get: soon, now: () => T0 + 4_000_000 + BACKOFF - 1 });
    assert.equal(soon.asked.length, 1, "a retry-after shorter than the backoff cut the backoff short");
  });

  it("backs off when the endpoint is not reached, and never says the token", async () => {
    const said = [];
    sink((row) => said.push(row));
    try {
      const down = answering({ fails: "fetch failed" });
      await refresh(instance, { get: down, now: () => T0 });
      tick(instance, { get: down, now: () => T0 + BACKOFF - 1 });
      assert.equal(down.asked.length, 1, "asked again before the backoff passed");
      assert.equal(reading(T0), null);
    } finally {
      sink(null);
    }
    assert.equal(said.length, 1, said.join("\n"));
    assert.match(said[0], /not reached/);
    assert.ok(!said.some((line) => line.includes("token-own")), "the token was logged");
  });

  it("asks once at a time", async () => {
    let release = null;
    const slow = async () => new Promise((resolve) => (release = () => resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload() })));
    const first = refresh(instance, { get: slow, now: () => T0 });
    const second = refresh(instance, { get: slow, now: () => T0 });
    assert.notEqual(release, null);
    await second;
    assert.equal(reading(T0), null, "the second call answered before the first landed");
    release();
    await first;
    assert.equal(reading(T0).session, "8%");
  });
});

describe("the reading", () => {
  it("says the time to a reset in whole days from two days out, whole hours from two hours out, minutes under that", () => {
    assert.equal(until("2026-09-19T21:00:00.000Z", T0), "5d");
    assert.equal(until(new Date(T0 + 48 * 3_600_000).toISOString(), T0), "2d");
    assert.equal(until(new Date(T0 + 48 * 3_600_000 - 1).toISOString(), T0), "47h");
    assert.equal(until("2026-09-14T19:20:00.000Z", T0), "3h");
    assert.equal(until(new Date(T0 + 120 * 60_000).toISOString(), T0), "2h");
    assert.equal(until(new Date(T0 + 119 * 60_000 + 59_000).toISOString(), T0), "119m");
    assert.equal(until(new Date(T0 + 30_000).toISOString(), T0), "0m");
    assert.equal(until(new Date(T0).toISOString(), T0), null, "a reset that is now has passed");
    assert.equal(until(undefined, T0), null);
    assert.equal(until("soon", T0), null);
  });

  it("is the three windows with their resets, the percent whole below 95 and to two decimals from there", () => {
    assert.deepEqual(format(payload(), T0), {
      session: "8%", reset: "3h", all: "86%", allReset: "5d", fable: "20%", fableReset: "5d",
      resets: { "5h": "2026-09-14T19:20:00.000Z", "7d": "2026-09-19T21:00:00.000Z", "7d fable": "2026-09-19T21:00:00.000Z" },
    });
    const near = format(payload({ session: 95.129, all: 99.5, fable: 94.5 }), T0);
    assert.equal(near.session, "95.13%");
    assert.equal(near.all, "99.5%");
    assert.equal(near.fable, "95%");
    assert.equal(format(payload({ fable: null }), T0).fable, "-", "a window the account has not got");
    assert.equal(format(payload({ fable: null }), T0).fableReset, null);
    assert.equal(format(payload({ fable: null }), T0).resets["7d fable"], null);
  });

  it("gives each window's reset moment off that window alone", () => {
    const apart = format(payload({ sessionResets: "2026-09-14T19:20:00.000Z", allResets: "2026-09-21T11:41:00.000Z", fableResets: "2026-09-15T21:11:00.000Z" }), T0);
    assert.deepEqual(apart.resets, { "5h": "2026-09-14T19:20:00.000Z", "7d": "2026-09-21T11:41:00.000Z", "7d fable": "2026-09-15T21:11:00.000Z" });
    assert.equal(format(payload({ allResets: "2026-09-14T15:00:00.000Z" }), T0).resets["7d"], null, "a reset already passed");
  });

  it("falls back on the flat keys when the limits list is not there, and is nothing when there is no reading", () => {
    const flat = payload();
    delete flat.limits;
    assert.deepEqual(format(flat, T0), {
      session: "8%", reset: "3h", all: "86%", allReset: "5d", fable: "-", fableReset: null,
      resets: { "5h": "2026-09-14T19:20:00.000Z", "7d": "2026-09-19T21:00:00.000Z", "7d fable": null },
    });
    assert.equal(format(null, T0), null);
    assert.equal(format("odd", T0), null);
  });

  it("is still the last reading once its session window has passed, with no time to that reset", () => {
    const passed = format(payload(), Date.parse("2026-09-14T19:20:00.000Z"));
    assert.equal(passed.session, "8%", "the reading was thrown away with its window");
    assert.equal(passed.reset, null);
    assert.equal(passed.resets["5h"], null);
    assert.equal(passed.all, "86%");
  });

  it("says when it was taken, and that it is old once that is more than a quarter of an hour ago", async () => {
    const instance = { root, config: { auth: "login" } };
    credentials({ claudeAiOauth: { accessToken: "token-own" } });
    assert.equal(reading(T0), null, "a reading before any was taken");
    await refresh(instance, { get: answering(), now: () => T0 });
    assert.equal(reading(T0).at, new Date(T0).toISOString());
    assert.equal(reading(T0 + OLD).old, false, "old at exactly a quarter of an hour");
    assert.equal(reading(T0 + OLD + 1).old, true);
    assert.equal(reading(T0 + OLD + 1).session, "8%", "an old reading is still the reading");
  });
});

describe("the reading kept across a restart", () => {
  const instance = { root, config: { auth: "login" } };

  before(() => {
    credentials({ claudeAiOauth: { accessToken: "token-own" } });
  });

  it("is written at the root with every answer, and taken up again by the next run with the moment it was taken", async () => {
    await refresh(instance, { get: answering(), now: () => T0 });
    const kept = JSON.parse(fs.readFileSync(path.join(root, USAGE_FILE), "utf8"));
    assert.equal(kept.fetchedAt, T0);
    assert.equal(kept.data.limits[0].percent, 8);
    reset();
    assert.equal(reading(T0), null, "a fresh run knows nothing before it reads the root");
    configure({ root });
    assert.equal(reading(T0 + 60_000).session, "8%");
    assert.equal(reading(T0 + 60_000).at, new Date(T0).toISOString());
  });

  it("is not thrown away by a failed answer, and is not rewritten by one", async () => {
    await refresh(instance, { get: answering(), now: () => T0 });
    const before = fs.readFileSync(path.join(root, USAGE_FILE), "utf8");
    await refresh(instance, { get: answering({ ok: false, status: 500 }), now: () => T0 + SPACING });
    assert.equal(fs.readFileSync(path.join(root, USAGE_FILE), "utf8"), before);
    reset();
    configure({ root });
    assert.equal(reading(T0 + SPACING).session, "8%");
  });

  it("starts from nothing when what is kept is not a reading", () => {
    fs.writeFileSync(path.join(root, USAGE_FILE), "{");
    configure({ root });
    assert.equal(reading(T0), null, "unparseable");
    fs.writeFileSync(path.join(root, USAGE_FILE), JSON.stringify({ data: { limits: [] } }));
    configure({ root });
    assert.equal(reading(T0), null, "no moment to go with it");
  });

  it("is asked for again when a page opens on a kept reading that is a minute old", async () => {
    await refresh(instance, { get: answering(), now: () => T0 });
    reset();
    configure({ root });
    const get = answering({ body: payload({ session: 9 }) });
    pageOpened(instance, { get, now: () => T0 + SPACING - 1 });
    assert.equal(get.asked.length, 0, "asked for a reading not yet a minute old");
    pageOpened(instance, { get, now: () => T0 + SPACING });
    assert.equal(get.asked.length, 1, "not asked for a kept reading a minute old");
    await settle();
    assert.equal(reading(T0 + SPACING).session, "9%");
  });
});

describe("when it is asked, and the page told", () => {
  const instance = { root, config: { auth: "login" } };
  let told;
  let unsubscribe;

  before(() => {
    credentials({ claudeAiOauth: { accessToken: "token-own" } });
  });

  beforeEach(() => {
    told = [];
    unsubscribe = subscribe((event) => {
      if (event.name === "quota") told.push(event.data);
    });
  });

  afterEach(() => {
    unsubscribe();
  });

  it("is asked for nothing on the clock while no page is open, however many sessions run, and still at a turn's end", async () => {
    const get = answering();
    pageClosed();
    tick(instance, { get, now: () => T0 });
    tick(instance, { get, now: () => T0 + POLL });
    assert.equal(get.asked.length, 0);
    assert.deepEqual(told, []);
    turnEnded(instance, { get, now: () => T0 + POLL });
    assert.equal(get.asked.length, 1, "a turn's end asked nothing with no page open");
  });

  it("is asked on the clock while a page is open, with no session running, and again every five minutes", async () => {
    const get = answering();
    tick(instance, { get, now: () => T0 });
    assert.equal(get.asked.length, 1, "not asked while a page is open");
    await settle();
    tick(instance, { get, now: () => T0 + POLL - 1 });
    assert.equal(get.asked.length, 1, "asked again before five minutes");
    tick(instance, { get, now: () => T0 + POLL });
    assert.equal(get.asked.length, 2, "not asked again at five minutes");
  });

  it("is asked on the clock until the last page has closed, and again once one opens", async () => {
    const get = answering();
    pageOpened(instance, { now: () => 0 });
    pageClosed();
    tick(instance, { get, now: () => T0 });
    assert.equal(get.asked.length, 1, "one page was still open");
    await settle();
    pageClosed();
    tick(instance, { get, now: () => T0 + POLL });
    assert.equal(get.asked.length, 1, "asked with no page open");
    pageOpened(instance, { get, now: () => T0 + POLL });
    assert.equal(get.asked.length, 2, "not asked when a page opened on a reading five minutes old");
  });

  it("is asked at a turn's end and when a page opens, once the last reading is a minute old", async () => {
    const get = answering();
    turnEnded(instance, { get, now: () => T0 });
    assert.equal(get.asked.length, 1, "not asked at a turn's end");
    await settle();
    turnEnded(instance, { get, now: () => T0 + SPACING - 1 });
    pageOpened(instance, { get, now: () => T0 + SPACING - 1 });
    assert.equal(get.asked.length, 1, "asked again within the minute");
    pageOpened(instance, { get, now: () => T0 + SPACING });
    assert.equal(get.asked.length, 2, "not asked when a page opened a minute on");
    await settle();
    turnEnded(instance, { get, now: () => T0 + 2 * SPACING });
    assert.equal(get.asked.length, 3, "not asked at a turn's end a minute on");
  });

  it("leaves a failure alone for the backoff, at a turn's end and a page opening too", async () => {
    const down = answering({ fails: "fetch failed" });
    sink(() => {});
    try {
      turnEnded(instance, { get: down, now: () => T0 });
      await settle();
    } finally {
      sink(null);
    }
    turnEnded(instance, { get: down, now: () => T0 + BACKOFF - 1 });
    pageOpened(instance, { get: down, now: () => T0 + BACKOFF - 1 });
    tick(instance, { get: down, now: () => T0 + BACKOFF - 1 });
    assert.equal(down.asked.length, 1, "asked again before the backoff passed");
  });

  it("is told the reading once it is in, again when its words change, and not for a tick that says the same", async () => {
    const get = answering();
    tick(instance, { get, now: () => T0 });
    assert.equal(get.asked.length, 1);
    await settle();
    assert.equal(told.length, 1, "not told once the answer landed");
    assert.equal(told[0].reset, "3h");
    assert.equal(told[0].at, new Date(T0).toISOString());
    tick(instance, { get, now: () => T0 + 30_000 });
    assert.equal(told.length, 1, "told a reading that says what the last one said");
    tick(instance, { get, now: () => T0 + POLL });
    assert.equal(get.asked.length, 2);
    await settle();
    assert.equal(told.length, 2, "not told a fresh reading, whose moment is new");
    assert.equal(told[1].at, new Date(T0 + POLL).toISOString());
    tick(instance, { get, now: () => T0 + POLL + 100_000 });
    assert.equal(told.length, 2, "told a tick with nothing new");
  });

  it("is told when the reading turns old, and when the time to its reset moved", async () => {
    const get = answering();
    tick(instance, { get, now: () => T0 });
    await settle();
    assert.equal(told.at(-1).old, false);
    pageClosed();
    tick(instance, { get, now: () => T0 + OLD });
    assert.equal(told.length, 1, "told at exactly a quarter of an hour");
    tick(instance, { get, now: () => T0 + OLD + 1 });
    assert.equal(told.length, 2, "not told when the reading turned old");
    assert.equal(told[1].old, true);
    assert.equal(told[1].session, "8%");
  });

  it("is told the reading whose session window has passed as it stands, with no time to that reset, once", async () => {
    const get = answering();
    tick(instance, { get, now: () => T0 });
    await settle();
    assert.equal(told.length, 1);
    pageClosed();
    tick(instance, { get, now: () => Date.parse("2026-09-14T19:20:00.000Z") });
    tick(instance, { get, now: () => Date.parse("2026-09-14T19:21:00.000Z") });
    assert.equal(told.length, 2);
    assert.equal(told[1].reset, null);
    assert.equal(told[1].session, "8%", "the reading went with its window");
    assert.equal(told[1].old, true);
  });
});
