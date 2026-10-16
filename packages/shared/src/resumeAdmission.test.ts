import { describe, expect, it } from 'vitest'
import { evaluateResumeAdmission, type ResumeAdmissionInput } from './resumeAdmission'

const NOW = Date.parse('2026-10-16T00:00:00.000Z')

function input(overrides: Partial<ResumeAdmissionInput> = {}): ResumeAdmissionInput {
  return {
    taskStatus: 'blocked',
    parked: false,
    projectStatus: 'running',
    jobs: [{ status: 'blocked', aiCliMode: 'implement', safeCommand: { kind: 'test' } }],
    approvals: [],
    nowMs: NOW,
    ...overrides,
  }
}

describe('evaluateResumeAdmission', () => {
  it('blocked Job を持つ running Project の Task は受け付ける', () => {
    expect(evaluateResumeAdmission(input())).toEqual({ ok: true })
  })

  it('Task が blocked で最新 Job が failed（escalation）でも受け付ける', () => {
    expect(evaluateResumeAdmission(input({
      jobs: [{ status: 'failed', aiCliMode: 'review', safeCommand: { kind: 'test' } }],
    }))).toEqual({ ok: true })
  })

  it('done の Task は TASK_DONE（最新 Job が blocked でも）', () => {
    expect(evaluateResumeAdmission(input({ taskStatus: 'done' }))).toEqual({ ok: false, code: 'TASK_DONE' })
  })

  it.each(['paused', 'draft', 'archived', undefined])('Project が %s なら PROJECT_NOT_RUNNING', (projectStatus) => {
    expect(evaluateResumeAdmission(input({ projectStatus }))).toEqual({ ok: false, code: 'PROJECT_NOT_RUNNING' })
  })

  it('live な承認待ちがあれば APPROVAL_WAITING、期限切れなら受け付ける', () => {
    const live = { status: 'WAITING_FOR_USER' as const, expiresAt: new Date(NOW + 60_000).toISOString() }
    const expired = { status: 'WAITING_FOR_USER' as const, expiresAt: new Date(NOW - 60_000).toISOString() }
    expect(evaluateResumeAdmission(input({ approvals: [live] }))).toEqual({ ok: false, code: 'APPROVAL_WAITING' })
    expect(evaluateResumeAdmission(input({ approvals: [expired] }))).toEqual({ ok: true })
    // 最新行でなくても live な WAITING があれば断る（集約形）。
    const approved = { status: 'APPROVED' as const, expiresAt: new Date(NOW + 60_000).toISOString() }
    expect(evaluateResumeAdmission(input({ approvals: [approved, live] }))).toEqual({ ok: false, code: 'APPROVAL_WAITING' })
  })

  it.each([
    [{ jobs: [] }, 'NO_JOBS'],
    [{ jobs: [{ status: 'success', aiCliMode: 'implement', safeCommand: { kind: 'test' } }] }, 'LATEST_JOB_NOT_BLOCKED'],
    [{ taskStatus: 'pending', jobs: [{ status: 'failed', aiCliMode: 'implement', safeCommand: { kind: 'test' } }] }, 'LATEST_JOB_NOT_BLOCKED'],
    [{ parked: true }, 'TASK_PARKED'],
    [{ jobs: [{ status: 'blocked', aiCliMode: 'implement', safeCommand: { kind: 'test' }, failureMetadata: { quarantined: true } }] }, 'WORKSPACE_QUARANTINED'],
    [{ jobs: [{ status: 'blocked', aiCliMode: 'implement', safeCommand: { kind: 'test' } }, { status: 'queued', safeCommand: { kind: 'test' } }] }, 'LIVE_JOB_EXISTS'],
    [{ jobs: [{ status: 'blocked', safeCommand: { kind: 'test' } }] }, 'AI_CLI_MODE_MISSING'],
  ] as const)('%o → %s', (overrides, code) => {
    expect(evaluateResumeAdmission(input(overrides as Partial<ResumeAdmissionInput>))).toEqual({ ok: false, code })
  })

  it('git_commit Job は aiCliMode を要求しない', () => {
    expect(evaluateResumeAdmission(input({
      jobs: [{ status: 'blocked', safeCommand: { kind: 'git_commit' } }],
    }))).toEqual({ ok: true })
  })
})
