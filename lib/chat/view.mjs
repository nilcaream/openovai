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

import fs from "node:fs";
import path from "node:path";

import { HOME } from "../claude.mjs";
import { candidates, escape, html } from "./render.mjs";

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
  return { ok: true, path: segments.join("/"), text, size: bytes.length, modified: stat.mtime };
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
  "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function page(title, head, main) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#eef1f5">
<title>${escape(title)}</title>
<link rel="stylesheet" href="/md.css">
<link rel="stylesheet" href="/view.css">
<script src="/theme.js"></script>
<body class="view">
<header>${head}</header>
<main class="md">${main}</main>
</body>
</html>
`;
}

// The view's answer for a path: the status and the page.
export function view(root, wanted) {
  const shown = viewable(root, wanted);
  if (!shown.ok) {
    return { status: shown.status, page: page(path.posix.basename(wanted) || "ovai", `<code class="path">${escape(wanted)}</code>`, `<p>${escape(shown.why)}</p>`) };
  }
  const about = `<code class="path">${escape(shown.path)}</code> <span class="about">read-only · ${shown.size} bytes · ${escape(shown.modified.toISOString())}</span>`;
  return { status: 200, page: page(path.posix.basename(shown.path), about, body(root, shown)) };
}

// The page the view answers when it is opened without the page's cookie.
export function unknown() {
  return page("ovai", "", "<p>Open this file from a link on the ovai page.</p>");
}
