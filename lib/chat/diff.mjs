// The diff view: a change in a repository of the instance, read-only, at /diff/<id>.
//
// A diff is captured first and drawn later. `capture` is what the `diff` tool runs: it takes a
// repository, by its path from the instance root, and two sides — revisions git names exactly, or
// `worktree` for the new side, the working tree with its uncommitted changes and its new untracked
// files — and keeps, at that moment, the list of files that differ, both whole sides of each and
// the ranges git's histogram diff says changed. The capture is a file under CAPTURES, named by a
// random id, and the link to it is `/diff/<id>`. It is volatile: kept KEPT ms from when it was
// made, then dropped, and the caller makes a new one when it needs one. The view never runs git
// and takes no revision from an address: what it draws is what was captured.
//
// History is read by git, past the filesystem's checks, so every path in a capture is passed
// through the view's own `denied` — a file under a .git directory, a Claude Code home, keys or a
// file of credentials is listed by its name and never captured. A revision is resolved with
// `--end-of-options` and one that starts with `-` is refused before git sees it; every git is a
// literal spawn with its arguments in a list, never a shell line.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import hljs from "./highlight/core.mjs";
import { escape } from "./render.mjs";
import { BINARY_PROBE, DRAWN_LARGEST, LARGEST, denied, languageOf, themeHead } from "./view.mjs";

// Where captures are kept, from the instance root: scratch, which anybody may clear at any time.
export const CAPTURES = path.join("temp", "diffs");
// How long a capture is kept, from when it was made.
export const KEPT = 24 * 60 * 60 * 1000;
// The new side that is the working tree rather than a revision.
export const WORKTREE = "worktree";
// The unchanged lines drawn on each side of a change; a longer run between is folded.
export const CONTEXT = 3;
// The most files one capture lists, and the most bytes of text it keeps across all of them: past
// the second, a file is listed with no sides.
export const MOST_FILES = 1000;
export const CAPTURE_LARGEST = 32 * 1024 * 1024;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCaptureId(id) {
  return typeof id === "string" && ID.test(id);
}

// git, run in a directory, its output whole. The environment keeps it from asking for anything
// and from taking the index lock to refresh it: a capture reads and never writes.
function git(cwd, args, input = "") {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => resolve({ code: -1, out: Buffer.alloc(0), err: error.message }));
    child.on("close", (code) => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString("utf8").trim() }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// The options every diff here is run with, whatever the repository's own configuration says:
