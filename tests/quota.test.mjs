// The quota gate's readings, stages and holds, checked as pure functions over an injected clock.
//
// What a child says about the account's windows arrives as `rate_limit_event` frames, and the
// weekly window of the one model that has its own arrives from the usage endpoint (see
// tests/usage.test.mjs for the hand-over); this module keeps the newest reading per window, turns
// it into a stage against the instance's thresholds, and says whether a write, a start or a hire
// may go. Nothing here spawns or writes stdin — the
// checks that the gate is wired in front of the real acts are in tests/lifecycle.test.mjs.
//
// Every mutation in tests/mutations-quota.json names the check it was written to redden.

import assert from "node:assert/strict";
import { describe, it } from "node:test";


import {
  hhmm,
  DEFAULT_THRESHOLDS,
  FABLE_WINDOW,
  configure,
  held,
  hold,
  holdsHire,
  mayStart,
  mayWrite,
  onStage,
  releasedBy,
  reset,
  saw,
  stageOf,
  standing,
  thresholdsIn,
  windowsFor,
} from "../lib/chat/quota.mjs";

const T0 = Date.parse("2026-09-12T20:00:00+02:00");
const RESET_5H = Date.parse("2026-09-12T23:00:00+02:00");
const RESET_7D = Date.parse("2026-09-16T09:00:00+02:00");

// A reading the way the frame carries it: `resetsAt` in epoch SECONDS (measured 2026-09-12 on a
// real fable run: 1789249800), one entry per window, each with its own reset. The frame never
// carries fable's own window; a test that needs one adds it under FABLE_WINDOW, the way usage.mjs
// hands it in (utilization a fraction, the reset in milliseconds).
function reading(fiveHour, sevenDay = 0.5, extra = {}, resets = RESET_5H) {
  return {
    status: "allowed",
    resetsAt: resets / 1000,
    rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { utilization: fiveHour, resetsAt: resets / 1000 },
      seven_day: { utilization: sevenDay, resetsAt: RESET_7D / 1000 },
      ...extra,
    },
  };
}

function fable(utilization) {
  return { [FABLE_WINDOW]: { utilization, resetsAt: RESET_7D } };
}

function fresh(config = {}) {
  reset();
  let now = T0;
  const clock = () => now;
  configure({ config, clock });
  return {
    at(when) {
      now = when;
    },
  };
}

describe("the thresholds", () => {
  it("default to 90/95 on 5h and 97/99 on 7d, and there are no others", () => {
    assert.deepEqual(thresholdsIn({}), DEFAULT_THRESHOLDS);
    assert.deepEqual(thresholdsIn({}), { "5h": [90, 95], "7d": [97, 99] });
  });

  it("take the instance's own per window and keep the defaults for the rest", () => {
    const merged = thresholdsIn({ quota: { "5h": [50, 60] } });
    assert.deepEqual(merged["5h"], [50, 60]);
    assert.deepEqual(merged["7d"], [97, 99]);
  });

  it("hold every weekly window against the one 7d pair: the account's and fable's own alike, the default and the instance's", () => {
    fresh();
    saw("usage", null, reading(0.5, 0.5, fable(0.98)));
    assert.equal(stageOf(FABLE_WINDOW), "warning");
    assert.equal(stageOf("seven_day"), null);
    saw("usage", null, reading(0.5, 0.5, fable(0.99)));
    assert.equal(stageOf(FABLE_WINDOW), "critical");
    fresh({ quota: { "7d": [50, 60], "7d-fable": [10, 20] } });
    saw("usage", null, reading(0.5, 0.55, fable(0.55)));
    assert.equal(stageOf("seven_day"), "warning", "the instance's 7d pair on the account's window");
    assert.equal(stageOf(FABLE_WINDOW), "warning", "the same pair on fable's own");
    saw("usage", null, reading(0.5, 0.15, fable(0.15)));
    assert.equal(stageOf(FABLE_WINDOW), null, "a 7d-fable key is not a threshold of anything");
  });

  it("apply per window: 0.91 is a warning on 5h and nothing on 7d", () => {
    fresh();
    saw("Paul", "opus", reading(0.5, 0.91));
    assert.equal(stageOf("seven_day"), null);
    saw("Paul", "opus", reading(0.91, 0.5));
    assert.equal(stageOf("five_hour"), "warning");
  });

  it("are inclusive: exactly 0.90 on 5h is a warning and exactly 0.95 is critical", () => {
    fresh();
    saw("Paul", "opus", reading(0.9));
    assert.equal(stageOf("five_hour"), "warning");
    saw("Paul", "opus", reading(0.95));
    assert.equal(stageOf("five_hour"), "critical");
  });

  it("7d reaches warning at 0.98 and critical at 0.99", () => {
    fresh();
    saw("Paul", "opus", reading(0.5, 0.98));
    assert.equal(stageOf("seven_day"), "warning");
    saw("Paul", "opus", reading(0.5, 0.99));
    assert.equal(stageOf("seven_day"), "critical");
  });
});

