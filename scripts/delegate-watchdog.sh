#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 4 ]; then
  echo "Usage: $0 <run_dir> <model> <log> <prompt>" >&2
  exit 1
fi

RUN_DIR="$1"
MODEL="$2"
LOG="$3"
PROMPT="$4"

sleep 120

PID=$(cat "$RUN_DIR/pid")
ATTEMPT=$(cat "$RUN_DIR/attempt")

ALIVE="dead"
kill -0 "$PID" 2>/dev/null && ALIVE="alive" || true

SIZE=$(wc -c < "$LOG" 2>/dev/null || echo 0)

if [ -f "$LOG" ]; then
  MTIME=$(stat -c %Y "$LOG" 2>/dev/null || stat -f %m "$LOG" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  IDLE=$(( NOW - MTIME ))
else
  IDLE=-1
fi

TAIL=$(tail -c 2000 "$LOG" 2>/dev/null | head -n 30 || echo "")

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEMINI_API_KEY=$(grep -m1 '^GEMINI_API_KEY=' "$REPO_ROOT/.env" | cut -d= -f2- | tr -d '\\"')

JUDGE_PROMPT="model=$MODEL attempt=$ATTEMPT alive=$ALIVE size=$SIZE idle=${IDLE}s
tail:
$TAIL

Reply with exactly one word: RUNNING, STALLED_RETRYABLE, FAILED_NON_RETRYABLE, COMPLETED, or UNCERTAIN.
Use FAILED_NON_RETRYABLE for auth failure, quota exceeded, or permission denied since retrying the same prompt will not help."

# Build Gemini request JSON with Node.js to avoid a jq dependency.
BODY=$(JUDGE_PROMPT="$JUDGE_PROMPT" node -e '
  process.stdout.write(JSON.stringify({
    contents: [{ parts: [{ text: process.env.JUDGE_PROMPT }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 16 },
  }))
')

RESPONSE=$(curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$BODY" 2>/dev/null || echo "CURL_FAILED")

VERDICT=$(RESP_JSON="$RESPONSE" node -e '
  try {
    const data = JSON.parse(process.env.RESP_JSON)
    process.stdout.write(data.candidates?.[0]?.content?.parts?.[0]?.text ?? "")
  } catch {
    process.stdout.write("")
  }
' 2>/dev/null || echo "")
VERDICT=$(echo "$VERDICT" | tr -d '[:space:]')

case "$VERDICT" in
  RUNNING|COMPLETED|FAILED_NON_RETRYABLE|STALLED_RETRYABLE|UNCERTAIN)
    ;;
  *)
    VERDICT="UNCERTAIN"
    ;;
esac

if [ "$RESPONSE" = "CURL_FAILED" ]; then
  VERDICT="UNCERTAIN"
fi

case "$VERDICT" in
  RUNNING)
    echo "RUNNING" > "$RUN_DIR/verdict"
    exit 0
    ;;
  COMPLETED)
    echo "COMPLETED" > "$RUN_DIR/verdict"
    exit 0
    ;;
  FAILED_NON_RETRYABLE)
    echo "ESCALATE:failed" > "$RUN_DIR/verdict"
    exit 0
    ;;
  UNCERTAIN)
    echo "ESCALATE:uncertain" > "$RUN_DIR/verdict"
    exit 0
    ;;
  STALLED_RETRYABLE)
    if [ "$ATTEMPT" -ge 3 ]; then
      echo "ESCALATE:retry_exhausted" > "$RUN_DIR/verdict"
      exit 0
    fi

    kill "$PID" 2>/dev/null || true
    sleep 1

    nohup ./node_modules/.bin/opencode run "$PROMPT" -m "$MODEL" --dir "$(pwd)" > "$LOG" 2>&1 &
    NEW_PID=$!
    echo "$NEW_PID" > "$RUN_DIR/pid"
    echo "$(( ATTEMPT + 1 ))" > "$RUN_DIR/attempt"

    nohup bash scripts/delegate-watchdog.sh "$RUN_DIR" "$MODEL" "$LOG" "$PROMPT" >> "$RUN_DIR/watchdog.log" 2>&1 &
    exit 0
    ;;
esac
