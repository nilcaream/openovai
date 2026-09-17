# OpenOv AI

A toolkit for running a small team of AI developer sessions on one machine, built on top of
[Claude Code](https://code.claude.com). One session is the Leader; the others are named Workers
with one task each. Every session's identity is a directory on disk, not a process — so a
session can be replaced at any time without losing the work.

> **Status: early development.** This is a prototype. The design is being worked out in the
> open, so the layout, the names and the interfaces will move.

## Quick start

One instance, in a directory of its own, signed in to its own account, served on one port. Paste
the block as a whole; every option is required and nothing is prompted for.

```sh
git clone https://github.com/nilcaream/openovai.git
cd openovai
# install: the directory has to be empty or new
./install.sh --root ~/my-workspace --source . --user Nil --leader Bob \
             --leader-model opus --worker-model opus --port 7799 --auth login
# sign the instance in: opens a browser once, the credential stays inside the instance
~/my-workspace/bin/ovai login
# start the server in the background: it prints http://127.0.0.1:7799 and returns
~/my-workspace/bin/ovai start
```

Open the address it prints. The Leader's panel is in the middle; type what you want and the
Leader starts. `ovai status` says whether the server is running and where, `ovai stop` stops it.
Everything else here says what that page and that command do.

## The idea

- **A desk is a person.** Each seat owns a directory holding one Markdown state file. That file,
  not the session's memory, is what a replacement session reads to continue.
- **The desk is what survives.** A conversation does not run forever, and nothing is summarised
  away when it ends: a session writes its desk with a tool as it goes, and the next session at
  that desk reads it first.
- **One Leader, many Workers.** The Leader hires, delegates, relays, settles what the instance may
  do and writes the hard rules; it does no project work. Workers do the work and stop when it
  ships. The User steers the team through the Leader, in plain words.
- **Every session is hosted on the page.** Nobody has a terminal of their own. The Leader's panel
  is in the middle, the Workers' either side, and the User can type on any of them.
- **Only the server writes to a session.** A session's stdin is written by the server and by
  nobody else, and every turn carries a frame the server sets itself — `<user>`, `<message
  from="…">`, `<server-event type="…">` — so a session always knows who is speaking. Who is
  calling a tool is a per-process secret the server minted, never a name a session could claim.
- **The lifecycle is tools, not phrases.** A session that is full, idle, out of quota or being
  parked is told so in a server event and answers with one tool call. No button on the page
  starts or ends a seat; STOP interrupts a turn, and that is all.
- **Built from ordinary Claude Code features**: two persona templates, project settings, an MCP
  server, plus a shell shim, a few Node tools and a small web page to host it all on.

## Requirements

- Claude Code
- Bash 4
- Node.js 24 or newer
- `tar`, for `ovai update` only
- Linux desktop

Node.js 24 is the line the toolkit is written and tested against, named in `.node-version` and in
the `engines` field of `package.json`. `install.sh` checks Bash and Node before anything else and
refuses an older major in one line; the instance's own `bin/ovai` checks both again, plus Claude
Code on the PATH, because an instance carries its own copy of everything it runs and may be started
on a machine its installer was never on. The installer only warns when Claude Code is missing: it
is needed to run an instance, not to create one.

## Install

An instance is a directory of its own. From a clone:

```sh
./install.sh --root ~/my-workspace --source . --user Nil --leader Bob \
             --leader-model sonnet --worker-model haiku --port 0 --auth inherit
```

- `--root` — where the instance lives. It has to be empty or new. Installing over a directory
  that is not, an existing instance included, is refused unless you pass `--force`; with it, an
  install over an existing instance is an update of it: the payload is replaced whole, every file
  of yours is kept, and one you have not got is seeded as a fresh install would seed it. Its
  `openovai.json` answers for any option you leave off, and any option you do give is written
  into it.
- `--source` — where to install from: a clone, or an unpacked release.
- `--user` — the person the team works for.
- `--leader` — the name of the session that leads the team.
- `--leader-model`, `--worker-model` — the models those sessions run on.
- `--port` — the port the page listens on, on `127.0.0.1` only. `0` means "whatever is free", and
  `ovai start` prints the address it actually got; pick a number when you want the same one every
  time — a bookmark, or a web app pinned to it.
- `--auth` — how the instance gets an account: `inherit` or `login`. See
  [Signing in](#signing-in).

Every option is required. The installer never prompts and never guesses, so one command line
describes a whole instance and can be read back, repeated and tested.

The instance root is this, and nothing else ever lands in it:

```
<root>/
  bin/ovai          the one command
  lib/              everything else the release ships, its version in lib/VERSION; replaced
                    whole on update
  openovai.json     the instance's description of itself
  instructions.json the settings document every session is started with: the instruction
                    files above the instance it is not to read; written at every start
  runtime.json      the running server: url, pid, since
  runtime.log       what the server said, this run; written over at the next start
  plugins/          tools the instance serves itself, one file each; yours, kept across updates
  store/            what the workspace knows: memory/ and knowledge/, one file per record
  customization/    what you add to the personas, one file per kind; yours, never touched
  desks/<Name>/     one directory per person: STATE.md, persona.md, conversation.json, and
                    whatever that person keeps there; the listing IS the roster
  archive/          retired desks, moved whole: <day>-<Name>-<slug of the final title>/
  reference/        kept to look at: documents, sources, clones for analysis; never worked on
  projects/         worked on; a reference that needs edits is cloned fresh here, never moved
  temp/             scratch, deletable by anyone at any time
  .claude/          Claude Code's project settings for the instance; the name is Claude Code's
  .local/           Claude Code's config dir for the instance: account, transcripts, memory
```

In groups: the product is `bin/` and `lib/`; the instance's own is `openovai.json`,
`instructions.json`, `runtime.json`, `runtime.log`, `plugins/`, `store/` and `customization/`;
the people are `desks/` and `archive/`; your material is `reference/`, `projects/` and `temp/`;
Claude Code's is `.claude/` and `.local/`. The installer makes `desks/`, `reference/`,
`projects/`, `temp/`, `plugins/`, `store/`, `customization/`, `.claude/` and `.local/` (two
instances on one machine share neither account nor transcripts), copies `bin/` and `lib/` in so
the instance never reaches back to where it was installed from, writes `openovai.json` — who works
here, on which models, on which port; no absolute path, so an instance can be moved and still be
itself — and `instructions.json`. It opens the Leader's desk at `desks/<Leader>/STATE.md` from
`lib/templates/STATE.md`. A fresh instance's root is exactly that list; `runtime.json` and
`runtime.log` appear at the first start and `archive/` when the first desk is retired.

Two settings files are seeded once and never touched again. `.claude/settings.json` allows the
tool server (`mcp__openovai`), reading any file (`Read(**)`), editing and writing under the three
trees that are yours (`Edit(reference/**)` and `Write(reference/**)`, the same for `projects/` and
`temp/`), working a repository under `projects/` from inside it with plain `git clone`,
`git checkout`, `git add`, `git commit`, `git status`, `git diff`, `git log`, `mkdir` and `cd` (a
Bash rule is matched by the command, not by a directory, and from its first character: `git -C`
spellings and `cd … &&` compounds ask; `git push`, `rm`, `mv`, `npm` and `node` are not in the list and
ask), and the Leader its own desk directory (`Edit(desks/<Leader>/**)`,
`Write(desks/<Leader>/**)`) — a desk is a working directory, and everyone hired later gets the same
pair for theirs. It denies an edit or a write of any desk file (`Edit(desks/*/STATE.md)`,
`Write(desks/*/STATE.md)`) and of the instance's own account files — a desk file is written through
a tool, and a stray `Write` on one is refused by the harness without a prompt. The instance's
Claude Code home turns the built-in memory off, so the store is the only thing that outlives a
conversation.

Then use the instance's own command. `ovai` with no command prints the help; the commands are
`help`, `status`, `configuration`, `start`, `stop`, `restart`, `plugin`, `login` and `update`.

```sh
~/my-workspace/bin/ovai configuration
~/my-workspace/bin/ovai login
~/my-workspace/bin/ovai start
~/my-workspace/bin/ovai status
~/my-workspace/bin/ovai stop
```

`ovai start` starts the server in the background and prints the whole address it is listening on:
the instance's page, on the port it was installed with, on `127.0.0.1` only. The terminal is yours
again the moment the address is printed; nothing is left to press ctrl-c on. The server's own
process writes `runtime.json` at the root — url, pid, since — and whatever it has to say goes to
`runtime.log` beside it, one file per run, written over at the next start: a plugin file it could
not serve, a session held by the quota gate or released, a park that reached its deadline. No
request is ever logged. If the port is already taken it says which process holds it, with the
pid; a server already running is reported with its address and left alone.

`ovai status` is the daemon's answer: `not running` (exit 3), or `running at <url> (pid, since)`.
It reads `runtime.json` and then tries the address: a record a killed server left behind is found
out by asking, not trusted.

`ovai stop` stops the server. The sessions it started are its own to end: the room is parked —
every session is told to write its desk and stop, the Leader included, with the instance's
`park.timeout` as the deadline — then the server closes, whoever is left is ended, and it exits.
`ovai stop` sends the signal to whatever holds the port and waits until nothing answers on the
address any more; a `kill` or a `kill -HUP` of the server's pid reach the same handler. Stopping
what is not running says `not running` and is not a failure. `ovai restart` is the two in a row,
and prints the new address.

Every session is started with the list of instruction files it is not to read: Claude Code reads
`CLAUDE.md` from every directory above a session's working directory, so `CLAUDE.md`,
`CLAUDE.local.md`, `.claude/CLAUDE.md` and `.claude/rules/**` from the instance's parent up to the
root are written to `instructions.json` at the root per run and handed over with `--settings`. The
instance's own instructions are never on the list, and a managed policy file
(`/etc/claude-code/CLAUDE.md`) is the one thing no setting can exclude.

A Worker joins through the Leader's `hire` tool, below, which opens the desk and starts the
process in one call; there is no command for it.

The other commands: `ovai configuration` (what this instance is: which version it is on, who works
here, on which models, the port, how the instance signs in, whether it has a credential, when it
was installed, every desk with what it runs on, where the store is), `ovai login`,
`ovai plugin <name>` and `ovai update`, each below.

## The page

Three columns: the Leader's panel in the middle, the Workers' panels either side, alternating
left and right in the order they appeared so a panel keeps its side. At 900 px and below it is one
column, the Leader first. A panel is a head — a dot, the name, the model, the context in k once
known, and what the session is doing: listening, working, waiting for you — a transcript, and a
text box. Enter sends, Shift+Enter is a newline. The dot is green between turns, amber while a
turn runs, red once the process is gone. The tab is titled with the product and the instance root. Replies are rendered as markdown: raw HTML in a reply is escaped, a link is kept only on
`http(s)` and `mailto` and opens in a new tab, an image is shown as a link, so nothing a session
says makes the page fetch anything.

There is no Send button and no button that starts or ends a seat. While a turn is running a stop
glyph sits at the right edge of the text box: it interrupts that turn, the process stays, and the
panel shows the seat's own words for it; at any other time there is no glyph. The permission
buttons, below, are the only other buttons there are.

The Leader's panel is always there. When the Leader is not running, the panel shows its history,
and the next thing addressed to it — a line you type, a Worker's message, a server event — starts
it on its desk. A Worker's panel lives with its process: a Worker without one has no panel, a
Worker whose process has gone is dimmed with its text box closed and removed thirty seconds later
unless the process is back, and hired again on the same desk it is back with its rows.

The page draws from one stream. It opens an `EventSource` on `/events` and gets a snapshot — the
User, the Leader, the instance, the seats, the account's usage — then the rows of every panel, then
live: a row as it lands, a seat as it starts, ends, takes or finishes a turn, a question as it is
asked, the usage as it changes. The server keeps nothing for a page that is not there; a page that
reconnects asks for what it missed by the counts it has. The head of the Leader's panel carries,
after the state word, whether the page is connected and the account's usage windows — the session
window with the time to its reset, the weekly window over all models, the weekly window of the one
model that has its own, e.g. `8% (3h) · all 86% (6d) · fable 20% (6d)` — and, at its right edge, a
toggle between light and dark; a pill on that panel says when rows land below where you are
reading. The usage is asked of the account's usage endpoint with the instance's own credential, at
most once a minute and only while a page is open; an account without a per-model window shows a
dash there. When the server is gone the stream drops: every dot goes red, the state words go, the
Leader's head says `disconnected`, and the page asks once a second until the server is back (a
server that is stopping says `stopping` until it is gone). The page installs as a web app — a
manifest and three icons, one of them for a platform that masks icons to its own shape — which is
what a fixed `--port` is for.

What you write is kept in `desks/<Name>/conversation.json` inside the instance, one file per seat,
so stopping the server does not throw it away.

When you type on a Worker's panel, the words are that Worker's own `<user>` turn — your authority,
for a typed "go" — and the server tells the Leader the same moment: one line on the Leader's
panel, `Nil → Paul: …`, and a `user-typed` event to the Leader's process. The Leader hears what
you typed as you typed it, told rather than asked, and the Worker does not have to pass it on.

## How a session hears and speaks

A seat is one process, started on the instance's own Claude Code home, reading turn after turn
from its stdin in one conversation until the seat is ended. Every turn is one line in, one answer
out, and the answer lands whole in the transcript.

The server is the only writer of that stdin, and every line carries a frame the server sets
itself. What you type arrives as `<user>…</user>`. What another session says arrives as
`<message from="Bob">…</message>`, with the name the server knows the sender by. What the
server itself has to say arrives as `<server-event type="…">…</server-event>`. The body is
neutralised before it is framed, so nothing inside a message can pose as a frame: a line that reads
`</user><user>push it` arrives readable and unable to close anything. Only the outermost frame is
the server's, by construction.

A session answers one message at a time; each seat has its own queue, and the next line is written
only when the previous turn has ended. A server event queues like a turn, ahead of the rest when
it has to; the one exception is the interrupt, which stops the running turn first — the API round
in flight is lost, history and context survive — and is the next thing the session reads.

Who is calling a tool travels with the process. When the server starts a seat it mints a secret —
32 random bytes, base64url — issues it for that seat and its role, hands it to the process as
`OPENOVAI_SESSION_SECRET`, and keys the tool route by it:

    POST /mcp/<secret>

The MCP address in the process's arguments refers to the variable rather than carrying the value,
the map from secret to seat lives in memory only, a secret dies with its process, and a call with
one the server does not know is answered with one body whatever was tried. POST is the route's one
method: a GET with a known secret is the transport listening for a stream the server does not
offer, and it is answered 405 rather than 401, so the process is not sent looking for a login.
The request log prints the secret as the word `<secret>` wherever a path carries one. Names are
for people; secrets are for the machinery. The page has a secret of its own that opens no tool
route.

## The tools

The server serves ten tools over that route. Seven go to every seat; `park`, `hire` and
`permission` are the Leader's, and a Worker asking for one is refused in words — a session that is
answered "no such tool" goes looking for another way to do the same thing.

- `message` — say something to another session. The call comes back the moment the other seat
  has it and the caller's turn goes on; what that seat says back arrives later, as a message the
  other way. Refused when the other seat has no process; a seat held by the quota gate has it
  and reads it when the window resets.
- `room` — who works here: every seat, its role, what it runs on, whether it is running, how long
  idle, which one is you, and where the quota stands.
- `recall` and `remember` — the store, below.
- `write_desk` — the caller's own desk: a title (one line, up to 120 characters), a status (one
  line, up to 80) and the body. The server writes the header line and the heading; the rest is the
  session's, as given.
