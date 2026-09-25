// One row of a panel, as the page draws it. Pure: a row in, what to show out — the words of a
// speaker, or the HTML of a reply — so the same code runs under node for the checks and in the
// browser for the page. What is HTML here is HTML the parser made from markdown, and nothing
// else: raw HTML inside a reply is escaped, a link is kept only on a scheme a page can follow
// without running anything, and an image is a link rather than a fetch the reply would cause.

import { Marked } from "./marked.mjs";

function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const FOLLOWABLE = /^(https?:|mailto:)/i;

function anchor(href, inner) {
  return typeof href === "string" && FOLLOWABLE.test(href.trim())
    ? `<a href="${escape(href)}" target="_blank" rel="noopener">${inner}</a>`
    : inner;
}

const parser = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(token) {
      return escape(token.text);
    },
    link({ href, tokens }) {
      return anchor(href, this.parser.parseInline(tokens));
    },
    image({ href, text }) {
      return anchor(href, escape(text));
    },
  },
});

// A reply's markdown as HTML.
export function html(text) {
  return parser.parse(String(text));
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
function folded(text) {
  return { html: html(text), tight: true, placeholder: !opensWithProse(text) };
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

// Whether the pill between two days goes before the first row of the new day: never before the
// first row drawn, whatever its day, and not before a row that says when a session ended or
// started — that row is a pill with the whole day and time on it already, the same words.
export function dayPillBefore(entry, shownDay) {
  return shownDay !== null && entry.stamp !== true;
}

// One row: `{ who, kind, text }` for words shown as they are, `{ who, kind, html }` for a reply,
// `{ who, kind: "line", text, err, why }` for a tool call — the summary the server wrote for it, red
// once the call failed, with the reason the result gave for a tooltip — and `{ who, kind:
// "divider", text }` for a word between two sessions on one panel, drawn the way the day between
// two rows is: the Leader's process gone, the next row the start of a fresh one. `names.chat` is who the
// server writes as when it is nobody — the chat saying what became of a message. `names.user` is
// the User's name: the User's own rows carry it, and on the Leader's panel one typed to a Worker
// reads `<User> → <Worker>` on a ground of its own, since it is not a prompt to the Leader. The
// User's own row says whether the frame it became has reached the process — `delivered` — and
// the page shows it waiting until then.
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
// line finds it. One the Leader sent urgent reads `Urgent to <name>` on its panel and `Received an
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
  if (entry.from === names.chat) {
    return { who: names.chat, kind: "chat", text: String(entry.text) };
  }
  if (typeof entry.to === "string") {
    const msg = typeof entry.msg === "string" ? { msg: entry.msg } : {};
    if (entry.overheard === true) {
      return { who: `${entry.from} → ${entry.to}`, kind: "overheard", ...folded(entry.text), ...msg };
    }
    if (names.seat === names.leader) {
      if (entry.from === names.seat) {
        const status =
          entry.outcome === undefined ? {} : { status: { text: OUTCOME[entry.outcome], bad: entry.outcome !== "sent", title: entry.why ?? "" } };
        return { who: `${entry.urgent === true ? "Urgent to" : "To"} ${entry.to}`, kind: "peer-out", ...folded(entry.text), ...status, ...msg };
      }
      return { who: `From ${entry.from}`, kind: "peer-in", ...folded(entry.text), ...msg };
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
  return { who: entry.from, kind: "reply", html: html(entry.text) };
}
