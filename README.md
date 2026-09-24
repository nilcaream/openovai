# OpenOv AI

A toolkit for running a small team of AI developer sessions on one machine, built on top of
[Claude Code](https://code.claude.com). One session is the Leader; the others are named Workers
with one task each. Every session's identity is a directory on disk, not a process — so a
session can be replaced at any time without losing the work.

> **Status.** Early development. In daily use by the team that builds it, and changing fast:
> releases are frequent, features move, and what a release does is in [NOTES.md](NOTES.md). Bugs
> are expected; an issue with what you tried, what happened and what you expected is the most
> useful thing you can send. The repository is open — no gate, no sign-up — and contributions are
> welcome.

## Quick start

Get the `openovai` command once per user, then create an instance: a directory of its own, signed
in to its own account, served on one port.

```sh
# the openovai command: installs itself under ~/.local/share/openovai, linked at ~/.local/bin/openovai
curl -fsSL https://raw.githubusercontent.com/nilcaream/openovai/main/openovai | sh
# create an instance: asks where it lives, who it works for, the models, the port, how it signs in
openovai
# or say it all on one line, and nothing is asked; the directory has to be empty or new
openovai --root ~/my-workspace --user Ana --leader Max \
         --leader-model opus --worker-model opus --port 7799 --auth login
# sign the instance in (--auth login): opens a browser once, the credential stays inside the instance
~/my-workspace/bin/ovai login
# start the server in the background: it prints http://127.0.0.1:7799 and returns
~/my-workspace/bin/ovai start
```

`openovai` says which release it resolved before doing anything — the newest on GitHub, or the
one you name: `openovai 0.16.0 --root …` — downloads it once, fetches the Node.js and Claude Code
it pins, and hands over to that release's installer. From a clone, the installer is called
directly:

```sh
git clone https://github.com/nilcaream/openovai.git
cd openovai
./install.sh --root ~/my-workspace --source . --user Ana --leader Max \
             --leader-model opus --worker-model opus --port 7799 --auth login
```

Open the address `ovai start` prints. The Leader's panel is in the middle; type what you want and
the Leader starts. `ovai status` says whether the server is running and where, `ovai stop` stops
it. Everything the page and the command do is described at [openov.ai](https://openov.ai).

## The idea

- **A desk is a person.** Each seat owns a directory holding one Markdown state file. That file,
  not the session's memory, is what a replacement session reads to continue.
- **The desk is what survives.** A conversation does not run forever, and nothing is summarised
  away when it ends: a session writes its desk with a tool as it goes, and the next session at
  that desk reads it first.
- **One Leader, many Workers.** The Leader hires, delegates, relays, settles what the instance may
  do; it does no project work. Workers do the work and stop when it ships. The User steers the
  team through the Leader, in plain words.
- **Every session is hosted on the page.** Nobody has a terminal of their own. The Leader's panel
  is in the middle, the Workers' either side, and the User can type on any of them.
- **Only the server writes to a session.** A session's stdin is written by the server and by
  nobody else, and every turn carries a frame the server sets itself — `<user>`, `<message
  from="…">`, `<server-event type="…">` — so a session always knows who is speaking. Who is
  calling a tool is a per-process secret the server minted, never a name a session could claim.
- **The lifecycle is tools, not phrases.** A session that is idle, out of quota or being parked
  is told so in a server event and answers with one tool call. No button on the page
  starts or ends a seat; STOP interrupts a turn, and that is all.
- **Built from ordinary Claude Code features**: two persona templates, project settings, an MCP
  server, plus a shell shim, a few Node tools and a small web page to host it all on.

## Requirements

- Linux, x86_64 or arm64
- `sh`, `curl` or `wget`, `tar`, `sha256sum`, `uname`

Nothing else: no Node.js, no npm, no Claude Code on the machine. Each release pins the Node.js and
Claude Code it runs on and fetches them itself, under `~/.local/share/openovai`, shared by every
instance of the user's — about half a gigabyte, once, no sudo. Claude Code's own updater is off; a
newer one reaches an instance with the next release.

## The instance

An instance is a directory of its own. Its root is this, and nothing else ever lands in it:

```
<root>/
  bin/ovai          the one command
  lib/              everything else the release ships, its version in lib/VERSION; replaced
                    whole on update
  openovai.json     the instance's description of itself
  instructions.json the settings document every session is started with: the instruction
                    files above the instance it is not to read; written at every start
  runtime.json      the running server: url, pid, since
  runtime.log       what the server said, one row per line, every run appended
  admin.json        what `ovai claude` left when the door closed: when the session ended, which
                    configuration files changed, and what moved in them, by name; a running
                    server hands it to the Leader within seconds, a stopped one at its next
                    start, and removes it
  plugins/          tools the instance serves itself, one file each; yours, kept across updates
  knowledge/        what the workspace knows, one Markdown note per topic, and files/ for the
                    files a note keeps of its own; written and read by every session with the
                    file tools
  customization/    what you add to the personas: common.md, leader.md, worker.md; yours, never
                    touched
  desks/<Name>/     one directory per person: STATE.md, persona.md, conversation.json, and
                    whatever that person keeps there; the listing IS the roster
  archive/          retired desks, moved whole: <day>-<Name>-<slug of the final title>/
  reference/        kept to look at: documents, sources, clones for analysis; never worked on
  projects/         worked on; a reference that needs edits is cloned fresh here, never moved
  temp/             scratch, deletable by anyone at any time
  .claude/          Claude Code's project settings for the instance; the name is Claude Code's
  .local/           Claude Code's config dir for the instance: account, transcripts, memory
```

## Documentation

The documentation is at [openov.ai](https://openov.ai): how it works, installing and updating,
the Leader and the Workers, permissions, knowledge, plugins, customization, a FAQ and the
reference. [NOTES.md](NOTES.md) says what each release changed and what taking it asks of the
workspace that takes it. [CONTRIBUTING.md](CONTRIBUTING.md) is about working on the toolkit
rather than with it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## License

[MIT](LICENSE).
