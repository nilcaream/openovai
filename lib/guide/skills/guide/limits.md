# What ovai cannot do

Each limit is followed by the nearest thing ovai can do instead.

- **Slash commands on the page.** Ask for a skill in words. Claude Code's own commands go to admin mode, `<instance>/bin/ovai claude`.
- **Buttons to start, stop or hire sessions.** Ask the Leader in words. The page's one control over a session is the stop button, which interrupts its running turn; the Leader's head also has switches for auto mode, and buttons to reload every session's skills and plugins and to restart or update the server (see `panels-and-team.md`).
- **Choosing a new Worker's name.** Names come from a fixed list. Ask for the task, not the person.
- **Sessions changing Claude Code's settings files.** The Leader adds, moves and removes permission rules through permission popups, except the rules that keep sessions out of the instance's own settings, login and page keys. ovai's own settings in `openovai.json` (idle minutes, desk limit, usage thresholds, context limits, default models) are the Leader's to change when asked, with a tool of its own and no restart; who and where the instance is (user, Leader, port, sign-in mode) is changed in an editor. Everything else is done in admin mode or an editor.
- **Changes reaching running sessions.** A permission rule in `.claude/settings.json` applies at each session's next call, whether it came from a permission popup or an editor. Skills and plugins reach running sessions with the reload button on the Leader's head. Other settings, MCP servers, `customization/` and `knowledge/common.md` are read at a session's start. Restart: `ovai restart`, the restart button, or ask the Leader. `openovai.json` is the exception: the server takes most of it while it runs (see `setup-and-update.md`).
- **Windows.** WSL 2 has not been tried, and native Windows is not supported. To try WSL 2, keep the instance off `/mnt/c`. macOS is built for and checked with stand-ins on Linux, but ovai has not yet been run on a Mac.
- **Updating while the server or any session runs.** `ovai stop`, then `ovai update`; or a click on the version on the Leader's head while it is red for a newer release, which does both and starts the server again.
- **Rolling back an update to 0.20.0 or earlier from GitHub.** Those releases carry no signed package, so the updater refuses them. `ovai update --downgrade` takes an older release that is signed, 0.21.0 or later, and `--from <directory>` takes any.
- **Pushing, sudo, ssh from a session.** A fresh instance denies them. They are rules in `.claude/settings.json`, which the person may change in an editor.
- **Reaching the page from another machine.** It listens on 127.0.0.1 only.
- **Answering a permission popup from a phone or when nobody is there.** A popup waits 10 minutes and is then denied. Grant the rules ahead of time instead.
- **A long run surviving a reboot.** A run started with `ovai run` survives its session and the server, not a reboot or a kill: it is told as lost, and starting it again under the same name resumes it when its command skips what it saved (see `panels-and-team.md`).
- **Keeping a session's conversation after it restarts.** A new session starts from the desk file. Anything not written there is gone from what it knows, though the panel still shows the old rows, and the session can search them, and the copies of its desk, when it is asked about the past.
