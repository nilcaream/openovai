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
~/.local/bin/openovai
# or say it all on one line, and nothing is asked; the directory has to be empty or new
~/.local/bin/openovai --root ~/my-workspace --user Ana --leader Max \
                      --leader-model opus --worker-model sonnet --port 7799 --auth login
# sign the instance in (--auth login): opens a browser once, the credential stays inside the instance
~/my-workspace/bin/ovai login
# start the server in the background: it prints a one-time link, http://127.0.0.1:7799/?token=…, and returns
~/my-workspace/bin/ovai start
```

`openovai` says which release it resolved before doing anything — the newest on GitHub, or the
one you name: `openovai <version> --root …` — downloads it once, checks that it is signed by the key
the command pins, fetches the Node.js and Claude Code it pins, and hands over to that release's
installer. A release from before releases were signed is not installed. The release key's
fingerprint is `SHA256:aPDZIYeTixbEFoDRX5ytVJ+TvZub0hlFDreET4iB8Lk` (Ed25519).

With Node.js 24 or newer, npm is another way in. The package is the release, so it takes the same
flags, installs the newest release, or the one you name as `@openovai/ovai@<version>`, downloads
nothing, and leaves Node.js and Claude Code to the first `ovai start`, as above. `@latest` is
written out because npx reuses a copy it has cached for a name given with no version. `ovai update`
takes releases from GitHub, signed, whichever way the instance was made:

```sh
npx @openovai/ovai@latest --root ~/my-workspace --user Ana --leader Max \
                          --leader-model opus --worker-model sonnet --port 7799 --auth login
```

From a clone, the installer is called directly:

```sh
git clone https://github.com/nilcaream/openovai.git
cd openovai
./install.sh --root ~/my-workspace --source . --user Ana --leader Max \
             --leader-model opus --worker-model sonnet --port 7799 --auth login
```

Open the link `ovai start` prints, within ten minutes. It works once: it signs that browser in and
takes it to the plain address, and the browser stays signed in across restarts and updates. For
another browser, run `ovai url`, which prints a new one-time link. The Leader's panel is in the
middle; type what you want and the Leader starts. `ovai status` says whether the server is running
and where, `ovai stop` stops it. To sign every browser out, delete `page-session` in the instance
directory. Everything the page and the command do is described at [openov.ai](https://openov.ai).

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
  is in the middle and the Workers' either side from a window 1800px wide; below that the Workers
  share one column beside it, the Leader's head says its usage short below 1240px, and below 1091px
  the page is one column, the Leader first. The User can type on any of them.
- **Only the server writes to a session.** A session's stdin is written by the server and by
  nobody else, and every turn carries a frame the server sets itself — `<user>`, `<message
  from="…">`, `<server-event type="…">` — so a session always knows who is speaking. Who is
  calling a tool is a per-process secret the server minted, never a name a session could claim.
- **The lifecycle is tools, not phrases.** A session that is idle, out of quota or being parked
  is told so in a server event and answers with one tool call. No button on the page
  starts or ends a seat; STOP interrupts a turn, and that is all.
- **Built from ordinary Claude Code features**: two persona templates, project settings, two
  hooks (one lets a compound of allowed commands through or refuses it toward a script, one hands a subagent
  `customization/common.md`), an MCP server, plus a shell shim, a few Node tools and a small web
  page to host it all on.

## Requirements

- Linux or macOS, x86_64 or arm64
- `sh`, `curl` or `wget`, `tar`, `sha256sum` or `shasum`, `uname`, `ssh-keygen` (OpenSSH 8.1 or
  later), which checks a release's signature

On Windows, use WSL 2: ovai runs there as it does on Linux. Keep the instance in the Linux file
system, such as under `~`, and not under `/mnt/c`. The Windows drives mounted there do not keep
file modes, do not tell names apart by case, and are slow.

Nothing else: no Node.js, no npm, no Claude Code on the machine. Each release pins the Node.js and
Claude Code it runs on and fetches them itself, under `~/.local/share/openovai`, shared by every
instance of the user's — about half a gigabyte, once, no sudo. Claude Code's own updater is off; a
newer one reaches an instance with the next release.

## The instance

An instance is a directory of its own. It holds this, and nothing else ever lands in it:

```
<instance>/
  bin/ovai          the one command
  lib/              everything else the release ships, its version in lib/VERSION; replaced
                    whole on update
  openovai.json     the instance's description of itself
  instructions.json the settings document every session is started with: the instruction
                    files above the instance it is not to read; written at every start
  runtime.json      the running server: url, pid, since
  runtime.log       what the server said, one row per line, every run appended
  usage.json        the last reading of the account's usage windows, kept across restarts
  claude-variables  the Claude Code variables of the shell the server was started from, and what
                    its sessions get of each, masked; written at every start
  page-session      the key a signed-in browser's cookie carries, made at the first start and
                    kept; delete it to sign every browser out
  page-link         the one-time link `ovai start` or `ovai url` printed last, until it is
                    opened or its ten minutes are up
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

The instance directory and `.local/` are open to their owner alone (0700), whatever the umask, and
`runtime.json`, `runtime.log`, `claude-variables`, `page-session` and `page-link` are 0600.

## What ovai relies on that Claude Code doesn't document

ovai runs on a pinned Claude Code release (2.1.296 in this version). A few things it needs are not in Claude Code's documentation. They work on the pinned release and are checked again whenever the pin moves. If Claude Code changes one of them, the matching ovai feature can stop working until a new ovai release adapts. ovai uses a documented way wherever one gives the same result.

- **Usage percentages and the per-model weekly limit.** The usage bar and the quota guard need the 5-hour, 7-day and model-specific weekly percentages. Claude Code documents only whether a turn was allowed and when a limit resets, so ovai reads the percentages from two undocumented places: a field in the stream Claude Code prints during a turn, and an Anthropic account usage endpoint, called with the instance's own Claude Code login about every five minutes while a page is open. If they change, the usage bar keeps its last reading, dimmed once it is a quarter of an hour old; sessions keep working.
- **Answering permission prompts ("cards").** Seats run in print mode, and ovai answers their permission prompts over Claude Code's standard input and output, the way the Agent SDK does. This path hands over Claude Code's own "don't ask again" rule suggestions, which the permission popup offers. The documented alternative for print mode, an MCP prompt tool, does not receive them. The message format is mostly documented; the name of the permission request and the option that selects this path are not.
- **Whether Claude Code has been set up.** The admin door reads one flag in Claude Code's state file to decide whether to show its first-time line. At worst, that line shows every time.
- **Which thinking blocks are progress notes.** A panel shows the notes a model writes to the reader between its calls. The API documents that it returns them as thinking blocks; ovai tells them apart from reasoning summaries, which are thinking blocks too, by a field of Claude Code's stream, `narration_block_indexes`, which is not documented. If it changes, those notes stop showing; the words of a turn's answer are not affected.
- **The admin overview of plugins and connectors.** The admin overview reads Claude Code's plugin records and its list of connected claude.ai connectors from their files. Claude Code documents where these files live, not what is in them. If they change, that part of the overview comes up empty.

Chaining allowed commands (`cd x && npm test`) without a prompt is done by an ordinary, documented PreToolUse hook. It is listed here only because it repeats Claude Code's own command matching, and it is checked against each new pin.

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
