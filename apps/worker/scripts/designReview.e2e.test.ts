import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Production-equivalent E2E for the pre-implementation Design Review hook.
 *
 * Exercises the real production code path end-to-end:
 *   checkPreImplementationDesignReview()
 *     -> runStrategicMetaReview()
 *       -> classifyReviewLoad() / selectFocuses() (real, unmocked)
 *       -> buildFocusedReviewPrompt() / buildIntegrationReviewPrompt() (real, unmocked;
 *          reads the real docs/project_memory + specs files from this repo)
 *       -> callGeminiWithFallback() (mocked at the outer LLM boundary only)
 *       -> runIndependentReview() -> createReviewerAdapter('codex') (mocked at the
 *          outer CLI boundary only)
 *
 * Only the two outermost AI call boundaries are mocked. No new E2E framework —
 * this reuses the same vitest + vi.mock conventions as strategicReview.test.ts.
 */

vi.mock('../src/aiCli/factory.js', () => ({
  createAiCliAdapter: vi.fn(),
}))

const { callGeminiWithFallback } = await import('../src/metaReviewer/geminiRouter.js')
vi.mock('../src/metaReviewer/geminiRouter.js', () => ({
  callGeminiWithFallback: vi.fn(),
}))

const { createAiCliAdapter } = await import('../src/aiCli/factory.js')
const { checkPreImplementationDesignReview } = await import('./designReview')

const mockCallGeminiWithFallback = vi.mocked(callGeminiWithFallback)
const mockCreateAiCliAdapter = vi.mocked(createAiCliAdapter)
const repoRoot = resolve(__dirname, '../../..')

function geminiDecision(decision: 'ALIGNED' | 'CONFLICT' | 'UNCERTAIN', summary: string): string {
  return JSON.stringify({ decision, summary, findings: [] })
}

function codexVerdict(verdict: 'approved' | 'changes_requested' | 'blocking', summary: string) {
  return {
    blocked: false,
    exitCode: 0,
    stdout: JSON.stringify({ verdict, summary, issues: [], confidence: 0.9 }),
    stderr: '',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Design Review E2E (production code path, mocked LLM/CLI boundaries only)', () => {
  it('E2E A — ALIGNED design proceeds to the next step', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(geminiDecision('ALIGNED', 'consistent with existing storage design'))

    const outcome = await checkPreImplementationDesignReview({
      taskId: 'e2e-aligned',
      taskTitle: 'Add an index to speed up Task lookups',
      changedFiles: ['apps/api/src/storage/schema.ts'],
      designText: 'Add a secondary index on tasks.projectId. No change to write paths, backup, or DB_PATH resolution.',
      workingDir: repoRoot,
    })

    expect(outcome.allowed).toBe(true)
    expect(outcome.result.finalDecision).toBe('ALIGNED')
  })

  it('E2E B — CONFLICT: rollback-time DB safety bypass is rejected fail-closed', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(
      geminiDecision('CONFLICT', 'Bypassing production fail-closed DB_PATH checks during rollback violates Safety First'),
    )

    const outcome = await checkPreImplementationDesignReview({
      taskId: 'e2e-conflict',
      taskTitle: 'Simplify rollback procedure',
      changedFiles: ['apps/api/src/storage/index.ts'],
      designText: 'During rollback, unset NODE_ENV so the production fail-closed DB_PATH check no longer applies, to make recovery faster.',
      workingDir: repoRoot,
    })

    expect(outcome.allowed).toBe(false)
    expect(outcome.result.finalDecision).toBe('CONFLICT')
    expect(outcome.result.requiresCeoApproval).toBe(false)
  })

  it('E2E C — UNCERTAIN: unresolved Goal/Design Philosophy ambiguity requires human judgment', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(
      geminiDecision('UNCERTAIN', 'Cannot determine from Goal/Design Philosophy whether this direction is intended'),
    )

    const outcome = await checkPreImplementationDesignReview({
      taskId: 'e2e-uncertain',
      taskTitle: 'Change default risk-approval policy',
      changedFiles: ['apps/api/src/storage/index.ts'],
      designText: 'Ambiguous change to default approval policy with no clear precedent in existing decisions.',
      workingDir: repoRoot,
    })

    expect(outcome.allowed).toBe(false)
    expect(outcome.result.finalDecision).toBe('UNCERTAIN')
    expect(outcome.result.requiresCeoApproval).toBe(true)
  })

  it('E2E D — CRITICAL: Independent Review actually executes and feeds the final decision', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(geminiDecision('ALIGNED', 'aligned'))
    mockCreateAiCliAdapter.mockReturnValue({
      run: vi.fn().mockResolvedValue(codexVerdict('approved', 'independent codex review: no issues')),
    } as unknown as ReturnType<typeof createAiCliAdapter>)

    const outcome = await checkPreImplementationDesignReview({
      taskId: 'e2e-critical',
      taskTitle: 'Change Meta Reviewer review-load thresholds',
      changedFiles: ['apps/worker/src/metaReviewer/strategicReview.ts'],
      designText: 'Adjust which focuses run for HIGH review load.',
      workingDir: repoRoot,
    })

    expect(outcome.result.reviewLoad).toBe('critical')
    expect(mockCreateAiCliAdapter).toHaveBeenCalledTimes(1)
    expect(outcome.result.independentReviewResult).toBeDefined()
    expect(outcome.result.independentReviewResult?.unavailable).toBe(false)
    expect(outcome.allowed).toBe(true)
  })

  it('E2E E — reviewer unavailable fails closed (independent reviewer failure on CRITICAL)', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(geminiDecision('ALIGNED', 'aligned'))
    mockCreateAiCliAdapter.mockReturnValue({
      run: vi.fn().mockResolvedValue({ blocked: false, exitCode: 1, stdout: '', stderr: 'codex CLI unavailable' }),
    } as unknown as ReturnType<typeof createAiCliAdapter>)

    const outcome = await checkPreImplementationDesignReview({
      taskId: 'e2e-reviewer-unavailable',
      taskTitle: 'Change Meta Reviewer review-load thresholds',
      changedFiles: ['apps/worker/src/metaReviewer/strategicReview.ts'],
      designText: 'Adjust which focuses run for HIGH review load.',
      workingDir: repoRoot,
    })

    expect(outcome.allowed).toBe(false)
    expect(outcome.result.finalDecision).toBe('REVIEW_UNAVAILABLE')
    expect(outcome.result.requiresCeoApproval).toBe(true)
  })
})
