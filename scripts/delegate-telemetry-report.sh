#!/usr/bin/env bash
set -euo pipefail

# Aggregate delegation watchdog telemetry (telemetry.json / retry_events.jsonl)
# written by delegate-watchdog.sh so a developer can inspect cost-effectiveness.
# Reads only numeric fields, final_result status, and retry_reason enum values.
# Never reads or emits prompts, delegation logs, stdout/stderr, or other private data.

if [ $# -lt 1 ]; then
  echo "Usage: $0 <dir> [<dir>...]" >&2
  exit 1
fi

total_tasks=0
success_count=0
failure_count=0
bucket_0=0
bucket_1_5=0
bucket_6_20=0
bucket_21_50=0
bucket_exhausted=0
sum_retries=0
reason_counts_file=$(mktemp)
trap 'rm -f "$reason_counts_file"' EXIT

extract_string_field() {
  # Reads a quoted field ("key": "value",) from watchdog telemetry.json layout.
  local file="$1" key="$2"
  sed -n "s/^  \"$key\": \"\(.*\)\",\$/\1/p" "$file" | tail -n 1
}

extract_number_field() {
  local file="$1" key="$2"
  sed -n "s/^  \"$key\": \([0-9][0-9]*\),\$/\1/p" "$file" | tail -n 1
}

collect_retry_reasons() {
  # Emits one retry_reason value per line. Prefers the raw retry_events.jsonl
  # stream; falls back to the retry_events array embedded in telemetry.json.
  local run_dir="$1" telemetry_file="$2"
  local events_file="$run_dir/retry_events.jsonl"
  if [ -s "$events_file" ]; then
    grep -o '"retry_reason":"[^"]*"' "$events_file" | sed 's/^"retry_reason":"//; s/"$//' || true
  else
    grep -o '"retry_reason":"[^"]*"' "$telemetry_file" | sed 's/^"retry_reason":"//; s/"$//' || true
  fi
}

for root in "$@"; do
  while IFS= read -r run_dir; do
    telemetry_file="$run_dir/telemetry.json"
    [ -f "$telemetry_file" ] || continue

    final_result=$(extract_string_field "$telemetry_file" "final_result")
    if [ -z "$final_result" ]; then
      echo "Warning: skipping unreadable telemetry file: $telemetry_file" >&2
      continue
    fi

    recovery_count=$(extract_number_field "$telemetry_file" "recovery_attempt_count")
    [ -n "$recovery_count" ] || recovery_count=0

    total_tasks=$((total_tasks + 1))
    if [ "$final_result" = "COMPLETED" ]; then
      success_count=$((success_count + 1))
    else
      failure_count=$((failure_count + 1))
    fi

    if [ "$final_result" = "ESCALATE:recovery_exhausted" ]; then
      bucket_exhausted=$((bucket_exhausted + 1))
    elif [ "$recovery_count" -eq 0 ]; then
      bucket_0=$((bucket_0 + 1))
    elif [ "$recovery_count" -le 5 ]; then
      bucket_1_5=$((bucket_1_5 + 1))
    elif [ "$recovery_count" -le 20 ]; then
      bucket_6_20=$((bucket_6_20 + 1))
    else
      bucket_21_50=$((bucket_21_50 + 1))
    fi

    sum_retries=$((sum_retries + recovery_count))

    collect_retry_reasons "$run_dir" "$telemetry_file" >> "$reason_counts_file"
  done < <(find "$root" -type d -name '.delegate-*' -print 2>/dev/null | sort)
done

average="0.00"
if [ "$total_tasks" -gt 0 ]; then
  average=$(awk -v sum="$sum_retries" -v count="$total_tasks" 'BEGIN { printf "%.2f", sum / count }')
fi

echo "Delegation Telemetry Report"
echo "Total tasks: $total_tasks"
echo "Success (COMPLETED): $success_count"
echo "Failure (ESCALATE:*): $failure_count"
echo "Retry buckets:"
echo "  0: $bucket_0"
echo "  1-5: $bucket_1_5"
echo "  6-20: $bucket_6_20"
echo "  21-50: $bucket_21_50"
echo "  exhausted: $bucket_exhausted"
echo "Retry reason counts:"
if [ -s "$reason_counts_file" ]; then
  sort "$reason_counts_file" | uniq -c | awk '{ printf "  %s: %d\n", $2, $1 }'
else
  echo "  (none)"
fi
echo "Average retry count: $average"
