// The file view: one file of the instance, read-only, at /view/<path from the instance root>.
//
// Whether a path can be viewed is one function, `viewable`, and it is the same call wherever it is
// asked: by the view when a page opens a link, and by the server when it sends a row, so a row
// carries a link only to a file the view will show. A path is read from the instance root and
// nowhere else. It is shown when it names a regular file whose real path — symlinks followed — is
// inside the real instance root, when nothing on the way is denied (the instance's Claude Code home,
// any .git directory, a .env file, a .credentials.json), and when the file is at most LARGEST bytes
// of UTF-8 text with no NUL in its first BINARY_PROBE bytes. These are checks on what is shown; the
// view has the same callers as the page, and the page secret is what it asks of them.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { HOME } from "../claude.mjs";
import { candidates, escape, html, opensInBrowser } from "./render.mjs";

export const LARGEST = 1024 * 1024;
export const BINARY_PROBE = 8192;

const MISSING = { ok: false, status: 404, why: "There is no file at this path in the instance." };

// A real path's segments, from the real root, that name something the view never shows: the instance's own Claude Code home
// at the root, a .git directory anywhere, a .env or .env.* file, a .credentials.json. Whatever
// their case: on a filesystem that folds case — macOS's and Windows' by default — `.GIT/config`
// names the same file as `.git/config`, and the real path keeps the case it was asked for.
function denied(segments) {
  const folded = segments.map((segment) => segment.toLowerCase());
  const name = folded.at(-1);
  return (
    folded[0] === HOME.toLowerCase() ||
    folded.includes(".git") ||
    name === ".credentials.json" ||
    /^\.env(\..*)?$/.test(name)
  );
}

// `{ ok: true, path, text, size, modified }` for a file the view shows, with its path from the root
// as the view names it; `{ ok: false, status, why }` for one it does not, with the reason a person
// reads on the page.
export function viewable(root, wanted) {
  if (typeof wanted !== "string" || wanted === "" || wanted.includes("\0") || path.isAbsolute(wanted)) {
    return MISSING;
  }
  let top;
  let real;
  try {
    top = fs.realpathSync(root);
    real = fs.realpathSync(path.join(top, wanted));
  } catch {
    return MISSING;
  }
  if (!real.startsWith(top + path.sep)) {
    return { ok: false, status: 403, why: "This path leads outside the instance." };
  }
  const segments = path.relative(top, real).split(path.sep);
  if (denied(segments)) {
    return { ok: false, status: 403, why: "This file is not shown: the view never shows the instance's Claude Code home, a .git directory, a .env file or a .credentials.json." };
  }
  let bytes;
  let stat;
  try {
    stat = fs.statSync(real);
    if (!stat.isFile()) {
      return { ok: false, status: 404, why: "This path is not a file." };
    }
    if (stat.size > LARGEST) {
      return { ok: false, status: 413, why: `This file is ${stat.size} bytes, more than the ${LARGEST} the view shows.` };
    }
    bytes = fs.readFileSync(real);
  } catch {
    return MISSING;
  }
  let text;
  try {
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) {
      throw new Error("binary");
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, status: 415, why: "This file is not text: the view shows UTF-8 text only." };
  }
  return { ok: true, path: segments.join("/"), real, text, size: bytes.length, modified: stat.mtime };
}

// A file the view would show that is also a web page by its real path's extension — a link named
// .html that leads to a .desktop file is refused, since the desktop's opener runs what that names.
// `{ ok: true, real }` with the real path the opener is given; else what `viewable` answers, or 415.
export function openable(root, wanted) {
  const shown = viewable(root, wanted);
  if (!shown.ok) {
    return shown;
  }
  if (!opensInBrowser(shown.real)) {
    return { ok: false, status: 415, why: "Only a web page, an .html or .htm file, opens in the browser." };
  }
  return { ok: true, real: shown.real };
}

// The desktop's own opener: what a double click in a file manager runs.
export const OPENER = process.platform === "darwin" ? "open" : "xdg-open";
// How long an opener that has neither failed nor exited is waited for before the file counts as
// opened: one that starts the browser itself can run on as long as the browser does.
export const OPENING = 3000;

// Hands a real path to the desktop's opener: detached, an argument rather than a shell line, its
// output ignored. `{ ok: true }` once it exits 0 or is still running after OPENING ms; `{ ok: false, why }`
// when it is not installed, cannot start or exits otherwise. The path is absolute, so the opener never
// reads it as an option.
export function openOnDesktop(real) {
  return new Promise((resolve) => {
    const opener = OPENER === "open"
      ? spawn("open", [real], { detached: true, stdio: "ignore" })
      : spawn("xdg-open", [real], { detached: true, stdio: "ignore" });
    const waited = setTimeout(() => {
      opener.unref();
      resolve({ ok: true });
    }, OPENING);
    opener.on("error", (error) => {
      clearTimeout(waited);
      resolve({ ok: false, why: error.code === "ENOENT" ? `${OPENER} is not installed.` : `${OPENER} did not start: ${error.message}` });
    });
    opener.on("exit", (code) => {
      clearTimeout(waited);
      resolve(code === 0 ? { ok: true } : { ok: false, why: `${OPENER} exited with ${code ?? "a signal"}.` });
    });
  });
}

