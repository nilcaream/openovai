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

// The sentence a silent turn is shown as, and the one an interrupted turn is.
export const SILENT = "(ended its turn without saying anything)";
export const INTERRUPTED = "turn interrupted";

// The glyph a message the Leader sent carries, by what became of it.
const OUTCOME = { sent: "sent ✓", refused: "refused ✗", "not sent": "not sent ✗" };

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
// <addressee>` on the ground the User's typed line has, for the same reason: it is not a prompt to
// the Leader, and the words are shown as they are, like the User's. It carries the id, so a click
// on either Worker's line finds it.
export function row(entry, names) {
  if (typeof entry.line === "string") {
    return { who: entry.from, kind: "line", text: entry.line, err: entry.err === true, why: entry.why ?? "" };
  }
  if (entry.divider === true) {
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
      return { who: `${entry.from} → ${entry.to}`, kind: "typed", text: String(entry.text), ...msg };
    }
    if (names.seat === names.leader) {
      if (entry.from === names.seat) {
        const status =
          entry.outcome === undefined ? {} : { status: { text: OUTCOME[entry.outcome], bad: entry.outcome !== "sent", title: entry.why ?? "" } };
        return { who: `To ${entry.to}`, kind: "peer-out", html: html(entry.text), tight: true, ...status, ...msg };
      }
      return { who: `From ${entry.from}`, kind: "peer-in", html: html(entry.text), tight: true, ...msg };
    }
    if (entry.outcome === "sent") {
      return { who: entry.from, kind: "line", text: `Sent a message to ${entry.to}`, err: false, why: "", ...msg };
    }
    if (entry.outcome !== undefined) {
      return { who: entry.from, kind: "line", text: `Writing a message to ${entry.to}`, err: true, why: entry.why ?? "" };
    }
    if (entry.to === names.seat) {
      return { who: entry.from, kind: "line", text: `Received a message from ${entry.from}`, err: false, why: "", ...msg };
    }
  }
  return { who: entry.from, kind: "reply", html: html(entry.text) };
}
