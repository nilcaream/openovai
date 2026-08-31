#!/usr/bin/env bash
set -euo pipefail

# tests/ow.sh — check the instance command: what status reports, and what login hands over.
#
# Claude Code is never really run. The stand-in from helpers.sh answers `auth status` and
# `auth login`, so this checks our side of both: that status asks rather than guesses, that an
# instance without a credential says how to fix itself, and that a failed sign-in cannot look
# like a success.
#
# Two instances are installed, one for each way of signing in, because the difference between
# them is exactly what an instance is allowed to take from the environment it is started in.

readonly HUMAN=Mike
readonly LEADER=Superman
readonly MODEL=haiku
readonly PORT=7900
readonly TOKEN=a-machine-token

# shellcheck source=tests/helpers.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

instance=""
inherited=""
stand_in=""
cleanup() {
    [[ -n "${instance}" ]] && rm -rf "${instance}"
    [[ -n "${inherited}" ]] && rm -rf "${inherited}"
    [[ -n "${stand_in}" ]] && rm -rf "${stand_in}"
    return 0
}
trap cleanup EXIT

# Install an instance that signs in the given way.
install_instance() {
    local repo="${1}" root="${2}" auth="${3}"
    "${repo}/install.sh" --root "${root}" --source "${repo}" \
        --human "${HUMAN}" --leader "${LEADER}" \
        --leader-model "${MODEL}" --worker-model "${MODEL}" \
        --port "${PORT}" --auth "${auth}" >/dev/null
}

# Run an instance's command with the stand-in first on the PATH, and with both an account
# credential that must never be inherited and a machine token that may be, depending on how
# the instance was installed.
run_ow() {
    local root="${1}" log="${2}"
    shift 2
    # The token is left alone when the caller has already set it, so that a check can ask what
    # happens when the machine has none.
    OW_STAND_IN_LOG="${log}" \
    ANTHROPIC_API_KEY=must-not-be-inherited \
    CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN-${TOKEN}}" \
    PATH="${stand_in}:${PATH}" \
        "${root}/bin/ow" "$@"
}

# Each instance records its calls in its own file, so that what one of them was run with can
# never be read as evidence about the other.
ow() { run_ow "${instance}" "${stand_in}/calls.txt" "$@"; }
ow_inherited() { run_ow "${inherited}" "${stand_in}/inherited.txt" "$@"; }

main() {
    local repo log inherited_log

    repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
    instance="${repo}/.tmp/ow-test-$$"
    inherited="${instance}-inherited"
    stand_in="${instance}-stand-in"
    log="${stand_in}/calls.txt"
    inherited_log="${stand_in}/inherited.txt"

    rm -rf "${instance}" "${inherited}" "${stand_in}"
    write_stand_in "${stand_in}"

    echo "Installing into ${instance}"
    install_instance "${repo}" "${instance}" login
    install_instance "${repo}" "${inherited}" inherit

    # Claude Code owns this file and writes its own things into it. Put something there first,
    # so the checks below can tell recording the trust apart from replacing the file.
    cat > "${inherited}/.claude-home/.claude.json" <<'STATE'
{
  "somethingClaudeCodeWrote": "keep-me",
  "projects": {
    "/somewhere-else": {
      "hasTrustDialogAccepted": true
    }
  }
}
STATE

    echo "Checking what status reports"
    check "status does not name the human" "ow status | grep -q '${HUMAN}'"
    check "status does not name the leader and the model" "ow status | grep -q '${LEADER} (${MODEL})'"
    check "status does not show the port" "ow status | grep -q '${PORT}'"
    check "an instance with a credential is not reported as having one" \
        "ow status | grep -qE 'credential +there is one'"
    check "status claims the credential was checked against Anthropic" \
        "ow status | grep -q 'not checked against Anthropic'"
    check "status did not ask Claude Code" "grep -q 'argv: auth status' '${log}'"

    echo "Checking an instance with no credential"
    check "an instance with no credential is not reported as having none" \
        "OW_STAND_IN_SIGNED_IN=false ow status | grep -qE 'credential +none'"
    check "an instance with no credential is not told how to fix itself" \
        "OW_STAND_IN_SIGNED_IN=false ow status | grep -q 'ow login'"

    echo "Checking status says how the instance signs in"
    check "status does not say an instance signs itself in" \
        "ow status | grep -qE 'signs in by +an account of its own'"
    check "status does not name the variable an inheriting instance signs in with" \
        "ow_inherited status | grep -qE 'signs in by +CLAUDE_CODE_OAUTH_TOKEN'"
    check "status does not say the machine's token is there" \
        "ow_inherited status | grep -q 'which is set here'"
    check "status did not notice a missing machine token" \
        "CLAUDE_CODE_OAUTH_TOKEN= ow_inherited status | grep -q 'not set here'"
    check "status printed the value of the machine's token" \
        "! ow_inherited status | grep -q '${TOKEN}'"
    check "an inheriting instance is told to run a sign-in that would refuse it" \
        "! OW_STAND_IN_SIGNED_IN=false ow_inherited status | grep -q 'run: ow login'"

    echo "Checking the sign-in"
    check "login did not hand over to Claude Code" "ow login && grep -q 'argv: auth login' '${log}'"
    check "a failed sign-in looked like a success" "! OW_STAND_IN_LOGIN_STATUS=3 ow login"

    echo "Checking what Claude Code is run as"
    check "the instance's own Claude Code home was not used" \
        "grep -q 'CLAUDE_CONFIG_DIR: ${instance}/.claude-home' '${log}'"
    check "a credential in the environment reached Claude Code" \
        "! grep -q 'ANTHROPIC_API_KEY: must-not-be-inherited' '${log}'"

    echo "Checking the instance trusts its own directory"
    check "the instance's own directory is not recorded as trusted" \
        "node '${repo}/tests/check-trust.mjs' '${instance}/.claude-home/.claude.json' '${instance}'"
    check "recording it threw away what Claude Code had already written there" \
        "grep -q 'keep-me' '${inherited}/.claude-home/.claude.json'"
    check "recording it threw away another directory Claude Code had trusted" \
        "node '${repo}/tests/check-trust.mjs' '${inherited}/.claude-home/.claude.json' /somewhere-else"

    echo "Checking an instance that signs itself in ignores the machine's token"
    check "the machine's token reached an instance installed with --auth login" \
        "! grep -q 'CLAUDE_CODE_OAUTH_TOKEN: ${TOKEN}' '${log}'"

    echo "Checking an instance that inherits takes the machine's token"
    ow_inherited status >/dev/null
    check "the machine's token did not reach an instance installed with --auth inherit" \
        "grep -q 'CLAUDE_CODE_OAUTH_TOKEN: ${TOKEN}' '${inherited_log}'"
    check "an account credential reached an instance installed with --auth inherit" \
        "! grep -q 'ANTHROPIC_API_KEY: must-not-be-inherited' '${inherited_log}'"
    check "an instance that inherits still used its own Claude Code home" \
        "grep -q 'CLAUDE_CONFIG_DIR: ${inherited}/.claude-home' '${inherited_log}'"
    check "signing in an instance that inherits was not refused" "! ow_inherited login"
    check "the refusal does not say where a token comes from" \
        "{ ow_inherited login 2>&1 || true; } | grep -q 'setup-token'"

    echo "Checking what it refuses"
    check "an unknown command was accepted" "! ow nonsense"

    report
}

main "$@"
