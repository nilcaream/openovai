#!/bin/sh
#
# install.sh — bootstrap for installing an OpenOv AI instance.
#
# This script fetches the toolkit's own Node.js and Claude Code, if this user has not got them
# yet, and hands over to the installer, which is written in Node so that one implementation covers
# everything after this line. Keeping the shell layer this thin means the only thing that can go
# wrong here is a fetch, and lib/runtime.sh says so in plain words.
#
# POSIX sh: it runs before any node exists, and the machine owes it nothing more than lib/runtime.sh
# needs — sh, curl or wget, tar, sha256sum and uname. Nothing of the machine's own node or claude is
# looked at, used or changed.

set -eu

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
runtime="${script_dir}/lib/runtime.sh"
installer="${script_dir}/lib/install.mjs"

[ -f "${runtime}" ] || die "the runtime bootstrap is missing at ${runtime}"
[ -f "${installer}" ] || die "the installer is missing at ${installer}"

# The runtimes this source tree pins, from the tree itself: a clone and an unpacked release both
# carry lib/RUNTIME, and the instance made from either runs on exactly what it says.
sh "${runtime}" ensure || die "the runtime could not be fetched, so nothing can be installed"

exec "$(sh "${runtime}" node-path)" "${installer}" "$@"
