#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Delegation wrapper.
# Starts opencode in detached mode, launches watchdog, waits for final verdict.

if [ $# -lt 3 ]; then
  echo "Usage: $0 <model> <output_log> <prompt>"
  echo "  model        Model name (e.g. opencode/big-pickle)"
  echo "  output_log   Path to redirect output log"
  echo "  prompt       Prompt text to send"
  exit 1
fi

MODEL="$1"
LOG="$2"
PROMPT="$3"
OPENCODE_BIN="${DELEGATION_OPENCODE_BIN:-./node_modules/.bin/opencode}"

# Add task prompt instructions requiring output status marker if not already present
MARKER_INSTRUCTION=$'\n\nWhen finished or unable to proceed, you MUST output exactly one of the following status markers on its own line as your final output:\nAI_TEAM_OS_STATUS:DONE\nAI_TEAM_OS_STATUS:BLOCKED'
if [[ "$PROMPT" != *"AI_TEAM_OS_STATUS:"* ]]; then
  PROMPT="${PROMPT}${MARKER_INSTRUCTION}"
fi

RUN_DIR="$(dirname "$LOG")/.delegate-$(date +%s)-$$"
mkdir -p "$RUN_DIR"

nohup "$OPENCODE_BIN" run "$PROMPT" -m "$MODEL" --dir "$(pwd)" > "$LOG" 2>&1 &
PID=$!
echo "$PID" > "$RUN_DIR/pid"
echo "$LOG" > "$RUN_DIR/current_log"
echo "$LOG" > "$RUN_DIR/base_log"
echo 1 > "$RUN_DIR/attempt"
echo 0 > "$RUN_DIR/recovery_attempt_count"
date +%s > "$RUN_DIR/start_time"

echo "PID=$PID"
echo "RUN_DIR=$RUN_DIR"

nohup bash "$SCRIPT_DIR/delegate-watchdog.sh" "$RUN_DIR" "$MODEL" "$LOG" "$PROMPT" >> "$RUN_DIR/watchdog.log" 2>&1 &
if type disown &>/dev/null 2>&1; then
  disown
fi

# Wait for watchdog final verdict (no outer 600s wrapper timeout)
while true; do
  if [ -f "$RUN_DIR/verdict" ]; then
    VERDICT=$(cat "$RUN_DIR/verdict")
    CURRENT_LOG=$(cat "$RUN_DIR/current_log" 2>/dev/null || echo "$LOG")
    BYTE_COUNT=$(wc -c < "$CURRENT_LOG" 2>/dev/null || echo 0)
    echo "$VERDICT"
    echo "$CURRENT_LOG: ${BYTE_COUNT} bytes"
    echo "$RUN_DIR"
    exit 0
  fi
  sleep 1
done
