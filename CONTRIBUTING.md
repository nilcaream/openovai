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
  shellcheck path/to/script.sh
  ```

  Silence a warning only with a `# shellcheck disable=SCxxxx` comment that says why on the
  line above.

## Documentation

A change in behaviour updates its documentation in the same commit. A pull request that
changes what a user sees and leaves the docs behind will be asked for the missing paragraph.

## Legal

No contributor licence agreement and no sign-off are required. Contributions are accepted
under the [MIT License](LICENSE), the same terms as the rest of the project.
