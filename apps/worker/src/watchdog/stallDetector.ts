import type { CommandKind } from '@ai-team/shared'

/** CommandKind ごとのスタル判定閾値（ms） */
const STALL_THRESHOLDS_MS: Record<CommandKind, number> = {
  git_status:       30_000,   //  30s — 超高速なはず
  git_diff:         30_000,   //  30s
  git_log:          30_000,   //  30s
  git_branch_create: 30_000,  //  30s
  git_checkout:     60_000,   //  60s — ファイル数が多いと遅い
  git_commit:       60_000,   //  60s
  git_revert:       60_000,   //  60s
  typecheck:       300_000,   //   5min — 大規模プロジェクト対応
  test:            600_000,   //  10min — CI相当
  build:           600_000,   //  10min
  lint:            120_000,   //   2min
}

export interface StallCheckResult {
  isStalled: boolean
  stallDurationMs: number
  thresholdMs: number
}

/**
 * Job がスタルしているか判定する。
 * @param commandKind Job のコマンド種別
 * @param startedAt Job の開始時刻（ISO 8601）
 * @param nowMs 現在時刻（テスト用に注入可能）
 */
export function checkStall(
  commandKind: CommandKind,
  startedAt: string,
  nowMs: number = Date.now(),
): StallCheckResult {
  const thresholdMs = STALL_THRESHOLDS_MS[commandKind]
  const startMs = new Date(startedAt).getTime()
  const stallDurationMs = nowMs - startMs
  return {
    isStalled: stallDurationMs > thresholdMs,
    stallDurationMs,
    thresholdMs,
  }
}

export function getStallThreshold(commandKind: CommandKind): number {
  return STALL_THRESHOLDS_MS[commandKind]
}
