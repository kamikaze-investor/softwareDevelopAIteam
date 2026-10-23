import type { CommandKind } from '@ai-team/shared'

/**
 * SafeCommand 1回の **kill budget**（containment が kill するまでの実行予算, ms）。
 *
 * 2026-10-23 production: implement Job の SafeCommand `pnpm test`（全 apps の vitest）は
 * 全件 pass するが 147s かかり、一律 120s の予算で毎回 containment に kill されていた。
 *
 * **watchdog の閾値（`watchdog/stallDetector.ts`）とは別の policy 値である。結合しない。**
 * watchdog は Job の `startedAt` から測る**Job 全体の経過時間**（最大15分の AI CLI フェーズを含む）に対する
 * **alert 閾値**であり、kill はしない。ここの予算は SafeCommand の実行開始から測る kill 境界である。
 * 測る区間も効果も違うので、片方を調整しても他方が黙って変わらないよう別々に持つ。
 */
export const SAFE_COMMAND_TIMEOUT_DEFAULT_MS = 120_000
export const SAFE_COMMAND_TIMEOUT_TEST_MS = 600_000
export const SAFE_COMMAND_TIMEOUT_BUILD_MS = 600_000
export const SAFE_COMMAND_TIMEOUT_TYPECHECK_MS = 300_000

/**
 * kind 別の kill budget。test / build / typecheck だけを延ばし、
 * lint / git_* などは従来どおり 120s のまま。
 * timeout 後の containment kill → drain → reconciliation の protocol は呼び出し側で不変。
 */
export function safeCommandTimeoutMs(kind: CommandKind): number {
  switch (kind) {
    case 'test':
      return SAFE_COMMAND_TIMEOUT_TEST_MS
    case 'build':
      return SAFE_COMMAND_TIMEOUT_BUILD_MS
    case 'typecheck':
      return SAFE_COMMAND_TIMEOUT_TYPECHECK_MS
    default:
      return SAFE_COMMAND_TIMEOUT_DEFAULT_MS
  }
}
