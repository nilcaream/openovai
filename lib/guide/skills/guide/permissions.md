# Permission popups and rules

ovai's own instructions call the permission popup a card; say "permission popup" to the person.

## When a permission popup appears
Claude Code asks before a tool call that the instance's settings neither allow nor deny. ovai shows that question as a permission popup at the bottom of the session's panel. A call a subagent makes gets one too, naming the subagent. Reads inside the instance never stop, and ovai's own tools are allowed from the start.

## The buttons on a permission popup
- **Allow**: this call only. Nothing is saved.
- **Always allow**: this call, plus a rule for every session, current and future. The popup shows the exact rule under "Always allow saves:" before you press.
  - A command gets a rule per part of the command, by prefix, e.g. `Bash(npm test:*)`.
  - A file write gets a rule for its directory, e.g. `Edit(/src/**)`.
  - Other tools get the rule Claude Code itself suggests.
  - The button is left off when no safe rule fits: a single file, a write outside the instance, or a long or shell-heavy one-off command.
- **Deny**: this call is refused, and the session is told so and tries something else.

A permission popup waits 10 minutes, or 2 for a subagent's call. After that it is denied with a message saying nobody answered. When it was a Worker's popup, the Leader is told. A popup also goes away when the session that asked ends.

## Rules for the whole instance
- The rules live in `.claude/settings.json` in the instance directory, in three lists: `allow` (no popup), `ask` (a popup every time) and `deny` (refused, no popup). Each rule granted from the page is also recorded with who asked, and why, in `.claude/allowed.md`.
- A fresh instance denies `git push`, `sudo` and `ssh`, and the instance's own account files. It asks before any edit to `customization/` and to `knowledge/common.md`.
- After an update, a rule a fresh instance is born with that none of the three lists holds is asked for on a permission popup of its own, headed "A new ovai default rule came with the update", on the Leader's panel. It shows the rule and why ovai recommends it, and has two buttons: the list ovai recommends (Allow, Deny or Ask every time), which writes the rule into that list, and Ignore, which ovai remembers and never asks about again. A popup nobody answers is raised again at the next start of the server. Nothing is added without a press.
- Ask the Leader in words, e.g. "stop asking me before running git status" or "always ask me before pip install". It puts a permission popup on its panel with the rule and its reason, and the buttons Allow, Deny and Ask every time. Your press writes the rule into the matching list. The Leader can also say which rules the instance holds.
- The Leader cannot change a rule that is already in one of the lists, and no session may edit `.claude/settings.json`. To take a rule back, remove its line from `.claude/settings.json` in an editor or in admin mode (`<instance>/bin/ovai claude`).
- A rule written from a permission popup applies at once. A file edited by hand is read by sessions when they start, so restart the running ones: ask the Leader, or run `ovai restart`.

The rule syntax is Claude Code's own: https://code.claude.com/docs/en/permissions
