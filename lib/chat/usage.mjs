// The account's usage windows, as the head shows them: the session window with the time to its
// reset, the weekly window over every model, and the weekly window of the one model that has its
// own — three percentages read at a glance. The third is also the quota gate's only source for
// that window — the frames every process writes carry the account's two and nothing scoped to a
// model — so every answer taken here is handed to the gate (quota.mjs), which holds it at the
// same weekly thresholds as the window over every model.
//
// Source: this server asks the account's usage endpoint directly, with the instance's own
// credential — the token Claude Code keeps in the instance's home, or the machine's token when
// the instance was installed to inherit it. There is deliberately no other source: the one file
// read back is the instance's own `usage.json`, holding this server's own last answer, and no other
// cache — another tool's, another account's — is ever read, since a number from another account's
// cache is worse than an empty line. The token is read at call time, used in one header, never
// kept, never logged, never put in an error.
//
// The reading is the head's whether or not any session runs, and it survives a restart: the last
// answer and the moment it was taken are kept in `usage.json` at the instance root. It is drawn
// dimmed once it is a quarter of an hour old, and its age is the tooltip's.
//
// Asked every five minutes while at least one page is open, and when a page opens and at a turn's
// end, once the last reading is a minute old; with no page open the clock asks nothing. After any
// failure, not again for five minutes.

import fs from "node:fs";
import path from "node:path";

import { home } from "../claude.mjs";
import { publish } from "./events.mjs";
import { log } from "./log.mjs";
import { FABLE_WINDOW, saw } from "./quota.mjs";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CREDENTIALS_FILE = ".credentials.json";
export const MACHINE_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

// Where the last reading is kept, at the instance root beside runtime.json.
export const USAGE_FILE = "usage.json";

// How old the reading may get before the clock asks again, how old before a turn's end or a page
// opening asks again, how long a failure is left alone, and how old a reading is drawn dimmed.
export const POLL = 5 * 60_000;
export const SPACING = 60_000;
export const BACKOFF = 5 * 60_000;
export const OLD = 15 * 60_000;
const TIMEOUT = 10_000;

let live = { data: null, fetchedAt: 0, nextAt: 0, inFlight: false };
let lastTold = "null";
let configured = { version: "unknown" };
// How many pages have a stream open: the clock asks only while somebody is looking.
let pages = 0;

// Back to nothing read; for a suite that asks several times.
export function reset() {
  live = { data: null, fetchedAt: 0, nextAt: 0, inFlight: false };
  lastTold = "null";
  configured = { version: "unknown" };
  pages = 0;
}

// The Claude Code version every request names, and the reading the last run kept, both set once
// when the server is armed.
export function configure({ version = "unknown", root = null } = {}) {
  configured = { version };
  if (root !== null) {
    recall(root);
  }
}

// The reading kept at the root, when there is a usable one; nothing otherwise.
function recall(root) {
  try {
    const kept = JSON.parse(fs.readFileSync(path.join(root, USAGE_FILE), "utf8"));
    if (kept !== null && typeof kept.data === "object" && kept.data !== null && Number.isFinite(kept.fetchedAt)) {
      live = { ...live, data: kept.data, fetchedAt: kept.fetchedAt };
    }
  } catch {
    // none kept, or not readable: the first answer makes one
  }
}

// The reading just taken, written down; a failure to write costs the restart its reading and
// nothing else.
function keep(root, data, fetchedAt) {
  try {
    fs.writeFileSync(path.join(root, USAGE_FILE), `${JSON.stringify({ fetchedAt, data })}\n`);
  } catch (error) {
    log("usage", null, null, `the reading was not kept — ${error.message}`);
  }
}

// The token, or null: the machine's when the instance inherits it, else the one in the
// instance's home — skipped once its own expiry has passed, since Claude Code refreshes it.
export function token(root, auth, env = process.env, now = Date.now()) {
  if (auth === "inherit") {
    const value = env[MACHINE_TOKEN];
    return typeof value === "string" && value !== "" ? value : null;
  }
  try {
    const kept = JSON.parse(fs.readFileSync(path.join(home(root), CREDENTIALS_FILE), "utf8"))?.claudeAiOauth;
    if (typeof kept?.accessToken !== "string" || kept.accessToken === "") {
      return null;
    }
    return typeof kept.expiresAt === "number" && kept.expiresAt <= now ? null : kept.accessToken;
  } catch {
    return null;
  }
}

// Why there is no token, as the log says it: the machine's variable unset, or no token that has not
// expired in the instance's home. On a Mac that is the usual case rather than a fault: Claude Code
// keeps the sign-in in the Keychain, which ovai does not read, so the usage line stays empty there.
export function noToken(auth, platform = process.platform) {
  if (auth === "inherit") {
    return `${MACHINE_TOKEN} is not set, so there is no usage reading`;
  }
  const why = `there is no unexpired token in ${CREDENTIALS_FILE} in the instance's Claude Code home, so there is no usage reading`;
  return platform === "darwin" ? `${why}: on a Mac, Claude Code keeps the sign-in in the Keychain, which ovai does not read` : why;
}

