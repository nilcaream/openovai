// tests/processes.test.mjs — the machine's processes as a Mac lists them.
//
// On Linux the process table is /proc, and the checks in tests/ovai.test.mjs and
// tests/update.test.mjs read it with real processes. A Mac has no /proc: there the table is read
// from `ps`, and a port's holder from `lsof`. Neither prints on Linux what it prints on a Mac, so
// here they are stand-ins on the PATH, printing what a Mac's would, and what is checked is how
// those lines are read: which process carries which environment, whether it runs the toolkit's
// claude, who holds a port. That a Mac's `ps -E` prints the environment after the command, one
// space apart, is what the stand-in assumes; it has not been run on a Mac.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { remove, repo, scratch } from "./helpers.mjs";
import { home } from "../lib/claude.mjs";
import { holderOnAMac } from "../lib/port.mjs";
import { fromPs } from "../lib/processes.mjs";
import { runningHere } from "../lib/running.mjs";
import { dataDirectory, pins } from "../lib/runtime.mjs";

const here = scratch("processes-test");
after(() => remove(here));

// A root with a space in it, as a Mac's home often has, so every value read back has to be read
// whole rather than up to the first space.
const root = path.join(here, "an instance");
const ours = home(root);
const claude = path.join(dataDirectory(), "claude", pins(repo).claude, "bin", "claude");

// The stand-ins, and the PATH they are first on for the length of one check.
const tools = path.join(here, "tools");
let pathBefore;
beforeEach(() => {
  pathBefore = process.env.PATH;
  process.env.PATH = `${tools}${path.delimiter}${pathBefore}`;
});
afterEach(() => {
  process.env.PATH = pathBefore;
});

function standIn(name, script) {
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

// A Mac's `ps`: the listing without the environment, the listing with it (-E), or one command (-p).
function aPs({ bare, full, one = "" }) {
  for (const [name, text] of Object.entries({ bare, full, one })) {
    fs.mkdirSync(here, { recursive: true });
    fs.writeFileSync(path.join(here, `ps-${name}`), text);
  }
  standIn("ps", `case "$*" in *-E*) cat '${here}/ps-full' ;; *-p*) cat '${here}/ps-one' ;; *) cat '${here}/ps-bare' ;; esac`);
}

const SESSION = `${claude} --print --output-format stream-json`;
const LEFTOVER = "/opt/homebrew/bin/python3 -m http.server 8000";
const OTHER = "/Applications/Other.app/Contents/MacOS/Other";

function aMac() {
  aPs({
    bare: [`  101 ${SESSION}`, `  102 ${LEFTOVER}`, `  103 ${OTHER}`, `  104 ${claude} --print`, ` 1999 ps -A -ww -o pid=,command=`, ""].join("\n"),
    full: [
      `  101 ${SESSION} CLAUDE_CONFIG_DIR=${ours} OPENOVAI_SEAT=Eva PATH=/usr/bin:/bin`,
      `  102 ${LEFTOVER} TERM=xterm CLAUDE_CONFIG_DIR=${ours} OPENOVAI_SEAT=Eva`,
      `  103 ${OTHER}`,
      `  104 ${claude} --print CLAUDE_CONFIG_DIR=${path.join(here, "another", ".local")}`,
      `  105 /bin/sleep 5 CLAUDE_CONFIG_DIR=${ours}`,
      ` 2000 ps -A -ww -E -o pid=,command= CLAUDE_CONFIG_DIR=${ours}`,
      "",
    ].join("\n"),
  });
}

describe("a Mac's process table", () => {
  it("reads each process's environment off what its line has beyond its command, a value with a space in it whole", () => {
    aMac();
    const table = new Map(fromPs().map((one) => [one.pid, one]));
    assert.deepEqual([...table.keys()], [101, 102, 103, 104]);
    assert.equal(table.get(101).environment().get("CLAUDE_CONFIG_DIR"), ours);
    assert.equal(table.get(101).environment().get("OPENOVAI_SEAT"), "Eva");
    assert.equal(table.get(101).environment().get("PATH"), "/usr/bin:/bin");
    assert.equal(table.get(102).environment().get("CLAUDE_CONFIG_DIR"), ours);
    assert.equal(table.get(102).command(), LEFTOVER);
    assert.equal(table.get(103).environment(), null);
    assert.equal(table.get(101).arguments(), null);
  });

  it("finds this instance's session and what its seat left, and nothing of another instance's", () => {
    aMac();
    assert.deepEqual(runningHere(root, fromPs()), [
      { pid: 101, seat: "Eva", session: true },
      { pid: 102, seat: "Eva", session: false },
    ]);
  });

  it("finds nothing when ps cannot be run", () => {
    standIn("ps", "exit 1");
    assert.deepEqual(fromPs(), []);
  });
});

describe("a port's holder on a Mac", () => {
  it("is the process lsof names, with its command", () => {
    standIn("lsof", `[ "$*" = "-nP -iTCP:7910 -sTCP:LISTEN -t" ] && echo 4242`);
    aPs({ bare: "", full: "", one: `${LEFTOVER}\n` });
    assert.deepEqual(holderOnAMac(7910), { pid: "4242", command: LEFTOVER });
  });

  it("is nobody when lsof names nobody", () => {
    standIn("lsof", "exit 1");
    assert.equal(holderOnAMac(7910), null);
  });
});
