import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { hasFormalVerdict, parseMetaReviewResult, tryParseMetaReviewResult } from './runner'

/**
 * `meta-review-structured-output-robustness` の受入条件。
 *
 * 中心となる不変条件は 1 つだけ:
 * **provider attempt が成功したかどうかは「formal verdict が成立したか」で決まり、
 * 「どの verdict だったか」では決まらない。**
 *
 * 後者で分岐させると、BLOCKED を別 provider で取り直す review shopping になる。
 */

function verdict(status: 'approved' | 'changes_requested' | 'blocked'): string {
  return JSON.stringify({
    status, riskLevel: 'low', requiresCeoApproval: false, summary: 's', findings: [],
  })
}

const TRUNCATED = '```json\n{\n  "status": "approved",\n  "summary": "センサー発火の重複'
const MALFORMED = '```json\n{ "status": }\n```'
const UNKNOWN_VERDICT = JSON.stringify({ status: 'looks_fine_to_me', summary: 's' })

describe('formal verdict predicate', () => {
  it('APPROVED / CHANGES_REQUESTED / BLOCKED はすべて成立扱い', () => {
    expect(hasFormalVerdict(verdict('approved'))).toBe(true)
    expect(hasFormalVerdict(verdict('changes_requested'))).toBe(true)
    expect(hasFormalVerdict(verdict('blocked'))).toBe(true)
  })

  it('fence の有無・前後の散文は成立可否に影響しない（既存 parser の受理範囲は不変）', () => {
    const v = verdict('approved')
    expect(hasFormalVerdict('```json\n' + v + '\n```')).toBe(true)
    expect(hasFormalVerdict('```\n' + v + '\n```')).toBe(true)
    expect(hasFormalVerdict('説明\n```json\n' + v + '\n```\n以上')).toBe(true)
  })

  it('empty / truncated / malformed / unknown verdict は不成立', () => {
    expect(hasFormalVerdict('')).toBe(false)
    expect(hasFormalVerdict('   ')).toBe(false)
    expect(hasFormalVerdict(TRUNCATED)).toBe(false)
    expect(hasFormalVerdict(MALFORMED)).toBe(false)
    expect(hasFormalVerdict(UNKNOWN_VERDICT)).toBe(false)
  })

  it('不成立でも parseMetaReviewResult は従来どおり fail-closed', () => {
    for (const bad of ['', TRUNCATED, MALFORMED, UNKNOWN_VERDICT]) {
      const r = parseMetaReviewResult(bad, 't')
      expect(r.status).toBe('blocked')
      expect(r.riskLevel).toBe('critical')
      expect(r.requiresCeoApproval).toBe(true)
    }
  })

  it('tryParse は成立時だけ結果を返す', () => {
    expect(tryParseMetaReviewResult(verdict('blocked'), 't')?.status).toBe('blocked')
    expect(tryParseMetaReviewResult(TRUNCATED, 't')).toBeUndefined()
  })
})

