import { describe, expect, it, vi, beforeEach } from 'vitest'
import { aiCliTimeoutMs, type AiCliMode, type AiCliProvider } from '@ai-team/shared'


/**
 * AI CLI の timeout をモードごとに決める回帰テスト（CEO 指示・2026-09-18）。
 *
 * ## 何を守るテストか
 *
 * production 実測では `claude_code` の implement だけが既定 300s を超え、
 * **provider_timeout 7 件すべてが `changedFiles` を持っていた**（＝作業中に殺されていた）。
 * 一方 review は 53 件で timeout 0 件・成功 max 131s だった。
 *
 * よってここで固定したいのは 2 つである。
 * 1. implement だけ 900_000 を**明示的に**受け取ること
 * 2. **それ以外は何も渡さないこと**（`undefined` = adapter の `defaultTimeoutMs` 300_000 のまま）
 *
 * 2 が崩れると「global default を伸ばした」のと同じになり、review のハング検知が鈍る。
 */
describe('aiCliTimeoutMs', () => {
  const IMPLEMENT_MS = 900_000

  it('claude_code + implement へ 900_000 を渡す', () => {
    expect(aiCliTimeoutMs('claude_code', 'implement')).toBe(IMPLEMENT_MS)
  })

  // repair Job は独立した mode ではなく `mode=implement` で走る
  // （production の `step=repair:… mode=implement`）。同じ値が効くことを明示しておく。
  it('repair は mode=implement なので同じ値が効く', () => {
    const repairJobMode: AiCliMode = 'implement'
    expect(aiCliTimeoutMs('claude_code', repairJobMode)).toBe(IMPLEMENT_MS)
  })

  // **review へ渡してはいけない。** 渡すと global default を伸ばしたのと同じ影響になる。
  it('claude_code + review には timeout を渡さない（既定 300_000 のまま）', () => {
    expect(aiCliTimeoutMs('claude_code', 'review')).toBeUndefined()
  })

  it('claude_code の他 mode にも渡さない', () => {
    const otherModes: AiCliMode[] = (['analyze', 'plan', 'explain'] as unknown as AiCliMode[])
      .filter((mode) => mode !== 'implement' && mode !== 'review')
    for (const mode of otherModes) {
      expect(aiCliTimeoutMs('claude_code', mode)).toBeUndefined()
    }
  })

  // 他 provider は implement であっても対象外。実測は claude_code のものしかない
  // （production の AI CLI Job 149 件はすべて claude_code）。測っていない provider へ広げない。
  it('他 provider は implement でも対象外', () => {
    const others: AiCliProvider[] = (['codex', 'gemini', 'copilot'] as unknown as AiCliProvider[])
      .filter((provider) => provider !== 'claude_code')
    for (const provider of others) {
      expect(aiCliTimeoutMs(provider, 'implement')).toBeUndefined()
      expect(aiCliTimeoutMs(provider, 'review')).toBeUndefined()
    }
  })

  // **値そのものを固定する。** 300_000 へ戻す変更はここで落ちる。
  it('implement の値は 300_000 ではない（既定へ戻したら落ちる）', () => {
    expect(aiCliTimeoutMs('claude_code', 'implement')).not.toBe(300_000)
    expect(aiCliTimeoutMs('claude_code', 'implement')).toBeGreaterThan(300_000)
  })
})
