import { describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { buildSystemState } from '../state/systemState'
import { abortTask } from './abortTask'

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

interface Fixture {
  storage: IStorage
  projectId: string
  taskId: string
}

/** roadmapActive な pending Task に blocked Job が1本ある状態（production の 6f8b41ef と同じ形）。 */
function seed(): Fixture {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id, title: 'stuck one', description: 'd', status: 'pending',
    assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1,
    roadmapTaskKey: 'some-item', allowedPaths: ['apps/api/src/pl'], acceptanceCriteria: ['x'],
  } as Parameters<IStorage['tasks']['create']>[0])
  storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
  } as Parameters<IStorage['jobs']['create']>[0])
  return { storage, projectId: project.id, taskId: task.id }
}

function approve(storage: IStorage, taskId: string): string {
  const request = storage.approvalRequests.create({
    taskId, requestedAction: 'abort', riskLevel: 'HIGH',
    targetBranch: 'ai/park', targetCommit: 'c', targetDiffHash: 'd',
    changedFiles: [], triggeredRules: [], invalidIf: ['commit changes'],
    status: 'WAITING_FOR_USER', expiresAt: FUTURE,
  } as Parameters<IStorage['approvalRequests']['create']>[0])
  storage.approvalRequests.updateStatus(request.id, 'APPROVED')
  return request.id
}

describe('abortTask — CEO 承認済みの park', () => {
  it('承認があれば park できる。status は変えず Job 履歴も残す', () => {
    const { storage, taskId } = seed()
    const approvalRequestId = approve(storage, taskId)

    const result = abortTask(storage, { taskId, approvalRequestId, reason: '別の項目を先に進める' })

    expect(result).toMatchObject({ ok: true })
    const task = storage.tasks.findById(taskId)
    // **done にしない。** 受入条件を満たしたと読める状態にしてはならない。
    expect(task?.status).toBe('pending')
    expect(task?.roadmapActive).toBe(false)
    // Job 履歴はそのまま。Mobile / audit から事実が消えない。
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(1)
    expect(storage.jobs.findByTaskId(taskId)[0]?.status).toBe('blocked')
  })

  it('承認が無ければ park しない', () => {
    const { storage, taskId } = seed()

    const result = abortTask(storage, { taskId, approvalRequestId: 'no-such-approval', reason: 'r' })

    expect(result).toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })
    expect(storage.tasks.findById(taskId)?.roadmapActive).toBe(true)
  })

  it('承認が WAITING のままなら park しない', () => {
    const { storage, taskId } = seed()
    const request = storage.approvalRequests.create({
      taskId, requestedAction: 'abort', riskLevel: 'HIGH',
      targetBranch: 'ai/park', targetCommit: 'c', targetDiffHash: 'd',
      changedFiles: [], triggeredRules: [], invalidIf: ['commit changes'],
      status: 'WAITING_FOR_USER', expiresAt: FUTURE,
    } as Parameters<IStorage['approvalRequests']['create']>[0])

    const result = abortTask(storage, { taskId, approvalRequestId: request.id, reason: 'r' })

    expect(result).toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })
    expect(storage.tasks.findById(taskId)?.roadmapActive).toBe(true)
  })

  it('別 Task の承認は流用できない', () => {
    const { storage, projectId, taskId } = seed()
    const other = storage.tasks.create({
      projectId, title: 'other', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    const approvalRequestId = approve(storage, other.id)

    const result = abortTask(storage, { taskId, approvalRequestId, reason: 'r' })

    expect(result).toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })
    expect(storage.tasks.findById(taskId)?.roadmapActive).toBe(true)
  })

  it('live Job があれば fail-closed で拒否する（Worker は roadmapActive を見ずに claim する）', () => {
    const { storage, projectId, taskId } = seed()
    storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'queued',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    const approvalRequestId = approve(storage, taskId)

    const result = abortTask(storage, { taskId, approvalRequestId, reason: 'r' })

    expect(result).toMatchObject({ ok: false, code: 'LIVE_JOB_PRESENT' })
    expect(storage.tasks.findById(taskId)?.roadmapActive).toBe(true)
  })

  it('done な Task は park しない', () => {
    const { storage, taskId } = seed()
    storage.tasks.update(taskId, { status: 'done' })
    const approvalRequestId = approve(storage, taskId)

    expect(abortTask(storage, { taskId, approvalRequestId, reason: 'r' }))
      .toMatchObject({ ok: false, code: 'TASK_ALREADY_DONE' })
  })

  it('pending 以外は park しない（半分だけ効く操作にしない）', () => {
    const { storage, taskId } = seed()
    storage.tasks.update(taskId, { status: 'blocked' })
    const approvalRequestId = approve(storage, taskId)

    const result = abortTask(storage, { taskId, approvalRequestId, reason: 'r' })

    expect(result).toMatchObject({ ok: false, code: 'TASK_NOT_PARKABLE' })
    if (result.ok) return
    expect(result.reason).toContain('resume / fail-stuck-job')
  })

  it('誰が・なぜ park したかを audit へ残す', () => {
    const { storage, taskId } = seed()
    const approvalRequestId = approve(storage, taskId)

    abortTask(storage, { taskId, approvalRequestId, reason: '先に別項目を進めるため', actor: 'ceo' })

    const entries = storage.auditLog.findByEntity('task', taskId)
      .filter((entry) => entry.operation === 'task_aborted')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.detail).toContain('先に別項目を進めるため')
    expect(entries[0]?.detail).toContain('ceo')
    expect(entries[0]?.detail).toContain('status kept as pending')
  })

  it('follow-up Task を作らない（残作業の再開は #233 の責務）', () => {
    const { storage, projectId, taskId } = seed()
    const approvalRequestId = approve(storage, taskId)

    abortTask(storage, { taskId, approvalRequestId, reason: 'r' })

    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(1)
  })
})

