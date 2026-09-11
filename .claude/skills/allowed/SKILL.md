---
name: allowed
description: Say what this workspace is allowed to do, by reading the files that decide it, in this turn. Use it whenever anyone asks what a session may do here, what is denied, whether a rule is in force, why a call stopped or did not stop, or when a change to the settings, a persona or the toolkit takes effect.
---

# What this workspace allows, read rather than remembered

This file is the toolkit's, and taking a newer toolkit replaces it. An edit made to it here lasts
until the next update and no longer: what it says about the runtime is measured, and the
measurement travels with the version.

This is a procedure and not an answer. The answer is in files, the files change, and the person
asking gave up the panel and the command line they would otherwise have read them with.

## Four rules, and none of them is optional

**Read now, in this turn.** Never answer from the conversation, from what a persona says, from
what this workspace allowed the last time anyone asked, or from a run of this procedure earlier
today. The files are the answer and they are cheap to open.

**A read that fails is a line in the report, never the end of it.** Most of the paths below are
ones this instance does not own and usually has not got. *"I could not read this one"* is a
truthful line in a report; a report that does not arrive is not one. Name the hole where it is and
write the rest.

**Every claim carries `path:line` and the line as it reads.** A rule quoted without its line is a
rule somebody remembered.

**Never merge what is written with what is honoured.** A file can hold a rule the runtime is not
applying. That gap is the reason this procedure exists, and it is block F.

## What to read, highest precedence first

1. `/etc/claude-code/managed-settings.json` — an organisation's policy. It outranks everything
   this instance owns and this instance did not write it. On most machines it is not there, which
   is one word in the report and not a reason to stop.
2. The command line the chat starts a session with: `tools/chat/session.mjs`, where the arguments
   are built. It is fixed by the toolkit rather than by configuration, and it is the one input a
   person cannot see from any file. Report `--print`, `--permission-prompt-tool stdio`, the model,
   and whether a `--permission-mode` is passed at all. Report `--settings chat/instructions.json`
   too: the list of instructions above the instance that a session is NOT to read travels with the
   run, in a document the chat writes for itself, and is not in the instance's settings.
3. `.claude/settings.local.json` — nothing here writes it. If it is there, somebody put it there
   by hand, and it outranks the instance's own.
4. `.claude/settings.json` — the instance's own.
5. `.claude-home/settings.json` — the account-level settings this instance keeps for itself.
   `autoContinueAtUsageLimit` lives here, and permissions can.
6. `.claude/allowed.md` — not a settings file. It is the *why* behind every rule beyond a desk:
   who asked, when, and what for.

That precedence order — managed, then the command line, then local, then the instance's own, then
the account's — is Claude Code's documented one and is **not measured here**. So report each value
**with the file it came from** rather than a computed winner. A reader who disagrees about
precedence can still see every input, and nothing in the report depends on the order being right.

## The report: seven blocks, in this order

The letters are the shape. Each block appears once, and every one of them appears even when the
answer is one word.

### A. How this instance decides

The permission mode, and where it came from — a `defaultMode` key with its `path:line`, or *"no
key in any of these files, so Claude Code's default"*. Where a call that stops goes:
`--permission-prompt-tool stdio` means the panel the person is looking at. One line saying that
`claudeMdExcludes` is not in that file but handed to each run (`chat/instructions.json`), decides
what instructions a session reads, and is not a permission.

And one line for **hooks**: whether any `hooks` entry exists in the files just read, and if so,
which events it fires on and what it runs, each with its `path:line`. A hook is shell that runs on
a tool event **with no permission decision at all** — neither a rule nor the working directory of
block E — and nothing in blocks B through F would ever mention it. A report on what an instance may do that leaves out
the one mechanism able to run a command without being asked is not a report. Name what is
configured; do not read the script and say what it would do.

### B. Denied

Every `permissions.deny` entry with its `path:line`. If there are none: *"nothing is denied"*,
said plainly, because an absence a person has to infer is one they will infer wrongly.

A deny rule is honoured wherever the file holding it is read at all. It is not stripped in any
mode, it survives a workspace nobody has trusted where `allow` does not, it beats
`bypassPermissions`, and it beats the frame's own handling of read-only shell commands. The same
is true of `ask`, and say so in the same breath: an `ask` entry also survives an untrusted
workspace and also overrides a bypass.

**And the sentence that keeps this block from lying: a rule binds the tools its matcher names, and
no others.** `Edit(...)` governs every built-in tool that writes a file, the Write tool included,
and nothing else. A shell command is not one of those tools. So `Edit(<path>)` in the deny list
stops every file-writing tool from reaching that path and **does not stop a shell command from
reaching it**.

**The check that follows, which is not optional.** When the deny list names a path, cross it
against the allow list and say whether any granted **shell** rule reaches that same path. If one
does, name the pair in one line and do not soften it: *"`Bash(sed:*)` reaches the paths
`Edit(.claude/**)` protects"*. An instance telling a competent person it cannot widen its own
permissions, while the rule that lets it do so sits three lines above in the same file, is the
exact failure this whole procedure exists to prevent.

### C. Allowed

Every `permissions.allow` entry with its `path:line`, and beside it the line from
`.claude/allowed.md` that accounts for it — or **"nothing accounts for this rule"**, which a
person should hear before they hear anything reassuring.

### D. Everything else asks — and some calls never do

