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

// One row: `{ who, kind, text }` for words shown as they are, `{ who, kind, html }` for a reply,
// `{ who, kind: "line", text, err }` for a tool call — the summary the server wrote for it, red
// once the call failed. `names.chat` is who the server writes as when it is nobody — the chat
// saying what became of a message. The User's own rows say `you`, and on the Leader's panel one
// typed to a Worker says where it went.
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
  return { who: entry.from, kind: "reply", html: html(entry.text) };
}
