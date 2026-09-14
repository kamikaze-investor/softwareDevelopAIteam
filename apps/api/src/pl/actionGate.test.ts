import { describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import {
  authorizePlAction,
  previewPlActionPolicy,
  PlActionBlockedError,
  UNVERIFIABLE_GATES,
  type PlActionRequest,
} from './actionGate'

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString()

interface Fixture {
  storage: IStorage
  projectId: string
  taskId: string
  jobId: string
}

function seed(): Fixture {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS',
    goal: 'g',
    designPhilosophy: [],
    status: 'running',
  })
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
  const job = storage.jobs.create({
    taskId: task.id,
    projectId: project.id,
    agentRole: 'developer_ai',
    status: 'failed',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    dryRun: false,
  } as Parameters<IStorage['jobs']['create']>[0])
  return { storage, projectId: project.id, taskId: task.id, jobId: job.id }
}

function addTask(storage: IStorage, projectId: string): string {
  return storage.tasks.create({
    projectId,
    title: 'other',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: true,
    phase: 1,
  } as Parameters<IStorage['tasks']['create']>[0]).id
}

function addDesignReviewEvidence(
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

function addApprovalRequest(storage: IStorage, taskId: string, over: Record<string, unknown> = {}): string {
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

function addCeoApproval(
  storage: IStorage,
  projectId: string,
  over: { type?: string; status?: string } = {},
): string {
  const approval = storage.approvals.create({
    projectId,
    title: 't',
    reason: 'r',
    type: (over.type ?? 'deployment') as never,
    status: 'pending',
  } as Parameters<IStorage['approvals']['create']>[0])
  storage.approvals.update(approval.id, { status: (over.status ?? 'approved') as never })
  return approval.id
}

function expectBlocked(storage: IStorage, request: PlActionRequest): PlActionBlockedError {
  let thrown: unknown
  try {
    authorizePlAction(storage, request)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(PlActionBlockedError)
  return thrown as PlActionBlockedError
}

describe('previewPlActionPolicy — 見るだけで、許可ではない', () => {
  it('必要 Gate を返すが、記録も実行権も伴わない', () => {
    const { storage } = seed()

    const decision = previewPlActionPolicy({ kind: 'rollback_commit' })

    expect(decision.requiredGates).toContain('ceo_approval')
    expect(storage.auditLog.findAll()).toHaveLength(0)
  })
})

describe('authorizePlAction — 判定を必ず監査記録へ残す', () => {
  it('許可されたときも記録する（境界が効いているかを後から検証できるように）', () => {
    const { storage, taskId, jobId } = seed()
    const approvalRequestId = addApprovalRequest(storage, taskId)

    const { actionId } = authorizePlAction(storage, {
      proposal: { kind: 'retry_job' },
      target: { kind: 'job', jobId, taskId },
      evidence: [{ gate: 'approval_gate', approvalRequestId }],
    })

    const entries = storage.auditLog.findByEntity('pl_action', actionId)
    expect(entries).toHaveLength(1)
    expect(entries[0].operation).toBe('pl_action_authorize')
    expect(entries[0].result).toBe('authorized')
    expect(entries[0].detail).toContain('kind=retry_job')
    expect(entries[0].detail).toContain('policy=pl-action-policy-v1')
  })

  it('禁止された操作も記録する', () => {
    const { storage } = seed()

    expectBlocked(storage, {
      proposal: { kind: 'override_gate_block' },
      target: { kind: 'system' },
    })

    const entries = storage.auditLog.findAll()
    expect(entries).toHaveLength(1)
    expect(entries[0].result).toBe('forbidden')
  })

  it('detail に diff や prompt のような大きな payload を載せない', () => {
    const { storage, taskId } = seed()

    expectBlocked(storage, {
      proposal: {
        kind: 'propose_code_change',
        changedFiles: ['apps/api/src/storage/migrations/004_x.ts'],
        plRiskOpinion: { level: 'LOW', rationale: 'x'.repeat(5000) },
      },
      target: { kind: 'task', taskId },
    })

    const detail = storage.auditLog.findAll()[0].detail ?? ''
    expect(detail.length).toBeLessThan(200)
    expect(detail).not.toContain('xxxxx')
  })
})

describe('authorizePlAction — 呼び出し側の判定を信じない', () => {
  it('許可を得る経路は1つで、判定オブジェクトを差し込む引数が存在しない', () => {
    const { storage, jobId, taskId } = seed()

    // 渡せるのは提案・対象・根拠だけ。「もう通っている」と主張する手段が無い。
    expectBlocked(storage, {
      proposal: { kind: 'rollback_commit' },
      target: { kind: 'job', jobId, taskId },
    })
  })

  it('forbidden な操作は、どんな根拠を積んでも通らない', () => {
    const { storage, taskId, projectId } = seed()
    const designReviewEvidenceId = addDesignReviewEvidence(storage, taskId)
    const approvalRequestId = addApprovalRequest(storage, taskId)
    const approvalId = addCeoApproval(storage, projectId)

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'change_own_permission' },
      target: { kind: 'task', taskId },
      evidence: [
        { gate: 'design_review', designReviewEvidenceId },
        { gate: 'approval_gate', approvalRequestId },
        { gate: 'ceo_approval', approvalId },
      ],
    })

    expect(blocked.decision.disposition).toBe('forbidden')
  })

  it('Gate を要さない観測操作はそのまま通る', () => {
    const { storage } = seed()

    const { decision } = authorizePlAction(storage, {
      proposal: { kind: 'observe_state' },
      target: { kind: 'system' },
    })
    expect(decision.disposition).toBe('no_gate_required')
  })
})

