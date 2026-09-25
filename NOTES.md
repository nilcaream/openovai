# What changed

For the Leader of a workspace taking this version. Short, and about what is different for the people
working there — not a developer changelog. A section per release, newest first; a release page
carries only its own.

## 0.19.0

**The Leader stops and restarts Workers; a Worker only works.** A Worker no longer has
`stop_session` or `restart_session`, and is no longer told of its context or asked to stop itself.
All of that is the Leader's now:

- `stop_worker` and `restart_worker` close one Worker. It is told its session is closing, writes
  its desk, and goes when that turn is over; a restart starts its successor on the desk. With
  `interrupt`, the turn it is on is cut first. Both answer at once, and the Leader hears the
  outcome as a `stopped` event: why is stop, stop-deadline, restart, idle, idle-forced or quota.
  A desk not written within the deadline (5 minutes after an interrupt, the park deadline
  otherwise, or the one given) is taken as it was last written.
- A Worker's context reaches the Leader, not the Worker, as a `context` event naming the Worker —
  at the warning size and at the error size only. At the error size the Leader restarts it with
  `restart_worker` at a moment that suits the work.
- That size is measured at every request of a turn, so a long turn is told when it passes a size.
- `message` takes `urgent`, the Leader's only: it reaches a Worker mid-turn, at its next tool call.
- A Worker says it is done with the new `done` tool, with a one-line note if it likes. The Leader
  gets a `done` event and decides whether it stops. The report still goes as a message.
- The Leader's own session is unchanged: it still ends and restarts itself.
- When a usage window that reached a stage resets, the Leader gets a `quota-reset` event with the
  window, and the model when it is one model's own; a stopped Leader is started by it, to bring
  back the Workers that stopped on the window. A park forgets the resets to come, and a server
  restart before the reset loses them.
- `hire` with a model on a desk a Worker had now runs it on that model and keeps it for the desk
  from then on; without a model, the desk's own stands as before.
- Every row a panel shows from the Server starts with a capital letter — `Waited 40 seconds for
  permission: …`, `Limit exhausted (5-hour window) …`, `Stopped; nothing waiting`, `No turn to
  stop` — and the log says the same words.
- The Leader keeps a Worker's checkpoint to itself: it tells the User nothing about it, only the
  Worker's report when that matters to them.
- The quota line in the Leader's head is current without a page open: the usage windows are read
  every 5 minutes while any session runs, and at a turn's end and a page load when the last read
  is a minute old. Its tooltip says when each window resets, each at its own time: `5h resets
  today at 12:12, 7d on Monday at 13:41, 7d fable tomorrow at 23:11`. Fable's own weekly window,
  which only this read carries, now reaches the quota gate with no page open too; before, a fable
  Worker could not be held at that window while nobody was looking.
