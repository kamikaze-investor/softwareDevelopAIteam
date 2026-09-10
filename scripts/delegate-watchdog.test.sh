#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG="$REPO_ROOT/scripts/delegate-watchdog.sh"
DELEGATE="$REPO_ROOT/scripts/delegate.sh"
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
    # Keep the process alive briefly so the polling watchdog can observe the marker.
    sleep 0.05
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

start_watchdog() {
  env \
    PATH="$MOCK_BIN:$PATH" \
    DELEGATION_OPENCODE_BIN="$MOCK_BIN/opencode" \
    DELEGATION_INACTIVITY_TIMEOUT_SECONDS="${DELEGATION_INACTIVITY_TIMEOUT_SECONDS:-10}" \
    DELEGATION_LONG_TOOL_TIMEOUT_SECONDS="${DELEGATION_LONG_TOOL_TIMEOUT_SECONDS:-600}" \
    DELEGATION_MAX_RECOVERY_RETRIES="${DELEGATION_MAX_RECOVERY_RETRIES:-50}" \
    DELEGATION_POLL_INTERVAL_SECONDS="${DELEGATION_POLL_INTERVAL_SECONDS:-0.01}" \
    MOCK_MODE="${MOCK_MODE:-default}" \
    bash "$WATCHDOG" "$RUN_DIR" test-model "$LOG" test-prompt &
  WATCHDOG_PID=$!
  for _ in $(seq 1 100); do
    if [ -f "$RUN_DIR/last_activity" ]; then
      return 0
    fi
    sleep 0.01
  done
  echo "watchdog did not reach trap-ready state" >&2
  return 1
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

# DELEG-001: 本番と同じ契約で provider を起動する。
# 専用 process group に置き、PID/PGID は provider 自身に exec 前へ報告させる
# （親から ps で後追いすると即死 provider を取りこぼす）。
start_provider_in_group() {
  local report="$RUN_DIR/provider_identity"
  rm -f "$report" "$report.tmp"

  setsid bash -c '
pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d " ")
printf "%s %s\n" "$$" "$pgid" > "$1.tmp" && mv "$1.tmp" "$1"
shift
exec "$@"
' _ "$report" "$@" > "$LOG" 2>&1 &
  local spawn_pid=$!

  local waited=0
  while [ ! -s "$report" ] && [ "$waited" -lt 2000 ]; do
    sleep 0.02
    waited=$(( waited + 20 ))
  done
  if [ ! -s "$report" ]; then
    echo "test harness: provider did not report its process group" >&2
    kill -KILL "$spawn_pid" 2>/dev/null || true
    exit 1
  fi

  local pid="" pgid=""
  read -r pid pgid < "$report"
  case "$pid" in ''|*[!0-9]*) echo "test harness: bad pid '$pid'" >&2; exit 1 ;; esac
  case "$pgid" in ''|*[!0-9]*) echo "test harness: bad pgid '$pgid'" >&2; exit 1 ;; esac
  if [ "$pid" != "$pgid" ]; then
    echo "test harness: provider is not its own group leader (pid=$pid pgid=$pgid)" >&2
    exit 1
  fi

  echo "$pid" >> "$TEST_ROOT/live_pids"
  printf '%s\n' "$pid" > "$RUN_DIR/pid"
  printf '%s\n' "$pgid" > "$RUN_DIR/pgid"
  LAST_PROVIDER_PID="$pid"
  LAST_PROVIDER_PGID="$pgid"
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
if grep -Fq "watchdog_interrupted" "$RUN_DIR/telemetry.json"; then
  echo "normal terminal verdict was overwritten during EXIT handling" >&2
  exit 1
fi

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
start_provider_in_group bash -c 'exec -a "opencode run" sleep 30'
LIVE_PID="$LAST_PROVIDER_PID"

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
MOCK_MODE=long_tool start_provider_in_group "$MOCK_BIN/opencode" run prompt -m model
TOOL_PID="$LAST_PROVIDER_PID"
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
DELEGATION_MAX_RECOVERY_RETRIES=99 \
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

