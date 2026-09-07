// tests/tag.test.mjs — check what a release of a tree would be, and what it refuses to be.
//
// No release is cut to check this. Every check runs against a repository made here, with its own
// VERSION, its own NOTES.md and its own tags, so nothing reaches GitHub and nothing depends on
// what this repository has already released. What the workflow does with the answer — pushing the
// tag, calling gh — is not checked here and cannot be: it is three lines of git and gh in
// .github/workflows/release.yml, and the reason the deciding is in a file of its own is that the
// deciding is the part worth checking.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import { remove, repo, scratch } from "./helpers.mjs";
import { TagError, alreadyTagged, main, notesFor, releaseOf, tagFor } from "../.github/tag.mjs";

const here = scratch("tag-test");

after(() => remove(here));

const NOTES = [
  "# What changed",
  "",
  "For the lead of a workspace taking this version.",
  "",
  "## 1.2.0",
  "",
  "The one this release is about.",
  "",
  "- a line with a - dash in it",
  "",
  "## 1.1.0",
  "",
  "The one before.",
  "",
].join("\n");

// A repository with a version, notes and a commit to tag. Each check gets its own: a check about
// a tag that exists cannot share a tree with a check about one that does not.
function aRepository(name, { version = "1.2.0", notes = NOTES, tags = [] } = {}) {
  const tree = path.join(here, name);
  fs.mkdirSync(tree, { recursive: true });
  if (version !== null) {
    fs.writeFileSync(path.join(tree, "VERSION"), `${version}\n`);
  }
  if (notes !== null) {
    fs.writeFileSync(path.join(tree, "NOTES.md"), notes);
  }

  const git = (...argv) => {
    const done = spawnSync("git", ["-C", tree, ...argv], { encoding: "utf8" });
    assert.equal(done.status, 0, `git ${argv.join(" ")}: ${done.stderr}`);
    return done.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "A Maintainer");
  git("config", "user.email", "maintainer@example.com");
  git("add", "-A");
  git("commit", "-q", "-m", "a commit to tag", "--allow-empty");
  for (const tag of tags) {
    git("tag", "-a", tag, "-m", tag);
  }
  return tree;
}

// The TagError a call raises, so a check can read the message it puts in front of a person.
function refused(call) {
  try {
    call();
  } catch (raised) {
    assert.ok(raised instanceof TagError, `raised ${raised} rather than a TagError`);
    return raised;
  }
  return assert.fail("nothing was refused");
}

// What the command printed, and what it wrote for the workflow to read.
function run(tree, argv = []) {
  const out = [];
  const err = [];
  const outputs = path.join(tree, "step-outputs");
  process.env.GITHUB_OUTPUT = outputs;
  let code;
  try {
    code = main(["--repo", tree, ...argv], (line) => out.push(line), (line) => err.push(line));
  } finally {
    delete process.env.GITHUB_OUTPUT;
  }
  const wrote = fs.existsSync(outputs) ? fs.readFileSync(outputs, "utf8") : "";
  return { code, out: out.join("\n"), err: err.join("\n"), outputs: wrote };
}

describe("the tag a version is released under", () => {
  it("is the version with a v in front", () => {
    assert.equal(tagFor("1.2.0"), "v1.2.0");
    assert.equal(tagFor("10.0.11"), "v10.0.11");
  });

  it("refuses anything that is not three numbers", () => {
    for (const said of ["1.2", "v1.2.0", "1.2.0-rc1", "", "latest", "1.2.0.1"]) {
      assert.throws(() => tagFor(said), TagError, `${JSON.stringify(said)} was accepted as a version`);
    }
  });
});

