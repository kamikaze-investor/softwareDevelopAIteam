import { describe, expect, it } from 'vitest'
import {
  classifyReviewLoad,
  ROADMAP_REVIEW_LOAD_CLASSIFICATION,
  type ReviewLoadClassifierInput,
} from './reviewLoadClassifier.js'

describe('classifyReviewLoad', () => {
  it('defaults empty changedFiles to MEDIUM', () => {
    expect(classifyReviewLoad({ changedFiles: [] })).toEqual({
      reviewLoad: 'medium',
      reasons: ['changedFiles is empty; defaulted to medium'],
    })
  })

  it('classifies all-test-only changes as LOW regardless of diff size', () => {
    const result = classifyReviewLoad({
      changedFiles: [
        'apps/worker/src/approvalLevel/focusSelector.test.ts',
        'packages/shared/src/approvalLevelClassifier.test.ts',
      ],
    })

    expect(result.reviewLoad).toBe('low')
  })

  it('classifies specs/00_constitution.md as CRITICAL even for a small file list', () => {
    const result = classifyReviewLoad({
      changedFiles: ['specs/00_constitution.md'],
    })

    expect(result.reviewLoad).toBe('critical')
    expect(result.reasons.some((reason) => reason.includes('specs/00_constitution.md'))).toBe(true)
  })

  it('classifies storage changes as HIGH when no CRITICAL rule matches', () => {
    const result = classifyReviewLoad({
      changedFiles: ['apps/api/src/storage/schema.ts'],
    })

    expect(result.reviewLoad).toBe('high')
    expect(result.reasons.some((reason) => reason.includes('DB/schema'))).toBe(true)
  })

  it('does not accept or consult a Risk Level input', () => {
    expect(classifyReviewLoad.length).toBe(1)

    const result = classifyReviewLoad({
      changedFiles: ['apps/worker/src/example.test.ts'],
      riskLevel: 'critical',
    } as unknown as ReviewLoadClassifierInput)

    expect(result.reviewLoad).toBe('low')
  })
})

describe('ROADMAP_REVIEW_LOAD_CLASSIFICATION', () => {
  it('always classifies whole-roadmap reviews as critical', () => {
    expect(ROADMAP_REVIEW_LOAD_CLASSIFICATION).toEqual({
      reviewLoad: 'critical',
      reasons: ["reviewKind='roadmap': whole-roadmap review is always critical load by design"],
    })
  })
})
