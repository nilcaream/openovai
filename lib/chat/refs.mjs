// A reference in what the User types: `(ref/HH:MM:SS/mmm)`, the time of a row on the same panel to
// the millisecond, on the clock of the machine the server runs on, which is the User's own — the
// page is loopback. Nothing is kept between the click that writes one and the send: the text is
// the whole of it, so a reference typed by hand or edited is read the same way, and one that
// names no row is only text. The page and the server resolve it with the same code here: the
// nearest row before the User's own whose time is that one. Nearest-before is what lets a line
// sent just after midnight find the row from just before it; two rows in one millisecond are not
// told apart, on purpose.

const REF = /\(ref\/(\d\d:\d\d:\d\d)\/(\d\d\d)\)/g;

const two = (n) => String(n).padStart(2, "0");

// When a row was written, local: `HH:MM:SS/mmm` for the reference, and the whole of it as ISO-8601
// without a zone for the session.
export function refOf(at) {
  const when = new Date(at);
  return `${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}/${String(when.getMilliseconds()).padStart(3, "0")}`;
}

export function localAt(at) {
  const when = new Date(at);
  return `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}T${refOf(at).replace("/", ".")}`;
}

// The reference a click on a row's stamp writes.
export function refTo(at) {
  return `(ref/${refOf(at)})`;
}

// A row a reference can name: one the page draws with a stamp — not a tool line, not a divider.
function referable(entry) {
  return entry !== undefined && entry.at !== undefined && typeof entry.line !== "string" && entry.divider !== true && entry.stamp !== true;
}

// Every reference in `text`, in order, as `{ start, end, to, index }`: where it sits in the text,
// its `HH:MM:SS/mmm`, and the index of the row it names in `rows` — searched from `before - 1`
// back — or null when no row has that time.
export function references(rows, before, text) {
  const found = [];
  for (const match of String(text).matchAll(REF)) {
    const to = `${match[1]}/${match[2]}`;
    let index = null;
    for (let at = Math.min(before, rows.length) - 1; at >= 0; at -= 1) {
      if (referable(rows[at]) && refOf(rows[at].at) === to) {
        index = at;
        break;
      }
    }
    found.push({ start: match.index, end: match.index + match[0].length, to, index });
  }
  return found;
}
