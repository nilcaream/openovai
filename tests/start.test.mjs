// What has to be true on disk before an instance is served: the trust record every session's
// permissions hang on (lib/claude.mjs). `ovai start` asks trustProblem once and refuses with its
// sentence; these checks are the sentence and the null, on a root of their own.
//
// Every mutation in tests/mutations-start.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { trustProblem } from "../lib/claude.mjs";

const roots = [];

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openovai-trust-"));
  roots.push(root);
  return root;
}

function stateFile(root) {
  return path.join(root, ".local", ".claude.json");
}

after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("the instance is trusted before it is served", () => {
  it("records the trust on a fresh root, reads it back, and answers null", () => {
    const root = freshRoot();

    assert.equal(trustProblem(root), null);

    const state = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
    assert.equal(state.projects[path.resolve(root)].hasTrustDialogAccepted, true);
  });

  it("answers null for a root already recorded, and leaves the record alone", () => {
    const root = freshRoot();
    fs.mkdirSync(path.join(root, ".local"));
    const written = `${JSON.stringify({ theirs: 1, projects: { [path.resolve(root)]: { hasTrustDialogAccepted: true, other: "kept" } } }, null, 2)}\n`;
    fs.writeFileSync(stateFile(root), written);

    assert.equal(trustProblem(root), null);
    assert.equal(fs.readFileSync(stateFile(root), "utf8"), written);
  });

  it("refuses with one sentence naming the file and the error when the record cannot be written", () => {
    const root = freshRoot();
    // The home is a file, so there is no directory to write the record into: the write fails the
    // way a read-only or missing home would, and deterministically for whoever runs this.
    fs.writeFileSync(path.join(root, ".local"), "not a directory\n");

    const problem = trustProblem(root);

    assert.equal(typeof problem, "string");
    assert.ok(problem.startsWith(`${stateFile(root)}: cannot record that ${root} is trusted (`), problem);
    assert.match(problem, /ENOTDIR|EEXIST/);
    assert.ok(problem.includes(path.join(root, ".claude", "settings.json")), problem);
    assert.ok(problem.endsWith("fix the file or its directory and start again"), problem);
    assert.equal(problem.split("\n").length, 1);
  });
});
