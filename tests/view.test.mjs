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

import { DRAWN_LARGEST, HEADERS, LARGEST, fenced, highlighted, languageOf, openable, raw, unknown, view, viewable, viewableIn, withViewable } from "../lib/chat/view.mjs";
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
    assert.equal(languageOf("projects/demo/Dockerfile"), "dockerfile");
    const answered = view(root, "projects/demo/lib/x.mjs");
    assert.equal(answered.status, 200);
    assert.match(answered.page, /<pre><code class="hljs language-javascript"><span class="hljs-keyword">const<\/span> fence = <span class="hljs-string">&quot;````&quot;<\/span>;\n<span class="hljs-keyword">export<\/span> <span class="hljs-keyword">default<\/span> fence;\n<\/code><\/pre>/);
    assert.match(view(root, "desks/Ann/notes.txt").page, /<pre><code>plain words\n<\/code><\/pre>/);
  });

  // Every language highlight.js ships, by the names and aliases it has, and a few extensions it has
  // none for; a file it has no grammar for, or only its plain-text one, is a plain block.
  it("names a code file's language by highlight.js's own names and aliases, and none where it has no grammar", () => {
    for (const [file, language] of [["x.mjs", "javascript"], ["x.ts", "typescript"], ["x.json", "json"], ["x.sh", "bash"], ["X.java", "java"], ["x.kt", "kotlin"], ["x.kts", "kotlin"], ["x.yml", "yaml"], ["x.hpp", "cpp"], ["x.webmanifest", "json"], ["CMakeLists.txt", "cmake"]]) {
      assert.equal(languageOf(`projects/demo/${file}`), language, file);
    }
    for (const file of ["x.zig", "notes.txt", "README", ".bashrc"]) {
      assert.equal(languageOf(`projects/demo/${file}`), "", file);
    }
  });

  it("highlights every code block with a language it knows, a markdown file's fenced ones too, and leaves the rest as marked drew them", () => {
    const drawn = '<h1>x</h1>\n<pre><code class="language-ts">let a: string = &quot;&lt;b&gt;&amp;&#39;&quot;;\n</code></pre>\n<pre><code class="language-zig">const x = 1;\n</code></pre>\n<pre><code>plain\n</code></pre>\n';
    assert.equal(
      highlighted(drawn),
      '<h1>x</h1>\n<pre><code class="hljs language-ts"><span class="hljs-keyword">let</span> <span class="hljs-attr">a</span>: <span class="hljs-built_in">string</span> = <span class="hljs-string">&quot;&lt;b&gt;&amp;&#x27;&quot;</span>;\n</code></pre>\n<pre><code class="language-zig">const x = 1;\n</code></pre>\n<pre><code>plain\n</code></pre>\n',
    );
    put("projects/demo/fenced.md", "# Fenced\n\n```kotlin\nval x = 1\n```\n");
    assert.match(view(root, "projects/demo/fenced.md").page, /<pre><code class="hljs language-kotlin"><span class="hljs-keyword">val<\/span> x = <span class="hljs-number">1<\/span>\n<\/code><\/pre>/);
    assert.match(view(root, "projects/demo/lib/x.mjs").page, /<pre class="raw digits-1" hidden><span class="line">const fence = &quot;````&quot;;<\/span>/);
  });

  // A file that is not markdown is numbered as the raw view numbers it, in a gutter of its own beside
  // the block, so no highlighted span is cut and a selection of the code never takes the numbers.
  it("numbers a code file's lines in a gutter beside the code, as the raw view does, and a markdown file's not at all", () => {
    assert.match(view(root, "projects/demo/lib/x.mjs").page, /<main class="md"><div class="numbered"><pre class="numbers digits-1" aria-hidden="true">1\n2<\/pre><pre><code class="hljs language-javascript">/);
    assert.match(view(root, "desks/Ann/notes.txt").page, /<div class="numbered"><pre class="numbers digits-1" aria-hidden="true">1<\/pre><pre><code>plain words\n<\/code><\/pre>\n<\/div><\/main>/);
    put("projects/demo/thirteen.json", "[\n" + "1,\n".repeat(10) + "1\n]\n");
    assert.match(view(root, "projects/demo/thirteen.json").page, /<pre class="numbers digits-2" aria-hidden="true">1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13<\/pre>/);
    assert.ok(!view(root, "projects/demo/README.md").page.includes("numbered"));
    const css = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "chat", "view.css"), "utf8");
    assert.match(css, /^\.view \.numbered pre \{ margin: 0; padding: 0; font: \.85rem\/1\.4 var\(--mono\); \}/m);
    assert.match(css, /^\.view pre\.numbers \{[^}]*margin-right: 16px; text-align: right; color: var\(--fg-faint\); user-select: none; \}/m);
    for (let digits = 1; digits <= 7; digits += 1) assert.ok(css.includes(`.view pre.numbers.digits-${digits} { width: ${digits}ch; }`), `${digits} digits`);
  });

  // A file larger than DRAWN_LARGEST is never highlighted: it opens in its source view, numbered, and
  // there is nothing to toggle to. One of exactly that size is still drawn.
  it("opens a file larger than the largest it draws in its source view alone, with no toggle", () => {
    const line = "const a = 1;\n";
    put("temp/over.mjs", line.repeat(Math.floor(DRAWN_LARGEST / line.length)) + "x".repeat(DRAWN_LARGEST % line.length + 1));
    put("temp/at.mjs", line.repeat(Math.floor(DRAWN_LARGEST / line.length)) + "x".repeat(DRAWN_LARGEST % line.length));
    const over = view(root, "temp/over.mjs").page;
    assert.match(over, /<body class="view">\n<pre class="raw digits-5"><span class="line">const a = 1;<\/span>\n/);
    assert.ok(!over.includes("<main") && !over.includes("raw-toggle") && !over.includes("hljs") && !over.includes(" hidden"));
    const at = view(root, "temp/at.mjs").page;
    assert.ok(at.includes('<main class="md"><div class="numbered">') && at.includes("hljs") && at.includes("raw-toggle"));
    assert.equal(DRAWN_LARGEST, 256 * 1024);
  });

  it("answers a path it does not show with its status and the reason, and nothing of the file", () => {
    for (const [wanted, status] of [["temp/big.txt", 413], ["temp/nul.txt", 415], ["projects/demo/.env", 403], ["temp/missing.txt", 404], ["temp/out-link.txt", 403]]) {
      const answered = view(root, wanted);
      assert.equal(answered.status, status, wanted);
      assert.ok(!answered.page.includes("A=1") && !answered.page.includes("outside the instance\n"), wanted);
    }
    assert.match(view(root, "temp/big.txt").page, /more than the 1048576 the view shows/);
  });

  it("links only the stylesheets and the two scripts the server serves, and nothing inline", () => {
    const { page } = view(root, "desks/Ann/notes.txt");
    assert.match(page, /<script src="\/theme\.js"><\/script>/);
    assert.match(page, /<script src="\/view\.js" defer><\/script>/);
    assert.match(page, /<link rel="stylesheet" href="\/md\.css">/);
    assert.match(page, /<link rel="stylesheet" href="\/view\.css">/);
    assert.equal(page.split("<script").length - 1, 2);
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

  // The file's content and nothing else, across the whole page: no header, no column in the middle,
  // and nothing inside the page that scrolls or wraps, so a wide file widens the page and the
  // window's own scrollbar is the one that moves it.
  it("draws the file's content alone across the whole page, nothing in it scrolling or wrapping", () => {
    for (const wanted of ["desks/Ann/notes.txt", "projects/demo/README.md", "temp/missing.txt"]) {
      const { page } = view(root, wanted);
      assert.match(page, /<body class="view">\n<main class="md">/, wanted);
      assert.ok(!page.includes("<header"), wanted);
    }
    const css = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "chat", "view.css"), "utf8");
    const rule = (selector) => css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
    assert.equal(rule(".view main"), " padding: 16px; ");
    assert.match(rule(".view .md .code"), /overflow: visible; width: max-content; min-width: 100%;/);
    assert.match(rule(".view .md pre"), /overflow: visible;/);
    assert.match(rule(".view .md table"), /overflow: visible; max-width: none;/);
    assert.ok(!/white-space|overflow-wrap|word-break|overflow: (auto|scroll|hidden)/.test(css.replace(/^html \{ overflow: scroll; \}$/m, "")), "nothing in the view wraps or scrolls");
  });

  // The window's scrollbars are always there, both of them, whether the view needs them or not, so
  // swapping the drawn file for its source never shifts the page and the toggle under the pointer.
  it("always shows the window's two scrollbars, so swapping the view never moves the toggle", () => {
    const css = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "chat", "view.css"), "utf8");
    assert.match(css, /^html \{ overflow: scroll; \}$/m);
  });

  // The view's window carries the page's own plain icon, never the asking one, and its policy lets
  // an image of the server's own load, which is what a favicon is to a browser that holds it to it.
  it("shows the page's plain icon in the window's tab, which its policy lets load", () => {
    for (const page of [view(root, "desks/Ann/notes.txt").page, view(root, "temp/missing.txt").page, unknown()]) {
      assert.ok(page.includes('<link rel="icon" href="/icons/192.png">'));
    }
    assert.match(HEADERS["content-security-policy"], /; img-src 'self';/);
  });

  // The raw view: the file's text as it is, each line a span the stylesheet numbers with a counter
  // in a column as wide as the last number, so a selection never takes the numbers. It is drawn
  // hidden beside the rendered file, and a fixed toggle swaps the two in place; nothing keeps the
  // choice, so a reload shows the rendered file. A refused path has neither.
  it("draws the file's raw text, lines numbered outside the text, behind a fixed toggle that swaps it in place and keeps nothing", () => {
    assert.equal(raw("a <b>\n\nc\n"), '<pre class="raw digits-1" hidden><span class="line">a &lt;b&gt;</span>\n<span class="line"></span>\n<span class="line">c</span></pre>');
    assert.equal(raw("x"), '<pre class="raw digits-1" hidden><span class="line">x</span></pre>');
    assert.equal(raw(""), '<pre class="raw digits-1" hidden></pre>');
    assert.match(raw("x\n".repeat(10)), /^<pre class="raw digits-2" hidden>/);
    assert.match(raw("x\n".repeat(1000)), /^<pre class="raw digits-4" hidden>/);
    const { page } = view(root, "projects/demo/README.md");
    assert.match(page, /<main class="md"><h1>Demo<\/h1>[\s\S]*<\/main>\n<pre class="raw digits-1" hidden><span class="line"># Demo<\/span>[\s\S]*<\/pre>\n<button type="button" class="raw-toggle" aria-pressed="false" title="View the file's source">View source<\/button>\n<\/body>/);
    assert.ok(!view(root, "temp/missing.txt").page.includes("raw"));
    const script = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "chat", "view.js"), "utf8");
    assert.match(script, /toggle\.addEventListener\("click", \(\) => \{\s*const showRaw = toggle\.getAttribute\("aria-pressed"\) !== "true";\s*toggle\.setAttribute\("aria-pressed", String\(showRaw\)\);\s*drawn\.hidden = showRaw;\s*text\.hidden = !showRaw;\s*\}\);/);
    assert.ok(!/localStorage|sessionStorage|cookie|location|history|open\(/.test(script), "the choice is kept nowhere and nothing is navigated");
    const css = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "chat", "view.css"), "utf8");
    assert.match(css, /^\.view pre\.raw \{[^}]*background: var\(--raw-bg\); color: var\(--raw-fg\); font: \.85rem\/1\.4 var\(--mono\); counter-reset: line; \}/m);
    assert.match(css, /^\.view pre\.raw \.line::before \{ counter-increment: line; content: counter\(line\);[^}]*user-select: none; \}/m);
    for (let digits = 1; digits <= 7; digits += 1) assert.ok(css.includes(`.view pre.raw.digits-${digits} .line::before { width: ${digits}ch; }`), `${digits} digits`);
    assert.ok(String(LARGEST).length <= 7, "the most lines a shown file can have is at most 7 digits");
    assert.ok(!/^\.view pre\.raw[^{]*\{[^}]*display/m.test(css.replace(/::before \{[^}]*\}/g, "")), "nothing overrides the hidden attribute");
    assert.match(css, /^\.view \.raw-toggle \{ position: fixed; right: 12px; bottom: 12px;/m);
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
