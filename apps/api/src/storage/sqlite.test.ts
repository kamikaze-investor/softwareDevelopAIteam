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
})
