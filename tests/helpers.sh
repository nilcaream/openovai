#!/usr/bin/env bash
# Shared by the test scripts. Sourced, never run.
#
# Two things live here: the counting a test does, and the stand-in for Claude Code. The
# stand-in matters most — a test that really ran Claude Code would need a subscription, would
# cost money, and would answer differently every time. This one records how it was called and
# answers in the shape measured from the real binary, which is what lets the tests check the
# parts that are ours: the arguments, the environment, and what we do with the answer.

checks=0
failures=0

pass() { checks=$(( checks + 1 )); }
fail() { checks=$(( checks + 1 )); failures=$(( failures + 1 )); echo "  FAIL  ${1}" >&2; }
check() { if eval "${2}" >/dev/null 2>&1; then pass; else fail "${1}"; fi; }

# Print the tally. Returns non-zero when anything failed, so a test can end on it.
report() {
    echo
    if (( failures > 0 )); then
        echo "${failures} of ${checks} checks failed"
        return 1
    fi
    echo "${checks} checks passed"
}

# Write a stand-in `claude` into a directory, to be put first on the PATH.
#
# It reads its behaviour from the environment, so one stand-in serves every test:
#   OW_STAND_IN_LOG           file to record each call in (required)
#   OW_STAND_IN_REPLY         what an answer says            (default: a reply)
#   OW_STAND_IN_SESSION       the thread id it returns       (default: test-thread)
#   OW_STAND_IN_RESUME_FAILS  refuse to resume a thread      (default: no)
#   OW_STAND_IN_SIGNED_IN     what `auth status` reports     (default: true)
#   OW_STAND_IN_LOGIN_STATUS  what `auth login` exits with   (default: 0)
write_stand_in() {
    local dir="${1}"
    mkdir -p "${dir}"
    cat > "${dir}/claude" <<'STANDIN'
#!/usr/bin/env bash
{
  echo "argv: $*"
  echo "cwd: ${PWD}"
  echo "CLAUDE_CONFIG_DIR: ${CLAUDE_CONFIG_DIR:-<unset>}"
  echo "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-<unset>}"
} >> "${OW_STAND_IN_LOG}"

case "$*" in
    "auth status")
        signed_in="${OW_STAND_IN_SIGNED_IN:-true}"
        printf '{"loggedIn":%s,"authMethod":"claude.ai"}\n' "${signed_in}"
        [[ "${signed_in}" == "true" ]] && exit 0
        exit 1
        ;;
    "auth login")
        echo "(the real one opens a browser here)"
        exit "${OW_STAND_IN_LOGIN_STATUS:-0}"
        ;;
esac

if [[ "$*" == *"--resume"* && -n "${OW_STAND_IN_RESUME_FAILS:-}" ]]; then
    printf '{"type":"result","is_error":true,"session_id":null,"result":"No conversation found"}\n'
    exit 1
fi

printf '{"type":"result","is_error":false,"session_id":"%s","result":"%s"}\n' \
    "${OW_STAND_IN_SESSION:-test-thread}" "${OW_STAND_IN_REPLY:-a reply}"
STANDIN
    chmod +x "${dir}/claude"
}
