#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT="$REPO_ROOT/scripts/delegate-telemetry-report.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/delegate-telemetry-report-test.XXXXXX")

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

new_run() {
  RUN_DIR="$1/.delegate-1700000000-$RANDOM$COUNTER"
  COUNTER=$((COUNTER + 1))
  mkdir -p "$RUN_DIR"
}

# Mirrors the exact telemetry.json layout emitted by delegate-watchdog.sh
write_telemetry_fixture() {
  local recovery_count="$1" final_result="$2" events_json="${3:-[]}"
  cat > "$RUN_DIR/telemetry.json" <<EOF
{
  "provider": "opencode",
  "recovery_attempt_count": $recovery_count,
  "retry_reason": "",
  "final_result": "$final_result",
  "started_at": 1700000000,
  "completed_at": 1700000100,
  "elapsed_seconds": 100,
  "retry_events": $events_json
}
EOF
}

append_retry_event() {
  local attempt="$1" count="$2" reason="$3"
  echo "{\"attempt_number\":$attempt,\"recovery_attempt_count\":$count,\"retry_reason\":\"$reason\",\"timestamp\":1700000000}" \
    >> "$RUN_DIR/retry_events.jsonl"
}

run_report() {
  bash "$REPORT" "$@" 2>"$TEST_ROOT/stderr.txt"
}

assert_line() {
  local output="$1" expected="$2"
  if ! grep -Fqx "$expected" <<< "$output"; then
    echo "report missing expected line: '$expected'" >&2
    echo "--- actual report ---" >&2
    echo "$output" >&2
    exit 1
  fi
}

assert_absent() {
  local output="$1" forbidden="$2"
  if grep -Fq "$forbidden" <<< "$output"; then
    echo "report must not contain: '$forbidden'" >&2
    exit 1
  fi
}

assert_not_reported() {
  local output="$1" expected="$2"
  if grep -Fqx "$expected" <<< "$output"; then
    echo "report must not contain line: '$expected'" >&2
    exit 1
  fi
}

COUNTER=0

# 1. Missing argument fails with usage
if bash "$REPORT" >/dev/null 2>&1; then
  echo "expected non-zero exit when no root dir given" >&2
  exit 1
fi

# 2. Empty root reports zeros
EMPTY_ROOT=$(mktemp -d "$TEST_ROOT/empty.XXXXXX")
OUTPUT=$(run_report "$EMPTY_ROOT")
assert_line "$OUTPUT" "Total tasks: 0"
assert_line "$OUTPUT" "Success (COMPLETED): 0"
assert_line "$OUTPUT" "Failure (ESCALATE:*): 0"
assert_line "$OUTPUT" "  0: 0"
assert_line "$OUTPUT" "  1-5: 0"
assert_line "$OUTPUT" "  6-20: 0"
assert_line "$OUTPUT" "  21-50: 0"
assert_line "$OUTPUT" "  exhausted: 0"
assert_line "$OUTPUT" "Retry reason counts:"
assert_line "$OUTPUT" "  (none)"
assert_line "$OUTPUT" "Average retry count: 0.00"

# 3. Mixed runs aggregate buckets, results, reasons, and average
ROOT=$(mktemp -d "$TEST_ROOT/cases.XXXXXX")

# run A: completed first try, no retry events at all
new_run "$ROOT"
write_telemetry_fixture 0 "COMPLETED"
printf 'secret prompt text alpha\n' > "$RUN_DIR/delegation.log"

# run B: completed after 3 retries
new_run "$ROOT"
write_telemetry_fixture 3 "COMPLETED"
append_retry_event 2 1 inactivity_timeout
append_retry_event 3 2 inactivity_timeout
append_retry_event 4 3 inactivity_timeout
printf 'secret stdout text beta\n' > "$RUN_DIR/delegation.log.attempt-2"

# run C: blocked after 7 retries of mixed reasons
new_run "$ROOT"
write_telemetry_fixture 7 "ESCALATE:blocked"
append_retry_event 2 1 long_tool_timeout
append_retry_event 3 2 long_tool_timeout
append_retry_event 4 3 long_tool_timeout
append_retry_event 5 4 long_tool_timeout
append_retry_event 6 5 pid_mismatch
append_retry_event 7 6 pid_mismatch
append_retry_event 8 7 pid_mismatch

