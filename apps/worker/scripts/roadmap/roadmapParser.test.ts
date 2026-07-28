import { describe, expect, it } from 'vitest'
import {
  parseRoadmapMarkdown,
  updateRoadmapState,
  type RoadmapIssueCode,
} from './roadmapParser.js'

const ROADMAP_FIXTURE = [
  '# Roadmap',
  '',
  '<!-- roadmap:id=mobile-approval-role-docs state=deferred -->',
  '1. [ ] 2種類の承認の役割整理とMobile導線設計 — details',
  '   description',
  '<!-- roadmap:id=mobile-task-job-detail-ui state=done -->',
  '2. [x] Task/Job一覧・詳細画面（Mobile） — details',
  '<!-- roadmap:id=mobile-task-create state=planned -->',
  '3. [ ] 開発指示（Task作成）画面（Mobile） — details',
  '',
].join('\n')

describe('roadmapParser updateRoadmapState', () => {
  it('updates the requested metadata state', () => {
    const result = updateRoadmapState(ROADMAP_FIXTURE, 'mobile-task-create', 'in_progress')

    expect(result.markdown).toContain('<!-- roadmap:id=mobile-task-create state=in_progress -->')
    expect(result.changed).toBe(true)
  })

  it('syncs checkboxes when state moves between done and non-done states', () => {
    const doneResult = updateRoadmapState(ROADMAP_FIXTURE, 'mobile-task-create', 'done')

    expect(doneResult.markdown).toContain('3. [x] 開発指示（Task作成）画面（Mobile）')

    const plannedResult = updateRoadmapState(doneResult.markdown, 'mobile-task-create', 'planned')

    expect(plannedResult.markdown).toContain('3. [ ] 開発指示（Task作成）画面（Mobile）')
  })

  it('is idempotent when the requested state is already applied', () => {
    const firstResult = updateRoadmapState(ROADMAP_FIXTURE, 'mobile-task-create', 'planned')
    const secondResult = updateRoadmapState(firstResult.markdown, 'mobile-task-create', 'planned')

    expect(firstResult.markdown).toBe(ROADMAP_FIXTURE)
    expect(secondResult.markdown).toBe(firstResult.markdown)
    expect(secondResult.changed).toBe(false)
  })

  it('rejects a missing id without changing the input string', () => {
    expect(() => updateRoadmapState(ROADMAP_FIXTURE, 'missing-id', 'done')).toThrow(
      'Roadmap item "missing-id" was not found',
    )
    expect(ROADMAP_FIXTURE).toContain('state=planned')
  })

  it('rejects an invalid target state without changing the input string', () => {
    expect(() => updateRoadmapState(ROADMAP_FIXTURE, 'mobile-task-create', 'unknown')).toThrow(
      'Invalid roadmap state "unknown"',
    )
    expect(ROADMAP_FIXTURE).toContain('state=planned')
  })
})

describe('parseRoadmapMarkdown validation', () => {
  it('detects duplicate roadmap ids', () => {
    const duplicateRoadmap = [
      '<!-- roadmap:id=dup state=planned -->',
      '1. [ ] First — details',
      '<!-- roadmap:id=dup state=done -->',
      '2. [x] Second — details',
    ].join('\n')

    expect(issueCodes(duplicateRoadmap)).toContain('duplicate_id')
  })

  it('detects state and checkbox mismatches', () => {
    const mismatchedRoadmap = [
      '<!-- roadmap:id=mismatch state=done -->',
      '1. [ ] Mismatch — details',
    ].join('\n')

    expect(issueCodes(mismatchedRoadmap)).toContain('checkbox_state_mismatch')
  })

  it('detects metadata comments that are not followed by checkbox lines', () => {
    const invalidRoadmap = [
      '<!-- roadmap:id=bad state=planned -->',
      '',
      'not a checkbox',
    ].join('\n')

    expect(issueCodes(invalidRoadmap)).toContain('missing_checkbox')
  })
})

function issueCodes(markdown: string): RoadmapIssueCode[] {
  return parseRoadmapMarkdown(markdown).issues.map((issue) => issue.code)
}
