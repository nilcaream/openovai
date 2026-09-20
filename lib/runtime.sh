#!/bin/sh
#
# runtime.sh — the toolkit's own Node.js and Claude Code, fetched once per user and shared.
#
# This is the one piece of the toolkit that runs before any node exists, which is why it is POSIX
# sh and needs nothing beyond sh, curl or wget, tar, sha256sum and uname. It reads the exact
# versions from lib/RUNTIME beside it, keeps the runtimes under the XDG data directory, and never
# looks at, uses or changes a node, npm or claude the machine already has.
#
#   runtime.sh ensure        fetch whatever is missing, say what is reused; nothing to do is fine
#   runtime.sh node-path     print the absolute path of the node binary this version runs on
#   runtime.sh npm-path      the npm that came with it
#   runtime.sh claude-path   the claude command
#   runtime.sh data-dir      where all of it lives
#   runtime.sh platform      what this machine is, in the words nodejs.org uses (linux-x64)
#   runtime.sh pin NAME      the exact version of NAME (node or claude) from lib/RUNTIME
#   runtime.sh verify ARCHIVE SUMS   check ARCHIVE against the line naming it in SUMS
#
# The paths are printed whether or not what they name is there yet: `ensure` is what makes them
# true, and the two are kept apart so that a launcher can ask where node is without fetching it.
# Nothing here ever runs the claude command: this script fetches it and says where it is.
#
# Two instances may run `ensure` at the same moment with the same pin. Each works in a temporary
# directory of its own and moves the finished runtime into place with one rename, so a half-fetched
# runtime is never at the place another instance looks; whoever comes second finds it there and
# throws its own copy away.

set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'runtime.sh: %s\n' "$*" >&2; exit 1; }

# Where the exact versions are read from: the RUNTIME file beside this script, so a clone, an
# unpacked release and an installed instance all answer from the file they carry.
here="$(cd -- "$(dirname -- "$0")" && pwd -P)"
pin_file="${here}/RUNTIME"

# Where the runtimes live. The XDG Base Directory spec: $XDG_DATA_HOME, and ~/.local/share when it
# is unset or empty. Data rather than config, because nothing in it is anybody's setting.
data_dir() {
    printf '%s/openovai\n' "${XDG_DATA_HOME:-${HOME}/.local/share}"
}

# The one platform the toolkit runs on, in the words nodejs.org names its archives with. Anything
# else is refused in one line rather than fetched and found not to run.
platform() {
    system="$(uname -s)"
    machine="$(uname -m)"
    [ "${system}" = "Linux" ] || die "only Linux is supported, and this is ${system}"
    case "${machine}" in
        x86_64) printf 'linux-x64\n' ;;
        aarch64 | arm64) printf 'linux-arm64\n' ;;
        *) die "only x86_64 and arm64 are supported, and this machine is ${machine}" ;;
    esac
}

