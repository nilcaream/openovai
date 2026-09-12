# What changed

For the lead of a workspace taking this version. Short, and about what is different for the people
working there — not a developer changelog. A section per release, newest first; a release page
carries only its own.

## 0.8.0

**The room says when it was last read.** A pass that finds nothing writes nothing, so a room watch
that had died looked exactly like one with nothing to do — and the watch is what parks a conversation
now, so its death was the one thing nobody would notice. One line above the room says it, on the
page, in `ovai room` and to your lead: when the room was last read and how often it is read, or
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
your lead once: how long it has been running, whether the service has spoken to it at all, and what
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
its desk; one begun after a handover — the button, the lead's tool, the room watch under a hold —
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
turned away, and the first pass ends nobody. Bringing the room back removes it, as before.

**The personas now say what the chat does by itself.** A lead hired on the previous version was
told that handing a conversation over was yours to press, that the room watch did three things and
that a crossing into a strong band was said once and left alone — while the chat had begun parking
a conversation on that crossing, and before its hour, desk written first. Both templates say so
now: the lead's names all four things the watch does and what its two readings are for, and
carries what to tell you about a conversation the chat ended; a worker's says a handover may be the
chat asking, and where in it to read why. A conversation already going keeps the persona it began
on, as always — and its lead is now told, in the block about who has grown big, that its
instructions predate this. That is read off the persona itself against what the instance would
render for it now, so a template you edited by hand, or something you added under
`customization/`, is told the same way an update is.

**Your lead is no longer told who has stopped.** A block at the top of the lead's turns used to name
every session that had run nothing for half an hour, and how long each had been doing nothing. It
was a reading and never a rule, and what it warned of — a conversation ended at the hour with its
desk unwritten — is what the chat now prevents itself: the room watch parks a conversation before
its hour, its desk written first. What is left is who is idle, and the room says that whenever the
lead asks, on the row, as `idle, last ran 35m ago`. The two blocks the lead is still handed on a
turn, who has grown big and where the account stands, are unchanged and read in the same order.

**An update is now a clean install with your material in it, and so is installing over an
instance.** Both put the payload in place whole and then seed, once, whatever file of yours a fresh
install would have given you and this instance has not got — the memory index, either settings file,
the lead's desk — and name what they seeded. A file you have is yours whatever is in it and is never
written over; `install --force` over an instance used to rewrite `openovai.json`, the memory index,
the home settings and the lead's desk, and merged the payload instead of replacing it. Over an
instance the installer's options are no longer all required: `openovai.json` answers for whatever
is left off, and whatever is given is written into it, the rest of the file untouched. The
instance's own settings are written once, whole, when there is none; the rule a hire adds still goes
into whatever you have made of the file by then.

**An update refuses while any session of this instance is running, and says which.** It used to ask
only whether the chat was up; a run that outlived a chat killed with `-9`, or a session started by
hand with the instance's Claude Code home, went on running the old version from memory under an
instance that said the new one was installed. Now every process carrying this instance's home in its
environment is named — `kill <pid>  <seat>`, or `(no seat name)` for a sign-in — and nothing of
another instance's is. Nothing is written down to find them by, so there is nothing to go stale.

**The `allowed` skill is payload, and `.claude/settings.json` is yours.** The skill a lead reads to
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
newer version no longer leaves everybody on the old instructions until they are hired again: a
handover is enough. The `personas/` directory an older toolkit left is read by nothing now and can
go — but before it does, look for anything you wrote into one of those files yourself, because that
was the only way to add to a persona and it never survived a hire. It has a place now:
`customization/leader.md` and `customization/worker.md` at the instance root, appended as they are
to every persona of that kind the instance renders, after everything the toolkit puts in, and never
touched by an update.

**The chat now keeps its own room, and it spends none of your account doing it.** The room watch
used to read the room every five minutes and, when something had crossed into a band, buy the lead a
turn to hear about it. It reads the same room at the same cadence, and acts instead: a conversation
nobody has carried on for an hour is ended by the pass, there and then, rather than by the next
message that happens to reach it; and when the account has reached the stop line of its five-hour
window and that window lifts later than a conversation can be carried across, the chat holds — it
hands each conversation over to its desk itself, fullest first and the lead last, and says each park
as it lands. Nothing in this buys a turn. What the pass did is one line on the lead's panel, and the
same line waits in a block at the top of the lead's next turn, whenever you give it one; the lead is
no longer woken to be told what the chat has already done.

