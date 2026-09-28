---
name: guide
description: How to set up, use and change OpenOv AI (ovai), the workspace that runs these Claude Code sessions, and what it can and cannot do. Use whenever the user asks how to do something here, whether something is possible, or why the tool behaved as it did, even without the word "ovai". Their words, then ovai's: permission popup or allow/deny box (card); always allow, ask me every time (permission rules); the chats, tabs, other agents (panels, Leader, Workers, hiring); which model or effort (seat models); /mcp, /plugin, /config or any slash command (admin mode, `ovai claude`); signing in to an MCP server, installing a plugin; sandbox, settings, env (Claude Code settings under ovai); update, start, stop, the browser link; notes the team keeps (knowledge); standing rules (customization); where files go. Not for questions about the user's own project code.
---

# ovai guide

This guide describes the ovai installed here, at the version in `lib/VERSION`. Read the one topic
file the question is about, beside this file, and answer from it. When a topic says ovai cannot do
something, say so and give the nearest thing it can.

- `setup-and-update.md`: install, sign-in (`ovai login` or a token), start, stop, restart, a new browser link (`ovai url`), `ovai update` and `--downgrade`, and what an update replaces.
- `panels-and-team.md`: the Leader and Workers, hiring and letting go, models and effort per seat, desks, and why a session closes or restarts.
- `cards-and-permissions.md`: the permission popup and its buttons, what "Always allow" writes, ask-every-time and deny rules, a card that times out, and asking the Leader for a rule.
- `slash-commands-and-admin-mode.md`: why panels take no slash commands, what to do instead (ask in words, or admin mode for `/mcp`, `/plugin`, `/config`), and what admin mode does and leaves out.
- `claude-code-settings.md`: which settings files the seats and admin mode read, the sandbox, env, the hooks ovai wires, and which files sessions may not edit.
- `mcp-and-plugins.md`: adding an MCP server and signing in to it, installing a Claude Code plugin, and a tool the workspace serves itself (`ovai plugin <name>`).
- `knowledge-and-customization.md`: the team's notes in `knowledge/`, and standing rules in `customization/`: who writes them and when a change takes effect.
- `workspace-layout.md`: what each directory at the root is for (desks, projects, reference, temp, knowledge, customization, .local, bin, lib).
- `limits.md`: what ovai cannot do, and the nearest thing it can do for each.
