import { describe, expect, it } from 'vitest'
import { holdsWorkspaceWhenBlocked, isStaleBlockedJobCandidate, occupiesProject, OCCUPIES_PROJECT_SQL } from './taskOccupancy'

describe('isStaleBlockedJobCandidate / holdsWorkspaceWhenBlocked — done と park は同じ扱い（lifecycle repair C2）', () => {
  const blocked = { status: 'blocked' }
  const quarantined = { status: 'blocked', failureMetadata: { quarantined: true } }

  it('a non-quarantined blocked row on a done or parked Task is a stale candidate, not an owner', () => {
    for (const task of [{ status: 'done' }, { status: 'pending', parked: true }]) {
      expect(isStaleBlockedJobCandidate(task, blocked)).toBe(true)
      expect(holdsWorkspaceWhenBlocked(task, blocked)).toBe(false)
    }
  })

  it('a quarantined row stays an owner on a done or parked Task', () => {
    for (const task of [{ status: 'done' }, { status: 'pending', parked: true }]) {
      expect(isStaleBlockedJobCandidate(task, quarantined)).toBe(false)
      expect(holdsWorkspaceWhenBlocked(task, quarantined)).toBe(true)
    }
  })

  it('without parked (or parked=false) a non-done Task row is an owner (fail-closed default)', () => {
    expect(holdsWorkspaceWhenBlocked({ status: 'pending' }, blocked)).toBe(true)
    expect(holdsWorkspaceWhenBlocked({ status: 'blocked', parked: false }, blocked)).toBe(true)
  })
})

describe('occupiesProject — 既存 currentTask と同じ意味', () => {
  it('in_progress / blocked は roadmapActive に関係なく占有する', () => {
    expect(occupiesProject({ status: 'in_progress', roadmapActive: true })).toBe(true)
    expect(occupiesProject({ status: 'in_progress', roadmapActive: false })).toBe(true)
    expect(occupiesProject({ status: 'blocked', roadmapActive: false })).toBe(true)
  })

  it('pending は roadmapActive のときだけ占有する', () => {
    expect(occupiesProject({ status: 'pending', roadmapActive: true })).toBe(true)
    // parked Task: 未完了だが、どの実行経路からも選ばれない。
    expect(occupiesProject({ status: 'pending', roadmapActive: false })).toBe(false)
    expect(occupiesProject({ status: 'pending' })).toBe(false)
  })

  it('done は占有しない', () => {
    expect(occupiesProject({ status: 'done', roadmapActive: true })).toBe(false)
  })

  it('SQL 断片が同じ条件を書いている', () => {
    // 片方だけ変えると transaction 内の再確認と呼び出し側の判定がずれる。
    expect(OCCUPIES_PROJECT_SQL).toContain("status IN ('in_progress','blocked')")
    expect(OCCUPIES_PROJECT_SQL).toContain("status = 'pending' AND roadmap_active = 1")
  })
})