describe("the readings", () => {
  it("keep the newest per window", () => {
    fresh();
    saw("Paul", "opus", reading(0.5));
    saw("Paul", "opus", reading(0.91));
    assert.equal(standing().five_hour.utilization, 0.91);
  });

  it("take each window's own reset, never the outer one", () => {
    fresh();
    saw("Paul", "opus", reading(0.5));
    assert.equal(standing().seven_day.resetsAt, new Date(RESET_7D).toISOString());
    assert.equal(standing().five_hour.resetsAt, new Date(RESET_5H).toISOString());
  });

  it("say the reset as hh:mm on the server's clock too, and the window as configured", () => {
    fresh();
    saw("Paul", "opus", reading(0.5));
    assert.equal(hhmm(RESET_5H), new Date(RESET_5H).toTimeString().slice(0, 5));
    assert.equal(standing().five_hour.resets, hhmm(RESET_5H));
    assert.equal(standing().five_hour.key, "5h");
    assert.equal(standing().seven_day.key, "7d");
    assert.equal(hhmm(new Date(RESET_5H).toISOString()), hhmm(RESET_5H));
  });

  it("read the reset as seconds and say it as a moment", () => {
    fresh();
    saw("Paul", "opus", reading(0.5));
    assert.equal(Date.parse(standing().five_hour.resetsAt), RESET_5H);
  });

  it("skip a window without a numeric utilization", () => {
    fresh();
    saw("Paul", "opus", reading(0.5, 0.5, { odd: { resetsAt: 1 } }));
    assert.equal(standing().odd, undefined);
  });

  it("say who reported the reading and when", () => {
    const clock = fresh();
    clock.at(T0 + 5000);
    saw("Ann", "sonnet", reading(0.5));
    assert.equal(standing().five_hour.from, "Ann");
    assert.equal(standing().five_hour.at, new Date(T0 + 5000).toISOString());
  });

  it("expire once the window's reset has passed", () => {
    const clock = fresh();
    saw("Paul", "opus", reading(0.96));
    assert.equal(stageOf("five_hour"), "critical");
    clock.at(RESET_5H);
    assert.equal(stageOf("five_hour"), null);
    assert.equal(mayWrite("Paul", "opus"), null);
  });
});

describe("the gate", () => {
  it("passes at stage one and holds at stage two", () => {
    fresh();
    saw("Paul", "opus", reading(0.91));
    assert.equal(mayWrite("Paul", "opus"), null);
    saw("Paul", "opus", reading(0.96));
    assert.deepEqual(mayWrite("Paul", "opus"), { window: "5h", resets: new Date(RESET_5H).toISOString() });
  });

  it("holds a start at stage two only", () => {
    fresh();
    saw("Paul", "opus", reading(0.91));
    assert.equal(mayStart("sonnet"), null);
    saw("Paul", "opus", reading(0.96));
    assert.equal(mayStart("sonnet")?.window, "5h");
  });

  it("holds a hire from stage one", () => {
    fresh();
    saw("Paul", "opus", reading(0.5));
    assert.equal(holdsHire("sonnet"), null);
    saw("Paul", "opus", reading(0.91));
    assert.equal(holdsHire("sonnet")?.window, "5h");
  });

  it("closes a window on rejected whatever the utilization", () => {
    const clock = fresh();
    saw("Paul", "opus", { ...reading(0.8), status: "rejected", rateLimitType: "five_hour" });
    assert.equal(stageOf("five_hour"), "critical");
    assert.equal(mayWrite("Paul", "opus")?.window, "5h");
    clock.at(RESET_5H);
    assert.equal(mayWrite("Paul", "opus"), null);
  });

  it("closes the window the rejection names and not another", () => {
    fresh();
    saw("Paul", "opus", { ...reading(0.5, 0.5), status: "rejected", rateLimitType: "seven_day" });
    assert.equal(stageOf("seven_day"), "critical");
    assert.equal(stageOf("five_hour"), null);
  });

  it("names the window with the earliest reset when two hold", () => {
    fresh();
    saw("Paul", "opus", reading(0.96, 0.99));
    assert.equal(mayWrite("Paul", "opus").window, "5h");
  });
});

describe("fable's own window", () => {
  it("is read on a fresh instance with nothing configured, and applies to fable models only", () => {
    fresh();
    assert.equal(FABLE_WINDOW, "seven_day_fable");
    assert.deepEqual(windowsFor("fable"), ["five_hour", "seven_day", FABLE_WINDOW]);
    assert.deepEqual(windowsFor("Fable"), ["five_hour", "seven_day", FABLE_WINDOW]);
    assert.deepEqual(windowsFor("opus"), ["five_hour", "seven_day"]);
    saw("usage", null, reading(0.5, 0.5, fable(0.99)));
    assert.equal(mayWrite("Zed", "fable")?.window, "7d-fable");
    assert.equal(mayWrite("Paul", "opus"), null);
    assert.equal(holdsHire("fable")?.window, "7d-fable");
    assert.equal(holdsHire("opus"), null);
    assert.equal(standing()[FABLE_WINDOW].key, "7d-fable");
  });

  it("at the second stage nothing more runs on fable until it resets, and from the first no fable Worker is hired", () => {
    const clock = fresh();
    saw("usage", null, reading(0.5, 0.5, fable(0.97)));
    assert.equal(mayStart("fable"), null, "the first stage lets a fable start through");
    assert.equal(holdsHire("fable")?.window, "7d-fable");
    saw("usage", null, reading(0.5, 0.5, fable(0.99)));
    assert.deepEqual(mayStart("fable"), { window: "7d-fable", resets: new Date(RESET_7D).toISOString() });
    assert.deepEqual(mayWrite("Zed", "fable"), { window: "7d-fable", resets: new Date(RESET_7D).toISOString() });
    assert.equal(mayStart("opus"), null, "another model is not held by fable's window");
    assert.equal(mayStart("sonnet"), null);
    clock.at(RESET_7D);
    assert.equal(mayStart("fable"), null, "let go once the window has reset");
  });
});

