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

# Supervised launch (apps/api/src/supervision/delegationSupervisor.ts) needs the run_dir to be
# known BEFORE the delegation starts, because it is the completion predicate's input and is
# recorded on the supervised_runs row at creation time. Without this override the run_dir is only
# discoverable by parsing this script's stdout, which cannot be done atomically with the launch.
RUN_DIR="${DELEGATION_RUN_DIR:-$(dirname "$LOG")/.delegate-$(date +%s)-$$}"
mkdir -p "$RUN_DIR"

# DELEG-001: provider は **専用の process group** で起動する。
# delegate-watchdog.sh は終了を PGID 単位で行うため、初回起動から同じ契約にしないと
# 旧 provider を group ごと止められない。
# setsid が無い環境では fallback せず unsupported として失敗させる
# （旧 PID tree kill は安全性を証明できなかったため戻さない）。
if ! command -v setsid >/dev/null 2>&1; then
  echo "setsid is unavailable; supervised delegation is unsupported on this platform" >&2
  exit 1
fi

OWN_PGID=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || echo "")

# PID/PGID は provider 自身に exec 前に報告させる。親から ps で後追いすると、
# 起動直後に終了する provider の group を特定できず fail-closed に倒れる。
REPORT="$RUN_DIR/provider_identity"
rm -f "$REPORT" "$REPORT.tmp"

setsid bash -c '
pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d " ")
printf "%s %s\n" "$$" "$pgid" > "$1.tmp" && mv "$1.tmp" "$1"
shift
exec "$@"
' _ "$REPORT" "$OPENCODE_BIN" run "$PROMPT" -m "$MODEL" --dir "$(pwd)" < /dev/null > "$LOG" 2>&1 &
SPAWN_PID=$!

WAITED=0
while [ ! -s "$REPORT" ] && [ "$WAITED" -lt 2000 ]; do
  sleep 0.02
  WAITED=$(( WAITED + 20 ))
done
if [ ! -s "$REPORT" ]; then
  echo "provider did not report its process group" >&2
  kill -KILL "$SPAWN_PID" 2>/dev/null || true
  exit 1
fi

PID=""
PGID=""
read -r PID PGID < "$REPORT"
case "$PID" in
  ''|*[!0-9]*) echo "provider reported a non-numeric pid '$PID'" >&2; kill -KILL "$SPAWN_PID" 2>/dev/null || true; exit 1 ;;
esac
case "$PGID" in
  ''|*[!0-9]*) echo "provider reported a non-numeric pgid '$PGID'" >&2; kill -KILL "$PID" 2>/dev/null || true; exit 1 ;;
esac
# setsid が効いていれば provider は session/process group leader なので pid == pgid。
if [ "$PGID" = "1" ] || [ "$PID" != "$PGID" ] || { [ -n "$OWN_PGID" ] && [ "$PGID" = "$OWN_PGID" ]; }; then
  echo "provider did not get its own process group (pid=$PID pgid=$PGID)" >&2
  kill -KILL "$PID" 2>/dev/null || true
  exit 1
fi

echo "$PID" > "$RUN_DIR/pid"
echo "$PGID" > "$RUN_DIR/pgid"
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