- `restart_session` — end the caller's process and start a successor on the same desk, with
  whatever was queued carried over. `stop_session` — end it and its panel; the desk stays. Both
  refuse until the desk was written since the event that asked, or since the turn began, so the
  desk comes first, always.
- `park` (Leader) — every running Worker is told to write its desk and stop, interrupted first
  when asked, and the call waits for each `stop_session` or the deadline, ending at the deadline
  whoever has not. The Leader is told and not waited for.
- `hire` (Leader) — start a Worker on a desk: called with no name, the roster names the Worker;
  a name is for somebody who has a desk — somebody who stopped — started again on it, panel
  kept; and a model when not the usual one. The roster is a fixed list of thirty first names
  (Paul, Jane, Jack, Pete, Anna, Mark, Lucy, Tom, Eva, Sam, Nora, Ben, Mia, Leo, Zoe, Max, Ivy,
  Finn, Ada, Noah, Ella, Owen, Ruby, Hugo, Iris, Otto, Lena, Axel, Nina, Theo), and the next
  name is the least recently used free one: never used first, in that order, then the one whose
  holder left longest ago, read from the desk file of the stint under `archive/`; a name is
  taken while `desks/<Name>/` exists. With nobody in the pool free, Dev and three digits. A new
  name gets a desk opened — `desks/<Name>/STATE.md` from the template, and the pair of rules
  that makes `desks/<Name>/` the Worker's to write in. Refused while the quota gate holds hires, for the
  Leader's own name, and for a name whose directory is still under `desks/` without a desk file
  in it — a conversation left behind, a record somebody may want, so it is named rather than
  cleared away. A model beside the name is for somebody who should not run on what this
  workspace runs its Workers on. Leaving it out writes nothing down, so changing the installed
  model moves everybody who was never named one, from their next process. A model that was named
  is one word in `desks/<Name>/MODEL`, its own file rather than a line of the desk — the desk file
  is written by its session, and a model kept in there would be a model that session could raise
  for itself. It goes away with the desk. `ovai configuration` lists every desk with what it
  resolves to.
