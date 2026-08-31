// Check that an instance grants its leader exactly the one thing it needs: the right to keep
// its own desk. Written as a script rather than a grep because the interesting part is what is
// NOT there — a rule that reaches wider than one file would pass any check that only looked for
// the file's name in the text.

import fs from "node:fs";

const [file, leader] = process.argv.slice(2);
const expected = `Edit(work/${leader}/STATE.md)`;

let settings;
try {
  settings = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  console.error(`cannot read ${file}: ${error.message}`);
  process.exit(1);
}

const allow = settings?.permissions?.allow;
if (!Array.isArray(allow)) {
  console.error("permissions.allow is missing");
  process.exit(1);
}

if (!allow.includes(expected)) {
  console.error(`no rule ${expected}; found ${JSON.stringify(allow)}`);
  process.exit(1);
}

// The instance is meant to be movable, so nothing in here may name a place on this machine.
const absolute = allow.filter((rule) => rule.includes("(//") || rule.includes("(/") || rule.includes("(~"));
if (absolute.length > 0) {
  console.error(`rules anchored outside the instance: ${JSON.stringify(absolute)}`);
  process.exit(1);
}

// One rule, one file. Anything wider is a grant nobody asked for.
const wider = allow.filter((rule) => rule !== expected);
if (wider.length > 0) {
  console.error(`rules beyond the leader's desk: ${JSON.stringify(wider)}`);
  process.exit(1);
}
