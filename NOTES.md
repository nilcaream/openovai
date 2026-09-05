# What changed

For the lead of a workspace taking this version. Short, and about what is different for the people
working there — not a developer changelog. A section per release, newest first; a release page
carries only its own.

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
