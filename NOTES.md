# What changed

For the lead of a workspace taking this version. Short, and about what is different for the people
working there — not a developer changelog. Rewritten for each release.

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
