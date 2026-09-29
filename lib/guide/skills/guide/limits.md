# What ovai cannot do

Each limit is followed by the nearest thing ovai can do instead.

- **Slash commands on the page.** Ask for a skill in words. Claude Code's own commands go to admin mode, `<instance>/bin/ovai claude`.
- **Buttons to start, stop or hire sessions.** Ask the Leader in words. The page's only control is STOP, which interrupts the running turn.
- **Choosing a new Worker's name.** Names come from a fixed list. Ask for the task, not the person.
- **Sessions changing Claude Code's settings files.** The Leader adds permission rules through permission popups. Everything else is done in admin mode or an editor.
- **Changes reaching running sessions.** Settings, MCP servers, plugins, `customization/` and `knowledge/common.md` are read at a session's start. Restart: `ovai restart`, or ask the Leader.
- **Native Windows.** Use WSL 2, with the instance off `/mnt/c`.
- **Updating while the server or any session runs.** `ovai stop`, then `ovai update`.
- **Rolling back an update.** Take the older release with `ovai update --downgrade`.
- **Pushing, sudo, ssh from a session.** A fresh instance denies them. They are rules in `.claude/settings.json`, which the person may change in an editor.
- **Reaching the page from another machine.** It listens on 127.0.0.1 only.
- **Answering a permission popup from a phone or when nobody is there.** A popup waits 10 minutes and is then denied. Grant the rules ahead of time instead.
- **Keeping a session's conversation after it restarts.** A new session starts from the desk file. Anything not written there is gone, though the panel still shows the old rows.
