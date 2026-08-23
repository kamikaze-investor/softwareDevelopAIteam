#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG="$REPO_ROOT/scripts/delegate-watchdog.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/delegate-watchdog-test.XXXXXX")
MOCK_BIN="$TEST_ROOT/bin"
mkdir -p "$MOCK_BIN"

cleanup() {
  if [ -f "$TEST_ROOT/live_pids" ]; then
    while read -r p; do
      [ -n "$p" ] && kill "$p" 2>/dev/null || true
    done < "$TEST_ROOT/live_pids"
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

cat > "$MOCK_BIN/opencode" <<'MOCK_OPENCODE'
#!/usr/bin/env bash
MODE="${MOCK_MODE:-default}"
case "$MODE" in
  done)
    printf 'Performing work...\nAI_TEAM_OS_STATUS:DONE\n'
    ;;
  blocked)
    printf 'Encountered blocker...\nAI_TEAM_OS_STATUS:BLOCKED\n'
    ;;
  exit_without_marker)
    printf 'Crash without marker\n'
    exit 1
    ;;
  long_tool)
    sleep 10 &
    CHILD_PID=$!
    wait "$CHILD_PID" 2>/dev/null || true
    ;;
  hanging)
    sleep 30
    ;;
  *)
    printf 'mock opencode default\nAI_TEAM_OS_STATUS:DONE\n'
    ;;
esac
MOCK_OPENCODE
chmod +x "$MOCK_BIN/opencode"

new_case() {
  CASE_DIR=$(mktemp -d "$TEST_ROOT/case.XXXXXX")
  RUN_DIR="$CASE_DIR/run"
  LOG="$CASE_DIR/delegation.log"
  mkdir -p "$RUN_DIR"
  printf '%s\n' 999999 > "$RUN_DIR/pid"
  printf '%s\n' "${1:-1}" > "$RUN_DIR/attempt"
  printf '%s\n' "${2:-0}" > "$RUN_DIR/recovery_attempt_count"
  printf '%s\n' "$LOG" > "$RUN_DIR/base_log"
  printf '%s\n' "$LOG" > "$RUN_DIR/current_log"
  printf '%s\n' "${3:-working}" > "$LOG"
}

run_watchdog() {
  env \
    PATH="$MOCK_BIN:$PATH" \
    DELEGATION_OPENCODE_BIN="$MOCK_BIN/opencode" \
    DELEGATION_INACTIVITY_TIMEOUT_SECONDS="${DELEGATION_INACTIVITY_TIMEOUT_SECONDS:-0.1}" \
    DELEGATION_LONG_TOOL_TIMEOUT_SECONDS="${DELEGATION_LONG_TOOL_TIMEOUT_SECONDS:-600}" \
    DELEGATION_MAX_RECOVERY_RETRIES="${DELEGATION_MAX_RECOVERY_RETRIES:-50}" \
    DELEGATION_POLL_INTERVAL_SECONDS="${DELEGATION_POLL_INTERVAL_SECONDS:-0.01}" \
    MOCK_MODE="${MOCK_MODE:-default}" \
    bash "$WATCHDOG" "$RUN_DIR" test-model "$LOG" test-prompt
}

assert_verdict() {
  local expected="$1"
  local actual
  actual=$(cat "$RUN_DIR/verdict" 2>/dev/null || echo "MISSING")
  if [ "$actual" != "$expected" ]; then
    echo "expected verdict '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_recovery_count() {
  local expected="$1"
  local actual
  actual=$(cat "$RUN_DIR/recovery_attempt_count" 2>/dev/null || echo "MISSING")
  if [ "$actual" != "$expected" ]; then
    echo "expected recovery_attempt_count '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_final_result() {
  local expected="$1"
  local actual
  actual=$(cat "$RUN_DIR/final_result" 2>/dev/null || echo "MISSING")
  if [ "$actual" != "$expected" ]; then
    echo "expected final_result '$expected', got '$actual'" >&2
    exit 1
  fi
}

