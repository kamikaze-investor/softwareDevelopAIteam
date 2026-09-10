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

# DELEG-001: SIGSTOP が**実際に効いた**ことを確認する。
#
# 独立レビュー指摘（第5ラウンド）: `kill -STOP` は signal を送るだけで、
# 停止の成立を待たない。送信直後に走査すると、まだ動いている親が
# その後 fork でき、「新しい PID なし」を閉包と誤認する。
# 停止（`ps` の stat が T）か、死亡（fork できないので同じく安全）まで待つ。
wait_for_stopped() {
  local pid="$1"
  local budget_ms="$2"
  local waited=0
  local state
  while [ "$waited" -lt "$budget_ms" ]; do
    # 死んでいれば fork し得ないので、凍結できたのと同じ扱いでよい。
    is_pid_alive "$pid" || return 0
    state=$(ps -p "$pid" -o stat= 2>/dev/null || true)
    case "$state" in
      *T*) return 0 ;;
    esac
    sleep 0.05
    waited=$(( waited + 50 ))
  done
  return 1
}

# DELEG-001: PID の死亡を「待って確認する」共通処理。
# 以前は SIGTERM 後に 0.5s 待ち、まだ生きていれば SIGKILL を送って**待たずに**戻っていた。
# 呼び出し元はその直後に respawn するため、旧 child が生きたまま新 child が起動し得た。
wait_for_death() {
  local pid="$1"
  local budget_ms="$2"
  local waited=0
  while is_pid_alive "$pid" && [ "$waited" -lt "$budget_ms" ]; do
    sleep 0.05
    waited=$(( waited + 50 ))
  done
  ! is_pid_alive "$pid"
}

