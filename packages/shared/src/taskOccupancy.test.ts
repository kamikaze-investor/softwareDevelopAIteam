import { describe, expect, it } from 'vitest'
import { occupiesProject, OCCUPIES_PROJECT_SQL } from './taskOccupancy'

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
