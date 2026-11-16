// The last thing a long run does once its command has ended (lib/runs.mjs, the wrapper): end what
// the command left running, as a seat's leftovers are ended when its session goes.
//
//   node lib/run-ended.mjs <root> <seat>/<name>
//
// A run's command may leave something behind that outlives it: a server it started, a daemon that
// forked into a session of its own. That carries the run in its environment, and with nothing to
// end it, it goes on being counted as the run long after the run has ended. The wrapper waiting
// for this, and this process itself, carry the run too, and are spared. What was ended is said in
// the run's log, one line each, which is where the run's end is read. It never fails the run:
// whatever goes wrong here, the wrapper writes the command's own exit next.

import { endRunLeftovers } from "./runs.mjs";

const [root, run] = process.argv.slice(2);
const ended = await endRunLeftovers(root, run, { spared: [process.pid, process.ppid] });
for (const { pid, command } of ended) {
  console.log(`ovai ended what the run left running: ${command} (pid ${pid})`);
}