# 9. An unexpected nonzero shell exit is terminalized instead of stranding delegate.sh.
new_case 1 0 'working'
MOCK_MODE=hanging start_provider_in_group "$MOCK_BIN/opencode" run prompt -m model
LIVE_PID="$LAST_PROVIDER_PID"

set +e
MOCK_MODE=hanging DELEGATION_POLL_INTERVAL_SECONDS=not-a-duration run_watchdog
WATCHDOG_STATUS=$?
set -e
if [ "$WATCHDOG_STATUS" -eq 0 ]; then
  echo "expected invalid poll interval to terminate watchdog nonzero" >&2
  exit 1
fi
assert_verdict "ESCALATE:watchdog_interrupted"
assert_final_result "ESCALATE:watchdog_interrupted"
if ! grep -q '"kind": "exit"' "$RUN_DIR/telemetry.json"; then
  echo "unexpected exit telemetry missing termination kind" >&2
  exit 1
fi
if ! grep -q '"exit_code":' "$RUN_DIR/telemetry.json"; then
  echo "unexpected exit telemetry missing exit code" >&2
  exit 1
fi
kill "$LIVE_PID" 2>/dev/null || true

# 10. TERM terminalizes once; its subsequent EXIT trap must not overwrite signal telemetry.
new_case 1 0 'working'
MOCK_MODE=hanging start_provider_in_group "$MOCK_BIN/opencode" run prompt -m model
LIVE_PID="$LAST_PROVIDER_PID"
MOCK_MODE=hanging start_watchdog
kill -TERM "$WATCHDOG_PID"
wait "$WATCHDOG_PID" 2>/dev/null || true
assert_verdict "ESCALATE:watchdog_interrupted"
assert_final_result "ESCALATE:watchdog_interrupted"
if ! grep -q '"kind": "signal"' "$RUN_DIR/telemetry.json" || ! grep -q '"signal": "TERM"' "$RUN_DIR/telemetry.json"; then
  echo "TERM telemetry was missing or overwritten by EXIT finalization" >&2
  exit 1
fi
kill "$LIVE_PID" 2>/dev/null || true

# 11. Parent wrapper returns the interruption verdict instead of waiting indefinitely.
WRAPPER_LOG="$CASE_DIR/delegate.log"
set +e
timeout 5 env \
  PATH="$MOCK_BIN:$PATH" \
  DELEGATION_OPENCODE_BIN="$MOCK_BIN/opencode" \
  DELEGATION_POLL_INTERVAL_SECONDS=not-a-duration \
  MOCK_MODE=hanging \
  bash "$DELEGATE" test-model "$WRAPPER_LOG" test-prompt > "$CASE_DIR/delegate.out" 2>&1
DELEGATE_STATUS=$?
set -e
if [ "$DELEGATE_STATUS" -ne 0 ]; then
  echo "delegate.sh did not return after watchdog interruption (status $DELEGATE_STATUS)" >&2
  exit 1
fi
if ! grep -Fxq 'ESCALATE:watchdog_interrupted' "$CASE_DIR/delegate.out"; then
  echo "delegate.sh did not surface watchdog_interrupted" >&2
  exit 1
fi
WRAPPER_RUN_DIR=$(find "$CASE_DIR" -maxdepth 1 -type d -name '.delegate-*' -print -quit)
if [ -z "$WRAPPER_RUN_DIR" ]; then
  echo "delegate.sh did not create a run directory" >&2
  exit 1
fi
WRAPPER_PID=$(cat "$WRAPPER_RUN_DIR/pid")
if kill -0 "$WRAPPER_PID" 2>/dev/null; then
  echo "watchdog interruption left the OpenCode process running" >&2
  exit 1
fi
# 12. DELEG-001 process group termination.
#     多段の子を持つ provider を PGID 単位で全停止できること、
#     kill 中に fork が起きても旧 group に live process が残らないこと。
cat > "$MOCK_BIN/opencode-nested" <<'MOCK_NESTED'
#!/usr/bin/env bash
# 多段の子孫を持ち、kill window 中にも新しい子孫を fork し続ける provider。
#
# fork は **上限付き** にする。無制限に fork させると test 環境ごと巻き込むだけで、
# 検証したい性質（kill 中に fork された子孫が旧 group に残らないこと）は上限付きでも同じように出る。
# 子孫は spin させず単一の長寿命 process (sleep) にして、1 fork = 1 process に固定する。
printf 'nested provider start\n'