// renames found, the histogram algorithm, no colour, no external diff or text conversion, paths
// from the top of the repository, and a working tree file whose stat changed but whose content did
// not left out of every format alike.
const DIFF = ["-c", "diff.autoRefreshIndex=true", "diff", "-M", "--histogram", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative"];

// A revision as a commit's full id, or null: refused before git when it is empty, starts with `-`
// or holds a NUL or a line break.
const optionLike = (asked) => typeof asked === "string" && asked.startsWith("-");

export async function resolve(top, asked) {
  if (typeof asked !== "string" || asked === "" || optionLike(asked) || /[\0\r\n]/.test(asked)) return null;
  const found = await git(top, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${asked}^{commit}`]);
  const id = found.out.toString("utf8").trim();
  return found.code === 0 && /^[0-9a-f]{40,64}$/.test(id) ? id : null;
}

// A commit as the page names it: what was asked, its id, its committer date and its subject.
async function described(top, asked, id) {
  const found = await git(top, ["log", "-1", "--no-walk", "--format=%cI%x00%s", "--end-of-options", id]);
  const [date = "", subject = ""] = found.out.toString("utf8").replace(/\n$/, "").split("\0");
  return { asked, id, date, subject };
}

// The repository a path names: its top directory, real, inside the real instance root and nothing
// `denied` names on the way, and that top's segments from the root.
async function repository(root, wanted) {
  const refused = (why) => ({ ok: false, why });
  if (typeof wanted !== "string" || wanted === "" || wanted.includes("\0")) return refused("repository must be a path from the instance root.");
  let top;
  let real;
  try {
    top = fs.realpathSync(root);
    real = fs.realpathSync(path.resolve(top, wanted));
  } catch {
    return refused(`There is no directory ${wanted} in the instance.`);
  }
  const inside = (where) => where === top || where.startsWith(top + path.sep);
  if (!inside(real) || !fs.statSync(real).isDirectory()) return refused(`${wanted} is not a directory inside the instance.`);
  const found = await git(real, ["rev-parse", "--show-toplevel"]);
  if (found.code !== 0) return refused(`${wanted} is not in a git repository.`);
  let repo;
  try {
    repo = fs.realpathSync(found.out.toString("utf8").trim());
  } catch {
    return refused(`${wanted} is not in a git repository.`);
  }
  if (!inside(repo) || repo === top) return refused(`The repository of ${wanted} is not inside the instance.`);
  const segments = path.relative(top, repo).split(path.sep);
  if (denied(segments)) return refused(`${wanted} is in a directory the view never shows.`);
  return { ok: true, top: repo, segments, name: segments.join("/") };
}

// `git diff --raw -z`: one entry a file, with both modes, both blob ids, the status letter and
// one path, or two for a rename.
export function parseRaw(buffer) {
  const parts = buffer.toString("utf8").split("\0");
  const entries = [];
  for (let i = 0; i < parts.length - 1; ) {
    const head = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(parts[i]);
    if (head === null) throw new Error(`git diff --raw said something this cannot read: ${JSON.stringify(parts[i].slice(0, 80))}`);
    const [, modeA, modeB, blobA, blobB, status] = head;
    const two = status === "R" || status === "C";
    entries.push({ modeA, modeB, blobA, blobB, status, oldPath: parts[i + 1], newPath: two ? parts[i + 2] : parts[i + 1] });
    i += two ? 3 : 2;
  }
  return entries;
}

// `git diff -U0`, split a file at a time at its `diff --git` line, each file's changed ranges as
// [old start, old count, new start, new count], as its hunk headers give them. An unmerged path has
// no `diff --git` line, so the raw list and the patch are paired with those taken out.
export function parseHunks(buffer) {
  const text = buffer.toString("utf8");
  const files = text.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git "));
  return files.map((part) => ({
    header: part.slice(0, part.indexOf("\n") === -1 ? part.length : part.indexOf("\n")),
    hunks: [...part.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]),
  }));
}

// Blobs by id, read in one `git cat-file --batch`: a map from id to bytes; a missing one is absent.
async function blobs(top, ids) {
  const wanted = [...new Set(ids)];
  const found = new Map();
  if (wanted.length === 0) return found;
  const read = await git(top, ["cat-file", "--batch"], wanted.map((id) => `${id}\n`).join(""));
  const out = read.out;
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(0x0a, at);
    if (end === -1) break;
    const line = out.toString("utf8", at, end);
    at = end + 1;
    const head = /^([0-9a-f]+) (\w+) (\d+)$/.exec(line);
    if (head === null) continue;
    const size = Number(head[3]);
    if (head[2] === "blob") found.set(head[1], out.subarray(at, at + size));
    at += size + 1;
  }
  return found;
}

// One side's bytes, as a capture keeps them: its text, or why there is none.
export function sideOf(bytes) {
  if (bytes === null) return { text: null, state: "none" };
  if (bytes.length > LARGEST) return { text: null, state: "large", size: bytes.length };
  try {
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) throw new Error("binary");
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), state: "text" };
  } catch {
    return { text: null, state: "binary" };
  }
}

// A file of the working tree, by its path from the repository's top, as git would have it: a
// symbolic link is the path it holds, never what it points to; a file with a second name, or one
// whose directory leads out of the repository, is not read.
function worktreeBytes(top, file) {
  const full = path.join(top, ...file.split("/"));
  try {
    const directory = fs.realpathSync(path.dirname(full));
    if (directory !== top && !directory.startsWith(top + path.sep)) return { refused: true };
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return { bytes: Buffer.from(fs.readlinkSync(full)) };
    if (!stat.isFile()) return { bytes: null };
    if (stat.nlink > 1) return { refused: true };
    if (stat.size > LARGEST) return { bytes: Buffer.alloc(LARGEST + 1) };
    return { bytes: fs.readFileSync(full) };
  } catch {
    return { bytes: null };
  }
}

const SUBMODULE = "160000";

// The new capture's id and where it is kept, after dropping every capture past KEPT. The
// directory must be the instance's own: one that leads out of it by a link is refused.
function captures(root) {
  const where = path.join(root, CAPTURES);
  fs.mkdirSync(where, { recursive: true });
  const real = fs.realpathSync(where);
  if (!real.startsWith(fs.realpathSync(root) + path.sep)) throw new Error(`${CAPTURES} leads outside the instance`);
  const now = Date.now();
  for (const name of fs.readdirSync(real)) {
    const id = name.replace(/\.json$/, "");
    if (!isCaptureId(id)) continue;
    try {
      if (now - fs.statSync(path.join(real, name)).mtimeMs > KEPT) fs.rmSync(path.join(real, name), { force: true });
    } catch {}
  }
  return real;
}

// The `diff` tool: `{ ok: true, id, files, text }` once captured, `{ ok: false, why }` when it
// cannot be, in words the asker acts on.
export async function capture(root, { repository: wanted, from, to }) {
  const repo = await repository(root, wanted);
  if (!repo.ok) return repo;
  for (const [named, asked] of [["from", from], ["to", to]]) {
    if (optionLike(asked)) return { ok: false, why: `${named}: ${JSON.stringify(asked)} starts with -, which git would read as an option; nothing was run.` };
  }
  const old = await resolve(repo.top, from);
  if (old === null) return { ok: false, why: `from: ${JSON.stringify(from)} is not a commit in ${repo.name}. Give a revision git names exactly — a commit id, a tag or a branch — and never one that starts with -.` };
  const worktree = to === WORKTREE;
  const fresh = worktree ? null : await resolve(repo.top, to);
  if (!worktree && fresh === null) return { ok: false, why: `to: ${JSON.stringify(to)} is not a commit in ${repo.name}, nor "${WORKTREE}". Give a revision git names exactly, or "${WORKTREE}" for the working tree.` };

  const revisions = ["--end-of-options", old, ...(worktree ? [] : [fresh]), "--"];
  const [raw, patch] = await Promise.all([git(repo.top, [...DIFF, "--raw", "-z", "--no-abbrev", ...revisions]), git(repo.top, [...DIFF, "-U0", ...revisions])]);
  if (raw.code !== 0 || patch.code !== 0) return { ok: false, why: `git diff failed in ${repo.name}: ${raw.err || patch.err}` };
  const entries = parseRaw(raw.out);
  const merged = entries.filter((entry) => entry.status !== "U");
  const patched = parseHunks(patch.out);
  if (patched.length !== merged.length) return { ok: false, why: `git diff listed ${merged.length} files and drew ${patched.length}; nothing was captured.` };
  merged.forEach((entry, index) => {
    entry.hunks = patched[index].hunks;
  });
  if (worktree) {
    const others = await git(repo.top, ["ls-files", "--others", "--exclude-standard", "-z", "--full-name"]);
    for (const file of others.out.toString("utf8").split("\0").filter(Boolean)) {
      entries.push({ modeA: "000000", modeB: "100644", blobA: "", blobB: "", status: "A", oldPath: file, newPath: file, untracked: true, hunks: null });
    }
  }
  if (entries.length > MOST_FILES) return { ok: false, why: `${entries.length} files differ, more than the ${MOST_FILES} one capture lists.` };

  const zero = /^0+$/;
  const shown = entries.map((entry) => ({ ...entry, denied: denied([...repo.segments, ...entry.oldPath.split("/")]) || denied([...repo.segments, ...entry.newPath.split("/")]) }));
  const ids = shown.filter((entry) => !entry.denied).flatMap((entry) => [
    ...(entry.status !== "A" && entry.modeA !== SUBMODULE && !zero.test(entry.blobA) ? [entry.blobA] : []),
    ...(entry.status !== "D" && entry.modeB !== SUBMODULE && !zero.test(entry.blobB) && entry.blobB !== "" ? [entry.blobB] : []),
  ]);
  const stored = await blobs(repo.top, ids);

  let kept = 0;
  const files = shown.map((entry) => {
    const file = { status: entry.status, old: entry.status === "A" ? null : entry.oldPath, new: entry.status === "D" ? null : entry.newPath, modes: [entry.modeA, entry.modeB] };
    if (entry.untracked) file.untracked = true;
    if (entry.denied) return { ...file, a: { text: null, state: "denied" }, b: { text: null, state: "denied" }, hunks: [] };
    const sideA = entry.status === "A" ? null : entry.modeA === SUBMODULE ? Buffer.from(`Subproject commit ${entry.blobA}\n`) : stored.get(entry.blobA) ?? null;
    let sideB = null;
    let refusedB = false;
    if (entry.status !== "D") {
      if (entry.modeB === SUBMODULE) sideB = Buffer.from(`Subproject commit ${zero.test(entry.blobB) ? "(working tree)" : entry.blobB}\n`);
      else if (worktree && (entry.untracked || zero.test(entry.blobB))) {
        const read = worktreeBytes(repo.top, entry.newPath);
        refusedB = read.refused === true;
        sideB = read.bytes ?? null;
      } else sideB = stored.get(entry.blobB) ?? null;
    }
    let a = sideOf(sideA);
    let b = refusedB ? { text: null, state: "denied" } : sideOf(sideB);
    const size = (a.text?.length ?? 0) + (b.text?.length ?? 0);
    if (kept + size > CAPTURE_LARGEST) {
      a = a.text === null ? a : { text: null, state: "skipped" };
      b = b.text === null ? b : { text: null, state: "skipped" };
    } else {
      kept += size;
    }
    const hunks = entry.untracked ? (b.text === null || b.text === "" ? [] : [[0, 0, 1, linesOf(b.text).length]]) : entry.hunks;
    return { ...file, a, b, hunks };
  });
  if (files.length === 0) return { ok: true, id: null, files: 0, text: `There is no difference in ${repo.name} between ${from} and ${to}; nothing was captured.` };

  const made = {
    at: new Date().toISOString(),
    repository: repo.name,
    from: await described(repo.top, from, old),
    to: worktree ? { asked: WORKTREE, id: null } : await described(repo.top, to, fresh),
    files,
  };
  const where = captures(root);
  const id = crypto.randomUUID();
  const file = path.join(where, `${id}.json`);
  fs.writeFileSync(`${file}.part`, JSON.stringify(made));
  fs.renameSync(`${file}.part`, file);
  const named = (side) => (side.id === null ? "the working tree" : `${side.asked} (${side.id.slice(0, 10)})`);
  return {
    ok: true,
    id,
    files: files.length,
    text: `Captured ${files.length} file${files.length === 1 ? "" : "s"} of ${repo.name}, ${named(made.from)} → ${named(made.to)}. Link: /diff/${id} — put it in your reply as a markdown link, for example [${from} vs ${to}](/diff/${id}), and it opens as a file link does. The capture is kept for 24 hours; after that, capture again.`,
  };
}

// A capture by its id, or null: none by that id, or one past KEPT.
export function captured(root, id) {
  if (!isCaptureId(id)) return null;
  const file = path.join(root, CAPTURES, `${id}.json`);
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > KEPT) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// A side's lines, as the view numbers them: none for an empty text, and a last newline ends the
// last line rather than starting another — as git counts them.
export function linesOf(text) {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

// highlight.js's HTML of a whole side, cut into lines: every span still open at a line break is
// closed at its end and opened again at the start of the next, so each line is whole HTML and a
// line inside a multi-line string or comment keeps its colour.
export function splitHighlighted(html) {
  const lines = [];
  const open = [];
  let line = "";
  for (const token of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (token === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (token.startsWith("<span")) {
      open.push(token);
      line += token;
    } else if (token === "</span>") {
      open.pop();
      line += token;
    } else {
      line += token;
    }
  }
  lines.push(line + "</span>".repeat(open.length));
  return lines;
}

// A side's lines as HTML: highlighted whole, then cut, when its file has a grammar and is no
// larger than the view draws; escaped as they are otherwise.
export function drawnLines(text, file) {
  const plain = linesOf(text);
  const language = languageOf(file ?? "");
  if (plain.length === 0 || language === "" || text.length > DRAWN_LARGEST) return plain.map(escape);
  const lines = splitHighlighted(hljs.highlight(text.replace(/\n$/, ""), { language, ignoreIllegals: true }).value);
  return lines.length === plain.length ? lines : plain.map(escape);
}

// The file as runs: `same` runs of lines both sides share, and changes, from git's ranges. A range
// with no old lines starts after its old start, as -U0 writes it; so does one with no new lines.
export function runs(oldCount, hunks) {
  const out = [];
  let a = 0;
  let b = 0;
  for (const [oldStart, oldLength, newStart, newLength] of hunks) {
    const a0 = oldLength === 0 ? oldStart : oldStart - 1;
    const b0 = newLength === 0 ? newStart : newStart - 1;
    if (a0 > a) out.push({ same: true, a, b, length: a0 - a });
    out.push({ same: false, a: a0, oldLength, b: b0, newLength });
    a = a0 + oldLength;
    b = b0 + newLength;
  }
  if (a < oldCount) out.push({ same: true, a, b, length: oldCount - a });
  return out;
}

// Which lines of a same run are drawn and which are folded: CONTEXT beside each change, none
// before the first or after the last, and a fold only when it hides more than one line.
export function folds(run, first, last) {
  const head = first ? 0 : CONTEXT;
  const tail = last ? 0 : CONTEXT;
  if (run.length - head - tail <= 1) return { head: run.length, folded: 0, tail: 0 };
  return { head, folded: run.length - head - tail, tail };
}

const number = (n) => `<td class="n">${n}</td>`;
const NO_NUMBER = `<td class="n"></td>`;

// The rows of one file, in both layouts, run by run: `side` for side by side, `unified` for one
// column. Unchanged rows are grouped in a tbody; a fold is a tbody holding its button, and the
// hidden tbody after it the lines it holds. The first row of a change starts it, for next and
// previous change.
function tables(file, A, B) {
  const all = runs(A.length, file.hunks);
  const side = [];
  const unified = [];
  let open = { side: [], unified: [] };
  const flush = () => {
    if (open.side.length > 0) side.push(`<tbody>${open.side.join("")}</tbody>`);
    if (open.unified.length > 0) unified.push(`<tbody>${open.unified.join("")}</tbody>`);
    open = { side: [], unified: [] };
  };
  const same = (a, b, into) => {
    into.side.push(`<tr>${number(a + 1)}<td class="c a">${A[a]}</td>${number(b + 1)}<td class="c b">${B[b]}</td></tr>`);
    into.unified.push(`<tr>${number(a + 1)}${number(b + 1)}<td class="c">${A[a]}</td></tr>`);
  };
  let fold = 0;
  all.forEach((run, index) => {
    if (run.same) {
      const { head, folded, tail } = folds(run, index === 0, index === all.length - 1);
      for (let i = 0; i < head; i += 1) same(run.a + i, run.b + i, open);
      if (folded > 0) {
        flush();
        const hidden = { side: [], unified: [] };
        for (let i = head; i < head + folded; i += 1) same(run.a + i, run.b + i, hidden);
        const button = (span) => `<tbody class="fold" data-fold="${fold}"><tr><td colspan="${span}"><button type="button" class="unfold">⋯ ${folded} unchanged line${folded === 1 ? "" : "s"}</button></td></tr></tbody>`;
        side.push(`${button(4)}<tbody class="folded" data-fold="${fold}" hidden>${hidden.side.join("")}</tbody>`);
        unified.push(`${button(3)}<tbody class="folded" data-fold="${fold}" hidden>${hidden.unified.join("")}</tbody>`);
        fold += 1;
      }
      for (let i = head + folded; i < run.length; i += 1) same(run.a + i, run.b + i, open);
      return;
    }
    const rows = Math.max(run.oldLength, run.newLength);
    for (let i = 0; i < rows; i += 1) {
      const start = i === 0 ? ` class="start"` : "";
      const a = i < run.oldLength ? `${number(run.a + i + 1)}<td class="c a del">${A[run.a + i]}</td>` : `${NO_NUMBER}<td class="c a none"></td>`;
      const b = i < run.newLength ? `${number(run.b + i + 1)}<td class="c b add">${B[run.b + i]}</td>` : `${NO_NUMBER}<td class="c b none"></td>`;
      open.side.push(`<tr${start}>${a}${b}</tr>`);
    }
    for (let i = 0; i < run.oldLength; i += 1) open.unified.push(`<tr${i === 0 ? ` class="start"` : ""}>${number(run.a + i + 1)}${NO_NUMBER}<td class="c del">${A[run.a + i]}</td></tr>`);
    for (let i = 0; i < run.newLength; i += 1) open.unified.push(`<tr${i === 0 && run.oldLength === 0 ? ` class="start"` : ""}>${NO_NUMBER}${number(run.b + i + 1)}<td class="c add">${B[run.b + i]}</td></tr>`);
  });
  flush();
  return `<table class="side"><colgroup><col class="n"><col><col class="n"><col></colgroup>${side.join("")}</table>\n<table class="unified"><colgroup><col class="n"><col class="n"><col></colgroup>${unified.join("")}</table>`;
}

const STATUS = { A: "added", D: "deleted", M: "modified", R: "renamed", C: "copied", T: "type changed", U: "unmerged" };

const WHY = {
  denied: "Not shown: the view never shows a Claude Code home, a .git directory, keys or a file of credentials.",
  binary: "Not drawn: this file is not UTF-8 text.",
  large: `Not drawn: this file is more than the ${LARGEST} bytes the view shows.`,
  skipped: "Not captured: the capture had reached its size before this file.",
};

// What a file has instead of its lines, when a side it needs has none.
function noteOf(file) {
  for (const side of [file.a, file.b]) {
    if (Object.hasOwn(WHY, side.state)) return WHY[side.state];
  }
  return null;
}

const added = (file) => file.hunks.reduce((sum, hunk) => sum + hunk[3], 0);
const removed = (file) => file.hunks.reduce((sum, hunk) => sum + hunk[1], 0);
const nameOf = (file) => file.new ?? file.old;

// One file's head — the status, the path, where it was renamed from, a mode that changed — and the
// place its body is fetched into when it is first shown: a page holds one file at a time, and one
// with every body drawn ran to tens of megabytes (80 files of ovai, 29 MB).
function section(file, index, id) {
  const status = file.untracked ? "untracked" : STATUS[file.status] ?? file.status;
  const renamed = file.old !== null && file.new !== null && file.old !== file.new ? ` <span class="from">from ${escape(file.old)}</span>` : "";
  const mode = file.modes[0] !== file.modes[1] && file.modes[0] !== "000000" && file.modes[1] !== "000000" ? ` <span class="mode">mode ${file.modes[0]} → ${file.modes[1]}</span>` : "";
  const head = `<h2 class="file-head"><span class="status s-${file.untracked ? "N" : escape(file.status)}">${status}</span> <span class="path">${escape(nameOf(file))}</span>${renamed}${mode} <span class="counts"><span class="plus">+${added(file)}</span> <span class="minus">−${removed(file)}</span></span></h2>`;
  return `<section class="file" id="f${index + 1}" data-index="${index}" hidden>\n${head}\n<div class="body" data-src="/diff/${id}/${index + 1}"></div>\n</section>`;
}

// One file's body: its two tables, or the note that stands for them.
export function fileBody(file) {
  const note = noteOf(file);
  if (note !== null) return `<p class="note">${note}</p>`;
  const A = file.a.text === null ? [] : drawnLines(file.a.text, file.old);
  const B = file.b.text === null ? [] : drawnLines(file.b.text, file.new);
  if (A.length === 0 && B.length === 0) return `<p class="note">${file.hunks.length === 0 ? "No change to the content." : "Empty file."}</p>`;
  const drawn = tables(file, A, B);
  return file.hunks.length === 0 ? `<p class="note">No change to the content.</p>\n${drawn}` : drawn;
}

// The list of files on the left: each one's status, path and counts, a link to it.
function list(files) {
  const items = files.map((file, index) => {
    const name = nameOf(file);
    const slash = name.lastIndexOf("/");
    const base = name.slice(slash + 1);
    const dir = slash === -1 ? "" : `<span class="dir">${escape(name.slice(0, slash + 1))}</span>`;
    return `<li><a href="#f${index + 1}" data-index="${index}" title="${escape(name)}"><span class="status s-${file.untracked ? "N" : escape(file.status)}">${file.untracked ? "N" : escape(file.status)}</span> <span class="name">${dir}${escape(base)}</span> <span class="counts"><span class="plus">+${added(file)}</span> <span class="minus">−${removed(file)}</span></span></a></li>`;
  });
  return `<nav class="files" aria-label="Files"><ol>${items.join("")}</ol></nav>`;
}

// A side as the bar names it: what was asked, and the commit's short id, date and subject when it
// is one.
function sideName(side) {
  if (side.id === null) return `<span class="rev" title="the working tree, with its uncommitted changes and new untracked files">working tree</span>`;
  const title = `${side.id}\n${side.date}\n${side.subject}`;
  return `<span class="rev" title="${escape(title)}">${escape(side.asked)} <span class="id">${side.id.slice(0, 7)}</span></span>`;
}

const BAR = (capture, count) => `<header class="bar">
<button type="button" class="toggle-files" aria-pressed="true" title="Show or hide the list of files">Files</button>
<span class="what"><span class="repo">${escape(capture.repository)}</span> ${sideName(capture.from)} → ${sideName(capture.to)}</span>
<span class="spacer"></span>
<span class="group"><button type="button" data-go="file" data-by="-1" title="Previous file ([)">‹</button><span class="position">1 / ${count}</span><button type="button" data-go="file" data-by="1" title="Next file (])">›</button></span>
<span class="group"><button type="button" data-go="change" data-by="-1" title="Previous change (p, Shift+F7)">↑ change</button><button type="button" data-go="change" data-by="1" title="Next change (n, F7)">↓ change</button></span>
<span class="group"><button type="button" class="expand" title="Open every fold">Expand all</button><button type="button" class="collapse" title="Fold every unchanged run again">Collapse all</button></span>
<button type="button" class="layout" aria-pressed="false" title="Side by side or unified">Unified</button>
</header>`;

function page(title, content, theme, bodyClass = "diff") {
  return `<!doctype html>
${themeHead(theme)}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="icon" href="/icons/192.png">
<link rel="stylesheet" href="/md.css">
<link rel="stylesheet" href="/diff.css">
<script src="/theme.js"></script>
<script src="/diff.js"></script>
<body class="${bodyClass}">
${content}
</body>
</html>
`;
}

const GONE = "There is no diff by this link. A capture is kept for 24 hours; ask for a new one.";

// A capture's files, each path passed through `denied` again as it is drawn: a capture is a file
// under temp/, and what is drawn from it is checked here too, not only when it was written.
function checked(found) {
  const segments = (file) => [...found.repository.split("/"), ...file.split("/")];
  return found.files.map((file) => ([file.old, file.new].some((name) => name !== null && denied(segments(name))) ? { ...file, a: { text: null, state: "denied" }, b: { text: null, state: "denied" } } : file));
}

// The view's answer for a capture id, in the theme named: the status and the page — the bar, the
// list of files and each file's head, its body fetched when shown. Its title is the instance as
// `named` says it, then the repository and both sides.
export function diffView(root, id, theme, named) {
  const found = captured(root, id);
  if (found === null) {
    return { status: 404, page: page(named, `<main class="md message"><p>${GONE}</p></main>`, theme, "diff message") };
  }
  const files = checked(found);
  const sections = files.map((file, index) => section(file, index, id)).join("\n");
  const title = `${named} ${found.repository} ${found.from.asked} → ${found.to.asked}`;
  return { status: 200, page: page(title, `${BAR(found, files.length)}\n<div class="frame">\n${list(files)}\n<main class="files-shown">\n${sections}\n</main>\n</div>`, theme) };
}

// One file of a capture, by its number from 1, as the HTML its section's body is filled with.
export function diffFile(root, id, number) {
  const found = captured(root, id);
  if (found === null) return { status: 404, body: `<p class="note">${GONE}</p>` };
  const file = checked(found)[number - 1];
  if (file === undefined) return { status: 404, body: `<p class="note">There is no file ${number} in this diff.</p>` };
  return { status: 200, body: fileBody(file) };
}

// The page the diff view answers when it is opened without the page's cookie, in the theme named.
export function unknownDiff(theme) {
  return page("ovai", `<main class="md message"><p>Open this diff from a link on the ovai page.</p></main>`, theme, "diff message");
}
