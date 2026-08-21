#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Delegation wrapper.
# Starts opencode in detached mode, launches watchdog, waits for verdict.

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

RUN_DIR="$(dirname "$LOG")/.delegate-$(date +%s)-$$"
mkdir -p "$RUN_DIR"

nohup "$OPENCODE_BIN" run "$PROMPT" -m "$MODEL" --dir "$(pwd)" > "$LOG" 2>&1 &
PID=$!
echo "$PID" > "$RUN_DIR/pid"
echo "$LOG" > "$RUN_DIR/current_log"
echo "$LOG" > "$RUN_DIR/base_log"

echo "PID=$PID"
echo "RUN_DIR=$RUN_DIR"

echo 1 > "$RUN_DIR/attempt"

nohup bash "$SCRIPT_DIR/delegate-watchdog.sh" "$RUN_DIR" "$MODEL" "$LOG" "$PROMPT" >> "$RUN_DIR/watchdog.log" 2>&1 &
if type disown &>/dev/null 2>&1; then
  disown
fi

ELAPSED=0
while [ "$ELAPSED" -lt 600 ]; do
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
  ELAPSED=$((ELAPSED + 1))
done

echo "ESCALATE:watchdog_timeout"
echo "$LOG: ${BYTE_COUNT:-0} bytes"
echo "$RUN_DIR"
exit 0