describe('abortTask — park した Task が PL を止めなくなる', () => {
  it('currentTask から外れ、blocked Job の attention も出なくなる', () => {
    const { storage, projectId, taskId } = seed()

    const before = buildSystemState(storage)
    const beforeProject = before.projects.find((p) => p.id === projectId)
    expect(beforeProject?.currentTask?.id).toBe(taskId)
    expect(before.attention.some((item) => item.kind === 'job_blocked' && item.taskId === taskId)).toBe(true)

    abortTask(storage, { taskId, approvalRequestId: approve(storage, taskId), reason: 'r' })

    const after = buildSystemState(storage)
    const afterProject = after.projects.find((p) => p.id === projectId)
    // PL の「現在の仕事」から外れる。
    expect(afterProject?.currentTask).toBeUndefined()
    // 履歴由来の attention で PL 全体を止めない。
    expect(after.attention.some((item) => item.kind === 'job_blocked' && item.taskId === taskId)).toBe(false)
    // **Job 自体は消えていない。** 事実は Mobile からも audit からも辿れる。
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(1)
  })
})

describe('abortTask — sync が park を取り消さない', () => {
  const spec = (key: string) => ({
    roadmapTaskKey: key, title: 'stuck one', description: 'd', phase: 1,
    assignee: 'developer_ai' as const, category: 'implementation' as const, dependencies: [],
    acceptanceCriteria: ['x'], allowedPaths: ['apps/api/src/pl'],
  })

  it('park した Task は後続 sync で再活性化されない', () => {
    const { storage, projectId, taskId } = seed()
    abortTask(storage, { taskId, approvalRequestId: approve(storage, taskId), reason: 'r' })

    const result = storage.tasks.syncRoadmapTasks({
      projectId,
      tasks: [spec('some-item')],
      phases: [{ phaseNumber: 1, name: 'p', goal: 'g' }],
    })

    expect(result.ok).toBe(true)
    expect(result.reactivatedTaskIds).not.toContain(taskId)
    expect(storage.tasks.findById(taskId)?.roadmapActive).toBe(false)
  })

  it('park されていない非活性 Task の既存再活性化は変えていない', () => {
    const { storage, projectId, taskId } = seed()
    // abort を経ずに非活性化された（sync が落とした）Task。
    storage.tasks.update(taskId, { roadmapActive: false })

    const result = storage.tasks.syncRoadmapTasks({
      projectId,
      tasks: [spec('some-item')],
      phases: [{ phaseNumber: 1, name: 'p', goal: 'g' }],
    })

    expect(result.ok).toBe(true)
    expect(result.reactivatedTaskIds).toContain(taskId)
    expect(storage.tasks.findById(taskId)?.roadmapActive).toBe(true)
  })
})
