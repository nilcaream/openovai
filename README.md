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
- **Every session is hosted on the page.** Nobody has a terminal of their own. The lead and
  every worker get the same panel, with the same text box under it.
- **Built from ordinary Claude Code features**: agent personas, hooks, skills, project
  settings, plus a few shell and Node launchers and a small web page to host them on.

## Requirements

- Claude Code
- Bash 4
- Node.js 24 or newer (for the launchers and the web page)
- Linux desktop

Node.js 24 is the line the toolkit is written and tested against. It is the one in long-term
support today — it entered LTS on 2025-10-28 and is maintained until 2028-04-30 — which makes
it the version a machine is most likely to already have and the one that will still be getting
security fixes for years. Supporting every Node at once would mean writing to the oldest of
them; one pinned line means the code can simply use what modern Node offers.

The version is named where the tools that care will look for it: `.node-version` for the
version managers, and the `engines` field of `package.json`. CI runs on that one version and
no other, and `install.sh` checks it before anything else and refuses an older major in one
line — better than an instance that installs and then fails at its first message on syntax its
Node cannot read.

## Install

An instance is a directory of its own. From a clone:

```sh
./install.sh --root ~/my-workspace --source . --human Mike --leader Superman \
             --leader-model sonnet --worker-model haiku --port 0 --auth inherit
```

- `--root` — where the instance lives. It has to be empty or new; `--force` accepts a
  directory that is not, and never deletes anything.
- `--source` — where to install from: a clone, or an unpacked release once there is one.
- `--human` — the person the team works for.
- `--leader` — the session that leads the team.
- `--leader-model`, `--worker-model` — the models those sessions run on.
- `--port` — the port the instance's chat page will listen on, on `127.0.0.1`. Two instances
  on one machine need two different ones, so `0` is worth knowing about: it means "whatever is
  free", and `ow chat` prints the address it actually got. Pick a number when you want the same
  one every time — a bookmark, or something else pointed at it.
