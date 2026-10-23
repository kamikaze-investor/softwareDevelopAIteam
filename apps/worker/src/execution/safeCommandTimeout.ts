import type { CommandKind } from '@ai-team/shared'
import { getStallThreshold } from '../watchdog/stallDetector.js'

/**
 * SafeCommand 実行予算の下限（ms）。lint / git_* など短いコマンドは従来どおりこの値で区切る。
 */
export const DEFAULT_SAFE_COMMAND_TIMEOUT_MS = 120_000

/**
 * SafeCommand 1回の実行予算（ms）を kind ごとに返す。
 *
 * 2026-10-23 production: implement Job の SafeCommand `pnpm test`（全 apps の vitest）は
 * 全件 pass するが 147s かかり、一律 120s の予算で毎回 containment に kill されていた。
 * watchdog は既に typecheck=300s / test・build=600s を「正常に掛かりうる時間」と想定しており、
 * 実行側だけが 120s だった。
 *
 * **表を複製しない。** 数値の正本は watchdog の `STALL_THRESHOLDS_MS`（`getStallThreshold`）で、
 * ここはそれを下限 120s で底上げするだけである。これにより
 *   - typecheck=300s / test=600s / build=600s は watchdog の想定と一致し（両者がずれない）
 *   - watchdog の値が 120s 未満の kind（git_* / lint）は従来の 120s のまま変わらない。
 * timeout 後の containment kill → drain → reconciliation の protocol は呼び出し側で不変。
 */
export function safeCommandTimeoutMs(kind: CommandKind): number {
  return Math.max(DEFAULT_SAFE_COMMAND_TIMEOUT_MS, getStallThreshold(kind))
}
