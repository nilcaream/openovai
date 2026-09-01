#!/usr/bin/env bash
set -euo pipefail

# install.sh — bootstrap for installing an office workspace instance.
#
# This script only checks that the machine is ready and then hands over to the installer,
# which is written in Node so that one implementation covers every platform we care about.
# Keeping the shell layer this thin means the only thing that can go wrong here is a missing
# prerequisite, and it says so in plain words.

readonly MIN_BASH_MAJOR=4

# The Node this toolkit is written against. Kept as a literal because install.sh is the one
# thing that runs before an instance exists, and it must say the same thing whether it was
# started from a clone or from an unpacked release. The other two places that name it are
# .node-version and the engines field of package.json.
readonly MIN_NODE_MAJOR=24

die() { echo "install.sh: ${*}" >&2; exit 1; }
warn() { echo "install.sh: warning: ${*}" >&2; }

main() {
    local script_dir installer node_version node_major

    if (( BASH_VERSINFO[0] < MIN_BASH_MAJOR )); then
        die "bash ${MIN_BASH_MAJOR} or newer is required, this shell is ${BASH_VERSION}"
    fi

    # Node.js is a prerequisite. We never hunt for it in a version manager's directories: it
    # has to be on the PATH of whoever runs the install, and that is the node the instance
    # will use.
    command -v node >/dev/null 2>&1 ||
        die "Node.js is required and is not on your PATH — install it, or load your version manager, then run this again"

    # An older Node reads a different language: it stops on syntax the toolkit uses freely.
    # Refusing here, in one line, beats an instance that installs and then fails at its first
    # message with a parse error nobody can place.
    node_version="$(node --version 2>/dev/null || true)"
    node_major="${node_version#v}"
    node_major="${node_major%%.*}"
    if [[ ! "${node_major}" =~ ^[0-9]+$ ]] || (( node_major < MIN_NODE_MAJOR )); then
        die "Node.js ${MIN_NODE_MAJOR} or newer is required, this one is ${node_version:-unreadable}"
    fi

    # Claude Code is a prerequisite too, but only to run an instance, not to create one. A
    # missing binary must not stop an install on a machine that is still being set up.
    command -v claude >/dev/null 2>&1 ||
        warn "Claude Code is not on your PATH; the instance will install, but no session can start until 'claude' is available"

    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
    installer="${script_dir}/tools/install.mjs"
    [[ -f "${installer}" ]] || die "the installer is missing at ${installer}"

    exec node "${installer}" "$@"
}

main "$@"