describe('authorizePlAction — 根拠は操作対象へ束縛する', () => {
  it('別 Task の ALIGNED evidence では resume_task は通らない', () => {
    const { storage, projectId, taskId } = seed()
    const otherTaskId = addTask(storage, projectId)
    const foreignEvidenceId = addDesignReviewEvidence(storage, otherTaskId)
    const approvalRequestId = addApprovalRequest(storage, taskId)

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'resume_task' },
      target: { kind: 'task', taskId },
      evidence: [
        { gate: 'design_review', designReviewEvidenceId: foreignEvidenceId },
        { gate: 'approval_gate', approvalRequestId },
      ],
    })

    expect(blocked.missingGates).toEqual(['design_review'])
    expect(blocked.rejectedEvidence.join(' ')).toContain('belongs to another task')
  })

  it('別 Task の Approval Request では通らない', () => {
    const { storage, projectId, taskId, jobId } = seed()
    const otherTaskId = addTask(storage, projectId)
    const foreignApprovalRequestId = addApprovalRequest(storage, otherTaskId)

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'retry_job' },
      target: { kind: 'job', jobId, taskId },
      evidence: [{ gate: 'approval_gate', approvalRequestId: foreignApprovalRequestId }],
    })

    expect(blocked.missingGates).toEqual(['approval_gate'])
  })

  it('Job に属さない taskId を申告しても束縛は成立しない', () => {
    const { storage, projectId, jobId, taskId } = seed()
    const otherTaskId = addTask(storage, projectId)
    const approvalRequestId = addApprovalRequest(storage, otherTaskId)

    // jobId は本物、taskId は別 Task。DB 側で照合するので通らない。
    const blocked = expectBlocked(storage, {
      proposal: { kind: 'retry_job' },
      target: { kind: 'job', jobId, taskId: otherTaskId },
      evidence: [{ gate: 'approval_gate', approvalRequestId }],
    })

    expect(blocked.missingGates).toEqual(['approval_gate'])
    expect(taskId).not.toBe(otherTaskId)
  })

  it('操作種別に合わない対象は通らない', () => {
    const { storage, taskId } = seed()

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'retry_job' },
      target: { kind: 'task', taskId },
    })

    expect(blocked.rejectedEvidence.join(' ')).toContain('requires a job target')
  })

  it('その Task の最新でない evidence は使えない（古い ALIGNED の持ち出し禁止）', () => {
    const { storage, taskId } = seed()
    const staleEvidenceId = addDesignReviewEvidence(storage, taskId, { decision: 'ALIGNED' })
    addDesignReviewEvidence(storage, taskId, { decision: 'UNCERTAIN' })
    const approvalRequestId = addApprovalRequest(storage, taskId)

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'resume_task' },
      target: { kind: 'task', taskId },
      evidence: [
        { gate: 'design_review', designReviewEvidenceId: staleEvidenceId },
        { gate: 'approval_gate', approvalRequestId },
      ],
    })

    expect(blocked.missingGates).toEqual(['design_review'])
    expect(blocked.rejectedEvidence.join(' ')).toContain('not the latest')
  })

  it('対象の最新 ALIGNED evidence と承認済み Approval なら resume_task は通る', () => {
    const { storage, taskId } = seed()
    const designReviewEvidenceId = addDesignReviewEvidence(storage, taskId)
    const approvalRequestId = addApprovalRequest(storage, taskId)

    const { decision } = authorizePlAction(storage, {
      proposal: { kind: 'resume_task' },
      target: { kind: 'task', taskId },
      evidence: [
        { gate: 'design_review', designReviewEvidenceId },
        { gate: 'approval_gate', approvalRequestId },
      ],
    })

    expect(decision.kind).toBe('resume_task')
  })
})