# 1. DONE marker produces COMPLETED without retry
new_case 1 0 $'Working on task...\nAI_TEAM_OS_STATUS:DONE\n'
run_watchdog
assert_verdict "COMPLETED"
assert_recovery_count 0
assert_final_result "COMPLETED"

# 2. BLOCKED marker produces ESCALATE:blocked without retry
new_case 1 0 $'Blocked on external dependency\nAI_TEAM_OS_STATUS:BLOCKED\n'
run_watchdog
assert_verdict "ESCALATE:blocked"
assert_recovery_count 0
assert_final_result "ESCALATE:blocked"

# 3. Immediate process-exit retry when process exited without final marker
new_case 1 0 'premature exit'
MOCK_MODE=done DELEGATION_INACTIVITY_TIMEOUT_SECONDS=10 run_watchdog
assert_verdict "COMPLETED"
assert_recovery_count 1
if [ ! -f "$LOG.attempt-2" ]; then
  echo "expected retry log $LOG.attempt-2 to exist" >&2
  exit 1
fi
if [ "$(cat "$LOG")" != 'premature exit' ]; then
  echo "original attempt log was overwritten" >&2
  exit 1
fi

# 4. Activity reset on log updates prevents false inactivity timeout
new_case 1 0 'starting'
nohup bash -c 'exec -a "opencode run" sleep 30' > "$LOG" 2>&1 &
LIVE_PID=$!
echo "$LIVE_PID" >> "$TEST_ROOT/live_pids"
printf '%s\n' "$LIVE_PID" > "$RUN_DIR/pid"

(
  sleep 1; printf 'step 1\n' >> "$LOG"
  sleep 1; printf 'step 2\n' >> "$LOG"
  sleep 1; printf 'step 3\n' >> "$LOG"
  sleep 1; printf 'AI_TEAM_OS_STATUS:DONE\n' >> "$LOG"
) &
FEEDER_PID=$!

DELEGATION_INACTIVITY_TIMEOUT_SECONDS=3 \
DELEGATION_POLL_INTERVAL_SECONDS=0.05 \
run_watchdog

wait "$FEEDER_PID" 2>/dev/null || true
kill "$LIVE_PID" 2>/dev/null || true
assert_verdict "COMPLETED"
assert_recovery_count 0

# 5. Long-tool protection: active child suppresses inactivity timeout, but retries on long-tool timeout
new_case 1 0 'starting tool'
MOCK_MODE=long_tool nohup "$MOCK_BIN/opencode" run prompt -m model > "$LOG" 2>&1 &
TOOL_PID=$!
echo "$TOOL_PID" >> "$TEST_ROOT/live_pids"
printf '%s\n' "$TOOL_PID" > "$RUN_DIR/pid"
sleep 1

MOCK_MODE=done \
DELEGATION_INACTIVITY_TIMEOUT_SECONDS=1 \
DELEGATION_LONG_TOOL_TIMEOUT_SECONDS=2 \
DELEGATION_POLL_INTERVAL_SECONDS=0.05 \
run_watchdog

assert_verdict "COMPLETED"
assert_recovery_count 1
ACTUAL_REASON=$(cat "$RUN_DIR/retry_reason" 2>/dev/null || echo "")
if [ "$ACTUAL_REASON" != "long_tool_timeout" ]; then
  echo "expected retry_reason 'long_tool_timeout', got '$ACTUAL_REASON'" >&2
  exit 1
fi

# 6. 50 recovery retries cap -> ESCALATE:recovery_exhausted
new_case 1 0 'initial crash'
MOCK_MODE=exit_without_marker \
DELEGATION_MAX_RECOVERY_RETRIES=50 \
DELEGATION_INACTIVITY_TIMEOUT_SECONDS=1 \
DELEGATION_POLL_INTERVAL_SECONDS=0.001 \
run_watchdog

assert_verdict "ESCALATE:recovery_exhausted"
assert_recovery_count 50
ACTUAL_ATTEMPT=$(cat "$RUN_DIR/attempt" 2>/dev/null || echo 0)
if [ "$ACTUAL_ATTEMPT" != "51" ]; then
  echo "expected attempt 51, got '$ACTUAL_ATTEMPT'" >&2
  exit 1
