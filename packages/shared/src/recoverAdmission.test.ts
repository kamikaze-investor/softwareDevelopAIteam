import { describe, expect, it } from 'vitest'
import { evaluateRecoverAdmission, type RecoverAdmissionInput } from './recoverAdmission'

const NOW = Date.parse('2026-10-16T00:00:00.000Z')

function input(overrides: Partial<RecoverAdmissionInput> = {}): RecoverAdmissionInput {
  return {
    taskStatus: 'blocked',
    parked: false,
    projectStatus: 'running',
    jobCount: 0,
    approvals: [],
    nowMs: NOW,
    ...overrides,
  }
}

describe('evaluateRecoverAdmission', () => {
  it('Job 0 件の blocked Task（running Project）は受け付ける', () => {
    expect(evaluateRecoverAdmission(input())).toEqual({ ok: true })
  })

  it.each([
    [{ projectStatus: undefined }, 'PROJECT_UNAVAILABLE'],
    [{ projectStatus: null }, 'PROJECT_UNAVAILABLE'],
    [{ projectStatus: 'archived' }, 'PROJECT_UNAVAILABLE'],
    [{ projectStatus: 'paused' }, 'PROJECT_NOT_RUNNING'],
    [{ projectStatus: 'draft' }, 'PROJECT_NOT_RUNNING'],
    [{ taskStatus: 'pending' }, 'TASK_NOT_BLOCKED'],
    [{ taskStatus: 'done' }, 'TASK_NOT_BLOCKED'],
    [{ jobCount: 1 }, 'TASK_HAS_JOBS'],
    [{ parked: true }, 'TASK_PARKED'],
  ] as const)('%o は %s', (overrides, code) => {
    expect(evaluateRecoverAdmission(input(overrides))).toEqual({ ok: false, code })
  })

  it('live な承認待ちがあれば APPROVAL_WAITING、期限切れの WAITING は無視する', () => {
    expect(evaluateRecoverAdmission(input({
      approvals: [{ status: 'WAITING_FOR_USER', expiresAt: '2026-10-16T01:00:00.000Z' }],
    }))).toEqual({ ok: false, code: 'APPROVAL_WAITING' })
    expect(evaluateRecoverAdmission(input({
      approvals: [{ status: 'WAITING_FOR_USER', expiresAt: '2026-10-15T23:00:00.000Z' }],
    }))).toEqual({ ok: true })
  })
})
