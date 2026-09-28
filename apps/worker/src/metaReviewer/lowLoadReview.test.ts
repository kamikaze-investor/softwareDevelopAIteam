import { existsSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// provider だけを差し替える。**prompt の組み立て（runner.ts）は本物を使う** ——
// 直したいのは「どの root から prompt.md を読むか」なので、そこを mock すると何も確かめられない。
vi.mock('./metaReviewFallbackRouter.js', () => ({
  reviewWithProviderFallback: vi.fn(),
}))

import { reviewWithProviderFallback } from './metaReviewFallbackRouter.js'
import { runStrategicMetaReview } from './strategicReview.js'

const mockProvider = vi.mocked(reviewWithProviderFallback)

/**
 * **low-load の Design Review（docs / test / 非 policy markdown だけの変更）。**
 *
 * 2026-09-28 production（run `d0af140a`）で次の 2 つが同時に起きていた:
 *
 *   1. prompt を container 時代の `/workspace/control` から読もうとして ENOENT
 *      （VPS にはそのディレクトリが無く、runner の最小 env には `CONTROL_ROOT` も届かない）
 *   2. 失敗結果に実行されなかった `strategic_alignment` focus が足され、API には
 *      `focus set mismatch` として見えた（本当の原因が隠れた）
 *
 * ここで固定するのは、coordinator が解決済みの `controlContextDir` から prompt を読むこと、
 * そして読めなかったときに架空の focus を作らず REVIEW_UNAVAILABLE と理由を返すことである。
 */

/** このテストファイルから見たリポジトリの root（= VPS の clone と同じ構造）。 */
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const DOCS_ONLY = ['docs/project_memory/decisions/vps-operations.md']

function input(controlContextDir?: string) {
  return {
    reviewKind: 'task' as const,
    subjectId: 'task-low-load',
    taskTitle: 'docs-only task',
    changedFiles: DOCS_ONLY,
    gitDiff: 'diff --git a/docs/project_memory/decisions/vps-operations.md ...',
    workingDir: REPO_ROOT,
    ...(controlContextDir !== undefined ? { controlContextDir } : {}),
  }
}

function legacyResponse(status: 'approved' | 'changes_requested' | 'blocked'): string {
  return JSON.stringify({
    status,
    riskLevel: 'low',
    summary: `legacy review said ${status}`,
    findings: [],
    requiresCeoApproval: false,
  })
}

describe('low-load Design Review', () => {
  beforeEach(() => {
    mockProvider.mockReset()
  })

  it('前提: 実 repo には prompt.md があり、container 時代の /workspace/control は無い', () => {
    expect(existsSync(path.join(REPO_ROOT, 'docs/meta_reviewer/prompt.md'))).toBe(true)
    // この前提が崩れる（CI が /workspace/control を持つ）と T1 は何も証明しなくなる。
    expect(existsSync('/workspace/control/docs/meta_reviewer/prompt.md')).toBe(false)
  })

  describe('T1 VPS / repo-root prompt resolution', () => {
    it('controlContextDir（repo root）から prompt.md を読み、provider へ本文を渡す', async () => {
      mockProvider.mockResolvedValue({ raw: legacyResponse('approved') } as never)

      await runStrategicMetaReview(input(REPO_ROOT))

      expect(mockProvider).toHaveBeenCalledTimes(1)
      const prompt = mockProvider.mock.calls[0]![0] as string
      // 読めた証拠は prompt.md の本文が実際に載っていること。
      const promptHead = (await import('node:fs')).readFileSync(
        path.join(REPO_ROOT, 'docs/meta_reviewer/prompt.md'), 'utf-8',
      ).split(/\r?\n/).find((line) => line.trim() !== '')!
      expect(prompt).toContain(promptHead)
    })
  })

  describe('T2 low-load docs review', () => {
    it('docs-only は low-load になり、ENOENT にならず review の判定まで届く', async () => {
      mockProvider.mockResolvedValue({ raw: legacyResponse('approved') } as never)

      const result = await runStrategicMetaReview(input(REPO_ROOT))

      expect(result.reviewLoad).toBe('low')
      expect(result.selectedFocuses).toEqual([])
      expect(result.focusedReviewResults).toEqual([])
      expect(result.finalDecision).toBe('ALIGNED')
      // API の recompute は finalDecision を読まないので、判定は構造化された枠で渡す。
      expect(result.integrationReviewResult).toEqual({
        decision: 'ALIGNED', summary: 'legacy review said approved',
      })
      expect(result.unavailableReason).toBeUndefined()
    })

    it('changes_requested は CONFLICT として同じ枠で渡る（未知値が ALIGNED へ化けない）', async () => {
      mockProvider.mockResolvedValue({ raw: legacyResponse('changes_requested') } as never)

      const result = await runStrategicMetaReview(input(REPO_ROOT))

      expect(result.finalDecision).toBe('CONFLICT')
      expect(result.integrationReviewResult?.decision).toBe('CONFLICT')
    })
  })

  describe('T3 unavailable propagation', () => {
    it('prompt が読めないと REVIEW_UNAVAILABLE になり、理由に本当の原因が残る', async () => {
      const missing = path.join(REPO_ROOT, 'does-not-exist-control-root')

      const result = await runStrategicMetaReview(input(missing))

      expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
      expect(result.unavailableReason).toContain('ENOENT')
      expect(result.unavailableReason).toContain('prompt.md')
      // prompt を組めていないので provider は呼ばれない。
      expect(mockProvider).not.toHaveBeenCalled()
    })

    it('provider が失敗しても REVIEW_UNAVAILABLE になり、理由が残る', async () => {
      mockProvider.mockRejectedValue(new Error('provider exhausted: HTTP 402'))

      const result = await runStrategicMetaReview(input(REPO_ROOT))

      expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
      expect(result.unavailableReason).toContain('provider exhausted')
    })
  })

  describe('T4 架空の focus を作らない', () => {
    it('unavailable のとき focus 結果は空のままで、strategic_alignment が足されない', async () => {
      const result = await runStrategicMetaReview(input(path.join(REPO_ROOT, 'does-not-exist-control-root')))

      expect(result.selectedFocuses).toEqual([])
      // **ここに strategic_alignment が 1 件でもあると、API は focus set mismatch として弾き、
      // 本当の原因（ENOENT）が見えなくなる。**
      expect(result.focusedReviewResults).toEqual([])
      expect(result.strategicAlignmentResult).toBeUndefined()
    })
  })
})

describe('runner.ts の既定（CI / container）を壊さない', () => {
  it('root を渡さない呼び出しは従来どおり CONTROL_ROOT を使う', async () => {
    // `CONTROL_ROOT` は module 読み込み時に確定するので、env を先に置いてから読み直す。
    vi.resetModules()
    const previous = process.env.CONTROL_ROOT
    process.env.CONTROL_ROOT = REPO_ROOT
    try {
      const runner = await vi.importActual<typeof import('./runner.js')>('./runner.js')
      const request = runner.buildMetaReviewRequest('t', 'title', DOCS_ONLY, REPO_ROOT, 'diff')
      expect(() => runner.buildMetaReviewPrompt(request)).not.toThrow()
    } finally {
      if (previous === undefined) delete process.env.CONTROL_ROOT
      else process.env.CONTROL_ROOT = previous
      vi.resetModules()
    }
  })

  it('既定の CONTROL_ROOT が存在しなければ、従来どおり読み込みに失敗する（黙って別の root へ逃げない）', async () => {
    vi.resetModules()
    const previous = process.env.CONTROL_ROOT
    process.env.CONTROL_ROOT = path.join(REPO_ROOT, 'does-not-exist-control-root')
    try {
      const runner = await vi.importActual<typeof import('./runner.js')>('./runner.js')
      const request = runner.buildMetaReviewRequest('t', 'title', DOCS_ONLY, REPO_ROOT, 'diff')
      expect(() => runner.buildMetaReviewPrompt(request)).toThrow(/ENOENT/)
    } finally {
      if (previous === undefined) delete process.env.CONTROL_ROOT
      else process.env.CONTROL_ROOT = previous
      vi.resetModules()
    }
  })
})
