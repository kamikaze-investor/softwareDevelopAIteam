import { describe, expect, it } from 'vitest'
import {
  assertGeneratorSeparatedFromFinalReviewer,
  isGeneratorSeparatedFromFinalReviewer,
  ProviderSeparationError,
  resolveReviewVendor,
} from './reviewSeparation'

/**
 * 生成したAIが自分の成果物を最終承認する構成を禁止する。
 *
 * 判定は**実際のprovider設定値**から、かつ**vendor単位**で行う。
 */
describe('generator / final reviewer の provider 分離', () => {
  it('異なるvendorなら分離が成立する', () => {
    expect(isGeneratorSeparatedFromFinalReviewer('codex', 'claude')).toBe(true)
    expect(() => assertGeneratorSeparatedFromFinalReviewer('codex', 'claude')).not.toThrow()
  })

  it('同一providerはfail-closedで拒否する', () => {
    expect(isGeneratorSeparatedFromFinalReviewer('codex', 'codex')).toBe(false)
    expect(() => assertGeneratorSeparatedFromFinalReviewer('codex', 'codex'))
      .toThrow(ProviderSeparationError)
  })

  // 独立レビュー指摘（2026-09-07）: このリポジトリには同一vendorを指す別名が実在する。
  // implementer側は`claude_code`、reviewer側は`claude`。素朴な文字列比較では
  // 「Claudeが生成してClaudeが最終承認する」構成を分離済みと誤判定する。
  it('同一vendorの別名（claude_code と claude）を分離とみなさない', () => {
    expect(isGeneratorSeparatedFromFinalReviewer('claude_code', 'claude')).toBe(false)
    expect(() => assertGeneratorSeparatedFromFinalReviewer('claude_code', 'claude'))
      .toThrow(/同一vendor/)
  })

  it('同一vendorの別名（codex と chatgpt）も分離とみなさない', () => {
    expect(isGeneratorSeparatedFromFinalReviewer('codex', 'chatgpt')).toBe(false)
    expect(() => assertGeneratorSeparatedFromFinalReviewer('chatgpt', 'codex')).toThrow(/同一vendor/)
  })

  // 分離を確認できない値を「分離済み」と言わない（fail-closed）。
  it('未知のprovider識別子は拒否する', () => {
    expect(isGeneratorSeparatedFromFinalReviewer('codex', 'mystery-model')).toBe(false)
    expect(() => assertGeneratorSeparatedFromFinalReviewer('codex', 'mystery-model'))
      .toThrow(/解決できません/)
  })

  it('空文字・空白のみの識別子も拒否する', () => {
    expect(() => assertGeneratorSeparatedFromFinalReviewer('', 'claude')).toThrow(/解決できません/)
    expect(() => assertGeneratorSeparatedFromFinalReviewer('codex', '   ')).toThrow(/解決できません/)
  })

  // PR C以前の現行topology（Claude Haiku生成 → Codex independent）で誤発火しないこと。
  // ここでthrowするhelperを配線すると、その瞬間にproductionが壊れる。
  it('現行topology（claude生成 / codex最終）でも誤って拒否しない', () => {
    expect(() => assertGeneratorSeparatedFromFinalReviewer('claude', 'codex')).not.toThrow()
    expect(() => assertGeneratorSeparatedFromFinalReviewer('claude_code', 'codex')).not.toThrow()
  })

  it('cutover後のtopology（codex生成 / claude最終）でも誤って拒否しない', () => {
    expect(() => assertGeneratorSeparatedFromFinalReviewer('codex', 'claude')).not.toThrow()
  })

  it('表記ゆれ（大文字小文字・前後空白）では分離とみなさない', () => {
    expect(isGeneratorSeparatedFromFinalReviewer('Codex', 'codex')).toBe(false)
    expect(isGeneratorSeparatedFromFinalReviewer(' CLAUDE_CODE ', 'claude')).toBe(false)
  })

  it('vendor解決は既知の識別子を正しく対応付ける', () => {
    expect(resolveReviewVendor('claude')).toBe('anthropic')
    expect(resolveReviewVendor('claude_code')).toBe('anthropic')
    expect(resolveReviewVendor('codex')).toBe('openai')
    expect(resolveReviewVendor('chatgpt')).toBe('openai')
    expect(resolveReviewVendor('gemini')).toBe('google')
    expect(resolveReviewVendor('unknown')).toBeUndefined()
  })

  // Copilotは複数vendor/modelを載せられるharnessなので、識別子だけでは分離を証明できない。
  // 独自vendorとして「他と独立」と判定すると、実体がClaudeやGPTだったときに
  // 自己レビューを通してしまう（CEO判断、2026-09-07）。
  it('copilot は underlying vendor 不明として fail-closed にする', () => {
    expect(resolveReviewVendor('copilot')).toBeUndefined()
    expect(isGeneratorSeparatedFromFinalReviewer('copilot', 'claude')).toBe(false)
    expect(() => assertGeneratorSeparatedFromFinalReviewer('copilot', 'claude'))
      .toThrow(/解決できません/)
    expect(() => assertGeneratorSeparatedFromFinalReviewer('codex', 'copilot'))
      .toThrow(/解決できません/)
  })

  // 今回のRoadmap topologyはこの1組だけなので、Copilotをunknown扱いにしても成立する。
  it('今回のtopology（codex生成 / claude最終）は影響を受けない', () => {
    expect(isGeneratorSeparatedFromFinalReviewer('codex', 'claude')).toBe(true)
  })

  it('エラーは両方のproviderと理由を含み、原因が読み取れる', () => {
    try {
      assertGeneratorSeparatedFromFinalReviewer('claude_code', 'claude')
      throw new Error('expected ProviderSeparationError')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderSeparationError)
      const error = err as ProviderSeparationError
      expect(error.generatorProvider).toBe('claude_code')
      expect(error.finalReviewerProvider).toBe('claude')
      expect(error.reason).toBe('same_vendor')
    }
  })
})