The hold does one of three things, and says which above the room — on the page, in `ovai room`, and
to the lead. If the window lifts inside the hour, nobody is handed over: everybody is still here
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
its desk while it can still be asked to — and tells the lead as it lands. Only a seat with nothing
running on it and not sitting on a permission prompt, the lead last when it is among them, and never
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

**Your lead cannot take anybody new on while the account is nearly spent.** Past nine tenths of the
five-hour window the lead's own block already said to start no new front and take nobody new on;
that is a mechanism now. A `hire` from the lead is refused before the name is looked at, and so is a
colleague's message to a seat with no conversation, or with one that has gone cold, because each of
those would start a conversation from nothing at the moment the account can least afford one. The
refusal is the answer the caller gets — the window, the reading and the moment it lifts, so it knows
when to ask again — and nothing is said on any panel. A conversation that is warm is carried on
whatever the account reads, a run in flight is never touched, and what you start yourself goes
through whatever the reading: the Hire button and a typed message are yours, and a chat that turned
its owner's own button away would have stopped being an assistant. Under a hold the line above the
room now ends by saying so — in the room, in `ovai room`, on the page and to the lead — and it says
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

**Your lead was told about the old watch, and an update does not tell it otherwise.** A lead in a
conversation started before this version was told that the watch gives it a turn and that nothing
stops running because of it; both are now false, and the lead will act on them until it is told
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

**Ask your lead what this workspace allows, and it reads the files rather than remembering.** The
answer used to be whatever the lead had picked up: a first-turn paragraph written months before your
instance existed said that nothing had been granted here, and every answer after that came out of a
conversation. Inside a chat you have no permission dialog in front of you and no command line to
point at the session, so a lead that remembers instead of reading is the whole of what you have to
go on — and it is wrong the moment anything changes.

There is now a skill for it, `allowed`, and the lead is told to run it whenever the question comes
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
handover replaces the conversation. A lead now tells you that rather than leaving you to work it
out from a session that seems to be ignoring you.

**A new instance now refuses three paths outright, and they are the ones it keeps its own account
in.** No tool that writes a file may reach `.claude/**` — the settings that say what is allowed and
the ledger that says who asked for each rule — or the two files its Claude Code home keeps, its
settings and the record of whether this workspace has been trusted. They hold whether or not the
workspace has been trusted, which is the case they matter most in.

What they are worth is narrower than it looks, and your lead will tell you so rather than
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

How full each conversation here is, said where you already look — and your lead told when one of
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

**Every five minutes the chat reads its own room, and on a crossing worth a turn it gives the lead
one.** It is the first timer in the toolkit and there is one case that earns it: the lead nobody has
typed to for an hour is the one that most needs to act, and it is precisely the one with no turn to
ride on. It speaks on a crossing and never on a condition — the band each session was last in is
held in memory, and a conversation sitting at ninety per cent for two hours is said once. Only two
things buy a turn: 90 or 95 per cent newly reached, and a conversation newly gone cold. It hands
nobody over, refuses nothing and ends no conversation of its own; a lead already answering is left
alone. `watchEverySeconds` in `openovai.json` sets the cadence, and `0` turns it off entirely.

You are asked once what may be done here, instead of one interruption at a time.

**The question, on the first turn.** A workspace where nothing has run and nothing has been granted
now opens by having your lead ask you one thing: what may be done at this root. It is open, there is
no menu, and nothing reads your answer or turns it into a setting — say *never push anything*, or
*never write outside `work/`*, or *no restrictions*, or *ask me every time*, however you would say
it. Then, if what you said allows anything, your lead goes and makes the calls it permits, one at a
time, so that each one stops on a panel and you settle it there while you are still thinking about
the workspace. Not everything it reaches for stops — read-only work is settled by the frame itself —
and your lead is not shown your panel, so it does not tell you what stopped: when the calls are made
it reads `.claude/allowed.md` back to you, which is this workspace's own account of every rule it
holds, and the only place either of you can read one off. **Not now is a whole answer**: nothing is
tripped, nothing is granted, and the workspace is exactly as capable as it was.

