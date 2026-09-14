// The account's usage windows, as the head shows them: the session window with the time to its
// reset, the weekly window over every model, and the weekly window of the one model that has its
// own — three percentages read at a glance.
//
// Source: this server asks the account's usage endpoint directly, with the instance's own
// credential — the token Claude Code keeps in the instance's home, or the machine's token when
// the instance was installed to inherit it. There is deliberately no other source and no cache
// file: a number from another account's cache is worse than an empty line. The token is read at
// call time, used in one header, never kept, never logged, never put in an error.
//
// Asked only while a page is looking (the server ticks while it has a stream open), at most once
// a minute, and after any failure not again for five minutes.

import fs from "node:fs";
import path from "node:path";

import { home } from "../claude.mjs";
import { publish } from "./events.mjs";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CREDENTIALS_FILE = ".credentials.json";
export const MACHINE_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

// How old the reading may get before it is asked for again, and how long a failure is left alone.
export const TTL = 60_000;
export const BACKOFF = 5 * 60_000;
const TIMEOUT = 10_000;

let live = { data: null, fetchedAt: 0, nextAt: 0, inFlight: false };
let lastTold = "null";

// Back to nothing read; for a suite that asks several times.
export function reset() {
  live = { data: null, fetchedAt: 0, nextAt: 0, inFlight: false };
  lastTold = "null";
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

// One request, when a token is there. `get` is fetch; the suite hands in its own.
export async function refresh(instance, { get = fetch, now = Date.now, version = "unknown" } = {}) {
  if (live.inFlight) {
    return;
  }
  const bearer = token(instance.root, instance.config?.auth, process.env, now());
  if (bearer === null) {
    live.nextAt = now() + BACKOFF;
    return;
  }
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
      console.log(`usage: the endpoint answered ${answered.status}, asked again in ${Math.round((live.nextAt - now()) / 1000)}s`);
      return;
    }
    live = { data: await answered.json(), fetchedAt: now(), nextAt: 0, inFlight: false };
  } catch (error) {
    live.nextAt = now() + BACKOFF;
    console.log(`usage: the endpoint was not reached — ${error.message}`);
  } finally {
    live.inFlight = false;
  }
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

// The reading as the page draws it, or null when there is none or it has outlived its own
// session window — then its numbers are the last window's and saying nothing is honest.
export function format(data, fetchedAt, now = Date.now()) {
  if (data === null || typeof data !== "object") {
    return null;
  }
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const session = limits.find((limit) => limit.kind === "session");
  const week = limits.find((limit) => limit.kind === "weekly_all");
  const fable = limits.find((limit) => limit.kind === "weekly_scoped" && /fable/i.test(limit.scope?.model?.display_name ?? ""));
  const reset = until(session?.resets_at ?? data.five_hour?.resets_at, now);
  if (reset === null) {
    return null;
  }
  return {
    session: percent(session?.percent ?? data.five_hour?.utilization),
    reset,
    all: percent(week?.percent ?? data.seven_day?.utilization),
    allReset: until(week?.resets_at ?? data.seven_day?.resets_at, now),
    fable: percent(fable?.percent),
    fableReset: until(fable?.resets_at, now),
    updated: new Date(fetchedAt).toISOString(),
  };
}

// What the page is given: the reading as it stands now.
export function reading(now = Date.now()) {
  return format(live.data, live.fetchedAt, now);
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

// One tick of the server's clock: while a page is looking, ask again once the reading is old
// enough, and tell the page what changed — now, for the time to a reset that moved, and once
// the answer is in.
export function tick(instance, pages, options = {}) {
  const now = options.now ?? Date.now;
  if (pages > 0 && now() >= live.nextAt && now() - live.fetchedAt >= TTL) {
    refresh(instance, options).then(() => tell(now()), () => {});
  }
  return tell(now());
}