# DELEG-001: 子孫 PID を深さ優先で列挙する（末端から先に kill するため）。
# 旧実装は親だけを kill しており、tool として起動された孫 process が
# orphan として生き残った（stale/duplicate child）。
#
# 深さは明示的に打ち切る（独立レビュー指摘: 無制限再帰にしない）。
# 実運用の provider → tool は数段で、これを超える深さは異常なので
# 打ち切って上位の kill と再走査に委ねる。
# 独立レビュー指摘（第4ラウンド）: 非数値を渡すと line 121 の比較が
# `integer expected` を出すだけで、if 条件内なので set -e も止めず、
# **深さ上限が事実上無効化される**。既存の MAX_RECOVERY_RETRIES と同じ形で検証する。
REQUESTED_MAX_DESCENDANT_DEPTH="${DELEGATION_MAX_DESCENDANT_DEPTH:-8}"
case "$REQUESTED_MAX_DESCENDANT_DEPTH" in
  *[!0-9]*|"") MAX_DESCENDANT_DEPTH=8 ;;
  *) MAX_DESCENDANT_DEPTH=$((10#$REQUESTED_MAX_DESCENDANT_DEPTH)) ;;
esac
if [ "$MAX_DESCENDANT_DEPTH" -lt 1 ]; then
  MAX_DESCENDANT_DEPTH=8
fi

# 深さ上限で打ち切ったことを呼び出し元へ伝える。
#
# 独立レビュー指摘: 打ち切りを黙って「子孫なし」と同じ扱いにすると、
# 上限より深い子孫が記録されないまま最深の祖先を kill することになり、
# それらは orphan 化して親PID起点の再走査からも消える。
# 打ち切りは **fail-closed**（確認できなかった）として扱う。
#
# 伝達に global 変数を使わないこと（独立レビュー指摘 第3ラウンド）:
# 呼び出しは `sweep=$(collect_descendants "$pid")` という **command substitution**、
# つまり subshell なので、その中での代入は親シェルへ戻らず、
# せっかくのガードが不発になる。**exit status** で返す。
# `$(...)` の終了コードは中のコマンドの終了コードなので、そのまま受け取れる。
collect_descendants() {
  local parent_pid="$1"
  local depth="${2:-0}"
  if [ "$depth" -ge "$MAX_DESCENDANT_DEPTH" ]; then
    return 1
  fi
  local truncated=0
  local child
  local candidates
  candidates=$(pgrep -P "$parent_pid" 2>/dev/null || ps --ppid "$parent_pid" -o pid= 2>/dev/null || true)
  for child in $candidates; do
    collect_descendants "$child" $(( depth + 1 )) || truncated=1
    echo "$child"
  done
  return "$truncated"
}

# DELEG-001: process tree ごと終了させ、**終了を確認できたときだけ 0 を返す**。
#
#   - 子孫 → 親 の順に kill する（親だけ殺して孫を orphan にしない）
#   - SIGTERM で死ななければ SIGKILL へ昇格し、そのあとも死亡を待つ
#   - opencode process と同定できない PID は**素通りさせず**非0で返す（fail-closed）
#     旧実装は「安全のため skip」と称して kill せずに 0 を返しており、
#     呼び出し元はそれを成功と区別できないまま respawn していた
terminate_process_tree() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  if ! is_pid_alive "$pid"; then
    return 0
  fi
  if ! is_opencode_pid "$pid"; then
    echo "Warning: PID $pid is not an opencode process; refusing to respawn over it" >&2
    return 1
  fi

  # 独立レビュー指摘（第4ラウンド）: 有限回の再走査では snapshot race は閉じない。
  # 走査した直後に fork された子は、記録済みの親が死んだ時点で reparent され、
  # 親PID起点では二度と辿れなくなる。
  #
  # そこで **走査の前に SIGSTOP で凍結する**。停止した process は fork できないので、
  # 「凍結済み集合に新しい子孫が加わらなくなった」時点で走査は閉じたと言える。
  # 親を最初に止めるのが要点で、これで新たな子は増えなくなる。
  # 独立レビュー指摘（第5ラウンド）: STOP は非同期なので、**停止の成立を確認してから**
  # 走査する。確認前に走査すると、まだ動いている親が走査後に fork でき、
  # 「新しい PID なし」が閉包の証拠にならない。
  local froze_all=1
  kill -STOP "$pid" 2>/dev/null || true
  wait_for_stopped "$pid" 1000 || froze_all=0

  local frozen="$pid"
  local sweep round p new
  local settled=0
  local truncated=0
  for round in 1 2 3 4 5; do
    if sweep=$(collect_descendants "$pid"); then :; else truncated=1; fi
    new=""
    for p in $sweep; do
      case " $frozen " in
        *" $p "*) ;;
        *)
          kill -STOP "$p" 2>/dev/null || true
          new="$new $p"
          ;;
      esac
    done
    if [ -z "$new" ]; then
      # 記録済みがすべて停止済みである状態で、新しい PID が現れなかった。
      # 停止した process は fork できないので、この時点で集合は閉じている。
      settled=1
      break
    fi
    # 次の走査を「全員停止済み」の状態で行うため、ここで停止の成立を待つ。
    for p in $new; do
      wait_for_stopped "$p" 1000 || froze_all=0
    done
    frozen="$frozen$new"
  done

  # 凍結したものは必ず始末する。ここで return してしまうと STOP されたままの
  # process を残すことになり、stale child を増やす側に回ってしまう。
  # 子孫 → 親 の順に落とす。
  local ordered=""
  for p in $frozen; do
    [ "$p" = "$pid" ] || ordered="$p $ordered"
  done
  for p in $ordered; do
    kill -9 "$p" 2>/dev/null || true
  done
  kill -9 "$pid" 2>/dev/null || true

  local dead=1
  for p in $frozen; do
    wait_for_death "$p" 1000 || dead=0
  done

  if [ "$dead" -ne 1 ]; then
    echo "Warning: could not confirm every process under PID $pid is dead" >&2
    return 1
  fi
  if [ "$froze_all" -ne 1 ]; then
    # 停止を確認できなかった process があるなら、その間に fork された子孫を
    # 見落とした可能性が残る。閉包を主張しない。
    echo "Warning: could not confirm every process under PID $pid was stopped before scanning" >&2
    return 1
  fi
  if [ "$settled" -ne 1 ]; then
    echo "Warning: new descendants of PID $pid kept appearing across $round sweeps; tree not confirmed" >&2
    return 1
  fi
  if [ "$truncated" -eq 1 ]; then
    echo "Warning: descendant scan for PID $pid hit MAX_DESCENDANT_DEPTH; deeper children may survive" >&2
    return 1
  fi

  return 0
}

# 終端経路（watchdog 自身の中断・recovery 打ち切り）用。
# ここでは kill の成否で分岐しないため、戻り値は捨ててよい。
safe_kill_process() {
  terminate_process_tree "$1" || true
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

  # DELEG-001: **旧 process tree の終了を確認してから**でなければ respawn しない。
  # 確認できない場合は retry せず terminal verdict へ倒す。
  # 生きているかもしれない child の上に新しい child を重ねると、
  # duplicate provider が並走し、recovery の数え方も壊れる。
  if ! terminate_process_tree "$PID"; then
    write_telemetry "ESCALATE:stale_child" "$RETRY_TRIGGERED"
    exit 0
  fi

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
