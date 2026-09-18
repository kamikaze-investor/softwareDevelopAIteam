import type { AiCliMode, AiCliProvider } from './types/ai_cli'

/**
 * `claude_code` の implement に与える AI CLI timeout。**暫定値である。**
 *
 * ## なぜ既定の 5 分では足りないか（production 実測・2026-09-18）
 *
 * | group | n | provider_timeout | 成功 median | 成功 p95 | 成功 max |
 * |---|---|---|---|---|---|
 * | claude_code / implement | 96 | **7 件 (7.3%)** | 61s | 201s | **230s** |
 * | claude_code / review | 53 | **0 件** | 33s | 70s | 131s |
 *
 * 既定 300s に対し、成功した implement の max は 230s —— **余裕は 1.3 倍しかない**。
 * しかも **timeout 7 件はすべて `changedFiles` があった**。つまりこの timeout は記録上
 * 一度も「ハングを救う」働きをしておらず、**毎回作業中の Job を殺している**。
 * 直近の 1 件（`2dc04370`）は終了の 15 秒前までツールを使い続けていた
 * （session transcript の毎分イベント数 23/12/12/14/**34** で、最後の 1 分が最多）。
 *
 * review は 53 件で timeout 0 件・max 131s（既定の 2.3 倍の余裕）なので、
 * **adapter 全体の `defaultTimeoutMs` は伸ばさない**。伸ばすと review のハング検知だけが鈍る。
 *
 * ## なぜ 900_000 が「最適値」ではないのか
 *
 * 上の max 230s は**右側打ち切り**である。300s を超えて必要だった Job は全部殺されており、
 * **本当に何秒必要だったかは測れていない**。900s は最適値ではなく、
 * **その裾を測り直すための暫定 budget** である（CEO 指示・2026-09-18）。
 * 観測 max の 3.9 倍・p95 の 4.5 倍にあたる。
 *
 * 測り直す条件は `apps/api/src/pl/implementTimeoutSensor.ts` が機械的に判定する。
 * **センサーはこの値を書き換えない。** 出すのは再 Review 候補までである。
 *
 * repair Job も `mode=implement` で走るため（production の `step=repair:… mode=implement`）、
 * 同じ値が効く。
 */
export const CLAUDE_IMPLEMENT_TIMEOUT_MS = 900_000

/**
 * AI CLI へ渡す timeout。**undefined を返した経路は既存挙動のまま**
 * （adapter の `defaultTimeoutMs` = 300_000 が効く）。
 *
 * 実測が `claude_code` のものしか無い（production の AI CLI Job 149 件すべて）ため、
 * **測っていない provider へは広げない**。
 */
export function aiCliTimeoutMs(
  provider: AiCliProvider,
  mode: AiCliMode,
): number | undefined {
  if (provider !== 'claude_code') return undefined
  return mode === 'implement' ? CLAUDE_IMPLEMENT_TIMEOUT_MS : undefined
}