describe('provider chain: formal-verdict-aware fallback', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env.GEMINI_API_KEY = 'test-key'
    // agy を「存在しない」状態にして CLI 段を確定的に skip させる。
    process.env.AGY_CLI_PATH = '/nonexistent/agy-for-test'
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.restoreAllMocks()
  })

  async function loadChain(geminiResponses: string[], copilot: { ok: true; raw: string } | { ok: false }) {
    const geminiCalls: string[] = []
    const copilotCalls: string[] = []

    vi.doMock('./geminiClient.js', () => ({
      callGeminiForReview: vi.fn(async () => {
        const next = geminiResponses.shift()
        geminiCalls.push(next ?? '(exhausted)')
        if (next === undefined) throw new Error('no more scripted gemini responses')
        return next
      }),
    }))

    vi.doMock('./copilotRouter.js', () => ({
      DEFAULT_COPILOT_META_REVIEW_MODEL: 'mai-code-1.1-flash',
      callCopilotForMetaReview: vi.fn(() => {
        copilotCalls.push('called')
        if (!copilot.ok) throw new Error('Copilot CLI: No authentication information found.')
        return copilot.raw
      }),
    }))

    const { reviewWithProviderFallback } = await import('./metaReviewFallbackRouter.js')
    return { reviewWithProviderFallback, geminiCalls, copilotCalls }
  }

  const options = {
    preferCli: true,
    featureName: 'meta_review',
    retryTransient: true,
    sleepImpl: () => {},
    validateResponse: hasFormalVerdict,
  }

  it('A. Gemini が valid APPROVED なら Copilot を呼ばない', async () => {
    const { reviewWithProviderFallback, copilotCalls, geminiCalls } =
      await loadChain([verdict('approved')], { ok: true, raw: verdict('approved') })

    const result = await reviewWithProviderFallback('p', options)

    expect(result.providerUsed).toBe('gemini')
    expect(hasFormalVerdict(result.raw)).toBe(true)
    expect(copilotCalls).toHaveLength(0)
    expect(geminiCalls).toHaveLength(1)
  })

  it('B/G. Gemini が valid BLOCKED なら Copilot を呼ばない（Review Shopping 禁止）', async () => {
    const { reviewWithProviderFallback, copilotCalls, geminiCalls } =
      await loadChain([verdict('blocked')], { ok: true, raw: verdict('approved') })

    const result = await reviewWithProviderFallback('p', options)

    expect(result.providerUsed).toBe('gemini')
    expect(parseMetaReviewResult(result.raw, 't').status).toBe('blocked')
    // **BLOCKED を別 provider で approved に取り直さない。**
    expect(copilotCalls).toHaveLength(0)
    expect(geminiCalls).toHaveLength(1)
  })

  it('B. Gemini が valid CHANGES_REQUESTED でも Copilot を呼ばない', async () => {
    const { reviewWithProviderFallback, copilotCalls } =
      await loadChain([verdict('changes_requested')], { ok: true, raw: verdict('approved') })

    const result = await reviewWithProviderFallback('p', options)

    expect(parseMetaReviewResult(result.raw, 't').status).toBe('changes_requested')
    expect(copilotCalls).toHaveLength(0)
  })

  it('C. truncated 応答は bounded retry され、成立したらそれを採用する', async () => {
    const { reviewWithProviderFallback, copilotCalls, geminiCalls } =
      await loadChain([TRUNCATED, verdict('approved')], { ok: true, raw: verdict('approved') })

    const result = await reviewWithProviderFallback('p', options)

    expect(result.providerUsed).toBe('gemini')
    // 1回目 truncated -> 2回目で成立。Copilot までは行かない。
    expect(geminiCalls).toHaveLength(2)
    expect(copilotCalls).toHaveLength(0)
  })

  it('D. retry を使い切っても不成立なら Copilot へ fallback する', async () => {
    const { reviewWithProviderFallback, copilotCalls } =
      await loadChain([TRUNCATED, TRUNCATED, TRUNCATED, TRUNCATED], { ok: true, raw: verdict('changes_requested') })

    const result = await reviewWithProviderFallback('p', options)

    expect(result.providerUsed).toBe('copilot')
    expect(copilotCalls).toHaveLength(1)
  })

  it('D. malformed / parse failure も同じく Copilot へ到達する', async () => {
    const { reviewWithProviderFallback, copilotCalls } =
      await loadChain([MALFORMED, MALFORMED, MALFORMED, MALFORMED], { ok: true, raw: verdict('approved') })

    const result = await reviewWithProviderFallback('p', options)

    expect(result.providerUsed).toBe('copilot')
    expect(copilotCalls).toHaveLength(1)
  })

  it('E. Copilot が valid verdict を返したらそれを採用する', async () => {
    const { reviewWithProviderFallback } =
      await loadChain([TRUNCATED, TRUNCATED, TRUNCATED, TRUNCATED], { ok: true, raw: verdict('blocked') })

    const result = await reviewWithProviderFallback('p', options)

    expect(result.providerUsed).toBe('copilot')
    expect(parseMetaReviewResult(result.raw, 't').status).toBe('blocked')
  })

  it('F. Copilot が auth 失敗なら fail-closed（throw）', async () => {
    const { reviewWithProviderFallback } =
      await loadChain([TRUNCATED, TRUNCATED, TRUNCATED, TRUNCATED], { ok: false })

    await expect(reviewWithProviderFallback('p', options)).rejects.toThrow()
  })

  it('F. Copilot が応答しても formal verdict 不成立なら fail-closed（fail-open しない）', async () => {
    const { reviewWithProviderFallback } =
      await loadChain([TRUNCATED, TRUNCATED, TRUNCATED, TRUNCATED], { ok: true, raw: TRUNCATED })

    await expect(reviewWithProviderFallback('p', options)).rejects.toThrow(/formal verdict/i)
  })
})

describe('H. Copilot provenance and CI-only token', () => {
  const ORIGINAL_ENV = { ...process.env }

  // 前の describe が copilotRouter を doMock しているので解除してから実物を読む。
  beforeEach(() => {
    vi.doUnmock('./copilotRouter.js')
    vi.doUnmock('./geminiClient.js')
    vi.resetModules()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.resetModules()
  })

  it('model は Auto ではなく Microsoft 系モデルが明示指定される', async () => {
    const { DEFAULT_COPILOT_META_REVIEW_MODEL } = await import('./copilotRouter.js')
    expect(DEFAULT_COPILOT_META_REVIEW_MODEL).toBe('mai-code-1.1-flash')
    expect(DEFAULT_COPILOT_META_REVIEW_MODEL).not.toBe('auto')
  })

  it('GitHub Actions のときだけ GITHUB_TOKEN を子プロセスへ渡す', async () => {
    vi.resetModules()
    process.env.GITHUB_ACTIONS = 'true'
    process.env.GITHUB_TOKEN = 'ghs_exampleonly'
    const inCi = await import('./copilotRouter.js')
    expect(inCi.buildCopilotEnvForTest().GITHUB_TOKEN).toBe('ghs_exampleonly')

    vi.resetModules()
    delete process.env.GITHUB_ACTIONS
    const outsideCi = await import('./copilotRouter.js')
    expect(outsideCi.buildCopilotEnvForTest().GITHUB_TOKEN).toBeUndefined()
  })

  it('PAT 変数は読まない（PAT 配線を復活させない）', async () => {
    vi.resetModules()
    process.env.GITHUB_ACTIONS = 'true'
    delete process.env.GITHUB_TOKEN
    process.env.COPILOT_GITHUB_TOKEN = 'pat-must-not-be-used'
    process.env.GH_TOKEN = 'pat-must-not-be-used-either'

    const mod = await import('./copilotRouter.js')
    const env = mod.buildCopilotEnvForTest()

    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(Object.values(env)).not.toContain('pat-must-not-be-used')
    expect(Object.values(env)).not.toContain('pat-must-not-be-used-either')
  })

  it('env は必要最小限のキーだけで構成される', async () => {
    vi.resetModules()
    delete process.env.GITHUB_ACTIONS
    const mod = await import('./copilotRouter.js')
    const keys = Object.keys(mod.buildCopilotEnvForTest()).sort()
    for (const k of keys) {
      expect(['PATH', 'HOME', 'LANG', 'TERM']).toContain(k)
    }
  })
})

