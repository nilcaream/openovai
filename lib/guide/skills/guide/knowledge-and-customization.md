# Knowledge and customization

Two places for what the team should keep between sessions. `knowledge/` holds facts: what is true. `customization/` holds standing rules: what sessions must do or never do. A line that can be obeyed or broken is a rule. A line that is true or false is knowledge.

## knowledge/
- Markdown notes, one topic per file, with a lowercase hyphenated filename. Each starts with a head of four fields: `summary`, `tags` (at least three), `sources`, `updated`.
- Any session may write notes without asking. The `index` tool lists the tags in use and the notes on a tag, and `validate` checks every head. Words are found with grep. There is no database or index file: every answer is built from the files at the moment it is asked.
- `knowledge/files/` holds files a note needs of its own, such as templates or images.
- `knowledge/common.md` is handed to every session at its start: the team, the lingo, where things are, which notes to read first. The Leader keeps it. Every edit to it asks the person first, since it reaches every seat.

## customization/
- `common.md` is given to every session. `leader.md` is given to the Leader. `worker.md` is given to every Worker, and also to the Leader, marked as the Workers', so it knows what they are told. A subagent a session starts gets `common.md` only.
- A few numbered lines, one rule per line, rarely changed. They add to what ovai tells a session and take nothing away.
- They are the person's: an update never touches them. A session asks the person before every edit. Workers propose lines; the Leader writes one only when the person says so.
- A change reaches sessions started after it, not running ones. The Leader tells running Workers the new line, or restarts them.

## Asking for either
Tell the Leader: "remember that …" for a fact, or "always …" / "never …" for a rule. The Leader decides which it is, then writes the note, or proposes the line and asks.
