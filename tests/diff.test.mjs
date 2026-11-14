// The diff view: what the `diff` tool captures from a repository of the instance, and what the
// view draws of a capture. The checks run over a scratch instance with one git repository in it,
// committed twice and changed in its working tree. The route itself, its cookie and its headers are
// checked where the server is served (tests/chat.test.mjs). Every mutation in
// tests/mutations-diff.json names the check it was written to redden.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import { CAPTURES, KEPT, capture, captured, diffFile, diffView, drawnLines, folds, runs, splitHighlighted } from "../lib/chat/diff.mjs";
import { remove, scratch } from "./helpers.mjs";

const base = scratch("diff-test");
const root = path.join(base, "instance");
const repo = path.join(root, "projects", "demo");
const outside = path.join(base, "outside");

function put(file, content) {
  const where = path.join(repo, file);
  fs.mkdirSync(path.dirname(where), { recursive: true });
  fs.writeFileSync(where, content);
}

function git(cwd, ...args) {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
}

const counted = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

remove(base);
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
git(repo, "init", "-q", "-b", "main");
// A capture finds renames whatever the repository's own configuration says.
git(repo, "config", "diff.renames", "false");
put("lib/a.mjs", counted(30));
put("old-name.txt", "kept as it is\n");
put("gone.txt", "deleted later\n");
put(".env", "SECRET=first\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "first");
git(repo, "tag", "one");
put("lib/a.mjs", counted(30).replace("line 5\n", "line five\n").replace("line 25\n", "line 25\nline 25b\n"));
fs.renameSync(path.join(repo, "old-name.txt"), path.join(repo, "new-name.txt"));
fs.rmSync(path.join(repo, "gone.txt"));
put(".env", "SECRET=second\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "second");
git(repo, "tag", "two");
put("lib/a.mjs", counted(30).replace("line 1\n", "line one\n"));
put("fresh.txt", "not added yet\n");
git(outside, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(outside, "secret.txt"), "outside the instance\n");
git(outside, "add", "-A");
git(outside, "commit", "-q", "-m", "outside");
fs.writeFileSync(path.join(outside, "secret.txt"), "outside the instance, changed\n");

after(() => remove(base));

const byName = (made, name) => made.files.find((file) => (file.new ?? file.old) === name);

describe("a capture", () => {
  it("keeps every file two revisions differ in, both whole sides, and git's ranges, under a random id", async () => {
    const made = await capture(root, { repository: "projects/demo", from: "one", to: "two" });
    assert.equal(made.ok, true, made.why);
    assert.match(made.text, new RegExp(`/diff/${made.id}`));
    const kept = captured(root, made.id);
    assert.deepEqual(kept.files.map((file) => [file.status, file.old, file.new]).sort(), [
      ["D", "gone.txt", null],
      ["M", ".env", ".env"],
      ["M", "lib/a.mjs", "lib/a.mjs"],
      ["R", "old-name.txt", "new-name.txt"],
    ]);
    const a = byName(kept, "lib/a.mjs");
    assert.equal(a.a.text, counted(30));
    assert.match(a.b.text, /line five\n[\s\S]*line 25b\n/);
    assert.deepEqual(a.hunks, [[5, 1, 5, 1], [25, 0, 26, 1]]);
    assert.equal(kept.from.asked, "one");
    assert.equal(kept.to.subject, "second");
  });

  it("takes the working tree as the new side, its uncommitted changes and new untracked files included", async () => {
    const made = await capture(root, { repository: "projects/demo", from: "two", to: "worktree" });
    assert.equal(made.ok, true, made.why);
    const kept = captured(root, made.id);
    assert.equal(kept.to.id, null);
    assert.match(byName(kept, "lib/a.mjs").b.text, /^line one\n/);
    const fresh = byName(kept, "fresh.txt");
    assert.equal(fresh.untracked, true);
    assert.equal(fresh.b.text, "not added yet\n");
    assert.deepEqual(fresh.hunks, [[0, 0, 1, 1]]);
  });

  it("never keeps a file the view never shows, by any side, and lists it by its name", async () => {
    const made = await capture(root, { repository: "projects/demo", from: "one", to: "worktree" });
    const file = fs.readFileSync(path.join(root, CAPTURES, `${made.id}.json`), "utf8");
    assert.ok(!file.includes("SECRET"), "a .env file's content was captured");
    const kept = captured(root, made.id);
    const env = byName(kept, ".env");
    assert.deepEqual([env.a.state, env.b.state], ["denied", "denied"]);
    assert.match(diffFile(root, made.id, kept.files.indexOf(env) + 1).body, /Not shown/);
  });

  it("refuses a revision that starts with -, and one git does not know, before anything is written", async () => {
    const written = path.join(root, "written-by-git");
    for (const [from, to] of [["--output=written-by-git", "two"], ["one", "--output=written-by-git"], ["-p", "two"]]) {
      const made = await capture(root, { repository: "projects/demo", from, to });
      assert.equal(made.ok, false, `${from} ${to}`);
      assert.match(made.why, /starts with -, which git would read as an option; nothing was run/, `${from} ${to}`);
    }
    for (const [from, to] of [["nothing-here", "two"], ["one", "nothing-here"]]) {
      const made = await capture(root, { repository: "projects/demo", from, to });
      assert.match(made.why, /is not a commit in projects\/demo/, `${from} ${to}`);
    }
    assert.equal(fs.existsSync(written), false);
    assert.equal(fs.existsSync(path.join(repo, "written-by-git")), false);
  });

  it("refuses a repository outside the instance, by its path or by a link to it", async () => {
    fs.symlinkSync(outside, path.join(root, "projects", "elsewhere"));
    for (const repository of [outside, "../outside", "projects/elsewhere"]) {
      const made = await capture(root, { repository, from: "main", to: "worktree" });
      assert.equal(made.ok, false, repository);
      assert.match(made.why, /inside the instance/, repository);
    }
  });

  it("is gone once it is older than it is kept, and dropped by the next capture", async () => {
    const old = await capture(root, { repository: "projects/demo", from: "one", to: "two" });
    const file = path.join(root, CAPTURES, `${old.id}.json`);
    const then = new Date(Date.now() - KEPT - 60_000);
    fs.utimesSync(file, then, then);
    assert.equal(captured(root, old.id), null);
    assert.equal(diffView(root, old.id, "light", "ovai").status, 404);
    await capture(root, { repository: "projects/demo", from: "one", to: "two" });
    assert.equal(fs.existsSync(file), false);
  });
});

describe("what the view draws", () => {
  it("cuts a whole side's highlighting into lines, reopening a span a line break cut", () => {
    const text = "const a = 1;\n/* one\ntwo */\nconst b = `x\ny`;\n";
    const lines = drawnLines(text, "x.mjs");
    assert.equal(lines.length, 5);
    assert.match(lines[2], /^<span class="hljs-comment">two \*\/<\/span>$/);
    assert.match(lines[4], /<span class="hljs-string">y`<\/span>/);
    const plain = (html) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    assert.deepEqual(lines.map(plain), text.replace(/\n$/, "").split("\n"));
    assert.deepEqual(splitHighlighted('<span class="a">x\ny</span>'), ['<span class="a">x</span>', '<span class="a">y</span>']);
  });

  it("pairs the lines both sides share and the changes between them, from git's ranges", () => {
    assert.deepEqual(runs(10, [[5, 1, 5, 1], [8, 0, 9, 2]]), [
      { same: true, a: 0, b: 0, length: 4 },
      { same: false, a: 4, oldLength: 1, b: 4, newLength: 1 },
      { same: true, a: 5, b: 5, length: 3 },
      { same: false, a: 8, oldLength: 0, b: 8, newLength: 2 },
      { same: true, a: 8, b: 10, length: 2 },
    ]);
    assert.deepEqual(runs(3, [[2, 1, 1, 0]]), [{ same: true, a: 0, b: 0, length: 1 }, { same: false, a: 1, oldLength: 1, b: 1, newLength: 0 }, { same: true, a: 2, b: 1, length: 1 }]);
  });

  it("folds an unchanged run past three lines beside each change, and none that would hide one line", () => {
    assert.deepEqual(folds({ length: 20 }, false, false), { head: 3, folded: 14, tail: 3 });
    assert.deepEqual(folds({ length: 20 }, true, false), { head: 0, folded: 17, tail: 3 });
    assert.deepEqual(folds({ length: 20 }, false, true), { head: 3, folded: 17, tail: 0 });
    assert.deepEqual(folds({ length: 7 }, false, false), { head: 7, folded: 0, tail: 0 });
  });

  it("draws a file side by side and unified, numbered on both sides, a filler beside an added line, folds hidden", async () => {
    const made = await capture(root, { repository: "projects/demo", from: "one", to: "two" });
    const index = captured(root, made.id).files.findIndex((file) => file.new === "lib/a.mjs");
    const { status, body } = diffFile(root, made.id, index + 1);
    assert.equal(status, 200);
    assert.match(body, /<table class="side">/);
    assert.match(body, /<table class="unified">/);
    assert.ok(body.includes('<tr class="start"><td class="n">5</td><td class="c a del"><span class="l">line <span class="hljs-number">5</span></span></td><td class="n">5</td><td class="c b add"><span class="l">line five</span></td></tr>'), "line 5's change drawn otherwise");
    assert.match(body, /<tr class="start"><td class="n"><\/td><td class="c a none"><\/td><td class="n">26<\/td><td class="c b add">/);
    assert.match(body, /<tbody class="fold" data-fold="0"><tr><td colspan="4"><button type="button" class="unfold">⋯ 14 unchanged lines<\/button>/);
    assert.match(body, /<tbody class="folded" data-fold="0" hidden>/);
    assert.equal(diffFile(root, made.id, 99).status, 404);
  });

  // Word wrap off: the one scrollbar moves every line of both sides by the same distance, short
  // lines too. A text-indent on each cell did so in layout, but Chrome left some lines painted where
  // they were (measured on the lab, 2026-11-17): so each line is one span of its cell, and the
  // scrollbar moves the spans with a transform, never the cells' text.
  it("draws every line as one span of its cell, which is what the one scrollbar moves, with a transform", async () => {
    const made = await capture(root, { repository: "projects/demo", from: "one", to: "two" });
    const index = captured(root, made.id).files.findIndex((file) => file.new === "lib/a.mjs");
    const { body } = diffFile(root, made.id, index + 1);
    const cells = [...body.matchAll(/<td class="c[^"]*">(.*?)<\/td>/g)].map((found) => found[1]).filter((inside) => inside !== "");
    assert.ok(cells.length > 60, `${cells.length} cells`);
    for (const inside of cells) assert.match(inside, /^<span class="l">.*<\/span>$/, inside);
    const css = fs.readFileSync(new URL("../lib/chat/diff.css", import.meta.url), "utf8");
    assert.match(css, /html\.no-wrap \.diff td\.c > \.l \{[^}]*transform: translateX\(calc\(var\(--x, 0\) \* -1px\)\)/);
    assert.ok(!/text-indent/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), "a text-indent moves the lines");
  });

  // A lab round: under a short file the scrollbar sat right below its last line. The file
  // area is a column, and the scrollbar's top margin takes what the file leaves, so it is at the
  // bottom of the window whatever the file's length; sticky keeps it there under a long one.
  it("keeps the one scrollbar at the bottom of the window, under a short file too", () => {
    const css = fs.readFileSync(new URL("../lib/chat/diff.css", import.meta.url), "utf8");
    assert.match(css, /\.diff main\.files-shown \{[^}]*display: flex; flex-direction: column;/);
    assert.match(css, /\.diff main\.files-shown > \* \{ flex: none; \}/);
    assert.match(css, /\.diff \.hscroll \{ position: sticky; bottom: 0; margin-top: auto;/);
  });

  it("draws the page with the list of files and each file's head, its body left to be fetched", async () => {
    const made = await capture(root, { repository: "projects/demo", from: "one", to: "two" });
    const { status, page } = diffView(root, made.id, "dark", "OpenOv AI ~/x");
    assert.equal(status, 200);
    assert.match(page, /<html lang="en" data-theme="dark">/);
    assert.match(page, /<nav class="files"/);
    assert.equal(page.split('<section class="file"').length - 1, 4);
    assert.deepEqual([...page.matchAll(/data-src="\/diff\/([^/"]+)\/(\d+)"/g)].map((found) => [found[1], found[2]]), [1, 2, 3, 4].map((n) => [made.id, String(n)]));
    assert.ok(!page.includes("<table"), "a body was drawn into the page");
    assert.match(page, /<link rel="stylesheet" href="\/diff.css">/);
    assert.match(page, /<script src="\/diff.js"><\/script>/);
    assert.equal(diffView(root, "not-an-id", "light", "ovai").status, 404);
  });

  it("is titled by the repository and the capture as a file in it, and its bar names both sides between the head's separators", async () => {
    const made = await capture(root, { repository: "projects/demo", from: "one", to: "two" });
    const kept = captured(root, made.id);
    const { page } = diffView(root, made.id, "light", "OpenOv AI ~/x");
    assert.ok(page.includes(`<title>OpenOv AI ~/x/projects/demo/${made.id}.diff</title>`), "titled otherwise");
    const what = /<span class="what">([\s\S]*?)<\/span>\n<span class="spacer">/.exec(page)[1].replace(/<[^>]+>/g, "");
    assert.equal(what, `projects/demo · one ${kept.from.id.slice(0, 7)} · two ${kept.to.id.slice(0, 7)}`);
    assert.match(page, /title="Previous change \(p, Shift\+F7\)">Previous<\/button><button type="button" data-go="change" data-by="1" title="Next change \(n, F7\)">Next<\/button>/);
    assert.match(page, />Unified<\/button><button type="button" class="wrap" aria-pressed="true"[^>]*>Word wrap<\/button>/);
    assert.match(page, /<div class="hscroll" hidden><div><\/div><\/div>\n<\/main>/);
  });
});
