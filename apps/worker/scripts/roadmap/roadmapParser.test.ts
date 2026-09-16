import { describe, expect, it } from 'vitest'
import {
  ADOPTABLE_ROADMAP_STATES,
  ALLOWED_ROADMAP_STATES,
  isRoadmapItemAdoptable,
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

describe('isRoadmapItemAdoptable — 自律採用してよい state の allowlist', () => {
  it('planned だけが採用対象', () => {
    expect(isRoadmapItemAdoptable('planned')).toBe(true)
  })

  it('in_progress / deferred / blocked / done は採用対象にしない', () => {
    // in_progress の除外は CEO 決定（2026-09-15 / PR #211）。着手済みのものを重ねて採用しない。
    expect(isRoadmapItemAdoptable('in_progress')).toBe(false)
    expect(isRoadmapItemAdoptable('deferred')).toBe(false)
    expect(isRoadmapItemAdoptable('blocked')).toBe(false)
    expect(isRoadmapItemAdoptable('done')).toBe(false)
  })

  it('未知の state は fail-closed で採用不可', () => {
    // allowlist なので、新しい state を足したときの既定は「採用不可」でなければならない。
    // ここが false でなくなったら、意味の決まっていない state を PL が拾える。
    expect(isRoadmapItemAdoptable('archived')).toBe(false)
    expect(isRoadmapItemAdoptable('')).toBe(false)
  })

  it('ALLOWED_ROADMAP_STATES の全件がどちらかに分類される（取りこぼしを作らない）', () => {
    const adoptable = ALLOWED_ROADMAP_STATES.filter((state) => isRoadmapItemAdoptable(state))
    expect(adoptable).toEqual([...ADOPTABLE_ROADMAP_STATES])
  })
})

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


describe('metadata tolerance — 追加属性を許す', () => {
  it('priority のような追加属性があっても項目として解釈する', () => {
    const markdown = [
      '<!-- roadmap:id=with-priority state=planned priority=high -->',
      '1. [ ] Has an extra attribute — details',
    ].join('\n')

    const { items, issues } = parseRoadmapMarkdown(markdown)

    expect(issues).toEqual([])
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('with-priority')
    expect(items[0].state).toBe('planned')
    expect(items[0].checkbox).toBe('unchecked')
  })

  it('追加属性が複数あっても解釈する', () => {
    const markdown = [
      '<!-- roadmap:id=multi state=done priority=high owner=pl -->',
      '1. [x] Two extra attributes — details',
    ].join('\n')

    expect(issueCodes(markdown)).toEqual([])
    expect(parseRoadmapMarkdown(markdown).items[0].id).toBe('multi')
  })

  it('壊れた metadata は従来どおり invalid_metadata として弾く', () => {
    const markdown = [
      '<!-- roadmap:id=broken -->',
      '1. [ ] Missing state — details',
    ].join('\n')

    expect(issueCodes(markdown)).toContain('invalid_metadata')
  })
})

describe('checkbox tolerance — [~] を未完了として受け付ける', () => {
  it('[~] を unchecked として解釈し、非 done state と矛盾しない', () => {
    const markdown = [
      '<!-- roadmap:id=in-progress-item state=in_progress -->',
      '1. [~] Work in progress — details',
    ].join('\n')

    const { items, issues } = parseRoadmapMarkdown(markdown)

    expect(issues).toEqual([])
    expect(items[0].checkbox).toBe('unchecked')
    expect(items[0].title).toBe('Work in progress')
  })

  it('[~] が done state と組み合わされたら従来どおり mismatch として報告する', () => {
    const markdown = [
      '<!-- roadmap:id=wrong state=done -->',
      '1. [~] Claims done but not checked — details',
    ].join('\n')

    expect(issueCodes(markdown)).toContain('checkbox_state_mismatch')
  })

  it('done へ更新すると [~] は [x] になる', () => {
    const markdown = [
      '<!-- roadmap:id=item state=in_progress -->',
      '1. [~] Work in progress — details',
    ].join('\n')

    const updated = updateRoadmapState(markdown, 'item', 'done').markdown

    expect(updated).toContain('1. [x] Work in progress — details')
    expect(updated).toContain('state=done')
  })

  it('非 done へ更新しても [~] を [ ] へ潰さない（著者が書いた進行中表記を失わない）', () => {
    const markdown = [
      '<!-- roadmap:id=item state=in_progress -->',
      '1. [~] Work in progress — details',
    ].join('\n')

    const updated = updateRoadmapState(markdown, 'item', 'blocked').markdown

    expect(updated).toContain('1. [~] Work in progress — details')
    expect(updated).toContain('state=blocked')
  })
})
function issueCodes(markdown: string): RoadmapIssueCode[] {
  return parseRoadmapMarkdown(markdown).issues.map((issue) => issue.code)
}