describe('authorizePlAction — レコードの状態を実際に読む', () => {
  it('存在しない根拠 ID は充足にならない', () => {
    const { storage, jobId, taskId } = seed()

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'retry_job' },
      target: { kind: 'job', jobId, taskId },
      evidence: [{ gate: 'approval_gate', approvalRequestId: 'does-not-exist' }],
    })

    expect(blocked.missingGates).toEqual(['approval_gate'])
    expect(blocked.rejectedEvidence[0]).toContain('does not exist')
  })

  it('承認待ちの Approval Request は充足にならない', () => {
    const { storage, jobId, taskId } = seed()
    const approvalRequestId = addApprovalRequest(storage, taskId, { status: 'WAITING_FOR_USER' })

    expectBlocked(storage, {
      proposal: { kind: 'retry_job' },
      target: { kind: 'job', jobId, taskId },
      evidence: [{ gate: 'approval_gate', approvalRequestId }],
    })
  })

  it('期限切れの Approval Request は充足にならない', () => {
    const { storage, jobId, taskId } = seed()
    const approvalRequestId = addApprovalRequest(storage, taskId, { expiresAt: PAST })

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'retry_job' },
      target: { kind: 'job', jobId, taskId },
      evidence: [{ gate: 'approval_gate', approvalRequestId }],
    })

    expect(blocked.rejectedEvidence.join(' ')).toContain('expired')
  })

  it('読めない期限値は「未失効」として通さない', () => {
    const { storage, jobId, taskId } = seed()
    const approvalRequestId = addApprovalRequest(storage, taskId, { expiresAt: 'not-a-date' })

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'retry_job' },
      target: { kind: 'job', jobId, taskId },
      evidence: [{ gate: 'approval_gate', approvalRequestId }],
    })

    expect(blocked.rejectedEvidence.join(' ')).toContain('unreadable expiry')
  })

  it('ALIGNED でない Design Review evidence は充足にならない', () => {
    const { storage, taskId } = seed()
    const designReviewEvidenceId = addDesignReviewEvidence(storage, taskId, { decision: 'UNCERTAIN' })
    const approvalRequestId = addApprovalRequest(storage, taskId)

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'resume_task' },
      target: { kind: 'task', taskId },
      evidence: [
        { gate: 'design_review', designReviewEvidenceId },
        { gate: 'approval_gate', approvalRequestId },
      ],
    })

    expect(blocked.missingGates).toEqual(['design_review'])
  })

  it('独立レビューを実行していない evidence は independent_review の根拠にならない', () => {
    const { storage, taskId } = seed()
    const designReviewEvidenceId = addDesignReviewEvidence(storage, taskId, {
      independentReviewRequired: false,
    })

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'deploy_production' },
      target: { kind: 'system' },
      evidence: [{ gate: 'independent_review', designReviewEvidenceId }],
    })

    expect(blocked.missingGates).toContain('independent_review')
  })

  it('pending な CEO Approval は充足にならない', () => {
    const { storage, projectId } = seed()
    const approvalId = addCeoApproval(storage, projectId, { status: 'pending' })

    expectBlocked(storage, {
      proposal: { kind: 'restart_service' },
      target: { kind: 'system' },
      evidence: [{ gate: 'ceo_approval', approvalId }],
    })
  })

  it('用途の違う CEO Approval は流用できない', () => {
    const { storage, projectId } = seed()
    const approvalId = addCeoApproval(storage, projectId, { type: 'billing' })

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'restart_service' },
      target: { kind: 'system' },
      evidence: [{ gate: 'ceo_approval', approvalId }],
    })

    expect(blocked.rejectedEvidence.join(' ')).toContain("not 'deployment'")
  })

  it('用途の合う承認済み CEO Approval なら restart_service は通る', () => {
    const { storage, projectId } = seed()
    const approvalId = addCeoApproval(storage, projectId, { type: 'deployment' })

    const { decision } = authorizePlAction(storage, {
      proposal: { kind: 'restart_service' },
      target: { kind: 'system' },
      evidence: [{ gate: 'ceo_approval', approvalId }],
    })

    expect(decision.kind).toBe('restart_service')
  })
})

