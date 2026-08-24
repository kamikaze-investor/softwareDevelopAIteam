#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ $# -lt 4 ]; then
  echo "Usage: $0 <run_dir> <model> <log> <prompt>" >&2
  exit 1
fi

RUN_DIR="$1"
MODEL="$2"
LOG="$3"
PROMPT="$4"

OPENCODE_BIN="${DELEGATION_OPENCODE_BIN:-./node_modules/.bin/opencode}"
INACTIVITY_TIMEOUT="${DELEGATION_INACTIVITY_TIMEOUT_SECONDS:-${DELEGATION_WATCHDOG_DELAY_SECONDS:-120}}"
LONG_TOOL_TIMEOUT="${DELEGATION_LONG_TOOL_TIMEOUT_SECONDS:-600}"
REQUESTED_MAX_RECOVERY_RETRIES="${DELEGATION_MAX_RECOVERY_RETRIES:-50}"
case "$REQUESTED_MAX_RECOVERY_RETRIES" in
  *[!0-9]*|"") MAX_RECOVERY_RETRIES=50 ;;
  *) MAX_RECOVERY_RETRIES=$((10#$REQUESTED_MAX_RECOVERY_RETRIES)) ;;
esac
if [ "$MAX_RECOVERY_RETRIES" -gt 50 ]; then
  MAX_RECOVERY_RETRIES=50
fi
POLL_INTERVAL="${DELEGATION_POLL_INTERVAL_SECONDS:-1}"

# Ensure task prompt instructions are present
MARKER_INSTRUCTION=$'\n\nWhen finished or unable to proceed, you MUST output exactly one of the following status markers on its own line as your final output:\nAI_TEAM_OS_STATUS:DONE\nAI_TEAM_OS_STATUS:BLOCKED'
if [[ "$PROMPT" != *"AI_TEAM_OS_STATUS:"* ]]; then
  PROMPT="${PROMPT}${MARKER_INSTRUCTION}"
fi

START_TIME=$(cat "$RUN_DIR/start_time" 2>/dev/null || date +%s)
echo "$START_TIME" > "$RUN_DIR/start_time"

is_pid_alive() {
  local pid="$1"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi

  # A completed child can remain a zombie until its parent reaps it.
  # kill -0 succeeds for zombies, but they cannot produce further activity.
  local process_state
  process_state=$(ps -p "$pid" -o stat= 2>/dev/null || true)
  case "$process_state" in
    *Z*) return 1 ;;
  esac

  return 0
}

is_opencode_pid() {
  local pid="$1"
  if ! is_pid_alive "$pid"; then
    return 1
  fi
  local cmd
  cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
  case "$cmd" in
    *opencode*run*) return 0 ;;
    *) return 1 ;;
  esac
}

get_child_pids() {
  local parent_pid="$1"
  if ! is_pid_alive "$parent_pid"; then
    echo ""
    return
  fi
  local candidates child_pid
  candidates=$(pgrep -P "$parent_pid" 2>/dev/null || ps --ppid "$parent_pid" -o pid= 2>/dev/null || true)
  for child_pid in $candidates; do
    if is_pid_alive "$child_pid"; then
      echo "$child_pid"
    fi
  done
}

safe_kill_process() {
  local pid="$1"
  if ! is_pid_alive "$pid"; then
    return 0
  fi
  if ! is_opencode_pid "$pid"; then
    echo "Warning: PID $pid is not an opencode process, skipping kill for safety" >&2
    return 0
  fi

  kill "$pid" 2>/dev/null || true

  local count=0
  while is_pid_alive "$pid" && [ "$count" -lt 10 ]; do
    sleep 0.05
    count=$((count + 1))
  done

  if is_pid_alive "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
  fi
}

