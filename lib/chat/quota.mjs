// The quota gate: what the account's windows stand at, and what that allows.
//
// Every process this server runs says, on its own stdout, how full the account's usage windows
// are: a `rate_limit_event` frame with one entry per window, each carrying a `utilization` and
// its own `resetsAt`, emitted whenever the reading changes (so a run that spends a window sends
// several, and the newest is the one that is true). This module keeps that newest reading per
// window, turns it into a stage against the instance's thresholds, and answers three questions
// that everything else asks before acting: may a frame be written to this seat, may a process be
// started on this model, may somebody be hired.
//
// Two stages per window. From the FIRST the gate is armed and hiring is refused; at the SECOND —
// or on a `rejected` status, whatever the number — writes and starts are held. A held frame is
// kept here, per seat, until the window's reset passes; the server decides what is released and
// in what order. A window whose reset has passed is forgotten: nobody has spent anything in the
// new window yet, and the first frame of the next turn says where it stands.
//
// Pure over an injected clock. Nothing here touches a process or a file, so every threshold,
// crossing and release is checkable to the millisecond in tests/quota.test.mjs.
//
// Measured 2026-09-12 on a real fable run (claude 2.1.270): the frame carried `five_hour`,
// `seven_day` and `seven_day_overage_included`; `utilization` is a fraction (0.7, 0.55, 0.19), so
// the thresholds below compare against it times a hundred; `resetsAt` is in epoch SECONDS
// (1789249800), and each window's own is the one read — never the outer one beside `status`,
// which is the reset of the one window the frame is about. No window scoped to a model was on the
// frame, so the per-model window has no wire name until one is measured (see FABLE_WINDOW).

import { publish } from "./events.mjs";

// The windows the frame names, and the key each is configured under. Only these two are read
// as windows of the account; anything else on the frame is kept for the standing and gates
// nothing.
const WINDOWS = Object.freeze({
  five_hour: "5h",
  seven_day: "7d",
});

// The per-model window. The target gates fable on its own weekly window; the frame this server
// reads has never carried one (not found on the run above), so it gates nothing until the
// instance names it — `quota.windows["7d-fable"]` in openovai.json — and the server says so once
// at start. It applies to the models its pattern names and to no other.
export const FABLE_WINDOW = Object.freeze({ key: "7d-fable", wire: null, models: /fable/i });

// Percent of the window at which the first stage (warning) and the second (critical) begin.
export const DEFAULT_THRESHOLDS = Object.freeze({
  "5h": [90, 95],
  "7d": [95, 97],
  "7d-fable": [95, 97],
});

export const WARNING = "warning";
export const CRITICAL = "critical";

const STAGES = [null, WARNING, CRITICAL];

export function thresholdsIn(config) {
  const own = config?.quota ?? {};
  const merged = {};
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    const given = own[key];
    merged[key] =
      Array.isArray(given) && given.length === 2 && given.every((n) => typeof n === "number") ? [...given] : [...DEFAULT_THRESHOLDS[key]];
  }
  return merged;
}

// ---------------------------------------------------------------------------------------- state

let clock = Date.now;
let thresholds = thresholdsIn({});
// wire name -> config key, for every window that gates: the two of the account and, when the
// instance named it, the per-model one.
let keyed = { ...WINDOWS };
let fableWire = null;

// wire name -> { utilization, resetsAt (ms), at (ms), from, rejected }
const readings = new Map();
// config key -> the stage last announced for it, with the reset it was announced against.
const announced = new Map();
const listeners = new Set();
// seat -> [{ ...entry, seat, at, window }]
const heldBySeat = new Map();
let arrivals = 0;

export function configure({ config = {}, clock: now = Date.now } = {}) {
  clock = now;
  thresholds = thresholdsIn(config);
  fableWire = typeof config?.quota?.windows?.[FABLE_WINDOW.key] === "string" ? config.quota.windows[FABLE_WINDOW.key] : null;
  keyed = { ...WINDOWS, ...(fableWire === null ? {} : { [fableWire]: FABLE_WINDOW.key }) };
}

