import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./geminiRouter.js', () => ({
  callGeminiWithFallback: vi.fn(),
}))

vi.mock('./runner.js', () => ({
  buildMetaReviewRequest: vi.fn(() => ({
    taskId: 'task-test',
    taskTitle: 'Test task',
    targetArea: 'target_project',
    changedFiles: ['example.test.ts'],
    gitDiff: 'diff',
    relatedSpecs: [],
  })),
  buildMetaReviewPrompt: vi.fn(() => 'legacy meta review prompt'),
  parseMetaReviewResult: vi.fn(() => ({
    id: 'meta-review-task-test',
    taskId: 'task-test',
    status: 'approved',
    riskLevel: 'low',
    summary: 'legacy approved',
    findings: [],
    requiresCeoApproval: false,
    createdAt: '2026-08-13T00:00:00.000Z',
  })),
}))

import { callGeminiWithFallback } from './geminiRouter.js'
import {
  buildMetaReviewPrompt,
  parseMetaReviewResult,
} from './runner.js'
import {
  runStrategicMetaReview,
} from './strategicReview.js'

const mockCallGeminiWithFallback = vi.mocked(callGeminiWithFallback)
const mockBuildMetaReviewPrompt = vi.mocked(buildMetaReviewPrompt)
const mockParseMetaReviewResult = vi.mocked(parseMetaReviewResult)
const repoRoot = resolve(__dirname, '../../../..')

beforeEach(() => {
  vi.clearAllMocks()
  mockCallGeminiWithFallback.mockResolvedValue(jsonDecision('ALIGNED'))
  mockParseMetaReviewResult.mockReturnValue({
    id: 'meta-review-task-test',
    taskId: 'task-test',
    status: 'approved',
    riskLevel: 'low',
    summary: 'legacy approved',
    findings: [],
    requiresCeoApproval: false,
    createdAt: '2026-08-13T00:00:00.000Z',
  })
})