get_file_size() {
  local file="$1"
  if [ -f "$file" ]; then
    wc -c < "$file" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

get_file_mtime() {
  local file="$1"
  if [ -f "$file" ]; then
    stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

check_marker() {
  local log_file="$1"
  if [ ! -f "$log_file" ]; then
    echo "NONE"
    return
  fi
  if grep -Fq "AI_TEAM_OS_STATUS:BLOCKED" "$log_file" 2>/dev/null; then
    echo "BLOCKED"
    return
  fi
  if grep -Fq "AI_TEAM_OS_STATUS:DONE" "$log_file" 2>/dev/null; then
    echo "DONE"
    return
  fi
  echo "NONE"
}

write_telemetry() {
  local final_verdict="$1"
  local last_retry_reason="${2:-}"
  local watchdog_termination_kind="${3:-terminal_verdict}"
  local watchdog_exit_code="${4:-0}"
  local watchdog_signal="${5:-}"
  if [ -z "$last_retry_reason" ] && [ -f "$RUN_DIR/retry_reason" ]; then
    last_retry_reason=$(cat "$RUN_DIR/retry_reason")
  fi
  local end_time
  end_time=$(date +%s)
  local elapsed=$(( end_time - START_TIME ))

  local recovery_count
  recovery_count=$(cat "$RUN_DIR/recovery_attempt_count" 2>/dev/null || echo 0)

  local attempt
  attempt=$(cat "$RUN_DIR/attempt" 2>/dev/null || echo 1)

  local exit_code_json="null"
  case "$watchdog_exit_code" in
    *[!0-9]*|"") ;;
    *) exit_code_json="$watchdog_exit_code" ;;
  esac

  local signal_json="null"
  if [ -n "$watchdog_signal" ]; then
    signal_json="\"$watchdog_signal\""
  fi

  echo "$final_verdict" > "$RUN_DIR/final_result"
  echo "$recovery_count" > "$RUN_DIR/recovery_attempt_count"
  echo "$last_retry_reason" > "$RUN_DIR/retry_reason"
  echo "$end_time" > "$RUN_DIR/end_time"
  echo "$elapsed" > "$RUN_DIR/elapsed_seconds"

  local events_json="[]"
  if [ -f "$RUN_DIR/retry_events.jsonl" ] && [ -s "$RUN_DIR/retry_events.jsonl" ]; then
    local joined
    joined=$(paste -sd, "$RUN_DIR/retry_events.jsonl" 2>/dev/null || true)
    if [ -n "$joined" ]; then
      events_json="[$joined]"
    fi
  fi

  cat > "$RUN_DIR/telemetry.json" <<EOF
{
  "provider": "opencode",
  "attempt_number": $attempt,
  "recovery_attempt_count": $recovery_count,
  "retry_reason": "$last_retry_reason",
  "final_result": "$final_verdict",
  "started_at": $START_TIME,
  "completed_at": $end_time,
  "elapsed_seconds": $elapsed,
  "watchdog_termination": {
    "kind": "$watchdog_termination_kind",
    "exit_code": $exit_code_json,
    "signal": $signal_json
  },
  "retry_events": $events_json
}
EOF

  echo "$final_verdict" > "$RUN_DIR/verdict"
}

record_retry_event() {
  local attempt="$1"
  local recovery_count="$2"
  local reason="$3"
  local now
  now=$(date +%s)

  echo "$reason" > "$RUN_DIR/retry_reason"
  echo "$recovery_count" > "$RUN_DIR/recovery_attempt_count"

  cat >> "$RUN_DIR/retry_events.jsonl" <<EOF
{"attempt_number":$attempt,"recovery_attempt_count":$recovery_count,"retry_reason":"$reason","timestamp":$now}
EOF
}

# A detached watchdog can be terminated independently of its parent wrapper.
# Ensure that a non-terminal exit always releases delegate.sh from its verdict wait.
FINALIZATION_IN_PROGRESS=0

finalize_interrupted_watchdog() {
  local termination_kind="$1"
  local exit_code="$2"
  local signal_name="${3:-}"

  if [ "$FINALIZATION_IN_PROGRESS" -eq 1 ] || [ -e "$RUN_DIR/verdict" ]; then
    return 0
  fi
  FINALIZATION_IN_PROGRESS=1

  local watched_pid
  watched_pid=$(cat "$RUN_DIR/pid" 2>/dev/null || echo "")
  safe_kill_process "$watched_pid"

  printf "watchdog interrupted kind=%s exit_code=%s signal=%s\n" \
    "$termination_kind" "$exit_code" "${signal_name:-none}" >&2

  if ! write_telemetry "ESCALATE:watchdog_interrupted" "watchdog_interrupted" \
    "$termination_kind" "$exit_code" "$signal_name"; then
    # Even if telemetry persistence itself fails, prefer releasing the parent
    # wrapper over leaving it in an unbounded wait.
    printf "%s\n" "ESCALATE:watchdog_interrupted" > "$RUN_DIR/verdict" 2>/dev/null || true
  fi
}

on_watchdog_exit() {
  local exit_code=$?
  finalize_interrupted_watchdog "exit" "$exit_code"
}

on_watchdog_signal() {
  local signal_name="$1"
  local exit_code="$2"
  finalize_interrupted_watchdog "signal" "$exit_code" "$signal_name"
  exit "$exit_code"
}

trap on_watchdog_exit EXIT
trap "on_watchdog_signal TERM 143" TERM
trap "on_watchdog_signal INT 130" INT
trap "on_watchdog_signal HUP 129" HUP

[ -f "$RUN_DIR/base_log" ] || echo "$LOG" > "$RUN_DIR/base_log"
[ -f "$RUN_DIR/current_log" ] || echo "$LOG" > "$RUN_DIR/current_log"
[ -f "$RUN_DIR/attempt" ] || echo 1 > "$RUN_DIR/attempt"
[ -f "$RUN_DIR/recovery_attempt_count" ] || echo 0 > "$RUN_DIR/recovery_attempt_count"

