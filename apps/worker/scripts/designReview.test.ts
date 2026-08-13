import { describe, expect, it } from 'vitest'
import {
  buildStrategicReviewInputFromDesign,
  exitCodeForStrategicResult,
  resolveDesignReviewInput,
} from './designReview'
import type { StrategicMetaReviewResult } from '@ai-team/shared'

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

    expect(strategicInput.taskId).toBe('task-design')
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

function resultWithDecision(
  finalDecision: StrategicMetaReviewResult['finalDecision'],
): StrategicMetaReviewResult {
  return {
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
