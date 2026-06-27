import { beforeEach, describe, expect, it } from 'vitest'
import { createSQLiteStorage } from './sqlite'
import type { IStorage } from './interface'

type ApprovalCreateInput = Parameters<IStorage['approvals']['create']>[0] & { projectId: string }

describe('SQLiteStorage', () => {
  let storage: IStorage

  beforeEach(() => {
    storage = createSQLiteStorage(':memory:')
  })

  describe('projects', () => {
    it('creates and finds a project by id', () => {
      const project = storage.projects.create({
        name: 'Test Project',
        goal: 'Test goal',
        designPhilosophy: [],
        status: 'draft',
      })

      expect(project.id).toBeTruthy()
      expect(storage.projects.findById(project.id)?.name).toBe('Test Project')
    })

    it('finds all projects', () => {
      storage.projects.create({ name: 'A', goal: 'a', designPhilosophy: [], status: 'draft' })
      storage.projects.create({ name: 'B', goal: 'b', designPhilosophy: [], status: 'draft' })

      expect(storage.projects.findAll()).toHaveLength(2)
    })

    it('updates a project', () => {
      const project = storage.projects.create({
        name: 'Old',
        goal: 'x',
        designPhilosophy: [],
        status: 'draft',
      })

      const updated = storage.projects.update(project.id, { name: 'New' })

      expect(updated?.name).toBe('New')
      expect(storage.projects.findById(project.id)?.name).toBe('New')
    })

    it('returns undefined when updating a missing project', () => {
      expect(storage.projects.update('not-exist', { name: 'x' })).toBeUndefined()
    })
  })

  describe('tasks', () => {
    let projectId: string

    beforeEach(() => {
      projectId = storage.projects.create({
        name: 'P',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      }).id
    })

    it('creates and finds tasks by project id', () => {
      storage.tasks.create({
        projectId,
        title: 'Task 1',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        dependencies: [],
      })

      const tasks = storage.tasks.findByProjectId(projectId)

      expect(tasks).toHaveLength(1)
      expect(tasks[0].title).toBe('Task 1')
    })

    it('serializes and deserializes provider and path fields', () => {
      const task = storage.tasks.create({
        projectId,
        title: 'T',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        provider: 'codex',
        dependencies: [],
        allowedPaths: ['apps/api/src/storage/'],
        forbiddenPaths: ['.env'],
        acceptanceCriteria: ['typecheck passes'],
        expectedOutputs: ['sqlite.test.ts'],
      })

      const found = storage.tasks.findById(task.id)

      expect(found?.provider).toBe('codex')
      expect(found?.allowedPaths).toEqual(['apps/api/src/storage/'])
      expect(found?.forbiddenPaths).toEqual(['.env'])
      expect(found?.acceptanceCriteria).toEqual(['typecheck passes'])
      expect(found?.expectedOutputs).toEqual(['sqlite.test.ts'])
    })

    it('updates provider and path fields', () => {
      const task = storage.tasks.create({
        projectId,
        title: 'T',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        dependencies: [],
      })

      storage.tasks.update(task.id, {
        provider: 'claude_code',
        allowedPaths: ['target-project/'],
      })

      const found = storage.tasks.findById(task.id)

      expect(found?.provider).toBe('claude_code')
      expect(found?.allowedPaths).toEqual(['target-project/'])
    })
  })

  describe('jobs', () => {
    let projectId: string
    let taskId: string

    beforeEach(() => {
      projectId = storage.projects.create({
        name: 'P',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      }).id
      taskId = storage.tasks.create({
        projectId,
        title: 'T',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        dependencies: [],
      }).id
    })

    it('creates and finds jobs by task id', () => {
      storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })

      const jobs = storage.jobs.findByTaskId(taskId)

      expect(jobs).toHaveLength(1)
      expect(jobs[0].safeCommand.kind).toBe('git_status')
    })

    it('serializes and deserializes safeCommand', () => {
      const job = storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: {
          kind: 'git_commit',
          params: { commitMessage: 'test commit', agentPrefix: '[codex task-018]' },
          workingDir: '/workspace/target',
        },
      })

      const found = storage.jobs.findById(job.id)

      expect(found?.safeCommand.kind).toBe('git_commit')
      expect(found?.safeCommand.params?.commitMessage).toBe('test commit')
    })

    it('updates job result fields', () => {
      const job = storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })

      storage.jobs.update(job.id, {
        status: 'success',
        exitCode: 0,
        stdout: 'preview stdout',
        stderr: 'preview stderr',
        stdoutPath: '/workspace/target/data/logs/job-1/stdout.txt',
        stderrPath: '/workspace/target/data/logs/job-1/stderr.txt',
        changedFiles: ['apps/api/src/storage/sqlite.ts'],
        guardResult: {
          permissionAllowed: true,
          fileChangeAllowed: true,
        },
        approvalId: 'approval-1',
      })

      const found = storage.jobs.findById(job.id)

      expect(found?.status).toBe('success')
      expect(found?.exitCode).toBe(0)
      expect(found?.stdout).toBe('preview stdout')
      expect(found?.stderr).toBe('preview stderr')
      expect(found?.stdoutPath).toBe('/workspace/target/data/logs/job-1/stdout.txt')
      expect(found?.stderrPath).toBe('/workspace/target/data/logs/job-1/stderr.txt')
      expect(found?.changedFiles).toEqual(['apps/api/src/storage/sqlite.ts'])
      expect(found?.guardResult?.permissionAllowed).toBe(true)
      expect(found?.approvalId).toBe('approval-1')
    })
  })

  describe('approvals', () => {
    let projectId: string

    beforeEach(() => {
      projectId = storage.projects.create({
        name: 'P',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      }).id
    })

    it('creates and finds pending approvals by project id', () => {
      const approval: ApprovalCreateInput = {
        projectId,
        title: 'External service',
        reason: 'Need an external service',
        type: 'external_service',
        status: 'pending',
      }

      storage.approvals.create(approval)

      expect(storage.approvals.findPendingByProjectId(projectId)).toHaveLength(1)
    })

    it('excludes approved approvals from pending results', () => {
      const approval = storage.approvals.create({
        projectId,
        title: 'test',
        reason: 'r',
        type: 'external_service',
        status: 'pending',
      } as ApprovalCreateInput)

      storage.approvals.update(approval.id, { status: 'approved' })

      expect(storage.approvals.findPendingByProjectId(projectId)).toHaveLength(0)
    })
  })

  describe('approvalRequests', () => {
    const BASE = {
      taskId: 'task-001',
      targetBranch: 'feat/x',
      targetCommit: 'abc123',
      targetDiffHash: 'deadbeef',
      riskLevel: 'HIGH' as const,
      requestedAction: 'merge',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      invalidIf: [],
    }

    it('expiresAt 超過 → updateStatus で EXPIRED に遷移し、reason/reviewedAt が保持される', () => {
      // APPROVED + reason + reviewedAt を持つリクエストを作成
      const req = storage.approvalRequests.create({ ...BASE, status: 'WAITING_FOR_USER' })
      // CEO が承認（reason/reviewedAt をセット）
      storage.approvalRequests.updateStatus(req.id, 'APPROVED', 'CEO承認メモ')

      const approved = storage.approvalRequests.findById(req.id)
      expect(approved?.status).toBe('APPROVED')
      expect(approved?.reason).toBe('CEO承認メモ')
      expect(approved?.reviewedAt).toBeTruthy()
      const savedReviewedAt = approved?.reviewedAt

      // expiresAt を過去に書き換えて「超過」状態を再現
      const pastExpiry = new Date(Date.now() - 1000).toISOString()
      storage.approvalRequests.updateStatus(req.id, 'APPROVED', undefined, true) // no-op で保持確認後…
      // DB を直接更新して expiresAt を過去に設定
      // createSQLiteStorage は内部で better-sqlite3 を使うが、
      // テストから db 参照はないため storage.approvalRequests.create で別リクエストを作り
      // updateStatus(EXPIRED, preserveReviewMeta=true) で遷移を検証する
      const req2 = storage.approvalRequests.create({
        ...BASE,
        expiresAt: pastExpiry,
        status: 'WAITING_FOR_USER',
      })
      storage.approvalRequests.updateStatus(req2.id, 'APPROVED', 'CEOメモ2')
      const approved2 = storage.approvalRequests.findById(req2.id)
      const savedAt2 = approved2?.reviewedAt

      // consume 相当: expiresAt 超過を検知して EXPIRED に遷移（preserveReviewMeta=true）
      const expired = storage.approvalRequests.updateStatus(req2.id, 'EXPIRED', undefined, true)

      expect(expired?.status).toBe('EXPIRED')
      // reason / reviewedAt が保持されていること
      expect(expired?.reason).toBe('CEOメモ2')
      expect(expired?.reviewedAt).toBe(savedAt2)
    })

    it('expiresAt 超過リクエストは findActiveByTaskId に出ない（EXPIRED は active 外）', () => {
      const pastExpiry = new Date(Date.now() - 1000).toISOString()
      const req = storage.approvalRequests.create({
        ...BASE,
        expiresAt: pastExpiry,
        status: 'WAITING_FOR_USER',
      })
      storage.approvalRequests.updateStatus(req.id, 'APPROVED', undefined)
      storage.approvalRequests.updateStatus(req.id, 'EXPIRED', undefined, true)

      const active = storage.approvalRequests.findActiveByTaskId('task-001')
      expect(active).toBeUndefined()
    })

    it('APPROVED → EXPIRED 遷移で reviewedAt が NULL の場合も NULL のまま保持される', () => {
      // reviewedAt=NULL を再現するため: WAITING_FOR_USER で作成し、
      // updateStatus で preserveReviewMeta=true のまま APPROVED に遷移
      // （APPROVED 遷移で reason/reviewedAt を設定した後、NULL に戻す手段はないが、
      //  preserveReviewMeta=true の APPROVED→EXPIRED パスを検証する）
      const req = storage.approvalRequests.create({ ...BASE, status: 'WAITING_FOR_USER' })
      // preserveReviewMeta=true で APPROVED: reviewedAt は existing.reviewedAt (null) のまま
      const approved = storage.approvalRequests.updateStatus(req.id, 'APPROVED', undefined, true)
      expect(approved?.reviewedAt).toBeUndefined()

      const expired = storage.approvalRequests.updateStatus(req.id, 'EXPIRED', undefined, true)
      expect(expired?.status).toBe('EXPIRED')
      // NULL のまま保持
      expect(expired?.reviewedAt).toBeUndefined()
    })
  })
})