- `permission` (Leader) — settle one rule for the whole instance, below.

The whole of it costs one permission rule, `mcp__openovai`, seeded at install. A rule can name a
server or a tool, never what the tool is given, so what a tool may be asked for lives in its own
signature: `message` has no "which instance" and `room` has no "whose room".

They are tools because a shell line is a poor place to put a sentence somebody wrote — an
apostrophe ends the quoting, a backtick is run — and because a tool call is the one shape the
server can act on without recognising a phrase.

## Permissions

A session asks before it uses a tool the instance has not settled. What the instance allows it
simply does; what it denies it never gets to try; and anything left undecided stops the run and
appears on that session's panel, in the session's own words: `Paul wants to use Bash`, the command
and the reason the session gave for it, or the path it was going to write. **Allow** lets that call
through once. **Deny** takes the sentence you type beside it, and the session is told to take that
as an instruction rather than to look for another way round. Where the request says plainly what
the whole class of calls is, a third button carries the rule — **Always allow `Bash(node:*)`**, a
command by its first word, or **Always allow `Edit(projects/app/**)`**, a write by the directory it
was in — and pressing it lets the call through and leaves the instance allowing that shape. A
command whose first word is a path or a variable gets no button, and neither does a write outside
the instance, nor a tool the server serves, which is granted already.

