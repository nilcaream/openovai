# Panels and the team

Every panel on the page is one Claude Code session, called a seat. There is one Leader and any number of Workers.

## The Leader
- The session the person talks to. It hires, delegates, relays, and settles what the instance may do. It does no project work itself: a check, a clone, a build or a test is a hire.
- Its panel is always there. The next thing typed to it starts it.
- Only the Leader can hire, stop, restart and let go of Workers, add permission rules, and park the room. All of it is asked for in words: there are no buttons for any of it. The page's only control is STOP, which interrupts the running turn.

## Workers
- A Worker has one task at a time, keeps its desk saying where it stands, and reports to the Leader when done.
- Ask the Leader for help and it hires. A new Worker gets the next free name from a fixed list of thirty (Paul, Jane, Jack, …). The name cannot be chosen.
- A hire is refused while the usage window has reached its first threshold, or while the server is stopping.
- Stopping a Worker: it is told it is closing, writes its desk, and goes when its turn is over. Restarting: the same, then a new session starts from the desk. `hire` on a stopped Worker's name brings it back on the same desk, with its panel log kept.
- Letting a Worker go (retire): its desk is moved whole to `archive/`, its panel leaves the page, and its name is free again. Only a stopped Worker can be retired.

## Models and effort
- The Leader's and the Workers' default models are in `openovai.json`, set at install. Changing the Workers' default changes it for every Worker without a model of its own, from their next start.
- Ask the Leader to hire a Worker on another model, e.g. "sonnet" or "opus/low". The part after the slash is the reasoning effort (low, medium, high, xhigh, max). With none, Claude Code picks its own. The choice is kept in `desks/<Name>/MODEL`, and a later hire on that desk with a model replaces it.
- A running session keeps the model it started on. It changes at its next start.
- Fast mode (Claude Code's `/fast`: Opus answers faster at a higher price, billed from the account's usage credits) is off for the Leader and the Workers, whatever the person's own Claude Code setting says. It is off because ovai starts sessions on demand: at the command line fast mode applies to the one session in front of the person, but here ten Workers on fast mode could run up a large bill within minutes. It may come back later as a choice per Worker, beside its model and effort.

## Desks
`desks/<Name>/` is one seat's directory:
- `STATE.md` is the desk file. Its first line is a title and a status everyone sees; below that is what the session keeps. A new session on that desk starts from it: the conversation of the one before is gone.
- `conversation.json` is the panel, kept across restarts.
- `persona.md` is what the session was told at its start.

## Why a session stopped or went away
- Idle: a Worker nobody has spoken to is closed after 55 minutes idle, with the Leader told at 10 and 50. The Leader is asked to stop at 55 and ended at 60. A session working a long turn is not idle. The next message to the Leader starts it again; a Worker comes back with `hire` on its name.
- Usage window: at the first threshold (90% of the 5-hour window, 97% of the weekly one), hiring is refused. At the second (95%, 99%), Workers on that model are closed and turns are held until the window resets.
- Stopped or restarted by the Leader, or the room parked for the day.
- `ovai stop` parks the room: every Worker is closed, the Leader writes its desk, then the server stops. Nothing restarts Workers after `ovai start`. Desks and panels stay on disk; ask the Leader to bring back who is needed.
- A Worker's panel dims when its process ends, and is removed about 30 seconds later. The Leader's panel says "<Name> has left".

## Typing to a Worker
Typing on a Worker's panel speaks to that Worker directly. It answers, and the Leader is told what was said. A panel whose process is gone takes no typing.
