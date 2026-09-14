import { describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import {
  authorizePlAction,
  assertPlActionExecutable,
  PlActionBlockedError,
  UNVERIFIABLE_GATES,
} from './actionGate'

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString()

function seedProject(storage: IStorage): string {
  return storage.projects.create({
    name: 'AIteamOS',
    goal: 'g',
    designPhilosophy: [],
    status: 'running',
  }).id
}

function seedTask(storage: IStorage): string {
  const project = { id: seedProject(storage) }
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: true,
    phase: 1,
  } as Parameters<IStorage['tasks']['create']>[0])
  return task.id
}

function createDesignReviewEvidence(
  storage: IStorage,
  taskId: string,
  over: { decision?: string; independentReviewRequired?: boolean; independentReviewVerdict?: string } = {},
): string {
  return storage.designReviewEvidence.create({
    taskId,
    reviewKind: 'task',
    subjectId: taskId,
    designTextHash: 'hash',
    reviewLoad: 'low',
    decision: (over.decision ?? 'ALIGNED') as never,
    independentReviewRequired: over.independentReviewRequired ?? false,
    independentReviewVerdict: over.independentReviewVerdict as never,
  } as Parameters<IStorage['designReviewEvidence']['create']>[0]).id
}

function createApprovalRequest(storage: IStorage, taskId: string, over: Record<string, unknown> = {}): string {
  return storage.approvalRequests.create({
    taskId,
    requestedAction: 'git_commit',
    riskLevel: 'LOW',
    triggeredRules: [],
    invalidIf: [],
    targetBranch: 'main',
    targetCommit: 'c',
    targetDiffHash: 'd',
    status: 'APPROVED',
    expiresAt: FUTURE,
    ...over,
  } as Parameters<IStorage['approvalRequests']['create']>[0]).id
}

describe('authorizePlAction — 判定を必ず監査記録へ残す', () => {
  it('許可された操作も記録する（境界が効いているかを後から検証できるように）', () => {
    const storage = createSQLiteStorage(':memory:')

    const { decision, actionId } = authorizePlAction(storage, { kind: 'retry_job' })

    expect(decision.disposition).toBe('gates_required')
    const entries = storage.auditLog.findByEntity('pl_action', actionId)
    expect(entries).toHaveLength(1)
    expect(entries[0].operation).toBe('pl_action_policy')
    expect(entries[0].result).toBe('gates_required')
    expect(entries[0].detail).toContain('kind=retry_job')
    expect(entries[0].detail).toContain('policy=pl-action-policy-v1')
  })

  it('禁止された操作も記録する', () => {
    const storage = createSQLiteStorage(':memory:')

    const { decision, actionId } = authorizePlAction(storage, { kind: 'override_gate_block' })

    expect(decision.disposition).toBe('forbidden')
    expect(storage.auditLog.findByEntity('pl_action', actionId)[0].result).toBe('forbidden')
  })

  it('detail に diff や prompt のような大きな payload を載せない', () => {
    const storage = createSQLiteStorage(':memory:')

    const { actionId } = authorizePlAction(storage, {
      kind: 'propose_code_change',
      changedFiles: ['apps/api/src/storage/migrations/004_x.ts'],
      plRiskOpinion: { level: 'LOW', rationale: 'x'.repeat(5000) },
    })

    const detail = storage.auditLog.findByEntity('pl_action', actionId)[0].detail ?? ''
    expect(detail.length).toBeLessThan(200)
    expect(detail).not.toContain('xxxxx')
  })
})

describe('assertPlActionExecutable — 呼び出し側の判定を信じない', () => {
  it('提案から判定を作り直すので、偽装した判定を渡す余地が無い', () => {
    const storage = createSQLiteStorage(':memory:')

    // 引数は「提案」だけ。judgement オブジェクトを差し込む口が存在しない。
    expect(() => assertPlActionExecutable(storage, { kind: 'rollback_commit' }, [])).toThrow(
      PlActionBlockedError,
    )
  })

  it('forbidden な操作は、どんな根拠を積んでも通らない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const evidenceId = createDesignReviewEvidence(storage, taskId)
    const approvalRequestId = createApprovalRequest(storage, taskId)

    expect(() =>
      assertPlActionExecutable(storage, { kind: 'change_own_permission' }, [
        { gate: 'design_review', designReviewEvidenceId: evidenceId },
        { gate: 'approval_gate', approvalRequestId },
      ]),
    ).toThrow(PlActionBlockedError)
  })

  it('Gate を要さない観測操作はそのまま通る', () => {
    const storage = createSQLiteStorage(':memory:')

    const decision = assertPlActionExecutable(storage, { kind: 'observe_state' })
    expect(decision.disposition).toBe('no_gate_required')
  })
})