// The paths in a piece of markdown the view would show, each once: what `html` links.
export function viewableIn(root, text) {
  return candidates(text).filter((wanted) => viewable(root, wanted).ok);
}

// A row as it goes to the page: the paths in its words the view would show, when there are any.
export function withViewable(root, row) {
  if (typeof row?.text !== "string") {
    return row;
  }
  const found = viewableIn(root, row.text);
  return found.length === 0 ? row : { ...row, viewable: found };
}

// The language tag a code file's fence carries, by its extension or, for a few, its whole name.
// No highlighter reads it yet; it is the hook one needs.
const LANGUAGES = {
  mjs: "javascript", cjs: "javascript", js: "javascript", ts: "typescript", json: "json", webmanifest: "json",
  sh: "bash", bash: "bash", py: "python", yaml: "yaml", yml: "yaml", toml: "toml",
  html: "html", htm: "html", css: "css", xml: "xml", svg: "xml", sql: "sql",
  go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", rb: "ruby",
  diff: "diff", patch: "diff",
};
const NAMED = { Dockerfile: "dockerfile", Makefile: "makefile" };
const MARKDOWN = new Set(["md", "markdown"]);

export function languageOf(file) {
  const name = path.posix.basename(file);
  if (Object.hasOwn(NAMED, name)) return NAMED[name];
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return Object.hasOwn(LANGUAGES, extension) ? LANGUAGES[extension] : "";
}

// A file that is not markdown, as markdown: one fenced block with its language tag, the fence one
// backtick longer than the longest run of backticks in the file, so nothing in it can close it.
export function fenced(text, language) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}`;
}

// What the view draws of a file it shows: markdown as markdown, anything else fenced.
export function body(root, shown) {
  const extension = shown.path.slice(shown.path.lastIndexOf(".") + 1).toLowerCase();
  const source = MARKDOWN.has(extension) && shown.path.includes(".") ? shown.text : fenced(shown.text, languageOf(shown.path));
  return html(source, viewableIn(root, source));
}

export const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

// The head of a page drawn in a theme, written in by the server from the cookie the page keeps,
// so the first paint is already that theme: the window's ground (color-scheme) and an installed
// app's title bar (theme-color, the head bubble's ground, --panel-2 in md.css) as well as the
// tokens. Light for anything but dark, as the page does. The view's page and the page itself
// (page.html, which carries the light one for the server to replace) both open with it; their
// scripts still repaint from the page's store.
const THEME_COLOR = { light: "#eef1f5", dark: "#1c232d" };

export function themeHead(wanted) {
  const theme = wanted === "dark" ? "dark" : "light";
  return `<html lang="en" data-theme="${theme}">
<meta name="color-scheme" content="${theme}">
<meta name="theme-color" content="${THEME_COLOR[theme]}">`;
}

// The file's text as it is, for the raw view: every line its own span, numbered by a CSS counter
// in a column as wide as the last line's number (the class says how many digits), so a selection
// copies the text and never the numbers. Hidden until the toggle shows it.
export function raw(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  const drawn = text === "" ? [] : lines;
  const digits = String(Math.max(drawn.length, 1)).length;
  return `<pre class="raw digits-${digits}" hidden>${drawn.map((line) => `<span class="line">${escape(line)}</span>`).join("\n")}</pre>`;
}

// The toggle between the drawn file and its raw text, fixed in the page's bottom right corner.
const TOGGLE = '<button type="button" class="raw-toggle" aria-pressed="false" title="Show the file as raw text">raw</button>';

function page(title, main, theme, after = "") {
  return `<!doctype html>
${themeHead(theme)}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="stylesheet" href="/md.css">
<link rel="stylesheet" href="/view.css">
<script src="/theme.js"></script>
<script src="/view.js" defer></script>
<body class="view">
<main class="md">${main}</main>${after}
</body>
</html>
`;
}

// The view's answer for a path, in the theme named: the status and the page. Its title is the
// page's own title, the instance as `named` says it, with the path from the root after it.
// A web page is never shown here, by its real path: it opens in the browser from its link on the
// page (openable), and the view has nothing of it to offer.
export function view(root, wanted, theme, named) {
  const found = viewable(root, wanted);
  const shown = found.ok && opensInBrowser(found.real) ? WEB_PAGE : found;
  if (!shown.ok) {
    return { status: shown.status, page: page(`${named}/${wanted}`, `<p>${escape(shown.why)}</p>`, theme) };
  }
  return { status: 200, page: page(`${named}/${shown.path}`, body(root, shown), theme, `\n${raw(shown.text)}\n${TOGGLE}`) };
}

const WEB_PAGE = { ok: false, status: 404, why: "A web page is not shown here: it opens in the browser from its link on the ovai page." };

// The page the view answers when it is opened without the page's cookie, in the theme named.
export function unknown(theme) {
  return page("ovai", "<p>Open this file from a link on the ovai page.</p>", theme);
}
