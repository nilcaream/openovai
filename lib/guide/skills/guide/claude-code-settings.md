# Claude Code settings under ovai

Every session is a normal Claude Code, started by ovai with the instance as its working directory and `.local/` as its Claude Code home (`CLAUDE_CONFIG_DIR`).

## Which settings files are read
| File | Sessions on the page | Admin mode (`ovai claude`) |
|---|---|---|
| `.claude/settings.json` (project) | read | not read |
| `.local/settings.json` (user) | read | read |
| `instructions.json` (written at every start; keeps CLAUDE.md files above the instance out) | read | not read |

- A setting for every session on the page goes into `.claude/settings.json`. A setting for the page's sessions and admin mode alike goes into `.local/settings.json`.
- No session may edit either file: both are denied to them. The Leader can add permission rules through its cards (see cards-and-permissions.md), but any other setting is changed in admin mode (`/config`, or ask it to edit the file) or in an editor.
- Sessions read their settings when they start. After a change, restart them: ask the Leader, or run `ovai restart`.

## The sandbox
The sandbox is Claude Code's own; ovai adds nothing to it and changes nothing in it. Turn it on with a `"sandbox"` block in `.claude/settings.json` for the page's sessions, or in `.local/settings.json` for them and admin mode, then restart the sessions. Its keys and its platform requirements (bubblewrap on Linux; not native Windows) are on https://code.claude.com/docs/en/sandboxing, for the Claude Code version the release pins (see `lib/RUNTIME`).

## What ovai wires into .claude/settings.json
- A hook before each Bash call. A command made of several parts runs without a card when every part is already allowed. A command that hides another program (a backtick or `$(`) is refused with a reason.
- A hook when a subagent starts. The subagent is handed `customization/common.md`.
- Commit and pull request attribution is turned off.
- The permission rules a fresh instance starts with.

An update wires missing hooks, and names but never adds rules a fresh instance would have.

## Environment
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are always removed. `CLAUDE_CODE_OAUTH_TOKEN` is kept only for an instance that signs in by `inherit`.
- Variables from a Claude Code session ovai itself was started from are removed.
- Claude Code's own updater is off.
- A session on the page runs at the effort its model names (e.g. `opus/high`), so `CLAUDE_CODE_EFFORT_LEVEL` is removed for it. Admin mode keeps the person's own.
