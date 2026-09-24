# Contributing

Thanks for looking. The toolkit is in early development — in daily use by the team that builds it,
and changing fast — so the most useful contribution is a clear issue: what you tried, what
happened, and what you expected.

## Getting a clone

```sh
git clone https://github.com/nilcaream/openovai.git
cd openovai
```

There is no build and no package yet.

## Language

English everywhere: code, comments, documentation, commit messages, issue and pull request
text.

## Branches

Branch off `main` and name the branch `<type>/<short-slug>`, using the same types as the
commits below — for example `feat/quota-gate` or `docs/quick-start`.

## Commits

**Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
This is required.**

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **type** — one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`.
- **scope** — optional, the part of the toolkit touched: `install`, `ovai`, `chat`, `knowledge`,
  `personas`, `docs`.
- **subject** — imperative mood, lower case, no trailing period, 72 characters or fewer.
  Write `feat(hooks): name a new worker session`, not `Added the naming hook.`
- **body** — optional. Explain why the change is needed, not what the diff already shows.
- **breaking change** — put `!` after the type or scope and add a `BREAKING CHANGE:` footer
  describing what a user has to do differently.

One logical change per commit.

## Shell scripts

- Start with `#!/usr/bin/env bash` and `set -euo pipefail`.
- Quote expansions; prefer `[[ ]]` over `[ ]`.
- Keep [ShellCheck](https://www.shellcheck.net/) clean. Continuous integration runs it over
  every tracked `*.sh` file, so run it locally first:

  ```sh
  shellcheck -x path/to/script.sh
  ```

  Silence a warning only with a `# shellcheck disable=SCxxxx` comment that says why on the
  line above.

## Tests

One suite per module, all on Node's own test runner, under `tests/`:

```sh
node --test tests/openovai.test.mjs         # resolve a release, fetch it once, hand over to its installer
node --test tests/install.test.mjs          # install an instance, check what came out
node --test tests/runtime.test.mjs          # where the toolkit's own node and claude are, and how they are fetched
node --test tests/ovai.test.mjs             # what status reports and what login hands over
node --test tests/start.test.mjs            # what has to be true on disk before an instance is served
node --test tests/chat.test.mjs             # serve the chat, talk to it, stop it
node --test tests/lifecycle.test.mjs        # start, tell, restart and stop the seats
node --test tests/lifecycle-quota.test.mjs  # hold what is written behind a spent window, release it at the reset
node --test tests/lifecycle-idle.test.mjs   # tell about an idle seat, ask it to stop, end it
node --test tests/lifecycle-stop.test.mjs   # stop, park and retire the seats, and stop the server
node --test tests/checkpoint.test.mjs       # count a Worker's calls to the Leader's checkpoint, and tell both
node --test tests/desks.test.mjs            # a desk is one directory, and filing it away is moving it
node --test tests/quota.test.mjs            # read the windows, stage them, hold at the gate
node --test tests/usage.test.mjs            # the account's usage windows, and when the page is told
node --test tests/permissions.test.mjs      # ask to be allowed, and answer
node --test tests/hook.test.mjs             # let a compound of allowed commands through, or do not
node --test tests/dialog.test.mjs           # show a question in the words it was asked in
node --test tests/frames.test.mjs           # frame what a session is told
node --test tests/secrets.test.mjs          # mint, resolve and revoke a secret
node --test tests/knowledge.test.mjs        # index and validate what the workspace knows
node --test tests/personas.test.mjs         # tell a Leader and a Worker only what is there
node --test tests/panels.test.mjs           # place the seats in three columns and keep their rows
node --test tests/page.test.mjs             # the stylesheet read as rules, one token table per theme
node --test tests/render.test.mjs           # draw a row as markdown, and nothing a row must not do
node --test tests/lines.test.mjs            # draw a tool call as the line its summary composes
node --test tests/log.test.mjs              # the server's log: one writer, one row shape
node --test tests/mask.test.mjs             # hide a secret's shape, and leave everything else byte for byte
node --test tests/update.test.mjs           # take a newer version from a release, and refuse to
node --test tests/tag.test.mjs              # what a release of this tree would be, and what it refuses to be
```

Run them all with `node --test tests/*.test.mjs`. Continuous integration runs each as a job of
its own, so a red one is named.

The update suite serves a release to itself — a directory for one already unpacked, and a local
HTTP server answering the shape GitHub answers in, with a real `.tar.gz` — so no check reaches the
network and no check needs a release to exist.

They need Node.js and nothing else. The install suite skips the checks that start an instance
when Claude Code is absent, and says it skipped them rather than passing quietly. The others
never run Claude Code at all: the stand-in in `tests/helpers.mjs` goes first on the PATH and
speaks the streaming protocol the way a session is run — one process, user frames in, result
frames out — so what gets checked is our side: the arguments a seat is started with, the frames
it is written, and what its panel says. It takes its behaviour from environment variables, so one
stand-in serves every suite.

They install into `.tmp/` inside the clone and clean up after themselves. Continuous
integration runs them when started by hand, and every release runs them before it publishes.

### Proving a check

A new check has to be shown failing before it is worth having: break the thing it is about, watch
that check go red and the unrelated ones stay green, then put the code back. A **mutation** is that
deliberate break, and `tests/mutate.mjs` runs a list of them for you — a sweep done by hand gets
the baseline, the bounds or the restore wrong in a different place every time, and each of those
mistakes reads like a finding about the suite.

```sh
node tests/mutate.mjs tests/mutations-dialog.json --suite tests/dialog.test.mjs
```

You write the list. It is JSON, and it lives beside the suite it is about:

```json
[
  {
    "name": "the dialog says what the call is for in the server's words",
    "catches": "carries the reason the session gave, verbatim, or none",
    "edits": [
      { "file": "lib/chat/dialog.mjs", "from": "  const reason = input[REASON_FIELD];", "to": "  const reason = \"for the task\";" }
    ]
  }
]
```

- **`name`** — what the mutation does, in the words you would say out loud.
- **`catches`** — the one check it was written to redden. A mutation that cannot name its check is
  a guess, and the sweep refuses a list without it.
- **`edits`** — applied in order to one copy of each file, so two edits to the same file cannot
  clobber each other. Every `from` has to match **exactly once**: none means the anchor is stale
  and the mutation never applied, more than one means it applied somewhere nobody meant.

Write the mutation before the check. A check written first and mutated afterwards is a check you
have already talked yourself into.

The sweep never writes to your clone. It lays down pinned copies of the tree — the committed tree
with your uncommitted work over it — runs the suite green on each copy first, then sweeps the
mutations across them in parallel. The suites wait far more than they compute, so the copies are
nearly free: two side by side finish in 113.2s against 111.4s for one alone. `--copies` sets how
many, four by default, bounded by memory rather than by cores.

What comes back, per mutation:

| verdict | what it means |
|---|---|
| `BIT` | the check named in `catches` went red. It is proven |
| `NOTHING NOTICED` | nothing went red — never "the code is fine". Dead code, a vacuous check, or a check nobody wrote, and which one has to be answered before moving on |
| `WRONG CHECK` | something went red, but not the one named. Another check already covers this |
| `HARNESS` | the mutation could not be applied. The list is wrong, not the suite |
| `TIMED OUT` | the run did not finish inside its bound, so nothing about it can be read |
| `UNREPORTABLE` | fewer checks ran than the baseline, so the suite died early. A short run with no failures looks exactly like a clean pass |

The last line of a finished run is `=== SWEEP COMPLETE ===`, and the exit code is 0 only when every
mutation bit its check and every copy was green again afterwards.

The sweep refuses to report at all on a baseline that is not green, a run that timed out, a run
that counted fewer checks than the baseline, or a clone that changed while the copies were being
made. Each of those is a sweep to throw away rather than a finding about the suite.

Run `node tests/mutate.mjs` with no arguments for the rest of the options.

## Releases

A release is a tag plus the source archive GitHub makes for it, and cutting one is a click:
**Actions -> Release -> Run workflow -> main**.

Everything it needs is already in the repository, so there is nothing to type into that form and
nothing to paste afterwards:

1. Put the new version in `lib/VERSION`.
2. Add a `## <version>` section to `NOTES.md` saying what changed for the Leader of a workspace
   taking it. The file keeps the older sections; the workflow publishes only the new one.
3. Merge both to `main`.
4. Run the workflow.

It reads `lib/VERSION`, tags that commit with `v<version>`, and publishes a release named for the
version whose body is that section of `NOTES.md`. It refuses, loudly and before anything is
tagged, when the version is not three numbers, when `v<version>` is already a tag, or when
`NOTES.md` says nothing about that version. The token is the one GitHub gives the run and
`contents: write` is the only permission it asks for, so there is nothing to set up and no
secret anywhere.

The deciding half lives in `.github/tag.mjs` rather than in the workflow, so it can be run and
checked without a runner:

```sh
node .github/tag.mjs            # what a release of this tree would be, or why there is not one
```

It is beside the workflow rather than in `lib/` because `lib/` is payload: it is copied into
every instance, and cutting a release is something this repository does rather than something an
instance does.

## Documentation

A change in behaviour updates its documentation in the same commit. A pull request that
changes what a user sees and leaves the docs behind will be asked for the missing paragraph.

## Legal

No contributor licence agreement and no sign-off are required. Contributions are accepted
under the [MIT License](LICENSE), the same terms as the rest of the project.
