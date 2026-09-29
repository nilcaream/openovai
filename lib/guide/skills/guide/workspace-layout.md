# Workspace layout

What is in the instance directory, and what each part is for.

## Where work goes
- `projects/`: what is worked on. A repository the team should change is cloned here. Something in `reference/` that needs edits is cloned or copied fresh into `projects/`, never moved.
- `reference/`: what is kept to look at: documents, sources, clones for analysis. It is added to, never worked on.
- `temp/`: scratch. Anyone may delete anything in it at any time.

## The team
- `desks/<Name>/`: one directory per seat. `STATE.md` is the desk file the session keeps. `conversation.json` is its panel. `persona.md` is what it was told at its last start. The listing of `desks/` is the roster.
- `archive/`: desks of Workers that were let go, moved whole.
- `knowledge/`: the team's notes, one Markdown file per topic, and `knowledge/files/` for files a note needs (see knowledge-and-customization.md).
- `customization/`: `common.md`, `leader.md`, `worker.md`, the person's standing rules. An update never touches them.
- `plugins/`: tools the instance serves itself, one file each. They are the person's and kept across updates.

## The tool
- `bin/ovai`: the one command.
- `lib/`: everything else a release ships, with its version in `lib/VERSION`. An update replaces it whole, including this guide.
- `openovai.json`: the instance's description of itself: user, Leader, models, port, sign-in mode. It holds no paths.
- `instructions.json`: the settings document every session is started with, written at every start.
- `runtime.json`: the running server's address, pid and start time. `runtime.log`: what the server said, every run appended.
- `page-session`: the key a signed-in browser's cookie carries. Delete it to sign every browser out. `page-link`: the pending one-time link.
- `introduced`: the version whose introduction the page last showed.
- `admin.json`: what admin mode left when it closed.
- `.claude/settings.json`: Claude Code's project settings for every session: permission rules, the hooks ovai wires, attribution off.
- `.local/`: the instance's own Claude Code home: account, transcripts, memory, user-level settings, MCP servers and plugins added in admin mode.

The instance directory and `.local/` are readable by their owner only. So are `runtime.json`, `runtime.log`, `page-session` and `page-link`.
