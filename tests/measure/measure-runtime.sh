#!/bin/sh
#
# measure-runtime.sh — what lib/runtime.sh assumes about a machine, asked of the machine.
#
#   sh tests/measure/measure-runtime.sh darwin|linux
#
# Run by the macOS and Windows workflows, which are started by hand. tests/ already runs
# lib/runtime.sh against a stand-in `uname`, a stand-in `shasum` and an archive made on the spot;
# this is the same script against the real nodejs.org, the real tar and the real checksum tool of the
# machine it runs on. A step that finds the assumption wrong stops the script with a line saying
# which one. Everything is fetched into XDG_DATA_HOME, which the caller sets to an empty directory
# of its own: the machine's own node, claude and data directory are not touched.

set -eu

fail() { printf 'MEASURED WRONG: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

expected="${1:-}"
[ "${expected}" = "darwin" ] || [ "${expected}" = "linux" ] || fail "usage: measure-runtime.sh darwin|linux"

repo="$(cd -- "$(dirname -- "$0")/../.." && pwd -P)"
runtime="${repo}/lib/runtime.sh"
shell="$(command -v sh)"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# The data directory is the caller's, so that what is fetched here is what the next script runs on.
# It has to start without a runtime in it, or the fetch below measures nothing.
: "${XDG_DATA_HOME:?XDG_DATA_HOME names the directory to fetch into}"
[ ! -e "${XDG_DATA_HOME}/openovai/node" ] || fail "${XDG_DATA_HOME}/openovai/node is already there, so nothing would be fetched"
export XDG_DATA_HOME

node_pin="$(sh "${runtime}" pin node)"
claude_pin="$(sh "${runtime}" pin claude)"
say "machine: $(uname -sm); node ${node_pin}; claude ${claude_pin}"
for tool in curl tar shasum sha256sum; do
    say "  ${tool}: $(command -v "${tool}" || echo 'not on the PATH')"
done

# 1. The platform words: the archive name nodejs.org publishes is built from them.
platform="$(sh "${runtime}" platform)"
case "${platform}" in
    "${expected}"-x64 | "${expected}"-arm64) say "platform: ${platform}" ;;
    *) fail "runtime.sh platform says \"${platform}\" on a machine that is ${expected}" ;;
esac
name="node-v${node_pin}-${platform}"
base="https://nodejs.org/dist/v${node_pin}"

# 2. The archive and its checksums, as nodejs.org serves them to curl.
mkdir -p "${work}/dist"
curl -fsSL -o "${work}/dist/${name}.tar.gz" "${base}/${name}.tar.gz" || fail "no ${base}/${name}.tar.gz: the archive name built from \"${platform}\" is not one nodejs.org publishes"
curl -fsSL -o "${work}/dist/SHASUMS256.txt" "${base}/SHASUMS256.txt" || fail "no ${base}/SHASUMS256.txt"
[ "$(grep -c "  ${name}.tar.gz\$" "${work}/dist/SHASUMS256.txt")" = "1" ] || fail "SHASUMS256.txt does not name ${name}.tar.gz on exactly one line"

# 3. The layout inside the archive, as this machine's tar lists it: lib/runtime.sh wants
#    <name>/bin/node, and the npm install after it wants <name>/bin/npm.
listing="${work}/listing"
tar -tzf "${work}/dist/${name}.tar.gz" >"${listing}" || fail "this machine's tar cannot list ${name}.tar.gz"
for member in bin/node bin/npm; do
    grep -qx "${name}/${member}" "${listing}" || fail "${name}.tar.gz has no ${name}/${member}; its layout is not the one runtime.sh unpacks"
done
say "archive layout: ${name}/bin/node and ${name}/bin/npm are there"

# 4. The checksum tool runtime.sh falls back to. `shasum -a 256 -c --status -` has to accept the
#    right line and refuse the same line over an archive that has one byte more.
if command -v shasum >/dev/null 2>&1; then
    (cd -- "${work}/dist" && grep "  ${name}.tar.gz\$" SHASUMS256.txt | shasum -a 256 -c --status -) ||
        fail "shasum -a 256 -c --status - refuses the genuine ${name}.tar.gz"
    mkdir -p "${work}/tampered"
    cp "${work}/dist/${name}.tar.gz" "${work}/tampered/${name}.tar.gz"
    printf 'x' >>"${work}/tampered/${name}.tar.gz"
    if (cd -- "${work}/tampered" && grep "  ${name}.tar.gz\$" "${work}/dist/SHASUMS256.txt" | shasum -a 256 -c --status -); then
        fail "shasum -a 256 -c --status - accepts an archive that is one byte longer than the published one"
    fi
    say "shasum: accepts the genuine archive, refuses a tampered one"

    # runtime.sh's own branch: a PATH with the tools verify uses and no sha256sum on it, whatever the
    # machine has, so the shasum branch runs here and not only on a machine without sha256sum.
    mkdir -p "${work}/only-shasum"
    for tool in grep dirname rm shasum; do
        ln -s "$(command -v "${tool}")" "${work}/only-shasum/${tool}"
    done
    [ -z "$(PATH="${work}/only-shasum" "${shell}" -c 'command -v sha256sum' || true)" ] || fail "sha256sum is still reachable on the restricted PATH"
    PATH="${work}/only-shasum" "${shell}" "${runtime}" verify "${work}/dist/${name}.tar.gz" "${work}/dist/SHASUMS256.txt" ||
        fail "runtime.sh verify, with shasum and no sha256sum, refuses the genuine archive"
    if PATH="${work}/only-shasum" "${shell}" "${runtime}" verify "${work}/tampered/${name}.tar.gz" "${work}/dist/SHASUMS256.txt" 2>/dev/null; then
        fail "runtime.sh verify, with shasum and no sha256sum, accepts a tampered archive"
    fi
    say "runtime.sh verify on shasum alone: accepts the genuine archive, refuses a tampered one"
else
    [ "${expected}" != "darwin" ] || fail "a Mac without shasum: runtime.sh has no checksum tool there"
    say "shasum: not on this machine, so its branch of runtime.sh is not measured here"
fi

# 5. The whole fetch, as an installer runs it: Node.js, then Claude Code through that node's npm.
sh "${runtime}" ensure
node_bin="$(sh "${runtime}" node-path)"
claude_bin="$(sh "${runtime}" claude-path)"
[ "$("${node_bin}" --version)" = "v${node_pin}" ] || fail "${node_bin} --version is not v${node_pin}"
claude_said="$("${claude_bin}" --version)" || fail "${claude_bin} --version did not run"
case "${claude_said}" in
    "${claude_pin}"*) ;;
    *) fail "${claude_bin} --version says \"${claude_said}\", not ${claude_pin}" ;;
esac
say "node ${node_pin} and claude ${claude_pin} run from ${XDG_DATA_HOME}/openovai"

# 6. A second ensure finds both and says nothing.
again="$(sh "${runtime}" ensure)"
[ -z "${again}" ] || fail "a second ensure printed \"${again}\" instead of nothing"
say "second ensure: silent"
