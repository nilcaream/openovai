// The file view: which paths it shows, and what it draws of them. One function decides whether a
// path is shown — the view calls it for a page, the server for every row it sends — so the checks
// here are on that function, over a scratch instance laid out with one file of every kind it
// has to tell apart, and on the page it answers. The route itself, its cookie and its headers are
// checked where the server is served (tests/chat.test.mjs). Every mutation in
// tests/mutations-view.json names the check it was written to redden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import { LARGEST, fenced, languageOf, openable, unknown, view, viewable, viewableIn, withViewable } from "../lib/chat/view.mjs";
import { remove, scratch } from "./helpers.mjs";

const base = scratch("view-test");
const root = path.join(base, "instance");
const outside = path.join(base, "outside");

function put(file, content) {
  const where = path.join(root, file);
  fs.mkdirSync(path.dirname(where), { recursive: true });
  fs.writeFileSync(where, content);
}

remove(base);
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, "secret.txt"), "outside the instance\n");
put("projects/demo/README.md", "# Demo\n\nSee `projects/demo/lib/x.mjs` and `projects/demo/nothing.md`.\n");
put("projects/demo/lib/x.mjs", "const fence = \"````\";\nexport default fence;\n");
put("desks/Ann/notes.txt", "plain words\n");
put(".claude/settings.json", "{}\n");
put(".local/notes.md", "the instance's Claude Code home\n");
put(".local/.credentials.json", "{}\n");
put("projects/demo/.git/config", "[core]\n");
put("projects/demo/.env", "A=1\n");
put("projects/demo/.env.local", "A=2\n");
put("projects/demo/config/.credentials.json", "{}\n");
// The same names cased otherwise: on a filesystem that folds case each is one of the files above.
put(".LOCAL/notes.md", "the instance's Claude Code home, asked for in capitals\n");
put("projects/demo/.GIT/config", "[core]\n");
put("projects/demo/.Env", "A=1\n");
put("projects/demo/.ENV.local", "A=2\n");
put("projects/demo/config/.CREDENTIALS.JSON", "{}\n");
put("temp/big.txt", "x".repeat(LARGEST + 1));
put("temp/edge.txt", "x".repeat(LARGEST));
put("temp/nul.txt", "text\0more\n");
put("temp/latin.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
fs.mkdirSync(path.join(root, "temp", "a-directory"), { recursive: true });
fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "temp", "out-link.txt"));
fs.symlinkSync(path.join(root, "desks", "Ann", "notes.txt"), path.join(root, "temp", "in-link.txt"));
fs.symlinkSync(path.join(root, ".local", "notes.md"), path.join(root, "temp", "home-link.md"));
put("desks/Ann/mock.html", "<!doctype html>\n<title>Mock</title>\n");
put("desks/Ann/launch.desktop", "[Desktop Entry]\nExec=true\n");
put("projects/demo/.git/page.html", "<!doctype html>\n");
fs.writeFileSync(path.join(outside, "page.html"), "<!doctype html>\n");
fs.symlinkSync(path.join(root, "desks", "Ann", "launch.desktop"), path.join(root, "temp", "page-link.html"));
fs.symlinkSync(path.join(root, "desks", "Ann", "mock.html"), path.join(root, "temp", "mock-link.htm"));
fs.symlinkSync(path.join(outside, "page.html"), path.join(root, "temp", "out-page.html"));

after(() => remove(base));

