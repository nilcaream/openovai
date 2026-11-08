# Permission popups and rules

ovai's own instructions call the permission popup a card; say "permission popup" to the person.

## When a permission popup appears
Every session starts in Claude Code's auto mode, as the Claude Code CLI does: a classifier settles the tool calls that the instance's settings neither allow nor deny, and most of them run with no popup. A permission popup appears for a call an `ask` rule names, for a write to a path Claude Code protects (such as `.claude` or `.git`), and, with auto mode switched off for that role (Manual, two switches on the Leader's head, see `panels-and-team.md`), for every call the settings neither allow nor deny. ovai shows it at the bottom of the session's panel. A call a subagent makes gets one too, naming the subagent. Reads inside the instance never stop, and ovai's own tools are allowed from the start.

## The buttons on a permission popup
- **Allow**: this call only. Nothing is saved.
- **Always allow**: this call, plus a rule for every session, current and future. The popup shows the exact rule under "Always allow saves:" before you press.
  - A command gets a rule per part of the command, by prefix, e.g. `Bash(npm test:*)`.
  - A file write gets a rule for its directory, e.g. `Edit(/src/**)`.
  - Other tools get the rule Claude Code itself suggests.
  - The button is left off when no safe rule fits: a single file, a write outside the instance, or a long or shell-heavy one-off command.
  - It is also left off for a command that holds a here-document (`<<`), for a call Claude Code itself marks as one it offers no "don't ask again" on (its `suppress_always_allow_rule`), and for a stop on Claude Code's safety check (a protected path, such as a settings file or `.git`) when it suggests no rule for it. Allow and Deny answer those.
- **Deny**: this call is refused, and the session is told so and tries something else.

A permission popup waits 10 minutes, or 2 for a subagent's call. After that it is denied with a message saying nobody answered. When it was a Worker's popup, the Leader is told. A popup also goes away when the session that asked ends.

## Rules for the whole instance
- The rules live in `.claude/settings.json` in the instance directory, in three lists: `allow` (no popup), `ask` (a popup every time) and `deny` (refused, no popup). Each rule granted from the page is also recorded with who asked, and why, in `.claude/allowed.md`.
- A fresh instance denies `git push`, `sudo` and `ssh`, and the instance's own account files. It asks before any edit to `customization/` and to `knowledge/common.md`.
- After an update, a rule a fresh instance is born with that none of the three lists holds is asked for on a permission popup of its own, headed "A new ovai default rule came with the update", on the Leader's panel. It shows the rule and why ovai recommends it, and has two buttons: the list ovai recommends (Allow, Deny or Ask every time), which writes the rule into that list, and Ignore, which ovai remembers and never asks about again. A popup nobody answers is raised again at the next start of the server. Nothing is added without a press.
- Ask the Leader in words, e.g. "stop asking me before running git status" or "always ask me before pip install". It puts a permission popup on its panel with the rule and its reason, and the buttons Allow, Deny and Ask every time. Your press writes the rule into the matching list. The Leader can also say which rules the instance holds.
- A rule already in one of the lists is asked the same way: the popup says where it stands now ("Now: asked every time"), and your press moves it.
- To take a rule back, ask the Leader in words, e.g. "take the npm ci rule out". Its popup, headed "… asks you to remove a rule", shows the rule, the lists that hold it, the line `.claude/allowed.md` has for it in each (who asked, when, what for), and the buttons Remove and Keep. Remove takes the rule out of every list and adds a line saying so to `.claude/allowed.md`; the earlier lines stay. A rule a fresh instance is born with, once removed, is remembered like an Ignore, so the update popup never asks for it again.
- The rules that keep sessions' file tools away from the instance's own settings, login and page keys are the exception: the Leader can neither move nor remove them. Change those in an editor or in admin mode (`<instance>/bin/ovai claude`). No session may edit `.claude/settings.json`.
- A rule applies at each running session's next call, whether `.claude/settings.json` was changed from a permission popup or by hand in an editor. No restart is needed for a rule.

The rule syntax is Claude Code's own: https://code.claude.com/docs/en/permissions