describe('runStrategicMetaReview', () => {
  it('keeps LOW review load on the legacy single-call Meta Review path', async () => {
    const result = await runStrategicMetaReview({
      taskId: 'task-low',
      taskTitle: 'Only test updates',
      changedFiles: ['apps/worker/src/example.test.ts'],
      gitDiff: makeLargeDiff(300),
      workingDir: repoRoot,
    })

    expect(result.reviewLoad).toBe('low')
    expect(result.selectedFocuses).toEqual([])
    expect(result.focusedReviewResults).toEqual([])
    expect(mockBuildMetaReviewPrompt).toHaveBeenCalledOnce()
    expect(mockCallGeminiWithFallback).toHaveBeenCalledOnce()
    expect(mockCallGeminiWithFallback.mock.calls[0][0]).toBe('legacy meta review prompt')
  })

  it('does not require CEO approval for LOW legacy CONFLICT without an explicit approval flag', async () => {
    mockParseMetaReviewResult.mockReturnValue({
      id: 'meta-review-task-test',
      taskId: 'task-test',
      status: 'changes_requested',
      riskLevel: 'low',
      summary: 'legacy requested changes',
      findings: [],
      requiresCeoApproval: false,
      createdAt: '2026-08-13T00:00:00.000Z',
    })

    const result = await runStrategicMetaReview({
      taskId: 'task-low-conflict',
      taskTitle: 'Only test updates',
      changedFiles: ['apps/worker/src/example.test.ts'],
      gitDiff: makeLargeDiff(300),
      workingDir: repoRoot,
    })

    expect(result.reviewLoad).toBe('low')
    expect(result.finalDecision).toBe('CONFLICT')
    expect(result.independentReviewRequired).toBe(false)
    expect(result.requiresCeoApproval).toBe(false)
  })

  it('sets independentReviewRequired for CRITICAL review load', async () => {
    mockCallGeminiWithFallback
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'strategic aligned'))
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'architecture aligned'))
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'integration aligned'))

    const result = await runStrategicMetaReview({
      taskId: 'task-critical',
      taskTitle: 'Meta reviewer hardening',
      changedFiles: ['apps/worker/src/metaReviewer/strategicReview.ts'],
      gitDiff: 'diff --git a/apps/worker/src/metaReviewer/strategicReview.ts b/apps/worker/src/metaReviewer/strategicReview.ts',
      workingDir: repoRoot,
    })

    expect(result.reviewLoad).toBe('critical')
    expect(result.selectedFocuses).toContain('strategic_alignment')
    expect(result.independentReviewRequired).toBe(true)
  })

  it('requires CEO approval for CRITICAL CONFLICT', async () => {
    mockCallGeminiWithFallback
      .mockResolvedValueOnce(jsonDecision('CONFLICT', 'critical conflict'))
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'architecture aligned'))
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'integration aligned'))

    const result = await runStrategicMetaReview({
      taskId: 'task-critical-conflict',
      taskTitle: 'Meta reviewer hardening',
      changedFiles: ['apps/worker/src/metaReviewer/strategicReview.ts'],
      gitDiff: 'diff --git a/apps/worker/src/metaReviewer/strategicReview.ts b/apps/worker/src/metaReviewer/strategicReview.ts',
      workingDir: repoRoot,
    })

    expect(result.reviewLoad).toBe('critical')
    expect(result.finalDecision).toBe('CONFLICT')
    expect(result.independentReviewRequired).toBe(true)
    expect(result.requiresCeoApproval).toBe(true)
  })

  it('returns CONFLICT when Strategic Alignment Focus returns CONFLICT', async () => {
    mockCallGeminiWithFallback
      .mockResolvedValueOnce(jsonDecision('CONFLICT', 'goal conflict'))
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'data aligned'))
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'integration aligned'))

    const result = await runStrategicMetaReview(highStorageInput())

    expect(result.reviewLoad).toBe('high')
    expect(result.strategicAlignmentResult?.decision).toBe('CONFLICT')
    expect(result.finalDecision).toBe('CONFLICT')
    expect(result.independentReviewRequired).toBe(false)
    expect(result.requiresCeoApproval).toBe(false)
  })

  it('returns CONFLICT when Integration Review returns CONFLICT even if Focused Reviews are ALIGNED', async () => {
    mockCallGeminiWithFallback
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'strategic aligned'))
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'data aligned'))
      .mockResolvedValueOnce(jsonDecision('CONFLICT', 'combined result conflicts'))

    const result = await runStrategicMetaReview(highStorageInput())

    expect(result.focusedReviewResults.every((focused) => focused.decision === 'ALIGNED')).toBe(true)
    expect(result.integrationReviewResult?.decision).toBe('CONFLICT')
    expect(result.finalDecision).toBe('CONFLICT')
  })

  it('returns UNCERTAIN when there is UNCERTAIN and no CONFLICT', async () => {
    mockCallGeminiWithFallback
      .mockResolvedValueOnce(jsonDecision('UNCERTAIN', 'strategic assumption unresolved'))
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'data aligned'))
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'integration aligned'))

    const result = await runStrategicMetaReview(highStorageInput())

    expect(result.finalDecision).toBe('UNCERTAIN')
    expect(result.independentReviewRequired).toBe(false)
    expect(result.requiresCeoApproval).toBe(true)
  })

  it('labels pre-implementation design material as text instead of diff', async () => {
    mockCallGeminiWithFallback
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'strategic aligned'))
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'data aligned'))
      .mockResolvedValueOnce(jsonDecision('ALIGNED', 'integration aligned'))

    await runStrategicMetaReview({
      ...highStorageInput(),
      gitDiff: 'Design: reuse the current Meta Reviewer router and split calls by focus.',
      materialKind: 'design',
    })

    const prompt = mockCallGeminiWithFallback.mock.calls[0][0]
    expect(prompt).toContain('## Proposed Design (pre-implementation, not yet a diff)')
    expect(prompt).toContain('```text\nDesign: reuse the current Meta Reviewer router')
    expect(prompt).not.toContain('## Git Diff or Design Text\n\n```diff\nDesign:')
  })

  it('fails closed without calling Gemini when non-strategic checklist context is missing', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'strategic-review-empty-'))

    try {
      const result = await runStrategicMetaReview({
        taskId: 'task-missing-checklist',
        taskTitle: 'Mobile UI adjustment',
        changedFiles: ['apps/mobile/app/index.tsx'],
        gitDiff: 'diff --git a/apps/mobile/app/index.tsx b/apps/mobile/app/index.tsx',
        workingDir: tempRoot,
      })

      expect(result.reviewLoad).toBe('medium')
      expect(result.selectedFocuses).toEqual(['product_ceo_experience'])
      expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
      expect(result.requiresCeoApproval).toBe(true)
      expect(mockCallGeminiWithFallback).not.toHaveBeenCalled()
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('never returns ALIGNED when Gemini throws during a required Focused Review', async () => {
    mockCallGeminiWithFallback.mockRejectedValueOnce(new Error('timeout'))

    const result = await runStrategicMetaReview({
      taskId: 'task-medium',
      taskTitle: 'Mobile UI adjustment',
      changedFiles: ['apps/mobile/app/index.tsx'],
      gitDiff: 'diff --git a/apps/mobile/app/index.tsx b/apps/mobile/app/index.tsx',
      workingDir: repoRoot,
    })

    expect(result.reviewLoad).toBe('medium')
    expect(result.finalDecision).not.toBe('ALIGNED')
    expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
    expect(result.requiresCeoApproval).toBe(true)
    expect(result.independentReviewRequired).toBe(false)
  })
})

function highStorageInput(): Parameters<typeof runStrategicMetaReview>[0] {
  return {
    taskId: 'task-high',
    taskTitle: 'Storage state hardening',
    changedFiles: ['apps/api/src/storage/schema.ts'],
    gitDiff: 'diff --git a/apps/api/src/storage/schema.ts b/apps/api/src/storage/schema.ts',
    workingDir: repoRoot,
  }
}

function jsonDecision(decision: 'ALIGNED' | 'CONFLICT' | 'UNCERTAIN', summary = 'ok'): string {
  return JSON.stringify({
    decision,
    summary,
    findings: [],
  })
}

function makeLargeDiff(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `+expect(value${index}).toBe(true)`).join('\n')
}
