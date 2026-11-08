---
name: guide
description: How to set up, use and change OpenOv AI (ovai), the workspace running these sessions, and what it can and cannot do. Use when the user asks how to do something here, whether it is possible, or why the tool behaved as it did, even without saying "ovai". Their words, then ovai's: permission popup, allow/deny box (card); always allow, ask every time (permission rules); chats, tabs, other agents (panels, Leader, Workers, hiring); the stop button (stopping a turn); model, effort, fast mode (seat models); /mcp, /plugin, /config, any slash command (admin mode, `ovai claude`); MCP sign-in, plugins; sandbox, settings, env (Claude Code settings); usage line, fable figure (usage windows); idle timeout, desk size, quota warning, context limit, default model (openovai.json, asked of the Leader); "resumes automatically" (wake-up); update, a new version out, start, stop, restart or reload buttons, the browser link; team notes (knowledge); standing rules (customization); where files go. Not for the user's own project code.
---

# ovai guide

This guide describes the ovai installed here, at the version in `lib/VERSION`. Read the one topic
file the question is about, beside this file, and answer from it. When a topic says ovai cannot do
something, say so and give the nearest thing it can.

`<instance>` in these pages is the instance directory, where ovai is installed. When you answer,
write the real path in its place, as your instructions give it, so the person can copy the line.

- `setup-and-update.md`: install, sign-in (`ovai login` or a token), start, stop, restart, a new browser link (`ovai url`), `ovai update` and `--downgrade`, the notice of a newer release, what an update replaces, and the settings in `openovai.json`: changing them by asking the Leader, which apply while the server runs, and which need a restart.
- `panels-and-team.md`: the Leader and Workers, hiring and letting go, the switches on the Leader's head and auto mode, the restart, update and reload buttons, the Leader's status row, models and effort per seat, why fast mode is off, desks, why a session closes or restarts, what to send when Claude's service cuts a reply, and when the Leader resumes by itself.
- `permissions.md`: the permission popup and its buttons, what "Always allow" writes, ask-every-time and deny rules, a popup that times out, and asking the Leader for a rule.
- `slash-commands-and-admin-mode.md`: why panels take no slash commands, what to do instead (ask in words, or admin mode for `/mcp`, `/plugin`, `/config`), and what admin mode does and leaves out.
- `claude-code-settings.md`: which settings files the seats and admin mode read, the sandbox, env, the hooks ovai wires, and which files sessions may not edit.
- `mcp-and-plugins.md`: adding an MCP server and signing in to it, installing a Claude Code plugin, and a tool the workspace serves itself (`ovai plugin <name>`).
- `knowledge-and-customization.md`: the team's notes in `knowledge/`, and standing rules in `customization/`: who writes them and when a change takes effect.
- `workspace-layout.md`: what each directory in the instance directory is for (desks, projects, reference, temp, knowledge, customization, .local, bin, lib).
- `limits.md`: what ovai cannot do, and the nearest thing it can do for each.
