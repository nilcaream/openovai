# The diff view

A page that shows what changed in a git repository of the instance, read-only, as a code review
does.

## Asking for one
- Ask any session in words: "show me the ovai work from last week", "r24 vs r26", "what is uncommitted in projects/site". The session turns the words into exact revisions with git (tags, branches, the commits' own dates) and calls its `diff` tool with the repository, the old side and the new side.
- The new side may be the working tree: uncommitted changes and new untracked files are included. Ignored files are not.
- The answer is a link, `/diff/<id>`, in the session's reply. It opens in a new tab, as a file link does.
- The view takes no revision from its address: a link only ever shows what the session captured.

## What it captures
- The list of files that differ, and both whole sides of each file, at the moment the session asked. A later change to the repository does not change the page; ask again for a fresh one.
- A capture is kept for 24 hours, in `<instance>/temp/diffs/`, and then dropped. An old link says the diff is gone.
- A file the file view never shows (anything under a `.git` directory or a Claude Code home, keys, a `.env` or credentials file) is listed by its name, and its content is never captured.
- A file that is not UTF-8 text, or larger than 1 MiB, is listed with a note instead of its lines. A side larger than 256 KiB is drawn without colours.
- A diff of more than 1000 files is refused; ask for a narrower one.

## The page
- One file at a time. The list of files on the left can be hidden with the Files button; it can be widened by dragging its corner. Previous and next file: the ‹ › buttons, or `[` and `]`.
- Side by side to start; the Unified button switches. The choice, and whether the list is shown, are kept in the browser.
- Three unchanged lines are shown on each side of a change; a longer unchanged run is folded. A click opens a fold; Expand all and Collapse all open or fold every one.
- Next and previous change: the ↓ ↑ buttons, `n` and `p`, or F7 and Shift+F7. Past the last change of a file, it goes on to the next file.
- Syntax highlighting with the same colours as the file view, in the page's light or dark theme, and line numbers on both sides.
- A selection in side by side stays on the side it starts on.

## What it cannot do
- No comments on lines, no editing, no merging: it only shows. To change a file, ask a session.
- No word-level marks inside a changed line; the whole line is marked.
- No blame and no commit list. Ask a session for `git log` or `git blame` in words.