- Text the page and the terminal show spells its units out where there is room: `Waited 233
  seconds for permission: …`, `delivered 13:42 ✓ — 12 seconds after`, `The hire tool took 12.3
  seconds`, `Limit exhausted (7-day fable window) …`, and `ovai stop`'s `Stopped (sessions gone
  after 1.4 seconds).` Where room is tight they stay short: the quota line and the context size in
  a panel's head.

**A Worker's session is closed for it, and never in the middle of a step.** When a Worker has to
end — idle at 55 minutes, its usage window spent, the room parking — the server tells it one thing,
`closing`, with why. The Worker writes its desk, and the session ends when that turn is over:

- The close is read at the start of a turn of its own. It never goes into a turn already under way,
  and a line you type while it waits goes in with it, behind it.
- The session ends when the turn that wrote the desk is over, not at the desk write, so whatever the
  Worker does after its desk in that turn is done before it goes. A later message does not take a
  close back; a word to an idle Worker still does, since that is what it was waiting for.
- A close that waits too long for its desk ends with the desk as it was last written. The deadline
  counts from the turn that read the close, and never ends a turn that is running. Idle and a spent
  window give the desk 5 minutes; a park keeps its own deadline.
- A close whose turn is refused by the service ends at once, since no turn is left to write a desk
  in.

**A Worker the service refuses no longer sits there looking well.** A turn can come back from the
service refused: a model this Claude Code does not have, a sign-in missing, the service down.
Every time that happens, the service's own words go in the log as a `died` row. From there:

- If it is the Worker's very first turn, the Worker has never worked and cannot. It is ended at
  once, and the Leader is told why in the service's own words, through the `stopped` event with
  why="first-turn-failed".
- If the Worker has worked before, it keeps running, since the failure may pass. The Leader is told
  once, through the new `died` event, and is not told again until the Worker has answered a turn.
- A refused turn does not count as activity. A Worker whose every turn is refused still reaches the
  idle ending instead of sitting until somebody notices.

**No card for a backtick in an otherwise allowed command.** A grep whose double-quoted pattern held a
backtick or `$(` stopped on a card even with grep allowed, because Claude Code reads the span as a
program hidden in the line.

- When every side of such a line is allowed, the hook now refuses it instead, with a reason the
  session reads: put the pattern in a file for `grep -f`, or the steps in a script on its desk.
- The session spells the command again and you are not asked.
- A line with a side the rules do not allow still asks as before.

## 0.18.0

**A seat waits for you while you type to it.** When something arrives for a seat — a Worker's
message, a server event — while you are typing in that seat's box, the seat does not start on it
straight away: it waits until you send your line or stop typing, so what you were about to say goes
in with it instead of landing behind a turn spent on something else.

What is held, and what is not:

- Only a turn made of Worker messages and server events, and only before it begins. A turn already
  under way runs on: the server cannot pause a session between its own tool calls.
- Your own line is never held. Pressing Enter takes whatever is waiting in with it, as one turn,
  in the order it all arrived.
- Only the seat whose box you are typing in. Every other seat carries on as before.
- A keystroke counts, text sitting in the box does not: a box you walked away from with words
  still in it holds nothing once the quiet has run out.

Two settings, under `typing` in `openovai.json`, both in seconds:

```json
"typing": { "quiet": 10, "cap": 30 }
```

- `quiet` (10) — how long after your last keystroke you still count as typing. The page tells the
  server about a keystroke at most once every two seconds, so the quiet is counted from the last
  keystroke the server heard, which can be up to two seconds before your real last one. A `quiet`
  under two seconds therefore holds only in patches.
- `cap` (30) — the longest a waiting turn is held, counted from when it started waiting (the
  moment it would otherwise have begun), however long you keep typing. Once it goes in and its turn
  ends, the next thing that arrives while you are still typing can be held again, for a fresh cap.
- `0` in either one turns the hold off. A value that is not a number, or is below 0, is taken as the
  default.
- The server reads `openovai.json` when it starts: a change takes effect at `ovai restart`.

A timeline with the defaults, on the Leader's panel:

1. **Typing, a message arrives, Enter.** You start typing at 14:00:00. At 14:00:04 a Worker's
   message arrives and the Leader, idle, does not start on it. At 14:00:09 you press Enter: your
   line and the message go in together as one turn, the message first because it arrived first.
2. **Typing stops without sending.** You type from 14:00:00 to 14:00:03 and stop, the words left in
   the box. At 14:00:04 a Worker's message arrives and is held. Ten seconds after the last
   keystroke the server heard, at about 14:00:13, it goes in on its own.
3. **Typing past the cap.** You type without a pause from 14:00:00. At 14:00:04 a Worker's message
   arrives and is held. At 14:00:34 the cap is reached and it goes in while you are still typing.
   When you send your line it reaches that turn the way any line of yours does: at the turn's next
   tool call, or after the turn if none is left.

What `runtime.log` shows, one row when a hold starts and the usual `wrote` row when it ends, with
how long it held and what ended it — `user` (your line), `quiet` or `cap`:

```
held <seat> - typing, 1 waiting
wrote <seat> - queue x2 (#41..#42: message, user), 0 waiting, after typing held 5.0s (user)
```

**A panel with no rows shows nothing.** It stays empty until the seat's first row arrives.

**A Worker writes anything longer than one command as a script on its desk.** A pipe, a chain or
a loop becomes a one-time script on the Worker's own desk, run by its interpreter, so the card you
are asked on shows one short line and the script stays there to read.

**A card offers no Always for a one-off command, and a wait row is one line.** A command longer
than 80 characters, or one holding a pipe, a chain, a redirect, a `$` or a newline, is answered
Allow or Deny: nobody keeps its whole text as a rule. The panel row saying how long a card waited
shows its first line; double-click it for the whole call.

**Your words reach the turn under way.** A line you type while a seat is working does not wait for
the turn to end: while one of the turn's calls is out, it goes into that turn and the session reads
it at its next step. With no call out it waits for the next call, or for the turn's end. The label
under a waiting line reads `queued — <name> reads it at its next step`. Worker messages and server
events still wait for the turn to end.

**A turn the session begins itself is a busy turn.** A line that reaches a session after the last
call of its turn gets a turn Claude Code begins on its own. The seat reads busy through it, and
what arrives meanwhile waits behind it. `runtime.log` names it `self-started`.

**A line you type while rows arrive says which row it answers.** The box remembers the last row
shown when you start typing into it empty. If a row arrives before you send, your line goes with a
reference to the row you were reading, spelled like a clicked stamp. A line that waited 5 seconds
or more before the session had it says so: `delivered 19:22:36 ✓ — 40 s after`.

**Every panel says when a session started and when it ended.** One row marks each start and each
end with the moment, in the machine's time zone: `2026.09.23 Wednesday 16:03:40`. Of two such rows
less than a minute apart, the page draws only the first.

**A session's question is answered on its card.** When a session calls AskUserQuestion, its card
shows each question with its options and a line for your own words, and Answer sends them back to
the session. An answer that leaves a question out is refused, and a question has no Always. A new
instance's allow list holds `AskUserQuestion`, so no permission card stands before the question.
An instance made before this version is told the rule by `ovai update`, as `allow AskUserQuestion`
among the rules its settings lack, and nothing is added for it: add it to the instance's
`.claude/settings.json` with an editor, then `ovai restart`.

**A message nobody read comes back.** A message queued for a session that ends before it reads it
goes back to its sender: a row on the sender's panel, and `<server-event type="undelivered"
to="…">` with the words as they were sent. A Leader that is not running is started by it. A line
of yours that was never read shows as not delivered on the panel you typed it on. A server event
for the Leader that asks nothing, queued while the Leader was ending, goes once more to the Leader
that comes next — never while the server stops or the room parks.

**Secrets are masked everywhere they are shown.** A secret's shape is hidden in every panel row,
in `conversation.json` and on the page alike, in `runtime.log`, and in the permission rules
admin mode reports. A permission card still shows the call exactly as the session made it: what
you approve is what runs.

**The Leader learns what admin mode changed.** When the `ovai claude` door closes, the
`admin-closed` event names what moved, by name and never by value: marketplaces, plugins and
whether each is on, skills, MCP servers by scope, claude.ai connectors, permission rules and other
settings keys. A running server tells the Leader within seconds. The first time on an instance,
the door also says that Claude Code runs its own first-launch setup, and that if it asks for an
account, you pick the one the instance is already signed in to.

**A seat runs without the claude.ai account's connectors.** MCP servers added to the claude.ai
account the instance signs in with do not reach the seats. A seat keeps the instance's own server
and whatever admin mode added. `ovai claude` is your own session and keeps them.

**A note keeps its own files in `knowledge/files/`.** A template or an image a note needs goes
there, cited by its path from `knowledge/`. `index` and `validate` do not look inside it; any
other directory under `knowledge/` is reported.

**A brief's tool budget is a checkpoint.** The Leader sets `checkpoint` on its message to a
Worker, a number of tool calls, and the server counts the Worker's own calls. When they reach it,
the Worker is told to report and carry on (`<server-event type="checkpoint">`), and the Leader is
told at the same moment. A checkpoint fires once; a new one replaces the one pending. The first
sentence of a brief reads "Report after N tool calls", with N sized for the round.

**The margin `ovai stop` allows is a setting.** `park.margin` in `openovai.json`, in seconds (15),
is how long past the park's timeout `ovai stop` waits for the sessions to finish.

**Stopping the server waits for the Leader too.** A server stop parks the room with the Leader in
it, and waits for the Leader to call `stop_session` just as it waits for the Workers, on the same
deadline; whoever has not stopped by then is ended with its desk as it is.

**A Worker ends its turn with no text once its report is sent.** Its panel shows the message
going out, and the Leader's panel shows it arriving.

**`write_desk` names each fault.** A status asked for at 80 characters is refused only above 100,
and a title asked for at 120 only above 150. A refusal names what is wrong: empty, a newline, a `|`
in the status, or how long the line was against the length asked for.

## 0.17.0

**A door to Claude Code's own commands: `ovai claude`.** There is no screen here for connectors,
plugins or marketplaces, and there will not be one. Instead the instance opens a real Claude Code
session on itself, at your terminal, with its configuration around it — so `/mcp`, `/plugin` and
whatever Claude Code gains next work here the day they ship, and write this instance's account
rather than your own. That session is not a seat: no desk, no name in the room, no way to speak to
anybody here, and every question it has it asks you, where you are sitting. It is told what it can
reach, who reads each of those things, and what changes if it writes to one. Quit it when you are
done. A seat reads its configuration when it starts, so nothing you changed is live for the people
working here until `ovai restart` — which interrupts whatever they are mid-way through, and is
yours to ask for rather than something the door does on its own.

**A session is told how much room is left, not that it is over.** There was one size — 160,000
tokens — and a session that passed it was told once, in words that read as an order to stop there
and then, though nothing here ever stopped it. There are three sizes now, under `context` in the
instance's configuration: `warning` (200,000), `step` (20,000) and `error` (300,000). The event
arrives when the conversation as sent passes the warning size, and again at every step above it —
220,000, 240,000, and on — carrying the size reached and all three sizes, so a session can see what
it is counting toward. Below the error size it says to carry on and plan its own restart; from the
error size it says to wrap up and restart as soon as it can, and the stepping goes on above that,
with the instruction changed and nothing else. Nothing is enforced at any size: when a session
restarts stays the session's own decision. The event is `context` with `stage="warning"` or
`stage="error"`, in place of `context-full`, and `context.ceiling` is gone — an instance that set
it sets the three sizes instead. The warning asks nothing of the session, and an event that asks
nothing no longer cancels an ending the server is already waiting on: a seat told at 55 minutes to
write its desk and stop is still ended at 60, whatever else the server tells it in between.

**What a session starts ends with the session.** Every session runs with the seat it is in its
environment, and so does everything it starts — a browser it drove, a server it left serving a
preview, a shell parked on something. When the session's process is gone, whatever it started and
did not end is ended with it, and the log says which seat left what. A Worker's own instructions
say the same in a sentence: a long run is a call you wait on, not a process left behind.

**The log says what became of the sessions, not only what they did.** `runtime.log` had a seat's
stop and never its start. It now says when a Worker was hired — what it runs on, and whether the
desk was new or one it had — and when a desk was filed away, with the model that round ran on and
where the desk went. A restart says how full the session that restarted was, in tokens, so "it
filled up" is a number that can be checked rather than a story. And every time the account's usage
crosses a threshold, the log says which window, the percentage it stood at, when it resets, and the
model when the window is one model's own — until now that was told to the sessions and to nobody
else. A day can be read back from the file.

**A stop no longer waits on what is not a session.** `ovai stop` waits for the sessions and
nothing else, and `ovai update` refuses only for a session — a process that is running the code an
update replaces. Anything else a seat left running is named by the seat that left it, with what it
is and one line that ends all of them, and the update goes on.

**What you add to a persona is three files, and a session can see where each line came from.**
`customization/` takes a third file beside `leader.md` and `worker.md`: `common.md`, what every
session here is given. Each one that is there arrives after the instructions in a frame naming the
file it came from — `<customization source="customization/common.md">` — with the content between
the tags exactly as you left it: nothing trimmed, nothing re-wrapped, and a file that is there and
empty is an empty frame rather than no frame at all. A file that is not there is no frame and no
error, so an instance with none of them reads exactly as it did. The common file comes first and
the role's own under it. A Leader is given the Worker's file as well as its own, marked
`for="worker"`, so that it knows what every Worker already holds and briefs the task rather than
the method; a Worker is never given the Leader's. Both templates now say what a frame is, what
shape a line has — numbered, one thing per line, a mark such as `(User, 2026-09-22)` on the ones
you set — and the one test for where a line belongs: a line that can be obeyed or broken is
customization, a line that is true or false is not. A change to any of these files reaches
sessions started after it and no others. And a fresh instance is born asking about that change:
`Edit(/customization/**)` goes in the settings' `ask` list, so a session that would rewrite one of
these files stops for your press — every seat, the Leader with the rest, since one settings file
serves them all. An instance made before this version is told the rule it has not got, the way it
is told about any other, and nothing is added to its settings for it.

**What the workspace knows is a directory you can read.** `knowledge/` sits at the root of a fresh
instance, empty, and fills with Markdown notes — one topic per file, facts only, written and edited
by every session with the ordinary file tools. A note opens with four fields and nothing else: a
`summary` line, at least three `tags`, the `sources` it came from, and the date it was `updated`.
There is no id, no status and no expiry, because a wrong note is edited and a dead one deleted.
Two tools read it, and neither keeps anything of its own — both are built from the files every time
they are called, so a note changed a moment ago is the note the next call sees. `index()` gives the
header: how many notes there are, when the directory last changed, every tag with its count, and
any file it could not read. `index(tags)` lists the notes carrying a tag, the ones carrying more of
what was asked first; it matches on tags and never on filenames or summaries, so a search means
what somebody decided when they wrote the note, and words are what grep is for. `validate` checks
the whole directory against those rules and answers with one line per problem, each saying the rule
it breaks, so a session can fix what it wrote without going to find the contract. Every seat may
write here — `Edit(/knowledge/**)` is in the settings a fresh instance is born with, and an
instance made before this version is told the rule the way it is told about any other. One note is
the framework's business: `knowledge/common.md` is handed to every session at its start, after your
customization files, in a frame naming it — `<knowledge source="knowledge/common.md">`. It is an
ordinary note otherwise, and it is the Leader's to gather: the team, the business, the lingo, where
things are, and which notes a newcomer reads first. Because it is handed to every session, the
settings a fresh instance is born with ask before it changes: `Edit(/knowledge/common.md)` is in
the `ask` list beside the customization rule, so a session that would rewrite that one file stops
for your press while the rest of `knowledge/` stays open to write. An instance made before this
version is told the rule the way it is told about any other. No file, no frame, no error — a
workspace that has learnt nothing yet reads exactly as it did.

**The store is gone, and what it held is `knowledge/` and your own instructions.** `recall` and
`remember` are no longer served, `store/` is no longer made, and no session is given a numbered set
of hard rules at the end of its instructions. What the workspace knows is the directory above, read
and written with the file tools every session already has; what the team is held to is
`customization/`, in your words, where you can read it. Nothing on disk is touched: an instance
that has a `store/` keeps it, every file in it, and the toolkit simply stops looking — delete it
yourself once you are satisfied, or leave it where it is. Two things follow that are worth knowing
before you take this version. A desk header no longer carries the rule set its session was started
under; a desk that has one is read and rewritten without it, and not a line of the body moves. And
a session already running can no longer be handed a change to its standing instructions — the
hard-rules update was the one frame that did that. A change to `customization/` or to
`knowledge/common.md` reaches the sessions started after it and no others, so when something has to
reach a session that is running, tell it in words, or stop the seat and hire it again.

**A session that restarts picks its own work back up.** A session is moved by a frame and by
nothing else, and a restart was the one start with nobody to write one: a hired Worker turns
because the Leader speaks to it, the Leader turns because something was addressed to it, and a
successor had neither — so it sat on its desk, its work written down in front of it, until
somebody happened to say something to it. The server now writes that first turn itself.
`<server-event type="restarted">` is the successor's first frame, behind whatever was waiting for
the seat and in the same turn as it: you are the session after a restart, your desk is the whole
of what the one before you left, go on from what it says to do next and never redo what it says
is done. Nothing is announced, nothing is asked of anybody, and a successor with nothing left in
flight says nothing at all. Both roles restart this way. Nothing the predecessor left is lost,
reordered or rewritten: what was queued for the seat still goes in first, in the order it
arrived. And a Worker about to restart no longer sends its Leader a line to say so: that message
cost the Leader a turn at full context and bought nothing, now that the successor picks the work
up by itself and the restart is in the log with the context it carried. A fact about a seat
belongs in the log; a message is for something somebody has to act on. What a session says on
its own panel before it goes — "back in a moment" — stays: that is for the person watching the
window.

**The Leader is told that admin mode ran.** `ovai claude` opens a Claude Code session on this
instance's own configuration, and it used to close with nobody the wiser. It now leaves a record at
the instance root, beside `runtime.json`: when the session ended, and which of the four
configuration files it watches changed — the account's settings and the account's own record of
servers, the permission rules every seat in this instance obeys, and the project's MCP file — by
name, and nothing of what is in them. At its next start the server hands that to the Leader as
`<server-event type="admin-closed">` and removes the record; a Worker is never told, and nothing is
asked of anybody. The telling is the server's and never the admin session's, which has no connector
and is not given one. Not a route on the running server, because a route fails exactly when nothing
is running, which is when admin work is likeliest — and the wait costs nothing, since a seat reads
its configuration when it starts: what was changed reaches the seats at the same start that carries
the notice.

**A newer Claude Code.** This version pins Claude Code 2.1.280, where the last pinned 2.1.278; the
node it brings is the one it brought before. An instance takes the new one the way it takes any
other change to the toolkit — `ovai update`, and the sessions started after it run on it.

## 0.16.0

The toolkit brings its own Node.js and Claude Code, one `openovai` command installs an instance from
any release and asks for what it was not told, `permission` settles every rule Claude Code reads, a
desk is edited in place, and a turn is one queue in arrival order. The page keeps its cards, its
tool line, its columns and its scroll where they belong.

**Nothing of the machine's own is needed but a shell.** Each release pins the exact Node.js and
Claude Code it runs on, in lib/RUNTIME, and fetches them itself: the node archive from nodejs.org,
verified against the checksums published beside it, and Claude Code installed with that node's own
npm, both under `~/.local/share/openovai` (`$XDG_DATA_HOME/openovai` when set), shared by every
instance of the user's, about half a gigabyte, once. Nothing is taken from the PATH, nothing needs
sudo, and no instance runs on a node or a claude the machine happens to have. Claude Code's own
background updater is off for every session: a newer Claude Code reaches an instance with the next
release, not on its own. `ovai` and the installer are POSIX sh and need sh, curl or wget, tar,
sha256sum and uname, on Linux x86_64 or arm64. An update fetches the new release's runtimes after
the swap, so the first start after it waits for nothing; a fetch that fails leaves the release in
place and says what fetches it again. `ovai configuration` has a `runtime` row: the pinned versions
and the data directory. When the chat cannot start a Leader, the refusal says what is missing,
where it was looked for and the two commands that fetch it.

**One `openovai` command, once per user.** `curl -fsSL …/main/openovai | sh` installs the command
under `~/.local/share/openovai` and links it at `~/.local/bin/openovai`, printing the line to add to
the shell profile when that directory is not on the PATH and never editing one. Run, it says which
release it resolved — the newest on GitHub, or the one named as `openovai 0.16.0` — downloads that
release once, and hands over to that release's own installer with every other option unchanged.
With nothing said and a terminal to ask on, it asks the one question that is its own: the newest,
or a version already fetched.

**The installer asks for what it was not told.** On a terminal, each option the command line left
off — where the instance lives, who it works for, the Leader's name, the models, the port, how it
signs in — is asked for, one line each, Enter taking the default where there is one; an option
typed on the command line is never asked again, and an instance installed over is asked nothing it
already knows. Off a terminal nothing is asked, and what is missing is refused as before.

**`permission` settles every rule Claude Code reads.** The Leader's `permission` tool accepts every
rule shape Claude Code itself reads from a settings file, and refuses the shapes Claude Code skips:
an exact Bash command or a `Bash(word:*)` prefix; `Edit` and `Read` on a `/dir/**` under the
instance root, and Read on an absolute path outside it as `//abs/**`; `WebFetch` bare or
`domain:host`; `WebSearch`; an MCP server, one of its tools, or a prefix of them; `Agent(Name)` and
any bare tool name. The card carries the rule Claude Code suggests for the call — for a Bash call
the exact command, for a fetch the domain — so the Leader settles a rule with what is already on
the card.

**A desk is edited in place.** `desks/<Name>/STATE.md` is a file like any other: its body is edited
with the file tools, line by line, and the server owns the header line alone. `write_desk` takes
the title and the status, rewrites that line and leaves everything below it as it stands. The gate
at the end of a session is unchanged: `restart_session` and `stop_session` refuse until
`write_desk` was called since the event that asked. A fresh instance is no longer born with a rule
denying Edit on the desks; an instance updated from an earlier version still has that rule, and
the update lists it — withdraw it by hand, the update removes nothing.

**A turn is one queue, in arrival order.** Everything a seat is handed for one turn is one
`<queue>` element: the frames as they arrived, each with the time it arrived, the envelope there
also for one item. The User's line no longer goes ahead of what arrived before it. The persona says
it in one sentence, with the example.

**A card stays up while another is pressed.** A press on a rule card starts a turn of the Leader's,
and every rule card used to hide while a turn ran: pressing one with others standing took them all
down until that turn ended, then drew the rest again. A rule card now knows the turn that raised
it, and the panel keeps every card raised earlier while a later turn runs.

**The Leader's tool line can be read.** Every word on the line above the Leader's pill —
"Thinking…", the call it has out — stays up half a second before the next replaces it; a word that
repeats the one showing is not queued, and the line trails the seat by at most a second and a half.
And a Leader call that stopped on a card no longer leaves a row on the panel: the tool line says it
while the card stands, and the wait row names it once answered.

**A Worker back after a while goes to its own column.** A Worker whose panel had gone — its process
stopped for thirty seconds, or its seat gone from the room — and came back was placed on both sides
at once and drawn on the right; three such Workers all went right and the left column stood empty.
A panel that goes takes its place in the order with it, and the sides alternate over the panels
that are there.

**A panel follows its newest row until a hand moves it away.** A panel that followed its rows used
to stop following when a tall row landed. Now only a hand — a wheel up, an up key, a finger moving
down the screen, the bar dragged up — lets a panel go, and at the newest row again, however it got
there, a panel follows. And one long unbreakable token — a URL, a path — no longer scrolls the
whole page sideways: a plain row's body wraps anywhere, as the markdown body did already.

**The README is what is read before cloning.** The documentation is at openov.ai; the README keeps
the first paragraph, the status, the quick start through `openovai`, the idea, the requirements and
the instance root. This file says what each release changed.

## 0.15.0

The browser tells you when a page you are not looking at needs you, the desktop pop is gone, the
log is one writer in fixed columns, the Leader files a stopped Worker's desk away, and an update
no longer pulls bin/ out from under the shell that ran it.

**The browser notifies you while the page is not visible.** A card appearing on any panel and the
Leader's reply arriving each reach you through the browser's own notifications — never while the
page is visible, never without the browser's permission. Two icon buttons on the Leader's head
beside the theme toggle switch them: an exclamation mark in a circle for `<name> requires your
action`, a bell for `<name> finished their turn`, lit while on and slashed while off, each with a
tooltip saying which way it is and what a click does. Both start off; a click that turns one on
asks the browser from the click and lights the switch only once the browser granted — refused or
dismissed leaves it off, so a switch never claims what the browser will not do. The notification's
tag is the seat, so a burst on one panel replaces its own rather than stacking; a click brings the
page to the front and the panel into view. No sound of the page's own.

**The desktop pop is gone.** The server no longer pops a notification of its own on the machine,
and the `quietHours` setting in openovai.json goes with it. The browser notification above is
what reaches you away from the page.

**The tab says what is asking with its icon, not its title.** The tab title is the product and the
instance, whatever is asking; the mark in front of it is gone. While any panel asks, the tab's
icon is the same mark with a ring in the page's warn colour, and the plain one otherwise. The
icons' ground is brighter, and an installed app's icon does not blink: the manifest lists the
plain icons alone.

**The Leader's panel says what it is at.** While the Leader's turn runs, one line above the pill
reads "Thinking…", then the call it has out, worded as a Worker's line would be, then "Thinking…"
again once the result is back; it is gone when the turn ends. One element changed in place, held
to one line, so the rows never jump for it. A page opened mid-turn draws it too.

**The Leader files a stopped Worker's desk away.** A `retire` tool beside `hire`, the Leader's
alone: desks/<Name>/ goes whole under archive/<day>-<Name>-<slug of the final title>/, the rules
that made the directory the Worker's are withdrawn, and the name is free to hire again. Refused: a
name that is not one, the Leader's own, a name with no desk, a Worker still running (stop it
first), the server stopping. The seat leaves the room and the page by itself, no reload.

**runtime.log has fixed columns and one writer.** Every row is the local time with milliseconds
and offset, the event, the seat or `-`, the tool call id or `-`, and the text; a text of several
lines is that many rows with the same columns. The pid, host, user and version are on the started
row, once; no row carries a level. The called, tool and failed rows of one call share its full
tool name and id, and a failure is on the log before the call is closed. A seat's process closing
is one row, `stopped <seat> - <why>` — stop, restart, idle, park, idle-forced, park-deadline, or
the exit it ended on (`exit 1`, `SIGKILL`) — and the last row of a run parked by signal is
`stopped - - SIGTERM`. Nothing is written through the console any more.

**A message that opens with a block folds.** A message between sessions whose markdown opens with
a table, a list, a code block, a heading, a quote or a rule used to draw whole and would not fold;
it now folds behind `(double-click to see the whole message)`, and a double click opens the whole
rendered markdown and folds it back. A folded message carries the pointer and answers a double
click only where there is more than its one line. What one Worker says to another is drawn and
folded like any message to or from a session.

**A following panel stays pinned on a tool line.** A panel that follows its newest row is pinned on
any row that lands — a bubble, a pill, a tool line, a counter that grew. A draw that brought tool
lines alone used to leave a following panel short of its end and drop the head's mark.

**An update copies bin/ in place.** An update used to remove bin/ and put a new one in its place,
which left a shell standing inside it in a directory that no longer existed, and `./ovai start`
failing with the file right there. The files of bin/ are now copied over the old ones; the
directory itself is never touched.

**A refusal over a running session says what the session is.** Each `kill <pid>` line of an
update or stop that refuses carries the command line of the process as a comment after it, so a
session of yours can be told from a process that merely carried the instance's home; the line
still pastes. And a server started from inside a session of another instance is a session of its
own instance now: `ovai start` sets the instance's home on the server it spawns, so the other
instance's update and stop no longer refuse over it, and a stop lists the server once.

## 0.14.0

The store replaces nothing on its own judgement, a write says when it is new, and a record replaced
by mistake comes back. Nothing is configured.

**Nothing silent: a resemblance refuses, it does not replace.** A `remember` that named no
`replaces` used to be matched by a model against the records of its kind, and the one the model
judged restated, widened, narrowed or reversed was replaced there and then — the writer learned
of it from the answer, or not at all, and a whole backlog record went that way once. The match
still happens; what changed is what follows it. A text that reads as a record already held is
refused, nothing written, and the refusal names the record — its id, its text, the model's reason
— so the writer answers: `replaces: <that id>` if it agrees, `replaces: none` if the record is
new. `none` is the word for "I have read the store and this replaces nothing": the model is not
asked, and nothing is refused on a resemblance. A `reason` goes with `replaces` naming a record and
is refused without one. What a recall shows is the same as before, minus one thing: no line says
the store chose, because it never does.

**A replaced record comes back.** `remember` with `restore: <id>`, alone with the store, brings a
replaced record back live under its own id, as it was — the text, the source, the `until`, the
provenance. The record that replaced it stands: a restore is not a swap, and a text somebody wrote
over the lost one is theirs to replace or leave. The restored record's line says who restored it,
when, and what had replaced it. On disk the restore is one more file, a marker naming the record,
so the history stays what it was: nothing edited in place, nothing deleted. A hard rule is not
restored this way — two live rules with one number would be a broken set — it is written again
over the rule that holds its number; and the User's record is the Leader's to restore.

**One write at a time.** Writes to one store run in the order they arrive, each one reading the
files after the one before it has written — as they have since the store was made; said here
because the two changes above lean on it. Nothing is merged and no two writers' records are
reconciled: the second of two writes that both replace a record is refused, and its writer reads
what stands and writes again.

**The Worker panels keep their width.** A narrower window — DevTools docked at the side is enough
— takes from the Leader's panel now; the columns either side never go under 406px.

**The server signs as `Server`.** The rows the server itself writes on a panel — a wait for
permission, a stopped turn, a process gone — and the refusal a session gets from a card with no
reason on it used to be signed "the chat"; they read `Server` now.

**No tooltip on a panel.** The desk title no longer pops up over a panel under the pointer; the
desk file still has it.

**Copy a code block.** Every fenced code block on a panel has a copy button in its corner, shown
when the pointer is over the block; a click puts the block's text on the clipboard and the button
says so for a moment.

**The Leader hears what one Worker says to another.** A message from one Worker to another used to
reach the two of them and nobody else — the Leader's panel showed nothing, and the User could not
see what was said. It now lands on the Leader's panel as `<sender> → <addressee>` with the words, on
the ground a line typed on a Worker's panel has, and the Leader's next turn carries it as
`<server-event type="overheard" from="…" to="…">` — heard, not asked; nothing waits on the Leader,
and the addressee gets the message as before.

**Every panel follows its newest row, or not, on its own.** A panel scrolled to its end follows
what lands there — rows, tool lines, cards; scrolling away from the end, by wheel, bar or key,
stops that panel and no other, and it stays exactly where it was put; scrolling back to the end
makes it follow again, with nothing pressed. Typing in a panel's box, or sending, moves nothing on
a panel that is not following, and makes no panel follow: only being at the end does. The page
opens with every panel at its end. A panel used to measure itself at every draw, and a box that
had grown by a line hid the end and made it stop following. **The head shows when a panel
follows:** while a panel follows its newest row its head carries, at its left edge, the border a
clickable tool line carries, and is plain again the moment it does not.

**The bottom of a panel is one area: the cards, then the box.** A permission card used to be a row
among the rows — it scrolled with them, and one that landed while the reader was at the end
scrolled the panel to it. It now sits right above the box, on the Leader's panel and a Worker's
alike, always in sight, and its coming scrolls nothing: a panel that follows its newest row keeps
that row in view above the card, one that does not stays exactly where it was. A stack of cards
scrolls inside that area and never pushes the box out of the panel. The same holds for a box that
grows as a long line is typed: the rows give it its room, and a following panel keeps its newest
row above the box whatever the box's height. A card still leaves on a press, and the User is still
told on the Leader's panel once a Worker has waited ten minutes on one. The wait itself —
`waited 40 s for permission: …` — is said on every panel, the Leader's included. And the Leader's
panel, which draws none of its own calls as lines, draws the one that stopped on a card — `git
push`, say — where the card came, so the card is never about a call the panel does not show.

**The stop glyph never narrows the box.** The square at the right edge of the box, there while a
turn can be stopped, used to take its room from the text: a long line wrapped differently the
moment a turn began, and the empty box's sentence could switch to its short form. The glyph now
lies over the box on the box's own ground, with a thin ring of it, so the letters under it stay
readable and nothing in the box moves.

**A message between the Leader and a Worker is one line on the Leader's panel.** A `To <name>`
or `From <name>` row used to show three lines of itself, faded at the edge, with `show all` under
it, and a short one stood whole. Every one is now one line, cut with an ellipsis; a double click
on the row opens it whole, and the next folds it again — nothing folds by itself, nothing is
remembered, and a page opened again shows every one folded. The click on a Worker's line —
`Sent a message to <leader>`, `Received a message from <leader>` — still finds the row on the
Leader's panel, and now opens it and brings it to the top of the rows, its label first, so a long
message reads from its start. What the User typed, on any panel or to a Worker, and what one
Worker said to another are shown whole, as before.

**A Worker's report is read once.** A Worker that had sent its report to the Leader used to say
nearly the same thing again on its own panel, so the User read it twice. The Worker persona now
says what its panel gets once a report is sent: one line — `Reported to <leader>.` — and never the
report again; what a Worker says on its own panel is for what the User typed there.

## 0.13.0

What the User types goes in ahead of a seat's backlog, a stop says what the seat goes on to, a
wait on a card is written down, a slow call of the instance's own tools is timed and said, a frame
held at the write is said on the panel, a call whose arguments do not fit what the tool declared is
refused before the tool sees it, a turn that fails in its own words lands once, and the log
survives a restart and says what the queue did. Nothing is configured: every one of these is on
from the moment the instance takes this version.

**The User steers, on any panel.** A seat with a backlog — messages from colleagues, events from
the chat — used to work through every one of them before reading a word the User typed after
them; a Leader with several Workers reporting in could be minutes behind the panel, and a stop
only made it pick up the next old frame. A line the User types now goes ahead of everything
waiting on that seat, behind the turn under way, on whichever panel they type on — the Leader's
or a Worker's, one mechanism for both — and two lines typed keep their order. The trade-off is
plain: a message a seat was sent earlier is answered after a line the User typed later, so a
Worker's report can wait behind the User's word. The alternative, a stop that leaves the queue
untouched until the User presses again, would keep that order at the price of making the User
drive every frame; the seat's own order stays first-come for everything the User did not type.

**A stop says what happens next.** Stopping a seat with a queue makes it busy again at once — with
the next frame, which may be older than the press. The panel now says so under the stop: how many
wait and which goes in next, with when it was told (`stopped; 2 waiting, next: line from the User
(14:02)`). A stop on a seat with no turn under way says `no turn to stop` instead of pretending.

**A wait on a card is written down.** A card that was answered leaves no row of its own, so a turn
that stood still on one read, afterwards, as a run that took that long. The log now has both
ends — what was asked, what the answer was and how long it took — and the panel says `waited 40 s
for permission: Bash: git push` once the wait was ten seconds or more; a card answered at once
draws no row, since there is no gap to explain. Every seat's tool calls reach the log the same way,
the Leader's included, with a failed call and its reason.

**A slow call of the instance's own tools is told apart from a stuck seat.** Every call of the
tools the instance serves — `message`, `room`, `hire`, `write_desk`, `recall`, `remember`,
`permission`, `park`, the plugins — is timed where it is dispatched: the log says `tool: <seat>
<name> in N ms` (`failed in N ms: <why>` when it threw), and the panel says `<name> took N ms` once
a call was ten seconds or more, on the same threshold as the wait on a card, and in the
milliseconds the log counts in.
`recall` and `remember` go through a model when a judgement is needed, and that round-trip is what
makes them slow: the log times it (`store: <seat> remember model in N ms`), and says `no model`
for a call that needed none — a recall by id, a remember that named what it replaces.

**A frame held at the write is said, once.** A message or a line the quota gate holds until a
window resets is said on the panel where it was typed or sent, with when the window resets, in one
place whichever door it came through.

**The log survives a restart.** Each run of the server appends under a header naming its process
and when it started, so the run before is still there to read. The queue and the interrupt say what
they did: what was queued and where it went, what was written and how many still wait, why a frame
was not written, and whether a stop was answered and how long that took.

**A call that does not fit what the tool declared is refused before the tool sees it.** Every tool
served — the chat's own and the instance's own alike — declares its arguments, and a call is now
held to that declaration where it arrives: an argument the schema requires and the call left out,
one of another type than declared, one outside the values listed, or one the tool does not take at
all is answered in one line naming it (`write_desk: name is not an argument it takes`, `message:
text is required`, `park: deadline is not a whole number`, `recall: store is not one of memory,
knowledge`) and the tool is never called. One level and no deeper. What an argument means — a name
nobody has, a status too long, a moment that cannot be placed — stays the tool's own refusal,
after the shape. A plugin can drop the checks it wrote for a missing or mistyped argument.

**A turn that fails in its own words lands once.** A run that cannot go on — not logged in, a
window spent — says why as text and then ends in the same words as an error. The panel holds one
row for that: the words, marked failed, in the place they landed; a second row appears only when
the failed words are not the last thing the seat said.

**`remember` says the way back from a wrong replacement.** A write that names nothing it replaces
leaves the choice to the store, and a corrected record written over the one that chose wrong does
not bring the wrongly replaced record back: it stays reachable by its id and by nothing else. The
tool's description says so, beside the sentence that says only the write's answer tells you what
happened, and says the repair — write the lost record again.

Every line of the notes, the README, the code's comments and the check names says what is there
now, not what a thing had been; no check changes what it checks. And a tool of the instance's own
is checked the whole way round, from its file under `plugins/` to the list a seat sees and the
call it answers, against the real server.

## 0.12.0

A seat's ordinary shell commands are allowed from install, three are refused when spelled plain,
a compound of allowed commands runs without a stop, the store says when it chose a replacement,
and an instance whose trust cannot be recorded does not start. A fresh instance's
`.claude/settings.json` grants `git`, `mkdir`, `cd`, `node`, `bash`, `sh`, `cp`, `mv`, `rm`, `ls`,
`cat`, `tar`, `diff`, `cmp`, `sha256sum`, `grep`, `find`, `sed`, `awk`, `head`, `tail`, `wc`,
`echo`, `chmod`, `touch`, `curl` and `npm`, and refuses `git push`, `sudo` and `ssh`; every path
rule is anchored at the instance root and is an `Edit` rule alone; and `Always` on a dialog offers
one rule per side of a compound command, none for a side that only reads, and nothing at all for a
command with a side that starts with a shell reserved word.

**The ordinary day raises no stop.** A repository cloned, branched, staged and committed, files
copied, moved, removed and compared, a script run, an archive made, a page fetched — each of these
is a command on the list above, and the list is in the settings from the moment the instance is
made, for every seat. Three commands are refused when spelled plain rather than asked: `git push`
is the User's, `sudo` and `ssh` are nobody's here, and a refusal wins over the `git` rule that
would let a push through. A refusal reads a command the way an allowance does, from its first
character and never by a directory, so it holds the plain spelling and no other: `bash -c 'git
push'` is the `bash` rule's, and a push stays the User's by the rules of the room, not by the file
alone. The same reading is why `git -C` asks, and why a compound — `cd projects/x && git status` —
was asked for as a whole whatever its halves were, until the hook below. A workspace already
installed keeps the rules it has: `ovai update` wires the hook into a `.claude/settings.json` that
lacks it, adds no rule, and says which of the rules a fresh instance is born with the file has not
got.

**`Always` offers what is worth keeping.** A dialog for a compound command offers one rule per side —
`git` by its subcommand, `git push` rather than `git`, the way the instance is born granting it —
and none for a side that only reads: `ls`, `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`,
`wc`, `which`, `diff`, `stat`, `du`, `cd` and the read-only forms of `git` are run by the harness
without asking, so a rule for one of them settles nothing at a stop. The nine of those a rule can
name — `ls`, `cat`, `diff`, `grep`, `find`, `head`, `tail`, `wc` and `echo` — are seeded all the
same, so the list the hook reads is one list and a compound of them goes through like any other. A
command with a side that starts with a shell reserved word — `for`, `do`, `done`, `if`, `while` and
the rest — gets no `Always` at all: `for f in a b; do cmp x/$f $f; done` would offer `Bash(for:*)`,
`Bash(do:*)`, `Bash(done:*)`, three rules that name no program and would let anything in inside a
loop. What is offered is what a rule can say; what a rule cannot say is not offered.

**Every path rule is anchored at the root.** The rules the installer seeds and the rules a desk
brings with it — `Edit(/desks/<Name>/**)`, `Edit(/projects/**)`, `Edit(/reference/**)`,
`Edit(/temp/**)` and the refusal `Edit(/desks/*/STATE.md)` — begin at the instance root, so they
hold from wherever the session is standing, and each is an `Edit` rule alone: the harness reads an
`Edit` rule for `Write` too, and a twin that said the same was one more line to keep in step.

**A compound of allowed commands runs without a stop.** A Bash rule is matched from the command's
first character, so a seat whose settings held `cd`, `git` and `npm` was still stopped on
`cd projects/x && npm test`: no one rule held the whole. Now a hook the instance is born with —
`lib/hooks/compound.mjs`, wired in `.claude/settings.json` to run before every shell command — cuts
the command into its sides the way the dialog does, and when every side is a command the file's own
`allow` holds and none is one its `deny` refuses, the command runs and nobody is asked. Anything
else it answers nothing about, and the harness asks as it always did. It never refuses: refusing is
the rules' job, and the harness reads a deny rule whatever a hook says. What it lets through is
never wider than the rules — what a rule already lets through on its own, one side at a time — and
it reads the settings at every call, so a rule the User settles later counts at the next command
and one taken out stops counting. A command it cannot read as plain text — a substitution, a
here-document, a quote left open, a `find` that runs what it finds — gets no answer, which is the
stop the harness would have raised anyway.

**The store is judged by a model.** A write's answer says what it replaced, and whether the writer
named the record it supersedes or the store chose it: a replacement the writer named reads as
before, and one the store chose says so, with the reason, to the writer — and says "the writer
named nothing" to whoever recalls it later. The descriptions of `remember` and `recall` say what the
store is — managed by a model, not a file, never a lookup over a memory file known from elsewhere —
and both personas say the same, so nobody writes a record expecting it to be matched by its words.

**The harness's own directories are not gone round.** `.claude`, `.git`, `.idea`, `.vscode` and the
like are the harness's wherever they sit, `projects/` included: a write there asks the User whatever
the rules say, and the Worker's persona says a script, a copy or a rename is not the way round it —
ask, or leave it. The Worker is also told that a compound whose every side is allowed runs without a
stop, and that one with a side nothing holds asks: spell it plain, or ask for the rule.

**An instance whose trust cannot be recorded does not start.** Every session's rules hang on one
record in the instance's own home, the trust the harness reads before it honours
`.claude/settings.json`; a home that could not take it used to start every seat asking for
everything it does, with a line on stderr nobody reads. Now `ovai start` records the trust once,
before anything is served, reads it back, and refuses with one sentence naming the file and the
error when it is not there, so no session runs with its rules off; a new CI job, `start`, watches
exactly that.

A fresh instance turns Claude Code's commit and pull request attribution off (`attribution`: empty `commit` and `pr`, `sessionUrl` false), and `ovai update` turns it off in settings that say nothing about it; a file that says something is the person's.

## 0.11.0

The command is a daemon's and the instance root is laid out for what each thing is. `ovai start`
starts the server in the background and returns, `ovai stop` parks the room and stops it, `ovai
status` says whether it runs and where; `ovai chat` and `ovai hire` are gone, and a Worker joins
through the Leader's `hire` tool, named from a roster of thirty. The root holds `bin/`, `lib/` and
the instance's own files — `openovai.json`, `desks/`, `plugins/`, `store/`, `projects/` — and every
seat works under its own desk and under `projects/` without a prompt. On the page, a panel's head
says the model, the context, the state and the account's usage, a message between two sessions is
one thing on two panels, and nobody's turn waits for anybody else's. A workspace on 0.10.0 is
installed again into an empty directory, not updated: this release has no `tools/`, no
`templates/` and no `VERSION` at the root for `ovai update` to take.

**The head of a panel says what you asked of it.** The tab is titled `OpenOv AI ~/the/instance`. A
head reads `<name> · opus · 22k · listening` — the dot, the name, the model, the context, the state
word — and on the Leader's head after that `connected · 8% (3h) · all 86% (6d) · fable 20% (6d)`:
the session window and the time to its reset, the weekly window over all models, the weekly window
of the one model that has its own, read from the account's usage endpoint with the instance's own
credential while a page is open. That third window is the quota gate's too, on a fresh instance with
nothing set: it is held at the same `7d` thresholds as the window over all models — one pair for
every weekly window, no key of fable's own in `openovai.json` — and when it reaches the second stage
nothing more runs on fable until it resets, while every other model goes on. The weekly pair itself
is higher now: the first stage at 97 per cent and the second at 99, where it was 95 and 97. The
theme toggle sits at the right edge. The version, the path and the port
are no longer on the head, and the context is never hidden. `STOP` is gone from the heads: while a
turn runs, a stop glyph sits at the right edge of that panel's text box, and only then. When the
server is gone the page says so — every dot red, no state words, `disconnected` on the Leader's
head — and comes back on its own when the server does.

**The command is a daemon's.** `ovai start` starts the server in the background, prints the
address and returns; `ovai stop` stops it, parking every session first; `ovai restart`
is the two in a row. `ovai status` says `not running` (exit 3) or `running at <url> (pid, since)`,
found out by trying the address rather than by trusting `runtime.json`. What `status` used to
print — who works here, the models, the port, how the instance signs in, the desks, the store — is
`ovai configuration`. Bare `ovai` prints the help. `ovai chat` and `ovai hire` are gone: the
server is started with `start`, and a Worker joins through the Leader's `hire` tool, which opens
the desk and starts the process in one call. The server's own lines — a plugin it could not serve,
a session held or released, a park at the deadline — go to `runtime.log` at the root, one file per
run, written over at the next start; no request is logged anywhere any more, and the start says
nothing about instruction files above the instance or about the quota windows.

**The instance root is laid out for what each thing is.** `bin/ovai` is the one command and `lib/`
is everything else the release ships, replaced whole on update — what `tools/` and `templates/` held
is in there now, and so is the version: `lib/VERSION`, no longer a file at the root. `openovai.json`
is the instance's description of itself, `instructions.json` beside it the settings document every
session is started with — the instruction files above the instance it is not to read, written by the
installer and again at every start — and `runtime.json` the running chat: url, pid, since. `plugins/`
holds the tools the instance serves itself, one file each, the User's and kept across updates;
`store/` is what the workspace knows and `customization/` what the User adds to the personas, both
at the root, and `customization/` is made by the installer like the rest. `desks/<Name>/` is one directory per person — the desk file, the
persona the session was last started with, the conversation the chat kept for it, the model when one
was named, and whatever that person keeps there — and the listing of `desks/` is the roster;
`archive/` is where a retired desk goes, moved whole, as `<day>-<Name>-<slug of the final title>/`.
`reference/`, `projects/` and `temp/` are the User's material: `reference/` is kept to look at and
never worked on, `projects/` is worked on — every seat may write there with the file tools and work a
repository from inside it with plain git (clone, checkout, add, commit, status, diff, log), mkdir and
cd, never push — `temp/` is scratch anyone may delete at any time.
`.claude/` is Claude Code's project settings for the instance, a name that is Claude Code's, and
`.local/` is Claude Code's config dir for it — account, transcripts, memory, and nothing of the
instance's own. A fresh instance's root is exactly `.claude/`, `.local/`, `bin/`, `customization/`,
`desks/`, `instructions.json`, `lib/`, `openovai.json`, `plugins/`, `projects/`, `reference/`,
`store/` and `temp/`; `runtime.json` and `runtime.log` appear at the first start, `archive/` at the
first retire.

**A desk is a working directory; the desk file stays the tool's.** Every seat may edit and write
under its own `desks/<Name>/` without a prompt: the pair of rules is granted when the desk is opened
and withdrawn when it is retired. The one exception is `STATE.md`, written through `write_desk` and
no other way — an edit or a write of it with a file tool is refused by the harness on the spot, in
both spellings. `reference/`, `projects/` and `temp/` are granted to every seat for edits and writes
from install. Scratch goes under `temp/` and nowhere else — not the root, not the home directory —
and no session puts a file in the root itself. Which of `reference/` and `projects/` a clone goes to is your
question to the User on every clone, analysis or modification; a reference that later needs edits
is cloned fresh into `projects/`, never moved. Both personas say the desk is the working directory
and where scratch goes, and yours says a Worker is "it". `hire` refuses a name whose directory is
still under `desks/`.

**A 0.10.0 instance is installed again, not updated.** Nothing here reads the places the previous
version used — `work/`, `personas/`, `chat/`, `tools/`, `templates/`, `.claude-home/` — and nothing
moves what is in them. `ovai update` on a 0.10.0 instance refuses this release, since the release
has no `tools/`, no `templates/` and no `VERSION` at the root for it to take. Install into an empty
directory with
`./install.sh --root <instance> --source <release> --user <name> …` and copy over by hand what
should survive.

**A message between two sessions is one thing on two panels.** What the Leader sends a Worker is
`To <Worker>` on the Leader's panel, red, with the whole text, and `Received a message from
<Leader>` on the Worker's — a line marked as a click: it brings that message into view on the
Leader's panel and lights it for a moment. What a Worker sends the Leader is `From <Worker>` on
the Leader's panel, blue, and `Sent a message to <Leader>` on the Worker's, the same click. What
the User types on a Worker's panel is the User's prompt there, green, under the User's name, and on the
Leader's panel `<User> → <Worker>`, orange, with the whole text — three cases and no others. A
red line says why on hover: the exit code or the missing file the call's result named, the reason
a message was refused. A `To` or `From` row longer than three lines shows three, faded at the
edge, with `show all` under it.

**Nobody's turn is held for anybody else's.** A message comes back the moment the other session
has it, and the sender's turn goes on: the Leader asked to hire somebody for a task answers you
now — who it hired, for what — instead of going quiet for as long as the Worker takes, and the
Worker's report arrives later, as a `From <Worker>` row of its own, when the Worker sends it.
What a session says at the end of a turn is its own, on its own panel, and reaches nobody else;
a reply to a message is a message the other way, made with the same tool. And what a session says
is on its panel as it says it — every sentence the moment it is said, not the last one once the
turn is over — so a Leader that says "hiring somebody for this" before a long call is read while
the call runs. A message that would have waited for its sender's own turn used to be refused;
nothing waits now, so nothing is.

**A Leader that has left says so on its panel.** When the Leader's process is gone for good —
it stopped itself after "go offline", the server was stopped, or it died — one row sits on its
panel where the session ended, drawn like the day between two rows: `<Leader> has left — the next
message starts a fresh session`. What is typed there next starts a new process with nothing of
the context it had; its desk is what it knows. A stopping server is a gone one on the page from the
moment it says so: every dot red, no state words, `disconnected` on the Leader's head — never
`stopping` — and it comes back on its own when the server does.

**A row says what became of it, and its stamp is a click.** What you type reads `sending…` on a
dashed ground until the process has it, `queued — <name> gets it after the current turn` while a
turn is under way, and `delivered ✓` the moment its frame went in — on the panel you typed it on,
and again the same way after a reload; on a narrow panel the word gives way to its glyph alone, as the
stamp gives way to its clock. A click on any row's stamp puts `(ref:2026.09.14-14:39:14)`
into that panel's box; what is sent carries it spelled out, `(ref: 14:39:14 Paul — "the first line
of that row…")`, so the session can find what you point at. The pill between two days carries the
whole stamp of the first row of the new day, `2026.09.14 Monday 00:00:49`, and sits only between
a row of one day and a row of the next: never above the first row on a panel, never under the last.
A code block is set at .85rem, 1.4 lines high, and the code inside it inherits that size.

**A new Worker is called by the roster.** The Leader hires somebody new with no name, and the
name comes from a fixed list of thirty first names — Paul, Jane, Jack, Pete, Anna, Mark, Lucy, Tom,
Eva, Sam, Nora, Ben, Mia, Leo, Zoe, Max, Ivy, Finn, Ada, Noah, Ella, Owen, Ruby, Hugo, Iris, Otto,
Lena, Axel, Nina, Theo — the least recently used free one: a name never used first, in that order,
then the one whose holder left longest ago. The answer says who (`Jane started on the desk
desks/Jane`), and a name given to `hire` is for bringing somebody who stopped back on their own
desk. With nobody in the list free, the name is Dev and three digits.

**A question is a row on the panel.** A permission card — a call the session is stopped on, a rule
the Leader asks you to settle — sits among the rows, where the newest row goes, and scrolls with
them: seven at once are seven rows, the text box stays where it is, and the head reads `waiting
for you · 7 prompts`. A card that lands while you are at the newest row comes into view like a
row; away from it, the `↓ new messages` pill says something landed below.

## 0.10.0

The page is a room you read at a glance. Three columns of panels, each a bare slot with a head
that says who sits there and what they are doing, rows drawn as bubbles under it, and one box
that grows with what you type; a Worker's panel shows the calls it makes as it makes them, and a
message between two sessions is on both panels with what became of it. Every colour, the radius
and the type come from one table, light and dark, so the two themes are one page. The server
changed only in what it writes to a panel; a workspace taking this version gets the new page with
the update and keeps everything else.

**One token table, light and dark.** Every colour the page uses, its radius and its two font
stacks are declared once per theme and nowhere else; a dark-mode OS gets a dark page, and the
installed app's colour is the light panel head. The suite reads the stylesheet as rules, so a
colour outside the table, a token nobody declared or a class nobody styles fails a check.

**The type is set once.** The page sets its type in rem on the sans stack and hides its scrollbars
while everything still scrolls; a panel with no rows yet says "Waiting for the transcript…"
instead of standing blank.

**A panel is a bare slot with a head bubble.** The border and ground a panel had are gone. Its
head is a bubble: a state dot before the name, the model and the context after it, the state
word, and a small STOP; the rows scroll under it.

**A row is a bubble.** Every row carries the speaker and the time on top and its body under them,
the time in the reader's own zone. What you typed, a reply, a line the chat writes, an
interrupted turn and a failed one each have their ground; a reply's markdown has its stylesheet,
and a pill between two rows names the day when it changes.

**A question is a card.** A call stop or a rule to settle is a card in the slot under the rows,
drawn as the bubbles are: the words of the request in a raw block, the reason on a line of its
own, and a button per decision.

**The composer is one row.** It grows with what is typed and drops back to one row when a message
is sent; there is no send button — Enter sends, Shift+Enter breaks a line — and while empty the
box says whom a message reaches and which key sends it. A box that takes no input is dimmed.

**The Leader's head carries the instance facts.** The line above the columns is gone: the
version, the instance, the port, whether the page is connected and the quota standing sit in the
Leader's head after the state word, with a toggle between light and dark; a pill on that panel
says when rows land below where the reader is.

**An icon for a mask.** The installed app has a third icon for a platform that cuts icons to its
own shape, so the mark shows whole rather than cut or letterboxed.

**A Worker's tool calls are lines in its panel.** Each call the Worker makes is one line the
moment it is made — what it reads, what it searches, what it runs — and turns red once the call
failed; never the input, never the result, and a subagent's calls are not read.

**The dot and the empty box follow the turn.** The dot before a name is green between turns,
amber while a turn runs and red once the process is gone; the state word reads listening, working
or waiting for you; while a Worker works, its empty box says so and that Enter still sends. In a
narrow column a row's stamp gives way to the label, the time alone staying, since the day pill
above says the day.

**A message between two sessions is a record on both panels.** A message one session sends
another through the tool is a row on the sender's panel the moment its outcome is known — sent,
not sent, or refused with why — and a row on the addressee's, as a message from the sender rather
than the addressee's own words. The Leader's panel carries every message it is party to with its
whole text, coloured by direction, so the whole exchange reads there; a Worker's panel stays slim,
one line for a message received and one for a message written.

## 0.9.0

The server frames every turn, owns every seat's lifecycle and gates every turn on the account's
windows; the page draws it all from one stream, in three columns. A workspace taking this version
starts every session afresh: the personas, the tools and the page are new, and nothing a session
did on the version before carries over except the desks.

**What the workspace knows is one store, reached through two tools.** `recall` and `remember`
replace the memory file each session grew for itself. `memory` is about us — hard rules, facts,
traps — and `knowledge` is about the project; each record is a markdown file under `store/`,
numbered, never rewritten: a later record replaces an earlier one and says so, with who wrote it and
when. Hard rules are rendered into every persona byte for byte, the User's first, numbered, with a
set version; a running session is told the change in front of its next turn. A Worker cannot write
one and is told to propose it; a write over the cap, a duplicate or a team write over the User's
record is refused in words. Where the store needs understanding rather than a grep — which records
answer a query, whether a new one replaces an old one, when "for today" ends — it asks a helper:
one Claude Code run in print mode and safe mode, with no tools, from an empty directory outside the
instance, on the smaller model. Claude Code's own memory is off for every session, and `ovai
status` names the store.

**Only the server writes to a session, and a process is who it says it is.** Every turn is one line
on a seat's stdin carrying a frame the server sets: `<user>` for what you typed, `<message
from="Name">` for what another session said, `<server-event type="…">` for the server. The body is
neutralised before it is framed, so nothing inside a message can pose as a frame. What you type on
a Worker's panel is that Worker's own turn, and the Leader is woken the same moment with what was
typed. When a seat starts, the server mints a secret for that process, hands it over in the
environment and keys the tool route by it; the map lives in memory only and dies with the process,
so nothing about identity is read from a name a session could claim. The actors are the User, the
Leader and the Workers, in the config, the flags, the templates and the page alike: the option is
`--user`, the key is `user`. Nothing rewrites a 0.8.0 workspace's `openovai.json`: it
carries the User's name under the former key, `ovai status` prints `user undefined` until the
instance is installed again with `./install.sh --root <instance> --source <release> --user <name>
--force`, and the former key stays.

**Every seat has a lifecycle the server runs, and one gate on the account.** Three tools for every
seat — `write_desk`, `restart_session`, `stop_session` — and two for the Leader, `hire` and
`park`. A restart is a new process on the same desk with the queue carried; a stop keeps the desk
and the panel; both refuse until the desk was written since the event that asked. The server owns
the desk header and writes it. What the server has to say is a fixed set of events: context-full,
quota-low, idle, park, hard-rules, stopped, and each asks one thing of the seat. The quota gate
reads the windows Claude Code reports — 5h and 7d, two thresholds each, 90/95 and 97/99 by default
— and fires a stage once per crossing: the first holds hires and tells every seat, the second holds
every write and interrupts the Workers, the Leader told once. A frame that would not pass waits in
the server's queue and is released at the reset, the Leader's first. `park` waits for the Workers'
stops or the deadline; `ovai stop` parks the whole room, the Leader included, then exits. A
per-model 7d window is wired and gates nothing until an instance names it: the frame this server
reads has never carried one.

**The personas say what the server serves, and a stop is shown in the session's own words.** Both
templates are written around the tools by name, the frames by type and what each event asks; the
first-turn audit, the `allowed` skill and every mention of a file under `.claude/` are gone, and
an update removes that skill from an instance an earlier version installed. A call stop shows the
command and the reason the session gave for it, or the path it was going to write, with Allow,
Deny and — where a rule can be composed — Always allow with the rule on the button. The Leader
has a tenth tool, `permission`: a rule the instance should settle, in one of the two shapes the
server accepts, and why, in words you read beside it. It lands on the Leader's panel with Allow,
Deny and Ask every time; the press writes the rule to that list, takes it off the other two and
tells the Leader in an event. A call stop that has waited ten minutes is reported to the Leader
once. The seed allows the tool server and the reads and denies an edit of any desk file, so a
stray write on a desk is refused without a prompt; `ovai hire` grants nothing of its own any
more.

**The page draws from one stream, in three columns, with markdown and STOP.** It opens one
`EventSource` and draws everything from it: a snapshot, the rows of every seat, then each row, seat
change, question and quota stage as it happens; the server keeps nothing for a page that is not
there, and a page that reconnects asks for what it missed. The Leader's panel is in the middle and
always there; the Workers alternate left and right in the order they appeared, a panel dims when its
process is gone and is removed thirty seconds later unless the process is back. Replies are rendered
as markdown, raw HTML escaped, links kept only on `http(s)` and `mailto`, images shown as links.
STOP interrupts the running turn of that seat and is the only button besides the permission
buttons: nothing on the page starts or ends a seat. The room list is gone; the panels are the room.
The status line carries the version, the instance, the port, the Leader, the quota standing and
whether the page is connected, and the page installs as a web app, with a manifest and two icons.

## 0.8.0

The chat says what it can see but not settle — a room that has not been read, a desk that has
stopped moving, a run that will not end — and nothing said across an ending is lost.

**The room says when it was last read.** A pass that finds nothing writes nothing, so a room watch
that had died looked exactly like one with nothing to do — and the watch is what parks a conversation
now, so its death was the one thing nobody would notice. One line above the room says it, on the
page, in `ovai room` and to your Leader: when the room was last read and how often it is read, or
that it has not been read yet and when the watch was armed. Two numbers and no verdict; whether
twelve minutes against every five means the watch is gone is yours to read off them.

**A desk that has stopped moving is asked for.** A conversation is parked with its desk written first,
and one handover turn cannot write three hours of work. So the chat now counts a session's own
answers since its desk file last changed and, once five have gone by, asks for the desk in the turn:
what is true now and what to do next. It stops the moment the desk moves, and it asks nothing of a
desk that has not yet said what it is on — that one is still asked for its title first.

**A run that will not end is named, with what is under it.** A run wedged on something that is not
the model — a clone the harness starts before its first request, say — holds its session's queue,
and every message to that seat waits behind it while the row says only `began 43m ago`. Past half
an hour, longer than anything in the toolkit waits for an answer, the room watch now names it to
your Leader once: how long it has been running, whether the service has spoken to it at all, and what
is running underneath it, by name — `ssh` under a run is a different reading from `mvn`. Nothing is
ended. The chat cannot tell a long build from a hang and does not guess; ending a run is still the
End button on that panel, and the line puts the diagnosis beside it.

**An answer that comes back after the run that asked was ended reaches its next turn.** A session
that says something to a colleague is held for the whole of the colleague's turn, and the End button
on its panel ends that run while it waits. The answer used to come back to nobody: it landed on the
colleague's panel, and the session that asked was never told. The chat now notices that the run
which asked is not the run there is, writes what came of it on the asker's panel under its own name,
and puts it in front of the asker's next message — the way anything else said while a session was
not running to hear it already is. A refusal is carried the same way, in the sentence `say` would
have answered with.

**A conversation begun after any ending reads its desk first, and whoever spoke to it is told.** Only
a conversation that had gone cold was told, on its first turn, that it was a new one and should read
its desk; one begun after a handover — the button, the Leader's tool, the room watch under a hold —
was left to the persona's standing instruction, and a session that spoke to it through `say` heard
nothing about who answered. The line that ends a thread is flagged on the panel now, and the first
turn on a desk that has no thread and such a line opens with the pick-up instruction whichever way
the thread ended; `say` says in its answer that a new conversation answered, as it already did for a
cold one.

## 0.7.0

The chat keeps its own room now, and a persona is rendered when a conversation starts rather than
when the toolkit was installed.

**A room taken off stays off after the chat restarts.** The switch used to live in the running chat
and go with it, which was right when the only thing that could start a run was a message; the room
watch can start one now, on its own clock, and a chat restarted for an update came back on and its
first pass parked and ended whatever it found in a room you had stopped. The word is a file beside
the hold now, `chat/offline`, and a restarted chat reads it: the room says it is off, a message is
turned away, and the first pass ends nobody. Bringing the room back removes it.

**The personas now say what the chat does by itself.** A Leader hired on the version before was
told that handing a conversation over was yours to press, that the room watch did three things and
that a crossing into a strong band was said once and left alone — while the chat had begun parking
a conversation on that crossing, and before its hour, desk written first. Both templates say so
now: the Leader's names all four things the watch does and what its two readings are for, and
carries what to tell you about a conversation the chat ended; a worker's says a handover may be the
chat asking, and where in it to read why. A conversation already going keeps the persona it began
on, as always — and its Leader is now told, in the block about who has grown big, that its
instructions predate this. That is read off the persona itself against what the instance would
render for it now, so a template you edited by hand, or something you added under
`customization/`, is told the same way an update is.

**Your Leader is no longer told who has stopped.** A block at the top of the Leader's turns used to name
every session that had run nothing for half an hour, and how long each had been doing nothing. It
was a reading and never a rule, and what it warned of — a conversation ended at the hour with its
desk unwritten — is what the chat now prevents itself: the room watch parks a conversation before
its hour, its desk written first. What is left is who is idle, and the room says that whenever the
Leader asks, on the row, as `idle, last ran 35m ago`. The two blocks the Leader is still handed on a
turn, who has grown big and where the account stands, are unchanged and read in the same order.

**An update is now a clean install with your material in it, and so is installing over an
instance.** Both put the payload in place whole and then seed, once, whatever file of yours a fresh
install would have given you and this instance has not got — the memory index, either settings file,
the Leader's desk — and name what they seeded. A file you have is yours whatever is in it and is never
written over; `install --force` over an instance used to rewrite `openovai.json`, the memory index,
the home settings and the Leader's desk, and merged the payload instead of replacing it. Over an
instance the installer's options are no longer all required: `openovai.json` answers for whatever
is left off, and whatever is given is written into it, the rest of the file untouched. The
instance's own settings are written once, whole, when there is none; the rule a hire adds still goes
into whatever you have made of the file by then.

**An update refuses while any session of this instance is running, and says which.** It used to ask
only whether the chat was up; a run that outlived a chat killed with `-9`, or a session started by
hand with the instance's Claude Code home, went on running the superseded version from memory under an
instance that said the new one was installed. Now every process carrying this instance's home in its
environment is named — `kill <pid>  <seat>`, or `(no seat name)` for a sign-in — and nothing of
another instance's is. Nothing is written down to find them by, so there is nothing to go stale.

**The `allowed` skill is payload, and `.claude/settings.json` is yours.** The skill a Leader reads to
say what the workspace allows now ships at `.claude/skills/allowed` — placed by the install,
replaced by an update, the one directory and never `.claude/skills`, so a skill of your own beside
it stays. The chat no longer rewrites it at every start, and no longer rewrites `claudeMdExcludes`
into your settings at every start either: the list of instructions above the instance that a
session is not to read is written to `chat/instructions.json` for each run and handed over with
`--settings`, which was measured to be honoured on a resumed run as it is on a fresh one. A
`claudeMdExcludes` an older toolkit left in your settings is yours now: neither read for this nor
removed, and harmless.

**A persona is rendered when a conversation starts, and what you add to one is yours.** Nothing
writes `personas/` any more. Who a session is gets rendered from the toolkit's templates the moment
it starts a conversation — a hire's first turn, the turn after a handover — and kept beside that
conversation at `chat/<Name>/persona.md` for as long as it lasts, so a conversation already going
keeps what it was told and the next one gets the templates the instance has by then. So taking a
newer version no longer leaves everybody on the instructions they started with until they are hired again: a
handover is enough. The `personas/` directory an older toolkit left is read by nothing now and can
go — but before it does, look for anything you wrote into one of those files yourself, because that
was the only way to add to a persona and it never survived a hire. It has a place now:
`customization/leader.md` and `customization/worker.md` at the instance root, appended as they are
to every persona of that kind the instance renders, after everything the toolkit puts in, and never
touched by an update.

**The chat now keeps its own room, and it spends none of your account doing it.** The room watch
used to read the room every five minutes and, when something had crossed into a band, buy the Leader a
turn to hear about it. It reads the same room at the same cadence, and acts instead: a conversation
nobody has carried on for an hour is ended by the pass, there and then, rather than by the next
message that happens to reach it; and when the account has reached the stop line of its five-hour
window and that window lifts later than a conversation can be carried across, the chat holds — it
hands each conversation over to its desk itself, fullest first and the Leader last, and says each park
as it lands. Nothing in this buys a turn. What the pass did is one line on the Leader's panel, and the
same line waits in a block at the top of the Leader's next turn, whenever you give it one; the Leader is
no longer woken to be told what the chat has already done.

The hold does one of three things, and says which above the room — on the page, in `ovai room`, and
to the Leader. If the window lifts inside the hour, nobody is handed over: everybody is still here
when it does. If the service did not say when it lifts, nobody is handed over either, because a park
is not something to do on an unknown; the next completed turn is read again. Only when it lifts later
than the hour does the chat park, and then a seat sitting on a permission prompt is left alone, no
seat is parked twice under one hold, and a seat whose park the account turns away is asked again
while it is still warm — as often as you allow. `parkAttemptsPerSeat` in `openovai.json` bounds
that, a whole number of one or more; left out, a refused seat is asked on every pass until it goes
cold, at which point it is ended as a cold conversation with the refusals counted in the line that
says so. When the window lifts, the hold is over and the line says who was handed over under it and
who never was.

**A conversation about to go cold is handed over before it does.** A conversation's cache lives an
hour past its last turn, and a seat idle for fifty minutes of it usually goes on to lose it. So in
those last minutes the pass asks the seat itself to hand over — one turn on that session, to write
its desk while it can still be asked to — and tells the Leader as it lands. Only a seat with nothing
running on it and not sitting on a permission prompt, the Leader last when it is among them, and never
in a workspace that wrote `watchEverySeconds: 0`. It saves no tokens; what it saves is whatever
that session had not yet written down.

A crossing — a conversation reaching nine tenths of its window, or ninety-five per cent — is now
acted on as well as said: on the crossing, once per band, the pass asks the seat itself to hand over
when the workspace buys a turn and nothing is running on it, and tells you the crossing with the
reason when it cannot. Handing a conversation over for its size is then yours to press, on its panel,
and the line says so.

**Where the stop line is drawn is yours to say.** The hold enters at ninety-five per cent of the
five-hour window unless `holdAbove` in `openovai.json` says otherwise: a fraction from `0.9` up to
but not including `1`, and the same line decides when the block about the account says to stop and
which other window is named beside it. A workspace whose account is also spent outside the instance
can draw it at `0.9` and have everybody put down before ninety-five arrives unannounced.

**Your Leader cannot take anybody new on while the account is nearly spent.** Past nine tenths of the
five-hour window the Leader's own block already said to start no new front and take nobody new on;
that is a mechanism now. A `hire` from the Leader is refused before the name is looked at, and so is a
colleague's message to a seat with no conversation, or with one that has gone cold, because each of
those would start a conversation from nothing at the moment the account can least afford one. The
refusal is the answer the caller gets — the window, the reading and the moment it lifts, so it knows
when to ask again — and nothing is said on any panel. A conversation that is warm is carried on
whatever the account reads, a run in flight is never touched, and what you start yourself goes
through whatever the reading: the Hire button and a typed message are yours, and a chat that turned
its owner's own button away would have stopped being an assistant. Under a hold the line above the
room now ends by saying so — in the room, in `ovai room`, on the page and to the Leader — and it says
it only because it is true.

**`watchEverySeconds: 0` means something different now, and if your instance wrote it, read this.**
It used to switch the watch off: no timer, no reading, nothing. It now means *spend nothing on me*.
The room is read at the default cadence regardless; a cold conversation is still ended and a crossing
is still said, because neither costs a turn; and nobody is handed over by the chat — under a hold the
line above the room says so, and whatever a conversation has not written to its desk by the lift goes
with it. A workspace that wants a room nothing acts on takes it offline, which is a button.

**Every row says where the account stands while a run is still going.** A row used to carry the
reading its last finished turn came back with. A session mid-turn now says what the account read
*now*, on which model, and since when the run began, so on a room where one long turn is what is
spending, the number is not as old as the last turn that ended. Whether the room is being read at all
shows on `/health` as `watch`: how often, when it was armed, when the last pass was, and how many
sessions it read, decided on and acted on — a watch that died and one that was never armed look the
same from a quiet room, and this is how they are told apart.

**Your Leader was told about the former watch, and an update does not tell it otherwise.** A Leader in a
conversation started before this version was told that the watch gives it a turn and that nothing
stops running because of it; both are now false, and the Leader will act on them until it is told
otherwise. A handover is what tells it: the next conversation is rendered from the templates this
version ships, the paragraph beginning *The third is the room watch* and the one after it.

**Every persona now carries a budget for the work it hands to others.** When a session delegates —
an agent sent to search or to read — what that costs is not how much the agent reads but how many
times it goes round, because every turn re-reads the whole conversation so far. The agent cannot see
this. So every persona this workspace writes ends with four sentences to copy into every brief, word
for word: answer in at most 15 tool calls or report what is missing; split the files between agents
and never let two read the same one; search first, then read the part that matched; and treat what
has been filed away as history, not a place to look things up. Here too a conversation started
before this version was not told; the next one is.

**A session the service refused comes back by itself, and a new instance says so in writing.** Left
to the default, the limit can arrive as a dialog on the session's own terminal offering the wait as
a choice, and the session sits on it until somebody answers at a keyboard nobody is at — it has left
the room, and it cannot be asked, told or parked. A new instance is installed with
`autoContinueAtUsageLimit` set to true in its own Claude Code home, spelled out rather than left to
the harness. What keeps a reopened window from being spent by a whole room coming back at once is
the hold above, not this key. An instance installed before this keeps what it was given.

**Ask your Leader what this workspace allows, and it reads the files rather than remembering.** The
answer used to be whatever the Leader had picked up: a first-turn paragraph written months before your
instance existed said that nothing had been granted here, and every answer after that came out of a
conversation. Inside a chat you have no permission dialog in front of you and no command line to
point at the session, so a Leader that remembers instead of reading is the whole of what you have to
go on — and it is wrong the moment anything changes.

There is now a skill for it, `allowed`, and the Leader is told to run it whenever the question comes
up. It opens the files in that turn — a managed policy if the machine has one, the settings beside
yours, the instance's own, the ones its Claude Code home keeps, and the ledger that says who asked
for each rule — and reports what it read with the path and line of every claim. Seven blocks, in
one order: how this instance decides, what is denied, what is allowed and who accounted for it,
what stops and waits on your panel, what the working directory refuses whatever the rules say,
**what is written and is not in force**, and when a change takes effect.

The sixth is the one you cannot get anywhere else. A settings file can hold rules the runtime is
ignoring — a workspace installed inside somebody's checkout that nobody has trusted has its
`allow` list dropped and keeps its `deny` and `ask`; a settings file that fails to parse grants
nothing and says so to nobody, because every session here runs with `--print`; and in auto mode the
frame quietly drops allow rules it considers dangerous. The report separates what is written from
what is honoured and never merges the two, and where it is inferring rather than reading it says so
in those words.

And it says when a change lands, which is better news than you would expect: every turn is a fresh
process, so an edit to `.claude/settings.json` is in force from each session's next turn, with
nothing to restart and nobody to hire again. The exception is a persona — a resumed conversation
still carries what it has already read, so tightening a persona is additive in effect until a
handover replaces the conversation. A Leader now tells you that rather than leaving you to work it
out from a session that seems to be ignoring you.

**A new instance now refuses three paths outright, and they are the ones it keeps its own account
in.** No tool that writes a file may reach `.claude/**` — the settings that say what is allowed and
the ledger that says who asked for each rule — or the two files its Claude Code home keeps, its
settings and the record of whether this workspace has been trusted. They hold whether or not the
workspace has been trusted, which is the case they matter most in.

What they are worth is narrower than it looks, and your Leader will tell you so rather than
reassuring you: a rule binds the tools its matcher names, and `Edit(...)` names the tools that
write files. A shell command is not one of them, so if you grant something like `Bash(sed:*)` a
session can edit those files anyway — and the `allowed` report crosses the two lists and says so in
one line when it applies. What the refusals buy you is that no file-writing tool reaches them by
accident, in every instance, trusted or not.

They are three lines in a file you own: delete them with an editor and restart the chat, and the
workspace goes back to what it was. And they are written for new instances only — an instance
already installed keeps whatever it holds, because changing how a workspace somebody is working in
behaves is not an installer's to do. Add them by hand if you want them.

## 0.6.0

Two refusals: one that was not there, and one that was not saying enough.

**`ovai update` no longer takes you backwards without being asked.** It used to ask what the latest
release was, compare that with the version you are on for sameness alone, and replace the payload
whichever way the difference ran — so an instance ahead of what is published was quietly put back
onto the older one, and told about the fall in the same words as a rise: `Was on 0.5.0, now on
0.4.0`. Being ahead is ordinary rather than exotic — an instance installed from a local head, or
from a directory release — so this was live on the plainest command there is, a bare `ovai update`
with nothing after it. It now stops, names both versions and says what to do about it. Going back
is a thing somebody does on purpose, so it is refused rather than forbidden: `--downgrade` says so
and the update goes ahead as it always did. The same version is still nothing to do, and a newer
one is still taken without being asked twice.

The two are placed by comparing the numbers as numbers, because compared as words `0.10.0` comes
before `0.5.0` — and the release where that starts being true is the release where a wrong answer
here is a downgrade. Where a version cannot be placed at all — a prerelease, a `dev`, a workspace
from before the toolkit carried a version — nothing is refused and the update goes on as it did
before there was anything here to ask. A refusal has to be certain of what it is refusing.

**A port that is taken names the process, wherever your workspace sits on disk.** When the chat
cannot have its port it tells you what is holding it, with the pid and that process's command
line, because the usual culprit is a chat somebody forgot to stop and its command line says which
workspace it belongs to: one `kill` rather than a search. That line was cut to a readable length
from the front, and the part of it that grows is the directories — so the deeper your workspace
sat, the sooner the cut landed in front of the only word worth reading, and far enough down you
were handed a hundred and twenty characters of path that named nothing at all. A line too long to
print now loses its directories instead: every word keeps what follows its last `/`, so the holder
reads `node ovai.mjs --root my-workspace chat`. A line that already fits is printed exactly as it
is, paths and all. And where the machine will not say — a process belonging to somebody else is the
usual reason — you get the pid on its own, or the advice on its own, as you did before.

How full each conversation here is, said where you already look — and your Leader told when one of
them fills up, whether or not anybody is talking to it.

**The lines are shares of the window and not sizes in tokens: four fifths, then 85, 90 and 95 per
cent.** They are four numbers somebody decided. What is measured is the denominator, and the frame
that carries the answer already says what the model it answered on can hold — so there is no table
of models for anybody to keep true, and no name of ours is compared against a name of theirs. A run
says which model it is having its turn on as it opens, and the frame keys that model's own entry
under those same words. Every row and every panel now says the share beside the size it always said.

A size in tokens could not do this, which is why the line 0.5.0 drew at 300,000 is gone. It has to
be a judgment about one window and is then wrong on every other, and the way it is wrong is silent:
a line drawn for a long window cannot be crossed inside a short one, so on a workspace sending
200,000 the block would never appear anywhere and nothing would say so — and on the 1,000,000 the
same service reports for its larger models, that line calls a conversation big with seven tenths of
its room still free. A reading that is dead everywhere it is installed is not conservative, it is
absent. Where the frame names no window — or names no model this run said it was on, which happens
when a turn is answered only beside, by a helper the service called on its own account — there is
no share, the row says the tokens alone as it always did, and the block does not name that session.

**Every five minutes the chat reads its own room, and on a crossing worth a turn it gives the Leader
one.** It is the first timer in the toolkit and there is one case that earns it: the Leader nobody has
typed to for an hour is the one that most needs to act, and it is precisely the one with no turn to
ride on. It speaks on a crossing and never on a condition — the band each session was last in is
held in memory, and a conversation sitting at ninety per cent for two hours is said once. Only two
things buy a turn: 90 or 95 per cent newly reached, and a conversation newly gone cold. It hands
nobody over, refuses nothing and ends no conversation of its own; a Leader already answering is left
alone. `watchEverySeconds` in `openovai.json` sets the cadence, and `0` turns it off entirely.

You are asked once what may be done here, instead of one interruption at a time.

**A write can now be settled for good.** A session stopped to write a file used to get **Allow** and
**Deny** and never a third button — the very first thing this README asks you to try, and it asked
you again every time. It now offers a rule for the directory the write was in, with the rule on the
button: **Always allow `Edit(work/Wren/**)`**. That is the width the harness honours — a directory
rule covers the whole subtree, and matches by path segment, so a rule for one desk cannot reach a
desk whose name it begins. A write that lands outside the workspace still offers nothing, because
there is no rule the workspace could hold for it.

A write at the root of the workspace offers the widest rule there is, and you are shown it rather
than protected from it: it is reachable only because a session asked to write there, the button
carries the rule word for word, and the press leaves the usual line in `.claude/allowed.md` saying
who asked and what for. That line now says which write it was for, where it used to say the grant
was for a call it could not describe.

**A version you take has been checked.** Cutting a release here was a button, and the checks were
started by the push before it — two things running side by side, neither waiting for the other. A
release took eleven seconds and the checks took two and a half minutes, so the tag and the page
people download from existed before anything had said the tree was good, and a failing check would
simply have turned up after them. From this version the release runs the checks first and tags
nothing until they are green. Nothing changes on your side: the version you take has just been
through them.

## 0.5.0

The chat can reach you when you are not looking at the page.

Two things that happen here can only be ended by you, and until now both of them said so on a
panel you may not have had open. From this version the chat also pops on your desktop when either
of them happens.

**Your Leader breaking in.** It has always had one line it can send you without being asked: it
breaks in, and what you were half way through writing arrives with it. That worked as long as you
were looking, and did nothing at all when you were not — the line went onto the panel and waited
there, and the Leader had no way of knowing you had never seen it.

**A session stopping to ask you something.** A run that reaches for a tool your workspace has not
already allowed stops where it stands and waits for your answer, for as long as that takes: nothing
on that path times out, because the answer is yours and you are not a deadline. One was measured
sitting parked for six and a half minutes, and it would have sat there for good, because the
request was drawn on a page nobody had open. Your desktop now says which session has stopped and
which tool it is waiting on, whether it stopped on something you said to it, on a handover or on
its way out.
What is counted is the request and not the turn it came out of, so a session that stops twice over
in one turn reaches you twice: each of those would have waited on its own.

**How your desktop is made to pop is yours to write, because it is your machine.** It is
`notify-send` on one desktop, `osascript` on another and something else again on a third, so it
cannot ship in a toolkit that installs on machines it knows nothing about. Put a file called
`pop.mjs` at the root of your workspace, beside `openovai.json`, exporting one function:

```js
import { execFile } from "node:child_process";

export function pop({ on, why }, { config }) {
  execFile("notify-send", ["--", config.user, `${on}: ${why}`]);
}
```

`on` is whose panel it is about, so you know where to look, and `why` is the sentence to read. The
file is read when the chat starts, so start it again after writing one. Nothing pops in a workspace
that has not got one, which costs nothing and says nothing — and a file that will not load is named
in the terminal you started the chat in, rather than being passed over in silence.

**Nothing else pops.** Not an ordinary answer, not a turn ending, not a desk being opened or put
away, not somebody speaking to somebody else, and not a request the run that asked it is no longer
waiting for. All of those are a record, and a record is read when
you read it. A workspace that popped for every one of them would be a workspace whose popups you
learned to ignore, which is the same as having none.

**And your Leader does not pop you itself.** It still has the one line it can send you without being
asked, and it is now told plainly that this is the whole of what it has: no notification tool of
its own, no command that raises one on your desktop. A second way in is what teaches somebody to
stop trusting the first. An update leaves the personas it finds where they are, as it always does,
so this is what a workspace installed from this version tells its Leader.

**When you are not to be woken**, say so in `openovai.json`:

```json
"quietHours": "22:00-08:00"
```

Nothing pops inside that window and nothing is saved up to arrive when it ends — a popup at eight
about something that happened at three is a lie about now, and the panel is still the record. It is
your machine's own clock, it may wrap midnight or not, and leaving it out means nothing is quiet.
A window the chat cannot read stops it starting, with a line saying which field to look at: being
told at the start beats finding out at three in the morning.

**Somebody can be hired onto a model that is not the usual one.** Until now everybody you hired ran
on the one model your workspace was installed with for its workers, and the only way to move one of
them was to move all of them. `ovai hire <name> [model]` takes a model beside the name, the Hire
box on the page does not, and your Leader can name one when it opens a desk itself.

Leaving it out is still the answer nearly every time, and it is the answer that keeps moving with
you: nothing is written down for somebody hired the usual way, so the model in `openovai.json` stays
a setting rather than a seed — change it, and everybody who was never named one is on the new one
from their next message. Somebody who was named one stays where they are, through a handover as
well, and what they were hired onto goes away with their desk when they leave.

**`ovai status` says what each desk runs on.** The row that read `worker model` now reads `default
worker model`, because that is what it is, and the row listing the desks names each of them with
the model it resolves to. That is the reading to reach for when the chat is not running; the room
on the page already says it for everybody in it.

**Your Leader is told the shape of the choice and no model names.** The instructions it is given say
that leaving the model out is right nearly every time, that a stronger one is drawn from the same
account window everybody there shares, and that when it chooses one it should say on its own panel
why — the room already shows what each session is on, and the reason is the part missing from it.
Which models your workspace actually uses stays in `openovai.json` and in whatever you tell your
Leader yourself. An update leaves the personas it finds where they are, so this is what a workspace
installed from this version tells its Leader.

**Your Leader is told which conversations here have grown big.** The room already says how much of
itself every session is carrying, and the panel says it again beside the name — a number with no
opinion attached, for a person to judge. From this version the one reader who would otherwise go on
loading a conversation is handed a block of its own, unasked, naming every session here whose
conversation has grown past the size where what is left in it has to be planned rather than simply
carried on, and what each was carrying at the end of its last turn. Its own conversation is in that
list like anybody else's: it is usually the largest one in the workspace, and it is the only one
that cannot press its own button.

**Pressing it is still yours.** Nothing is ended, refused, queued or delayed because a conversation
is big — the whole of this is one block of text on one session's turn, and **Hand over** is where it
always was, beside the composer. So the Leader is told to say which panel and why, its own included.
The block says nothing at all while every conversation here is under the line, and it stops by being
acted on: handing a session over takes the reading with the thread, so there is nothing to clear and
nothing here remembers having said it. Your Leader is told that much in its own instructions, and told
plainly that it cannot press the button itself. An update leaves the personas it finds where they
are, so this is what a workspace installed from this version tells its Leader.

**The line is 300,000 tokens, and it is a judgment about a long context window.** It is the size at
which answers measurably degrade on the windows the workspaces this was built for run on. On a
workspace whose model sends a shorter one — one has been measured at 200,000 — a conversation runs
out of room before it ever reaches the line, so the block never appears. That is the right answer
and not a gap: there the window itself is the line, the row and the panel go on printing the size as
they always did, and advice that is always early is worse than advice that stays quiet where it has
nothing to add.

**A directory in `work/` that nobody could have been hired under is not somebody who works here.**
The desks under `work/` are the roster: hiring opens one, leaving takes it away, and there is no
second list anybody has to keep true. But `work/` is a directory on your machine as well: an
editor opening the workspace leaves its own in there, a copy of a desk gets made beside the desks,
something of your own writes where it seemed sensible. Until now every one of those arrived as a
person — a panel, a row in the room, a name your Leader could say something to — and **Leave** on such
a panel would have put away whatever that directory was holding. From this version the roster is the
directories somebody could have been hired under, and nothing else in `work/` is a person anywhere:
not on the page, not in the room, not in `ovai status`, and not on a route. Everybody you did hire
is untouched, and there is nothing to do after taking this version.


## 0.4.0

Your Leader can open a desk and put one away now. It has two tools it did not have before:
`hire`, which opens a desk for somebody new the way the **Hire** box does, and `retire`, which asks
somebody to write their desk one last time and then files that desk and their whole conversation
away together, exactly as **Leave** does. Both are the Leader's alone; nobody else here is offered
either.

Nothing about the buttons changes and neither does anything you have to do. What changes is that a
Leader which has just decided somebody is needed can act on it in the same turn instead of asking you
to press something, and you will see it happen: every desk it opens or puts away is written on the
Leader's own panel, in a line saying which it was and for whom. What the Leader still cannot do is
anything else about who works here — handing a session over is yours, so is a conversation somebody
left behind, and so is everything in `archive/`.

Answering a session that has stopped is worth more than it was. Refusing one takes the sentence you
type beside **Deny**, and that sentence is what the session is told — it has always been what the
run hears, and until now the page had no way to send you one, so every refusal from the panel
arrived in the chat's own words. A session refused with a reason takes it as an instruction; one
refused by a word it has never seen goes looking for another way round.

And allowing one no longer has to be done again tomorrow. Where the request says plainly what the
whole class of calls is, a third button appears with the rule written on it — **Always allow
`Bash(node:*)`** — and pressing it lets that call through and leaves the workspace allowing that
shape, so the next session reaching for the same thing is not stopped at all. It is offered
narrowly: a command's first word and only when it is a bare name, never a path, never a variable,
and never for writing a file or for a tool the chat already serves. Where no rule can be composed
there is no button, rather than one that cannot be pressed.

Every rule granted that way is written down in `.claude/allowed.md` beside the settings, one line
saying who was asked, when, and what they were doing at the time. A permission granted by a press
is otherwise unanswerable a month later, and a workspace run for a few months this way collects a
couple of dozen of them that nobody dares remove. A rule in the settings with no line in that file
is a grant nobody can account for, and the toolkit says so.

Your workers are told where the boundary runs, too. The persona now says that the desk is theirs
and that who works here is the Leader's, and that the files under a stop are never the way round — a
session refused something used to have your desk files sitting right there, and writing one by hand
is easier than asking and looks, from the outside, exactly like the tool having worked.

## 0.3.0

Tools a workspace serves itself, for the things only that workspace wants.

The chat serves a session a handful of tools, and until now what they were was decided in this
repository. That is right for the ones every workspace wants and wrong for the ones only yours
wants: a workspace whose person is not at the page needs something that pops on their desktop, and
how a desktop is made to pop is one command here and another one there, none of which can ship in a
toolkit that installs on machines it knows nothing about. So it is written where the machine is
known. One file in `plugins/` at the root of your workspace is one tool, and the name of the file
is the name of the tool — nothing is registered, nothing is listed and nothing has to be kept in
step with anything, because the directory IS the list, the same way a directory under `work/` is a
person. Renaming a tool is renaming its file, which is the honest way round: a name that lived in a
field could disagree with the file holding it and nothing could say which of the two was right.

`plugins/` is yours and not the toolkit's. It sits beside `work/` and `personas/`, and deliberately
not under `tools/`, because taking a newer version removes every directory the toolkit ships before
it copies the new one in — a tool kept in there would be gone the first time anybody took an
update, and gone quietly, since an update reports what it replaced and not what it took away.
Taking this version or any after it leaves `plugins/` exactly as it was, and there is a check that
says so.

A file exports three things — a `description`, an `inputSchema` and a `run` — and that is the whole
of the shape. The handler is given the arguments of the call and a context: who called it, whether
they lead, where the workspace is (the one thing the file cannot work out for itself, since a
workspace records no absolute path anywhere) and the workspace's own description of itself. It
answers with words or with a refusal, and the three ways it can do neither now arrive as a sentence
rather than as silence. A refusal is passed on as a refusal, in words that can be acted on, because
the call arrived and was understood and was answered with a no. A handler that throws is answered
in the words of the failure, naming the tool it happened in. And a handler that answers with
nothing usable is refused in words naming the file, saying what the two shapes are and what it
answered instead — the first mistake anybody writing one of these makes, and left alone it comes
back as a call that came back empty, which is the one answer nothing can be done with. There is no
way to hide one, either: a tool that is only the Leader's is offered to everybody and says so itself
in one line, because a hidden tool costs more turns than a visible one that refuses, and a session
never reads the refusal of a tool it was not offered anyway.

They are read when the chat starts, and only then. A file written or changed while the chat is up
is served from the next start, which is already the ordinary act here and one no session notices.
Reading the directory on every call would be worse than either extreme, because a module is
imported once for as long as the chat runs: a new file would appear and a changed one would go on
serving its old code, and nobody could tell which of the two they were looking at.

A file can fail to become a tool in four ways — it will not load, it is missing one of the three
exports, it is called something a tool cannot be called, or it is called something the chat already
serves — and all four end the same way. The file is not served, the chat starts with everything
else, and the reason is printed where the chat was started, naming the file. Starting anyway is the
point: a workspace where nobody can talk to anybody is a worse answer to a typo in one file than a
workspace missing one tool, and it is the choice already made a level up, where a session that
could not be named still runs. The printing is the other point, and it is the shape that makes it
necessary — the directory IS the list, so a file sitting in it looks served, and nothing a session
can ever see would say otherwise. A file that was never going to be a tool, a `notes.txt` left
beside them, is passed over in silence.

**`ovai plugin <name>`** writes `plugins/<name>.mjs` from a scaffold, prints what it wrote, and then
says the one thing you would otherwise sit and wonder about: the chat has to be started again. What
it writes carries the whole of what a handler is given, written out rather than pointed at, because
whoever opens that file has nowhere else to read it. It refuses three things, in two different
ways. A name a tool cannot have is something wrong with what was typed, so it is answered with the
usage under it, the way every other command line is — a name is a letter and then letters, digits
and hyphens, and never an underscore, because a permission rule for a single tool of a server is
spelled with two of them and a name carrying a pair would make a rule naming a different tool. A
name whose file is already there is something true of the workspace, so it is answered on its own
and the file is left exactly as it was: what is in it is somebody's work, and a command that
quietly writes over it to get its own job done is worse than the surprise it saves you. And a name
the chat already serves is refused there too, before anything is written. `say` is a name a tool
could have, so what is in the way is not what was typed but that this chat serves one — asked
before the file, because a file can be moved out of the way and one of those four names cannot.

Nothing was added to what your workspace allows, and that is the answer rather than an omission.
One rule grants every tool the chat serves, so a tool of your own is granted the moment it appears
in the list, and the list is exactly where a check can see it. What stands where a permission rule
cannot is that a session holds one write grant, its own desk and nothing else — so no session can
give itself a tool, and writing that file stops to be approved by a person. It is a mistake net
rather than a wall, and the standing limit in the README now says what it is a limit ON: what this
toolkit ships. A tool of your own runs inside the chat rather than in a session, so no rule there
decides what it may do, and writing the file is the deciding.

Three sentences that described how things used to be are gone. This file is no longer rewritten for
each release: it keeps a section per version and a release publishes the one it is about, so what a
person cutting one does is add a section rather than replace the file. And there are five test
suites now rather than four, which the line telling you to run them all had not caught up with, nor
the sentence counting which of them never reach for Claude Code.

## 0.2.0

A room that says more about itself, and a way out of every state a session can get into.

A run can now be ended from the panel it is on. *End this run* ends the run and everything it
started underneath, and leaves the session: the thread is intact, the panel is still there, and the
transcript says the run was ended rather than reporting a session that went quiet. It is offered
whatever the session is doing, because it is wanted the moment a panel looks stuck, and it is the
one thing here that does not queue — everything else typed at a panel waits behind the turn in
front of it, which is exactly the turn that is not finishing. A run somebody ended is not asked
again: a run that fell over is retried without its thread, which is the repair for a conversation
that cannot be resumed, and an ended run used to look like one from there.

You can ask the chat what it has not finished. Four kinds of thing are held in memory while it
works — a run, a turn, a request waiting to be allowed, and a call one session is making on another
— and each kind is named beside the sentence that says what ends it. One entry per thing rather
than per session, which is the point: a session answering one message with another queued behind it
is holding two, and being told that it is busy is true and useless. It is a reading and never a
gate. Behind it, the states the room can say are one ordered list now, held against rows off real
scenarios, so a state written down that nobody can reach goes red — because a state nobody reaches
is a state nobody has had to write an exit for. Five of the six have one; the sixth is rest, and
needs none.

The room can be taken off. Beside the room heading there is one button — **Go offline**, and once
pressed, **Go online** — and while the room is off, nothing new is run for anybody. It is a switch
and not an agreement: throwing it either way runs nothing, asks nobody and cannot be turned away,
which is what makes it impossible to leave the room half off. The gate is on *starting* a run and
on nothing else, so what is refused is a message, a hand over and a leave, each in its own words
saying what was not done — the conversation untouched, the desk still open, nothing filed and
nothing lost. What stays open is everything that ends something rather than starting it: a run can
still be ended, a session stopped waiting to be allowed a tool can still be answered, and somebody
can still be hired. A turn already going runs to its end. The room says it is off above the rows
and never on one — on the page, in `ovai room`, and to the Leader. There is no `ovai offline`: taking the
room off is a person's decision about the whole instance, and it stays on the page beside the
button that brings it back.

The rows carry what the model service last told a run about the account it runs on. **refused until
14:30** and **five-hour window 96% full, read 2m ago** come off frames the chat already receives
while a session is running — no poll and no extra request — and they are facts for a person to
judge rather than anything acted on: a message to a session whose row says refused is still
attempted. The reading always carries its age, because a usage window belongs to the account and
not to a session, so a low number on a row that has not run for hours is not the account's current
state. Windows are named as the service names them, one it said nothing about is left unsaid rather
than shown as 0%, and there is no threshold, no colour and no warning level on a row.

**idle** now says how long: `idle, last ran 40m ago`, and a bare `idle` for a session that has
never run. It is part of the idle phrase and never a fact of its own beside the state, because it
is only true there — every state above idle is a run in flight, and the clock is rewritten when a
run ends, so a duration printed beside *answering* would tell you a session had been doing nothing
for exactly as long as it had been working. It is the conversation's clock and not the panel's: a
Leader's panel moves every time it overhears something said elsewhere, and what matters when you are
deciding whether to check on somebody is when they last ran.

Two things are handed to the Leader unasked, which the room deliberately never is, and both are
absent while they do not apply. The first is who has gone quiet: any session stopped for more than
half the hour after which a conversation is ended is named where the Leader's turn begins, with the
moment it was read. It is never about the Leader itself or about anybody mid-turn, and acting on it
is the whole of what stops it — saying anything to that session starts a run and moves its clock.

The second is where the account stands, and it is the only thing this toolkit holds an opinion
about. Once the five-hour window is past nine tenths the Leader is told to finish what is in flight,
start no new front and take nobody new on until it lifts. Past ninety-five per cent it is told to
stop, and which way to put people down — which is the whole reason the block exists, because
pausing a session leaves its conversation where it stands and costs nothing to undo, while parking
one ends the conversation and is paid for in whatever it worked out and never wrote to its desk. So
it reads the moment the window lifts against the hour after which a conversation here is ended
anyway. Lifting inside that hour: pause everybody where they are. Later: park everybody, the Leader
included, and start fresh on the desks afterwards. A service that did not say when it lifts: stop,
and go and find that out before choosing. The window is matched by name, which is the one place a
service's name for a window is written into the code, and if it is ever renamed the block says
nothing rather than something wrong. A second window is named only as a fact with nothing to do
about it attached, the reading picked is the freshest rather than the fullest, and one whose lift
has already passed is dropped. It is advice and never a gate: nothing stops running because of it,
and when the window lifts the block is gone.

Two smaller things about being talked to. What a Leader says at the end of a turn goes back to
whoever spoke to it in that turn and to nobody else, so a closing line addressed to the person at
the page at the end of a worker's turn lands on the worker's panel, about somebody who never reads
it; the Leader's instructions now say so, and say to break in when the person has to know before they
are next asked. And on the page, a line that broke in drags the reader down to it — the one redraw
allowed to move somebody who had scrolled up to re-read, because a break-in drawn off-screen is the
one case no wording could have saved.

Cutting a release is a click. **Actions → Release → Run workflow → `main`** reads `VERSION`, forms
the tag, takes the section of this file under that version's heading and publishes the release with
it, refusing before anything is tagged when the version is not three numbers, when the tag is
already out, or when the notes say nothing about it. It is machinery of the repository rather than
of a workspace and nothing installed into an instance moved for it, with one visible consequence:
this file keeps every version's notes now instead of only the newest, because the release page
shows one section of it. Nothing a workspace runs changed for the test work here either, though ten
checks that a value came from somewhere are proved against a second source of it now — a check with
one fixture behind it is green whether the code reads the value or hard-codes it.

**One thing is yours to do after taking this version.** Both readings above arrive from the chat
whatever instructions the Leader is running, so they will turn up for a Leader hired before this update
that has been told nothing about them. Personas are not re-rendered, so either say what those two
blocks are yourself, or hand the Leader over once and let the session that replaces it read the new
instructions.

## 0.1.0

The first release. Nothing changed, because there is nothing before it.

An instance now knows which version it is on: `bin/ovai status` says so, and the version travels in
the payload with the code it names.

`bin/ovai update` takes a newer version from a release: it replaces what the toolkit ships — `bin/`,
`tools/`, `templates/` and `VERSION` — and touches nothing a workspace has accumulated. Desks,
personas, threads, panels, settings and everything the workspace has learned are left exactly as
they were. It refuses to run while the chat is answering, so stop the chat first.

An update does not re-render anybody's persona. A session hired before it goes on running the
instructions it was hired under; a session hired afterwards gets the new ones. That is why you are
reading this: nobody else here has been told, and working out what it means for them is yours.

The three commands a session used to be told to type are tools now. Saying something to another
session, asking who works here, and — if you lead — asking for the room are done with a tool and
proper arguments rather than a shell line. What that buys the people here is that a message
survives being sent: an apostrophe, a backtick or a line break in what somebody wrote used to end
the quoting or stop the run to be approved, and now the words arrive exactly as they were written.

A session that says something to another is held while that one answers, for up to half an hour.
Beyond that it is told the call timed out — while the session it asked carries on working, and its
answer stays in its own transcript where nobody is waiting for it.

The workspace grants less than it did: one rule per person for their own desk, and one for the
tools, where the three commands needed six between them. The commands themselves are unchanged and
are still there for you at a terminal.

A conversation nobody carries on for an hour is not carried on at all. The next message to a
session that has been quiet that long is answered by a new one at the same desk, which reads the
desk before it answers. This is not a setting and there is nothing to turn on: it happens because
resuming a conversation the model service has stopped holding costs the whole of it again, at
fourteen to twenty times an ordinary turn depending on how big the conversation has grown, and
nobody was choosing to pay that. The bigger the conversation, the worse it gets, which is why the
session that leads is the one this saves most on.

What it costs is what that session had worked out and never wrote down. The desk survives, the
panel survives, and everything else in that conversation is gone. Say so to the people here: the
personas now do, but only for sessions hired after this version, and a desk kept current as the
work moves is the whole of the protection. Nothing is asked of the session before its thread ends,
because asking would be exactly the expensive turn being avoided.

Nobody is exempt, including whoever leads. It holds the largest conversation in the workspace and
is the one this saves most on — and it is the one you would otherwise be most likely to catch out,
because a Leader's panel keeps moving while it overhears what is said elsewhere, and the conversation
behind that panel goes cold all the same.

You will see it three ways: the room says `cold` where it said `idle` for a session whose next
message starts a new conversation; the panel carries a line, before the question, saying where the
memory stops; and a session asking another through the `say` tool is told in the answer that it
came from a fresh head.

**Two things are yours to do after taking this version, because an update leaves a workspace as it
found it.** The permission rules are the workspace's own, so add `mcp__openovai` to
`.claude/settings.json`: without it the first tool a session reaches for stops and asks you to
allow it, on every message. And personas are not re-rendered, so everybody hired before the update
goes on typing the commands it knows — which still work, and whose rules you can drop once nobody is
running those instructions any more. Those same sessions have not been told that a conversation can
end without being asked to hand over, so tell them yourself, or hand them over once and let the
sessions that replace them read it.