describe("which paths the view shows", () => {
  it("shows a regular text file named by its path from the instance root, and nothing named any other way", () => {
    const shown = viewable(root, "desks/Ann/notes.txt");
    assert.equal(shown.ok, true);
    assert.equal(shown.path, "desks/Ann/notes.txt");
    assert.equal(shown.text, "plain words\n");
    assert.equal(viewable(root, ".claude/settings.json").ok, true);
    for (const wanted of ["notes.txt", "Ann/notes.txt", "/desks/Ann/notes.txt", path.join(root, "desks/Ann/notes.txt"), "", "desks/Ann/notes.txt\0"]) {
      assert.equal(viewable(root, wanted).status, 404, JSON.stringify(wanted));
    }
  });

  it("follows a symlink inside the instance and refuses one or a climb that leads out of it", () => {
    assert.equal(viewable(root, "temp/in-link.txt").ok, true);
    assert.equal(viewable(root, "temp/in-link.txt").path, "desks/Ann/notes.txt");
    assert.equal(viewable(root, "temp/out-link.txt").status, 403);
    assert.equal(viewable(root, "../outside/secret.txt").status, 403);
    assert.equal(viewable(root, "desks/../../outside/secret.txt").status, 403);
  });

  it("never shows the instance's Claude Code home, a .git directory, a .env file or a .credentials.json, however it is reached", () => {
    for (const wanted of [".local/notes.md", ".local/.credentials.json", "temp/home-link.md", "projects/demo/.git/config", "projects/demo/.env", "projects/demo/.env.local", "projects/demo/config/.credentials.json"]) {
      assert.equal(viewable(root, wanted).status, 403, wanted);
    }
  });

  it("never shows any of them however its name is cased, since a filesystem that folds case names the same file either way", () => {
    for (const wanted of [".LOCAL/notes.md", "projects/demo/.GIT/config", "projects/demo/.Env", "projects/demo/.ENV.local", "projects/demo/config/.CREDENTIALS.JSON"]) {
      assert.equal(viewable(root, wanted).status, 403, wanted);
    }
  });

  it("shows regular files only, of at most the largest size, and text only", () => {
    assert.equal(viewable(root, "temp/a-directory").status, 404);
    assert.match(viewable(root, "temp/a-directory").why, /not a file/);
    assert.equal(viewable(root, "temp/edge.txt").ok, true);
    assert.equal(viewable(root, "temp/big.txt").status, 413);
    assert.equal(viewable(root, "temp/nul.txt").status, 415);
    assert.equal(viewable(root, "temp/latin.txt").status, 415);
    assert.equal(viewable(root, "temp/missing.txt").status, 404);
  });

  it("finds in a row's words exactly the paths it shows, and leaves a row with none as it was", () => {
    const text = "Read `desks/Ann/notes.txt:3`, [the demo](projects/demo/README.md), `temp/nul.txt` and `projects/demo/.env`.";
    assert.deepEqual(viewableIn(root, text), ["desks/Ann/notes.txt", "projects/demo/README.md"]);
    const row = { from: "Ann", text };
    assert.deepEqual(withViewable(root, row), { ...row, viewable: ["desks/Ann/notes.txt", "projects/demo/README.md"] });
    const plain = { from: "Ann", text: "nothing to open" };
    assert.equal(withViewable(root, plain), plain);
  });
});

