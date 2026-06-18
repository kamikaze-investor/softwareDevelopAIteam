import { describe, it, expect } from 'vitest'
import { checkStall, getStallThreshold } from './stallDetector'

describe('checkStall', () => {
  it('閾値以下なら isStalled=false', () => {
    const startedAt = new Date(Date.now() - 10_000).toISOString()
    const result = checkStall('git_status', startedAt)
    expect(result.isStalled).toBe(false)
  })

  it('閾値超過なら isStalled=true', () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const result = checkStall('git_status', startedAt) // threshold=30s
    expect(result.isStalled).toBe(true)
  })

  it('ちょうど閾値は isStalled=false（境界値: >で判定）', () => {
    const threshold = getStallThreshold('git_commit') // 60000
    const startedAt = new Date(Date.now() - threshold).toISOString()
    const result = checkStall('git_commit', startedAt)
    // stallDurationMs == threshold → false (> でなく ==)
    expect(result.isStalled).toBe(false)
  })

  it('nowMs を注入して決定論的にテスト可能', () => {
    const base = 1_700_000_000_000
    const startedAt = new Date(base).toISOString()
    const result = checkStall('typecheck', startedAt, base + 400_000) // 400s > 300s threshold
    expect(result.isStalled).toBe(true)
    expect(result.stallDurationMs).toBe(400_000)
    expect(result.thresholdMs).toBe(300_000)
  })

  it('test コマンドは 600s 閾値', () => {
    const base = 1_700_000_000_000
    const startedAt = new Date(base).toISOString()
    expect(checkStall('test', startedAt, base + 599_999).isStalled).toBe(false)
    expect(checkStall('test', startedAt, base + 600_001).isStalled).toBe(true)
  })

  it('build コマンドは 600s 閾値', () => {
    expect(getStallThreshold('build')).toBe(600_000)
  })

  it('lint コマンドは 120s 閾値', () => {
    expect(getStallThreshold('lint')).toBe(120_000)
  })
})
