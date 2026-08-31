# Contributing

Thanks for looking. The project is young, so the most useful contribution today is a clear
issue: what you tried, what happened, and what you expected.

## Getting a clone

```sh
git clone https://github.com/nilcaream/office-workspace.git
cd office-workspace
```

There is no build and no package yet.

## Language

English everywhere: code, comments, documentation, commit messages, issue and pull request
text.

## Branches

Branch off `main` and name the branch `<type>/<short-slug>`, using the same types as the
commits below — for example `feat/worker-launcher` or `docs/handover-flow`.

## Commits

**Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
This is required.**

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **type** — one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`.
- **scope** — optional, the part of the toolkit touched: `hooks`, `launchers`, `personas`,
  `skills`, `chat`, `docs`.
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

  `-x` lets it follow a `source` into a shared helper.

  Silence a warning only with a `# shellcheck disable=SCxxxx` comment that says why on the
  line above.

## Tests

Two so far:

```sh
node --test tests/install.test.mjs   # install an instance, check what came out
./tests/chat.sh       # serve the chat, talk to it, stop it
./tests/ow.sh         # what status reports and what login hands over
```

Both need Node.js and neither needs Claude Code. The install test skips the checks that start
an instance when Claude Code is absent, and says it skipped them rather than passing quietly.
The chat test never runs Claude Code at all: the stand-in in `tests/helpers.sh` goes first on
the PATH and answers in the shape the real one answers in, so what gets checked is our side —
the arguments the leader is run with, the thread being resumed, and what the transcript says
when Claude Code is missing. Anything else that needs Claude Code in a test uses that same
stand-in; it takes its behaviour from environment variables rather than being copied.

Both install into `.tmp/` inside the clone and clean up after themselves. Continuous
integration runs them on every push and pull request.

## Documentation

A change in behaviour updates its documentation in the same commit. A pull request that
changes what a user sees and leaves the docs behind will be asked for the missing paragraph.

## Legal

No contributor licence agreement and no sign-off are required. Contributions are accepted
under the [MIT License](LICENSE), the same terms as the rest of the project.
