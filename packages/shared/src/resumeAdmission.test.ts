import { describe, expect, it } from 'vitest'
import { evaluateResumeAdmission, type ResumeAdmissionInput } from './resumeAdmission'

const NOW = Date.parse('2026-10-16T00:00:00.000Z')

function input(overrides: Partial<ResumeAdmissionInput> = {}): ResumeAdmissionInput {
  return {
    taskStatus: 'blocked',
    parked: false,
    projectStatus: 'running',
    jobs: [{ status: 'blocked', aiCliMode: 'implement', aiCliProvider: 'codex', safeCommand: { kind: 'test' } }],
    repairDesignReviewInFlight: false,
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
      jobs: [{ status: 'failed', aiCliMode: 'review', aiCliProvider: 'codex', safeCommand: { kind: 'test' } }],
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
    [{ jobs: [{ status: 'success', aiCliMode: 'implement', aiCliProvider: 'codex', safeCommand: { kind: 'test' } }] }, 'LATEST_JOB_NOT_BLOCKED'],
    [{ taskStatus: 'pending', jobs: [{ status: 'failed', aiCliMode: 'implement', aiCliProvider: 'codex', safeCommand: { kind: 'test' } }] }, 'LATEST_JOB_NOT_BLOCKED'],
    [{ parked: true }, 'TASK_PARKED'],
    [{ jobs: [{ status: 'blocked', aiCliMode: 'implement', aiCliProvider: 'codex', safeCommand: { kind: 'test' }, failureMetadata: { quarantined: true } }] }, 'WORKSPACE_QUARANTINED'],
    [{ jobs: [{ status: 'blocked', aiCliMode: 'implement', aiCliProvider: 'codex', safeCommand: { kind: 'test' } }, { status: 'queued', safeCommand: { kind: 'test' } }] }, 'LIVE_JOB_EXISTS'],
    [{ jobs: [{ status: 'blocked', safeCommand: { kind: 'test' } }] }, 'AI_CLI_MODE_MISSING'],
    [{ jobs: [{ status: 'blocked', aiCliMode: 'implement', safeCommand: { kind: 'test' } }] }, 'AI_CLI_PROVIDER_MISSING'],
  ] as const)('%o → %s', (overrides, code) => {
    expect(evaluateResumeAdmission(input(overrides as Partial<ResumeAdmissionInput>))).toEqual({ ok: false, code })
  })

  it('git_commit Job は aiCliMode を要求しない', () => {
    expect(evaluateResumeAdmission(input({
      jobs: [{ status: 'blocked', safeCommand: { kind: 'git_commit' } }],
    }))).toEqual({ ok: true })
  })
})

// Codex review 361c19a（C-03）: Task 単位の判断（command kind でない requestedAction）は、人の resume なら
// 置き換え対象として通し、人でない resume なら HUMAN_DECISION_PENDING。Job 束縛の承認待ちは従来どおり。
describe('evaluateResumeAdmission — Task 単位の判断', () => {
  const live = (requestedAction: string, status: 'WAITING_FOR_USER' | 'APPROVED' = 'WAITING_FOR_USER') => ({
    status, requestedAction, expiresAt: new Date(NOW + 60_000).toISOString(),
  })

  it('人の resume は live WAITING / APPROVED の Task 単位判断があっても受け付ける', () => {
    expect(evaluateResumeAdmission(input({ resumedByHuman: true, approvals: [live('abort_task')] }))).toEqual({ ok: true })
    expect(evaluateResumeAdmission(input({ resumedByHuman: true, approvals: [live('abort_task', 'APPROVED')] })))
      .toEqual({ ok: true })
  })

  it('人でない resume は live WAITING / APPROVED の Task 単位判断があると HUMAN_DECISION_PENDING', () => {
    expect(evaluateResumeAdmission(input({ approvals: [live('reconcile_external_completion')] })))
      .toEqual({ ok: false, code: 'HUMAN_DECISION_PENDING' })
    // APPROVED は決定主体（API が付ける approvalActor）が human のときだけ人の判断（lifecycle repair C3）。
    expect(evaluateResumeAdmission(input({
      approvals: [{ ...live('repair_from_stored_review:r1', 'APPROVED'), approvalActor: 'human' as const }],
    }))).toEqual({ ok: false, code: 'HUMAN_DECISION_PENDING' })
  })

  it('決定主体が human でない（記録なし / ai / unknown）live APPROVED は人の判断として数えない', () => {
    // 実行側（verifyAndConsumeTaskApproval）は approval_actor=human の無い APPROVED を authority として
    // 使わない。それを HUMAN_DECISION_PENDING の根拠にすると、authority の無い行が Task を止める（C3 P1）。
    for (const approvalActor of [undefined, 'ai' as const, 'unknown' as const]) {
      expect(evaluateResumeAdmission(input({
        approvals: [{ ...live('abort_task', 'APPROVED'), approvalActor }],
      }))).toEqual({ ok: true })
    }
    // WAITING は主体に依らず判断待ち。
    expect(evaluateResumeAdmission(input({ approvals: [live('abort_task')] })))
      .toEqual({ ok: false, code: 'HUMAN_DECISION_PENDING' })
  })

  it('期限切れの Task 単位判断は誰も止めない', () => {
    const expired = { status: 'APPROVED' as const, requestedAction: 'abort_task', expiresAt: new Date(NOW - 60_000).toISOString() }
    expect(evaluateResumeAdmission(input({ approvals: [expired] }))).toEqual({ ok: true })
  })

  it('live WAITING の command kind 承認は人の resume でも APPROVAL_WAITING', () => {
    expect(evaluateResumeAdmission(input({ resumedByHuman: true, approvals: [live('git_commit')] })))
      .toEqual({ ok: false, code: 'APPROVAL_WAITING' })
  })
})