BASE_LOG=$(cat "$RUN_DIR/base_log")

while true; do
  PID=$(cat "$RUN_DIR/pid" 2>/dev/null || echo "")
  ATTEMPT=$(cat "$RUN_DIR/attempt" 2>/dev/null || echo 1)
  RECOVERY_COUNT=$(cat "$RUN_DIR/recovery_attempt_count" 2>/dev/null || echo 0)
  CURRENT_LOG=$(cat "$RUN_DIR/current_log" 2>/dev/null || echo "$LOG")

  LAST_ACTIVITY_TIME=$(cat "$RUN_DIR/last_activity" 2>/dev/null || date +%s)
  LAST_SIZE=$(get_file_size "$CURRENT_LOG")
  LAST_MTIME=$(get_file_mtime "$CURRENT_LOG")
  echo "$LAST_ACTIVITY_TIME" > "$RUN_DIR/last_activity"
  TOOL_START_TIME=0
  RETRY_TRIGGERED=""

  while true; do
    MARKER=$(check_marker "$CURRENT_LOG")
    if [ "$MARKER" = "DONE" ]; then
      write_telemetry "COMPLETED" ""
      exit 0
    elif [ "$MARKER" = "BLOCKED" ]; then
      write_telemetry "ESCALATE:blocked" ""
      exit 0
    fi

    NOW=$(date +%s)

    if ! is_pid_alive "$PID"; then
      MARKER=$(check_marker "$CURRENT_LOG")
      if [ "$MARKER" = "DONE" ]; then
        write_telemetry "COMPLETED" ""
        exit 0
      elif [ "$MARKER" = "BLOCKED" ]; then
        write_telemetry "ESCALATE:blocked" ""
        exit 0
      fi

      RETRY_TRIGGERED="process_exit"
      break
    fi

    if ! is_opencode_pid "$PID"; then
      RETRY_TRIGGERED="pid_mismatch"
      break
    fi

    CURR_SIZE=$(get_file_size "$CURRENT_LOG")
    CURR_MTIME=$(get_file_mtime "$CURRENT_LOG")
    if [ "$CURR_SIZE" -ne "$LAST_SIZE" ] || [ "$CURR_MTIME" -ne "$LAST_MTIME" ]; then
      LAST_ACTIVITY_TIME=$NOW
      LAST_SIZE=$CURR_SIZE
      LAST_MTIME=$CURR_MTIME
      echo "$LAST_ACTIVITY_TIME" > "$RUN_DIR/last_activity"
    fi

    CHILDREN=""
    if is_opencode_pid "$PID"; then
      CHILDREN=$(get_child_pids "$PID" | tr '\n' ' ' | xargs 2>/dev/null || echo "")
    fi
    if [ -n "$CHILDREN" ]; then
      if [ "$TOOL_START_TIME" -eq 0 ]; then
        TOOL_START_TIME=$NOW
      fi
      TOOL_ELAPSED=$(( NOW - TOOL_START_TIME ))

      if [ "$TOOL_ELAPSED" -ge "$LONG_TOOL_TIMEOUT" ]; then
        RETRY_TRIGGERED="long_tool_timeout"
        break
      fi

      LAST_ACTIVITY_TIME=$NOW
    else
      TOOL_START_TIME=0
      IDLE_ELAPSED=$(( NOW - LAST_ACTIVITY_TIME ))

      if [ "$IDLE_ELAPSED" -ge "$INACTIVITY_TIMEOUT" ]; then
        RETRY_TRIGGERED="inactivity_timeout"
        break
      fi
    fi

    sleep "$POLL_INTERVAL"
  done

  if [ "$RECOVERY_COUNT" -ge "$MAX_RECOVERY_RETRIES" ]; then
    safe_kill_process "$PID"
    write_telemetry "ESCALATE:recovery_exhausted" "$RETRY_TRIGGERED"
    exit 0
  fi

  safe_kill_process "$PID"

  NEXT_ATTEMPT=$(( ATTEMPT + 1 ))
  NEXT_RECOVERY_COUNT=$(( RECOVERY_COUNT + 1 ))
  NEXT_LOG="${BASE_LOG}.attempt-${NEXT_ATTEMPT}"

  record_retry_event "$NEXT_ATTEMPT" "$NEXT_RECOVERY_COUNT" "$RETRY_TRIGGERED"

  nohup "$OPENCODE_BIN" run "$PROMPT" -m "$MODEL" --dir "$(pwd)" > "$NEXT_LOG" 2>&1 &
  NEW_PID=$!

  echo "$NEW_PID" > "$RUN_DIR/pid"
  echo "$NEXT_ATTEMPT" > "$RUN_DIR/attempt"
  echo "$NEXT_RECOVERY_COUNT" > "$RUN_DIR/recovery_attempt_count"
  echo "$NEXT_LOG" > "$RUN_DIR/current_log"
  date +%s > "$RUN_DIR/last_activity"
done
