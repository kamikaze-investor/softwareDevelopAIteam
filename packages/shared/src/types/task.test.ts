import { describe, expect, it } from 'vitest'
import { computeTaskDisplayStatus } from './task'
import { isLiveApprovedApproval } from '../approvalLiveness'

const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const FUTURE = '2026-10-16T13:00:00.000Z'
const PAST = '2026-10-16T11:00:00.000Z'

describe('computeTaskDisplayStatus', () => {
  it('returns pending for a pending Task without a Job', () => {
    expect(computeTaskDisplayStatus({ taskStatus: 'pending' })).toBe('pending')
  })

  it('shows waiting_approval only for a live (unexpired) linked WAITING request', () => {
    expect(computeTaskDisplayStatus({
      taskStatus: 'in_progress', latestJobStatus: 'blocked',
      linkedApproval: { status: 'WAITING_FOR_USER', expiresAt: FUTURE }, nowMs: NOW,
    })).toBe('waiting_approval')
  })

  it('an expired linked WAITING request is not waiting: the Task is blocked (A-02)', () => {
    expect(computeTaskDisplayStatus({
      taskStatus: 'in_progress', latestJobStatus: 'blocked',
      linkedApproval: { status: 'WAITING_FOR_USER', expiresAt: PAST }, nowMs: NOW,
    })).toBe('blocked')
  })

  it('a linked REJECTED request still shows rejected_waiting_instruction', () => {
    expect(computeTaskDisplayStatus({
      taskStatus: 'in_progress', latestJobStatus: 'blocked',
      linkedApproval: { status: 'REJECTED', expiresAt: PAST }, nowMs: NOW,
    })).toBe('rejected_waiting_instruction')
  })
})

describe('isLiveApprovedApproval', () => {
  it('is live only for an unexpired APPROVED request with a readable expiry', () => {
    expect(isLiveApprovedApproval({ status: 'APPROVED', expiresAt: FUTURE }, NOW)).toBe(true)
    expect(isLiveApprovedApproval({ status: 'APPROVED', expiresAt: PAST }, NOW)).toBe(false)
    expect(isLiveApprovedApproval({ status: 'APPROVED', expiresAt: 'not-a-date' }, NOW)).toBe(false)
    expect(isLiveApprovedApproval({ status: 'WAITING_FOR_USER', expiresAt: FUTURE }, NOW)).toBe(false)
    expect(isLiveApprovedApproval(undefined, NOW)).toBe(false)
  })
})
