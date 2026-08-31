#!/usr/bin/env bash
set -euo pipefail

# install.sh — bootstrap for installing an office workspace instance.
#
# This script only checks that the machine is ready and then hands over to the installer,
# which is written in Node so that one implementation covers every platform we care about.
# Keeping the shell layer this thin means the only thing that can go wrong here is a missing
# prerequisite, and it says so in plain words.

readonly MIN_BASH_MAJOR=4

die() { echo "install.sh: ${*}" >&2; exit 1; }
warn() { echo "install.sh: warning: ${*}" >&2; }

main() {
    local script_dir installer

    if (( BASH_VERSINFO[0] < MIN_BASH_MAJOR )); then
        die "bash ${MIN_BASH_MAJOR} or newer is required, this shell is ${BASH_VERSION}"
    fi

    # Node.js is a prerequisite. We never hunt for it in a version manager's directories: it
    # has to be on the PATH of whoever runs the install, and that is the node the instance
    # will use.
    command -v node >/dev/null 2>&1 ||
        die "Node.js is required and is not on your PATH — install it, or load your version manager, then run this again"

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