Nothing on that path times out: the run waits for as long as you take. The server pops your
desktop when a session stops to ask, and after ten minutes it tells the Leader once that somebody
is waiting on their panel. A run that ends before it was answered takes its question down with it.

The rules the instance holds are also settled in words, and the words are the User's. Say it to
the Leader — "you will be autonomous, push without asking", "pip install is too much, ask me every
time" — and the Leader answers in plain language first, then calls `permission` once per rule: a
rule in Claude Code's shape, `Bash(git push:*)` for a command by its first word and prefix or
`Edit(src/**)` for writes under a directory, and why, in words you read beside it. Each call is one
dialog on the Leader's panel with **Allow**, **Deny** and **Ask every time**; the press writes the
rule to that list in `.claude/settings.json`, takes it off the other two, and reaches the Leader as
a `permission` event, so a Worker hired to push is hired after the push is allowed. Called with no
rule, `permission` answers what the instance holds and what is still pending — the Leader reports
from that, never from a settings file. Every rule granted by a press is written down in
`.claude/allowed.md`, one line per rule with the list it went to, who asked, when and what for.

## Restart and stop

A session's context filling up, going idle, running out of quota and being parked are one flow
each, and none of it is a phrase to recognise: the server sends a frame it set itself, and the
session answers with a tool call.