describe("the notes a release carries", () => {
  it("are the section under the version's own heading", () => {
    const section = notesFor(NOTES, "1.2.0");
    assert.match(section, /The one this release is about\./);
    assert.match(section, /- a line with a - dash in it/);
  });

  it("stop at the next version", () => {
    assert.doesNotMatch(notesFor(NOTES, "1.2.0"), /The one before\./);
    assert.doesNotMatch(notesFor(NOTES, "1.2.0"), /^## /m);
  });

  it("are the last section when there is nothing after it", () => {
    assert.match(notesFor(NOTES, "1.1.0"), /The one before\./);
  });

  it("do not include the heading itself", () => {
    assert.doesNotMatch(notesFor(NOTES, "1.2.0"), /## 1\.2\.0/);
  });

  it("refuse a version the notes say nothing about, and say what they do have", () => {
    const raised = refused(() => notesFor(NOTES, "9.9.9"));
    assert.match(raised.message, /no "## 9\.9\.9" section/);
    assert.match(raised.message, /## 1\.2\.0, ## 1\.1\.0/);
  });

  it("refuse a section with nothing in it", () => {
    const empty = ["## 1.2.0", "", "## 1.1.0", "", "The one before.", ""].join("\n");
    assert.throws(() => notesFor(empty, "1.2.0"), /is empty/);
  });

  it("are not confused by a heading of another depth", () => {
    const deeper = ["## 1.2.0", "", "Real.", "", "### 1.1.0", "", "Still 1.2.0.", ""].join("\n");
    assert.match(notesFor(deeper, "1.2.0"), /Still 1\.2\.0\./);
  });
});

describe("a version that is already out", () => {
  it("is found by its tag", () => {
    const tree = aRepository("tagged", { tags: ["v1.2.0"] });
    assert.notEqual(alreadyTagged(tree, "v1.2.0"), null);
    assert.equal(alreadyTagged(tree, "v9.9.9"), null);
  });

  it("is refused, with what to do next", () => {
    const tree = aRepository("refuse-tagged", { tags: ["v1.2.0"] });
    const raised = refused(() => releaseOf(tree));
    assert.match(raised.message, /v1\.2\.0 is already a tag/);
    assert.match(raised.message, /Bump VERSION/);
  });
});

describe("what a release of a tree would be", () => {
  it("is the version, its tag, its name and its section of the notes", () => {
    const release = releaseOf(aRepository("whole"));
    assert.equal(release.version, "1.2.0");
    assert.equal(release.tag, "v1.2.0");
    assert.equal(release.name, "1.2.0");
    assert.match(release.notes, /The one this release is about\./);
  });

  // A second tree, on a version of its own. Every repository here was on 1.2.0 until it was
  // measured, so a release that answered with that version — never reading the file — was right
  // about all of them, and the check above stayed green under exactly that.
  it("is the version the tree's own VERSION names, and not one written down here", () => {
    const notes = ["## 2.3.4", "", "The other one this release is about.", ""].join("\n");
    const release = releaseOf(aRepository("another-version", { version: "2.3.4", notes }));
    assert.deepEqual([release.version, release.tag, release.name], ["2.3.4", "v2.3.4", "2.3.4"]);
  });

  it("refuses a tree with no version in it", () => {
    const tree = aRepository("no-version", { version: null });
    assert.throws(() => releaseOf(tree), /no VERSION in it/);
  });

  it("refuses a tree with no notes in it", () => {
    const tree = aRepository("no-notes", { notes: null });
    assert.throws(() => releaseOf(tree), /no NOTES\.md in it/);
  });
});

describe("the command the workflow runs", () => {
  it("writes the notes where it was told and prints where that is", () => {
    const tree = aRepository("command");
    const where = path.join(tree, "somewhere", "notes.md");
    const done = run(tree, ["--notes-file", where]);
    assert.equal(done.code, 0);
    assert.equal(fs.readFileSync(where, "utf8").trim(), releaseOf(aRepository("command-again")).notes);
    assert.match(done.out, new RegExp(`notes  ${where.replace(/[.\\]/g, "\\$&")}`));
  });

  it("hands the workflow the tag, the name and the notes file", () => {
    const tree = aRepository("outputs");
    const where = path.join(tree, "notes.md");
    const done = run(tree, ["--notes-file", where]);
    assert.match(done.outputs, /^tag=v1\.2\.0$/m);
    assert.match(done.outputs, /^name=1\.2\.0$/m);
    assert.match(done.outputs, new RegExp(`^notes-file=${where.replace(/[.\\]/g, "\\$&")}$`, "m"));
  });

  it("writes the notes beside the clone when nobody says where", () => {
    const tree = aRepository("default-notes");
    assert.equal(run(tree).code, 0);
    assert.match(fs.readFileSync(path.join(tree, ".tmp", "release-notes.md"), "utf8"), /The one this release is about\./);
  });

  it("fails, says why, and writes nothing when the version is already out", () => {
    const tree = aRepository("command-tagged", { tags: ["v1.2.0"] });
    const done = run(tree, ["--notes-file", path.join(tree, "notes.md")]);
    assert.equal(done.code, 1);
    assert.match(done.err, /already a tag/);
    assert.equal(done.outputs, "");
    assert.equal(fs.existsSync(path.join(tree, "notes.md")), false);
  });

  it("says it in the shape Actions marks up, when it is Actions asking", () => {
    const tree = aRepository("annotated", { tags: ["v1.2.0"] });
    process.env.GITHUB_ACTIONS = "true";
    try {
      assert.match(run(tree).err, /^::error::/);
    } finally {
      delete process.env.GITHUB_ACTIONS;
    }
  });

  it("refuses an argument it does not know", () => {
    const tree = aRepository("unknown-argument");
    const done = run(tree, ["--publish"]);
    assert.equal(done.code, 1);
    assert.match(done.err, /unknown argument --publish/);
  });
});

// The workflow and this suite have to agree on three names. Nothing checks a YAML file for us, so
// the names it reads out of the step are read out of the file here.
describe("the workflow that runs it", () => {
  const workflow = fs.readFileSync(path.join(repo, ".github", "workflows", "release.yml"), "utf8");

  it("is the click, and nothing else starts it", () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:$/m);
  });

  it("asks for exactly the one permission it needs", () => {
    assert.match(workflow, /^permissions:\n  contents: write$/m);
  });

  it("uses the outputs this command writes", () => {
    for (const name of ["tag", "name", "notes-file"]) {
      assert.match(workflow, new RegExp(`steps\\.release\\.outputs\\.${name}`), `the workflow never reads ${name}`);
    }
  });

  it("runs the command whose outputs those are", () => {
    assert.match(workflow, /id: release\n\s+run: node \.github\/tag\.mjs/);
  });

  it("takes the whole history, or a tag that is already out would not be found", () => {
    assert.match(workflow, /fetch-depth: 0/);
  });

  it("publishes the tag it pushed rather than making one of its own", () => {
    assert.match(workflow, /--verify-tag/);
  });
});

// CI is the other thing in .github/ that runs this repository's own checks, and it is a written
// list of jobs beside a directory of suites — two places holding one fact, which is a thing that
// stays true only while somebody remembers it. It did not: tests/update.test.mjs was written, was
// green on every desk it was ever run on, and no job ever ran it. So the list is read off the
// directory here rather than written down, and a suite added without a job for it goes red in the
// suite that would have been the last to notice.
describe("the checks CI runs", () => {
  const ci = fs.readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");
  const suites = fs.readdirSync(path.join(repo, "tests")).filter((name) => name.endsWith(".test.mjs"));

  // Without this the check below passes over an empty list and says nothing at all.
  it("found the suites to ask about", () => {
    assert.ok(suites.length > 0, "no suite files were found, so the check below proved nothing");
  });

  it("runs every suite this repository has", () => {
    for (const suite of suites) {
      assert.ok(ci.includes(`node --test tests/${suite}`), `no CI job runs tests/${suite}`);
    }
  });
});

// A release used to be able to go out on a commit whose checks were failing, or still running, or
// had never been asked for. Nothing was wrong with either workflow on its own: CI starts on a push
// and the release starts on a button, so the two ran side by side and neither waited for the
// other. The tag went on first and the red tick arrived after it. What follows is the thing that
// stops that, in the only two lines of YAML that say it.
describe("a release and the checks", () => {
  const release = fs.readFileSync(path.join(repo, ".github", "workflows", "release.yml"), "utf8");
  const ci = fs.readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");

  it("runs the checks before anything is tagged", () => {
    assert.match(
      release,
      /^  release:\n    name: Release\n    needs: tests$/m,
      "the release job does not wait for the tests job, so a tag can be pushed on a red commit",
    );
  });

  it("waits for CI itself rather than for a copy of its list", () => {
    assert.match(
      release,
      /^  tests:\n    name: Tests\n    uses: \.\/\.github\/workflows\/ci\.yml$/m,
      "the job the release waits for is not CI, so the two can check different things",
    );
  });

  it("leaves CI something a release can call", () => {
    const triggers = ci.match(/^on:\n((?:[ \t]+.*\n)+)/m)?.[1] ?? "";
    assert.match(
      triggers,
      /^  workflow_call:$/m,
      "CI cannot be called by another workflow, so the release has nothing to wait for",
    );
  });
});