describe("a stage crossing", () => {
  it("fires once per crossing upward", () => {
    fresh();
    const fired = [];
    onStage((window, stage, resets, model) => fired.push([window, stage, resets, model]));
    saw("Paul", "opus", reading(0.91));
    saw("Paul", "opus", reading(0.92));
    assert.deepEqual(fired, [["5h", "warning", new Date(RESET_5H).toISOString(), null]]);
    saw("Paul", "opus", reading(0.96));
    assert.equal(fired.length, 2);
    assert.deepEqual(fired[1].slice(0, 2), ["5h", "critical"]);
  });

  it("re-arms once the reset has passed", () => {
    const clock = fresh();
    const fired = [];
    onStage((window, stage) => fired.push([window, stage]));
    saw("Paul", "opus", reading(0.91));
    clock.at(RESET_5H + 1);
    saw("Paul", "opus", reading(0.91, 0.5, {}, RESET_5H + 5 * 3600 * 1000));
    assert.deepEqual(fired, [
      ["5h", "warning"],
      ["5h", "warning"],
    ]);
  });

  it("a reading past its reset fires nothing", () => {
    const clock = fresh();
    const fired = [];
    onStage((window, stage) => fired.push([window, stage]));
    clock.at(RESET_5H + 1);
    saw("Paul", "opus", reading(0.96));
    assert.deepEqual(fired, []);
  });

  it("names the model for fable's own window and no model for the account's", () => {
    fresh();
    const fired = [];
    onStage((window, stage, resets, model) => fired.push([window, stage, model]));
    saw("usage", null, reading(0.5, 0.98, fable(0.98)));
    assert.deepEqual(fired, [["7d", "warning", null], ["7d-fable", "warning", "fable"]]);
  });

  it("can be unsubscribed", () => {
    fresh();
    const fired = [];
    const off = onStage((window) => fired.push(window));
    off();
    saw("Paul", "opus", reading(0.91));
    assert.deepEqual(fired, []);
  });
});

describe("the held list", () => {
  it("keeps frames per seat in arrival order and releases them once the window has reset", () => {
    const clock = fresh();
    saw("Paul", "opus", reading(0.96));
    hold("Paul", { frame: "one", window: "5h" });
    hold("Leader", { frame: "two", window: "5h" });
    hold("Paul", { frame: "three", window: "5h" });
    assert.deepEqual(held("Paul").map((entry) => entry.frame), ["one", "three"]);
    assert.deepEqual(releasedBy(), []);
    clock.at(RESET_5H);
    const released = releasedBy();
    assert.deepEqual(released.map((entry) => [entry.seat, entry.frame]), [
      ["Paul", "one"],
      ["Leader", "two"],
      ["Paul", "three"],
    ]);
    assert.deepEqual(held("Paul"), []);
  });

  it("releases only what the passed window held", () => {
    const clock = fresh();
    saw("Paul", "opus", reading(0.96, 0.99));
    hold("Paul", { frame: "five", window: "5h" });
    hold("Paul", { frame: "seven", window: "7d" });
    clock.at(RESET_5H);
    assert.deepEqual(releasedBy().map((entry) => entry.frame), ["five"]);
    assert.deepEqual(held("Paul").map((entry) => entry.frame), ["seven"]);
  });

  it("holds a fable frame by fable's own window, not by the account's weekly one", () => {
    const clock = fresh();
    saw("usage", null, reading(0.5, 0.5, { [FABLE_WINDOW]: { utilization: 0.99, resetsAt: RESET_7D - 60_000 } }));
    saw("Paul", "opus", reading(0.5, 0.99));
    assert.equal(mayWrite("Zed", "fable").window, "7d-fable");
    assert.equal(mayWrite("Paul", "opus").window, "7d");
    hold("Zed", { frame: "fable-turn", window: mayWrite("Zed", "fable").window });
    hold("Paul", { frame: "opus-turn", window: mayWrite("Paul", "opus").window });
    clock.at(RESET_7D - 60_000);
    assert.deepEqual(releasedBy().map((entry) => entry.frame), ["fable-turn"], "fable's window reset; the account's has not");
    assert.deepEqual(held("Paul").map((entry) => entry.frame), ["opus-turn"]);
  });
});
