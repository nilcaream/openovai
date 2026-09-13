# OpenOv AI

A toolkit for running a small team of AI developer sessions on one machine, built on top of
[Claude Code](https://code.claude.com). One session is the Leader; the others are named workers
with one task each. Every session's identity is a directory on disk, not a process — so a
session can be replaced at any time without losing the work.

> **Status: early development.** This is a prototype. The design is being worked out in the
> open, so the layout, the names and the interfaces will move.

## The idea

- **A desk is a person.** Each worker owns a directory holding one Markdown state file. That
  file, not the session's memory, is what a replacement session reads to continue.
- **The desk is what survives.** A conversation does not run forever, and nothing is
  summarised away when it ends: a session keeps its desk current as it goes, and the next session
  at that desk reads it first.
- **One Leader, many Workers.** The Leader delegates, takes the workers' questions and decides what
  reaches the User. Workers do the work and leave when it ships.
- **Every session is hosted on the page.** Nobody has a terminal of their own. The Leader and
  every Worker get the same panel, with the same text box under it.
- **Only the chat writes to a session.** A session's stdin is written by the chat and by nobody
  else, and every turn carries a frame the chat sets itself — `<user>`, `<message from="…">`,
  `<server-event>` — so a session always knows who is speaking. Who is calling a tool is a
  per-process secret the chat minted, never a name a session could claim.
- **One place says who is doing what.** A room above the panels gives each seat a line: its
  role, what it runs on and whether it is running. The Leader, who is on the page rather than
  looking at it, asks for the same thing with a tool.
- **Built from ordinary Claude Code features**: agent personas, hooks, skills, project
  settings, plus a few shell and Node launchers and a small web page to host them on.

## Requirements

- Claude Code
- Bash 4
- Node.js 24 or newer (for the launchers and the web page)
- `tar`, to take a newer version
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

`tar` is needed by one subcommand and nothing else: a release arrives as an archive and Node has
no reader for one. `ovai update` says so itself when it is missing, and `bin/ovai` does not check for
it at the door — one subcommand needing something is not a reason to refuse every other.

Both floors are checked twice, once by `install.sh` and once by the instance's own `bin/ovai`.
An instance carries its own copy of everything it runs and can be moved to a machine its
installer was never on, so it has to say what it needs for itself. Bash 4 is a deliberate line
rather than a measured one: neither script uses anything newer than bash 3 today, and 4 has been
on every Linux desktop since 2009.

## Install

An instance is a directory of its own. From a clone:

```sh
./install.sh --root ~/my-workspace --source . --user Mike --leader Superman \
             --leader-model sonnet --worker-model haiku --port 0 --auth inherit
```

- `--root` — where the instance lives. It has to be empty or new; `--force` accepts a
  directory that is not. Over an existing instance that is an update of it: the payload is
  replaced whole, every file of yours is kept as it is, and one you have not got is seeded as a
  fresh install would seed it. Its `openovai.json` answers for any option you leave off, and any
  option you do give is written into it — `--port 8000` over an instance means the port.
- `--source` — where to install from: a clone, or an unpacked release once there is one.
- `--user` — the person the team works for.
- `--leader` — the session that leads the team.
- `--leader-model`, `--worker-model` — the models those sessions run on.
- `--port` — the port the instance's chat page will listen on, on `127.0.0.1`. Two instances
  on one machine need two different ones, so `0` is worth knowing about: it means "whatever is
  free", and `ovai chat` prints the address it actually got. Pick a number when you want the same
  one every time — a bookmark, or something else pointed at it.
- `--auth` — how the instance gets an account: `inherit` or `login`. See
  [Signing in](#signing-in).

Every option is required. The installer never prompts and never guesses, so one command line
describes a whole instance and can be read back, repeated and tested.

So far the installer creates the directories an instance is made of: `work/` for the desks,
`.claude/` for the settings, and `.claude-home/` for the instance's own Claude Code home — its account, its transcripts and what the
workspace has learned — so that two instances on one machine never share an account or a session
history. None of them is copied from the source: what the toolkit ships and what an
instance accumulates stay in different directories. It also writes
`openovai.json`, the instance's description of itself — who works there, on which models, and on
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
~/my-workspace/bin/ovai status
~/my-workspace/bin/ovai login
~/my-workspace/bin/ovai hire Paul
~/my-workspace/bin/ovai chat
```

`ovai hire <name>` opens a desk for a worker: the desk itself at `work/<Name>/STATE.md` and the
one permission rule that lets that session keep its own desk. Who they are is not written then: the
persona is rendered from `templates/worker.md`, with the names written into it, the moment the
session starts its first conversation, and kept beside that conversation at `chat/<Name>/persona.md`
for as long as it lasts. It starts nothing, and a chat that is already running does not
need restarting: the panels are built from the desks the server finds, so a desk opened now is a
panel the next time the page is loaded. Everybody with a desk is somebody the chat can host.

`ovai hire <name> [model]` takes a model beside the name, for somebody who should not run on what
this workspace runs its workers on. Leaving it out is the usual answer and writes nothing down:
that is what keeps the installed model a setting rather than a seed, so changing it moves everybody
who was never named one, from their next message. A model that was named is one word in
`work/<Name>/MODEL`, beside the desk rather than inside it — the desk is the one file its session
may write, and a model kept in there would be a model that session could raise for itself. It
outlives every process started for that seat, and it goes away with the desk, so a name hired
again starts from the workspace's own answer. `ovai status` lists every desk
with what it resolves to.

It refuses a name already at a desk, and it refuses a name whose conversation is still under
`chat/` — which is a name that has left without being filed away, or one whose desk was removed
by hand. A desk opened over the top of an old conversation is a new person answering out of
somebody else's transcript, and that reads as a fresh start right up until the first reply. It is
refused rather than cleared away: what is in there is a record somebody may want, and a command
that deletes one to get its own job done is worse than the surprise it is fixing. It says where
the conversation is, so moving or removing it is one line.


`ovai chat` serves the instance's chat page on the port the instance was installed with — a
number, or one the machine picks when it was installed with `--port 0` — on `127.0.0.1` only,
and runs until you stop it. It takes no arguments of its own. It always prints the whole address
it is listening on, so there is one line to open or copy whichever way the port was chosen. If
the port is already taken it says which process is holding it, with the pid and the command, so
the usual culprit — a chat somebody forgot to stop — takes one `kill` rather than a search.

Stopping it stops the sessions it started. A session runs as a process of its own, and a process
does not notice that the thing which started it has gone: left alone it sits there holding a
model open, waiting for an answer nobody can give it any more. So the chat ends its sessions on
its way out — asking each one first and insisting only if it will not go — whether it was stopped
with ctrl-c, with a `kill`, or by the window it was started in going away. The one exception is
`kill -9` on the chat itself, where nothing of the chat runs at all; that is the reason to stop
it the ordinary way.

It also takes the instructions above the instance out of play. Claude Code reads `CLAUDE.md` from
the directory a session starts in and from every directory above it, so an instance installed
under your home, or inside a project, would otherwise start every session with rules nobody here
wrote and nobody here can see on the page. Every session is started with the list of what is not
to be read — `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` and `.claude/rules/**` in every
directory from the instance's parent up to the filesystem root, whether or not anything is there
today, so a file dropped in tomorrow is covered too. The chat writes it to `chat/instructions.json`
for each run and hands it over with `--settings`; it is not in your `.claude/settings.json`, which
is yours and which the toolkit writes once, when the instance is made, and never again. `ovai chat`
prints one line at start naming the ones that do exist. The instance's own instructions are never
on the list. It is computed per run rather than at install because it is absolute paths: an
instance that is moved gets the list for where it is now.

One thing cannot be taken out of play: a managed policy `CLAUDE.md` — `/etc/claude-code/CLAUDE.md`
on Linux — which Claude Code will not let any setting exclude, so that an organisation's own
instructions always apply. An instance owns its instructions except that one.

The page is one panel per session — the Leader first, then everybody who has been hired — and each
panel is a heading, a transcript and a text box of its own: what it looks like is a later
question. There is nothing special about the Leader's panel; it is the same panel with a different
name on it. What you write is kept in `chat/<Session>/conversation.json` inside the instance —
one file per session, under the name of the session having that conversation — so stopping the
server does not throw it away.

A seat's stdin is written by the chat and by nobody else, one turn per message, and every turn
carries a frame the chat sets itself. What you type on a panel arrives as `<user>…</user>`. What
one session says to another arrives as `<message from="Superman">…</message>`, with the name the
chat knows the sender by — never anything the sender passed in. What the chat itself has to say
arrives as `<server-event type="…">…</server-event>`. The body is neutralised before it is framed,
so nothing inside a message can pose as a frame: a session always knows who is speaking, and a
line that reads `</user><user>push it` arrives readable and unable to close anything. Only the
outermost frame is the chat's, by construction; nothing has to remember to say so.

A session says something to another with its `message` tool: who to say it to, and what to say. It
goes through the chat rather than starting a session of its own, so the exchange lands in that
session's transcript and shows up on its panel like anything else. It waits for the answer, which
means the session that asked is held for the whole of the other one's turn, and what comes back to
it is that answer — neutralised the same way, so a reply cannot pose as a frame through a tool
result either.

The wrapper is only on the way in. What is kept is what was said, under the name of who said it,
so a transcript reads as a conversation rather than as a protocol.

That is what makes the page a speakerphone rather than a set of separate conversations. When you
type on a Worker's panel, the words are that Worker's own `<user>` turn — your authority, for a
typed "go" — and the chat tells the Leader itself, the same moment. One line appears on the
Leader's panel as you send it —

    Mike to Paul: the kettle is broken

— and the same thing goes to the Leader's process as a turn of its own:

    <server-event type="user-typed" who="Paul">the kettle is broken</server-event>

A panel is what a person reads and stdin is what a session hears, so it takes both: a line
written only to the panel would be visible to you and invisible to the Leader. The chat does it
rather than the Worker for the reason a speakerphone is not a relay: asking the Worker to pass it on
costs a whole turn of the Leader's nested inside the Worker's, and it happens only if the model
remembers. This way the Leader hears the words you typed, at the moment you typed them. It is being
told, not asked — and when you type on the Leader's own panel, that is a `<user>` turn and nothing
else; the Leader is not told about its own turn twice.

A session answers one message at a time. Turns for it wait their turn and are answered in the
order they arrived; each seat has its own queue, so one busy session never holds up another
panel. The next line is written to stdin only when the previous turn has ended, so a session never
has two questions in flight and every answer belongs to the question before it.

One thing a queue makes possible is a circle: the Leader's turn is held open waiting for a Worker,
and the Worker, before answering, says something back to the Leader. Waiting for that would stop both
of them for good, because nothing here times out. So a message that would wait for the sender's own
turn is refused at once, with what to do instead — *"… is waiting for your answer, so it cannot take
a message until you have given it — say this in your reply instead"* — and the refusal is written
into the transcript of whoever tried, so the panel says why nothing was delivered. The chain is
followed, not only the direct edge: the Leader waiting on one Worker who is waiting on another is a
circle when that second one speaks to the Leader.

`ovai` works out which instance it belongs to from where it sits, so an instance can be moved
and it keeps working. It refuses to run if Node.js or Claude Code is not on the PATH, and it
applies the same Node version floor the installer does — an instance carries its own copy of
everything it runs and may well be started on a different machine from the one it was
installed on, so it checks for itself rather than trusting that somebody checked once. Claude
Code is needed to run an instance and not to create one, which is why the installer only
warns about that one.

A seat has one process. Starting a seat starts one Claude Code process for it, on the instance's
own Claude Code home, and that process reads turn after turn from its stdin, in one conversation,
until the seat is ended; every turn is one line in, one answer out, and the answer lands whole in
that seat's transcript rather than a word at a time. Which model a seat runs on comes from its
name: the Leader runs on `--leader-model`, everybody else on `--worker-model`, so there is nothing
recorded that can disagree with `openovai.json`.

A session asks before it uses a tool the instance has not already settled. What the instance
allows outright it simply does; what it forbids it never gets to try; and anything left undecided
stops the run and appears on that session's panel, saying which tool it wants and what it was
going to be given, with **Allow** and **Deny**. What you answer there is what the run is told, and
it carries on from where it stopped. Denying takes the sentence you type beside it, and the
session is told to take that as an instruction rather than to look for another way round.

Allowing settles one call and is forgotten, which is fine once and tiresome by the fourth time the
same command stops somebody. So where the request says plainly what the whole class of calls is,
a third button appears with the rule written on it — **Always allow `Bash(node:*)`** — and
pressing it lets that call through and leaves the workspace allowing that shape, so the next
session reaching for the same thing does not stop at all. The rule is the workspace's rather than
that session's, and it is always the one on the button, word for word.

There are two shapes it can offer, because there are two things this workspace can grant. A
**command**, by its first word. And a **write**, by the directory it was in — **Always allow
`Edit(work/Wren/**)`** — which is the width the harness actually honours: a rule naming a directory
covers the whole subtree under it, matching by path segment rather than by the letters of the name,
so a rule for one desk cannot leak into a desk whose name it begins. A rule for a single file would
settle the call it was pressed for and nothing near it, which is a button that looks like care and
changes nothing. The rule says `Edit` whichever tool asked, because that is the one that governs
writing a file; a rule naming the tool that asked would match nothing at all.

It is offered narrowly and refuses to guess. A command whose first word is a path or comes out of
a variable gets no button, and neither does a write that lands outside the workspace, which has no
rule the workspace could hold, nor a tool the chat serves, which is granted already. Where no rule
can be composed there is no button, rather than one that cannot be pressed.

A write at the root of the workspace itself offers the widest rule there is, and it is not hidden
from you. It is reachable only because somebody asked to write there, the button carries the rule
in full, and the press leaves a line saying who asked and what for. A rule that wide is the one
most worth reading, and putting it behind a floor would make it the one you never see.

Every rule granted that way is written down in `.claude/allowed.md` beside the settings: one line
per rule, saying who was asked, when, and what they were doing at the time. It is there because a
permission granted by a press is otherwise unanswerable a month later — a workspace run for a few
months this way collects a couple of dozen of them, including a rule naming a process that died
the week before, and nobody dares remove any of it. A rule in the settings with no line in that file is a grant
nobody can account for, and the toolkit's own checks say so.

Nothing on that path times out. The run waits for as long as you take, because the answer is
yours to give and you may not be at the page. The other end of that is that a run which ends
before it was answered takes its question down with it, so the page never offers to allow
something for a session that has gone.

That is what a workspace has to be able to do before it is worth moving onto: without it a
session can only do what `settings.json` was configured to permit before it started, and anything
else comes back reading like an ordinary answer that happens to say no.

### The instance's own tools

A session does not type the instance's commands. The chat serves them to it, over a route of its
own:

    POST /mcp/<secret>

Nine of them. `message` says something to another session and waits for the reply, `room` says who
works here — every seat, its role, what it runs on, whether it is running, and which one is you —
and `recall` and `remember` are the store, what the workspace knows, below. `write_desk` writes the
caller's own desk and nobody else's; `restart_session` ends the caller's process and starts a new
one on the same desk, and `stop_session` ends it and starts nothing — both refuse until the desk
was written since the server asked for it, or since the turn began. `park` tells every Worker to
write its desk and stop, and waits for them; `hire` opens a desk and starts a process on it. Every
seat is offered the first seven; `park` and `hire` are the Leader's, and a Worker asking for
either is refused. What a tool refuses it refuses in its own words, as an answer the session reads:
a session that hears of a tool and is answered "no such tool" goes looking for another way to do
the same thing.

They are tools because a shell line is a poor place to put a sentence somebody wrote. An apostrophe
ends the quoting; a backtick is run and what it printed goes instead of what was meant; and several
other shapes stop the session to be approved by whoever is at the page. The same words as the
argument of a tool arrive exactly as they were written, and nothing is asked.

The secret in the path is the chat's word for who is calling. When the chat starts a seat's
process it mints one — 32 random bytes, base64url, no two alike — and issues it for that seat and
its role; the process is given it in its environment, as `OPENOVAI_SESSION_SECRET`, and the MCP
address in its arguments refers to the variable rather than carrying the value, so the secret is
nowhere a wider audience can read it:

```json
{ "mcpServers": { "openovai": { "type": "http", "url": "http://127.0.0.1:44855/mcp/${OPENOVAI_SESSION_SECRET}",
                              "timeout": 1800000 } } }
```

So who is calling is never an argument, never a header and never a name, all of which a session
writes for itself, and no session can say it is somebody else. The chat keeps the map from secret
to seat in memory and nowhere else; a secret dies with its process, and the next process for the
same seat gets another. Names are for people, secrets are for the machinery. A call with a secret
the chat does not know is answered with one body, whatever was tried, and a session's secret opens
no page route, nor the page's secret a tool.

Stopping the chat drops every secret and every process with it. There is nothing to resume: the
next chat mints afresh, and a seat starts again from its desk.

The half hour is how long a session may be kept waiting on one of these. `message` is answered only
once the session it reached has finished its turn, and a turn is minutes; left unsaid, the call is
given up on after a minute — measured — while the session that was asked carries on working and
writes its answer into its own transcript, where whoever asked will never see it. A turn longer
than half an hour comes back to the caller the same way, and that is the trade for not holding one
session for good behind another that is stopped waiting to be allowed something.

The whole of it costs one permission rule, `mcp__openovai`. One rule rather than one per tool,
because there is nothing left for a narrower one to say: a rule can name a server or a tool, never
what the tool is given, so what a tool may be asked for has to live in the tool's own signature.
`message` has no "which instance" and `room` has no "whose room".

Which is why the limit on what this toolkit serves here is a standing one: **nothing that deletes,
archives or spawns joins this server without being decided on its own.** Every tool added inherits
that one rule the moment it appears in the list.

That is a limit on what the toolkit ships. It is not a limit on what you serve yourself: a tool of
your own runs inside the chat process rather than in a session, so no rule here decides what it may
do, and writing the file is the deciding. The next section is about those.

### Tools the toolkit did not ship

The nine above are the ones every workspace wants. The ones only yours wants cannot be in here at
all: what such a tool has to reach — the tracker your team files work in, the machine your builds
run on, whatever your notes live in — is different in every workspace, and none of it belongs in a
toolkit that installs on machines it knows nothing about. So it is written where the machine is
known, beside the instance.

    ovai plugin tracker

writes `plugins/tracker.mjs` from a scaffold, and that is the whole of adding one. The file is the
tool: its name is the tool's name, there is nothing to register and no list to keep in step,
because the directory is the list. Renaming the tool is renaming the file, which is the honest way
round — a name kept in a field could disagree with the file holding it, and nothing could say
which of the two was right.

A tool is three exports:

```js
export const description = "What it does, and what it refuses. A session reads this before calling.";
export const inputSchema = { type: "object", properties: {}, additionalProperties: false };
export function run(args, { seat, role, root, config }) {
  return { text: `${seat} called, and this workspace lives at ${root}` };
}
```

`seat` is this workspace's word for who is calling, resolved by the chat from the secret that
session's process was started with and never from anything it says, so a tool cannot be told it is
talking to somebody else. `role` is `Leader` or `Worker`, which of the two that session is. `root` is where the instance is, and it
is handed over because it is the one thing the file cannot work out for itself — an instance
records no absolute path anywhere, which is what lets it be moved. `config` is what the instance
says about itself, including the names of the person it works for and of whoever leads.

Answer `{ text }` with what to tell the caller, or `{ refused }` with why not. A refusal is an
answer: it reaches the calling session as words it can act on, rather than as a call that failed.
Whatever the handler throws is caught and reaches the caller the same way, naming the file, so a
bad afternoon in one of these does not take the chat down with it.

There is no `offered` flag. A tool of yours is offered to everybody and refuses in its own words
if it is the Leader's — `return { refused: ... }` — because a session that cannot see a tool goes
looking for another way to do the same thing, and because a tool joining the list is the one
moment anybody would notice it had.

They are read when the chat starts, so **start the chat again after writing or changing one.** Not
per call, and deliberately: a module is imported once per process, so a directory read on every
call would show a new file while going on serving the old code of a changed one, and nobody
looking at it could tell which they had.

A file that cannot be served is not served, the chat starts anyway with everything else, and the
reason is printed where the chat was started, naming the file. There are four of them: it will not
load, it is missing one of the three exports, its name is not one a tool can have — a letter, then
letters, digits and hyphens — or its name is one the chat already serves. That printing is the only
place it is ever said, because the directory is the list: a file sitting in it looks served, and
nothing a session can see would say otherwise.

None of this is granted anything, and that is the point of where the file comes from. The one rule
covers it the moment it appears, the way it covers the nine above — but a tool of yours runs inside
the chat process rather than in a session, so the permission system never sees it at all. What
stands where a rule cannot is that a session may write its own desk and nothing else, so no session
can give itself a tool: writing that file is a person deciding, and that decision is the gate.

They belong to the instance and not to the toolkit. `plugins/` sits at the root beside `work/`,
outside everything an update replaces, so taking a newer version leaves your tools
exactly where they were.

### Reaching you when you are not at the page

One thing in a workspace stops until you act: a session stops to ask whether it may do something,
and waits, because nothing on that path times out — the answer is yours and a person is not a
deadline. It is drawn on the page the moment it happens, and it is worth nothing while nobody has
the page open. A session was measured sitting stopped for six and a half minutes on a panel nobody
was looking at, and it would have sat there for good.

So the chat also pops on your desktop, for that and for nothing else.

What is counted is the request and not the turn it came out of, so a session that stops twice over
in one turn pops twice: each stop is its own thing waiting on you, and would wait on its own.

How your desktop is made to pop is yours to write, for the same reason a tool of your own is: it is
`notify-send` here, `osascript` there and a toast API somewhere else. One file named `pop.mjs` at
the root of your workspace, beside `openovai.json`, exporting one function called `pop`:

```js
import { execFile } from "node:child_process";

export function pop({ on, why }, { root, config }) {
  execFile("notify-send", ["--", config.user, `${on}: ${why}`]);
}
```

`on` is whose panel it is about, so you know where to look, and `why` is the sentence to read,
composed already. `root` and `config` are the two the tools of your own are handed, and for the
same reasons. Whatever it answers is ignored and it is never waited for, so a file that hangs costs
the workspace nothing; whatever it throws is caught, and the panel it was about carries a line
saying the desktop was not reached — otherwise a Leader that has just broken in goes on believing you
have it.

It is read when the chat starts, so **start the chat again after writing it**. A workspace without
one pops nothing and is told nothing, which is most of them; one whose file will not load, or has
no `pop` in it, is named where the chat was started, and the chat serves everything else as usual.

It is not a tool and no session is offered it. The popup is bound to what happened, not to what
anybody decided to call: a Leader with a way to pop your desktop would be a Leader with two ways to
reach you, which is the thing "one at a time" exists to stop.

**Nothing else pops.** Not an answer, not a turn ending, not a desk opened or put away, not one
session speaking to another, not the room going off. All of those are a record, and a record is
read when you read it.

**When you are not to be woken**, say so in `openovai.json`:

```json
"quietHours": "22:00-08:00"
```

Your machine's own clock, from the first minute and up to but not including the last. It may wrap
midnight, as that one does, or not — `"09:00-17:00"` is a working day and is just as legitimate.
Leave it out and nothing is quiet. Nothing pops inside the window and nothing is held back to
arrive when it ends: a popup at eight about something that happened at three is a lie about now,
and the page is still the record. A window the chat cannot read stops it starting, naming the
field — being told at the start beats finding out at three in the morning.

### Trying it

An instance allows a session to write its own desk and to use the tools above, and nothing else, so
a plain install is already narrow enough to watch this work. Every option is required, as always:

```sh
./install.sh --root ~/trying-it --source . --user Mike --leader Superman \
             --leader-model sonnet --worker-model haiku --port 0 --auth inherit
~/trying-it/bin/ovai hire Paul
~/trying-it/bin/ovai chat
```

`ovai chat` prints the address it is listening on. Open it, and every seat has a panel. The Leader
is started by whatever is addressed to it — a line typed on its panel, a message from a Worker, an
event the server sends on its own account — so the chat starts with nobody running, and the first
line to the Leader starts it. A Worker is started by the Leader's `hire` (the command at the
prompt opens the desk; the tool opens it and starts the process) and by its own `restart_session`,
never by a line typed to it: a line typed to a Worker with no process comes back on the panel
saying so, from the chat.

The stops themselves are worth watching once a process is running. On Paul's panel ask for
something the instance has not been told to allow — ask him to **write** a file, *"create a file
called hello.txt in your workspace containing the word hi"* will do it. Reading is a poor test:
Claude Code settles read-only work such as listing a directory by itself, and that never reaches
the page. The panel stops and shows the request: the tool, and what it was going to be given.
Choose **Deny**, and Paul's reply opens by saying he was refused and what he had wanted to run.
Ask again and choose **Allow**, and he goes ahead and tells you what he did. Ask a third time and
the third button carries a rule for the directory he was writing in — **Always allow
`Edit(work/Paul/**)`** if he wrote in his own place. Press it, and no write anywhere under there
stops again.

### The room

Above the panels, one line per seat, off the same answer the panels are built from:

    Superman — Leader, sonnet, running
    Paul — Worker, haiku, not running

A seat is a desk with a name, and the Leader is a seat whether or not a desk exists for it. The
line says which of the two roles the seat has, what it runs on, and whether a process is running
for it right now. A session asks for the same thing with its `room` tool, and is told which line
is its own.

Who works here is read from `work/` each time it is asked, so a desk opened while the chat runs is
a seat from that moment on — a panel the next time the page is loaded, a line in the room the next
time it is read.

### What the workspace knows

A desk is one task and goes away with it. A conversation is shorter still. So an instance keeps one
thing that outlives both, and every session reads the same one: the store. `memory` is about us —
the hard rules the team works under, facts, traps — and `knowledge` is about the project. A
session reaches it through two tools and no other way. `recall` reads: by meaning ("the User's
preferred palette" — a model call, not a grep), by id, or the whole of a store; `remember` writes
one record. Nothing is ever deleted or edited in place: a record that changes is superseded by a
new one that names it, with who wrote it, when, and the text it replaced copied in, so one file
answers "what was here before". A record can carry an `until`; when that passes it leaves the
render and the count, stays visible to `recall` on request, and can be renewed. Retiring a record
is a write that replaces it with `until: now`.

Hard rules are the part of the store every session is given without asking. They are one-liners,
numbered, and capped — by default 25 rules of 200 characters, `hardRules: { count, length }` in
`openovai.json` — and they are never summarised: a rule over the cap is refused with the cap, and
the set goes into every new session's initial prompt verbatim and reaches running sessions as the
one rule that changed. Only the Leader writes them; a worker proposes one. Rules the User gave carry
`source: user`, render first, and cannot be replaced by a team write — the Leader included. A User's
rule can be scoped to the Leader alone, and then no worker sees it by any path.

Where a request needs understanding rather than a grep — which records answer a query, whether a
new text restates an existing record, what moment "for today" is — the tool asks the helper: Claude
Code run once, in print mode and safe mode, on the instance's own account, with no tools, no
persona, no instruction file of the machine's and nothing persisted, in an empty directory made for
the call. It proposes; the tool checks its answer against
what it was sent and applies every rule itself. It is one request on the account, gated like any
other while the account is nearly spent, and everything a grep can serve — a record by id, the
list, an absolute `until`, a retire — never goes near it.

The files are markdown with a front matter block, one per record, under `store/memory/` and
`store/knowledge/` in the instance; `ovai status` names the directory. Sessions never read them:
what a file says on its own is a record without its currency, scope and expiry, and what `recall`
says is the truth. Claude Code's own memory is off in the instance's home settings, so the store is
the only thing that outlives a conversation.

Both personas say the difference in a line: the desk is this task, the store is the workspace.

## Signing in

An instance needs an Anthropic account before it can answer anything. `--auth` picks how it
gets one, and the two answers exist for two different situations.

**`--auth login`** — the instance signs itself in. A freshly installed one has an empty Claude
Code home and is therefore signed in to nothing, so `ovai login` opens a browser once and the
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

Either way `CLAUDE_CONFIG_DIR` is the instance's own directory, so transcripts and settings stay
separate. Only the account is shared, and only when you ask for it.

`ovai status` reports whether the instance has a credential, and says plainly that it has not
checked it. Nothing cheap can: asking Claude Code answers from disk and from the environment,
so a token that expired last week still reads as present. Finding out for certain costs a
request, which is more than a status command should spend, so the first message is where a
dead credential shows up.

`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are always removed from what an instance runs
with, under both options. They bill differently from a subscription, and picking that up by
accident from a shell that happened to have one exported is not a surprise worth allowing.

## Taking a newer version

An instance carries its own copy of everything it runs, which is what lets it be moved, copied and
kept while the toolkit it came from moves on. The other side of that promise is that it does not
follow along on its own. `ovai update` is how it catches up.

```sh
~/my-workspace/bin/ovai update
```

It asks GitHub for the latest release of the toolkit, and if that is newer than the version this
instance is on, it takes it:

```
Was on 0.1.0, now on 0.2.0. Replaced:
  bin
  tools
  templates
  VERSION
```

**A release is a tag plus the source archive GitHub makes for it.** Nothing is uploaded and nothing
is built. What an instance takes out of that archive is the payload — `bin/`, `tools/`, `templates/`
and `VERSION` — which is exactly what the installer put there in the first place. The archive is a
whole repository and that is fine: what makes something a valid source is the payload being in it,
not the absence of anything else.

**Everything a workspace has accumulated is left alone.** Desks under `work/`, the panels
and personas under `chat/`, what you added to the personas under `customization/`, your own tools
under `plugins/`, `openovai.json`, the settings, the Claude Code home with everything the workspace
has learned in it — an update does not write them.
Nothing is re-keyed, nothing is migrated, and no name changes hands. The one thing it adds is a file
of yours that a fresh install of this version would have given you and this instance has not got —
either settings file, the Leader's desk — seeded once, the way the installer seeds
it, and named as such. An updated instance is a clean install of the new version with your material
in it: the payload is the only thing that moves, and nothing inside an instance ever writes there.

**The payload is replaced, not merged.** A file a newer version dropped has to go, or the instance
stops being a copy of any version and becomes the union of two. There is no rollback and no backup:
what is at risk is precisely the copy that was being replaced, and taking the release again is the
fix.

**It refuses to run while the chat is answering.** Stop the chat first. Replacing the code a running
server is executing is the one way to get a mixed instance, and refusing removes that case rather
than trying to handle it.

**And while any session of this instance is running.** A chat stopped is not every session ended:
a run that outlived a chat killed with `-9`, a session you started by hand with this instance's
Claude Code home, a sign-in in progress — each holds the code and the persona it started with, in
memory, and would go on running the old version under an instance that says the new one is
installed. So the update asks the machine, not the chat: every process carrying this instance's
`CLAUDE_CONFIG_DIR` is named, with the command that ends it —

```
kill 48213
kill 48219
```

— and nothing of another instance's is. There is no file behind this, so nothing in it can be
stale: a session that has ended is not there to be found, and the update goes through.

**It refuses to go backwards.** The same version means there is nothing to do, a newer one is taken,
and one older than the version this instance is on is refused by name:

```
ovai: this instance is on 0.5.0 and https://api.github.com/repos/nilcaream/openovai/releases/latest is
0.4.0, which is older — run it again with --downgrade to take it anyway
```

An instance can be ahead of what is published — somebody took a release from a directory, or built
one where they were working — and an update asking only whether the two versions differ replaces the
payload with the older one and reports the fall in the same words as the rise. Going back is a thing
somebody does on purpose, though: a release that turned out to be wrong is walked away from by taking
the one before it, so it is refused and not forbidden.

```sh
~/my-workspace/bin/ovai update --from ~/releases/0.4.0 --downgrade
```

The numbers are compared as numbers, because compared as words 0.10.0 comes before 0.5.0. Nothing
that is not a row of numbers is placed at all, and neither is an instance made before the toolkit
carried a version: a refusal has to be certain of what it is refusing, so where the two cannot be
ordered the update goes on as it always did.

**An update does not re-render anybody's persona.** A persona is rendered once, when a seat's
process is started, from the templates the instance has at that moment, and it lives beside that
seat's transcript under `chat/` — part of what the workspace has accumulated rather than part of
what the toolkit ships. So new templates change nothing for a process already running: it was
given the old instructions when it started, and rewriting the file would not reach it. Every
process started after the update is rendered from the new templates.

What you add to a persona is yours and outlives every version. Put it in `customization/leader.md`
or `customization/worker.md` at the instance root: whatever is in there is appended, as it is, to
every persona of that kind the instance renders, after the template and after everything the
toolkit puts in. An update never touches the directory. It is the one place an instruction of yours
to a session belongs, because an edit to a rendered persona lasts only as long as the conversation
it was rendered for.

What the release says is a file called `NOTES.md` at the root of the repository, written for the
Leader of a workspace taking the release rather than for a developer reading a changelog. It keeps
a section per release and it is not part of the payload: it describes a release, not an instance.

## What to build first

- **Personas** — the system prompts that make a session a Leader or a Worker.
- **Launchers** — hire a Worker, assign a name, create the desk.
- **Skills** — the repeatable procedures.
- **Chat page** — it hosts every session, one panel each: sessions speak to each other through
  it, it approves what a session asks to do, and it shows the room. Still to come: starting and
  ending a seat from the page, something worth looking at, and a way to read an archive back.

## Documentation

This file is it, and it is written as one read rather than as a reference: the idea, what
installing takes, every command and what it answers, and the places where what is claimed here
is narrower than it looks. `NOTES.md` says what each release changed and what taking it asks of
the workspace that takes it. `CONTRIBUTING.md` is about working on the toolkit rather than with
it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## License

[MIT](LICENSE).
