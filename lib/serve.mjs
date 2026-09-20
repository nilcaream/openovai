#!/usr/bin/env node

// The server process of an instance: what `ovai start` runs in the background, with this file's
// output going to the instance's log. It serves one instance until it is signalled, and it is a
// file of its own rather than a command of `ovai` so that the command never has to know the
// difference between being the server and starting one.
//
// Run by hand it serves in the foreground — the tests do — and says on stdout where it listens.
// Whatever it says after that is the server's own account of the room: a session held or released,
// a park at the deadline, a plugin that could not be served.

import { parkRoom, settingsIn, stopping } from "./chat/lifecycle.mjs";
import { serve } from "./chat/server.mjs";
import { HOST } from "./chat/runtime.mjs";
import { trustProblem } from "./claude.mjs";
import { endEvery, runningSeats } from "./chat/session.mjs";
import { readConfig, readRoot } from "./instance.mjs";
import { holderOf } from "./port.mjs";
import { describePlugins, pluginsIn } from "./plugins.mjs";

// What is printed once the address is known: the line `ovai start` waits for, and the line a
// person reads in the log to learn where the page is. Whole, never "the port you installed
// with": with --port 0 nobody knows it until now.
export function serving(root, port) {
  return `Serving ${root} at http://${HOST}:${port}`;
}

// The rest of "that port is taken". Naming the process turns a hunt into one `kill`, and the
// commonest thing on the port is a server somebody forgot to stop — its command line says which
// instance it belongs to. When the machine cannot tell us, the advice alone still stands.
function byWhom(port) {
  const advice = "or install this instance with a different --port (0 takes a free one)";
  const holder = holderOf(port);

  if (holder === null) {
    return ` — stop whatever is on it, ${advice}`;
  }

  const named =
    holder.command === null ? `pid ${holder.pid}` : `pid ${holder.pid} (${holder.command})`;
  return ` by ${named} — stop it, ${advice}`;
}

async function main(argv) {
  const { root } = readRoot(argv);
  const config = readConfig(root);

  // Before anything is served: every session's permissions hang on one
  // key in one file of the instance's home, which every session start writes and none reads back.
  // An instance that cannot write it starts every seat with its rules off — each asking the User
  // for everything it does — and says so nowhere. Checked once, here, where a refusal is one
  // sentence a person reads instead of a room of questions.
  const untrusted = trustProblem(root);
  if (untrusted !== null) {
    throw new Error(untrusted);
  }

  // Read here rather than inside the server, and read once: a module is imported once per
  // process, so a directory read again later would show a new file while going on serving the stale
  // code of a changed one. A plugin is picked up when the server starts, which is already the act
  // that replaces everything else the server is running.
  const plugins = await pluginsIn(root);

  // What was found, and what was meant to be found and could not be. Only when there is something
  // to say: an instance with no tools of its own is the ordinary case and a line saying so every
  // time would stop being read. A file that could not be served is named here and nowhere else —
  // it is absent from every list a session sees, which is exactly what it would look like if it
  // had never been written, so the log is the only place anybody learns that it was.
  const aboutPlugins = describePlugins(plugins);
  if (aboutPlugins !== "") {
    console.log(aboutPlugins);
  }

  const instance = { root, config, plugins: plugins.tools, stopping: false };
  let server;
  try {
    server = await serve(instance);
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      throw new Error(`port ${config.port} is already taken${byWhom(config.port)}`);
    }
    throw error;
  }

  console.log(serving(root, server.address().port));

  // Whatever stops the server, the sessions it started are its own to end. A signal from the
  // terminal, a `kill`, or a closed window reach this process alone, and a session does not
  // notice a parent that has gone: it stays there holding a model open. Ending them here means
  // the server has one way out and not one per way of being stopped.
  //
  // Nothing is left to catch a SIGKILL on this process, where no handler of ours runs at all.
  // That case is the reason a server is stopped with `ovai stop` and not with kill -9.
  //
  // In this order, because the park is a conversation over this very server: (1) the instance is
  // marked stopping, so the page is told to wait and nobody is hired, while the MCP route keeps
  // answering; (2) the room is parked, the Leader included — every session is interrupted, told,
  // and given the stop timeout to write its desk and stop itself; (3) only then is the server
  // closed; (4) whoever is left is ended; (5) exit. A server closed first would refuse the very
  // write_desk and stop_session calls the park waits for.
  const stop = async () => {
    stopping(instance);
    const going = runningSeats().length;
    if (going > 0) {
      console.log(`Parking ${going} ${going === 1 ? "session" : "sessions"}.`);
      const parked = await parkRoom(instance, { interrupt: true, deadline: settingsIn(config).park.timeout, leaderToo: true });
      console.log(parked.text ?? parked.refused);
    }
    server.close();
    await endEvery();
    // Stopping a server that was asked to stop is what it was told to do, not a failure.
    process.exit(0);
  };

  // Once, not on: a second signal from somebody who thinks it has hung would otherwise start the
  // whole thing again underneath the first one.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, stop);
  }
}

// The reason, bare: this is a log line of the server, and `ovai start` quotes it under its own
// sentence when the start fails.
main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