describe('Independent Review 2026-09-17: gate predicate strictness and no-shopping', () => {
  it('切れた応答の中に早期の完全オブジェクトがあっても成立にしない', () => {
    // 独立レビュー指摘の再現形。最終 parser は受理するが gate 述語は拒否する。
    const sneaky = '```json\n{"status":"approved"} trailing {'
    expect(hasFormalVerdict(sneaky)).toBe(false)
  })

  it('status だけで他が欠けている応答は成立にしない', () => {
    expect(hasFormalVerdict(JSON.stringify({ status: 'approved' }))).toBe(false)
    expect(hasFormalVerdict(JSON.stringify({ status: 'approved', summary: 's' }))).toBe(false)
    expect(hasFormalVerdict(JSON.stringify({
      status: 'approved', summary: 's', riskLevel: 'low',
    }))).toBe(false)
  })

  it('必要項目がすべて揃っていれば成立する', () => {
    expect(hasFormalVerdict(JSON.stringify({
      status: 'blocked', riskLevel: 'critical', summary: 's',
      findings: [], requiresCeoApproval: true,
    }))).toBe(true)
  })

  it('gate 述語は最終 parser より厳しい（緩い方向へは倒れない）', () => {
    const lenientlyParseable = JSON.stringify({ status: 'approved' })
    // 最終 parser は既定値で埋めて受理する（既存挙動は変えない）。
    expect(parseMetaReviewResult(lenientlyParseable, 't').status).toBe('approved')
    // しかし gate 述語は成立とみなさない = retry / fallback へ進む = 安全側。
    expect(hasFormalVerdict(lenientlyParseable)).toBe(false)
  })
})

describe('Independent Review 2026-09-17 R2: validated object == finalized object', () => {
  it('早期の緩い APPROVED より後続の厳密な BLOCKED を採用する', () => {
    // 独立レビュー R2 の再現形。検証と最終採用が別の object を選んでいた。
    const mixed = [
      '```json',
      JSON.stringify({ status: 'approved' }),
      '```',
      '',
      '```json',
      JSON.stringify({
        status: 'blocked', riskLevel: 'critical', summary: 'real verdict',
        findings: [{ severity: 'critical', category: 'security_regression', message: 'm' }],
        requiresCeoApproval: true,
      }),
      '```',
    ].join('\n')

    expect(hasFormalVerdict(mixed)).toBe(true)
    // **BLOCKED が捨てられて APPROVED が残ってはいけない。**
    expect(parseMetaReviewResult(mixed, 't').status).toBe('blocked')
  })

  it('findings の要素が空オブジェクトなら成立にしない', () => {
    expect(hasFormalVerdict(JSON.stringify({
      status: 'approved', riskLevel: 'low', summary: 's',
      findings: [{}], requiresCeoApproval: false,
    }))).toBe(false)
  })

  it('findings に message があれば成立する', () => {
    expect(hasFormalVerdict(JSON.stringify({
      status: 'changes_requested', riskLevel: 'medium', summary: 's',
      findings: [{ severity: 'medium', category: 'scope_creep', message: 'm' }],
      requiresCeoApproval: false,
    }))).toBe(true)
  })
})

describe('Independent Review 2026-09-17 R3', () => {
  it('finding の severity / category が欠けていれば成立にしない', () => {
    const base = { status: 'approved', riskLevel: 'low', summary: 's', requiresCeoApproval: false }
    expect(hasFormalVerdict(JSON.stringify({ ...base, findings: [{ message: 'm' }] }))).toBe(false)
    expect(hasFormalVerdict(JSON.stringify({
      ...base, findings: [{ severity: 'low', message: 'm' }],
    }))).toBe(false)
    expect(hasFormalVerdict(JSON.stringify({
      ...base, findings: [{ severity: 'low', category: 'scope_creep', message: '  ' }],
    }))).toBe(false)
    // 契約を満たせば成立する。
    expect(hasFormalVerdict(JSON.stringify({
      ...base, findings: [{ severity: 'low', category: 'scope_creep', message: 'm' }],
    }))).toBe(true)
  })
})