It is asked once and then it is gone, because it stops the moment either half of what it fires on
stops being true — the first turn, or the first thing granted. One consequence is worth knowing
rather than being surprised by: a lead handed over in a workspace where you have still granted
nothing is asked again, because a new conversation has no way of knowing the question was put once.
Answering anything at all, or answering *not now* and granting one thing, ends it.

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
What is counted is the request and not the turn it came out of, so a session that stops twice over
in one turn reaches you twice: each of those would have waited on its own.

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

**And your lead does not pop you itself.** It still has the one line it can send you without being
asked, and it is now told plainly that this is the whole of what it has: no notification tool of
its own, no command that raises one on your desktop. A second way in is what teaches somebody to
stop trusting the first. An update leaves the personas it finds where they are, as it always does,
so this is what a workspace installed from this version tells its lead.

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
box on the page does not, and your lead can name one when it opens a desk itself.

Leaving it out is still the answer nearly every time, and it is the answer that keeps moving with
you: nothing is written down for somebody hired the usual way, so the model in `openovai.json` stays
a setting rather than a seed — change it, and everybody who was never named one is on the new one
from their next message. Somebody who was named one stays where they are, through a handover as
well, and what they were hired onto goes away with their desk when they leave.

**`ovai status` says what each desk runs on.** The row that read `worker model` now reads `default
worker model`, because that is what it is, and the row listing the desks names each of them with
the model it resolves to. That is the reading to reach for when the chat is not running; the room
on the page already says it for everybody in it.

**Your lead is told the shape of the choice and no model names.** The instructions it is given say
that leaving the model out is right nearly every time, that a stronger one is drawn from the same
account window everybody there shares, and that when it chooses one it should say on its own panel
why — the room already shows what each session is on, and the reason is the part missing from it.
Which models your workspace actually uses stays in `openovai.json` and in whatever you tell your
lead yourself. An update leaves the personas it finds where they are, so this is what a workspace
installed from this version tells its lead.

**Your lead is told which conversations here have grown big.** The room already says how much of
itself every session is carrying, and the panel says it again beside the name — a number with no
opinion attached, for a person to judge. From this version the one reader who would otherwise go on
loading a conversation is handed a block of its own, unasked, naming every session here whose
conversation has grown past the size where what is left in it has to be planned rather than simply
carried on, and what each was carrying at the end of its last turn. Its own conversation is in that
list like anybody else's: it is usually the largest one in the workspace, and it is the only one
that cannot press its own button.

**Pressing it is still yours.** Nothing is ended, refused, queued or delayed because a conversation
is big — the whole of this is one block of text on one session's turn, and **Hand over** is where it
always was, beside the composer. So the lead is told to say which panel and why, its own included.
The block says nothing at all while every conversation here is under the line, and it stops by being
acted on: handing a session over takes the reading with the thread, so there is nothing to clear and
nothing here remembers having said it. Your lead is told that much in its own instructions, and told
plainly that it cannot press the button itself. An update leaves the personas it finds where they
are, so this is what a workspace installed from this version tells its lead.

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
person — a panel, a row in the room, a name your lead could say something to — and **Leave** on such
a panel would have put away whatever that directory was holding. From this version the roster is the
directories somebody could have been hired under, and nothing else in `work/` is a person anywhere:
not on the page, not in the room, not in `ovai status`, and not on a route. Everybody you did hire
is untouched, and there is nothing to do after taking this version.


## 0.4.0

Your lead can open a desk and put one away now. It has two tools it did not have before:
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
and never on one — on the page, in `ovai room`, and to the lead. There is no `ovai offline`: taking the
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
because a lead's panel keeps moving while it overhears what is said elsewhere, and the conversation
behind that panel goes cold all the same.

You will see it three ways: the room says `cold` where it said `idle` for a session whose next
message starts a new conversation; the panel carries a line, before the question, saying where the
memory stops; and a session asking another through the `say` tool is told in the answer that it
came from a fresh head.

**Two things are yours to do after taking this version, because an update leaves a workspace as it
found it.** The permission rules are the workspace's own, so add `mcp__openovai` to
`.claude/settings.json`: without it the first tool a session reaches for stops and asks you to
allow it, on every message. And personas are not re-rendered, so everybody hired before the update
goes on typing the old commands — which still work, and whose rules you can drop once nobody is
running those instructions any more. Those same sessions have not been told that a conversation can
end without being asked to hand over, so tell them yourself, or hand them over once and let the
sessions that replace them read it.
