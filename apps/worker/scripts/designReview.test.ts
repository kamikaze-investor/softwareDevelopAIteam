import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StrategicMetaReviewResult } from '@ai-team/shared'

const mockRunStrategicMetaReview = vi.fn()
vi.mock('../src/metaReviewer/strategicReview.js', () => ({
  runStrategicMetaReview: (...args: unknown[]) => mockRunStrategicMetaReview(...args),
}))

const {
  buildStrategicReviewInputFromDesign,
  checkPreImplementationDesignReview,
  exitCodeForStrategicResult,
  persistDesignReviewEvidence,
  resolveDesignReviewInput,
} = await import('./designReview')

beforeEach(() => {
  mockRunStrategicMetaReview.mockReset()
  delete process.env.API_BASE_URL
  delete process.env.API_TOKEN
})

describe('designReview CLI helpers', () => {
  it('builds Strategic Review input from implementation-plan JSON without git diff', async () => {
    const designText = 'Design: reuse existing Meta Reviewer router and split high-load review by focus.'
    const input = await resolveDesignReviewInput(
      [],
      {},
      JSON.stringify({
        taskId: 'task-design',
        taskTitle: 'Design review before implementation',
        changedFiles: [
          'apps/worker/src/metaReviewer/strategicReview.ts',
          'apps/worker/src/approvalLevel/focusSelector.ts',
        ],
        designText,
        workingDir: 'C:/repo',
      }),
    )

    const strategicInput = buildStrategicReviewInputFromDesign(input)

    expect(strategicInput.subjectId).toBe('task-design')
    expect(strategicInput.taskTitle).toBe('Design review before implementation')
    expect(strategicInput.changedFiles).toEqual([
      'apps/worker/src/metaReviewer/strategicReview.ts',
      'apps/worker/src/approvalLevel/focusSelector.ts',
    ])
    expect(strategicInput.gitDiff).toBe(designText)
    expect(strategicInput.workingDir).toBe('C:/repo')
    expect(strategicInput.materialKind).toBe('design')
  })

  it('maps Strategic Review final decisions to documented CLI exit codes', () => {
    expect(exitCodeForStrategicResult(resultWithDecision('ALIGNED'))).toBe(0)
    expect(exitCodeForStrategicResult(resultWithDecision('CONFLICT'))).toBe(1)
    expect(exitCodeForStrategicResult(resultWithDecision('UNCERTAIN'))).toBe(2)
    expect(exitCodeForStrategicResult(resultWithDecision('REVIEW_UNAVAILABLE'))).toBe(3)
  })
})

describe('persistDesignReviewEvidence', () => {
  it('posts exact reviewed design text and review result to the API evidence endpoint', async () => {
    process.env.API_TOKEN = 'test-token'
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 201 })
    const input = {
      taskId: 'task-design',
      taskTitle: 'Design review before implementation',
      changedFiles: ['apps/api/src/routes/jobs.ts'],
      designText: 'Design: gate implement Job creation on stored evidence.',
      workingDir: 'C:/repo',
    }

    const persisted = await persistDesignReviewEvidence(input, {
      ...resultWithDecision('ALIGNED'),
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewResult: {
        provider: 'codex',
        verdict: 'approved',
        summary: 'Independent approval',
        unavailable: false,
      },
    }, {
      apiBaseUrl: 'http://api.test',
      fetchImpl,
    })

    expect(persisted).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith('http://api.test/api/design-review-evidence', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        taskId: input.taskId,
        designText: input.designText,
        reviewLoad: 'critical',
        decision: 'ALIGNED',
        independentReviewRequired: true,
        independentReviewVerdict: 'approved',
      }),
    })
  })

  it('returns false without throwing when evidence persistence fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      const persisted = await persistDesignReviewEvidence({
        taskId: 'task-design',
        taskTitle: 'Design review before implementation',
        changedFiles: [],
        designText: 'Design: still use decision exit code.',
        workingDir: 'C:/repo',
      }, resultWithDecision('CONFLICT'), {
        apiBaseUrl: 'http://api.test/',
        fetchImpl,
      })

      expect(persisted).toBe(false)
      expect(fetchImpl).toHaveBeenCalledWith(
        'http://api.test/api/design-review-evidence',
        expect.any(Object),
      )
      expect(stderr).toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
  })
})

describe('checkPreImplementationDesignReview', () => {
  it('allows proceeding only when the Strategic Review decision is ALIGNED', async () => {
    mockRunStrategicMetaReview.mockResolvedValueOnce(resultWithDecision('ALIGNED'))

    const outcome = await checkPreImplementationDesignReview({
      taskId: 'task-design',
      taskTitle: 'Design review before implementation',
      changedFiles: ['apps/worker/src/example.ts'],
      designText: 'Design: reuse existing router.',
      workingDir: 'C:/repo',
    })

    expect(outcome.allowed).toBe(true)
    expect(outcome.result.finalDecision).toBe('ALIGNED')
  })

  it.each(['CONFLICT', 'UNCERTAIN', 'REVIEW_UNAVAILABLE'] as const)(
    'fails closed (allowed:false) when the Strategic Review decision is %s',
    async (decision) => {
      mockRunStrategicMetaReview.mockResolvedValueOnce(resultWithDecision(decision))

      const outcome = await checkPreImplementationDesignReview({
        taskId: 'task-design',
        taskTitle: 'Design review before implementation',
        changedFiles: ['apps/worker/src/example.ts'],
        designText: 'Design: bypass production DB safety during rollback.',
        workingDir: 'C:/repo',
      })

      expect(outcome.allowed).toBe(false)
    },
  )

  it('passes materialKind:design through to the Strategic Review so it is not mistaken for a diff', async () => {
    mockRunStrategicMetaReview.mockResolvedValueOnce(resultWithDecision('ALIGNED'))

    await checkPreImplementationDesignReview({
      taskId: 'task-design',
      taskTitle: 'Design review before implementation',
      changedFiles: ['apps/worker/src/example.ts'],
      designText: 'Design text',
      workingDir: 'C:/repo',
    })

    expect(mockRunStrategicMetaReview).toHaveBeenCalledWith(
      expect.objectContaining({ materialKind: 'design', gitDiff: 'Design text' }),
    )
  })
})

function resultWithDecision(
  finalDecision: StrategicMetaReviewResult['finalDecision'],
): StrategicMetaReviewResult {
  return {
    reviewKind: 'task',
    subjectId: 'task-design',
    taskId: 'task-design',
    reviewLoad: 'medium',
    reviewLoadReasons: [],
    selectedFocuses: [],
    focusedReviewResults: [],
    finalDecision,
    independentReviewRequired: false,
    requiresCeoApproval: finalDecision === 'UNCERTAIN' || finalDecision === 'REVIEW_UNAVAILABLE',
    createdAt: '2026-08-13T00:00:00.000Z',
  }
}
