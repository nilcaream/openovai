# MCP servers and plugins

## An MCP server
- Add it in admin mode (`<root>/bin/ovai claude`) with Claude Code's own `/mcp`, or `claude mcp add --scope user …`. It is written to the instance's `.local/.claude.json`.
- A server that needs a sign-in (OAuth) is signed in to the same way: `/mcp` in admin mode.
- A credential a server needs goes in its configuration there, never in a note or a message.
- Then restart the sessions (`ovai restart`, or ask the Leader). A session sees servers only from its next start.
- Its tools then ask for permission like any other tool. A rule such as `mcp__github__*` can be granted from a card.

## A Claude Code plugin
Install it in admin mode with `/plugin` (a marketplace first, if it comes from one). It is recorded in the instance's `.local/settings.json` and `.local/plugins/`, so it is the instance's and not the person's own Claude Code's. Restart the sessions for them to have it. A plugin's slash commands still cannot be typed on a panel: ask for its skills in words.

## A tool the workspace serves itself (an ovai plugin)
- `<root>/bin/ovai plugin <name>` writes `plugins/<name>.mjs` from a scaffold. A name is a letter followed by up to 31 letters, digits or hyphens, and cannot be a built-in tool's name.
- The file exports `description`, `inputSchema` and `run`. `run` answers `{ text }` or `{ refused }`, and is told which seat called it, as the server knows it.
- Every session sees it as `mcp__openovai__<name>`, with no card, under the rule the instance already holds for ovai's tools. The file decides for itself whom it answers.
- Plugins are loaded when the server starts: `ovai restart` after adding or changing one. One that fails to load is reported and skipped.
- `plugins/` is the person's and is kept across updates.