// Forget every reading, crossing and hold, keeping the configuration and the listeners: for a
// suite that moves between windows.
export function forget() {
  readings.clear();
  announced.clear();
  heldBySeat.clear();
  arrivals = 0;
}

export function reset() {
  readings.clear();
  announced.clear();
  listeners.clear();
  heldBySeat.clear();
  arrivals = 0;
  lastTold = null;
  configure();
}

// Whether the per-model window is gated at all — the server says so once at start when it is not.
export function fableWindowName() {
  return fableWire;
}

// ------------------------------------------------------------------------------------- readings

// Epoch seconds on the wire; milliseconds everywhere here. A value already in milliseconds is
// left alone, so a frame that ever changes unit does not put every reset in the year 58000.
function moment(resetsAt) {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) {
    return null;
  }
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

// When a window resets, as the page says it: hh:mm on the clock of the machine the server runs
// on, which is the User's own — the page is loopback. Takes what the readings hold (milliseconds)
// and what the gates answer (ISO-8601) alike.
export function hhmm(resets) {
  const at = new Date(resets);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function current(window, now) {
  const reading = readings.get(window);
  if (reading === undefined || reading.resetsAt === null || reading.resetsAt <= now) {
    return null;
  }
  return reading;
}

// The stage a window is at now: null, warning or critical. A reading whose reset has passed is
// no reading at all.
export function stageOf(window, now = clock()) {
  const reading = current(window, now);
  const key = keyed[window];
  if (reading === null || key === undefined) {
    return null;
  }
  if (reading.rejected) {
    return CRITICAL;
  }
  const [warning, critical] = thresholds[key];
  // Rounded before the comparison: 0.57 * 100 is 56.99999999999999 in floating point, and a
  // threshold met exactly is met.
  const percent = Math.round(reading.utilization * 1e6) / 1e4;
  if (percent >= critical) {
    return CRITICAL;
  }
  if (percent >= warning) {
    return WARNING;
  }
  return null;
}

// Take one reading, as the frame carried it. Keeps the newest per window, closes the window a
// rejection names, and announces every window that crossed a stage upward — once per crossing,
// re-armed when the window's reset passes.
export function saw(seat, model, info, now = clock()) {
  const named = info?.unifiedWindows;
  if (named !== null && typeof named === "object") {
    for (const [window, entry] of Object.entries(named)) {
      if (typeof entry?.utilization !== "number") {
        continue;
      }
      readings.set(window, {
        utilization: entry.utilization,
        resetsAt: moment(entry.resetsAt),
        at: now,
        from: seat,
        rejected: false,
      });
    }
  }
  if (info?.status === "rejected" && typeof info.rateLimitType === "string") {
    const window = info.rateLimitType;
    const kept = readings.get(window);
    const resetsAt = moment(info.resetsAt) ?? kept?.resetsAt ?? null;
    readings.set(window, {
      utilization: kept?.utilization ?? 1,
      resetsAt,
      at: now,
      from: seat,
      rejected: true,
    });
  }
  const fired = announce(now);
  tellThePage(now);
  return fired;
}

// The page is told the standing whenever a reading changed it — the same object GET /sessions
// carries — and not for a reading that says what the last one said (when it was read aside).
let lastTold = null;

function tellThePage(now) {
  const said = standing(now);
  const worth = JSON.stringify(said, (key, value) => (key === "at" ? undefined : value));
  if (worth !== lastTold) {
    lastTold = worth;
    publish("standing", said);
  }
}

function announce(now) {
  const fired = [];
  for (const [window, key] of Object.entries(keyed)) {
    const reading = current(window, now);
    const before = announced.get(key);
    if (before !== undefined && (reading === null || before.resetsAt !== reading.resetsAt)) {
      // The window it was announced against is over: armed again.
      announced.delete(key);
    }
    const stage = stageOf(window, now);
    if (stage === null) {
      continue;
    }
    const last = announced.get(key)?.stage ?? null;
    if (STAGES.indexOf(stage) <= STAGES.indexOf(last)) {
      continue;
    }
    announced.set(key, { stage, resetsAt: reading.resetsAt });
    const resets = new Date(reading.resetsAt).toISOString();
    const model = key === FABLE_WINDOW.key ? "fable" : null;
    fired.push([key, stage, resets, model]);
    for (const listener of listeners) {
      listener(key, stage, resets, model);
    }
  }
  return fired;
}

// Called with (window key, stage, resets as ISO-8601, model or null) on every upward crossing.
export function onStage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Every window seen, by wire name, for the room and the page.
export function standing(now = clock()) {
  const said = {};
  for (const [window, reading] of readings) {
    said[window] = {
      // The window as configured (5h, 7d), when it is one of the account's; the wire name else.
      key: keyed[window] ?? window,
      utilization: reading.utilization,
      resetsAt: reading.resetsAt === null ? null : new Date(reading.resetsAt).toISOString(),
      resets: reading.resetsAt === null ? null : hhmm(reading.resetsAt),
      at: new Date(reading.at).toISOString(),
      from: reading.from,
      ...(reading.rejected ? { rejected: true } : {}),
      stage: stageOf(window, now),
    };
  }
  return said;
}

// ----------------------------------------------------------------------------------------- gates

// The windows a model is subject to: the account's two, and the per-model one when it has a wire
// name and the model is one it names.
export function windowsFor(model) {
  const applies = fableWire !== null && FABLE_WINDOW.models.test(String(model ?? ""));
  return [...Object.keys(WINDOWS), ...(applies ? [fableWire] : [])];
}

// Whether a window (config key) is one this model is subject to.
export function appliesTo(model, key) {
  return windowsFor(model).some((window) => keyed[window] === key);
}

// The first window of a model's that is at or past the stage asked, as { window (config key),
// resets (ISO-8601) } — the earliest reset first when several are — or null when none is.
function holdOn(model, stage, now) {
  const holding = windowsFor(model)
    .filter((window) => STAGES.indexOf(stageOf(window, now)) >= STAGES.indexOf(stage))
    .map((window) => ({ window: keyed[window], resetsAt: current(window, now).resetsAt }))
    .sort((a, b) => a.resetsAt - b.resetsAt);
  if (holding.length === 0) {
    return null;
  }
  return { window: holding[0].window, resets: new Date(holding[0].resetsAt).toISOString() };
}

// Whether a frame to this seat is held: at the second stage, or on a rejection. The seat's model
// is what the caller knows; the gate is per model.
export function mayWrite(seat, model, now = clock()) {
  return holdOn(model, CRITICAL, now);
}

// Whether a process may be started on this model — the helper, a spawn. The same criterion.
export function mayStart(model, now = clock()) {
  return holdOn(model, CRITICAL, now);
}

// Whether a hire is refused: from the first stage on.
export function holdsHire(model, now = clock()) {
  return holdOn(model, WARNING, now);
}

// --------------------------------------------------------------------------------- the held list

// A frame the gate held, kept beside the window that held it. Released — in arrival order, the
// entry's own `order` when the caller numbers arrivals, else the order held here; the caller
// choosing the order across seats — once that window's reset has passed.
export function hold(seat, entry, now = clock()) {
  arrivals += 1;
  const kept = { ...entry, seat, at: now, order: entry.order ?? arrivals };
  heldBySeat.set(seat, [...(heldBySeat.get(seat) ?? []), kept]);
  return kept;
}

export function held(seat) {
  return [...(heldBySeat.get(seat) ?? [])];
}

export function heldSeats() {
  return [...heldBySeat.keys()].filter((seat) => heldBySeat.get(seat).length > 0);
}

// Whether the window (config key) a hold named is still holding.
function stillHolding(key, now) {
  for (const [window, of] of Object.entries(keyed)) {
    if (of === key && stageOf(window, now) === CRITICAL) {
      return true;
    }
  }
  return false;
}

// Every held entry whose window has let go, taken off the list, in the order they arrived.
export function releasedBy(now = clock()) {
  const released = [];
  for (const [seat, entries] of heldBySeat) {
    const staying = [];
    for (const entry of entries) {
      if (stillHolding(entry.window, now)) {
        staying.push(entry);
      } else {
        released.push(entry);
      }
    }
    heldBySeat.set(seat, staying);
  }
  return released.sort((a, b) => a.order - b.order);
}