// One request, when a token is there. `get` is fetch; the suite hands in its own. Without one, why
// is said once, and not again until a token has been read.
export async function refresh(instance, { get = fetch, now = Date.now, version = configured.version, platform = process.platform } = {}) {
  if (live.inFlight) {
    return;
  }
  const bearer = token(instance.root, instance.config?.auth, process.env, now());
  if (bearer === null) {
    live.nextAt = now() + BACKOFF;
    if (!live.saidNoToken) {
      live.saidNoToken = true;
      log("usage", null, null, noToken(instance.config?.auth, platform));
    }
    return;
  }
  live.saidNoToken = false;
  live.inFlight = true;
  try {
    const answered = await get(USAGE_URL, {
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": `claude-code/${version}`,
        authorization: `Bearer ${bearer}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!answered.ok) {
      const retry = Number.parseInt(answered.headers.get("retry-after") ?? "", 10);
      live.nextAt = now() + Math.max(BACKOFF, retry > 0 ? retry * 1000 : 0);
      log("usage", null, null, `the endpoint answered ${answered.status}, asked again in ${Math.round((live.nextAt - now()) / 1000)}s`);
      return;
    }
    live = { data: await answered.json(), fetchedAt: now(), nextAt: 0, inFlight: false };
    keep(instance.root, live.data, live.fetchedAt);
    gate(live.data, now());
  } catch (error) {
    live.nextAt = now() + BACKOFF;
    log("usage", null, null, `the endpoint was not reached — ${error.message}`);
  } finally {
    live.inFlight = false;
  }
}

// The weekly window of the model named fable, off the limits list, or undefined when the account
// has none.
function fableLimit(data) {
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  return limits.find((limit) => limit.kind === "weekly_scoped" && /fable/i.test(limit.scope?.model?.display_name ?? ""));
}

// Fable's own window, to the gate, the way a frame would carry it: the percent as a fraction,
// the reset as a moment, the source named. The account's two are not handed over — the frames
// say those with every turn, and one source per window keeps a reading from arguing with itself.
function gate(data, now) {
  const fable = fableLimit(data);
  if (fable === undefined || typeof fable.percent !== "number") {
    return;
  }
  saw("usage", null, { unifiedWindows: { [FABLE_WINDOW]: { utilization: fable.percent / 100, resetsAt: Date.parse(fable.resets_at ?? "") } } }, now);
}

// A percentage as the head says it: whole below 95; at 95 and above the last points matter, so
// two decimals, trailing zeros dropped. A window the account has not got is a dash.
function percent(value) {
  if (typeof value !== "number") {
    return "-";
  }
  return value < 95 ? `${Math.round(value)}%` : `${Math.round(value * 100) / 100}%`;
}

// The time to a reset, as the head says it: whole days from two days out, whole hours from two
// hours out, minutes under that. Null for a reset not given or already passed.
export function until(resetsAt, now) {
  const at = Date.parse(resetsAt ?? "");
  if (!at || at <= now) {
    return null;
  }
  const minutes = Math.floor((at - now) / 60_000);
  if (minutes >= 48 * 60) {
    return `${Math.floor(minutes / (24 * 60))}d`;
  }
  return minutes >= 120 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`;
}

// The moment a reset comes, as a stamp, or null for a reset not given or already passed.
function moment(resetsAt, now) {
  const at = Date.parse(resetsAt ?? "");
  return !at || at <= now ? null : new Date(at).toISOString();
}

// The reading as the page draws it, or null when there is none. A window whose reset has passed
// is still drawn, with no time to its reset: the last reading is the last one, and its age says
// how far to trust it. Each window's reset moment is read off that window alone: they need not
// fall together.
export function format(data, now = Date.now()) {
  if (data === null || typeof data !== "object") {
    return null;
  }
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const session = limits.find((limit) => limit.kind === "session");
  const week = limits.find((limit) => limit.kind === "weekly_all");
  const fable = fableLimit(data);
  const sessionResets = session?.resets_at ?? data.five_hour?.resets_at;
  const weekResets = week?.resets_at ?? data.seven_day?.resets_at;
  return {
    session: percent(session?.percent ?? data.five_hour?.utilization),
    reset: until(sessionResets, now),
    all: percent(week?.percent ?? data.seven_day?.utilization),
    allReset: until(weekResets, now),
    fable: percent(fable?.percent),
    fableReset: until(fable?.resets_at, now),
    resets: { "5h": moment(sessionResets, now), "7d": moment(weekResets, now), "7d fable": moment(fable?.resets_at, now) },
  };
}

// What the page is given: the reading as it stands now, with when it was taken and whether that
// is more than OLD ago.
export function reading(now = Date.now()) {
  const said = format(live.data, now);
  return said === null ? null : { ...said, at: new Date(live.fetchedAt).toISOString(), old: now - live.fetchedAt > OLD };
}

// The page is told when what it would draw has changed — the words, not the payload, so a
// payload that says what the last one said costs the page nothing.
function tell(now) {
  const said = reading(now);
  const words = JSON.stringify(said);
  if (words !== lastTold) {
    lastTold = words;
    publish("quota", said);
  }
  return said;
}

// Ask when the reading is at least `age` old and no failure is being left alone, and tell the
// page once the answer is in.
function ask(instance, age, options) {
  const now = options.now ?? Date.now;
  if (now() >= live.nextAt && now() - live.fetchedAt >= age) {
    refresh(instance, options).then(() => tell(now()), () => {});
  }
}

// One tick of the server's clock: while a page is open, ask again every five minutes, and tell
// the page what changed — now, for the time to a reset that moved, and once the answer is in.
export function tick(instance, options = {}) {
  if (pages > 0) {
    ask(instance, POLL, options);
  }
  return tell((options.now ?? Date.now)());
}

// A turn has ended: what it spent is in the windows now, and the quota gate's reading of fable's
// own window is this endpoint's, so it is asked for with no page open too.
export function turnEnded(instance, options = {}) {
  ask(instance, SPACING, options);
}

// A page has opened its stream: somebody is looking, sessions running or not.
export function pageOpened(instance, options = {}) {
  pages += 1;
  ask(instance, SPACING, options);
}

// A page's stream has closed.
export function pageClosed() {
  pages = Math.max(0, pages - 1);
}

// How many pages are looking now.
export function watching() {
  return pages;
}
