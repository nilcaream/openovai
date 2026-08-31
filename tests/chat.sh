#!/usr/bin/env bash
set -euo pipefail

# tests/chat.sh — start the chat server, talk to it, stop it.
#
# It needs Node.js and nothing else. Claude Code is never really run: the stand-in from
# helpers.sh answers in the shape the real one answers in, which keeps the test deterministic
# and lets it check the parts that are ours — the arguments the leader is run with, the thread
# being resumed, and what the transcript says when Claude Code is missing altogether.
#
# It reaches the server through tools/ow.mjs rather than bin/ow, because bin/ow refuses to run
# without Claude Code installed, which is the right behaviour for a person and the wrong one
# for this test.

readonly HUMAN=Mike
readonly LEADER=Superman
readonly MODEL=haiku

# shellcheck source=tests/helpers.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

instance=""
stand_in=""
server=""
cleanup() {
    [[ -n "${server}" ]] && kill "${server}" 2>/dev/null
    [[ -n "${instance}" ]] && rm -rf "${instance}"
    [[ -n "${stand_in}" ]] && rm -rf "${stand_in}"
    return 0
}
trap cleanup EXIT

# A port nobody else on this machine is likely to be holding.
port() { echo $(( 20000 + ( $$ % 20000 ) )); }

wait_for_health() {
    local url="${1}" tries=0
    while (( tries < 50 )); do
        if curl -fsS "${url}/health" >/dev/null 2>&1; then
            return 0
        fi
        tries=$(( tries + 1 ))
        sleep 0.1
    done
    return 1
}

say() {
    curl -fsS -X POST -H 'content-type: application/json' \
        -d "{\"text\":\"${1}\"}" "${2}/message"
}

main() {
    local repo url log node_dir

    repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
    instance="${repo}/.tmp/chat-test-$$"
    stand_in="${instance}-stand-in"
    log="${stand_in}/calls.txt"
    url="http://127.0.0.1:$(port)"

    rm -rf "${instance}" "${stand_in}"
    write_stand_in "${stand_in}"

    echo "Installing into ${instance}"
    "${repo}/install.sh" --root "${instance}" --source "${repo}" \
        --human "${HUMAN}" --leader "${LEADER}" \
        --leader-model "${MODEL}" --worker-model "${MODEL}" --port "$(port)" >/dev/null

    echo "Starting the chat on ${url}"
    OW_STAND_IN_LOG="${log}" PATH="${stand_in}:${PATH}" \
        node "${instance}/tools/ow.mjs" --root "${instance}" chat >/dev/null 2>&1 &
    server=$!
    wait_for_health "${url}" || { echo "the server never answered" >&2; return 1; }

    echo "Checking what it serves"
    check "/health does not name the instance" "curl -fsS '${url}/health' | grep -q '${instance}'"
    check "/health does not name the leader" "curl -fsS '${url}/health' | grep -q '${LEADER}'"
    check "the page has no composer" "curl -fsS '${url}/' | grep -q 'id=\"composer\"'"
    check "an unknown path is not a 404" \
        "[[ \$(curl -s -o /dev/null -w '%{http_code}' '${url}/nowhere') == 404 ]]"

    echo "Checking a message and its reply"
    check "a message was not accepted" "say hello '${url}'"
    check "the transcript lost the message" "curl -fsS '${url}/messages' | grep -q hello"
    check "there is no reply in the transcript" "curl -fsS '${url}/messages' | grep -q 'a reply'"
    check "the leader was not run with the instance's model" "grep -q -- '--model ${MODEL}' '${log}'"
    check "empty text was accepted" \
        "! curl -fsS -X POST -H 'content-type: application/json' -d '{\"text\":\"  \"}' '${url}/message'"

    echo "Checking the conversation carries on"
    check "the thread was not remembered" "[[ -f '${instance}/chat/session.json' ]]"
    check "a second message was not accepted" "say again '${url}'"
    check "the second message did not resume the thread" "grep -q -- '--resume test-thread' '${log}'"

    echo "Checking what it says when Claude Code is missing"
    kill "${server}" 2>/dev/null
    wait "${server}" 2>/dev/null || true
    node_dir="$(dirname -- "$(command -v node)")"
    PATH="${node_dir}:/usr/bin:/bin" node "${instance}/tools/ow.mjs" --root "${instance}" chat >/dev/null 2>&1 &
    server=$!
    wait_for_health "${url}" || { echo "the server never answered" >&2; return 1; }
    check "a missing Claude Code is not reported in the transcript" \
        "say 'anyone there' '${url}' | grep -q 'not on the PATH'"

    report
}

main "$@"
