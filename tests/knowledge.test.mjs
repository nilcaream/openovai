// What this workspace knows, as files: the note contract, the two tools built over it at every
// call, and the one note the framework hands to every session at its start.
//
// The division these tests hold to is the one the tools are built on: `index` says what is there
// and judges none of it, `validate` judges all of it and says what to fix. A note with two tags
// appears in every index it belongs in AND is reported by `validate` — both, and each test says
// which of the two it is about.
//
// Notes are written here as text rather than built from a helper, because the thing under test is
// a contract about what a file looks like, and a helper that assembled a head correctly would hide
// exactly the mistakes the contract exists to catch.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { index, validate } from "../lib/knowledge.mjs";
import { persona } from "../lib/desks.mjs";
import { remove, repo, scratch } from "./helpers.mjs";

// `validate` takes today from the zone it is running in, so the zone these checks run in has to be
// this file's choice rather than the machine's: left alone, `reports a date after today` passes in
// Berlin and fails in New York for the very same instant. Pinned here, and the one check that is
// about the difference between local and UTC sets its own zone and puts this one back.
process.env.TZ = "UTC";

const root = scratch("knowledge");
const dir = path.join(root, "knowledge");

function note(name, text) {
  fs.writeFileSync(path.join(dir, name), text);
}

function head({ summary = "What a session gets from reading this", tags = "[alpha, beta, gamma]", sources = "[reference/thing]", updated = "2026-09-20" } = {}) {
  return `---\nsummary: ${summary}\ntags: ${tags}\nsources: ${sources}\nupdated: ${updated}\n---\n\nThe facts.\n`;
}

// One directory for the whole file: every note is named for the test that wants it, so a check
// reads the shelf as it really is — a hundred notes of other people's, with its own among them —
// which is the only state these tools are ever called in.
before(() => {
  fs.mkdirSync(dir, { recursive: true });
  note("alpha-note.md", head({ summary: "Alpha, and what it is for", tags: "[alpha, beta, gamma]" }));
  note("beta-note.md", head({ summary: "Beta, and what it is for", tags: "[beta, delta, epsilon]" }));
  note("gamma-note.md", head({ summary: "Gamma, and what it is for", tags: "[gamma, delta, zeta]" }));
});

after(() => {
  remove(root);
});

