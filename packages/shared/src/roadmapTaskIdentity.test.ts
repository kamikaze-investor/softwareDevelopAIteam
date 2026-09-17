import { describe, expect, it } from 'vitest'
import {
  createFollowUpTaskKey,
  getBaseRoadmapId,
  getFollowUpSequence,
  isFollowUpTaskKey,
  MAX_FOLLOW_UPS_PER_ROADMAP_ITEM,
} from './roadmapTaskIdentity'

describe('getBaseRoadmapId — ledger を引くときは必ず base へ戻る', () => {
  it('通常 Task の key はそのまま base', () => {
    expect(getBaseRoadmapId('roadmap-adoption-followups')).toBe('roadmap-adoption-followups')
  })

  it('follow-up key からは suffix を外す', () => {
    expect(getBaseRoadmapId('roadmap-adoption-followups#2')).toBe('roadmap-adoption-followups')
    expect(getBaseRoadmapId('roadmap-adoption-followups#11')).toBe('roadmap-adoption-followups')
  })

  it('末尾が `#<数字>` でなければ suffix として扱わない', () => {
    expect(getBaseRoadmapId('item#draft')).toBe('item#draft')
    expect(getBaseRoadmapId('item#')).toBe('item#')
  })
})

describe('isFollowUpTaskKey / getFollowUpSequence', () => {
  it('通常 Task は follow-up ではなく sequence も持たない', () => {
    expect(isFollowUpTaskKey('item')).toBe(false)
    expect(getFollowUpSequence('item')).toBeUndefined()
  })

  it('follow-up は sequence を返す（初回 Task を 1 と数えるので 2 始まり）', () => {
    expect(isFollowUpTaskKey('item#2')).toBe(true)
    expect(getFollowUpSequence('item#2')).toBe(2)
    expect(getFollowUpSequence('item#10')).toBe(10)
  })
})

describe('createFollowUpTaskKey — sequence はサーバが決める', () => {
  it('最初の follow-up は #2', () => {
    const result = createFollowUpTaskKey('item', ['item'])

    expect(result).toMatchObject({ ok: true, roadmapTaskKey: 'item#2', sequence: 2, followUpCount: 0 })
  })

  it('#3 以降も連番で発番する', () => {
    expect(createFollowUpTaskKey('item', ['item', 'item#2'])).toMatchObject({ roadmapTaskKey: 'item#3' })
    expect(createFollowUpTaskKey('item', ['item', 'item#2', 'item#3'])).toMatchObject({ roadmapTaskKey: 'item#4' })
  })

  it('既存 sequence の最大値 + 1 を使う（欠番があっても衝突しない）', () => {
    // #3 が消えていても #4 を再利用しない。
    const result = createFollowUpTaskKey('item', ['item', 'item#2', 'item#4'])

    expect(result).toMatchObject({ ok: true, roadmapTaskKey: 'item#5' })
  })

  it('別 item の key は数えない', () => {
    const result = createFollowUpTaskKey('item', ['item', 'other#2', 'other#3'])

    expect(result).toMatchObject({ roadmapTaskKey: 'item#2', followUpCount: 0 })
  })

  it(`follow-up は ${MAX_FOLLOW_UPS_PER_ROADMAP_ITEM} 回まで許可する`, () => {
    const keys = ['item']
    for (let sequence = 2; sequence <= MAX_FOLLOW_UPS_PER_ROADMAP_ITEM + 1; sequence += 1) {
      const result = createFollowUpTaskKey('item', keys)
      expect(result.ok, `sequence ${sequence}`).toBe(true)
      if (!result.ok) return
      keys.push(result.roadmapTaskKey)
    }

    // 10 件作った時点で打ち止め。11 回目は作らず診断へ回す。
    expect(keys.filter((key) => isFollowUpTaskKey(key))).toHaveLength(MAX_FOLLOW_UPS_PER_ROADMAP_ITEM)
    const eleventh = createFollowUpTaskKey('item', keys)
    expect(eleventh.ok).toBe(false)
    if (eleventh.ok) return
    expect(eleventh.followUpCount).toBe(MAX_FOLLOW_UPS_PER_ROADMAP_ITEM)
    expect(eleventh.reason).toContain('maximum')
  })

  it('base が follow-up 形式なら曖昧なので作らない', () => {
    const result = createFollowUpTaskKey('item#2', ['item#2'])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('must not look like a follow-up task key')
  })
})
