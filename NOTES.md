# What changed

For the lead of a workspace taking this version. Short, and about what is different for the people
working there — not a developer changelog. A section per release, newest first; a release page
carries only its own.

## 0.5.0

The chat can reach you when you are not looking at the page.

Two things that happen here can only be ended by you, and until now both of them said so on a
panel you may not have had open. From this version the chat also pops on your desktop when either
of them happens.

**Your lead breaking in.** It has always had one line it can send you without being asked: it
breaks in, and what you were half way through writing arrives with it. That worked as long as you
were looking, and did nothing at all when you were not — the line went onto the panel and waited
there, and the lead had no way of knowing you had never seen it.

**A session stopping to ask you something.** A run that reaches for a tool your workspace has not
already allowed stops where it stands and waits for your answer, for as long as that takes: nothing
on that path times out, because the answer is yours and you are not a deadline. One was measured
sitting parked for six and a half minutes, and it would have sat there for good, because the
request was drawn on a page nobody had open. Your desktop now says which session has stopped and
which tool it is waiting on, whether it stopped on something you said to it, on a handover or on
its way out.

**How your desktop is made to pop is yours to write, because it is your machine.** It is
`notify-send` on one desktop, `osascript` on another and something else again on a third, so it
cannot ship in a toolkit that installs on machines it knows nothing about. Put a file called
`pop.mjs` at the root of your workspace, beside `openovai.json`, exporting one function:

```js
import { execFile } from "node:child_process";

export function pop({ on, why }, { config }) {
  execFile("notify-send", ["--", config.human, `${on}: ${why}`]);
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

**When you are not to be woken**, say so in `openovai.json`:

```json
"quietHours": "22:00-08:00"
```

Nothing pops inside that window and nothing is saved up to arrive when it ends — a popup at eight
about something that happened at three is a lie about now, and the panel is still the record. It is
your machine's own clock, it may wrap midnight or not, and leaving it out means nothing is quiet.
A window the chat cannot read stops it starting, with a line saying which field to look at: being
told at the start beats finding out at three in the morning.

## 0.4.0

The toolkit has a name of its own: OpenOv AI. It was called after the directory it lived in, and
"office workspace" is what a workspace is rather than what this one is called. Three names move
with it, and one of them wants a minute of your time.

**One thing is yours to do after taking this version, because an update leaves a workspace as it
found it.** The permission rules are the workspace's own, so open `.claude/settings.json` and
change `mcp__office` to `mcp__openovai`. That rule is what grants the tools the chat serves your
sessions, and the tools are served under the new name from this version on — so until the rule is
changed, the first tool any session reaches for stops and asks you to allow it, on every message.
It is one line, and it is the only edit here.

The command is `ovai`. `ow` still works: it says what the command is called now and then does what
you asked, so nothing you have written down stops working today. It goes away two releases from
now, which is the time to change the lines that call it.

The instance's description of itself is `openovai.json`. Yours is still called `ow.json` and is
still read under that name, because an update replaces only what the toolkit ships and never
reaches into what your workspace is. Rename it when it suits you; the new name wins if both are
ever there. This one also stops being read two releases from now.

Nothing about how the workspace runs is different. The desks, the personas, the settings, the
transcripts and the account are where they were, under the names they had.

Your lead can also open a desk and put one away now. It has two tools it did not have before:
`hire`, which opens a desk for somebody new the way the **Hire** box does, and `retire`, which asks
somebody to write their desk one last time and then files that desk and their whole conversation
away together, exactly as **Leave** does. Both are the lead's alone; nobody else here is offered
either.

Nothing about the buttons changes and neither does anything you have to do. What changes is that a
lead which has just decided somebody is needed can act on it in the same turn instead of asking you
to press something, and you will see it happen: every desk it opens or puts away is written on the
lead's own panel, in a line saying which it was and for whom. What the lead still cannot do is
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
and that who works here is the lead's, and that the files under a stop are never the way round — a
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
way to hide one, either: a tool that is only the lead's is offered to everybody and says so itself
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

**`ow plugin <name>`** writes `plugins/<name>.mjs` from a scaffold, prints what it wrote, and then
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
and never on one — on the page, in `ow room`, and to the lead. There is no `ow offline`: taking the
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
lead's panel moves every time it overhears something said elsewhere, and what matters when you are
deciding whether to check on somebody is when they last ran.

Two things are handed to the lead unasked, which the room deliberately never is, and both are
absent while they do not apply. The first is who has gone quiet: any session stopped for more than
half the hour after which a conversation is ended is named where the lead's turn begins, with the
moment it was read. It is never about the lead itself or about anybody mid-turn, and acting on it
is the whole of what stops it — saying anything to that session starts a run and moves its clock.

The second is where the account stands, and it is the only thing this toolkit holds an opinion
about. Once the five-hour window is past nine tenths the lead is told to finish what is in flight,
start no new front and take nobody new on until it lifts. Past ninety-five per cent it is told to
stop, and which way to put people down — which is the whole reason the block exists, because
pausing a session leaves its conversation where it stands and costs nothing to undo, while parking
one ends the conversation and is paid for in whatever it worked out and never wrote to its desk. So
it reads the moment the window lifts against the hour after which a conversation here is ended
anyway. Lifting inside that hour: pause everybody where they are. Later: park everybody, the lead
included, and start fresh on the desks afterwards. A service that did not say when it lifts: stop,
and go and find that out before choosing. The window is matched by name, which is the one place a
service's name for a window is written into the code, and if it is ever renamed the block says
nothing rather than something wrong. A second window is named only as a fact with nothing to do
about it attached, the reading picked is the freshest rather than the fullest, and one whose lift
has already passed is dropped. It is advice and never a gate: nothing stops running because of it,
and when the window lifts the block is gone.

Two smaller things about being talked to. What a lead says at the end of a turn goes back to
whoever spoke to it in that turn and to nobody else, so a closing line addressed to the person at
the page at the end of a worker's turn lands on the worker's panel, about somebody who never reads
it; the lead's instructions now say so, and say to break in when the person has to know before they
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
whatever instructions the lead is running, so they will turn up for a lead hired before this update
that has been told nothing about them. Personas are not re-rendered, so either say what those two
blocks are yourself, or hand the lead over once and let the session that replaces it read the new
instructions.

## 0.1.0

The first release. Nothing changed, because there is nothing before it.

An instance now knows which version it is on: `bin/ow status` says so, and the version travels in
the payload with the code it names.

`bin/ow update` takes a newer version from a release: it replaces what the toolkit ships — `bin/`,
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
because a lead's panel keeps moving while it overhears what is said elsewhere, and the conversation
behind that panel goes cold all the same.

You will see it three ways: the room says `cold` where it said `idle` for a session whose next
message starts a new conversation; the panel carries a line, before the question, saying where the
memory stops; and a session asking another through the `say` tool is told in the answer that it
came from a fresh head.

**Two things are yours to do after taking this version, because an update leaves a workspace as it
found it.** The permission rules are the workspace's own, so add `mcp__office` to
`.claude/settings.json`: without it the first tool a session reaches for stops and asks you to
allow it, on every message. And personas are not re-rendered, so everybody hired before the update
goes on typing the old commands — which still work, and whose rules you can drop once nobody is
running those instructions any more. Those same sessions have not been told that a conversation can
end without being asked to hand over, so tell them yourself, or hand them over once and let the
sessions that replace them read it.
