#!/bin/sh
#
# measure-instance.sh — install an instance from this checkout, start its server, open its page
# with the one-time link, stop it: the path a person takes, on the real machine.
#
#   sh tests/measure/measure-instance.sh [windows]
#
# Run by the macOS and Windows workflows, which are started by hand, after measure-runtime.sh has
# fetched the runtimes into XDG_DATA_HOME. No Claude sign-in is involved: the page is served and
# opened, no session is started. With `windows`, the first request for the page is made by a
# Windows program (curl.exe) started from inside WSL, so it reaches 127.0.0.1 from the Windows
# side of the machine, which is where a person's browser is.

set -eu

fail() { printf 'MEASURED WRONG: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

from_windows=no
[ "${1:-}" != "windows" ] || from_windows=yes

repo="$(cd -- "$(dirname -- "$0")/../.." && pwd -P)"
: "${XDG_DATA_HOME:?XDG_DATA_HOME names the directory the runtimes were fetched into}"

work="$(mktemp -d)"
root="${work}/instance"
case "${root}" in
    /mnt/*) fail "the instance would sit under ${root}, on a Windows drive; the README says to keep it off /mnt" ;;
esac
trap 'sh "${root}/bin/ovai" stop >/dev/null 2>&1 || true; rm -rf "${work}"' EXIT

sh "${repo}/install.sh" --root "${root}" --source "${repo}" --user Mike --leader Martin \
    --leader-model sonnet --worker-model haiku --port 0 --auth login >"${work}/install.log" 2>&1 ||
    { cat "${work}/install.log" >&2; fail "install.sh failed on this machine"; }
say "installed into ${root}"

ovai() { sh "${root}/bin/ovai" "$@"; }

[ "$(ovai status || true)" = "not running" ] || fail "ovai status before start is not \"not running\""
ovai start >"${work}/start.log" 2>&1 || { cat "${work}/start.log" >&2; fail "ovai start failed"; }
link="$(ovai url)"
case "${link}" in
    http://127.0.0.1:*/\?token=*) ;;
    *) fail "ovai url printed \"${link}\", not a link to 127.0.0.1" ;;
esac
say "serving: ${link%%\?*}"

status="$(ovai status || true)"
case "${status}" in
    "not running" | "") fail "ovai status says \"${status}\" with the server started" ;;
esac

# The first link is used from the side the person's browser is on; a link opens once, so the
# second request takes a new one.
if [ "${from_windows}" = "yes" ]; then
    command -v curl.exe >/dev/null 2>&1 || fail "no curl.exe reachable from WSL: Windows programs cannot be started from here"
    code="$(curl.exe -sS -o NUL -w '%{http_code}' --max-time 30 "${link}" || echo "failed")"
    [ "${code}" = "303" ] || fail "a Windows request for ${link%%\?*} got \"${code}\", not 303: the server's 127.0.0.1 port is not reached from the Windows side"
    say "Windows side: curl.exe reached ${link%%\?*} and was signed in (303)"
    link="$(ovai url)"
fi

code="$(curl -sS -o /dev/null -c "${work}/jar" -w '%{http_code}' --max-time 30 "${link}")" || fail "curl could not reach ${link%%\?*}"
[ "${code}" = "303" ] || fail "the one-time link answered ${code}, not 303"
page="$(curl -sS -o /dev/null -b "${work}/jar" -w '%{http_code}' --max-time 30 "${link%%\?*}")" || fail "curl could not fetch the page"
[ "${page}" = "200" ] || fail "the page with the session cookie answered ${page}, not 200"
say "same side: signed in with the link (303), the page answers 200"

ovai stop >/dev/null || fail "ovai stop failed"
[ "$(ovai status || true)" = "not running" ] || fail "ovai status after stop is not \"not running\""
if curl -sS -o /dev/null --max-time 5 "${link%%\?*}" 2>/dev/null; then
    fail "the server still answers after ovai stop"
fi
say "ovai stop: the server is gone"