- `--auth` — how the instance gets an account: `inherit` or `login`. See
  [Signing in](#signing-in).

Every option is required. The installer never prompts and never guesses, so one command line
describes a whole instance and can be read back, repeated and tested.

So far the installer creates the directories an instance is made of: `work/` for the desks,
`personas/` for the file that tells each session who it is, `.claude/` for the settings, and
`.claude-home/` for the instance's own Claude Code home, so that two instances on one machine
never share an account or a session history. None of them is copied from the source: what the
toolkit ships and what an instance accumulates stay in different directories. It also writes
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
~/my-workspace/bin/ow login
~/my-workspace/bin/ow hire Paul
~/my-workspace/bin/ow chat
~/my-workspace/bin/ow say Paul what are you working on
```

`ow hire <name>` opens a desk for a worker: the desk itself at `work/<Name>/STATE.md`, a persona
at `personas/<Name>.md` with the names written into it, and the one permission rule that lets
that session keep its own desk. It starts nothing, and a chat that is already running does not
need restarting: the panels are built from the desks the server finds, so a desk opened now is a
panel the next time the page is loaded. Everybody with a desk is somebody the chat can host.

`ow chat` serves the instance's chat page on the port it was installed with — or, with
`--port 0`, on one the machine picks — on `127.0.0.1` only, and runs until you stop it. It
always prints the whole address it is listening on, so there is one line to open or copy
whichever way the port was chosen. If the port is already taken it says which process is
holding it, with the pid and the command, so the usual culprit — a chat somebody forgot to
stop — takes one `kill` rather than a search.

The page is one panel per session — the lead first, then everybody who has been hired — and each
panel is a heading, a transcript and a text box of its own: what it looks like is a later
question. There is nothing special about the lead's panel; it is the same panel with a different
name on it. What you write is kept in `chat/<Session>/conversation.json` inside the instance —
one file per session, under the name of the session having that conversation — so stopping the
server does not throw it away.

`ow say <name> <message>` says something to another session in the instance and prints what it
answers. It goes through the chat rather than starting a session of its own, so the exchange
lands in that session's transcript and shows up on its panel like anything else. The chat writes
the address it is listening on to `chat/listening.json` when it starts — with `--port 0` nothing
knows the address until then — and this reads it there. It waits for the answer, which means the
session that asked is held for the whole of the other one's turn. Without a chat running there is
nobody to say it to, and it says so rather than starting anybody.

Every session in the instance is allowed to run it, and the lead's persona says so, which is what
makes the team a team: the lead can ask a worker something mid-turn and quote the answer back to
you. The rule is `Bash(bin/ow say:*)` and it is relative, like the rule that lets a session write
its own desk — a session is started with the instance root as its working directory, and an
instance that named a place on this machine would stop working the moment it was moved.

`ow` works out which instance it belongs to from where it sits, so an instance can be moved
and it keeps working. It refuses to run if Node.js or Claude Code is not on the PATH, and it
applies the same Node version floor the installer does — an instance carries its own copy of
everything it runs and may well be started on a different machine from the one it was
installed on, so it checks for itself rather than trusting that somebody checked once. Claude
Code is needed to run an instance and not to create one, which is why the installer only
warns about that one.

Each message runs one session once — one Claude Code run per message, on the instance's own
Claude Code home — and the answer lands in that session's transcript. A reply arrives whole
rather than a word at a time. Which model a session runs on comes from its name: the lead runs
on `--leader-model`, everybody else on `--worker-model`, so there is nothing recorded that can
disagree with `ow.json`.

Each panel is its own conversation: a thread's id is kept in `chat/<Session>/session.json` and
every message after the first continues it, so the server can be stopped and started again in
the middle of one. If a thread ever goes missing that session starts a new one rather than
staying broken.

## Signing in

An instance needs an Anthropic account before it can answer anything. `--auth` picks how it
gets one, and the two answers exist for two different situations.

**`--auth login`** — the instance signs itself in. A freshly installed one has an empty Claude
Code home and is therefore signed in to nothing, so `ow login` opens a browser once and the
credential is kept inside that instance. Use this when two instances on one machine should be
two different accounts.

**`--auth inherit`** — the instance takes `CLAUDE_CODE_OAUTH_TOKEN` from the environment it is
started in. Mint that token once on the machine:

```sh
claude setup-token
```

Export it wherever instances are started from, and every one of them is signed in from its
first message, with no browser in the way. This is the option to use for anything automatic:
there is nothing interactive left in creating an instance and starting it.

The token is long-lived but not forever, and it cannot refresh itself. When it expires every
instance stops at once, with the same message; mint a new one and they all work again. That is
deliberate. The alternative — giving each instance a copy of a signed-in credential — looks
tidier and behaves much worse: those credentials refresh themselves independently, and copies
of one credential go stale at different times, so the instances quietly diverge hours after
they were installed.

Either way `CLAUDE_CONFIG_DIR` is the instance's own directory, so transcripts, memory and
settings stay separate. Only the account is shared, and only when you ask for it.

`ow status` reports whether the instance has a credential, and says plainly that it has not
checked it. Nothing cheap can: asking Claude Code answers from disk and from the environment,
so a token that expired last week still reads as present. Finding out for certain costs a
request, which is more than a status command should spend, so the first message is where a
dead credential shows up.

`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are always removed from what an instance runs
with, under both options. They bill differently from a subscription, and picking that up by
accident from a shell that happened to have one exported is not a surprise worth allowing.

## What to build first

- **Personas** — the system prompts that make a session a lead or a worker.
- **Launchers** — start a lead or hire a worker, assign a name, create the desk.
- **Hooks** — to keep session names, the roster and the desks consistent.
- **Skills** — the repeatable procedures, handover first among them.
- **Chat page** — it hosts every session now, one panel each. Still to come: the lead and a
  worker talking to each other through it, and approving what a session asks to do.

## Documentation

Being written. It will live in `docs/`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## License

[MIT](LICENSE).
