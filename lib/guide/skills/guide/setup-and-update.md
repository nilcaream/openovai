# Setup and update

## Install
- Get the command once: `curl -fsSL https://raw.githubusercontent.com/nilcaream/openovai/main/openovai | sh`. It installs itself under `~/.local/share/openovai`, linked at `~/.local/bin/openovai`. If `~/.local/bin` is not on `PATH`, it prints the line to add to the shell profile. It never edits a profile.
- Run `openovai` to create an instance. It asks where the instance lives, who the team works for, who leads it, the Leader's and the Workers' models (Enter takes `opus` for the Leader and `sonnet` for the Workers), the port (Enter takes `0`, a free port picked at each start) and how it signs in. Each answer can also be given on the command line.
- With Node.js 24 or newer there is another way in: `npx @openovai/ovai@latest`. It asks the same questions and takes the same options, and creates the instance directly, so no `openovai` command is left behind. The release is the package, so nothing is downloaded for it; Node.js and Claude Code are fetched at the first `ovai start`. `@latest` is written out because npx reuses a copy it has cached for a name given with no version. `@openovai/ovai@<version>` names a release.
- The directory must be empty unless `--force` is given. Installing over an existing instance updates it.
- The `openovai` command downloads the release, checks its signature, and fetches the Node.js and Claude Code versions the release pins, into `~/.local/share/openovai`. That is about half a gigabyte, shared by every instance of the user, with no sudo.
- Linux or macOS, x86_64 or arm64. macOS is built for and checked with stand-ins on Linux, but ovai has not yet been run on a Mac. WSL 2 has not been tried, and native Windows is not supported. To try WSL 2, keep the instance off `/mnt/c`.

## Sign in to Claude
Chosen at install:
- `login`: the instance signs itself in once with `ovai login` and keeps the credential in its own Claude Code home. Two instances can be two different accounts.
- `inherit`: the instance takes `CLAUDE_CODE_OAUTH_TOKEN` from the environment it is started in. Mint the token once with `claude setup-token`; the full path is printed at install. The token cannot refresh itself: when it expires, every instance using it stops with the same message, and a new token fixes all of them.

`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from what an instance runs with.

## Commands
All are run from a terminal as `<instance>/bin/ovai <command>`:
- `start`: starts the server in the background and prints a one-time link to the page. When the server is already running, it says so and prints a fresh link.
- `stop`: stops the server. Every session is parked first.
- `restart`: stop, then start.
- `status`: whether the server is running, and where.
- `url`: a new one-time link for a browser.
- `configuration`: what the instance is. It shows the version, the runtime, who works here, the models, the port, and how it signs in.
- `login`: signs the instance in, in `login` mode.
- `claude`: admin mode (see slash-commands-and-admin-mode.md).
- `plugin <name>`: scaffolds a tool the instance serves itself (see mcp-and-plugins.md).
- `update`: see below.

## Getting into the page
- The link `start` or `url` prints works once, within ten minutes. Opening it signs that browser in with a cookie and takes it to the plain address.
- The cookie is renewed at every load and lasts 400 days. A closed tab is reopened at the plain address `http://127.0.0.1:<port>`, with no new link needed, across restarts and updates.
- For another browser, or after the cookie is gone, run `ovai url` for a new link.
- To sign every browser out, delete `page-session` in the instance directory.
- The page listens on 127.0.0.1 only.

## Update
- `ovai update` takes the latest signed release from GitHub. `--from <url or directory>` looks elsewhere. A git checkout is taken only on `main`, committed and clean, and its version is then the commit's first 8 characters.
- It refuses to go backwards unless `--downgrade` is given.
- Stop the server first. It refuses while the server or any session of the instance is running.
- It replaces `bin/` and `lib/` only. Desks, conversations, `knowledge/`, `customization/`, `plugins/`, `openovai.json`, the settings and the Claude Code home are left alone. It then seeds only files that are missing, and counts the permission rules that a fresh instance would have but this one lacks. It adds none of them: each is asked for on a permission popup on the Leader's panel at every start of the server, until the User presses the button for the list ovai recommends or Ignore.
- There is no rollback: taking an older release again with `--downgrade` is the fix, for a release that carries a signed package, which 0.21.0 and later do. 0.20.0 and earlier do not, so the updater refuses them from GitHub; `--from <directory>` of one still works.
- Claude Code's own updater is off. A newer Claude Code arrives with the next ovai release.
- After an update, the page shows the introduction once.

## Settings in openovai.json
To change a setting, ask the Leader: "raise the desk limit to 256 KB", "Workers on sonnet". It writes the file and the change applies at once. Editing the file by hand works too.

`openovai.json` holds the answers given at install, and any of these settings, each optional:
- `desk.limit`: the size in bytes a desk grows past before the server saves a copy and tells its session. 131072 (128 KB).
- `idle.fyi`: the two minutes of a Worker's idleness at which the Leader is told, `[10, 50]`. `idle.force`: the minutes idle at which a session is told to write its desk and stop, 55. `idle.all`: the minutes after which the Leader is told every Worker is idle, 1.
- `context.warning`, `context.step`, `context.error`: the context size in tokens at which a session is first told, the step it is told again at, and the size it wraps up at: 200000, 20000, 300000.
- `park.deadline`: the seconds the Leader's `park` gives when it names none, 1800. `park.timeout`: the seconds a server stop gives sessions to write their desks, 20. `park.margin`: the seconds `ovai stop` waits past that, 15.
- `typing.quiet`, `typing.cap`: the seconds after the last key in a panel's box that count as typing, and the longest a turn waits for them, 10 and 30; 0 turns either off.
- `quota["5h"]`, `quota["7d"]`: the two usage percentages, warning and critical, `[90, 95]` and `[97, 99]`. The weekly pair also holds each model's own weekly window.

All of them, and `models.leader` and `models.worker`, take effect while the server runs: the server reads the file again within about 5 seconds of a save, and tells the Leader the names of the keys that changed. A model applies from each session's next start; a running session keeps the one it started on.

`user`, `leader`, `port` and `auth` take effect only at `ovai restart`, and only by hand: the Leader does not change them. A save that changes them is told to the Leader as not applied.

A file that does not read as JSON changes nothing: the server goes on with what it had and tells the Leader, and tells it again once the file reads.

Sessions cannot edit `openovai.json`; a fresh instance denies it to their file tools, and the Leader changes it with a tool of its own. The rule names this instance's file only: another instance's, such as a test instance under `projects/`, stays editable. An instance made before 0.27.0 is asked for that rule on a permission popup.

## Two instances on one machine
Yes. They share the runtimes under `~/.local/share/openovai` and nothing else: not the account, not the transcripts, not the port. Give them different ports, or `0` each. If a fixed port is taken, install over the instance with `--force` and another `--port`.
