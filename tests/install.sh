#!/usr/bin/env bash
set -euo pipefail

# tests/install.sh — install an instance, check it is the one that was asked for, remove it.
#
# It needs Node.js and nothing else. Claude Code is only needed to run an instance, so the
# checks that would start one are skipped when it is not installed, and the test still says
# what it did.

readonly HUMAN=Mike
readonly LEADER=Superman
readonly LEADER_MODEL=sonnet
readonly WORKER_MODEL=haiku
readonly PORT=7801
readonly AUTH=inherit

# shellcheck source=tests/helpers.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

# The instance is removed however this run ends, so the trap has to see it from outside main.
instance=""
chosen=""
cleanup() {
    [[ -n "${instance}" ]] && rm -rf "${instance}"
    [[ -n "${chosen}" ]] && rm -rf "${chosen}"
    return 0
}
trap cleanup EXIT

main() {
    local repo

    repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
    # Scratch lives inside the repository, where .gitignore already covers it, so a failed run
    # leaves its evidence somewhere obvious instead of somewhere shared.
    instance="${repo}/.tmp/install-test-$$"

    rm -rf "${instance}"

    echo "Installing into ${instance}"
    "${repo}/install.sh" \
        --root "${instance}" \
        --source "${repo}" \
        --human "${HUMAN}" \
        --leader "${LEADER}" \
        --leader-model "${LEADER_MODEL}" \
        --worker-model "${WORKER_MODEL}" \
        --port "${PORT}" \
        --auth "${AUTH}" >/dev/null

    echo "Checking what it made"
    check "ow.json is missing" "[[ -f '${instance}/ow.json' ]]"
    check "the launcher is missing" "[[ -f '${instance}/bin/ow' ]]"
    check "the launcher is not executable" "[[ -x '${instance}/bin/ow' ]]"
    check "the installer was not copied in" "[[ -f '${instance}/tools/install.mjs' ]]"
    check "the instance command was not copied in" "[[ -f '${instance}/tools/ow.mjs' ]]"
    check "the desk template was not copied in" "[[ -f '${instance}/templates/STATE.md' ]]"
    check "the settings directory is missing" "[[ -d '${instance}/.claude' ]]"
    check "the Claude Code home is missing" "[[ -d '${instance}/.claude-home' ]]"
    check "the leader has no desk" "[[ -f '${instance}/work/${LEADER}/STATE.md' ]]"
    check "the desk does not name the leader" "grep -q 'name: ${LEADER}' '${instance}/work/${LEADER}/STATE.md'"
    check "the desk still holds an unfilled placeholder" \
        "[[ -f '${instance}/work/${LEADER}/STATE.md' ]] && ! grep -q '{{' '${instance}/work/${LEADER}/STATE.md'"
    check "the leader persona template was not copied in" "[[ -f '${instance}/templates/leader.md' ]]"
    check "the instance has no leader persona" "[[ -f '${instance}/leader.md' ]]"
    check "the persona does not say who the leader is" \
        "grep -q 'You are ${LEADER}, ${HUMAN}'\"'\"'s lead' '${instance}/leader.md'"
    check "the persona does not point at the leader's own desk" \
        "grep -q 'work/${LEADER}/STATE.md' '${instance}/leader.md'"
    check "the persona still holds an unfilled placeholder" \
        "[[ -f '${instance}/leader.md' ]] && ! grep -q '{{' '${instance}/leader.md'"

    echo "Checking the configuration says what was asked for"
    if node "${repo}/tests/check-config.mjs" \
        "${instance}/ow.json" "${HUMAN}" "${LEADER}" "${LEADER_MODEL}" "${WORKER_MODEL}" "${PORT}" "${AUTH}"; then
        pass
    else
        fail "ow.json does not describe the instance that was asked for"
    fi

    echo "Checking what it refuses"
    check "installing over a non-empty directory was not refused" \
        "! '${repo}/install.sh' --root '${instance}' --source '${repo}' --human '${HUMAN}' --leader '${LEADER}' --leader-model '${LEADER_MODEL}' --worker-model '${WORKER_MODEL}' --port '${PORT}' --auth '${AUTH}'"
    check "--force did not install over a non-empty directory" \
        "'${repo}/install.sh' --root '${instance}' --source '${repo}' --human '${HUMAN}' --leader '${LEADER}' --leader-model '${LEADER_MODEL}' --worker-model '${WORKER_MODEL}' --port '${PORT}' --auth '${AUTH}' --force"
    check "a missing option was not refused" \
        "! '${repo}/install.sh' --root '${instance}' --source '${repo}' --human '${HUMAN}' --leader '${LEADER}'"
    check "a port below 1024 was not refused" \
        "! '${repo}/install.sh' --root '${instance}-lowport' --source '${repo}' --human '${HUMAN}' --leader '${LEADER}' --leader-model '${LEADER_MODEL}' --worker-model '${WORKER_MODEL}' --port 80 --auth '${AUTH}'"
    check "a port that is not a number was not refused" \
        "! '${repo}/install.sh' --root '${instance}-badport' --source '${repo}' --human '${HUMAN}' --leader '${LEADER}' --leader-model '${LEADER_MODEL}' --worker-model '${WORKER_MODEL}' --port banana --auth '${AUTH}'"
    check "a way of signing in that does not exist was not refused" \
        "! '${repo}/install.sh' --root '${instance}-badauth' --source '${repo}' --human '${HUMAN}' --leader '${LEADER}' --leader-model '${LEADER_MODEL}' --worker-model '${WORKER_MODEL}' --port '${PORT}' --auth sometimes"
    check "a port that is not written in digits was not refused" \
        "! '${repo}/install.sh' --root '${instance}-hexport' --source '${repo}' --human '${HUMAN}' --leader '${LEADER}' --leader-model '${LEADER_MODEL}' --worker-model '${WORKER_MODEL}' --port 0x1f90 --auth '${AUTH}'"
    check "a missing --auth was not refused" \
        "! '${repo}/install.sh' --root '${instance}-noauth' --source '${repo}' --human '${HUMAN}' --leader '${LEADER}' --leader-model '${LEADER_MODEL}' --worker-model '${WORKER_MODEL}' --port '${PORT}'"

    echo "Checking a port the machine picks"
    chosen="${instance}-chosen"
    check "--port 0 was refused" \
        "'${repo}/install.sh' --root '${chosen}' --source '${repo}' --human '${HUMAN}' --leader '${LEADER}' --leader-model '${LEADER_MODEL}' --worker-model '${WORKER_MODEL}' --port 0 --auth '${AUTH}'"
    if node "${repo}/tests/check-config.mjs" \
        "${chosen}/ow.json" "${HUMAN}" "${LEADER}" "${LEADER_MODEL}" "${WORKER_MODEL}" 0 "${AUTH}"; then
        pass
    else
        fail "ow.json did not record the port as 0"
    fi

    if command -v claude >/dev/null 2>&1; then
        echo "Checking the instance runs"
        check "ow status failed" "'${instance}/bin/ow' status"
        check "ow status does not name the human" "'${instance}/bin/ow' status | grep -q '${HUMAN}'"
    else
        echo "Skipping the checks that run the instance: Claude Code is not on the PATH"
    fi

    report
}

main "$@"