describe("the index", () => {
  it("counts the notes and says when the directory last changed", () => {
    const first = index(root).split("\n")[0];
    assert.match(first, /^knowledge\/ — 3 notes, last changed \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  // The tag line is the point of the call: it is the workspace's vocabulary, and a session that
  // writes a note without having seen it invents a fourth spelling of a tag three notes carry.
  it("lists every tag alphabetically with the number of notes carrying it", () => {
    const tags = index(root).split("\n")[1];
    assert.equal(tags, "tags (6): alpha 1 · beta 2 · delta 2 · epsilon 1 · gamma 2 · zeta 1");
  });

  // Around a broken shelf, so that what is reported and what is merely thin are told apart in the
  // one call. `unreadable.md` has no head, `notes.txt` is not a note at all, and `thin.md` is a
  // note that breaks two rules — which is the other tool's business and not this one's.
  function aroundBrokenFiles(check) {
    note("unreadable.md", "No head at all.\n");
    note("notes.txt", "Not a note.\n");
    note("thin.md", head({ tags: "[alpha]", updated: "2099-01-01" }));
    try {
      check(index(root).split("\n"));
    } finally {
      remove(path.join(dir, "unreadable.md"), path.join(dir, "notes.txt"), path.join(dir, "thin.md"));
    }
  }

  it("does not count a file it could not read as one of the notes", () => {
    aroundBrokenFiles((lines) => {
      assert.equal(lines[0].startsWith("knowledge/ — 4 notes,"), true, lines[0]);
    });
  });

  // Read, not judged. A note with one tag and a date in the future is indexed like any other: it
  // is there, and saying what is wrong with it is the other tool's work.
  it("names the files it could not read, each with its reason, and judges nothing else", () => {
    aroundBrokenFiles((lines) => {
      assert.equal(lines.includes("not indexed:"), true);
      assert.equal(
        lines.includes("  unreadable.md — no front matter: a note opens with the head between two `---` lines"),
        true,
        lines.join("\n"),
      );
      assert.equal(lines.includes("  notes.txt — not a .md file"), true, lines.join("\n"));
      assert.equal(
        lines.some((line) => line.includes("thin.md")),
        false,
        "a thin note is indexed, not reported",
      );
    });
  });

  // Breadth and order in one check, because they are one answer: three notes come back for two
  // tags — so a note carrying only one of them is in — and the note at the intersection of the
  // question is first, with two equal notes always the same way round.
  it("returns every note carrying at least one of the asked tags, the ones carrying more of them first", () => {
    const names = index(root, ["delta", "gamma"])
      .split("\n")
      .filter((line) => line.endsWith("]"))
      .map((line) => line.split(" ")[0]);
    assert.deepEqual(names, ["gamma-note.md", "alpha-note.md", "beta-note.md"]);
  });

  it("gives each note as its filename and tags, with the summary indented under it", () => {
    assert.equal(index(root, ["epsilon"]), "beta-note.md  [beta, delta, epsilon]\n  Beta, and what it is for");
  });

  // Tags and nothing else. What a tag means is a decision somebody made when they wrote the note,
  // and a search that also matched the words in a summary would return notes nobody filed there.
  it("matches on tags alone, never on a filename or a summary", () => {
    assert.equal(index(root, ["alpha-note"]).includes("alpha-note.md  ["), false, "a filename is not a tag");
    assert.equal(index(root, ["what"]).includes(".md  ["), false, "a word in a summary is not a tag");
  });

  it("says so when no note carries any of the asked tags", () => {
    assert.equal(index(root, ["omega", "psi"]), "no notes carry any of: omega, psi");
  });
});

describe("validate", () => {
  // Each of these writes its own broken note, asks for the one line about it, and takes the note
  // away again — so a check names the rule it is holding and never reads another check's mess.
  function complaintAbout(name, text, now = new Date("2026-09-22T00:00:00Z")) {
    note(name, text);
    try {
      return validate(root, { now })
        .split("\n")
        .filter((line) => line.startsWith(`${name}:`));
    } finally {
      remove(path.join(dir, name));
    }
  }

  it("answers a sound directory with the count and nothing else", () => {
    assert.equal(validate(root, { now: new Date("2026-09-22T00:00:00Z") }), "3 notes, all valid");
  });

  it("reports a head that is missing one of the four fields", () => {
    const [said] = complaintAbout("missing-field.md", "---\ntags: [alpha, beta, gamma]\nsources: [a/b]\nupdated: 2026-09-20\n---\n");
    assert.equal(said, "missing-field.md: the head has no `summary` (the four fields are summary, tags, sources, updated, all four, none missing)");
  });

  it("reports a head carrying a field the contract has not got", () => {
    const [said] = complaintAbout("extra-field.md", head().replace("updated: 2026-09-20", "updated: 2026-09-20\nauthor: somebody"));
    assert.equal(said, "extra-field.md: the head has `author` (the four fields are summary, tags, sources, updated, and nothing else)");
  });

  it("reports a summary with nothing on the line", () => {
    const [said] = complaintAbout("no-summary.md", head({ summary: "" }));
    assert.equal(said, "no-summary.md: `summary` is one non-empty line: what a session gets from reading this note");
  });

  // Three, because one or two tags describe a note and three begin to describe a shelf.
  it("reports a note carrying fewer than three tags", () => {
    const [said] = complaintAbout("two-tags.md", head({ tags: "[alpha, beta]" }));
    assert.equal(said, "two-tags.md: `tags` has 2, and a note carries at least 3");
  });

  it("reports a tag that is not lowercase letters, digits and hyphens", () => {
    const [said] = complaintAbout("shouty-tag.md", head({ tags: "[alpha, Beta, gamma]" }));
    assert.equal(said, "shouty-tag.md: `tags` has `Beta`, and a tag is lowercase letters, digits and hyphens");
  });

  it("reports a tag named twice", () => {
    const [said] = complaintAbout("twice-tag.md", head({ tags: "[alpha, beta, alpha]" }));
    assert.equal(said, "twice-tag.md: `tags` names `alpha` twice");
  });

  // Form, never existence: a path is not opened and a URL is not fetched, so `validate` never says
  // a note is wrong because a directory moved.
  it("reports a source that is not a path from the instance root, a URL, or what the User said", () => {
    const [said] = complaintAbout("bad-source.md", head({ sources: "[/etc/passwd]" }));
    assert.equal(said, "bad-source.md: `sources` has `/etc/passwd`, and a source is a path from the instance root, a URL, or `<user>`");
    assert.deepEqual(complaintAbout("fine-source.md", head({ sources: "[reference/a, https://example.com/x, <user>]" })), []);
    // Literally that word: a path shaped like it is a source nobody can follow.
    assert.deepEqual(complaintAbout("near-miss.md", head({ sources: "[<usr>]" })), [
      "near-miss.md: `sources` has `<usr>`, and a source is a path from the instance root, a URL, or `<user>`",
    ]);
  });

  it("reports a date that is not a real YYYY-MM-DD", () => {
    assert.deepEqual(complaintAbout("odd-date.md", head({ updated: "22-09-2026" })), ["odd-date.md: `updated` is `22-09-2026`, and a date is YYYY-MM-DD"]);
    assert.deepEqual(complaintAbout("no-such-day.md", head({ updated: "2026-02-31" })), ["no-such-day.md: `updated` is `2026-02-31`, and a date is YYYY-MM-DD"]);
    // A month or a day out of range is two digits like any other, so it passes the shape and
    // reaches the round-trip. `2026-02-31` rolls over to March and comes back differing; these
    // make no date at all, and the tool that exists to report a malformed note must report them
    // rather than fall over on them — one typo would otherwise take the reading down for the
    // whole directory.
    assert.deepEqual(complaintAbout("month-13.md", head({ updated: "2026-13-01" })), ["month-13.md: `updated` is `2026-13-01`, and a date is YYYY-MM-DD"]);
    assert.deepEqual(complaintAbout("month-00.md", head({ updated: "2026-00-10" })), ["month-00.md: `updated` is `2026-00-10`, and a date is YYYY-MM-DD"]);
    assert.deepEqual(complaintAbout("day-45.md", head({ updated: "2026-09-45" })), ["day-45.md: `updated` is `2026-09-45`, and a date is YYYY-MM-DD"]);
  });

  it("reports a date after today", () => {
    const [said] = complaintAbout("tomorrow.md", head({ updated: "2026-09-23" }));
    assert.equal(said, "tomorrow.md: `updated` is `2026-09-23`, which is after today (2026-09-22)");
    assert.deepEqual(complaintAbout("today.md", head({ updated: "2026-09-22" })), []);
  });

  // The date a seat writes is the one its environment handed it, which is local; taking today from
  // UTC reported a note written that evening as dated tomorrow. Found by running the tool against
  // the real directory rather than by any fixture, because it only shows where local is ahead of
  // UTC — which, on the machine this was found on, meant the two hours before midnight.
  //
  // So the offset is stated here rather than waited for: a fixed zone AND a fixed instant, which
  // makes this red every time it runs under a UTC `today` and green every time under a local one,
  // at noon as much as at midnight.
  it("takes today from the local zone rather than from UTC", () => {
    const zone = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      // Half past eleven at night on the 15th in UTC is already half past one in the afternoon of
      // the 16th at +14, so a note dated the 16th there is today's and not tomorrow's.
      const evening = new Date("2026-01-15T23:30:00Z");
      assert.deepEqual(complaintAbout("far-east.md", head({ updated: "2026-01-16" }), evening), []);
    } finally {
      process.env.TZ = zone;
    }
  });

  it("reports a filename that is not lowercase letters, digits and hyphens", () => {
    const [said] = complaintAbout("Shouty_Name.md", head());
    assert.equal(said, "Shouty_Name.md: a filename is lowercase letters, digits and hyphens, ending `.md`");
  });

  // A file it could not read as a note at all, at both ends of that: one with no head, and one
  // that is not a note in the first place. Reported and then let alone — nobody is told a stray
  // file's tags are wrong, only that it is there, which is why each of these is one line and not
  // the four a note with an empty head would otherwise collect.
  it("reports a file it could not read as a note, and holds it to none of the other rules", () => {
    assert.deepEqual(complaintAbout("headless.md", "Straight into the facts.\n"), [
      "headless.md: no front matter: a note opens with the head between two `---` lines",
    ]);
    assert.deepEqual(complaintAbout("Notes.txt", "Whatever this is.\n"), ["Notes.txt: not a .md file"]);
  });

  // The closing line, in both numbers it can carry. Both broken notes here break the same rule and
  // break it plainly, so that this check is about the count and never about which rule found what.
  it("closes with the number of notes and the number of problems, one of them in the singular", () => {
    note("one-bad.md", head({ tags: "[alpha]" }));
    try {
      assert.equal(validate(root, { now: new Date("2026-09-22T00:00:00Z") }).split("\n").at(-1), "4 notes, 1 problem");
      note("two-bad.md", head({ tags: "[beta]" }));
      assert.equal(validate(root, { now: new Date("2026-09-22T00:00:00Z") }).split("\n").at(-1), "5 notes, 2 problems");
    } finally {
      remove(path.join(dir, "one-bad.md"), path.join(dir, "two-bad.md"));
    }
  });
});

// The one note the framework knows by name. It is an ordinary note — same head, indexed and
// validated with the rest — and what is special is only that every session is handed it.
describe("the common note in a persona", () => {
  const home = scratch("knowledge-persona");
  const names = { user: "Mike", leader: "Superman" };

  before(() => {
    fs.mkdirSync(path.join(home, "lib", "templates"), { recursive: true });
    fs.mkdirSync(path.join(home, "customization"), { recursive: true });
    fs.mkdirSync(path.join(home, "knowledge"), { recursive: true });
    for (const role of ["leader", "worker"]) {
      fs.copyFileSync(path.join(repo, "lib", "templates", `${role}.md`), path.join(home, "lib", "templates", `${role}.md`));
    }
  });

  after(() => {
    remove(home);
  });

  it("frames the common note after the person's own files, naming the file it came from", () => {
    fs.writeFileSync(path.join(home, "customization", "common.md"), "Answer in French.\n");
    fs.writeFileSync(path.join(home, "knowledge", "common.md"), head({ summary: "Who works here" }));
    try {
      const text = persona(home, "Jane", names);
      assert.equal(text.includes(`<knowledge source="knowledge/common.md">\n${head({ summary: "Who works here" })}</knowledge>`), true, text.slice(-400));
      assert.equal(text.indexOf("<knowledge source=") > text.indexOf("</customization>"), true, "the knowledge frame comes after the person's own");
    } finally {
      remove(path.join(home, "customization", "common.md"), path.join(home, "knowledge", "common.md"));
    }
  });

  // A clean instance has an empty `knowledge/` and no common note, and reads exactly as it did.
  it("renders no frame and no error when there is no common note", () => {
    const text = persona(home, "Jane", names);
    assert.equal(text.includes("<knowledge"), false);
    assert.equal(text.includes("</knowledge>"), false);
  });
});

// The instruction text, in both personas. Example over definitions: the head shows the shape and
// `validate`'s messages carry the rules, so what is checked here is that a session is told where
// knowledge lives, which call comes first, and when to write.
describe("what a session is told about knowledge", () => {
  const read = (role) => fs.readFileSync(path.join(repo, "lib", "templates", `${role}.md`), "utf8");

  it("tells both roles where knowledge is, to call index first, and to validate what they wrote", () => {
    for (const role of ["leader", "worker"]) {
      const text = read(role);
      assert.match(text, /The workspace's knowledge is `knowledge\/`: Markdown notes, one topic per file, facts only\./, role);
      assert.match(text, /Before you search or write, call `index\(\)`\nfor the tags in use/, role);
      assert.match(text, /Then call `validate` and fix what it\nreports before you go on\./, role);
      assert.match(text, /^tags: \[billing-service, invoicing, rounding\]$/m, role);
    }
  });

  // The backstop is a sentence, not a rule: `common.md` is read by every session here, so a wrong
  // line in it costs everybody, and it is the Leader who gathers it.
  it("tells a Worker never to edit the common note, and tells the Leader it is theirs", () => {
    assert.match(read("worker"), /`common\.md` is the one note you never edit/);
    assert.doesNotMatch(read("worker"), /`common\.md` is yours/);
    assert.match(read("leader"), /`common\.md` is yours: the team, whom to heed, the business, the lingo/);
    assert.match(read("leader"), /Call\n`validate` at the end of a round\./);
  });
});
