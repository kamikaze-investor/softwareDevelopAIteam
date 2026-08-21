#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# MVP: Load GEMINI_API_KEY from the repository-local .env when it is not
# already supplied by the parent process. Do not print the secret value.
if [ -z "${GEMINI_API_KEY:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  GEMINI_API_KEY="$(
    sed -n 's/^GEMINI_API_KEY=//p' "$REPO_ROOT/.env" | head -n 1
  )"
  GEMINI_API_KEY="${GEMINI_API_KEY%\"}"
  GEMINI_API_KEY="${GEMINI_API_KEY#\"}"
  GEMINI_API_KEY="${GEMINI_API_KEY%\'}"
  GEMINI_API_KEY="${GEMINI_API_KEY#\'}"
  export GEMINI_API_KEY
fi

if [ $# -lt 4 ]; then
  echo "Usage: $0 <run_dir> <model> <log> <prompt>" >&2
  exit 1
fi

RUN_DIR="$1"
MODEL="$2"
LOG="$3"
PROMPT="$4"
OPENCODE_BIN="${DELEGATION_OPENCODE_BIN:-./node_modules/.bin/opencode}"

WATCHDOG_DELAY_SECONDS="${DELEGATION_WATCHDOG_DELAY_SECONDS:-120}"
sleep "$WATCHDOG_DELAY_SECONDS"

PID=$(cat "$RUN_DIR/pid")
ATTEMPT=$(cat "$RUN_DIR/attempt")

ALIVE="dead"
kill -0 "$PID" 2>/dev/null && ALIVE="alive" || true

PID_IS_OPENCODE="not_applicable"
if [ "$ALIVE" = "alive" ]; then
  PID_COMMAND=$(ps -p "$PID" -o args= 2>/dev/null || echo "")
  case "$PID_COMMAND" in
    *opencode*run*) PID_IS_OPENCODE="yes" ;;
    *) PID_IS_OPENCODE="no" ;;
  esac
fi

SIZE=$(wc -c < "$LOG" 2>/dev/null || echo 0)

if [ -f "$LOG" ]; then
  MTIME=$(stat -c %Y "$LOG" 2>/dev/null || stat -f %m "$LOG" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  IDLE=$(( NOW - MTIME ))
else
  IDLE=-1
fi

TAIL=$(tail -c 2000 "$LOG" 2>/dev/null | head -n 30 || echo "")

JUDGE_PROMPT="model=$MODEL attempt=$ATTEMPT alive=$ALIVE pid_is_opencode=$PID_IS_OPENCODE size=$SIZE idle=${IDLE}s
tail:
$TAIL

Reply with exactly one word: RUNNING, STALLED_RETRYABLE, FAILED_NON_RETRYABLE, COMPLETED, or UNCERTAIN.
Use FAILED_NON_RETRYABLE for auth failure, quota exceeded, or permission denied since retrying the same prompt will not help.
Even when the process is dead, use COMPLETED if the log clearly contains a successful completion or final result.
Use UNCERTAIN when completion is plausible but not clear.
Use STALLED_RETRYABLE only when there is no completion evidence and the supplied state gives a concrete reason that retrying the same prompt is likely to help."

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "ESCALATE:uncertain" > "$RUN_DIR/verdict"
  exit 0
fi

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

    if [ "$ALIVE" = "alive" ]; then
      # Re-check immediately before kill to reduce the chance of signalling a reused PID.
      CURRENT_COMMAND=$(ps -p "$PID" -o args= 2>/dev/null || echo "")
      case "$CURRENT_COMMAND" in
        *opencode*run*) kill "$PID" 2>/dev/null || true ;;
        *)
          echo "ESCALATE:uncertain" > "$RUN_DIR/verdict"
          exit 0
          ;;
      esac
      sleep 1
    fi

    NEXT_ATTEMPT=$(( ATTEMPT + 1 ))
    BASE_LOG=$(cat "$RUN_DIR/base_log" 2>/dev/null || echo "$LOG")
    NEXT_LOG="${BASE_LOG}.attempt-${NEXT_ATTEMPT}"
    nohup "$OPENCODE_BIN" run "$PROMPT" -m "$MODEL" --dir "$(pwd)" > "$NEXT_LOG" 2>&1 &
    NEW_PID=$!
    echo "$NEW_PID" > "$RUN_DIR/pid"
    echo "$NEXT_ATTEMPT" > "$RUN_DIR/attempt"
    echo "$NEXT_LOG" > "$RUN_DIR/current_log"

    nohup bash "$SCRIPT_DIR/delegate-watchdog.sh" "$RUN_DIR" "$MODEL" "$NEXT_LOG" "$PROMPT" >> "$RUN_DIR/watchdog.log" 2>&1 &
    exit 0
    ;;
esac
