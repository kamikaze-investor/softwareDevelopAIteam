import { beforeEach, describe, expect, it, vi } from 'vitest'

// callGeminiWithFallback だけを差し替え、AGY_* モデル定数など他の export は実物を使う
// （定数を落とすと呼び出し元の `...AGY_LIGHT_MODEL` が undefined 展開で壊れる）。
vi.mock('../metaReviewer/geminiRouter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../metaReviewer/geminiRouter.js')>()),
  callGeminiWithFallback: vi.fn(),
}))

import { callGeminiWithFallback } from '../metaReviewer/geminiRouter.js'
import {
  buildStepReviewPrompt,
  createNotRunStepReviewResult,
  createPendingStepReviewResult,
  parseStepReviewResponse,
  runStepReview,
} from './stepReview.js'
import type { StepReviewInput } from './stepReview.js'

const mockCallGeminiWithFallback = vi.mocked(callGeminiWithFallback)

function makeInput(overrides: Partial<StepReviewInput> = {}): StepReviewInput {
  return {
    jobId: 'job-1',
    taskId: 'task-1',
    stepSummary: 'health.tsに/api/healthルートを追加した',
    purposeSummary: '代表Health Endpointの追加',
    mechanicalSafetyResultSummary: 'test/typecheckともにPASS',
    targetFiles: ['apps/api/src/routes/health.ts'],
    ...overrides,
  }
}

function jsonResponse(body: Record<string, unknown>): string {
  return ['```json', JSON.stringify(body), '```'].join('\n')
}

beforeEach(() => {
  mockCallGeminiWithFallback.mockReset()
})

describe('buildStepReviewPrompt', () => {
  it('過去Stepの経緯を含めず、今回のStep要約・目的・機械チェック結果の要約のみを含める', () => {
    const prompt = buildStepReviewPrompt(makeInput())

    expect(prompt).toContain('health.tsに/api/healthルートを追加した')
    expect(prompt).toContain('代表Health Endpointの追加')
    expect(prompt).toContain('test/typecheckともにPASS')
    expect(prompt).toContain('apps/api/src/routes/health.ts')
  })

  it('停止権限を持たない旨をプロンプトに明記する', () => {
    const prompt = buildStepReviewPrompt(makeInput())

    expect(prompt).toContain('最終判断者ではありません')
  })

  it('Constitution 3.14〜3.15 の原則本文が含まれる', () => {
    const prompt = buildStepReviewPrompt(makeInput())

    expect(prompt).toContain('## 3.14 Minimum Sufficient Validation')
    expect(prompt).toContain('必要最小限の独立した反証レビュー')
    expect(prompt).toContain('CEO確認は、原則として次の場合に限る')
  })
})

describe('parseStepReviewResponse', () => {
  it('正常なJSON応答をパースしてstatus:doneを返す', () => {
    const raw = jsonResponse({
      importance: 'low',
      routing: 'proceed_candidate',
      summary: '問題なし',
      concerns: [],
      requiredFixes: [],
      escalationReason: null,
      confidence: 0.9,
    })

    const result = parseStepReviewResponse(raw)

    expect(result.status).toBe('done')
    expect(result.importance).toBe('low')
    expect(result.routing).toBe('proceed_candidate')
    expect(result.confidence).toBe(0.9)
  })

  it('importance/routingが不正な場合はstatus:failedを返す（例外を投げない）', () => {
    const result = parseStepReviewResponse(jsonResponse({ importance: 'unknown', routing: 'proceed_candidate' }))

    expect(result.status).toBe('failed')
    expect(result.confidence).toBe(0)
  })

  it('JSONとして壊れている応答でもstatus:failedを返す（例外を投げない）', () => {
    const result = parseStepReviewResponse('not json at all')

    expect(result.status).toBe('failed')
    expect(result.summary).toContain('パースに失敗')
  })
})

describe('runStepReview', () => {
  it('Gemini呼び出しが成功すればstatus:doneのStepReviewResultを返す', async () => {
    mockCallGeminiWithFallback.mockResolvedValueOnce(
      jsonResponse({
        importance: 'medium',
        routing: 'fix_required',
        summary: '軽微な修正が必要',
        concerns: ['エラーハンドリング不足'],
        requiredFixes: ['try/catchを追加'],
        escalationReason: null,
        confidence: 0.7,
      }),
    )

    const result = await runStepReview(makeInput())

    expect(result.status).toBe('done')
    expect(result.importance).toBe('medium')
    expect(result.routing).toBe('fix_required')
  })

  it('Gemini呼び出しが失敗（quota枯渇等）してもstatus:failedを返し、例外を投げない（既存フローを止めない）', async () => {
    mockCallGeminiWithFallback.mockRejectedValueOnce(new Error('Gemini quota exhausted'))

    const result = await runStepReview(makeInput())

    expect(result.status).toBe('failed')
    expect(result.summary).toContain('Gemini quota exhausted')
    expect(result.confidence).toBe(0)
  })
})

describe('createNotRunStepReviewResult / createPendingStepReviewResult', () => {
  it('not_runの結果は呼び出しを行わず理由を保持する', () => {
    const result = createNotRunStepReviewResult('Level 1のため未実行')

    expect(result.status).toBe('not_run')
    expect(result.summary).toBe('Level 1のため未実行')
    expect(mockCallGeminiWithFallback).not.toHaveBeenCalled()
  })

  it('pendingの結果は呼び出し待ちであることを表現する', () => {
    const result = createPendingStepReviewResult('PR作成後に実行予定')

    expect(result.status).toBe('pending')
    expect(result.summary).toBe('PR作成後に実行予定')
  })
})