# The exact version pinned for NAME. The file is one name and one version per line; anything else
# in it is a mistake in the file, and a version that is not three numbers is refused rather than
# put into a URL.
pin() {
    name="$1"
    [ -f "${pin_file}" ] || die "${pin_file} is missing, so there is no ${name} version to fetch"
    found="$(sed -n "s/^${name} //p" "${pin_file}")"
    if [ "$(printf '%s\n' "${found}" | wc -l)" -ne 1 ] || ! printf '%s\n' "${found}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        die "${pin_file} does not pin ${name} to one version like 1.2.3 (got \"${found}\")"
    fi
    printf '%s\n' "${found}"
}

node_dir() { printf '%s/node/%s\n' "$(data_dir)" "$(pin node)"; }
claude_dir() { printf '%s/claude/%s\n' "$(data_dir)" "$(pin claude)"; }

node_path() { printf '%s/bin/node\n' "$(node_dir)"; }
npm_path() { printf '%s/bin/npm\n' "$(node_dir)"; }
claude_path() { printf '%s/bin/claude\n' "$(claude_dir)"; }

# curl or wget, whichever is there. Quiet on success, and on failure the URL is in the message.
fetch() {
    url="$1"
    into="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -o "${into}" "${url}" || die "could not download ${url}"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "${into}" "${url}" || die "could not download ${url}"
    else
        die "curl or wget is required to download ${url}, and neither is on your PATH"
    fi
}

# ARCHIVE against the one line of SUMS that names it. The file is the SHASUMS256.txt nodejs.org
# publishes beside every release: a checksum, two spaces, a file name. Exactly one line has to name
# the archive, or nothing was verified.
verify() {
    archive="$1"
    sums="$2"
    archive_name="${archive##*/}"
    archive_dir="$(dirname -- "${archive}")"
    lines="$(grep -c "  ${archive_name}\$" "${sums}" || true)"
    [ "${lines}" = "1" ] || die "${sums} has ${lines} lines naming ${archive_name}, not one; nothing was verified"
    (cd -- "${archive_dir}" && grep "  ${archive_name}\$" "${sums}" | sha256sum -c --status -) ||
        die "${archive_name} does not match its checksum in ${sums##*/}; the download is corrupt or tampered with"
}

# Where a fetch works before its result is moved into place: under the data directory, so the final
# rename never crosses a file system, and named for this process, so two fetches never share one.
workspace() {
    where="$(data_dir)/tmp/$1.$$"
    rm -rf "${where}"
    mkdir -p "${where}"
    printf '%s\n' "${where}"
}

# A fetch that fails leaves nothing behind: the working directory goes when the script exits, and
# only the finished, verified runtime is ever at the place the next run looks.
cleanup() {
    rm -rf "${work-}"
}
trap cleanup EXIT

# Move a finished runtime to its place, or throw it away when another instance got there first.
# `mv` of a directory to a name that is not taken is one rename. If the name IS taken by then, mv
# would move the directory inside it, so that is checked first and, for the sliver of time between
# the check and the rename, cleaned up after: what a losing rename leaves is a copy nested under the
# winner's, and it is removed.
settle() {
    finished="$1"
    target="$2"
    work="$3"
    mkdir -p "$(dirname -- "${target}")"
    if [ ! -e "${target}" ]; then
        mv "${finished}" "${target}" 2>/dev/null || true
    fi
    rm -rf "${target}/${finished##*/}"
    rm -rf "${work}"
}

# The official archive for the pinned version and this platform, from nodejs.org unless
# OPENOVAI_NODE_DIST says where else (a mirror, or a directory served for a test), verified against
# the SHASUMS256.txt published beside it. The archive ships npm, so both arrive together.
ensure_node() {
    version="$(pin node)"
    target="$(node_dir)"
    binary="${target}/bin/node"

    if [ -e "${target}" ]; then
        if [ -x "${binary}" ] && [ "$("${binary}" --version 2>/dev/null || true)" = "v${version}" ]; then
            say "Node.js ${version} already in ${target}"
            return 0
        fi
        die "${target} is there but ${binary} does not run as Node.js ${version}; remove the directory and run this again"
    fi

    where="$(platform)"
    name="node-v${version}-${where}"
    base="${OPENOVAI_NODE_DIST:-https://nodejs.org/dist}/v${version}"
    work="$(workspace "node-${version}")"

    say "Fetching Node.js ${version} (${where}) from ${base} into ${target}"
    fetch "${base}/${name}.tar.gz" "${work}/${name}.tar.gz"
    fetch "${base}/SHASUMS256.txt" "${work}/SHASUMS256.txt"
    verify "${work}/${name}.tar.gz" "${work}/SHASUMS256.txt"
    mkdir -p "${work}/unpacked"
    tar -xzf "${work}/${name}.tar.gz" -C "${work}/unpacked" || die "${name}.tar.gz could not be opened"
    [ -x "${work}/unpacked/${name}/bin/node" ] || die "${name}.tar.gz holds no ${name}/bin/node"

    settle "${work}/unpacked/${name}" "${target}" "${work}"
    [ -x "${binary}" ] || die "${binary} is not there after the fetch"
    say "Node.js ${version} in ${target}"
}

# Claude Code, installed by the npm that came with the toolkit's own node, into a prefix of its own
# under the data directory. That node is put on the PATH for this one command and nothing else, so
# the install is the same whatever the machine has. npm's cache goes under the data directory too:
# a tool that promises to keep to one place keeps to it.
ensure_claude() {
    version="$(pin claude)"
    target="$(claude_dir)"
    command_path="${target}/bin/claude"

    if [ -e "${target}" ]; then
        [ -x "${command_path}" ] ||
            die "${target} is there but ${command_path} is not runnable; remove the directory and run this again"
        say "Claude Code ${version} already in ${target}"
        return 0
    fi

    node_bin="$(node_dir)/bin"
    [ -x "${node_bin}/npm" ] || die "${node_bin}/npm is missing; Node.js has to be fetched before Claude Code"
    work="$(workspace "claude-${version}")"
    mkdir -p "${work}/prefix"

    say "Installing Claude Code ${version} with ${node_bin}/npm into ${target}"
    PATH="${node_bin}:${PATH}" npm_config_cache="$(data_dir)/npm-cache" npm_config_update_notifier=false \
        "${node_bin}/npm" install --global --prefix "${work}/prefix" --no-fund --no-audit --loglevel=error \
        "@anthropic-ai/claude-code@${version}" ||
        die "npm could not install @anthropic-ai/claude-code@${version}"
    [ -x "${work}/prefix/bin/claude" ] || die "npm installed @anthropic-ai/claude-code@${version} but left no bin/claude"

    settle "${work}/prefix" "${target}" "${work}"
    [ -x "${command_path}" ] || die "${command_path} is not there after the install"
    say "Claude Code ${version} in ${target}"
}

case "${1-}" in
    ensure) ensure_node; ensure_claude ;;
    node-path) node_path ;;
    npm-path) npm_path ;;
    claude-path) claude_path ;;
    data-dir) data_dir ;;
    platform) platform ;;
    pin) [ $# -eq 2 ] || die "pin takes one name: node or claude"; pin "$2" ;;
    verify) [ $# -eq 3 ] || die "verify takes an archive and a checksum file"; verify "$2" "$3" ;;
    "") die "a command is required: ensure, node-path, npm-path, claude-path, data-dir, platform, pin NAME, verify ARCHIVE SUMS" ;;
    *) die "unknown command: $1" ;;
esac
