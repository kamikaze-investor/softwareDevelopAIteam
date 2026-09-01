import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./metaReviewFallbackRouter.js', () => ({
  reviewWithProviderFallback: vi.fn(),
}))

vi.mock('../aiCli/factory.js', () => ({
  createAiCliAdapter: vi.fn(),
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

import { createAiCliAdapter } from '../aiCli/factory.js'
import { reviewWithProviderFallback } from './metaReviewFallbackRouter.js'
import {
  buildMetaReviewPrompt,
  parseMetaReviewResult,
} from './runner.js'
import {
  applyIndependentReviewOverride,
  runIndependentReview,
  runStrategicMetaReview,
} from './strategicReview.js'

const mockReviewWithProviderFallback = vi.mocked(reviewWithProviderFallback)
const mockBuildMetaReviewPrompt = vi.mocked(buildMetaReviewPrompt)
const mockParseMetaReviewResult = vi.mocked(parseMetaReviewResult)
const mockCreateAiCliAdapter = vi.mocked(createAiCliAdapter)
const repoRoot = resolve(__dirname, '../../../..')

/** Codex reviewer JSON response wrapped the way CodexReviewerAdapter expects (stdout, exitCode 0). */
function mockCodexReviewerRun(
  verdict: 'approved' | 'changes_requested' | 'blocking',
  summary = 'codex independent review',
): void {
  const stdout = JSON.stringify({ verdict, summary, issues: [], confidence: 0.9 })
  mockCreateAiCliAdapter.mockReturnValue({
    run: vi.fn().mockResolvedValue({ blocked: false, exitCode: 0, stdout, stderr: '' }),
  } as unknown as ReturnType<typeof createAiCliAdapter>)
}

function mockCodexReviewerFailure(): void {
  mockCreateAiCliAdapter.mockReturnValue({
    run: vi.fn().mockResolvedValue({ blocked: false, exitCode: 1, stdout: '', stderr: 'codex unavailable' }),
  } as unknown as ReturnType<typeof createAiCliAdapter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockReviewWithProviderFallback.mockResolvedValue({ raw: jsonDecision('ALIGNED'), providerUsed: 'gemini' })
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
  mockCodexReviewerRun('approved')
})

describe('runStrategicMetaReview', () => {
  it('keeps LOW review load on the legacy single-call Meta Review path', async () => {
    const result = await runStrategicMetaReview({
      subjectId: 'task-low',
      taskTitle: 'Only test updates',
      changedFiles: ['apps/worker/src/example.test.ts'],
      gitDiff: makeLargeDiff(300),
      workingDir: repoRoot,
    })

    expect(result.reviewLoad).toBe('low')
    expect(result.selectedFocuses).toEqual([])
    expect(result.focusedReviewResults).toEqual([])
    expect(mockBuildMetaReviewPrompt).toHaveBeenCalledOnce()
    expect(mockReviewWithProviderFallback).toHaveBeenCalledOnce()
    expect(mockReviewWithProviderFallback.mock.calls[0][0]).toBe('legacy meta review prompt')
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
      subjectId: 'task-low-conflict',
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
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'strategic aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'architecture aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'integration aligned'), providerUsed: 'gemini' })

    const result = await runStrategicMetaReview({
      subjectId: 'task-critical',
      taskTitle: 'Meta reviewer hardening',
      changedFiles: ['apps/worker/src/metaReviewer/strategicReview.ts'],
      gitDiff: 'diff --git a/apps/worker/src/metaReviewer/strategicReview.ts b/apps/worker/src/metaReviewer/strategicReview.ts',
      workingDir: repoRoot,
    })

    expect(result.reviewLoad).toBe('critical')
    expect(result.selectedFocuses).toContain('strategic_alignment')
    expect(result.independentReviewRequired).toBe(true)
  })

  it('actually executes an Independent Review for CRITICAL, not just the flag', async () => {
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'strategic aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'architecture aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'integration aligned'), providerUsed: 'gemini' })
    mockCodexReviewerRun('approved', 'independent codex review approved')

    const result = await runStrategicMetaReview({
      subjectId: 'task-critical-independent',
      taskTitle: 'Meta reviewer hardening',
      changedFiles: ['apps/worker/src/metaReviewer/strategicReview.ts'],
      gitDiff: 'diff --git a/apps/worker/src/metaReviewer/strategicReview.ts b/apps/worker/src/metaReviewer/strategicReview.ts',
      workingDir: repoRoot,
    })

    expect(mockCreateAiCliAdapter).toHaveBeenCalledTimes(1)
    expect(result.independentReviewResult).toBeDefined()
    expect(result.independentReviewResult?.provider).toBe('codex')
    expect(result.independentReviewResult?.verdict).toBe('approved')
    expect(result.finalDecision).toBe('ALIGNED')
  })

  it('does not call the Independent Reviewer for non-CRITICAL review load', async () => {
    await runStrategicMetaReview(highStorageInput())

    expect(mockCreateAiCliAdapter).not.toHaveBeenCalled()
  })

  it('does not feed the Independent Reviewer the primary Gemini prompt or response', async () => {
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'strategic aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'architecture aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'integration aligned'), providerUsed: 'gemini' })
    const run = vi.fn().mockResolvedValue({
      blocked: false,
      exitCode: 0,
      stdout: JSON.stringify({ verdict: 'approved', summary: 'ok', issues: [], confidence: 0.9 }),
      stderr: '',
    })
    mockCreateAiCliAdapter.mockReturnValue({ run } as unknown as ReturnType<typeof createAiCliAdapter>)

    await runStrategicMetaReview({
      subjectId: 'task-critical-independence',
      taskTitle: 'Meta reviewer hardening',
      changedFiles: ['apps/worker/src/metaReviewer/strategicReview.ts'],
      gitDiff: 'diff --git a/apps/worker/src/metaReviewer/strategicReview.ts b/apps/worker/src/metaReviewer/strategicReview.ts',
      workingDir: repoRoot,
    })

    const reviewCall = run.mock.calls[0][0] as { prompt: string }
    expect(reviewCall.prompt).not.toContain('strategic aligned')
    expect(reviewCall.prompt).not.toContain('architecture aligned')
    expect(reviewCall.prompt).not.toContain('integration aligned')
  })

  it('overrides CRITICAL ALIGNED to CONFLICT when the Independent Review blocks', async () => {
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'strategic aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'architecture aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'integration aligned'), providerUsed: 'gemini' })
    mockCodexReviewerRun('blocking', 'independent reviewer found a critical safety gap')

    const result = await runStrategicMetaReview({
      subjectId: 'task-critical-blocked',
      taskTitle: 'Meta reviewer hardening',
      changedFiles: ['apps/worker/src/metaReviewer/strategicReview.ts'],
      gitDiff: 'diff --git a/apps/worker/src/metaReviewer/strategicReview.ts b/apps/worker/src/metaReviewer/strategicReview.ts',
      workingDir: repoRoot,
    })

    expect(result.finalDecision).toBe('CONFLICT')
    expect(result.independentReviewResult?.verdict).toBe('blocking')
    expect(result.requiresCeoApproval).toBe(true)
  })

  it('fails closed to REVIEW_UNAVAILABLE when the Independent Reviewer itself is unavailable', async () => {
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'strategic aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'architecture aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'integration aligned'), providerUsed: 'gemini' })
    mockCodexReviewerFailure()

    const result = await runStrategicMetaReview({
      subjectId: 'task-critical-reviewer-unavailable',
      taskTitle: 'Meta reviewer hardening',
      changedFiles: ['apps/worker/src/metaReviewer/strategicReview.ts'],
      gitDiff: 'diff --git a/apps/worker/src/metaReviewer/strategicReview.ts b/apps/worker/src/metaReviewer/strategicReview.ts',
      workingDir: repoRoot,
    })

    expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
    expect(result.requiresCeoApproval).toBe(true)
  })

  it('does not run the Independent Reviewer when the primary review is already unavailable', async () => {
    mockReviewWithProviderFallback.mockRejectedValueOnce(new Error('gemini timeout'))

    const result = await runStrategicMetaReview({
      subjectId: 'task-critical-primary-unavailable',
      taskTitle: 'Meta reviewer hardening',
      changedFiles: ['apps/worker/src/metaReviewer/strategicReview.ts'],
      gitDiff: 'diff --git a/apps/worker/src/metaReviewer/strategicReview.ts b/apps/worker/src/metaReviewer/strategicReview.ts',
      workingDir: repoRoot,
    })

    expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
    expect(mockCreateAiCliAdapter).not.toHaveBeenCalled()
  })

  describe('applyIndependentReviewOverride', () => {
    it('keeps the base decision when the independent reviewer approves', () => {
      expect(applyIndependentReviewOverride('ALIGNED', {
        provider: 'codex',
        verdict: 'approved',
        summary: 'ok',
        unavailable: false,
      })).toBe('ALIGNED')
    })

    it('forces CONFLICT when the independent reviewer blocks', () => {
      expect(applyIndependentReviewOverride('ALIGNED', {
        provider: 'codex',
        verdict: 'blocking',
        summary: 'blocked',
        unavailable: false,
      })).toBe('CONFLICT')
    })

    it('downgrades ALIGNED to UNCERTAIN when the independent reviewer requests changes', () => {
      expect(applyIndependentReviewOverride('ALIGNED', {
        provider: 'codex',
        verdict: 'changes_requested',
        summary: 'needs changes',
        unavailable: false,
      })).toBe('UNCERTAIN')
    })

    it('does not downgrade an existing CONFLICT further on changes_requested', () => {
      expect(applyIndependentReviewOverride('CONFLICT', {
        provider: 'codex',
        verdict: 'changes_requested',
        summary: 'needs changes',
        unavailable: false,
      })).toBe('CONFLICT')
    })

    it('fails closed to REVIEW_UNAVAILABLE when the independent reviewer is unavailable regardless of base decision', () => {
      expect(applyIndependentReviewOverride('ALIGNED', {
        provider: 'codex',
        verdict: 'blocking',
        summary: 'unavailable',
        unavailable: true,
      })).toBe('REVIEW_UNAVAILABLE')
    })
  })

  describe('runIndependentReview', () => {
    it('reports unavailable:true when the Codex CLI exits non-zero', async () => {
      mockCodexReviewerFailure()

      const outcome = await runIndependentReview({
        subjectId: 'task-x',
        taskTitle: 'title',
        changedFiles: ['apps/worker/src/example.ts'],
        gitDiff: 'diff',
        workingDir: repoRoot,
      })

      expect(outcome.unavailable).toBe(true)
    })

    it('reports unavailable:false with the parsed verdict on success', async () => {
      mockCodexReviewerRun('changes_requested', 'please address X')

      const outcome = await runIndependentReview({
        subjectId: 'task-x',
        taskTitle: 'title',
        changedFiles: ['apps/worker/src/example.ts'],
        gitDiff: 'diff',
        workingDir: repoRoot,
      })

      expect(outcome.unavailable).toBe(false)
      expect(outcome.verdict).toBe('changes_requested')
      expect(outcome.summary).toBe('please address X')
    })
  })

  it('requires CEO approval for CRITICAL CONFLICT', async () => {
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('CONFLICT', 'critical conflict'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'architecture aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'integration aligned'), providerUsed: 'gemini' })

    const result = await runStrategicMetaReview({
      subjectId: 'task-critical-conflict',
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
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('CONFLICT', 'goal conflict'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'data aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'integration aligned'), providerUsed: 'gemini' })

    const result = await runStrategicMetaReview(highStorageInput())

    expect(result.reviewLoad).toBe('high')
    expect(result.strategicAlignmentResult?.decision).toBe('CONFLICT')
    expect(result.finalDecision).toBe('CONFLICT')
    expect(result.independentReviewRequired).toBe(false)
    expect(result.requiresCeoApproval).toBe(false)
  })

  it('returns CONFLICT when Integration Review returns CONFLICT even if Focused Reviews are ALIGNED', async () => {
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'strategic aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'data aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('CONFLICT', 'combined result conflicts'), providerUsed: 'gemini' })

    const result = await runStrategicMetaReview(highStorageInput())

    expect(result.focusedReviewResults.every((focused) => focused.decision === 'ALIGNED')).toBe(true)
    expect(result.integrationReviewResult?.decision).toBe('CONFLICT')
    expect(result.finalDecision).toBe('CONFLICT')
  })

  it('returns UNCERTAIN when there is UNCERTAIN and no CONFLICT', async () => {
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('UNCERTAIN', 'strategic assumption unresolved'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'data aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'integration aligned'), providerUsed: 'gemini' })

    const result = await runStrategicMetaReview(highStorageInput())

    expect(result.finalDecision).toBe('UNCERTAIN')
    expect(result.independentReviewRequired).toBe(false)
    expect(result.requiresCeoApproval).toBe(true)
  })

  it('labels pre-implementation design material as text instead of diff', async () => {
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'strategic aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'data aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'integration aligned'), providerUsed: 'gemini' })

    await runStrategicMetaReview({
      ...highStorageInput(),
      gitDiff: 'Design: reuse the current Meta Reviewer router and split calls by focus.',
      materialKind: 'design',
    })

    const prompt = mockReviewWithProviderFallback.mock.calls[0][0]
    expect(prompt).toContain('## Proposed Design (pre-implementation, not yet a diff)')
    expect(prompt).toContain('```text\nDesign: reuse the current Meta Reviewer router')
    expect(prompt).not.toContain('## Git Diff or Design Text\n\n```diff\nDesign:')
  })

  it('fails closed without calling Gemini when non-strategic checklist context is missing', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'strategic-review-empty-'))

    try {
      const result = await runStrategicMetaReview({
        subjectId: 'task-missing-checklist',
        taskTitle: 'Mobile UI adjustment',
        changedFiles: ['apps/mobile/app/index.tsx'],
        gitDiff: 'diff --git a/apps/mobile/app/index.tsx b/apps/mobile/app/index.tsx',
        workingDir: tempRoot,
      })

      expect(result.reviewLoad).toBe('medium')
      expect(result.selectedFocuses).toEqual(['product_ceo_experience'])
      expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
      expect(result.requiresCeoApproval).toBe(true)
      expect(mockReviewWithProviderFallback).not.toHaveBeenCalled()
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('never returns ALIGNED when Gemini throws during a required Focused Review', async () => {
    mockReviewWithProviderFallback.mockRejectedValueOnce(new Error('timeout'))

    const result = await runStrategicMetaReview({
      subjectId: 'task-medium',
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

  it('parses Copilot-provided raw output through the existing focused review parser', async () => {
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'copilot strategic review'), providerUsed: 'copilot' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'copilot data review'), providerUsed: 'copilot' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'copilot integration review'), providerUsed: 'copilot' })

    const result = await runStrategicMetaReview(highStorageInput())

    expect(result.reviewLoad).toBe('high')
    expect(result.focusedReviewResults.length).toBe(2)
    expect(result.focusedReviewResults.every((f) => f.decision === 'ALIGNED')).toBe(true)
    expect(result.integrationReviewResult?.decision).toBe('ALIGNED')
    expect(result.finalDecision).toBe('ALIGNED')
  })

  it('fails closed on non-quota errors without falling back to Copilot', async () => {
    mockReviewWithProviderFallback.mockRejectedValueOnce(
      new Error('[geminiRouter] Gemini failed, non-quota (feature: strategic-meta-review-scope_simplicity)'),
    )

    const result = await runStrategicMetaReview({
      subjectId: 'task-medium-nonquota',
      taskTitle: 'Mobile UI adjustment',
      changedFiles: ['apps/mobile/app/index.tsx'],
      gitDiff: 'diff --git a/apps/mobile/app/index.tsx b/apps/mobile/app/index.tsx',
      workingDir: repoRoot,
    })

    expect(result.reviewLoad).toBe('medium')
    expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
    expect(result.requiresCeoApproval).toBe(true)
  })
})

describe('runStrategicMetaReview with reviewKind=roadmap', () => {
  it('uses the fixed roadmap focuses and treats the whole roadmap as the review subject', async () => {
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'strategic aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'scope aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'architecture aligned'), providerUsed: 'gemini' })
    mockCodexReviewerRun('approved', 'independent roadmap review approved')

    const result = await runStrategicMetaReview({
      reviewKind: 'roadmap',
      subjectId: 'project-roadmap-1',
      taskTitle: 'Whole-Roadmap Review',
      changedFiles: [],
      gitDiff: '# Roadmap Design Review Material detailing the planned roadmap',
      workingDir: repoRoot,
    })

    expect(result.reviewKind).toBe('roadmap')
    expect(result.subjectId).toBe('project-roadmap-1')
    expect(result.reviewLoad).toBe('critical')
    expect(result.selectedFocuses).toEqual([
      'strategic_alignment',
      'scope_simplicity',
      'architecture_responsibility',
    ])
    expect(result.independentReviewResult?.verdict).toBe('approved')
    expect(result.finalDecision).toBe('ALIGNED')
  })
})

function highStorageInput(): Parameters<typeof runStrategicMetaReview>[0] {
  return {
    subjectId: 'task-high',
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
