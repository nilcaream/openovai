// Whether a newer release of ovai is out, for the Leader's head.
//
// Asked once a day on the server's tick, of the address `ovai update` itself asks (release.mjs), so
// that what the head announces is what an update would take: a release with no signed package is
// one the updater refuses, and is not announced. One GET with no body and nothing about the
// instance in it; the answer is read for the tag and the names of the files attached, and nothing
// is downloaded. An instance on a build from a checkout is on its commit's hash, which no release
// is newer than, so it is never asked at all. `update.check` false in openovai.json turns the
// asking off, and takes a notice already shown off the head at the next tick.
//
// The answer is held in memory only: a server started again asks again.

import { RELEASES, latestRelease } from "../release.mjs";
import { isOlderThan, isRelease, version } from "../version.mjs";
import { publish } from "./events.mjs";
import { log } from "./log.mjs";

export const CHECK_EVERY = 86_400_000;

let latest = null;
let shown = null;
let nextAt = 0;
let inFlight = false;

// The suites start each case from nothing asked.
export function reset() {
  latest = null;
  shown = null;
  nextAt = 0;
  inFlight = false;
}

// The newer version the head names, or null.
export function newer() {
  return shown;
}

// The page is told when what the head names changes, and only then.
function show(next) {
  if (next !== shown) {
    shown = next;
    publish("release", next === null ? null : { version: next });
  }
}

// One look, when one is due. `on` is the instance's `update.check`; `get` is fetch, and the suite
// hands in its own. A failure is said once per look and asked again a day later.
export async function check({ root, on, now = Date.now(), get = fetch }) {
  const here = version(root);
  if (on && isRelease(here) && !inFlight && now >= nextAt) {
    nextAt = now + CHECK_EVERY;
    inFlight = true;
    try {
      latest = (await latestRelease(RELEASES, { get })).version;
      if (isOlderThan(here, latest)) {
        log("release", null, null, `${latest} is out; this instance is on ${here}`);
      }
    } catch (error) {
      log("release", null, null, `no newer release could be read: ${error.message}`);
    } finally {
      inFlight = false;
    }
  }
  show(on && latest !== null && isOlderThan(here, latest) ? latest : null);
}
