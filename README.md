# OpenOv AI

A toolkit for running a small team of AI developer sessions on one machine, built on top of
[Claude Code](https://code.claude.com). One session is the lead; the others are named workers
with one task each. Every session's identity is a directory on disk, not a process — so a
session can be replaced at any time without losing the work.

> **Status: early development.** This is a prototype. The design is being worked out in the
> open, so the layout, the names and the interfaces will move.

## The idea

- **A desk is a person.** Each worker owns a directory holding one Markdown state file. That
  file, not the session's memory, is what a replacement session reads to continue.
- **Handover replaces summarisation.** When a session's conversation fills up, it is asked to
  write its desk and the thread is ended; the next message on that panel starts a fresh one,
  which reads the desk first. Nothing is compacted away.
- **One lead, many workers.** The lead delegates, takes the workers' questions and decides what
  reaches the human. Workers do the work and leave when it ships.
- **Every session is hosted on the page.** Nobody has a terminal of their own. The lead and
  every worker get the same panel, with the same text box under it.
- **One place says who is doing what.** A room above the panels gives each session a line: what
  it is on, whether it is answering and how many messages are waiting behind, who is holding it
  up, how big its conversation has grown and how long since anything happened on its panel. The
  lead, who is on the page rather than looking at it, asks for the same thing with a tool.
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
  free", and `ovai chat` prints the address it actually got. Pick a number when you want the same
  one every time — a bookmark, or something else pointed at it.
- `--auth` — how the instance gets an account: `inherit` or `login`. See
  [Signing in](#signing-in).

Every option is required. The installer never prompts and never guesses, so one command line
describes a whole instance and can be read back, repeated and tested.

So far the installer creates the directories an instance is made of: `work/` for the desks,
`personas/` for the file that tells each session who it is, `.claude/` for the settings, and
`.claude-home/` for the instance's own Claude Code home — its account, its transcripts and what the
workspace has learned — so that two instances on one machine never share an account, a session
history or a memory. None of them is copied from the source: what the toolkit ships and what an
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
~/my-workspace/bin/ovai room
~/my-workspace/bin/ovai say Paul what are you working on
```

`ovai hire <name>` opens a desk for a worker: the desk itself at `work/<Name>/STATE.md`, a persona
at `personas/<Name>.md` with the names written into it, and the one permission rule that lets
that session keep its own desk. It starts nothing, and a chat that is already running does not
need restarting: the panels are built from the desks the server finds, so a desk opened now is a
panel the next time the page is loaded. Everybody with a desk is somebody the chat can host.

`ovai hire <name> [model]` takes a model beside the name, for somebody who should not run on what
this workspace runs its workers on. Leaving it out is the usual answer and writes nothing down:
that is what keeps the installed model a setting rather than a seed, so changing it moves everybody
who was never named one, from their next message. A model that was named is one word in
`work/<Name>/MODEL`, beside the desk rather than inside it — the desk is the one file its session
may write, and a model kept in there would be a model that session could raise for itself. It
survives a handover, which ends a conversation and touches nothing else, and it goes away with the
desk, so a name hired again starts from the workspace's own answer. `ovai status` lists every desk
with what it resolves to.

It refuses a name already at a desk, and it refuses a name whose conversation is still under
`chat/` — which is a name that has left without being filed away, or one whose desk was removed
by hand. A desk opened over the top of an old conversation is a new person answering out of
somebody else's transcript, and that reads as a fresh start right up until the first reply. It is
refused rather than cleared away: what is in there is a record somebody may want, and a command
that deletes one to get its own job done is worse than the surprise it is fixing. It says where
the conversation is, so moving or removing it is one line.

The chat page hires too, from a name box above the panels, and refuses the same things for the
same reasons in the same words — it calls this. What a name is refused for has one answer, not
two that can drift apart.

`ovai chat` serves the instance's chat page on the port it was installed with — or, with
`--port 0`, on one the machine picks — on `127.0.0.1` only, and runs until you stop it. It
always prints the whole address it is listening on, so there is one line to open or copy
whichever way the port was chosen. If the port is already taken it says which process is
holding it, with the pid and the command, so the usual culprit — a chat somebody forgot to
stop — takes one `kill` rather than a search.

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
wrote and nobody here can see on the page. Every time `ovai chat` starts it writes into the
instance's own `.claude/settings.json` the list of what is not to be read: `CLAUDE.md`,
`CLAUDE.local.md`, `.claude/CLAUDE.md` and `.claude/rules/**` in every directory from the
instance's parent up to the filesystem root, whether or not anything is there today, so a file
dropped in tomorrow is covered too. It prints one line naming the ones that do exist. The
instance's own instructions are never on that list. The list is written at start rather than at
install because it is absolute paths: an instance that is moved gets the list for where it is now.

One thing cannot be taken out of play: a managed policy `CLAUDE.md` — `/etc/claude-code/CLAUDE.md`
on Linux — which Claude Code will not let any setting exclude, so that an organisation's own
instructions always apply. An instance owns its instructions except that one.

The page is one panel per session — the lead first, then everybody who has been hired — and each
panel is a heading, a transcript and a text box of its own: what it looks like is a later
question. There is nothing special about the lead's panel; it is the same panel with a different
name on it. What you write is kept in `chat/<Session>/conversation.json` inside the instance —
one file per session, under the name of the session having that conversation — so stopping the
server does not throw it away.

A panel says when its session is answering. That matters most for the turns you did not start:
a session is put to work by another session over its `say` tool, and by this page open in a
second window, and a panel that said nothing while that happened would read as one nobody is
listening on. Waiting for a turn counts as answering — from the panel's side there is no difference
between a message being worked on and a message queued behind one, and both mean the same thing
to whoever is looking at it.

A run that is not going to end on its own can be ended from the panel it is on. *End this run* ends
the run and everything it started underneath, and leaves the session: the thread is intact, the
panel is still there, and the transcript says the run was ended before it answered rather than
going quiet. It is offered whatever the session is doing, because it is wanted at the moment a
panel looks stuck and a button that only worked on a panel already known to be busy would be no
use; pressed with nothing running, it says so and nothing happens. A run given the word and not
taking it is given two seconds and then made to go.

This is the one thing here that reaches a session whose queue has stopped moving. Everything else
typed at a panel is queued behind the turn in front of it, which is exactly the turn that is not
finishing, so an ending that queued would be an ending that never arrived.

A session says something to another with its `say` tool: who to say it to, and what to say. It
goes through the chat rather than starting a session of its own, so the exchange lands in that
session's transcript and shows up on its panel like anything else. It waits for the answer, which
means the session that asked is held for the whole of the other one's turn, and what comes back to
it is that answer.

`ovai say <name> <message>` is the same thing for a person at a terminal, and prints what came back.
The chat writes the address it is listening on to `chat/listening.json` when it starts — with
`--port 0` nothing knows the address until then — and this reads it there. Without a chat running
there is nobody to say it to, and it says so rather than starting anybody.

Every session here has that tool and both personas name it, which is what makes the team a team:
the lead can ask a worker something mid-turn and quote the answer back to you. What else a session
is given, and why these are tools rather than commands it types, is *The instance's own tools*
below.

A session can see who is speaking to it. The page signs nothing, so what is typed there arrives as
it was typed; the `say` tool signs with the name the chat started that session under — the name in
the address it calls on, and never anything it passes in — and the chat hands a signed message over
wrapped, as `<from-session name="Superman" role="lead">…</from-session>`. Anything outside a
wrapper is therefore yours, by construction: nothing has to remember to say so. A signature naming
nobody who works there is refused rather than passed on as the human's.

The wrapper is only on the way in. What is kept is what was said, under the name of who said it,
so a transcript reads as a conversation rather than as a protocol — and `ovai say` run from a
terminal signs nothing, because the person at the keyboard is the human.

That is what makes the page a speakerphone rather than a set of separate conversations. When you
type on a worker's panel, the chat tells the lead itself. One line appears on the lead's panel as
you send it —

    the chat: Mike said to Paul: the kettle is broken

— and the same thing goes to the lead's session in front of whatever it is asked next:

    <overheard on="Paul" from="Mike">the kettle is broken</overheard>

A panel is what a person reads and a thread is what a session resumes, so it takes both: a line
written only to the panel would be visible to you and invisible to the lead.

The chat does it rather than the worker for the reason a speakerphone is not a relay. Asking the
worker to pass it on costs a whole turn of the lead's nested inside the worker's — three process
starts where one would do, with the panel quiet through all of it — and it happens only if the
model remembers. This way the lead hears the words you typed, at the moment you typed them, whether
or not anybody was paying attention. It hears them late, on its next turn, and that is the trade:
it is being told, not asked.

A session answers one message at a time. Messages for it wait their turn and are answered in the
order they arrived; each session has its own queue, so one busy session never holds up another
panel. Without that, a second message arriving mid-run would start a second Claude Code child for
the same session, both resuming the same thread, and the transcript would come out as two questions
followed by two answers nobody can pair up. The question is written down when its turn begins, so a
transcript reads as a conversation.

One thing a queue makes possible is a circle: the lead's turn is held open waiting for a worker,
and the worker, before answering, says something back to the lead. Waiting for that would stop both
of them for good, because nothing here times out. So a message that would wait for the sender's own
turn is refused at once, with what to do instead — *"… is waiting for your answer, so it cannot take
a message until you have given it — say this in your reply instead"* — and the refusal is written
into the transcript of whoever tried, so the panel says why nothing was delivered. The chain is
followed, not only the direct edge: the lead waiting on one worker who is waiting on another is a
circle when that second one speaks to the lead.

`ovai` works out which instance it belongs to from where it sits, so an instance can be moved
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
disagree with `openovai.json`.

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
that session's, and it is always the one on the button: a first word, never a path, never a
command line.

It is offered narrowly and refuses to guess. A command whose first word is a path or comes out of
a variable gets no button, and neither does writing a file, which names a path rather than a class
of calls, nor a tool the chat serves, which is granted already. Where no rule can be composed
there is no button, rather than one that cannot be pressed.

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

    POST /mcp/<name>

Six of them. `say` says something to another session, `status` says who works here and what each
one runs on, `room` is the room above the panels, one line per session, and `interrupt` is the
lead's one unprompted line to whoever is at the page — it takes what to say and why it could not
wait, and it says both on the lead's own panel.

The last two are the lead's alone and they change who works here. `hire` opens a desk for somebody
new; `retire` asks them to write it one last time and then files that desk and their whole
conversation away together. A session that is not the lead is not offered either, and is told whose
they are rather than that they do not exist — a session that hears of a tool and is answered
"no such tool" goes looking for another way to do the same thing.

They are tools because a shell line is a poor place to put a sentence somebody wrote. An apostrophe
ends the quoting; a backtick is run and what it printed goes instead of what was meant; and several
other shapes stop the session to be approved by whoever is at the page. The same words as the
argument of a tool arrive exactly as they were written, and nothing is asked.

The name in the path is the chat's word for who is calling. It is written into the configuration
the session is started with — passed as the configuration itself rather than as a file, because
with `--port 0` the address is not known until the chat has bound one, and a file written before
that would be a lie the next restart makes worse:

```json
{ "mcpServers": { "openovai": { "type": "http", "url": "http://127.0.0.1:44855/mcp/Superman",
                              "timeout": 1800000 } } }
```

So who is calling is never an argument and never a header, both of which a session writes for
itself, and no session can say it is somebody else. What each one is offered is decided in that
same place, from that name against the name the instance was made with: the room is the lead's, and
a worker is not offered it.

Asking for it anyway is refused by name — the tool says whose the room is, rather than that there
is no such thing, because a session told something does not exist goes looking for another way to
the same answer while one told whose it is asks that person. A worker seldom reads that sentence,
though: Claude Code turns down a call to a tool it was not offered before it leaves the session, so
what the model is told is that there is no such tool. The refusal is the boundary for anything that
posts to the route; the list is what the model goes by.

The half hour is how long a session may be kept waiting on one of these. `say` is answered only
once the session it reached has finished its turn, and a turn is minutes; left unsaid, the call is
given up on after a minute — measured — while the session that was asked carries on working and
writes its answer into its own transcript, where whoever asked will never see it. A turn longer
than half an hour comes back to the caller the same way, and that is the trade for not holding one
session for good behind another that is stopped waiting to be allowed something.

Nothing is held between one call and the next. The chat can be stopped and started again in the
middle of a turn and the session never notices: it posts to whatever is listening now, and the new
process answers a call it never saw introduced.

The whole of it costs one permission rule, `mcp__openovai`, where the three commands needed six —
each twice, because a rule is a literal prefix rather than a path, and `bin/ovai say` and
`./bin/ovai say` are two spellings of one command that would each miss the other's rule. One rule
rather than one per tool, because there is nothing left for a narrower one to say: a rule can name
a server or a tool, never what the tool is given, so what a tool may be asked for has to live in
the tool's own signature. `say` has no "which instance" and `room` has no "whose room".

Which is why the limit on what this toolkit serves here is a standing one: **nothing that deletes,
archives or spawns joins this server without being decided on its own.** Every tool added inherits
that one rule the moment it appears in the list.

It has been spent twice, both times on the same question: who is here. A lead that cannot open a
desk cannot act on what it decided, and a lead that cannot put one away leaves the person it works
for doing its clearing up. `hire` writes a desk and does none of the three things the limit names.
`retire` does one of them, and is here because of what it does first: the desk and the whole
conversation are filed away together before anything is taken down, so what is lost is a record
nothing here reads back rather than a record. Handing over stays on the page, and so does everything
about the workspace itself — who leads, what runs, and whether the room is on.

That is a limit on what the toolkit ships. It is not a limit on what you serve yourself: a tool of
your own runs inside the chat process rather than in a session, so no rule here decides what it may
do, and writing the file is the deciding. The next section is about those.

### Tools the toolkit did not ship

The six above are the ones every workspace wants. The ones only yours wants cannot be in here at
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
export function run(args, { caller, leads, root, config }) {
  return { text: `${caller} called, and this workspace lives at ${root}` };
}
```

`caller` is this workspace's word for who is calling, taken from the path the chat gave that
session and never from anything it says, so a tool cannot be told it is talking to somebody else.
`leads` is whether that session is the one leading here. `root` is where the instance is, and it
is handed over because it is the one thing the file cannot work out for itself — an instance
records no absolute path anywhere, which is what lets it be moved. `config` is what the instance
says about itself, including the names of the person it works for and of whoever leads.

Answer `{ text }` with what to tell the caller, or `{ refused }` with why not. A refusal is an
answer: it reaches the calling session as words it can act on, rather than as a call that failed.
Whatever the handler throws is caught and reaches the caller the same way, naming the file, so a
bad afternoon in one of these does not take the chat down with it.

There is no `offered` flag. A tool of yours is offered to everybody and refuses in its own words
if it is the lead's — `return { refused: ... }` — because a session that cannot see a tool goes
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
covers it the moment it appears, the way it covers the six above — but a tool of yours runs inside
the chat process rather than in a session, so the permission system never sees it at all. What
stands where a rule cannot is that a session may write its own desk and nothing else, so no session
can give itself a tool: writing that file is a person deciding, and that decision is the gate.

They belong to the instance and not to the toolkit. `plugins/` sits at the root beside `work/` and
`personas/`, outside everything an update replaces, so taking a newer version leaves your tools
exactly where they were.

### Reaching you when you are not at the page

Two things in a workspace stop until you act. Your lead breaks in, which is the one line it has to
you without being asked; and a session stops to ask whether it may do something, and waits, because
nothing on that path times out — the answer is yours and a person is not a deadline. Both are drawn
on the page the moment they happen, and both are worth nothing while nobody has the page open. A
session was measured sitting stopped for six and a half minutes on a panel nobody was looking at,
and it would have sat there for good.

So the chat also pops on your desktop, for those two things and for nothing else.

What is counted is the request and not the turn it came out of, so a session that stops twice over
in one turn pops twice: each stop is its own thing waiting on you, and would wait on its own.

How your desktop is made to pop is yours to write, for the same reason a tool of your own is: it is
`notify-send` here, `osascript` there and a toast API somewhere else. One file at the root of your
workspace, beside `openovai.json`, exporting one function:

```js
import { execFile } from "node:child_process";

export function pop({ on, why }, { root, config }) {
  execFile("notify-send", ["--", config.human, `${on}: ${why}`]);
}
```

`on` is whose panel it is about, so you know where to look, and `why` is the sentence to read,
composed already. `root` and `config` are the two the tools of your own are handed, and for the
same reasons. Whatever it answers is ignored and it is never waited for, so a file that hangs costs
the workspace nothing; whatever it throws is caught, and the panel it was about carries a line
saying the desktop was not reached — otherwise a lead that has just broken in goes on believing you
have it.

It is read when the chat starts, so **start the chat again after writing it**. A workspace without
one pops nothing and is told nothing, which is most of them; one whose file will not load, or has
no `pop` in it, is named where the chat was started, and the chat serves everything else as usual.

It is not a tool and no session is offered it. Your lead has exactly one line to you that it can
choose to send, and it already has it; a second one would be a lead with two ways to interrupt you,
which is the thing "one at a time" exists to stop. The popup is bound to what happened, not to what
anybody decided to call.

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
./install.sh --root ~/trying-it --source . --human Mike --leader Superman \
             --leader-model sonnet --worker-model haiku --port 0 --auth inherit
~/trying-it/bin/ovai hire Paul
~/trying-it/bin/ovai chat
```

`ovai chat` prints the address it is listening on. Open it, and on Paul's panel ask for something
the instance has not been told to allow. Ask him to **write** a file — *"create a file called
hello.txt in your workspace containing the word hi"* will do it. Reading is a poor test: Claude
Code settles read-only work such as listing a directory by itself, and that never reaches the
page. The panel stops and shows the request: the tool, and what it was going to be given. Choose
**Deny**, and Paul's reply opens by saying he was refused and what he had wanted to run. Ask again
and choose **Allow**, and he goes ahead and tells you what he did.

Each panel is its own conversation: a thread's id is kept in `chat/<Session>/session.json` and
every message after the first continues it, so the server can be stopped and started again in
the middle of one. If a thread ever goes missing that session starts a new one rather than
staying broken.

Beside the model, each panel says how much of itself that conversation is carrying: how big it
was at the end of its last turn, in tokens. It is a reading and not an estimate — it comes off
the same frame the answer does, where the last request a turn made is the whole conversation as
the model last saw it, and the turn after it opens there. It is not a share of anything, because
a share would need a table of what each model can hold that somebody has to keep true.

### The room

Above the panels, one line per session, saying what would otherwise mean opening every panel and
reading it:

    Paul — worker (haiku) — reading the water meter — answering, 1 waiting · 24,479 tokens · last moved just now
    Ann  — worker (haiku) — writing the install notes — needs you · 8,102 tokens · last moved 2m ago
    Ivy  — worker (haiku) — (has not said what it is on) — idle · nothing to carry on · nothing said yet
    Leo  — worker (haiku) — checking the meter reads — idle, last ran 40m ago · refused until 14:30 · five-hour window 96% full, read 2m ago · 12,004 tokens · last moved 2m ago

The phrases are tried in the order that decides what to do about them. **needs you** first — that
session is stopped until somebody here answers it, and answering is a click. Then **waiting for
`<name>`**, which is a session held up by another session and not a session being slow. Then
**answering**, with however many messages are waiting behind it — the state a run can be ended
from, above. Then **cold**, which says the next message to that session ends the conversation it
is having and starts a new one — see below. Then **idle**, which carries how long that session has
been doing nothing: `idle, last ran 40m ago`, and a bare `idle` for one that has never run at all.

That duration is part of the idle phrase and never a fact of its own beside the state, because it
is only true there. Every state above idle is a run in flight, and the file the clock comes off is
rewritten when a run ENDS — so a session answering right now has a clock as old as the turn it is
in the middle of, and a duration printed beside its state would tell you it had been doing nothing
for exactly as long as it had been working. Saying it inside the phrase makes that reading
unreachable rather than merely unlikely.

It is the conversation's clock and not the panel's, which are two different questions with two
different answers. A panel moves when anything is written on it, and a lead's panel moves every
time it overhears something said somewhere else — so a lead that has not thought for an hour can
have a panel that moved a second ago. What matters when you are deciding whether to check on
somebody is when they last ran.

What each session is on comes from one field: the `title:` in the header its desk file opens with.
That is the only part of a desk anything outside it reads, and both personas ask for that one line
to be kept current as the work moves — a session asked to keep a whole header true keeps none of
it. A session that has not said gets no guess.

**nothing to carry on** means that session has no thread: it has just been handed over, or has
never been spoken to. It is said only when it is true, because a full panel whose session
remembers none of it reads as an ordinary one until something says otherwise.

**refused until 14:30** and **five-hour window 96% full, read 2m ago** are what the model service
last told a run of that session about the account it runs on. They come from frames the chat
already receives while a session is running — no poll, no extra request, nothing read that would
not have been read anyway — and they are facts on the row rather than anything this toolkit acts
on: nothing consults them to decide whether to deliver a message, hire, hand over or queue, and a
message to a session whose row says refused is still attempted. The reading always carries its own
age, because a usage window belongs to the account and not to a session: the same window appears on
every row as of whenever that session last ran, so a low number on a row that has not run for hours
is not the account's current state, and saying when it was read is what keeps it from being taken
for one. The windows are named as the service names them, all of the ones it named, and a window it
said nothing about is left unsaid rather than shown as 0%. There is no threshold on the row, no
colour and no warning level — the number there is a fact for a person to judge. The two lines this
toolkit does hold an opinion about are in a block handed to the lead and nowhere else, which
*Where the account stands* below is about: advice to the one reader whose next act would spend the
last of the window, rather than a mark on a row everybody reads.

The last part is when anything last happened on that panel, and it is a fact rather than a
verdict. Nothing here knows whether a session quiet for an hour is finished, stuck or thinking,
and a page that guessed would be wrong in the way that looks like an answer. **cold** is not an
exception to that: it is not a guess about the session, it says what this toolkit will do to the
next message sent to it. The two clocks are different, too — a panel moves when a lead overhears
something said elsewhere, and the conversation behind it has not run since yesterday.

The room costs nothing: it is built from the same rows the panels were already asking for once a
second, so it is not a request per person per second — it is no request at all.

The lead cannot read any of this, because it is on the page rather than looking at it. It asks for
the room with a tool of its own and gets the same rows. That tool is the one thing here served to
the lead and to nobody else, as *The instance's own tools* above says.

`ovai room` prints the same rows for a person at a terminal:

```sh
~/my-workspace/bin/ovai room
```

Both ask the running chat, because half of a room is only in that process — how many turns are
going, who is held up waiting for whom, what is stopped waiting to be allowed something. With no
chat running there is no room to show, and it says so rather than printing an empty one.

### Handing a session over

When a conversation gets too big to think in, press **Hand over** on that panel. The session is
asked — in words, through the queue everything else goes through — to write `work/<Name>/STATE.md`
so a new session can carry on: what the task is, what is true right now, what to do next, and what
has already been settled. Then the thread that has been answering is ended, and the next message
starts a new one, which reads that desk first.

Nothing is summarised. What survives is what the session wrote down, in its own words, and the
transcript is not cleared with the thread — two lines under `the chat` bracket the handover
instead:

    the chat: Mike asked Paul to hand over. Paul is writing work/Paul/STATE.md before its thread ends.
    Paul: Desk written. Ready.
    the chat: Paul handed over. The thread that answered up to here is gone; the next message
              starts a new one, which reads work/Paul/STATE.md first.

Without them a panel would go on showing a conversation the session no longer remembers, with
nothing saying where the memory stops.

It waits its turn like any other message, so pressing it on a session that is in the middle of
something is fine: the turn ahead of it finishes first. There is nothing to kill — a run lives for
one message and is over long before this is asked for.

Which is why the desk is worth keeping current as the work moves rather than only when a handover
is asked for. Both personas say so, and a desk that is already true makes a handover one line's
work instead of an hour's remembering.

### The handover nobody asks for

A conversation that nobody carries on for an hour is not carried on at all. The next message to
that session ends the thread and is answered by a new one at the same desk, handed an instruction
to read `work/<Name>/STATE.md` before anything else.

This is not tidying up. Resuming a conversation the model service has stopped holding costs most of
it again at write price: measured here at fourteen times an ordinary turn on a conversation of
40,000 tokens and about twenty on a large one. It gets worse as a conversation grows, because what
does survive the hour is a shared prefix that stays the same size while the conversation does not —
so the session with the most to remember is the one this costs the most on. The alternative to ending it is paying that,
repeatedly, for a conversation nobody was using. There is no third option: what a model service is
still holding cannot be asked, only a run that has already paid can say, so the rule is
one-directional. Past the hour, certainly expensive, so something is done. Inside it, nothing is
claimed and nothing is done.

Nobody is exempt, and the lead least of all — it holds the largest conversation here and is
therefore the one this saves most on.

Nothing is summarised and nothing is asked for first. Asking the session to write its desk would be
exactly the expensive turn being avoided, so what that conversation worked out and never wrote down
is lost. That is the price of the feature and there is no version of it without one. What bounds
the loss is how current the desk is, which is the same thing the handover asks of everybody anyway.

It is never silent, and each of the three readers needs a different thing:

    the chat: Paul had been quiet for longer than a conversation can be carried, so the thread
              that answered up to here is gone. What follows was answered by a new one, which
              reads work/Paul/STATE.md first.

on the panel, before the question, for whoever opens it later and finds the memory stops there; a
`<pick-up>` wrapper on the turn itself, telling that session to read its desk, which is the only
reader that can act on it; and a sentence back to whoever asked, because a session that reached
this one through the `say` tool never reads this panel and would otherwise take the answer as
continuous with a conversation it remembers having.

A session that has no thread is never cold. There is nothing to carry on, so nothing that carrying
it on could cost, and a thread that was never there must not be ended nor a restart announced.

### Hiring somebody, and a session leaving

Above the panels there is a name box and **Hire**. It writes what `ovai hire` writes — the desk, the
persona, the one permission rule — because it calls the same code, and it shows a refusal in the
words that refusal came in.

When somebody's work is finished, press **Leave** on their panel. It is the far end of a handover:
the session is asked, in words, through the same queue, to write `work/<Name>/STATE.md` one last
time — what was done and how it ended — and then the desk and the panel are filed away together
under `archive/<day>-<Name>-<what the desk ended up on>/`, and the name is free again.

    the chat: Mike asked Paul to leave. Paul is writing work/Paul/STATE.md one last time.
    Paul: Desk written. The meter reads 41,208.
    the chat: Paul has left. The desk and this conversation are filed under
              archive/2026-05-04-Paul-reading-the-water-meter.

The order inside that turn is the whole of what makes the record true. The session is asked first
and the desk is read for its title only after the answer, or a session that says what it ended up
on in that very turn would be filed under what it used to be on. And the line saying it has left is
written to the panel before the panel is moved, so what is filed ends at the moment it ends at. A
desk that never said what it was on is filed under the day and the name alone; a guess in a
directory name is a guess somebody has to live with afterwards.

What is filed is what a person would want to read: the desk as the session last wrote it, and the
whole conversation. Not the thread id, which points at a conversation that has been ended. Not the
persona, which is the worker template with a name written into it — reproducible, and naming
somebody who does not work here any more. Nothing in this code ever reads an archive back; it is
files for a person, which is why nothing here promises them a shape.

The archive sits beside `work/` rather than inside it. The directories under `work/` **are** the
roster — there is nothing else to register and nothing that can disagree with what is on disk —
so a directory in there is somebody who works here, with a panel, a row in the room and a name
the `say` tool will accept.

The name is free by construction: no desk, no conversation, no persona and no rule are left under
it, so hiring it again starts on nothing. Two doors are shut behind that. Hiring refuses a name
whose conversation is still there, as above. And a message that arrived while the leave turn was
running is refused when its turn comes rather than answered — it would otherwise open a thread and
a panel under a name that had just been given up, which is the same bug coming back through the
queue instead of through hiring.

The lead has no **Leave**. An instance has a lead by definition and this page is hosted by it, so a
lead that left would still be here with nowhere to read what it was doing. The route refuses it as
well, which is what makes it true rather than merely unoffered.

Both buttons load the page again when they work. Who works here is settled once, at load, from the
rows the room is built from, so loading again is the honest way to show it has changed — one rule
and one line, against a panel lifecycle nobody has asked for.

None of the page itself is covered by a browser: no suite runs `page.html`. What the routes do is
checked on their own data, and the page is checked as text on the served body — that each thing is
offered, and that it goes to the route behind it.

### Who has gone quiet

The room is deliberately never carried into a turn: a snapshot of it handed to a session would be
read as now, and it is stale the moment it is composed. There is one exception, and this is it.

When a turn of the lead's begins, any session that has stopped for more than half the hour after
which a conversation is ended is named to it, unasked, in one block:

    Ann last ran 35m ago, and Ivy last ran 50m ago. That is how long each has been doing
    nothing, read at 14:07, as this turn began.

It says who is speaking — the chat, and nobody at the page — because an update ships new templates
and re-renders nobody's persona, so a session reading it may be running one written before any of
this existed and has nothing to look it up in. It carries the moment it was read, which is what
makes it safe to hand over unasked at all: a dated line cannot be mistaken for the room now. And it
is absent entirely while nobody has stopped, rather than saying so — a sentence in every turn
forever is a sentence nobody reads.

It is a reading and not a gate. Nothing consults it before delivering a message, hiring, handing a
session over or queueing anything, and a message to a session named in it is delivered exactly as
any other. No state is added to the room for it either; the phrases above are the whole list.

Only the lead is told, and it is never told about itself or about anything mid-turn. That is one
rule and not two: the block is composed inside the reader's own turn, so a session with a turn
going is excluded by the same test that excludes everyone else who is working.

The half-hour is read from the hour rather than written down again, so the day one moves the other
moves with it. A session that has gone cold stays in the block — it is not capped, because a
conversation named at 55 minutes and dropped at 61 would stop being mentioned at the moment it
became expensive. A session with no thread is not in it at all: it has nothing to be quiet with,
and nothing that waiting could cost it.

Nothing here has to be cleared and nothing remembers having said it. Acting on it is what stops
it: saying anything to that session starts a run and moves its clock, and handing it over removes
the conversation altogether.

### Where the account stands

The other thing handed to the lead unasked, and the only one this toolkit has an opinion about.

Every run is told how full the account's usage windows are, and every row on the page shows it. Once
the five-hour window is past nine tenths, the lead is also told so where its own turn begins:

    The five-hour usage window was 91% full when Otto last ran, read 4m ago, as this turn
    began at 14:07.

    Plan what is left wisely: finish what is in flight, start no new front and take nobody
    new on until that window has lifted.

Past ninety-five per cent it says to stop instead, and which way to put people down. That choice is
the whole reason this exists, because the two ways cost very different things: pausing a session
leaves its conversation where it stands and costs nothing to undo, while parking one ends the
conversation and is paid for in whatever it worked out and never wrote to its desk. So the block
reads the moment the window lifts against the hour after which a conversation here is ended anyway
— the same hour, read from the same place — and says one of three things. If it lifts inside that
hour: pause everybody where they are, because their conversations will still be there. If it lifts
later: park everybody, the lead included, and start fresh on the desks afterwards. If the service
did not say when it lifts: stop, and go and find that out before choosing.

**Why it is pushed at all**, when the room deliberately never is: the turn in which the lead would
have asked is the turn that gets refused. Once nothing can run, nothing can go and look either, so a
reading nobody is handed until they think to want it is no use for a condition whose arrival is what
stops them thinking. Every property that earns the exception is the same as the block above it. It
carries the reading's age *and* the moment the turn began, because "read 4m ago" has nothing to
measure from on its own. It says who is speaking. It is absent entirely while nothing applies. And
it goes only to the lead, because a worker has one task, while what the whole workspace does about a
window that is filling up is the lead's.

**The window is named.** The rule is about the five-hour one, and the five-hour one is matched by
name — which is the one place in this toolkit that writes a service's name for a window into the
code. It is deliberate, and it is because five per cent of a week is a working day: the same
sentences said of a seven-day window would stop the workspace for something that is not an
emergency. If the service ever renames that window, nothing matches, the block says nothing, and the
rows go on naming every window the service names. It fails silent rather than wrong.

A second window is named only when it too is past ninety-five per cent, and only as a fact with
nothing to do about it attached. It is there for the one case where the advice above would otherwise
be wrong — *pause everybody, it lifts in twenty minutes* is false while a week nobody mentioned is
what is actually refusing. What to do about a full week is not a rule anybody has decided, and this
does not invent one.

The reading picked is the freshest, not the fullest. One account, many sessions, many readings of
many ages: the most recent is the only one that describes the account now, and the largest of them
may be off a window that ended hours ago. A window whose lift has already passed is dropped
entirely, because ninety-six per cent of a window that has reset is nothing.

And it is a reading, never a gate. Nothing consults it before delivering a message, hiring, handing
a session over or queueing anything; a worker asked something while the account is nearly gone
answers exactly as usual. The lead decides and the lead acts — including with the turns it needs in
order to act. Nothing here has to be cleared: the work stops, the account fills no further, and when
the window lifts the block is gone.

### Taking the room off

Beside the room heading there is one button: **Go offline**, and once it is pressed, **Go online**.
While the room is off, nothing new is run for anybody.

It exists because of a measured morning. A workspace its owner believed was off was re-entered
hours later by something armed inside it, and paid the whole of a large conversation again at write
price to say nothing. What went wrong was not the stopping. It was that "off" had been the end of a
handshake — a session was asked to write its desk and stop, the model service refused that run, and
the intent went down with the refusal — so the room was neither on nor off, and nothing said which.

So this is a switch, not an agreement. Taking the room off runs nothing, asks nobody and cannot be
turned away; bringing it back runs nothing either. Neither press has a condition on it, which is
what makes it impossible to leave the room half off. An exit that some state does not have is not
an exit, so this one has no state to check.

The gate is on *starting* a run, and on nothing else. A turn already going is left alone and
answers as it would have; the switch was thrown across it and nothing happened, because nothing
should. What is turned away is a message, a **Hand over** and a **Leave** — one rule with no
exceptions, because a session asked to hand over is a session asked to think, which is a run. Each
is refused in its own words, saying what was *not* done: the conversation is untouched, the desk is
still open, nothing was filed and nothing was lost. A handover that could not be run never reports
that it happened.

What stays open is everything that ends something rather than starting it, and everything that
touches no conversation at all. A run that is already stopped waiting to be allowed a tool can
still be answered, a run can still be ended, and somebody can still be hired. Ending a run while
the room is off is the point of being able to press it.

Refusal comes back before the queue, not from inside it. A message that joined the queue and was
refused at the front would wait for whatever was ahead of it, and "the room is off" is the one
answer that has no reason to wait for anything.

The room says so itself, above the rows and never on one — on the page, in `ovai room`, and to the
lead, which is the reader most likely to be turned away next:

    The room is offline — nothing new will be started until it is brought back online.
    Paul — worker (haiku) — reading the water meter — idle · 24,479 tokens · last moved 4m ago
    Ann  — worker (haiku) — writing the install notes — idle · 8,102 tokens · last moved 9m ago

Whether the room will start anything is a fact about the room. It is not a state any of those
sessions is in, and the same word on every row would read as one.

The switch lives in the running chat and nowhere else, for the same reason the queue does: nothing
about taking the room off stops the chat, and a chat that is not running starts nothing to gate.
There is no file to leave behind and disagree with, and so no way for a room to be confidently
wrong about whether it was off.

There is no `ovai offline`. Taking the room off is a person's decision about the whole instance, and
it stays on the page, beside the button that brings it back.

### What the workspace has learned

A desk is one task and goes away with it. A conversation is shorter still. So an instance keeps one
thing that outlives both: what a session worked out that the next person would otherwise work out
again — how something here works, a trap, a decision and the argument that took it.

It is Claude Code's own memory, kept inside the instance's own Claude Code home. That is a
deliberate choice rather than a shortcut. Measured on a real run: a session reads that memory before
it is asked anything, with nothing granted and nothing in the turn spent asking it to look; and
writing to it takes a `Write` and no permission an instance has to grant, while an ordinary write
in the same run is refused. A directory of our own beside `work/` would have needed a grant to be
written and a sentence in every turn to be read — a second answer to one question, read worse than
the answer already there.

Two things make it real, because the mechanism alone had been sitting unused:

- **An instance files it under one name.** Left alone, Claude Code names the directory it keeps a
  workspace's transcripts and memory in after the absolute directory a session was started in — and
  every session here starts in the instance root. A workspace that was moved would look for its
  threads and everything it had learned under the path it used to sit at. So the name is fixed, and
  an instance that is moved or copied is still itself, which is the promise it makes everywhere
  else.
- **A turn asks for it.** A field named in the turn gets written; the same words in a persona alone
  do not. That is settled here on the desk header title, twice, on real runs. So the handover and
  the leave — the two moments a thread is about to take what a session worked out with it — each
  ask for it in as many words. Not every turn: the title ask can ride on every turn because it
  stops the moment the field is filled, and "have you learned anything" has no such condition.

An instance ships the index, `MEMORY.md`, rather than leaving one to grow. A session asked to
remember something and finding nothing there writes whatever shape occurs to it, and every session
after that reads that shape as the workspace's own — measured, and what came out was a bare pointer
line with no heading. The shipped index says what belongs there, that it is an index and each fact
belongs in a file beside it, and that what is written should say what it assumes.

`bin/ovai status` names the directory, because it is inside the Claude Code home and is otherwise the
one part of an instance nobody would think to look in.

Both personas say the difference in a line: the desk is this task, the memory is the workspace.

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

Either way `CLAUDE_CONFIG_DIR` is the instance's own directory, so transcripts, memory and
settings stay separate. Only the account is shared, and only when you ask for it.

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

It asks GitHub for the latest release of the toolkit, and if that is not the version this instance
is on, it takes it:

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

**Everything a workspace has accumulated is left alone.** Desks under `work/`, the personas the
sessions here are running, the panels and threads under `chat/`, `openovai.json`, the Claude Code home
with everything the workspace has learned in it — an update does not read them and does not write
them. Nothing is re-keyed, nothing is migrated, and no name changes hands. The payload is the only
thing that moves, and nothing inside an instance ever writes there.

**The payload is replaced, not merged.** A file a newer version dropped has to go, or the instance
stops being a copy of any version and becomes the union of two. There is no rollback and no backup:
what is at risk is precisely the copy that was being replaced, and taking the release again is the
fix.

**It refuses to run while the chat is answering.** Stop the chat first. Replacing the code a running
server is executing is the one way to get a mixed instance, and refusing removes that case rather
than trying to handle it.

**Versions are compared for equality, not for order.** GitHub's latest release is the authority: the
same version means there is nothing to do, a different one means take it. So going back to an older
release is a release like any other, and the toolkit never has to have an opinion about which of two
versions is newer.

**An update does not re-render anybody's persona.** A persona is rendered once, when a session is
hired, and it is part of what the workspace has accumulated rather than part of what the toolkit
ships. So new templates change nothing for the sessions already here: everybody hired after the
update gets the new instructions, and everybody hired before goes on running the old ones. Their
threads carry those instructions anyway, so rewriting the files would not have reached them.

### The lead is told, and what "at once" honestly means

An update stops the chat and puts a new toolkit under it. So the lead is told by the chat, from a
note the update leaves behind: one line on the lead's panel,

    the chat: the toolkit was updated from 0.1.0 to 0.2.0. What the release says changed: …

and the same thing to the lead's session, in front of whatever it is asked next:

    <update from="0.1.0" to="0.2.0">…</update>

Both halves, for the same reason an overheard line takes both: a panel is what a person reads and a
thread is what a session resumes.

The wrapper explains itself rather than relying on the persona, because the persona is the one thing
an update deliberately did not replace. It says that the chat is speaking and not the human, what
was replaced, what was left alone, what the release said changed, and that nobody else in the
workspace has been told. That last part is the point of telling the lead at all: the lead is what
tells everybody else, and the sessions already at work were hired under the arrangement before this
one.

**"At once" means this, and no more:** the lead is told in front of the very next thing it is asked,
and never later than that. It is not told while it is idle, because there is no way to hand a
session something without asking it a question. A lead that is never spoken to again is never told —
and it also never tells a worker anything, so nothing wrong is said on the strength of it. That is
the limit, and this does not close it.

What the release says is a file called `NOTES.md` at the root of the repository, written for the
lead of a workspace taking the release rather than for a developer reading a changelog. It keeps
a section per release and it is not part of the payload: it describes a release, not an instance.

## What to build first

- **Personas** — the system prompts that make a session a lead or a worker.
- **Launchers** — start a lead or hire a worker, assign a name, create the desk.
- **Hooks** — to keep session names, the roster and the desks consistent.
- **Skills** — the repeatable procedures, handover first among them.
- **Chat page** — it hosts every session now, one panel each: sessions speak to each other
  through it, it approves what a session asks to do, it shows the room, and it hires and retires.
  Still to come: something worth looking at, and a way to read an archive back.

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
