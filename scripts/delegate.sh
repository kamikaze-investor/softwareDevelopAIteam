#!/usr/bin/env bash
set -euo pipefail

# Minimal delegation wrapper.
# Starts opencode in background and sleeps 120s to remind PL to check progress.
# No auto-progress detection, no retry, no state management.

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

nohup ./node_modules/.bin/opencode run "$PROMPT" -m "$MODEL" --dir "$(pwd)" > "$LOG" 2>&1 &
PID=$!

echo "Started opencode (PID=$PID)"
echo "Output: $LOG"

sleep 120

BYTE_COUNT=$(wc -c < "$LOG" 2>/dev/null || echo 0)
echo ""
echo "委任から2分経過。進捗を確認してください"
echo "$LOG: ${BYTE_COUNT} bytes"
