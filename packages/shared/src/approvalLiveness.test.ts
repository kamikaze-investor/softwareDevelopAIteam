import { describe, expect, it } from 'vitest'
import { isApprovalBlockingTechnicalAbort } from './approvalLiveness'

const NOW = Date.parse('2026-10-20T00:00:00.000Z')
const FUTURE = '2026-10-21T00:00:00.000Z'
const PAST = '2026-10-19T00:00:00.000Z'

describe('isApprovalBlockingTechnicalAbort (H-2 / T-1)', () => {
  it('WAITING blocks when unexpired or when its expiry is unreadable', () => {
    expect(isApprovalBlockingTechnicalAbort({ status: 'WAITING_FOR_USER', expiresAt: FUTURE }, { nowMs: NOW })).toBe(true)
    expect(isApprovalBlockingTechnicalAbort({ status: 'WAITING_FOR_USER', expiresAt: 'not-a-date' }, { nowMs: NOW })).toBe(true)
    expect(isApprovalBlockingTechnicalAbort({ status: 'WAITING_FOR_USER', expiresAt: PAST }, { nowMs: NOW })).toBe(false)
  })

  it('APPROVED blocks only when the decider is human (and it is unexpired or unreadable)', () => {
    expect(isApprovalBlockingTechnicalAbort({ status: 'APPROVED', expiresAt: FUTURE, approvalActor: 'human' }, { nowMs: NOW })).toBe(true)
    expect(isApprovalBlockingTechnicalAbort({ status: 'APPROVED', expiresAt: 'not-a-date', approvalActor: 'human' }, { nowMs: NOW })).toBe(true)
    expect(isApprovalBlockingTechnicalAbort({ status: 'APPROVED', expiresAt: PAST, approvalActor: 'human' }, { nowMs: NOW })).toBe(false)
    expect(isApprovalBlockingTechnicalAbort({ status: 'APPROVED', expiresAt: FUTURE, approvalActor: 'unknown' }, { nowMs: NOW })).toBe(false)
    expect(isApprovalBlockingTechnicalAbort({ status: 'APPROVED', expiresAt: FUTURE }, { nowMs: NOW })).toBe(false)
  })

  it('CONSUMED blocks only when human-decided and created after the cleanup request', () => {
    const cleanupRequestedAt = '2026-10-19T12:00:00.000Z'
    const row = { status: 'CONSUMED' as const, expiresAt: PAST, createdAt: '2026-10-19T13:00:00.000Z' }
    expect(isApprovalBlockingTechnicalAbort({ ...row, approvalActor: 'human' }, { nowMs: NOW, cleanupRequestedAt })).toBe(true)
    expect(isApprovalBlockingTechnicalAbort({ ...row, approvalActor: 'ai' }, { nowMs: NOW, cleanupRequestedAt })).toBe(false)
    expect(isApprovalBlockingTechnicalAbort({ ...row, approvalActor: 'human' }, { nowMs: NOW })).toBe(false)
    expect(isApprovalBlockingTechnicalAbort({ ...row, createdAt: '2026-10-19T11:00:00.000Z', approvalActor: 'human' }, { nowMs: NOW, cleanupRequestedAt })).toBe(false)
  })

  it('CONSUMED compares times numerically: a timezone-offset form of a later instant still blocks', () => {
    // 12:00Z の cleanup 要求。作成 13:00Z を +09:00 で書くと '2026-10-19T22:00:00+09:00'（文字列では順序を誤らない例）、
    // cleanup を +09:00 で書くと '2026-10-19T21:00:00+09:00' で、作成 13:00Z は文字列比較では「前」になる。
    const human = { status: 'CONSUMED' as const, expiresAt: PAST, approvalActor: 'human' as const }
    expect(isApprovalBlockingTechnicalAbort(
      { ...human, createdAt: '2026-10-19T13:00:00.000Z' },
      { nowMs: NOW, cleanupRequestedAt: '2026-10-19T21:00:00+09:00' },
    )).toBe(true)
    expect(isApprovalBlockingTechnicalAbort(
      { ...human, createdAt: '2026-10-19T20:00:00+09:00' },
      { nowMs: NOW, cleanupRequestedAt: '2026-10-19T12:00:00.000Z' },
    )).toBe(false)
  })

  it('CONSUMED with a missing or unreadable createdAt / cleanup time blocks (fail closed)', () => {
    const human = { status: 'CONSUMED' as const, expiresAt: PAST, approvalActor: 'human' as const }
    const cleanupRequestedAt = '2026-10-19T12:00:00.000Z'
    expect(isApprovalBlockingTechnicalAbort({ ...human }, { nowMs: NOW, cleanupRequestedAt })).toBe(true)
    expect(isApprovalBlockingTechnicalAbort({ ...human, createdAt: 'garbage' }, { nowMs: NOW, cleanupRequestedAt })).toBe(true)
    expect(isApprovalBlockingTechnicalAbort(
      { ...human, createdAt: '2026-10-19T13:00:00.000Z' },
      { nowMs: NOW, cleanupRequestedAt: 'garbage' },
    )).toBe(true)
    // 人以外の CONSUMED は時刻に関係なく止めない。
    expect(isApprovalBlockingTechnicalAbort({ ...human, approvalActor: 'ai', createdAt: 'garbage' }, { nowMs: NOW, cleanupRequestedAt })).toBe(false)
  })
})
