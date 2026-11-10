// The moment as ovai shows it to a person, to the second: `2026-09-23 Wednesday 16:03:40` — the
// date as ISO 8601 writes it, the weekday whole, the 24-hour clock, nothing else. One definition
// for the server, which writes it in the machine's zone (a panel's stamp rows, the sign-in line),
// and for the page, which stamps every row with it in the reader's own: the page imports this
// file as it is, so it holds the format and nothing that reads the machine.

const formats = new Map();

// The whole stamp, and its clock alone for where a row's label leaves no room for the whole. No
// zone is the zone of whoever runs it.
export function stampOf(date, zone) {
  if (!formats.has(zone)) {
    formats.set(zone, new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }));
  }
  const part = Object.fromEntries(formats.get(zone).formatToParts(date).map((piece) => [piece.type, piece.value]));
  const clock = `${part.hour}:${part.minute}:${part.second}`;
  return { whole: `${part.year}-${part.month}-${part.day} ${part.weekday} ${clock}`, clock };
}
