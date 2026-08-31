#!/usr/bin/env node

// Read the Claude Code state file inside an instance's home and say whether the instance's own
// directory is recorded as trusted. Called by tests/ow.sh with the file and the instance root.
//
// Without this, Claude Code ignores the settings the instance ships with and says so only on a
// line of stderr, so a test that did not look here would not notice it happening.

import fs from "node:fs";

const [file, root] = process.argv.slice(2);

let state;
try {
  state = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  console.error(`${file} could not be read: ${error.message}`);
  process.exit(1);
}

if (state?.projects?.[root]?.hasTrustDialogAccepted !== true) {
  console.error(`${root} is not recorded as trusted in ${file}`);
  process.exit(1);
}
