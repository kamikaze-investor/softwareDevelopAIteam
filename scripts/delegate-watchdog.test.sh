#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG="$REPO_ROOT/scripts/delegate-watchdog.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/delegate-watchdog-test.XXXXXX")
MOCK_BIN="$TEST_ROOT/bin"
mkdir -p "$MOCK_BIN"

cleanup() {
  if [ -f "$TEST_ROOT/live_pid" ]; then
    kill "$(cat "$TEST_ROOT/live_pid")" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

cat > "$MOCK_BIN/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "${MOCK_CAPTURE:?}"
case "${MOCK_RESPONSE:-}" in
  curl_fail) exit 1 ;;
  empty) printf '%s' '{}' ;;
  invalid) printf '%s' '{"candidates":[{"content":{"parts":[{"text":"NOT_A_VERDICT"}]}}]}' ;;
  *) printf '{"candidates":[{"content":{"parts":[{"text":"%s"}]}}]}' "$MOCK_RESPONSE" ;;
esac
MOCK_CURL
chmod +x "$MOCK_BIN/curl"

cat > "$MOCK_BIN/opencode" <<'MOCK_OPENCODE'
#!/usr/bin/env bash
printf '%s\n' 'mock opencode retry output'
MOCK_OPENCODE
chmod +x "$MOCK_BIN/opencode"

new_case() {
  CASE_DIR=$(mktemp -d "$TEST_ROOT/case.XXXXXX")
  RUN_DIR="$CASE_DIR/run"
  LOG="$CASE_DIR/delegation.log"
  CAPTURE="$CASE_DIR/request.txt"
  mkdir -p "$RUN_DIR"
  printf '%s\n' 999999 > "$RUN_DIR/pid"
  printf '%s\n' "${1:-1}" > "$RUN_DIR/attempt"
  printf '%s\n' "$LOG" > "$RUN_DIR/base_log"
  printf '%s\n' "$LOG" > "$RUN_DIR/current_log"
  printf '%s\n' "${2:-working}" > "$LOG"
}

run_watchdog() {
  local response="$1"
  env \
    PATH="$MOCK_BIN:$PATH" \
    GEMINI_API_KEY="test-key" \
    DELEGATION_WATCHDOG_DELAY_SECONDS=0 \
    DELEGATION_OPENCODE_BIN="$MOCK_BIN/opencode" \
    MOCK_RESPONSE="$response" \
    MOCK_CAPTURE="$CAPTURE" \
    bash "$WATCHDOG" "$RUN_DIR" test-model "$LOG" test-prompt
}

assert_verdict() {
  local expected="$1"
  local actual
  actual=$(cat "$RUN_DIR/verdict")
  if [ "$actual" != "$expected" ]; then
    echo "expected verdict '$expected', got '$actual'" >&2
    exit 1
  fi
}

for verdict in RUNNING COMPLETED; do
  new_case
  run_watchdog "$verdict"
  assert_verdict "$verdict"
done

new_case
run_watchdog FAILED_NON_RETRYABLE
assert_verdict ESCALATE:failed

new_case
run_watchdog UNCERTAIN
assert_verdict ESCALATE:uncertain

for response in curl_fail empty invalid; do
  new_case
  run_watchdog "$response"
  assert_verdict ESCALATE:uncertain
done

new_case
NO_ENV_REPO="$CASE_DIR/repo-without-env"
mkdir -p "$NO_ENV_REPO/scripts"
cp "$WATCHDOG" "$NO_ENV_REPO/scripts/delegate-watchdog.sh"
PATH="$MOCK_BIN:$PATH" MOCK_CAPTURE="$CAPTURE" DELEGATION_WATCHDOG_DELAY_SECONDS=0 \
  bash "$NO_ENV_REPO/scripts/delegate-watchdog.sh" "$RUN_DIR" test-model "$LOG" test-prompt
assert_verdict ESCALATE:uncertain
if [ -f "$CAPTURE" ]; then
  echo 'missing-key case unexpectedly called Gemini' >&2
  exit 1
fi

new_case 1 'FINAL RESULT: task completed successfully'
run_watchdog COMPLETED
assert_verdict COMPLETED
if ! grep -q 'Even when the process is dead, use COMPLETED' "$CAPTURE"; then
  echo 'completion guidance was not sent to Gemini' >&2
  exit 1
fi
if compgen -G "$LOG.attempt-*" >/dev/null; then
  echo 'completion case unexpectedly retried' >&2
  exit 1
fi

new_case 3
run_watchdog STALLED_RETRYABLE
assert_verdict ESCALATE:retry_exhausted

new_case 2 'original attempt evidence'
run_watchdog STALLED_RETRYABLE
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  [ -f "$RUN_DIR/verdict" ] && break
  sleep 1
done
assert_verdict ESCALATE:retry_exhausted
if [ "$(cat "$LOG")" != 'original attempt evidence' ]; then
  echo 'retry overwrote the previous attempt log' >&2
  exit 1
fi
if [ ! -s "$LOG.attempt-3" ]; then
  echo 'retry did not create an attempt-specific log' >&2
  exit 1
fi

sleep 30 &
LIVE_PID=$!
printf '%s\n' "$LIVE_PID" > "$TEST_ROOT/live_pid"
new_case 1
printf '%s\n' "$LIVE_PID" > "$RUN_DIR/pid"
run_watchdog STALLED_RETRYABLE
assert_verdict ESCALATE:uncertain
if ! kill -0 "$LIVE_PID" 2>/dev/null; then
  echo 'watchdog killed a non-OpenCode process' >&2
  exit 1
fi

echo 'delegate-watchdog deterministic tests: PASS'
