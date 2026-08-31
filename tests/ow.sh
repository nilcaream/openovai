#!/usr/bin/env bash
set -euo pipefail

# tests/ow.sh — check the instance command: what status reports, and what login hands over.
#
# Claude Code is never really run. The stand-in from helpers.sh answers `auth status` and
# `auth login`, so this checks our side of both: that status asks rather than guesses, that a
# signed-out instance says how to fix itself, and that a failed sign-in cannot look like a
# success.

readonly HUMAN=Mike
readonly LEADER=Superman
readonly MODEL=haiku
readonly PORT=7900

# shellcheck source=tests/helpers.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

instance=""
stand_in=""
cleanup() {
    [[ -n "${instance}" ]] && rm -rf "${instance}"
    [[ -n "${stand_in}" ]] && rm -rf "${stand_in}"
    return 0
}
trap cleanup EXIT

# Run the instance command with the stand-in first on the PATH, and with a credential in the
# environment that must not reach it.
ow() {
    OW_STAND_IN_LOG="${stand_in}/calls.txt" \
    ANTHROPIC_API_KEY=must-not-be-inherited \
    PATH="${stand_in}:${PATH}" \
        "${instance}/bin/ow" "$@"
}

main() {
    local repo log

    repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
    instance="${repo}/.tmp/ow-test-$$"
    stand_in="${instance}-stand-in"
    log="${stand_in}/calls.txt"

    rm -rf "${instance}" "${stand_in}"
    write_stand_in "${stand_in}"

    echo "Installing into ${instance}"
    "${repo}/install.sh" --root "${instance}" --source "${repo}" \
        --human "${HUMAN}" --leader "${LEADER}" \
        --leader-model "${MODEL}" --worker-model "${MODEL}" --port "${PORT}" >/dev/null

    echo "Checking what status reports"
    check "status does not name the human" "ow status | grep -q '${HUMAN}'"
    check "status does not name the leader and the model" "ow status | grep -q '${LEADER} (${MODEL})'"
    check "status does not show the port" "ow status | grep -q '${PORT}'"
    check "a signed-in instance is not reported as signed in" "ow status | grep -qE 'signed in +yes'"
    check "status did not ask Claude Code" "grep -q 'argv: auth status' '${log}'"

    echo "Checking a signed-out instance"
    check "a signed-out instance is not reported as signed out" \
        "OW_STAND_IN_SIGNED_IN=false ow status | grep -qE 'signed in +no'"
    check "a signed-out instance is not told how to fix itself" \
        "OW_STAND_IN_SIGNED_IN=false ow status | grep -q 'ow login'"

    echo "Checking the sign-in"
    check "login did not hand over to Claude Code" "ow login && grep -q 'argv: auth login' '${log}'"
    check "a failed sign-in looked like a success" "! OW_STAND_IN_LOGIN_STATUS=3 ow login"

    echo "Checking what Claude Code is run as"
    check "the instance's own Claude Code home was not used" \
        "grep -q 'CLAUDE_CONFIG_DIR: ${instance}/.claude-home' '${log}'"
    check "a credential in the environment reached Claude Code" \
        "! grep -q 'ANTHROPIC_API_KEY: must-not-be-inherited' '${log}'"

    echo "Checking what it refuses"
    check "an unknown command was accepted" "! ow nonsense"

    report
}

main "$@"