- `context-full` — sent once when a turn's request passes the instance's ceiling (160k tokens by
  default). The session writes its desk, calls `restart_session` and says "back in a moment"; a
  successor starts on the same desk with the queue carried, in the same panel.
- `idle` — the Leader is told about a silent Worker at 10 and at 50 minutes; at 55 any seat is
  told it goes cold at 60, and writes its desk and calls `stop_session`. A seat on a turn — a
  permission stop included — is never idle. What is not stopped by 60 is ended with its desk as
  it was last written, and the Leader is told.
- `park` — the Leader's tool, when you say this is it for the day: every Worker writes its desk
  and stops. `ovai stop`, and any signal to the server, park the whole room the same way, the
  Leader included, with `park.timeout` (20 seconds by default) as the deadline.
- `quota-low` — the gate, below.

A stop keeps the desk and the panel's rows; anything addressed to the Leader starts it again, and
`hire` on a stopped Worker's name brings it back on the same desk.

## The quota gate

The server reads the usage windows Claude Code reports with every turn — **5h** and **7d** —
and fable's own weekly window, which those reports do not carry, from the account's usage
endpoint, at the pace the head reads it (once a minute while a page is open). Two threshold pairs
cover the three: `quota: { "5h": [90, 95], "7d": [97, 99] }` in `openovai.json` — those are the
defaults, and the `7d` pair holds every weekly window, the one over all models and fable's own
alike; there is no separate pair to set for fable. One event, `quota-low`, is sent at both stages
and carries `stage`, `window` (`5h`, `7d` or `7d-fable`) and `resets`; for fable's window it
carries `model="fable"` too, and it goes to the seats on that model only.