describe('authorizePlAction — 対象スコープと Review 根拠の対応', () => {
  it('Project 対象では roadmap-kind の Review evidence を束縛できる', () => {
    const { storage, projectId } = seed()
    const evidence = storage.designReviewEvidence.create({
      reviewKind: 'roadmap',
      subjectId: projectId,
      designTextHash: 'hash',
      reviewLoad: 'low',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    } as Parameters<IStorage['designReviewEvidence']['create']>[0])

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'adopt_roadmap_item' },
      target: { kind: 'project', projectId },
      evidence: [{ gate: 'design_review', designReviewEvidenceId: evidence.id }],
    })

    // design_review は束縛できて充足する。残るのは検証手段の無い strategic_alignment_review だけ。
    expect(blocked.missingGates).toEqual(['strategic_alignment_review'])
  })

  it('別 Project の roadmap evidence では束縛できない', () => {
    const { storage, projectId } = seed()
    // running は1つだけという既存の interlock があるので、別 Project は paused で作る。
    const otherProject = storage.projects.create({
      name: 'other',
      goal: 'g',
      designPhilosophy: [],
      status: 'paused',
    })
    const evidence = storage.designReviewEvidence.create({
      reviewKind: 'roadmap',
      subjectId: otherProject.id,
      designTextHash: 'hash',
      reviewLoad: 'low',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    } as Parameters<IStorage['designReviewEvidence']['create']>[0])

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'adopt_roadmap_item' },
      target: { kind: 'project', projectId },
      evidence: [{ gate: 'design_review', designReviewEvidenceId: evidence.id }],
    })

    expect(blocked.missingGates).toContain('design_review')
    expect(blocked.rejectedEvidence.join(' ')).toContain('belongs to another project')
  })

  it('taskId を持つ roadmap-kind evidence では Task 単位の Gate を満たせない', () => {
    const { storage, taskId } = seed()
    const evidence = storage.designReviewEvidence.create({
      taskId,
      reviewKind: 'roadmap',
      subjectId: taskId,
      designTextHash: 'hash',
      reviewLoad: 'low',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    } as Parameters<IStorage['designReviewEvidence']['create']>[0])
    const approvalRequestId = addApprovalRequest(storage, taskId)

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'resume_task' },
      target: { kind: 'task', taskId },
      evidence: [
        { gate: 'design_review', designReviewEvidenceId: evidence.id },
        { gate: 'approval_gate', approvalRequestId },
      ],
    })

    expect(blocked.missingGates).toEqual(['design_review'])
  })

  it('system 対象に Review 根拠を結び付けられないことを黙らせない', () => {
    const { storage, taskId } = seed()
    const designReviewEvidenceId = addDesignReviewEvidence(storage, taskId, {
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'deploy_production' },
      target: { kind: 'system' },
      evidence: [{ gate: 'independent_review', designReviewEvidenceId }],
    })

    expect(blocked.missingGates).toContain('independent_review')
    expect(blocked.rejectedEvidence.join(' ')).toContain('cannot be bound to a system target')
  })
})

describe('authorizePlAction — 検証手段の無い Gate は充足できない', () => {
  it('safety_review を要求する操作は、根拠を積んでも通らない（fail-closed）', () => {
    const { storage, jobId, taskId } = seed()
    const approvalRequestId = addApprovalRequest(storage, taskId)

    const blocked = expectBlocked(storage, {
      proposal: { kind: 'clear_workspace_quarantine' },
      target: { kind: 'job', jobId, taskId },
      evidence: [{ gate: 'approval_gate', approvalRequestId }],
    })

    expect(blocked.missingGates).toEqual(['safety_review'])
  })

  it('検証できない Gate の一覧が明示されている', () => {
    expect(UNVERIFIABLE_GATES).toContain('safety_review')
    expect(UNVERIFIABLE_GATES).toContain('strategic_alignment_review')
  })
})
