import { describe, expect, it } from 'vitest'
import type { MetaReviewFocus } from '@ai-team/shared'
import { selectFocuses, selectRoadmapReviewFocuses } from './focusSelector.js'

const VALID_FOCUSES: readonly MetaReviewFocus[] = [
  'strategic_alignment',
  'safety_recovery',
  'architecture_responsibility',
  'data_state_integrity',
  'auth_permission',
  'operations',
  'product_ceo_experience',
  'scope_simplicity',
]

describe('selectFocuses', () => {
  it('returns no Focused Review focus for LOW review load', () => {
    expect(selectFocuses('low', ['apps/worker/src/example.test.ts'])).toEqual([])
  })

  it('includes strategic_alignment for HIGH review load', () => {
    const focuses = selectFocuses('high', ['apps/api/src/storage/schema.ts'])

    expect(focuses).toContain('strategic_alignment')
    expect(focuses).toContain('data_state_integrity')
  })

  it('prioritizes design signals as strategic_alignment for MEDIUM review load', () => {
    expect(selectFocuses('medium', ['docs/project_memory/decisions/008_review_load.md'])).toEqual([
      'strategic_alignment',
    ])
  })

  it('uses the existing checklist responsibility mapping without inventing new Focus values', () => {
    const focuses = selectFocuses('critical', [
      'apps/worker/src/guards/fileChangeGuard.ts',
      'sandbox/Dockerfile',
      'apps/api/src/routes/tasks.ts',
      'apps/api/src/storage/schema.ts',
      'packages/shared/src/types/meta_review.ts',
      '.github/workflows/meta-review.yml',
      'apps/mobile/app/index.tsx',
      'README.md',
    ])

    expect(focuses).toContain('strategic_alignment')
    expect(focuses).toContain('safety_recovery')
    expect(focuses).toContain('auth_permission')
    expect(focuses).toContain('architecture_responsibility')
    expect(focuses).toContain('data_state_integrity')
    expect(focuses).toContain('operations')
    expect(focuses).toContain('product_ceo_experience')
    expect(focuses).toContain('scope_simplicity')
    expect(focuses.every((focus) => VALID_FOCUSES.includes(focus))).toBe(true)
  })
})

describe('selectRoadmapReviewFocuses', () => {
  it('returns exactly the fixed roadmap focus set', () => {
    expect(selectRoadmapReviewFocuses()).toEqual([
      'strategic_alignment',
      'scope_simplicity',
      'architecture_responsibility',
    ])
  })

  it('never delegates to the changedFiles-driven selectFocuses paths', () => {
    const focuses = selectRoadmapReviewFocuses()
    expect(focuses).not.toContain('safety_recovery')
    expect(focuses).not.toContain('data_state_integrity')
    expect(focuses.every((focus) => VALID_FOCUSES.includes(focus))).toBe(true)
  })
})
