// One row of a panel, as the page draws it. Pure: a row in, what to show out — the words of a
// speaker, or the HTML of a reply — so the same code runs under node for the checks and in the
// browser for the page. What is HTML here is HTML the parser made from markdown, and nothing
// else: raw HTML inside a reply is escaped, a link is kept only on a scheme a page can follow
// without running anything, and an image is a link rather than a fetch the reply would cause.

import { Marked } from "./marked.mjs";

export function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const FOLLOWABLE = /^(https?:|mailto:)/i;

function anchor(href, inner) {
  return typeof href === "string" && FOLLOWABLE.test(href.trim())
    ? `<a href="${escape(href)}" target="_blank" rel="noopener">${inner}</a>`
    : inner;
}

// A file or a directory named in a reply: a backticked path from the instance root, or a markdown
// link to one, a directory's with or without a slash at its end — never an absolute path, never a
// URL, nothing with a blank in it. A `:12`, `:12-20` or `:12:5` after it is where in the file, not
// part of its path. What a name looks like is only the first half:
// the server says which of these the view would show (view.mjs), and only those are linked.
const PATH = /^(?![/~])([^\s:\\`<>"|?*]+?)(?::\d+(?:[-:]\d+)?)?$/;

export function pathOf(text) {
  const found = PATH.exec(String(text));
  return found === null ? null : found[1];
}

// The view's address for a path from the instance root, a segment at a time.
function viewHref(file) {
  return `/view/${file.split("/").map(encodeURIComponent).join("/")}`;
}

// A web page or an image, by its extension, or a directory, by the slash at its end: what the
// desktop opens — a web page in the browser, an image in the image viewer, a directory in the file
// manager — rather than the view showing it, as a double click in a file manager would. Nothing else
// is ever handed to the desktop.
const PAGES = /\.html?$/i;
const IMAGES = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

export function isImage(file) {
  return IMAGES.test(String(file));
}

export function opensOnDesktop(file) {
  return PAGES.test(String(file)) || isImage(file) || String(file).endsWith("/");
}

// The address that asks the server to open a file on the desktop: a POST, never a navigation.
export function openHref(file) {
  return `/open/${file.split("/").map(encodeURIComponent).join("/")}`;
}

// The link to a file the view would show or the desktop opens. A web page's, an image's or a
// directory's link carries the address that opens it, which the page follows on a click; the view's
// address only makes it a link, since the view refuses each and says where it opens.
function fileLink(file, inner) {
  const opens = opensOnDesktop(file) ? ` data-opens="${openHref(file)}"` : "";
  return `<a href="${viewHref(file)}" target="_blank" rel="noopener"${opens}>${inner}</a>`;
}

// Which of the names in `viewable` this one is, if it is one: a directory's is there with the slash
// at its end, whether or not the reply wrote it.
function shownFile(name, viewable) {
  const file = pathOf(name);
  if (file === null) return null;
  if (viewable.includes(file)) return file;
  return viewable.includes(`${file}/`) ? `${file}/` : null;
}

// The paths the view is being given to draw: set by `html` for the one parse it runs, so the
// renderer reads them without a second parser per call.
let drawing = [];

const parser = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(token) {
      return escape(token.text);
    },
    // marked hands over the text after an inline <pre>, <code>, <kbd> or <script> — in every block
    // after it until the tag is closed — as already escaped, since it expects the tag drawn as HTML.
    // Here the tag is escaped, so that text is not: marked's own text renderer escapes it.
    text(token) {
      token.escaped = false;
      return false;
    },
    codespan({ text }) {
      const file = shownFile(text, drawing);
      return file === null ? false : fileLink(file, `<code>${escape(text)}</code>`);
    },
    link({ href, tokens }) {
      // A backticked path inside a link's words is part of that link, never a second one in it.
      const file = shownFile(href, drawing);
      const outer = drawing;
      drawing = [];
      const inner = this.parser.parseInline(tokens);
      drawing = outer;
      return file === null ? anchor(href, inner) : fileLink(file, inner);
    },
    image({ href, text }) {
      return anchor(href, escape(text));
    },
  },
});

// A reply's markdown as HTML. `viewable` is the paths the server found the view would show; a
// backticked path or a markdown link to one of them opens it, in a tab of its own, and a web page
// in the browser.
export function html(text, viewable = []) {
  drawing = Array.isArray(viewable) ? viewable : [];
  try {
    return parser.parse(String(text));
  } finally {
    drawing = [];
  }
}

// Every path a piece of markdown names the way `html` would link it — backticked, or as a link's
// target — each once, in order. Code blocks name nothing.
export function candidates(text) {
  const found = [];
  parser.walkTokens(parser.lexer(String(text)), (token) => {
    const name = token.type === "codespan" ? token.text : token.type === "link" ? token.href : null;
    const file = name === null ? null : pathOf(name);
    if (file !== null && !found.includes(file)) found.push(file);
  });
  return found;
}

// Whether a message's markdown opens with a paragraph of plain text, so a fold of it has a first
// line to show. Decided on the source, never on the DOM: the first non-blank line, its leading
// blanks dropped, opens a table (`|`), a list (`-`, `*` or `+` and a blank; digits, `.` or `)` and
// a blank), a heading (`#` to `######` and a blank), a quote (`>`), a fence (three backticks or
// tildes) or a rule (`---`, `***`, `___`) — or it does not, and then it is prose. A message with no
// line at all is prose too: there is nothing under a fold of it.
const OPENS_A_BLOCK = /^(?:\||[-*+] |\d+[.)] |#{1,6} |>|```|~~~|---|\*\*\*|___)/;
export function opensWithProse(text) {
  const first = String(text).split("\n").find((line) => line.trim() !== "");
  return first === undefined || !OPENS_A_BLOCK.test(first.trimStart());
}

// The sentence a silent turn is shown as, and the one an interrupted turn is.
export const SILENT = "(ended its turn without saying anything)";
export const INTERRUPTED = "turn interrupted";

// The glyph a message the Leader sent carries, by what became of it.
const OUTCOME = { sent: "sent ✓", refused: "refused ✗", "not sent": "not sent ✗" };

// The body of a message between sessions, as the Leader's panel folds it: its compact markdown,
// and whether the fold shows a placeholder rather than a first line.
function folded(text, viewable) {
  return { html: html(text, viewable), tight: true, placeholder: !opensWithProse(text) };
}

// A row that says when a session ended or started is not drawn when the one before it of that
// kind is less than a minute older and was drawn itself: of two that close — an end and a start
// seconds after it — the first is shown and the second is not. Both stay in the conversation;
// this is the drawing only. It reads only the rows before it, so a row appended later draws the
// same as it would in a whole draw.
const STAMPS_APART = 60_000;

export function collapsed(rows, index) {
  if (rows[index]?.stamp !== true) {
    return false;
  }
  for (let before = index - 1; before >= 0; before -= 1) {
    if (rows[before].stamp === true) {
      return Date.parse(rows[index].at) - Date.parse(rows[before].at) < STAMPS_APART && !collapsed(rows, before);
    }
  }
  return false;
}

// Whether a row is left out of the drawing: a row that says when a session ended or started too
// soon after the last one drawn (`collapsed`), or a turn that said it had nothing for the panel
// (`noop`). Both stay in the conversation; this is the drawing only.
export function unseen(rows, index) {
  return rows[index]?.noop === true || collapsed(rows, index);
}

// Whether `row` draws an entry as one of the messages between the Leader and the Workers — sent,
// received, overheard — the rows the comms switch hides. It reads the entry alone, so the page can
// count the rows a reader sees without building them.
export function talks(entry, names) {
  if (typeof entry.to !== "string" || typeof entry.line === "string") return false;
  if (entry.divider === true || entry.stamp === true || entry.interrupted === true || entry.silent === true || entry.failed === true) return false;
  if (entry.from === "user" || entry.from === names.chat) return false;
  return entry.overheard === true || names.seat === names.leader;
}

// One row: `{ who, kind, text }` for words shown as they are, `{ who, kind, html }` for a reply,
// `{ who, kind: "line", text, err, why }` for a tool call — the summary the server wrote for it, red
// once the call failed, with the reason the result gave for a tooltip — and `{ who, kind:
// "divider", text }` for a word between two sessions on one panel, drawn as a pill among the rows:
// the Leader's process gone, the next row the start of a fresh one, and the time a session ended
// or started. `names.chat` is who the server writes as when it is nobody — the chat saying what
// became of a message. `names.user` is the User's name: the User's own rows carry it, and on the
// Leader's panel one typed to a Worker reads `<User> → <Worker>` on a ground of its own, since it
// is not a prompt to the Leader. The User's own row says whether the frame it became has reached
// the process — `delivered` — and the page shows it waiting until then.
//
// A message between two sessions carries `to` and `msg`, the id both ends of it share, and the
// two panels draw it differently. `names.seat` is whose panel the row is on and `names.leader`
// who the Leader is. The Leader's panel carries its whole text under compact markdown, `To <name>`
// on one ground and `From <name>` on another, and a call the Leader made carries its outcome as a
// glyph. A Worker's panel stays slim: a call it made and a message it received are each one line
// that carries the id, so a click on it finds the message on the Leader's panel — `Sent` once it
// went, `Writing` in red with the reason when it did not; its own answer stays its reply. One
// between two Workers is on the Leader's panel too, marked `overheard`, and reads `<sender> →
// <addressee>` on a ground of its own — not a prompt to the Leader, and not the User's words — under
// the same compact markdown as `To` and `From`. It carries the id, so a click on either Worker's
// line finds it. One the Leader sent urgent reads `To <name> (urgent)` on its panel and `Received an
// urgent message` on the Worker's. The three carry `placeholder` too: true when the markdown opens
// with something other than a paragraph, so the page folds the row behind a placeholder rather than a first line
// it does not have.
export function row(entry, names) {
  if (typeof entry.line === "string") {
    return { who: entry.from, kind: "line", text: entry.line, err: entry.err === true, why: entry.why ?? "" };
  }
  if (entry.divider === true || entry.stamp === true) {
    return { who: names.chat, kind: "divider", text: String(entry.text) };
  }
  if (entry.interrupted === true) {
    return { who: names.chat, kind: "interrupted", text: INTERRUPTED };
  }
  if (entry.silent === true) {
    return { who: entry.from, kind: "silent", text: SILENT };
  }
  if (entry.failed === true) {
    return { who: entry.from === names.chat ? names.chat : entry.from, kind: "failed", text: String(entry.text) };
  }
  if (entry.from === "user") {
    if (typeof entry.typedTo === "string") {
      return { who: `${names.user} → ${entry.typedTo}`, kind: "typed", text: String(entry.text) };
    }
    return { who: names.user, kind: "user", text: String(entry.text), delivered: entry.delivered === true };
  }
  // The introduction is the one row of the server's own that is written as markdown, and the one
  // that is not folded: it is there to be read.
  if (entry.from === names.chat && entry.introduction === true) {
    return { who: names.chat, kind: "introduction", html: html(entry.text, entry.viewable) };
  }
  if (entry.from === names.chat) {
    return { who: names.chat, kind: "chat", text: String(entry.text) };
  }
  if (typeof entry.to === "string") {
    const msg = typeof entry.msg === "string" ? { msg: entry.msg } : {};
    if (entry.overheard === true) {
      return { who: `${entry.from} → ${entry.to}`, kind: "overheard", ...folded(entry.text, entry.viewable), ...msg };
    }
    if (names.seat === names.leader) {
      if (entry.from === names.seat) {
        const status =
          entry.outcome === undefined ? {} : { status: { text: OUTCOME[entry.outcome], bad: entry.outcome !== "sent", title: entry.why ?? "" } };
        return { who: `To ${entry.to}${entry.urgent === true ? " (urgent)" : ""}`, kind: "peer-out", ...folded(entry.text, entry.viewable), ...status, ...msg };
      }
      return { who: `From ${entry.from}`, kind: "peer-in", ...folded(entry.text, entry.viewable), ...msg };
    }
    if (entry.outcome === "sent") {
      return { who: entry.from, kind: "line", text: `Sent a message to ${entry.to}`, err: false, why: "", ...msg };
    }
    if (entry.outcome !== undefined) {
      return { who: entry.from, kind: "line", text: `Writing a message to ${entry.to}`, err: true, why: entry.why ?? "" };
    }
    if (entry.to === names.seat) {
      return { who: entry.from, kind: "line", text: `Received ${entry.urgent === true ? "an urgent" : "a"} message from ${entry.from}`, err: false, why: "", ...msg };
    }
  }
  return { who: entry.from, kind: "reply", html: html(entry.text, entry.viewable) };
}