Any other tool call stops the session and waits on the person's panel, for as long as that takes.

Then the part that costs people their assumptions: **some calls never stop, so no rule is ever
offered for them.** Claude Code settles read-only shell commands itself — a listing, a read, a
status return without parking, where a delete or a write parks. This class is out of reach of
`allow`; it is **not** out of reach of `deny`. A deny rule refuses one of these commands in a
workspace that is trusted and in one that is not. So "never stops" describes what a person is
never *asked* about, and says nothing about what they can forbid.

### E. The other mechanism: the working directory

Claude Code confines the file tools to the session's working directories on its own and refuses
outside them **with no permission rule involved and no permission decision to point at** — its own
wording, not a rule's. Three sentences: name it, say it is not the rules, and say the consequence
— **this report may not claim a write will be allowed on rule evidence alone.** It may say a rule
permits it. Whether the working directory also permits it is a second question the rules cannot
answer.

### F. Written, and not honoured

The block the whole procedure is for. Four checks, each with a verdict and the evidence in the
line.

**Trust.** Claude Code trusts by the enclosing git repository, not by the directory. So: is this
instance inside a repository, and if it is, is the top level the instance root? Look the path up
in `.claude-home/.claude.json` under `projects[<path>].hasTrustDialogAccepted`. Not `true` →
**every `permissions.allow` entry in the instance's settings is ignored, and only the allow
entries**: `deny` and `ask` in the same file go on applying. An untrusted instance is not an
instance with no rules; it is one that can still forbid and can no longer permit.

**Say plainly, in the report, that this check is our reconstruction and not the runtime speaking,
and mark it Assumes.** The runtime states it exactly once, on stderr —
`Ignoring N permissions.allow entry from .claude/settings.json: this workspace has not been trusted.`
— and nothing here reads that line. What this procedure has instead are two measured facts, trust
by the enclosing repository and the trust record being that key, from which it *infers* what the
runtime will do. The inference is good and it is still an inference. This whole feature exists
because a file can lie about what the runtime honours; a check that quietly read as measured would
be that same failure one level up. The wording is not decoration and it is not yours to soften.
The signal is also asymmetric: that line counts only the *ignored allows*, so a file with no allow
entries produces no line either way, and silence would never have been proof that anything was
read.

**The file parses.** Every session here is a `--print` session, and a settings file that fails
validation is silently ignored in that mode — no error, nowhere. So a file that does not parse
grants nothing and complains to nobody. Parse each file read and say so.

**Mode-dependent stripping.** *Only when block A says the mode is `auto`.* Otherwise skip it and
say it was skipped. In auto mode the frame filters `permissions.allow` through a dangerousness
test before matching and drops what it dislikes, silently: a bare `Bash`, `Bash(*)`, and
`Bash(<interpreter> …)` where what follows is empty, a flag or a star and the interpreter is one
of `python python3 python2 node deno tsx ruby perl php lua npx bunx "npm run" "yarn run"
"pnpm run" "bun run" bash sh ssh zsh fish eval exec env xargs sudo`. A rule whose remainder is a
path survives. Deny and ask are never filtered. This was measured on one bundle and is
version-sensitive: print `claude --version` beside it, and where the version differs, label the
check *unverified on this version* rather than asserting it.

**Rules that cannot match here.** A rule anchored outside the instance, or spelled differently
from the call it is meant to cover. Matching is by path segment with no normalisation, and a
command rule is a literal prefix rather than a pattern, so a rule for one spelling of a command
does not cover another.

### G. When a change takes effect, and for whom

Every turn is a fresh `claude` process — `ask()` in `tools/chat/session.mjs` spawns one per turn
and resumes the conversation. Almost everything follows from that:

- **A change to `.claude/settings.json` is honoured from each session's next turn.** No restart
  and nobody has to be hired again. *Measured*: the process per turn. *Assumes*: that a fresh
  process reads its settings at start.
- **A session nobody asks anything again is never affected.** There is no turn in which to read
  the file.
- **A change to the toolkit needs the chat restarted**, because a process keeps the code it
  started with. An update refuses while the chat, or any session of this instance, is running.
- **`claudeMdExcludes` is written for every run**, into `chat/instructions.json`, from where the
  instance sits now; a copy of that key in `.claude/settings.json` is the person's — an older
  toolkit wrote one there — and is neither read for this nor removed.
- **A rule pressed on the panel applies from the next call.** The rule and its line in the ledger
  are written in one act, into the file the next process reads.

**And the exception, which is not a footnote.**

> A resumed conversation keeps what it has already read, and the appended system prompt survives a
> resume. So tightening a persona is additive in effect until a handover replaces the
> conversation.

Removing an instruction does not remove it from a running session: the session read it, and the
transcript it resumes from still carries it. The persona file is passed again on every turn, so
from the moment it is edited the session carries **both** texts — the new one it is handed and the
old one its conversation remembers. A person who tightens a rule and watches the session go on
behaving the old way is not looking at a bug and is not looking at a session that ignored them.
What clears it is replacing the conversation. Say that in the same breath.

## What this report does not do

It does not name rules the person could usefully press next. It is a report, not advice, and a
lead suggesting rules is a lead improvising grants. It does not read a hook script and say what it
would do. It does not describe models, cadences, personas or the roster — that is a neighbouring
question and this one is *what may be done here*. And it keeps nothing: there is no stored copy of
the answer to disagree with the next read.
