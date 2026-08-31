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
./install.sh --root ~/my-workspace --source . --human Mike --leader Superman \
             --leader-model sonnet --worker-model haiku --port 7801
```

- `--root` — where the instance lives. It has to be empty or new; `--force` accepts a
  directory that is not, and never deletes anything.
- `--source` — where to install from: a clone, or an unpacked release once there is one.
- `--human` — the person the team works for.
- `--leader` — the session that leads the team.
- `--leader-model`, `--worker-model` — the models those sessions run on.
- `--port` — the port the instance's chat page will listen on, on `127.0.0.1`. Two instances
  on one machine need two different ones.

Every option is required. The installer never prompts and never guesses, so one command line
describes a whole instance and can be read back, repeated and tested.

So far the installer creates the directories an instance is made of: `work/` for the desks,
`.claude/` for the settings, and `.claude-home/` for the instance's own Claude Code home, so
that two instances on one machine never share an account or a session history. It also writes
`ow.json`, the instance's description of itself — who works there, on which models, and on
which port. That
file holds no absolute path, not even the instance's own, so a workspace can be moved or
copied and still be itself.

It then copies `bin/`, `tools/` and `templates/` in, so the instance carries its own copy of everything
runs and never reaches back to where it was installed from. Two instances share nothing, and
one of them can install the next.

Finally it opens the leader's desk at `work/<Leader>/STATE.md`, from the template in
`templates/`. Editing that template changes what every new desk starts out looking like.

Then use the instance's own command:

```sh
~/my-workspace/bin/ow status
~/my-workspace/bin/ow chat
```

`ow chat` serves the instance's chat page on the port it was installed with, on `127.0.0.1`
only, and runs until you stop it. The page is one heading, one transcript and one text box:
what it looks like is a later question. What you write is kept in `chat/conversation.json`
inside the instance, so stopping the server does not throw the conversation away.

`ow` works out which instance it belongs to from where it sits, so an instance can be moved
and it keeps working. It refuses to run if Node.js or Claude Code is not on the PATH: those
are needed to run an instance, not to create one, which is why the installer only warns.

Each message runs the leader once — one Claude Code run per message, on the instance's own
Claude Code home and the model `ow.json` names — and the answer lands in the transcript. A
reply arrives whole rather than a word at a time.

A freshly installed instance has an empty Claude Code home and is therefore not logged in;
the first message comes back saying so. Log that instance in once with:

```sh
CLAUDE_CONFIG_DIR=~/my-workspace/.claude-home claude
```

and use `/login` there.

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
