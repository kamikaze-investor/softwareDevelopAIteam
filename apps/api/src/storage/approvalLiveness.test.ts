import { describe, expect, it } from 'vitest'
import type { ApprovalGateStatus } from '@ai-team/shared'
import { createSQLiteStorage } from './sqlite'
import type { IStorage } from './interface'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'

/**
 * 「承認待ち」の意味を shared `isLiveWaitingApproval`（期限内の WAITING_FOR_USER）に揃えた
 * storage 側の consumer（2026-10-16 監査 A2）。期限切れ WAITING は誰も待っておらず、
 * `approveAndResumeJob()` も EXPIRED で拒否するので、表示にも retry 抑止にも数えない。
 */

const LIVE = (): string => new Date(Date.now() + 60 * 60 * 1000).toISOString()
const EXPIRED = (): string => new Date(Date.now() - 60 * 1000).toISOString()

function seedRunningTask(): { storage: IStorage; projectId: string; taskId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'in_progress',
    assignee: 'developer_ai', dependencies: [],
  })
  return { storage, projectId: project.id, taskId: task.id }
}

function addRequest(
  storage: IStorage,
  taskId: string,
  status: ApprovalGateStatus,
  expiresAt: string,
  requestedAction = 'git_commit',
): string {
  return storage.approvalRequests.create({
    taskId, requestedAction, riskLevel: 'HIGH',
    targetBranch: 'ai/x', targetCommit: 'c', targetDiffHash: 'd',
    changedFiles: [], triggeredRules: [], invalidIf: [],
    status, expiresAt,
  } as Parameters<IStorage['approvalRequests']['create']>[0]).id
}

describe('tasks.findSummaries — hasWaitingApproval は live な WAITING だけ', () => {
  it.each([
    ['live WAITING', 'WAITING_FOR_USER', LIVE, true],
    ['expired WAITING', 'WAITING_FOR_USER', EXPIRED, false],
    ['APPROVED', 'APPROVED', LIVE, false],
  ] as const)('%s → %s', (_label, status, expiresAt, expected) => {
    const { storage, taskId } = seedRunningTask()
    addRequest(storage, taskId, status, expiresAt())

    const summary = storage.tasks.findSummaries().find((item) => item.taskId === taskId)
    expect(summary?.approvalSummary.hasWaitingApproval).toBe(expected)
  })
})

describe('persistProviderTimeoutFailure — 最新承認による retry 抑止', () => {
  function timeoutWithLatestApproval(status: ApprovalGateStatus | undefined, expiresAt: string) {
    const { storage, projectId, taskId } = seedRunningTask()
    const prompt = 'Implement the reviewed provider-timeout case.'
    storage.designReviewEvidence.create({
      taskId,
      designTextHash: computeDesignTextHash(prompt),
      reviewLoad: 'medium',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    })
    if (status !== undefined) addRequest(storage, taskId, status, expiresAt)
    const source = storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'running',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      aiCliProvider: 'codex', aiCliPrompt: prompt, aiCliMode: 'implement',
    })
    return storage.jobs.persistProviderTimeoutFailure({
      jobId: source.id,
      update: { status: 'failed', failureMetadata: { kind: 'provider_timeout', workspaceState: 'unchanged' } },
      outboxEvent: { eventId: `evt-${status ?? 'none'}-${expiresAt}`, payloadHash: 'h' },
    })
  }

  it('承認が無ければ retry を作る（前提の確認）', () => {
    expect(timeoutWithLatestApproval(undefined, LIVE())).toMatchObject({ ok: true, retryJobCreated: true })
  })

  it('live な WAITING は retry を止める', () => {
    expect(timeoutWithLatestApproval('WAITING_FOR_USER', LIVE()))
      .toMatchObject({ ok: true, retryJobCreated: false })
  })

  it('期限切れ WAITING は retry を止めない（誰も待っていない）', () => {
    expect(timeoutWithLatestApproval('WAITING_FOR_USER', EXPIRED()))
      .toMatchObject({ ok: true, retryJobCreated: true })
  })

  it.each([LIVE, EXPIRED])('REJECTED は期限に関係なく retry を止める（CEO の却下の記録）', (expiresAt) => {
    expect(timeoutWithLatestApproval('REJECTED', expiresAt()))
      .toMatchObject({ ok: true, retryJobCreated: false })
  })
})