describe('assertPlActionExecutable — 充足は DB の実レコードで検証する', () => {
  it('存在しない根拠 ID は充足にならない', () => {
    const storage = createSQLiteStorage(':memory:')

    let thrown: unknown
    try {
      assertPlActionExecutable(storage, { kind: 'retry_job' }, [
        { gate: 'approval_gate', approvalRequestId: 'does-not-exist' },
      ])
    } catch (error) {
      thrown = error
    }

    const blocked = thrown as PlActionBlockedError
    expect(blocked).toBeInstanceOf(PlActionBlockedError)
    expect(blocked.missingGates).toEqual(['approval_gate'])
    expect(blocked.rejectedEvidence[0]).toContain('does not exist')
  })

  it('承認待ちの Approval Request は充足にならない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const approvalRequestId = createApprovalRequest(storage, taskId, { status: 'WAITING_FOR_USER' })

    expect(() =>
      assertPlActionExecutable(storage, { kind: 'retry_job' }, [
        { gate: 'approval_gate', approvalRequestId },
      ]),
    ).toThrow(PlActionBlockedError)
  })

  it('期限切れの Approval Request は充足にならない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const approvalRequestId = createApprovalRequest(storage, taskId, { expiresAt: PAST })

    expect(() =>
      assertPlActionExecutable(storage, { kind: 'retry_job' }, [
        { gate: 'approval_gate', approvalRequestId },
      ]),
    ).toThrow(PlActionBlockedError)
  })

  it('承認済み Approval Request なら retry_job は通る', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const approvalRequestId = createApprovalRequest(storage, taskId)

    const decision = assertPlActionExecutable(storage, { kind: 'retry_job' }, [
      { gate: 'approval_gate', approvalRequestId },
    ])
    expect(decision.kind).toBe('retry_job')
  })

  it('ALIGNED でない Design Review evidence は充足にならない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const evidenceId = createDesignReviewEvidence(storage, taskId, { decision: 'UNCERTAIN' })
    const approvalRequestId = createApprovalRequest(storage, taskId)

    let thrown: unknown
    try {
      assertPlActionExecutable(storage, { kind: 'resume_task' }, [
        { gate: 'design_review', designReviewEvidenceId: evidenceId },
        { gate: 'approval_gate', approvalRequestId },
      ])
    } catch (error) {
      thrown = error
    }

    expect((thrown as PlActionBlockedError).missingGates).toEqual(['design_review'])
  })

  it('独立レビューを実行していない evidence は independent_review の根拠にならない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const evidenceId = createDesignReviewEvidence(storage, taskId, {
      independentReviewRequired: false,
    })

    let thrown: unknown
    try {
      assertPlActionExecutable(storage, { kind: 'deploy_production' }, [
        { gate: 'independent_review', designReviewEvidenceId: evidenceId },
      ])
    } catch (error) {
      thrown = error
    }

    expect((thrown as PlActionBlockedError).missingGates).toContain('independent_review')
  })

  it('independent review の verdict が approved でなければ充足にならない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const evidenceId = createDesignReviewEvidence(storage, taskId, {
      independentReviewRequired: true,
      independentReviewVerdict: 'blocking',
    })

    expect(() =>
      assertPlActionExecutable(storage, { kind: 'deploy_production' }, [
        { gate: 'independent_review', designReviewEvidenceId: evidenceId },
      ]),
    ).toThrow(PlActionBlockedError)
  })

  it('pending な CEO Approval は充足にならない', () => {
    const storage = createSQLiteStorage(':memory:')
    const projectId = seedProject(storage)
    const approvalId = storage.approvals.create({
      projectId,
      title: 't',
      reason: 'r',
      type: 'deployment',
      status: 'pending',
    } as Parameters<IStorage['approvals']['create']>[0]).id

    expect(() =>
      assertPlActionExecutable(storage, { kind: 'restart_service' }, [
        { gate: 'ceo_approval', approvalId },
      ]),
    ).toThrow(PlActionBlockedError)
  })

  it('承認済みの CEO Approval なら restart_service は通る', () => {
    const storage = createSQLiteStorage(':memory:')
    const projectId = seedProject(storage)
    const approval = storage.approvals.create({
      projectId,
      title: 't',
      reason: 'r',
      type: 'deployment',
      status: 'pending',
    } as Parameters<IStorage['approvals']['create']>[0])
    storage.approvals.update(approval.id, { status: 'approved' })

    const decision = assertPlActionExecutable(storage, { kind: 'restart_service' }, [
      { gate: 'ceo_approval', approvalId: approval.id },
    ])
    expect(decision.kind).toBe('restart_service')
  })
})

describe('assertPlActionExecutable — 検証手段の無い Gate は充足できない', () => {
  it('safety_review を要求する操作は、根拠を積んでも通らない（fail-closed）', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const approvalRequestId = createApprovalRequest(storage, taskId)

    let thrown: unknown
    try {
      assertPlActionExecutable(storage, { kind: 'clear_workspace_quarantine' }, [
        { gate: 'approval_gate', approvalRequestId },
      ])
    } catch (error) {
      thrown = error
    }

    expect((thrown as PlActionBlockedError).missingGates).toEqual(['safety_review'])
  })

  it('検証できない Gate の一覧が明示されている', () => {
    expect(UNVERIFIABLE_GATES).toContain('safety_review')
    expect(UNVERIFIABLE_GATES).toContain('strategic_alignment_review')
  })
})

describe('assertPlActionExecutable — 実行可否の判断も監査に残せる', () => {
  it('actionId を渡すと blocked / executable が記録される', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const approvalRequestId = createApprovalRequest(storage, taskId)
    const { actionId } = authorizePlAction(storage, { kind: 'retry_job' })

    expect(() => assertPlActionExecutable(storage, { kind: 'retry_job' }, [], { actionId })).toThrow(
      PlActionBlockedError,
    )
    assertPlActionExecutable(
      storage,
      { kind: 'retry_job' },
      [{ gate: 'approval_gate', approvalRequestId }],
      { actionId },
    )

    const results = storage.auditLog
      .findByEntity('pl_action', actionId)
      .filter((entry) => entry.operation === 'pl_action_execute')
      .map((entry) => entry.result)

    // findByEntity の並び順には依存しない。両方が記録されていることだけを固定する。
    expect([...results].sort()).toEqual(['blocked', 'executable'])
  })
})
