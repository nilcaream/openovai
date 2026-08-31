# office-workspace

A toolkit for running a small team of AI developer sessions on one machine, built on top of
[Claude Code](https://code.claude.com). One session is the lead; the others are named workers
with one task each. Every session's identity is a directory on disk, not a process — so a
session can be replaced at any time without losing the work.

> **Status: early development.** This is a prototype. The design is being worked out in the
> open, so the layout, the names and the interfaces will move.

## The idea

- **A desk is a person.** Each worker owns a directory holding one Markdown state file. That
  file, not the session's memory, is what a replacement session reads to continue.
- **Handover replaces summarisation.** When a session's context fills up, it writes its desk
  and exits; a fresh session starts on the same desk. Nothing is compacted away.
- **One lead, many workers.** The lead delegates, takes the workers' questions and decides what
  reaches the human. Workers do the work and leave when it ships.
- **Built from ordinary Claude Code features**: agent personas, hooks, skills, project
  settings, plus a few shell and Node launchers and a small web page for the lead.

## Requirements

- Claude Code
- Bash 5
- Node.js (for the launchers and the web page)
- Linux desktop

Exact versions will be pinned as the first components are written.

## Install

An instance is a directory of its own. From a clone:

```sh
./install.sh --root ~/my-workspace --human Mike --leader Superman \
             --leader-model sonnet --worker-model haiku
```

- `--root` — where the instance lives. It has to be empty or new; `--force` accepts a
  directory that is not, and never deletes anything.
- `--human` — the person the team works for.
- `--leader` — the session that leads the team.
- `--leader-model`, `--worker-model` — optional. Leave one out and those sessions run on
  whatever model Claude Code is configured to use.

So far the installer creates the directories an instance is made of: `work/` for the desks,
`.claude/` for the settings, and `.claude-home/` for the instance's own Claude Code home, so
that two instances on one machine never share an account or a session history. The
configuration file, the desks and the launcher are being written next; an instance cannot be
started yet.

## What to build first

- **Personas** — the system prompts that make a session a lead or a worker.
- **Launchers** — start a lead or hire a worker, assign a name, create the desk.
- **Hooks** — to keep session names, the roster and the desks consistent.
- **Skills** — the repeatable procedures, handover first among them.
- **Chat page** — a browser front end to host the lead session.

## Documentation

Being written. It will live in `docs/`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## License

[MIT](LICENSE).