# run D: recovery exhausted at the cap of 50 -> exhausted bucket, not 21-50
new_run "$ROOT"
write_telemetry_fixture 50 "ESCALATE:recovery_exhausted"
i=1
while [ "$i" -le 50 ]; do
  append_retry_event $((i + 1)) "$i" process_exit
  i=$((i + 1))
done

OUTPUT=$(run_report "$ROOT")
assert_line "$OUTPUT" "Total tasks: 4"
assert_line "$OUTPUT" "Success (COMPLETED): 2"
assert_line "$OUTPUT" "Failure (ESCALATE:*): 2"
assert_line "$OUTPUT" "  0: 1"
assert_line "$OUTPUT" "  1-5: 1"
assert_line "$OUTPUT" "  6-20: 1"
assert_line "$OUTPUT" "  21-50: 0"
assert_line "$OUTPUT" "  exhausted: 1"
assert_line "$OUTPUT" "  inactivity_timeout: 3"
assert_line "$OUTPUT" "  long_tool_timeout: 4"
assert_line "$OUTPUT" "  pid_mismatch: 3"
assert_line "$OUTPUT" "  process_exit: 50"
assert_line "$OUTPUT" "Average retry count: 15.00"

# privacy: prompts and delegation output must never appear in the report
assert_absent "$OUTPUT" "secret prompt text alpha"
assert_absent "$OUTPUT" "secret stdout text beta"

# 4. Runs with only embedded retry_events (no retry_events.jsonl) are counted once
EMBEDDED_ROOT=$(mktemp -d "$TEST_ROOT/embedded.XXXXXX")
new_run "$EMBEDDED_ROOT"
write_telemetry_fixture 2 "COMPLETED" \
  '[{"attempt_number":2,"recovery_attempt_count":1,"retry_reason":"inactivity_timeout","timestamp":1700000000},{"attempt_number":3,"recovery_attempt_count":2,"retry_reason":"process_exit","timestamp":1700000050}]'

OUTPUT=$(run_report "$EMBEDDED_ROOT")
assert_line "$OUTPUT" "Total tasks: 1"
assert_line "$OUTPUT" "Success (COMPLETED): 1"
assert_line "$OUTPUT" "  1-5: 1"
assert_line "$OUTPUT" "  inactivity_timeout: 1"
assert_line "$OUTPUT" "  process_exit: 1"
assert_line "$OUTPUT" "Average retry count: 2.00"

# 5. Malformed telemetry file is skipped with a warning, not counted
MALFORMED_ROOT=$(mktemp -d "$TEST_ROOT/malformed.XXXXXX")
new_run "$MALFORMED_ROOT"
printf 'not json at all\n' > "$RUN_DIR/telemetry.json"

OUTPUT=$(run_report "$MALFORMED_ROOT")
assert_line "$OUTPUT" "Total tasks: 0"
if ! grep -Fq "Warning: skipping unreadable telemetry file:" "$TEST_ROOT/stderr.txt"; then
  echo "expected stderr warning for malformed telemetry file" >&2
  exit 1
fi

# 6. Multiple roots are aggregated together
OUTPUT=$(run_report "$ROOT" "$EMBEDDED_ROOT")
assert_line "$OUTPUT" "Total tasks: 5"
assert_line "$OUTPUT" "Success (COMPLETED): 3"
assert_line "$OUTPUT" "Failure (ESCALATE:*): 2"
assert_line "$OUTPUT" "Average retry count: 12.40"

# 7. Non .delegate-* directories are ignored
OUTSIDER_ROOT=$(mktemp -d "$TEST_ROOT/outsider.XXXXXX")
mkdir -p "$OUTSIDER_ROOT/not-a-delegate-run"
cat > "$OUTSIDER_ROOT/not-a-delegate-run/telemetry.json" <<EOF
{
  "provider": "opencode",
  "recovery_attempt_count": 9,
  "retry_reason": "",
  "final_result": "COMPLETED",
  "started_at": 1700000000,
  "completed_at": 1700000100,
  "elapsed_seconds": 100,
  "retry_events": []
}
EOF

OUTPUT=$(run_report "$OUTSIDER_ROOT")
assert_not_reported "$OUTPUT" "Total tasks: 1"
assert_line "$OUTPUT" "Total tasks: 0"

echo 'delegate-telemetry-report deterministic tests: PASS'
