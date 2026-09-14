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
// `{ who, kind: "line", text, err }` for a tool call — the summary the server wrote for it, red
// once the call failed. `names.chat` is who the server writes as when it is nobody — the chat
// saying what became of a message. The User's own rows say `you`, and on the Leader's panel one
// typed to a Worker says where it went.
//
// A message between two sessions carries `to`, and the two panels draw it differently.
// `names.seat` is whose panel the row is on and `names.leader` who the Leader is. The Leader's
// panel carries its whole text under compact markdown, `To <name>` on one ground and
// `From <name>` on another, and a call the Leader made carries its outcome as a glyph. A
// Worker's panel stays slim: a call it made and a message it received are each one line, red
// when the call did not go; its own answer stays its reply.
export function row(entry, names) {
  if (typeof entry.line === "string") {
    return { who: entry.from, kind: "line", text: entry.line, err: entry.err === true };
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
    const to = typeof entry.typedTo === "string" ? ` → ${entry.typedTo}` : "";
    return { who: `you${to}`, kind: "user", text: String(entry.text) };
  }
  if (entry.from === names.chat) {
    return { who: names.chat, kind: "chat", text: String(entry.text) };
  }
  if (typeof entry.to === "string") {
    if (names.seat === names.leader) {
      if (entry.from === names.seat) {
        const status =
          entry.outcome === undefined ? {} : { status: { text: OUTCOME[entry.outcome], bad: entry.outcome !== "sent", title: entry.why ?? "" } };
        return { who: `To ${entry.to}`, kind: "peer-out", html: html(entry.text), tight: true, ...status };
      }
      return { who: `From ${entry.from}`, kind: "peer-in", html: html(entry.text), tight: true };
    }
    if (entry.outcome !== undefined) {
      return { who: entry.from, kind: "line", text: `Writing a message to ${entry.to}`, err: entry.outcome !== "sent" };
    }
    if (entry.to === names.seat) {
      return { who: entry.from, kind: "line", text: `Received a message from ${entry.from}`, err: false };
    }
  }
  return { who: entry.from, kind: "reply", html: html(entry.text) };
}