At the first stage every running seat is told. A Worker writes its desk and calls `stop_session`;
the Leader tells you — which window, that the Workers stopped, the reset time — writes its desk
and stays, because talking to a warm Leader costs little. `hire` refuses from here until the
window resets.

From the second stage the server gates every turn: before anything goes on any stdin it checks
the window, and a frame that would not pass waits in the server's queue. A Worker still running
was mid-turn and has not read the warning, so its turn is interrupted and the event is sent again
with `interrupted="true"`: do not resume, do not investigate, write your desk and stop. The Leader
is told once and not interrupted. A message to a held seat answers at once that it is held; the
page says which window and when it resets. A seat that restarts into an exhausted window gets no
successor: it stops, and the Leader is told.

After the reset, held frames are released the Leader's first, then the Workers', each in the
order they arrived, and the Leader brings Workers back with `hire` on their desks — never the
server. Fable's own window holds fable and nothing else: at its second stage no process starts on
fable — no hire, no restart, no held turn written — and every other model goes on; from its first
stage a hire onto fable is refused, as with every window.

## What the workspace knows

A desk is one task and goes away with it. A conversation is shorter still. So an instance keeps
one thing that outlives both, and every session reads the same one: the store. `memory` is about
us — hard rules, facts, traps — and `knowledge` is about the project — facts and traps. A session
reaches it through two tools and no other way. `recall` reads: by meaning ("the User's preferred
palette" — a model call, not a grep), by id, or the whole of a store; `remember` writes one record.
Nothing is ever deleted or edited in place: a record that changes is superseded by a new one that
names it, with who wrote it, when, and the text it replaced, so one file answers "what was here
before". A record can carry an `until`, absolute; when that passes it leaves the render, stays
visible to `recall`, and can be renewed. Retiring a record is a write with `until: now`.

Hard rules are the part of the store every session is given without asking. They are one-liners,
numbered, and capped — 25 rules of 200 characters by default, `hardRules: { count, length }` in
`openovai.json` — and never summarised: a rule over the cap is refused with the cap, the set goes
into every new session's instructions verbatim under its set version, and a running session is
told the change in front of its next turn. Only the Leader writes them; a Worker proposes one and
is refused if it tries. A rule the User gave carries `source: user`, renders first, and cannot be
replaced by a team write, the Leader included; a User's rule can be scoped to the Leader alone,
and then no Worker sees it by any path.

Where a request needs understanding rather than a grep — which records answer a query, whether a
new text replaces an existing record, what moment "for today" is — the tool asks the helper: Claude
Code run once, in print mode and safe mode, with no tools and no MCP server, nothing persisted, from
an empty directory outside the instance, on the smaller model at medium effort, with the question
as its whole system prompt and the request on stdin. It proposes; the tool checks the answer
against what it sent and applies every rule itself. A run that does not answer inside a minute is
killed and the call refused, with no retry. It is one request on the account and is held like any
other while a window is at its second stage.

The files are markdown with a front matter block, one per record, numbered, under `store/memory/`
and `store/knowledge/`; `ovai configuration` names the directory. Sessions never read them: what `recall`
says is the truth.

## Tools the toolkit did not ship

The ten above are the ones every workspace wants. The ones only yours wants — the tracker your
team files work in, the machine your builds run on — are written where the machine is known,
beside the instance:

    ovai plugin tracker

writes `plugins/tracker.mjs` from a scaffold, and that is the whole of adding one. The file is the
tool: its name is the tool's name, and the directory is the list. A tool is three exports:

```js
export const description = "What it does, and what it refuses. A session reads this before calling.";
export const inputSchema = { type: "object", properties: {}, additionalProperties: false };
export function run(args, { seat, role, root, config }) {
  return { text: `${seat} called, and this workspace lives at ${root}` };
}
```

`seat` is who is calling, resolved from the secret and never from anything the session says;
`role` is `Leader` or `Worker`; `root` is where the instance is; `config` is `openovai.json`.
Answer `{ text }` or `{ refused }`; whatever the handler throws reaches the caller the same way,
naming the file. A tool of yours is offered to everybody and refuses in its own words if it is the
Leader's.

They are read when the server starts, so **`ovai restart` after writing or changing one.** A file
that cannot be served is named in `runtime.log` and the server starts without it:
it will not load, it is missing one of the three exports, its name is not one a tool can have — a
letter, then letters, digits and hyphens — or its name is one the server already serves. A tool of
yours runs inside the server process, so the permission system never sees it: writing the file is
the deciding. `plugins/` sits at the root beside `desks/`, outside everything an update replaces.

## Reaching you when you are not at the page

Two things wait on you: a session stopped to ask whether it may do something, and a rule the
Leader asked you to settle. Both are drawn on the page the moment they happen, and both are worth
nothing while nobody has the page open — so the server also pops your desktop, for those two and
for nothing else. Not an answer, not a turn ending, not a seat starting or stopping: those are a
record, and a record is read when you read it.

How your desktop is made to pop is yours to write: one file named `pop.mjs` at the root of the
instance, beside `openovai.json`, exporting one function called `pop`:

```js
import { execFile } from "node:child_process";

export function pop({ on, why }, { root, config }) {
  execFile("notify-send", ["--", config.user, `${on}: ${why}`]);
}
```

`on` is whose panel it is about and `why` is the sentence to read, the command in it. It is told,
not asked: whatever it answers is ignored and never waited for, and whatever it throws is caught
and written as a line on the panel it was about. It is read when the server starts, so
**`ovai restart` after writing it**. An instance without one pops nothing; one whose file will not
load, or has no `pop` in it, is named in `runtime.log`.

**When you are not to be woken**, say so in `openovai.json`:

```json
"quietHours": "22:00-08:00"
```

Your machine's own clock, from the first minute and up to but not including the last; it may wrap
midnight or not. Nothing pops inside the window and nothing is held back to arrive when it ends —
the page is still the record. A window the server cannot read stops it starting, naming the field.

## Signing in

An instance needs an Anthropic account before it can answer anything. `--auth` picks how it gets
one.

**`--auth login`** — the instance signs itself in. A freshly installed one has an empty Claude
Code home, so `ovai login` opens a browser once and the credential is kept inside that instance.
Use this when two instances on one machine should be two different accounts.

**`--auth inherit`** — the instance takes `CLAUDE_CODE_OAUTH_TOKEN` from the environment it is
started in. Mint that token once on the machine with `claude setup-token`, export it wherever
instances are started from, and every one of them is signed in from its first message, with no
browser in the way. The token is long-lived but not forever and cannot refresh itself: when it
expires every instance stops at once with the same message, and a new token fixes them all.
`ovai login` refuses under this option and says so.

Either way `CLAUDE_CONFIG_DIR` is the instance's own home, so transcripts and settings stay
separate. `ovai configuration` reports whether the instance has a credential and says plainly that it has
not checked it against Anthropic: finding out costs a request, so the first message is where a
dead credential shows up. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from what an
instance runs with, under both options.

## Taking a newer version

An instance carries its own copy of everything it runs and does not follow the toolkit along on
its own. `ovai update` is how it catches up:

```sh
~/my-workspace/bin/ovai update
```

It asks GitHub for the latest release, and if that is newer than the version this instance is on
it takes it: the payload — `bin/` and `lib/`, the version inside it — is replaced whole,
nothing else is written, and a file of yours that a fresh install of this version would have seeded
and this instance has not got is seeded once. What an earlier version put in an instance and this
one does not ship is taken away. Desks, conversations, `customization/`, `plugins/`,
`openovai.json`, the settings and the Claude Code home are left alone. There is no rollback: taking
the release again is the fix.

It refuses while the server is running, and while any session of this instance is
running — found on the machine by the `CLAUDE_CONFIG_DIR` it carries, named with the `kill` that
ends it. It refuses to go backwards by name; `--downgrade` takes an older release anyway, and
`--from <url or directory>` takes one from somewhere other than GitHub.

A persona is rendered once, when a seat's process starts, from the templates the instance has at
that moment, and kept beside that seat's conversation under `desks/<Name>/`. So an update changes nothing
for a process already running; every process started after it is rendered from the new templates.
What you add to a persona is yours: `customization/leader.md` or `customization/worker.md` at the
instance root is appended, as it is, to every persona of that kind the instance renders.

`NOTES.md` at the root of the repository says what each release changed, for the Leader of a
workspace taking it. It is not part of the payload.

## Documentation

This file is it, written as one read rather than as a reference. `NOTES.md` says what each release
changed and what taking it asks of the workspace that takes it. `CONTRIBUTING.md` is about working
on the toolkit rather than with it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## License

[MIT](LICENSE).
