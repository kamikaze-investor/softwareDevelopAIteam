import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { AGY_REVIEW_MODEL } from './geminiRouter.js'
import { reviewWithProviderFallback } from './metaReviewFallbackRouter.js'
import {
  buildMetaReviewPrompt,
  parseMetaReviewResult,
} from './runner.js'
import {
  applyIndependentReviewOverride,
  parseFocusedReviewResponse,
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
  // Mirrors real codex exec output: narration/reasoning text on stdout ahead of the final
  // answer, with the clean answer captured separately via --output-last-message as
  // AiCliResult.parsedOutput (apps/worker/src/aiCli/adapter.ts). A prior bug had
  // CodexReviewerAdapter re-parse the noisy stdout instead of using parsedOutput -- this shape
  // (unparseable stdout, valid parsedOutput) proves both task-kind and roadmap-kind independent
  // reviews (both share CodexReviewerAdapter) go through the fixed, parsedOutput-preferring path.
  const parsedOutput = { verdict, summary, issues: [], confidence: 0.9 }
  const stdout = [
    'codex exec started',
    'Inspecting the requested review material and forming a verdict.',
    JSON.stringify(parsedOutput),
  ].join('\n')
  mockCreateAiCliAdapter.mockReturnValue({
    run: vi.fn().mockResolvedValue({ blocked: false, exitCode: 0, stdout, stderr: '', parsedOutput }),
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
    const emptyControlRoot = await mkdtemp(join(tmpdir(), 'strategic-review-empty-control-'))

    try {
      // workingDir（target）も controlContextDir（control）も空。checklistはcontrol rootから
      // 読むため、control rootにchecklistが無ければ fail-closed になる。
      const result = await runStrategicMetaReview({
        subjectId: 'task-missing-checklist',
        taskTitle: 'Mobile UI adjustment',
        changedFiles: ['apps/mobile/app/index.tsx'],
        gitDiff: 'diff --git a/apps/mobile/app/index.tsx b/apps/mobile/app/index.tsx',
        workingDir: tempRoot,
        controlContextDir: emptyControlRoot,
      })

      expect(result.reviewLoad).toBe('medium')
      expect(result.selectedFocuses).toEqual(['product_ceo_experience'])
      expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
      expect(result.requiresCeoApproval).toBe(true)
      expect(mockReviewWithProviderFallback).not.toHaveBeenCalled()
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
      await rm(emptyControlRoot, { recursive: true, force: true })
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

  it('accepts engineering principle categories in focused review findings', () => {
    const outcome = parseFocusedReviewResponse(JSON.stringify({
      decision: 'CONFLICT',
      summary: 'Constraint issue',
      findings: [{
        severity: 'medium',
        category: 'over_constraint',
        message: 'The design adds a gate without a specific prevented failure.',
      }],
    }), 'scope_simplicity')

    expect(outcome.unavailable).toBe(false)
    expect(outcome.result.findings[0].category).toBe('over_constraint')
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

  // 2026-09-04 の production 障害: focused / integration review が effort 込みの旧識別子
  // `gemini-3.5-flash-medium` を渡しており、現行 agy がこれを拒否するため3 focus すべてが
  // UNCERTAIN → REVIEW_UNAVAILABLE で fail-closed していた。Whole-Roadmap Review の
  // agy 呼び出しすべてが model と effort を対で渡すことを固定する。
  it('passes a paired agy model+effort on every focused and integration review call', async () => {
    mockReviewWithProviderFallback
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'strategic aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'scope aligned'), providerUsed: 'gemini' })
      .mockResolvedValueOnce({ raw: jsonDecision('ALIGNED', 'architecture aligned'), providerUsed: 'gemini' })
    mockCodexReviewerRun('approved', 'independent roadmap review approved')

    await runStrategicMetaReview({
      reviewKind: 'roadmap',
      subjectId: 'project-roadmap-model-pairing',
      taskTitle: 'Whole-Roadmap Review',
      changedFiles: [],
      gitDiff: '# Roadmap Design Review Material detailing the planned roadmap',
      workingDir: repoRoot,
    })

    // focused review ×3 + integration review
    expect(mockReviewWithProviderFallback.mock.calls.length).toBeGreaterThanOrEqual(4)
    for (const [, options] of mockReviewWithProviderFallback.mock.calls) {
      const opts = options as { cliModel?: string; cliEffort?: string; apiModel?: string }
      expect(opts.cliModel).toBe(AGY_REVIEW_MODEL.cliModel)
      expect(opts.cliEffort).toBe(AGY_REVIEW_MODEL.cliEffort)
      // apiModel は Gemini REST API の名前空間。agy 命名（effort 込み）へ寄せていないこと。
      expect(opts.apiModel).not.toMatch(/-(low|medium|high)$/)
    }
  })
})

describe('two-root control context resolution (control-plane vs target-project)', () => {
  it('positive: roadmap review succeeds with target docs in target root and control docs in control root', async () => {
    const { targetRoot, controlRoot } = await createTwoRootSetup({
      targetHasProjectMemory: true,
      controlHasConstitution: true,
      controlHasChecklists: true,
    })

    try {
      const result = await runStrategicMetaReview({
        reviewKind: 'roadmap',
        subjectId: 'project-two-root-1',
        taskTitle: 'Whole-Roadmap Review',
        changedFiles: [],
        gitDiff: '# Roadmap Design Review Material detailing the planned roadmap',
        workingDir: targetRoot,
        controlContextDir: controlRoot,
      })

      // target root carries only target Project Memory; control root carries only control policy.
      // No selected focus may come back as a missing-context review.
      expect(result.selectedFocuses).toEqual([
        'strategic_alignment',
        'scope_simplicity',
        'architecture_responsibility',
      ])
      expect(result.focusedReviewResults.every((f) => f.decision !== 'UNCERTAIN')).toBe(true)
      expect(result.finalDecision).toBe('ALIGNED')
    } finally {
      await rm(targetRoot, { recursive: true, force: true })
      await rm(controlRoot, { recursive: true, force: true })
    }
  })

  it('negative: fails closed when the control root lacks the Constitution', async () => {
    const { targetRoot, controlRoot } = await createTwoRootSetup({
      targetHasProjectMemory: true,
      controlHasConstitution: false,
      controlHasChecklists: true,
    })

    try {
      const result = await runStrategicMetaReview({
        reviewKind: 'roadmap',
        subjectId: 'project-two-root-constitution-missing',
        taskTitle: 'Whole-Roadmap Review',
        changedFiles: [],
        gitDiff: '# Roadmap Design Review Material detailing the planned roadmap',
        workingDir: targetRoot,
        controlContextDir: controlRoot,
      })

      expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
      expect(result.requiresCeoApproval).toBe(true)
      const strategic = result.focusedReviewResults.find((f) => f.focus === 'strategic_alignment')
      expect(strategic?.decision).toBe('UNCERTAIN')
      expect(strategic?.summary).toContain('Required strategic context is missing')
      expect(strategic?.summary).toContain('specs/00_constitution.md')
    } finally {
      await rm(targetRoot, { recursive: true, force: true })
      await rm(controlRoot, { recursive: true, force: true })
    }
  })

  it('negative: fails closed when the control root lacks all checklist candidates', async () => {
    const { targetRoot, controlRoot } = await createTwoRootSetup({
      targetHasProjectMemory: true,
      controlHasConstitution: true,
      controlHasChecklists: false,
    })

    try {
      const result = await runStrategicMetaReview({
        subjectId: 'task-two-root-checklist-missing',
        taskTitle: 'Mobile UI adjustment',
        changedFiles: ['apps/mobile/app/index.tsx'],
        gitDiff: 'diff --git a/apps/mobile/app/index.tsx b/apps/mobile/app/index.tsx',
        workingDir: targetRoot,
        controlContextDir: controlRoot,
      })

      expect(result.reviewLoad).toBe('medium')
      expect(result.selectedFocuses).toEqual(['product_ceo_experience'])
      expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
      const focusResult = result.focusedReviewResults.find((f) => f.focus === 'product_ceo_experience')
      expect(focusResult?.summary).toContain('Checklist context is missing')
      expect(mockReviewWithProviderFallback).not.toHaveBeenCalled()
    } finally {
      await rm(targetRoot, { recursive: true, force: true })
      await rm(controlRoot, { recursive: true, force: true })
    }
  })

  it('negative: output fails closed on missing target Project Memory even when the control root has its own docs', async () => {
    const { targetRoot, controlRoot } = await createTwoRootSetup({
      targetHasProjectMemory: false,
      controlHasConstitution: true,
      controlHasChecklists: true,
    })

    try {
      const result = await runStrategicMetaReview({
        subjectId: 'task-two-root-target-memory-missing',
        taskTitle: 'Storage state hardening',
        changedFiles: ['apps/api/src/storage/schema.ts'],
        gitDiff: 'diff --git a/apps/api/src/storage/schema.ts b/apps/api/src/storage/schema.ts',
        workingDir: targetRoot,
        controlContextDir: controlRoot,
      })

      expect(result.reviewLoad).toBe('high')
      expect(result.finalDecision).toBe('REVIEW_UNAVAILABLE')
      const strategic = result.focusedReviewResults.find((f) => f.focus === 'strategic_alignment')
      expect(strategic?.decision).toBe('UNCERTAIN')
      expect(strategic?.summary).toContain('Required strategic context is missing')
      // The missing docs must be the target-owned ones, not the control root's own constitution.
      expect(strategic?.summary).toContain('docs/project_memory/goal.md')
      expect(strategic?.summary).toContain('docs/project_memory/design_philosophy.md')
    } finally {
      await rm(targetRoot, { recursive: true, force: true })
      await rm(controlRoot, { recursive: true, force: true })
    }
  })

  it('reset-survival: review still succeeds after the target repo is reset/cleaned of all control files', async () => {
    // Simulate the production symptom: a fresh target repo that has target Project Memory but
    // was never seeded with / got cleaned of any specs/ or docs/meta_reviewer/ directory.
    const { targetRoot, controlRoot } = await createTwoRootSetup({
      targetHasProjectMemory: true,
      controlHasConstitution: true,
      controlHasChecklists: true,
    })

    try {
      // Belt-and-braces: ensure the target root genuinely has no control-plane material.
      const targetSpecs = join(targetRoot, 'specs')
      const targetChecklists = join(targetRoot, 'docs', 'meta_reviewer')
      await rm(targetSpecs, { recursive: true, force: true })
      await rm(targetChecklists, { recursive: true, force: true })

      const result = await runStrategicMetaReview({
        reviewKind: 'roadmap',
        subjectId: 'project-reset-survival',
        taskTitle: 'Whole-Roadmap Review',
        changedFiles: [],
        gitDiff: '# Roadmap Design Review Material detailing the planned roadmap',
        workingDir: targetRoot,
        controlContextDir: controlRoot,
      })

      expect(result.finalDecision).toBe('ALIGNED')
      expect(result.focusedReviewResults.every((f) => f.decision !== 'UNCERTAIN')).toBe(true)
    } finally {
      await rm(targetRoot, { recursive: true, force: true })
      await rm(controlRoot, { recursive: true, force: true })
    }
  })
})

async function createTwoRootSetup(options: {
  targetHasProjectMemory: boolean
  controlHasConstitution: boolean
  controlHasChecklists: boolean
}): Promise<{ targetRoot: string; controlRoot: string }> {
  const targetRoot = await mkdtemp(join(tmpdir(), 'two-root-target-'))
  const controlRoot = await mkdtemp(join(tmpdir(), 'two-root-control-'))

  if (options.targetHasProjectMemory) {
    await writeDeep(targetRoot, 'docs/project_memory/goal.md', '# Goal\n\nDeliver a working AI team OS MVP.')
    await writeDeep(targetRoot, 'docs/project_memory/design_philosophy.md', '# Design Philosophy\n\nKeep it simple and safe.')
  }

  if (options.controlHasConstitution) {
    await writeDeep(controlRoot, 'specs/00_constitution.md', '# Constitution\n\n## 3.14 AI Team OS\n\nSafety rules.')
  }

  if (options.controlHasChecklists) {
    await writeDeep(controlRoot, 'docs/meta_reviewer/checklist.md', '# General Meta Reviewer checklist\n\nCheck safety.')
    await writeDeep(controlRoot, 'docs/meta_reviewer/checklists/worker.md', '# Worker checklist\n\nCheck worker ownership.')
    await writeDeep(controlRoot, 'docs/meta_reviewer/checklists/api_routes.md', '# API routes checklist\n\nCheck routes.')
    await writeDeep(controlRoot, 'docs/meta_reviewer/checklists/shared_types.md', '# Shared types checklist\n\nCheck types.')
    await writeDeep(controlRoot, 'docs/meta_reviewer/checklists/storage.md', '# Storage checklist\n\nCheck storage.')
  }

  return { targetRoot, controlRoot }
}

async function writeDeep(root: string, relPath: string, content: string): Promise<void> {
  const fullPath = join(root, relPath)
  await mkdir(join(root, relPath.split(/[\\/]/).slice(0, -1).join('/')), { recursive: true })
  await writeFile(fullPath, content, 'utf-8')
}

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
