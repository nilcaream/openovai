# Slash commands and admin mode

## Slash commands on the page
They are not supported. What is typed on a panel reaches the session as a message, not as a command line, so `/mcp`, `/review`, `/config` or any other slash command is read as words.
- A skill (including one a user command came from) is used by asking for it in words: "use the review skill on this branch".
- Claude Code's own commands are run in admin mode.

## Admin mode
Run in a terminal:

    <instance>/bin/ovai claude

It opens plain, interactive Claude Code on the instance, as the person, with the instance's Claude Code home. Everything `/mcp`, `/plugin`, `/config` or `claude mcp login` writes lands where the page's sessions will read it. The same commands run in a bare `claude` would write the person's own home instead.

What it is for:
- Signing in to an MCP server, adding one, installing a Claude Code plugin or marketplace.
- Changing Claude Code settings that sessions may not edit (see claude-code-settings.md).

What it leaves out, on purpose:
- The instance's project settings (`.claude/settings.json`), so the rules written for unattended sessions do not apply. Every edit asks the person there.
- ovai's own tools: admin mode is not on the team, has no desk and cannot message anyone.
- The model and effort the seats run on: admin mode uses the person's own choice.
- ovai's guide.

It may be opened while the server runs. Changes reach a session only when it starts, so restart after: `ovai restart`, or ask the Leader. When admin mode closes, ovai compares the configuration files and tells the Leader what changed: names only, never values such as tokens.