describe("what the view draws", () => {
  it("renders a markdown file as markdown, its own paths linked only where the view shows them", () => {
    const answered = view(root, "projects/demo/README.md", "light", "OpenOv AI ~/inst");
    assert.equal(answered.status, 200);
    assert.match(answered.page, /<h1>Demo<\/h1>/);
    assert.match(answered.page, /<a href="\/view\/projects\/demo\/lib\/x\.mjs" target="_blank" rel="noopener"><code>projects\/demo\/lib\/x\.mjs<\/code><\/a>/);
    assert.match(answered.page, /<code>projects\/demo\/nothing\.md<\/code>/);
    assert.match(answered.page, /<code class="path">projects\/demo\/README\.md<\/code>/);
  });

  // The window's title is the page's own, the instance as it names it, with the path from the root
  // after it: a refused path too, as it was asked for.
  it("titles the window with the instance as the page names it and the path from the root after it", () => {
    assert.match(view(root, "projects/demo/README.md", "light", "OpenOv AI ~/inst").page, /<title>OpenOv AI ~\/inst\/projects\/demo\/README\.md<\/title>/);
    assert.match(view(root, "temp/missing.txt", "light", "OpenOv AI /srv/inst").page, /<title>OpenOv AI \/srv\/inst\/temp\/missing\.txt<\/title>/);
  });

  it("wraps a code file in one fenced block with its language tag, a fence longer than any run of backticks in it", () => {
    assert.equal(fenced("a ```` b\n", "javascript"), "`````javascript\na ```` b\n`````");
    assert.equal(fenced("plain\n", ""), "```\nplain\n```");
    assert.equal(languageOf("projects/demo/lib/x.mjs"), "javascript");
    assert.equal(languageOf("desks/Ann/notes.txt"), "");
    assert.equal(languageOf("projects/demo/Dockerfile"), "dockerfile");
    const answered = view(root, "projects/demo/lib/x.mjs");
    assert.equal(answered.status, 200);
    assert.match(answered.page, /<pre><code class="language-javascript">const fence = &quot;````&quot;;\nexport default fence;\n<\/code><\/pre>/);
    assert.match(view(root, "desks/Ann/notes.txt").page, /<pre><code>plain words\n<\/code><\/pre>/);
  });

  it("answers a path it does not show with its status and the reason, and nothing of the file", () => {
    for (const [wanted, status] of [["temp/big.txt", 413], ["temp/nul.txt", 415], ["projects/demo/.env", 403], ["temp/missing.txt", 404], ["temp/out-link.txt", 403]]) {
      const answered = view(root, wanted);
      assert.equal(answered.status, status, wanted);
      assert.ok(!answered.page.includes("A=1") && !answered.page.includes("outside the instance\n"), wanted);
    }
    assert.match(view(root, "temp/big.txt").page, /more than the 1048576 the view shows/);
  });

  it("links only the stylesheets and the theme script the server serves, and nothing inline", () => {
    const { page } = view(root, "desks/Ann/notes.txt");
    assert.match(page, /<script src="\/theme\.js"><\/script>/);
    assert.match(page, /<link rel="stylesheet" href="\/md\.css">/);
    assert.match(page, /<link rel="stylesheet" href="\/view\.css">/);
    assert.equal(page.split("<script").length - 1, 1);
    assert.ok(!page.includes("<style"));
  });

  // An installed app opens the view in a window of its own, whose title bar takes the page's
  // theme-color: the theme script repaints it from the head bubble's ground, as the page does,
  // and runs after the stylesheets that define that ground.
  it("gives an installed app's title bar the theme's colour, as the page does", () => {
    const { page } = view(root, "desks/Ann/notes.txt");
    assert.match(page, /<meta name="theme-color" content="#eef1f5">/);
    assert.ok(page.indexOf('<script src="/theme.js">') > page.indexOf('<link rel="stylesheet" href="/view.css">'));
    const script = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "chat", "theme.js"), "utf8");
    assert.match(script, /themeMeta\.content = getComputedStyle\(document\.documentElement\)\.getPropertyValue\("--panel-2"\)\.trim\(\) \|\| themeMeta\.content;/);
  });

  // The server names the theme the page keeps, so the first paint is already in it, before any
  // stylesheet or script: the window's ground, the title bar in the head bubble's ground of that
  // theme as md.css declares it, and the tokens. Light for anything else, as the page does.
  it("draws the page in the theme it is given from the first paint, light for anything but dark", () => {
    const css = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "chat", "md.css"), "utf8");
    const ground = (selector) => css.match(new RegExp(`^${selector.replace(/[[\]]/g, "\\$&")} \\{[^}]*--panel-2: (#[0-9a-f]+);`, "m"))[1];
    for (const [given, theme, selector] of [["dark", "dark", ':root[data-theme="dark"]'], ["light", "light", ":root"], [null, "light", ":root"], ["bogus", "light", ":root"]]) {
      for (const page of [view(root, "desks/Ann/notes.txt", given).page, view(root, "temp/missing.txt", given).page, unknown(given)]) {
        assert.match(page, new RegExp(`^<!doctype html>\\n<html lang="en" data-theme="${theme}">\\n`), String(given));
        assert.ok(page.includes(`<meta name="color-scheme" content="${theme}">`), String(given));
        assert.ok(page.includes(`<meta name="theme-color" content="${ground(selector)}">`), String(given));
        assert.ok(page.indexOf('<meta name="theme-color"') < page.indexOf('<link rel="stylesheet"'), String(given));
      }
    }
  });

  // A web page opens in the browser from its link on the page; the view shows nothing of it, by its
  // real path: a link named .htm to one is refused too, and a link named .html to another kind of
  // file is that file.
  it("never shows a web page, however it is named, and says where it opens", () => {
    for (const wanted of ["desks/Ann/mock.html", "temp/mock-link.htm"]) {
      const answered = view(root, wanted);
      assert.equal(answered.status, 404, wanted);
      assert.ok(!answered.page.includes("Mock") && !answered.page.includes("doctype html&gt;"), wanted);
      assert.match(answered.page, /A web page is not shown here: it opens in the browser from its link on the ovai page\./);
    }
    assert.equal(view(root, "temp/page-link.html").status, 200, "a link named .html to another file");
    assert.equal(view(root, "desks/Ann/notes.txt").status, 200);
  });
});

// A web page is opened in the browser by the desktop, which runs what it is given: only a file the
// view shows, and only one whose real path is a web page's.
describe("which files open in the browser", () => {
  it("opens a web page the view shows, by its real path", () => {
    assert.deepEqual(openable(root, "desks/Ann/mock.html"), { ok: true, real: fs.realpathSync(path.join(root, "desks/Ann/mock.html")) });
    assert.deepEqual(openable(root, "temp/mock-link.htm"), { ok: true, real: fs.realpathSync(path.join(root, "desks/Ann/mock.html")) });
  });

  it("opens nothing else: not another type, not one a web page's name leads to, nothing the view refuses", () => {
    for (const [wanted, status] of [["desks/Ann/launch.desktop", 415], ["temp/page-link.html", 415], ["desks/Ann/notes.txt", 415], ["temp/out-page.html", 403], ["projects/demo/.git/page.html", 403], ["temp/missing.html", 404]]) {
      assert.equal(openable(root, wanted).status, status, wanted);
    }
  });
});
