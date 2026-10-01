#!/usr/bin/env node
// The command the npm package installs: `npx @openovai/ovai@<version> --root …` is this file.
//
// It is the installer called one more way, and does nothing of its own: it runs lib/install.mjs on
// the package it sits in, with the arguments it was given. It is not lib/install.mjs itself because
// npm runs a command through a symlink, and the installer starts only when the path it was run as is
// its own real path — through the link it would exit quietly having done nothing. It is not in
// bin/ or lib/ because those two are the payload and every instance gets a copy of them.
//
// The package is the release, so there is nothing to fetch here: Node and Claude Code come with the
// first `ovai start`, as they do on every other way in.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The terminal is handed on as it is, so the installer asks its questions the way it does anywhere.
// The node it runs on is the one this file was found by, the shebang above having looked it up on
// the same PATH.
const result = spawnSync(
  "node",
  [path.join(packageDir, "lib", "install.mjs"), "--source", packageDir, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

if (result.error !== undefined) {
  console.error(`install: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