fi
if [ ! -f "$LOG.attempt-51" ]; then
  echo "expected attempt-51 log to exist" >&2
  exit 1
fi

# 7. Non-OpenCode PID safety: never kill unrelated process
sleep 30 &
UNRELATED_PID=$!
echo "$UNRELATED_PID" >> "$TEST_ROOT/live_pids"
new_case 1 0 'stalled'
printf '%s\n' "$UNRELATED_PID" > "$RUN_DIR/pid"

MOCK_MODE=done \
DELEGATION_INACTIVITY_TIMEOUT_SECONDS=1 \
DELEGATION_MAX_RECOVERY_RETRIES=1 \
DELEGATION_POLL_INTERVAL_SECONDS=0.05 \
run_watchdog

if ! kill -0 "$UNRELATED_PID" 2>/dev/null; then
  echo "Watchdog killed non-OpenCode PID $UNRELATED_PID" >&2
  exit 1
fi
kill "$UNRELATED_PID" 2>/dev/null || true

# 8. Telemetry and per-attempt log preservation
new_case 1 0 'attempt 1 fail'
MOCK_MODE=done \
DELEGATION_INACTIVITY_TIMEOUT_SECONDS=1 \
DELEGATION_POLL_INTERVAL_SECONDS=0.01 \
run_watchdog

assert_verdict "COMPLETED"
assert_recovery_count 1
if [ ! -f "$RUN_DIR/telemetry.json" ]; then
  echo "telemetry.json not created" >&2
  exit 1
fi
if [ ! -f "$RUN_DIR/retry_events.jsonl" ]; then
  echo "retry_events.jsonl not created" >&2
  exit 1
fi
if [ ! -f "$RUN_DIR/elapsed_seconds" ]; then
  echo "elapsed_seconds not created" >&2
  exit 1
fi

if ! grep -q '"provider": "opencode"' "$RUN_DIR/telemetry.json"; then
  echo "telemetry.json missing provider" >&2
  exit 1
fi
if ! grep -q '"started_at":' "$RUN_DIR/telemetry.json" || ! grep -q '"completed_at":' "$RUN_DIR/telemetry.json"; then
  echo "telemetry.json missing timestamps" >&2
  exit 1
fi
if ! grep -q '"attempt_number":' "$RUN_DIR/retry_events.jsonl" || ! grep -q '"retry_reason":' "$RUN_DIR/retry_events.jsonl"; then
  echo "retry event missing attempt_number or retry_reason" >&2
  exit 1
fi

if ! grep -q '"recovery_attempt_count": 1' "$RUN_DIR/telemetry.json"; then
  echo "telemetry.json missing recovery_attempt_count" >&2
  exit 1
fi
if ! grep -q '"final_result": "COMPLETED"' "$RUN_DIR/telemetry.json"; then
  echo "telemetry.json missing final_result" >&2
  exit 1
fi
if ! grep -q '"retry_events":' "$RUN_DIR/telemetry.json"; then
  echo "telemetry.json missing retry_events" >&2
  exit 1
fi
if grep -Fq 'test-prompt' "$RUN_DIR/telemetry.json" || grep -Fq 'attempt 1 fail' "$RUN_DIR/telemetry.json"; then
  echo "telemetry.json stored prompt or output" >&2
  exit 1
fi
if [ ! -s "$RUN_DIR/last_activity" ]; then
  echo "last_activity was not persisted" >&2
  exit 1
fi

if [ "$(cat "$LOG")" != 'attempt 1 fail' ]; then
  echo "original attempt log was corrupted" >&2
  exit 1
fi
if ! grep -q "AI_TEAM_OS_STATUS:DONE" "$LOG.attempt-2"; then
  echo "attempt-2 log missing DONE marker" >&2
  exit 1
fi

echo 'delegate-watchdog deterministic tests: PASS'