# $1: TERM を無視するか。無視する枝を1つ入れておかないと TERM だけで group が消え、
# bounded wait -> KILL -> 確認 の経路が test で一度も走らない。
child() {
  if [ "$1" = "ignore_term" ]; then
    trap '' TERM
  fi
  # 初期の孫（多段構造そのもの）。
  sleep 300 &
  sleep 300 &
  sleep 300 &
  # TERM -> KILL の待機窓（計 4s）をまたいで fork し続けるが、回数は上限で止める。
  i=0
  while [ "$i" -lt 12 ]; do
    sleep 300 &
    i=$(( i + 1 ))
    sleep 0.4
  done
  wait
}
child normal &
child ignore_term &
wait
MOCK_NESTED
chmod +x "$MOCK_BIN/opencode-nested"

new_case 1 0 'nested start'
start_provider_in_group "$MOCK_BIN/opencode-nested" run prompt -m model
NESTED_PGID="$LAST_PROVIDER_PGID"
sleep 1

NESTED_BEFORE=$( { pgrep -g "$NESTED_PGID" 2>/dev/null || true; } | wc -l | tr -d ' ' )
if [ "$NESTED_BEFORE" -lt 3 ]; then
  echo "expected a multi-level provider tree, got $NESTED_BEFORE processes in pgid $NESTED_PGID" >&2
  exit 1
fi

# provider は live child (sleep) を持つので、watchdog は inactivity ではなく
# long-tool timeout 経路で retry を判断する。ここを短くしないと child の寿命ぶん待つ。
# つまりこの case は「group が実際に稼働中でも PGID 単位で止められるか」を見ている。
MOCK_MODE=done \
DELEGATION_OPENCODE_BIN="$MOCK_BIN/opencode" \
DELEGATION_INACTIVITY_TIMEOUT_SECONDS=1 \
DELEGATION_LONG_TOOL_TIMEOUT_SECONDS=2 \
DELEGATION_POLL_INTERVAL_SECONDS=0.05 \
run_watchdog

NESTED_AFTER=$( { pgrep -g "$NESTED_PGID" 2>/dev/null || true; } | wc -l | tr -d ' ' )
if [ "$NESTED_AFTER" -ne 0 ]; then
  echo "old provider group $NESTED_PGID still has $NESTED_AFTER live process(es) after termination" >&2
  pgrep -g "$NESTED_PGID" -a 2>/dev/null | head -5 >&2 || true
  exit 1
fi

# respawn は旧 group の終了確認後に起きるので、新しい group は別 PGID になる。
NEW_PGID=$(cat "$RUN_DIR/pgid" 2>/dev/null || echo "")
if [ -z "$NEW_PGID" ] || [ "$NEW_PGID" = "$NESTED_PGID" ]; then
  echo "respawn did not create a new process group (old=$NESTED_PGID new=$NEW_PGID)" >&2
  exit 1
fi

# 13. DELEG-001 fail-closed: group を特定できない live provider の上へ respawn しない。
new_case 1 0 'no pgid recorded'
sleep 30 &
ORPHAN_PID=$!
echo "$ORPHAN_PID" >> "$TEST_ROOT/live_pids"
printf '%s\n' "$ORPHAN_PID" > "$RUN_DIR/pid"
rm -f "$RUN_DIR/pgid"

MOCK_MODE=done \
DELEGATION_INACTIVITY_TIMEOUT_SECONDS=1 \
DELEGATION_POLL_INTERVAL_SECONDS=0.05 \
run_watchdog

assert_verdict "ESCALATE:stale_child"
if ! kill -0 "$ORPHAN_PID" 2>/dev/null; then
  echo "fail-closed path killed a process it could not identify as ours" >&2
  exit 1
fi
kill "$ORPHAN_PID" 2>/dev/null || true

echo 'delegate-watchdog deterministic tests: PASS'
