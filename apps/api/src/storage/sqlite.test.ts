import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createSQLiteStorage, SingleRunningProjectError } from './sqlite'
import { CREATE_TABLES } from './schema'
import { validateRoadmapTasks } from './roadmapTaskValidation'
import type { IStorage, RoadmapSyncTaskInput, RoadmapTaskSpecConflict } from './interface'
import type { JobStatus, PersistedTaskFailureExplanationV1, Task } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'

type ApprovalCreateInput = Parameters<IStorage['approvals']['create']>[0] & { projectId: string }
type TaskCreateInput = Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'roadmapActive'> & {
  roadmapActive?: boolean
}

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

    it('rejects a second running project with SingleRunningProjectError', () => {
      storage.projects.create({
        name: 'Running',
        goal: 'g',
        designPhilosophy: [],
        status: 'running',
      })

      expect(() => {
        storage.projects.create({
          name: 'Second running',
          goal: 'g',
          designPhilosophy: [],
          status: 'running',
        })
      }).toThrow(SingleRunningProjectError)
    })

    it('findRunning returns the running project or undefined', () => {
      expect(storage.projects.findRunning()).toBeUndefined()

      storage.projects.create({
        name: 'Draft',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      })
      const running = storage.projects.create({
        name: 'Running',
        goal: 'g',
        designPhilosophy: [],
        status: 'running',
      })

      expect(storage.projects.findRunning()?.id).toBe(running.id)

      storage.projects.update(running.id, { status: 'paused' })

      expect(storage.projects.findRunning()).toBeUndefined()
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

    function createTask(overrides: Partial<TaskCreateInput> = {}) {
      return storage.tasks.create({
        projectId,
        title: 'T',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        dependencies: [],
        ...overrides,
      })
    }

    function roadmapTask(
      roadmapTaskKey: string,
      overrides: Partial<RoadmapSyncTaskInput> = {},
    ): RoadmapSyncTaskInput {
      return {
        roadmapTaskKey,
        title: `Roadmap ${roadmapTaskKey}`,
        description: `Description ${roadmapTaskKey}`,
        phase: 1,
        assignee: 'developer_ai',
        dependencies: [],
        acceptanceCriteria: [`Done ${roadmapTaskKey}`],
        allowedPaths: [`src/${roadmapTaskKey}`],
        ...overrides,
      }
    }

    function createJob(taskId: string, status: JobStatus) {
      return storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status,
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })
    }

    function createRoadmapTaskRecord(
      input: RoadmapSyncTaskInput,
      overrides: Partial<TaskCreateInput> = {},
    ): Task {
      return createTask({
        title: input.title,
        description: input.description,
        status: 'pending',
        assignee: input.assignee,
        dependencies: [],
        allowedPaths: input.allowedPaths,
        acceptanceCriteria: input.acceptanceCriteria,
        roadmapTaskKey: input.roadmapTaskKey,
        phase: input.phase,
        roadmapActive: true,
        ...overrides,
      })
    }

    function expectConflict(
      result: ReturnType<IStorage['tasks']['syncRoadmapTasks']>,
      roadmapTaskKey: string,
      field: RoadmapTaskSpecConflict['field'],
    ): void {
      expect(result.ok).toBe(false)
      expect(result.conflicts).toContainEqual({ roadmapTaskKey, field })
    }

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

    it('creates roadmap columns in a new database and persists roadmap fields', () => {
      const dbPath = path.join(os.tmpdir(), `ai-team-roadmap-task-${randomUUID()}.db`)
      const fileStorage = createSQLiteStorage(dbPath)
      const db = new Database(dbPath, { readonly: true })

      try {
        const columns = new Map(
          (db.pragma('table_info(tasks)') as Array<{
            name: string
            type: string
            notnull: number
            dflt_value: string | null
          }>).map((column) => [column.name, column]),
        )

        expect(columns.get('roadmap_task_key')?.type).toBe('TEXT')
        expect(columns.get('phase')?.type).toBe('INTEGER')
        expect(columns.get('roadmap_active')?.type).toBe('INTEGER')
        expect(columns.get('roadmap_active')?.notnull).toBe(1)
        expect(columns.get('roadmap_active')?.dflt_value).toBe('0')
      } finally {
        db.close()
      }

      const project = fileStorage.projects.create({
        name: 'Roadmap Project',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      })
      const task = fileStorage.tasks.create({
        projectId: project.id,
        title: 'Roadmap task',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        dependencies: [],
        roadmapTaskKey: 'task-001',
        phase: 1,
        roadmapActive: true,
      })

      const found = fileStorage.tasks.findById(task.id)

      expect(found?.roadmapTaskKey).toBe('task-001')
      expect(found?.phase).toBe(1)
      expect(found?.roadmapActive).toBe(true)
    })

    it('defaults roadmapActive to false when it is omitted', () => {
      const task = createTask({ title: 'Manual task' })
      const found = storage.tasks.findById(task.id)

      expect(task.roadmapActive).toBe(false)
      expect(found?.roadmapActive).toBe(false)
    })

    it('rejects duplicate roadmapTaskKey values in the same project', () => {
      createTask({ roadmapTaskKey: 'task-001', phase: 1, roadmapActive: true })

      expect(() => {
        createTask({ title: 'Duplicate roadmap task', roadmapTaskKey: 'task-001', phase: 2, roadmapActive: true })
      }).toThrow()
    })

    it('allows the same roadmapTaskKey in different projects', () => {
      const otherProjectId = storage.projects.create({
        name: 'Other',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      }).id

      const first = createTask({ roadmapTaskKey: 'task-001', phase: 1, roadmapActive: true })
      const second = storage.tasks.create({
        projectId: otherProjectId,
        title: 'Same roadmap key',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        dependencies: [],
        roadmapTaskKey: 'task-001',
        phase: 1,
        roadmapActive: true,
      })

      expect(first.roadmapTaskKey).toBe(second.roadmapTaskKey)
      expect(first.projectId).not.toBe(second.projectId)
    })

    it('allows multiple NULL roadmapTaskKey tasks in the same project', () => {
      createTask({ title: 'Manual task 1' })
      createTask({ title: 'Manual task 2' })

      const tasks = storage.tasks.findByProjectId(projectId)

      expect(tasks).toHaveLength(2)
      expect(tasks.map((task) => task.roadmapTaskKey)).toEqual([undefined, undefined])
    })

    it('updates phase and roadmapActive fields', () => {
      const task = createTask({ roadmapTaskKey: 'task-001', phase: 1, roadmapActive: false })

      storage.tasks.update(task.id, { phase: 2, roadmapActive: true })

      const found = storage.tasks.findById(task.id)
      expect(found?.phase).toBe(2)
      expect(found?.roadmapActive).toBe(true)
    })

    it('keeps roadmapActive when updating other fields without specifying it', () => {
      const task = createTask({ roadmapTaskKey: 'task-001', phase: 1, roadmapActive: true })

      // roadmapActive を渡さない部分更新で、既存の true が暗黙に false へ落ちないこと
      storage.tasks.update(task.id, { title: 'updated title' })

      const found = storage.tasks.findById(task.id)
      expect(found?.title).toBe('updated title')
      expect(found?.roadmapActive).toBe(true)
      expect(found?.phase).toBe(1)
      expect(found?.roadmapTaskKey).toBe('task-001')
    })

    it('syncRoadmapTasks creates tasks from a new roadmap', () => {
      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [
          roadmapTask('task-001', { phase: 1 }),
          roadmapTask('task-002', { phase: 2, dependencies: ['task-001'] }),
        ],
      })

      expect(result.ok).toBe(true)
      expect(result.createdTaskIds).toHaveLength(2)

      const syncedTasks = storage.tasks.findByProjectId(projectId)
      const first = syncedTasks.find((task) => task.roadmapTaskKey === 'task-001')
      const second = syncedTasks.find((task) => task.roadmapTaskKey === 'task-002')

      expect(first).toMatchObject({
        roadmapActive: true,
        phase: 1,
        title: 'Roadmap task-001',
        status: 'pending',
      })
      expect(first?.allowedPaths).toEqual(['src/task-001'])
      expect(first?.acceptanceCriteria).toEqual(['Done task-001'])
      expect(second?.phase).toBe(2)
      expect(second?.dependencies).toEqual([first?.id])
    })

    it('syncRoadmapTasks is idempotent for identical input', () => {
      const input = [roadmapTask('task-001')]
      const first = storage.tasks.syncRoadmapTasks({ projectId, tasks: input })
      const firstTask = storage.tasks.findByProjectId(projectId)[0]

      const second = storage.tasks.syncRoadmapTasks({ projectId, tasks: input })
      const tasksAfterSecondRun = storage.tasks.findByProjectId(projectId)

      expect(first.ok).toBe(true)
      expect(first.createdTaskIds).toHaveLength(1)
      expect(second.ok).toBe(true)
      expect(second.createdTaskIds).toEqual([])
      expect(tasksAfterSecondRun).toHaveLength(1)
      expect(tasksAfterSecondRun[0].id).toBe(firstTask.id)
    })

    it('syncRoadmapTasks allows the same roadmapTaskKey in another project', () => {
      const otherProjectId = storage.projects.create({
        name: 'Other roadmap project',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      }).id

      const first = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [roadmapTask('task-001')],
      })
      const second = storage.tasks.syncRoadmapTasks({
        projectId: otherProjectId,
        tasks: [roadmapTask('task-001')],
      })

      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      expect(storage.tasks.findByProjectId(projectId)).toHaveLength(1)
      expect(storage.tasks.findByProjectId(otherProjectId)).toHaveLength(1)
      expect(storage.tasks.findByProjectId(projectId)[0].id).not.toBe(
        storage.tasks.findByProjectId(otherProjectId)[0].id,
      )
    })

    it('syncRoadmapTasks resolves dependencies within the same project only', () => {
      const otherProjectId = storage.projects.create({
        name: 'Other dependency project',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      }).id
      storage.tasks.syncRoadmapTasks({
        projectId: otherProjectId,
        tasks: [roadmapTask('task-001', { title: 'Other task' })],
      })
      const otherTask = storage.tasks.findByProjectId(otherProjectId)[0]

      storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [
          roadmapTask('task-001', { title: 'Main task' }),
          roadmapTask('task-002', { dependencies: ['task-001'] }),
        ],
      })

      const projectTasks = storage.tasks.findByProjectId(projectId)
      const mainDependency = projectTasks.find((task) => task.roadmapTaskKey === 'task-001')
      const dependent = projectTasks.find((task) => task.roadmapTaskKey === 'task-002')

      expect(dependent?.dependencies).toEqual([mainDependency?.id])
      expect(dependent?.dependencies).not.toEqual([otherTask.id])
    })

    it('syncRoadmapTasks leaves the database unchanged when validation requires DB state', () => {
      const removed = createTask({
        roadmapTaskKey: 'task-001',
        phase: 1,
        roadmapActive: true,
      })
      createJob(removed.id, 'queued')
      createTask({
        roadmapTaskKey: 'task-002',
        title: 'Keep old title',
        phase: 1,
        roadmapActive: true,
      })
      const beforeTasks = storage.tasks.findByProjectId(projectId)
      const beforeJobs = storage.jobs.findByTaskId(removed.id)

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [
          roadmapTask('task-002', { title: 'Changed title' }),
          roadmapTask('task-003'),
        ],
      })

      expect(result.ok).toBe(false)
      expect(storage.tasks.findByProjectId(projectId)).toEqual(beforeTasks)
      expect(storage.jobs.findByTaskId(removed.id)).toEqual(beforeJobs)
    })

    it('syncRoadmapTasks updates specification fields and dependencies for unstarted tasks only', () => {
      const oldDependency = createTask({
        roadmapTaskKey: 'task-old',
        title: 'Old dependency',
        phase: 1,
        roadmapActive: true,
      })
      const newDependencyInput = roadmapTask('task-new')
      const newDependency = createRoadmapTaskRecord(newDependencyInput)
      const existing = createTask({
        roadmapTaskKey: 'task-001',
        title: 'Old title',
        description: 'Old description',
        phase: 1,
        roadmapActive: true,
        dependencies: [oldDependency.id],
        allowedPaths: ['old/path'],
        acceptanceCriteria: ['old criteria'],
      })

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [
          newDependencyInput,
          roadmapTask('task-001', {
            title: 'New title',
            description: 'New description',
            phase: 2,
            dependencies: ['task-new'],
            allowedPaths: ['new/path'],
            acceptanceCriteria: ['new criteria'],
          }),
        ],
      })

      const updated = storage.tasks.findById(existing.id)
      expect(result.ok).toBe(true)
      expect(result.updatedTaskIds).toEqual([existing.id])
      expect(updated?.title).toBe('New title')
      expect(updated?.description).toBe('New description')
      expect(updated?.phase).toBe(2)
      expect(updated?.dependencies).toEqual([newDependency.id])
      expect(updated?.allowedPaths).toEqual(['new/path'])
      expect(updated?.acceptanceCriteria).toEqual(['new criteria'])
    })

    it.each([
      {
        field: 'title' as const,
        changedInput: (input: RoadmapSyncTaskInput): RoadmapSyncTaskInput => ({
          ...input,
          title: 'Changed title',
        }),
      },
      {
        field: 'description' as const,
        changedInput: (input: RoadmapSyncTaskInput): RoadmapSyncTaskInput => ({
          ...input,
          description: 'Changed description',
        }),
      },
      {
        field: 'phase' as const,
        changedInput: (input: RoadmapSyncTaskInput): RoadmapSyncTaskInput => ({
          ...input,
          phase: 2,
        }),
      },
      {
        field: 'assignee' as const,
        changedInput: (input: RoadmapSyncTaskInput): RoadmapSyncTaskInput => ({
          ...input,
          assignee: 'reviewer_ai',
        }),
      },
      {
        field: 'allowedPaths' as const,
        changedInput: (input: RoadmapSyncTaskInput): RoadmapSyncTaskInput => ({
          ...input,
          allowedPaths: ['changed/path'],
        }),
      },
      {
        field: 'acceptanceCriteria' as const,
        changedInput: (input: RoadmapSyncTaskInput): RoadmapSyncTaskInput => ({
          ...input,
          acceptanceCriteria: ['Changed criteria'],
        }),
      },
    ])('syncRoadmapTasks rejects $field changes for tasks with job history', ({ field, changedInput }) => {
      const input = roadmapTask('task-001')
      const existing = createRoadmapTaskRecord(input)
      createJob(existing.id, 'success')
      const beforeTasks = storage.tasks.findByProjectId(projectId)

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [changedInput(input)],
      })

      expectConflict(result, 'task-001', field)
      expect(storage.tasks.findByProjectId(projectId)).toEqual(beforeTasks)
    })

    it('syncRoadmapTasks rejects spec changes for non-pending tasks without job history', () => {
      const input = roadmapTask('task-001')
      createRoadmapTaskRecord(input, { status: 'in_progress' })
      const beforeTasks = storage.tasks.findByProjectId(projectId)

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [roadmapTask('task-001', { title: 'Changed title' })],
      })

      expectConflict(result, 'task-001', 'title')
      expect(storage.tasks.findByProjectId(projectId)).toEqual(beforeTasks)
    })

    it('syncRoadmapTasks rejects dependency changes for tasks with job history', () => {
      const dependencyInput = roadmapTask('task-000')
      const dependency = createRoadmapTaskRecord(dependencyInput)
      const input = roadmapTask('task-001', { dependencies: ['task-000'] })
      const existing = createRoadmapTaskRecord(input, { dependencies: [dependency.id] })
      createJob(existing.id, 'success')
      const beforeTasks = storage.tasks.findByProjectId(projectId)

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [
          dependencyInput,
          roadmapTask('task-001', { dependencies: [] }),
        ],
      })

      expectConflict(result, 'task-001', 'dependencies')
      expect(storage.tasks.findByProjectId(projectId)).toEqual(beforeTasks)
    })

    it('syncRoadmapTasks ignores order-only differences for locked task array fields', () => {
      const firstDependencyInput = roadmapTask('task-001')
      const secondDependencyInput = roadmapTask('task-002')
      const firstDependency = createRoadmapTaskRecord(firstDependencyInput)
      const secondDependency = createRoadmapTaskRecord(secondDependencyInput)
      const lockedInput = roadmapTask('task-003', {
        allowedPaths: ['apps/api/src/a.ts', 'apps/api/src/b.ts'],
        acceptanceCriteria: ['First criterion', 'Second criterion'],
        dependencies: ['task-001', 'task-002'],
      })
      const locked = createRoadmapTaskRecord(lockedInput, {
        allowedPaths: ['apps/api/src/b.ts', 'apps/api/src/a.ts'],
        acceptanceCriteria: ['Second criterion', 'First criterion'],
        dependencies: [secondDependency.id, firstDependency.id],
      })
      createJob(locked.id, 'success')
      const beforeTasks = storage.tasks.findByProjectId(projectId)

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [
          firstDependencyInput,
          secondDependencyInput,
          lockedInput,
        ],
      })

      expect(result.ok).toBe(true)
      expect(result.createdTaskIds).toEqual([])
      expect(result.updatedTaskIds).toEqual([])
      expect(result.reactivatedTaskIds).toEqual([])
      expect(result.deactivatedTaskIds).toEqual([])
      expect(storage.tasks.findByProjectId(projectId)).toEqual(beforeTasks)
    })

    it('syncRoadmapTasks rejects locked dependencies that cannot resolve to project roadmapTaskKey values', () => {
      const manualDependency = createTask({
        title: 'Manual dependency',
        roadmapActive: false,
      })
      const input = roadmapTask('task-001')
      const existing = createRoadmapTaskRecord(input, { dependencies: [manualDependency.id] })
      createJob(existing.id, 'success')
      const beforeTasks = storage.tasks.findByProjectId(projectId)

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [input],
      })

      expectConflict(result, 'task-001', 'dependencies')
      expect(storage.tasks.findByProjectId(projectId)).toEqual(beforeTasks)
    })

    it('syncRoadmapTasks leaves every task unchanged when a locked task conflicts', () => {
      const lockedInput = roadmapTask('task-001')
      const locked = createRoadmapTaskRecord(lockedInput)
      createJob(locked.id, 'success')
      const retainedInput = roadmapTask('task-002')
      createRoadmapTaskRecord(retainedInput, { title: 'Retained old title' })
      const beforeTasks = storage.tasks.findByProjectId(projectId)

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [
          roadmapTask('task-001', { title: 'Changed title' }),
          roadmapTask('task-002', { title: 'Retained new title' }),
          roadmapTask('task-003'),
        ],
      })

      expectConflict(result, 'task-001', 'title')
      expect(storage.tasks.findByProjectId(projectId)).toEqual(beforeTasks)
    })

    it('syncRoadmapTasks syncs locked tasks when specifications match exactly', () => {
      const input = roadmapTask('task-001')
      const existing = createRoadmapTaskRecord(input)
      createJob(existing.id, 'success')
      const before = storage.tasks.findById(existing.id)

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [input],
      })

      expect(result.ok).toBe(true)
      expect(result.conflicts).toBeUndefined()
      expect(result.createdTaskIds).toEqual([])
      expect(result.updatedTaskIds).toEqual([])
      expect(result.reactivatedTaskIds).toEqual([])
      expect(storage.tasks.findById(existing.id)).toEqual(before)
    })

    it('syncRoadmapTasks reactivates inactive locked tasks when specifications match exactly', () => {
      const input = roadmapTask('task-001')
      const existing = createRoadmapTaskRecord(input, { roadmapActive: false })
      createJob(existing.id, 'success')

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [input],
      })

      expect(result.ok).toBe(true)
      expect(result.reactivatedTaskIds).toEqual([existing.id])
      expect(storage.tasks.findById(existing.id)).toMatchObject({
        title: input.title,
        phase: input.phase,
        roadmapActive: true,
      })
    })

    it('syncRoadmapTasks deactivates disappeared tasks without changing phase', () => {
      const removed = createTask({
        roadmapTaskKey: 'task-001',
        phase: 3,
        roadmapActive: true,
      })
      createTask({
        roadmapTaskKey: 'task-002',
        phase: 1,
        roadmapActive: true,
      })

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [roadmapTask('task-002')],
      })

      const found = storage.tasks.findById(removed.id)
      expect(result.deactivatedTaskIds).toEqual([removed.id])
      expect(found?.roadmapActive).toBe(false)
      expect(found?.phase).toBe(3)
    })

    it('syncRoadmapTasks fails atomically when an active-job task disappears', () => {
      const removed = createTask({
        roadmapTaskKey: 'task-001',
        phase: 1,
        roadmapActive: true,
      })
      createJob(removed.id, 'blocked')
      const retained = createTask({
        roadmapTaskKey: 'task-002',
        title: 'Old title',
        phase: 1,
        roadmapActive: true,
      })

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [roadmapTask('task-002', { title: 'New title' })],
      })

      expect(result.ok).toBe(false)
      expect(result.createdTaskIds).toEqual([])
      expect(storage.tasks.findById(removed.id)?.roadmapActive).toBe(true)
      expect(storage.tasks.findById(retained.id)?.title).toBe('Old title')
    })

    it('syncRoadmapTasks preserves dependencies when a locked task disappears without an active job', () => {
      const dependencyInput = roadmapTask('task-001')
      const dependency = createRoadmapTaskRecord(dependencyInput)
      const removedInput = roadmapTask('task-002', { dependencies: ['task-001'] })
      const removed = createRoadmapTaskRecord(removedInput, { dependencies: [dependency.id] })
      createJob(removed.id, 'success')

      const result = storage.tasks.syncRoadmapTasks({
        projectId,
        tasks: [dependencyInput],
      })

      const found = storage.tasks.findById(removed.id)
      expect(result.ok).toBe(true)
      expect(result.deactivatedTaskIds).toEqual([removed.id])
      expect(found?.roadmapActive).toBe(false)
      expect(found?.dependencies).toEqual([dependency.id])
    })

    it('validateRoadmapTasks rejects an empty roadmap before sync changes existing tasks', () => {
      createTask({
        roadmapTaskKey: 'task-001',
        phase: 1,
        roadmapActive: true,
      })
      const beforeTasks = storage.tasks.findByProjectId(projectId)

      const issues = validateRoadmapTasks([])

      expect(issues).toContainEqual(expect.objectContaining({ code: 'empty_roadmap' }))
      expect(storage.tasks.findByProjectId(projectId)).toEqual(beforeTasks)
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

    it('saves and finds a failure explanation envelope without exposing it on Job', () => {
      const job = storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'failed',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      })
      const envelope: PersistedTaskFailureExplanationV1 = {
        schemaVersion: 1,
        inputVersion: 1,
        contentHash: 'content-hash',
        generatedAt: '2026-08-17T00:00:00.000Z',
        aiAnalysis: {
          classification: 'code',
          likelyCause: 'Type mismatch',
          impact: 'Tests failed',
          recommendedNextAction: 'Fix the type',
        },
      }

      expect(storage.jobs.findFailureExplanation(job.id)).toBeUndefined()
      storage.jobs.saveFailureExplanation(job.id, envelope)

      expect(storage.jobs.findFailureExplanation(job.id)).toEqual(envelope)
      expect(storage.jobs.findById(job.id)).toMatchObject(job)
      expect(storage.jobs.findById(job.id)).not.toHaveProperty('failureExplanationJson')
      expect(storage.jobs.findById(job.id)).not.toHaveProperty('failure_explanation_json')
    })

    it.each([
      ['malformed JSON', '{not-json'],
      ['a schema mismatch', JSON.stringify({ schemaVersion: 2, inputVersion: 1 })],
    ])('treats %s in a saved failure explanation as a cache miss', (_label, savedJson) => {
      const dbPath = path.join(os.tmpdir(), `ai-team-failure-explanation-invalid-${randomUUID()}.db`)
      const fileStorage = createSQLiteStorage(dbPath)
      const project = fileStorage.projects.create({
        name: 'Failure explanation storage',
        goal: 'Validate persisted JSON',
        designPhilosophy: [],
        status: 'draft',
      })
      const task = fileStorage.tasks.create({
        projectId: project.id,
        title: 'Failure explanation task',
        description: '',
        status: 'blocked',
        assignee: 'developer_ai',
        dependencies: [],
      })
      const job = fileStorage.jobs.create({
        taskId: task.id,
        projectId: project.id,
        agentRole: 'developer_ai',
        status: 'failed',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      })
      const db = new Database(dbPath)
      db.prepare(
        'UPDATE jobs SET failure_explanation_json = ? WHERE id = ?',
      ).run(savedJson, job.id)
      db.close()

      expect(() => fileStorage.jobs.findFailureExplanation(job.id)).not.toThrow()
      expect(fileStorage.jobs.findFailureExplanation(job.id)).toBeUndefined()
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

    it('failIfRunning transitions only a running Job and persists failure details', () => {
      const job = storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'running',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })
      const failure = {
        stderr: 'Failed to persist the terminal result',
        completedAt: '2026-08-08T01:02:03.000Z',
      }

      const result = storage.jobs.failIfRunning(job.id, failure)

      expect(result).toMatchObject({
        ok: true,
        updated: true,
        currentStatus: 'failed',
        job: {
          id: job.id,
          status: 'failed',
          stderr: failure.stderr,
          completedAt: failure.completedAt,
        },
      })
      expect(storage.jobs.findById(job.id)).toMatchObject({
        status: 'failed',
        stderr: failure.stderr,
        completedAt: failure.completedAt,
      })
    })

    it.each(['success', 'failed', 'blocked', 'queued'] as const)(
      'failIfRunning leaves a %s Job unchanged',
      (status) => {
        const job = storage.jobs.create({
          taskId,
          projectId,
          agentRole: 'developer_ai',
          status,
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        })

        const result = storage.jobs.failIfRunning(job.id, {
          stderr: 'must not be saved',
          completedAt: '2026-08-08T01:02:03.000Z',
        })

        expect(result).toMatchObject({ ok: true, updated: false, currentStatus: status })
        expect(storage.jobs.findById(job.id)).toMatchObject({
          status,
          stderr: undefined,
          completedAt: undefined,
        })
      },
    )

    it('failIfRunning returns JOB_NOT_FOUND for a missing Job', () => {
      expect(storage.jobs.failIfRunning('missing-job', {
        stderr: 'technical failure',
        completedAt: '2026-08-08T01:02:03.000Z',
      })).toEqual({ ok: false, code: 'JOB_NOT_FOUND', reason: 'Job not found' })
    })

    it('allows multiple manual Jobs because workflow_step_key is NULL', () => {
      storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })
      storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })

      expect(storage.jobs.findByTaskId(taskId)).toHaveLength(2)
      expect(storage.jobs.findByTaskId(taskId).every((job) => job.workflowStepKey === undefined)).toBe(true)
    })

    it('rejects duplicate non-NULL workflow step keys', () => {
      const workflowStepKey = `task:${taskId}:initial-implement`
      const input = {
        taskId,
        projectId,
        workflowStepKey,
        agentRole: 'developer_ai' as const,
        status: 'queued' as const,
        safeCommand: { kind: 'test' as const, workingDir: '/workspace/target' },
      }

      storage.jobs.create(input)

      expect(() => storage.jobs.create(input)).toThrow()
    })

    it('creates a new workflow Job once and returns it on result resend', () => {
      const implement = storage.jobs.create({
        taskId,
        projectId,
        workflowStepKey: `task:${taskId}:initial-implement`,
        agentRole: 'developer_ai',
        status: 'running',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      })
      const nextJob = {
        taskId,
        projectId,
        workflowStepKey: `implement:${implement.id}:review`,
        agentRole: 'reviewer_ai' as const,
        status: 'queued' as const,
        safeCommand: { kind: 'git_status' as const, workingDir: '/workspace/target' },
      }

      const first = storage.jobs.updateAndCreateNextWorkflowJob({
        jobId: implement.id,
        update: { status: 'success' },
        nextJob,
      })
      const second = storage.jobs.updateAndCreateNextWorkflowJob({
        jobId: implement.id,
        update: { status: 'success' },
        nextJob,
      })

      expect(first.ok && first.nextJobCreated).toBe(true)
      expect(second.ok && second.nextJobCreated).toBe(false)
      expect(storage.jobs.findByTaskId(taskId)).toHaveLength(2)
    })

    it('does not advance a manual Job', () => {
      const manual = storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'running',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      })

      const result = storage.jobs.updateAndCreateNextWorkflowJob({
        jobId: manual.id,
        update: { status: 'success' },
        nextJob: {
          taskId,
          projectId,
          workflowStepKey: `implement:${manual.id}:review`,
          agentRole: 'reviewer_ai',
          status: 'queued',
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        },
      })

      expect(result).toMatchObject({ ok: false, code: 'NOT_WORKFLOW_JOB' })
      expect(storage.jobs.findByTaskId(taskId)).toHaveLength(1)
    })

    it('creates workflow schema on a new DB and migrates a legacy jobs table', () => {
      const newDbPath = path.join(os.tmpdir(), `ai-team-workflow-new-${randomUUID()}.db`)
      createSQLiteStorage(newDbPath)
      const newDb = new Database(newDbPath, { readonly: true })
      expect((newDb.pragma('table_info(jobs)') as Array<{ name: string }>).some(
        (column) => column.name === 'workflow_step_key',
      )).toBe(true)
      newDb.close()

      const legacyDbPath = path.join(os.tmpdir(), `ai-team-workflow-legacy-${randomUUID()}.db`)
      const legacyDb = new Database(legacyDbPath)
      legacyDb.exec(CREATE_TABLES.replace('    workflow_step_key TEXT,\n', ''))
      legacyDb.close()

      expect(() => createSQLiteStorage(legacyDbPath)).not.toThrow()
      const migratedDb = new Database(legacyDbPath, { readonly: true })
      expect((migratedDb.pragma('table_info(jobs)') as Array<{ name: string }>).some(
        (column) => column.name === 'workflow_step_key',
      )).toBe(true)
      migratedDb.close()
    })

    it('creates and idempotently migrates the failure explanation column', () => {
      const newDbPath = path.join(os.tmpdir(), `ai-team-failure-explanation-new-${randomUUID()}.db`)
      createSQLiteStorage(newDbPath)
      const newDb = new Database(newDbPath, { readonly: true })
      expect((newDb.pragma('table_info(jobs)') as Array<{ name: string }>).some(
        (column) => column.name === 'failure_explanation_json',
      )).toBe(true)
      newDb.close()

      const legacyDbPath = path.join(os.tmpdir(), `ai-team-failure-explanation-legacy-${randomUUID()}.db`)
      const legacyDb = new Database(legacyDbPath)
      legacyDb.exec(CREATE_TABLES.replace('    failure_explanation_json TEXT,\n', ''))
      legacyDb.close()

      expect(() => createSQLiteStorage(legacyDbPath)).not.toThrow()
      expect(() => createSQLiteStorage(legacyDbPath)).not.toThrow()
      const migratedDb = new Database(legacyDbPath, { readonly: true })
      expect((migratedDb.pragma('table_info(jobs)') as Array<{ name: string }>).some(
        (column) => column.name === 'failure_explanation_json',
      )).toBe(true)
      migratedDb.close()
    })

    it('enforces one Job per non-NULL approval_id with the unique index', () => {
      const first = storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'running',
        safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' },
      })
      const second = storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'running',
        safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' },
      })

      storage.jobs.update(first.id, { approvalId: 'approval-unique' })
      expect(() => {
        storage.jobs.update(second.id, { approvalId: 'approval-unique' })
      }).toThrow()
      expect(storage.jobs.findById(second.id)?.approvalId).toBeUndefined()
    })

    it('fails startup when the unique approval_id index migration finds legacy duplicates', () => {
      const dbPath = path.join(os.tmpdir(), `ai-team-duplicate-approval-${randomUUID()}.db`)
      const legacyDb = new Database(dbPath)
      const timestamp = new Date().toISOString()
      legacyDb.exec(CREATE_TABLES)
      legacyDb.prepare(`
        INSERT INTO projects (id, name, goal, created_at, updated_at)
        VALUES ('project-1', 'P', 'g', ?, ?)
      `).run(timestamp, timestamp)
      legacyDb.prepare(`
        INSERT INTO tasks (id, project_id, title, created_at, updated_at)
        VALUES ('task-1', 'project-1', 'T', ?, ?)
      `).run(timestamp, timestamp)
      const insertJob = legacyDb.prepare(`
        INSERT INTO jobs (id, task_id, project_id, status, safe_command, approval_id, created_at)
        VALUES (?, 'task-1', 'project-1', 'blocked', ?, 'duplicate-approval', ?)
      `)
      insertJob.run('job-1', JSON.stringify({ kind: 'git_commit', workingDir: '/workspace/target' }), timestamp)
      insertJob.run('job-2', JSON.stringify({ kind: 'git_commit', workingDir: '/workspace/target' }), timestamp)
      legacyDb.close()

      expect(() => createSQLiteStorage(dbPath)).toThrow()
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

  describe('reviewResults', () => {
    it('enforces one ReviewResult per review Job', () => {
      const project = storage.projects.create({
        name: 'Review project',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      })
      const task = storage.tasks.create({
        projectId: project.id,
        title: 'Review task',
        description: '',
        status: 'review',
        assignee: 'reviewer_ai',
        dependencies: [],
      })
      const job = storage.jobs.create({
        taskId: task.id,
        projectId: project.id,
        agentRole: 'reviewer_ai',
        status: 'success',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })
      const review = {
        taskId: task.id,
        jobId: job.id,
        reviewer: 'reviewer_ai' as const,
        status: 'approved' as const,
        summary: 'Approved',
        findings: [],
      }

      storage.reviewResults.create(review)

      expect(() => storage.reviewResults.create(review)).toThrow()
      expect(storage.reviewResults.findByTaskId(task.id)).toHaveLength(1)
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

    it('serializes and deserializes changedFiles and triggeredRules', () => {
      const req = storage.approvalRequests.create({
        ...BASE,
        status: 'WAITING_FOR_USER',
        changedFiles: ['apps/api/src/storage/schema.ts'],
        triggeredRules: ['DB migration / schema'],
      })

      const found = storage.approvalRequests.findById(req.id)

      expect(req.changedFiles).toEqual(['apps/api/src/storage/schema.ts'])
      expect(req.triggeredRules).toEqual(['DB migration / schema'])
      expect(found?.changedFiles).toEqual(['apps/api/src/storage/schema.ts'])
      expect(found?.triggeredRules).toEqual(['DB migration / schema'])
    })

    it('createForJob failure leaves both Approval and Job unchanged atomically', () => {
      const project = storage.projects.create({
        name: 'Atomic approval project',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      })
      const task = storage.tasks.create({
        projectId: project.id,
        title: 'Atomic approval task',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        dependencies: [],
      })
      const job = storage.jobs.create({
        taskId: task.id,
        projectId: project.id,
        agentRole: 'developer_ai',
        status: 'running',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      })

      const result = storage.approvalRequests.createForJob({
        taskId: task.id,
        targetBranch: 'main',
        targetCommit: 'commit',
        targetDiffHash: 'diff',
        riskLevel: 'LOW',
        requestedAction: 'git_commit',
        status: 'WAITING_FOR_USER',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        invalidIf: [],
      }, job.id)

      expect(result.ok).toBe(false)
      expect(storage.approvalRequests.findByTaskId(task.id)).toEqual([])
      expect(storage.jobs.findById(job.id)?.approvalId).toBeUndefined()
    })

    it('defaults changedFiles and triggeredRules to empty arrays when omitted', () => {
      const req = storage.approvalRequests.create({ ...BASE, status: 'WAITING_FOR_USER' })
      const found = storage.approvalRequests.findById(req.id)

      expect(req.changedFiles).toEqual([])
      expect(req.triggeredRules).toEqual([])
      expect(found?.changedFiles).toEqual([])
      expect(found?.triggeredRules).toEqual([])
    })

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

  describe('designReviewEvidence', () => {
    it('creates the table in a new database', () => {
      const dbPath = path.join(os.tmpdir(), `ai-team-design-review-evidence-${randomUUID()}.db`)
      createSQLiteStorage(dbPath)
      const db = new Database(dbPath, { readonly: true })

      try {
        const columns = new Set(
          (db.pragma('table_info(design_review_evidence)') as Array<{ name: string }>)
            .map((column) => column.name),
        )

        expect(columns.has('task_id')).toBe(true)
        expect(columns.has('design_text_hash')).toBe(true)
        expect(columns.has('independent_review_verdict')).toBe(true)
      } finally {
        db.close()
      }
    })

    it('creates and finds Design Review evidence by Task', () => {
      const project = storage.projects.create({
        name: 'Design evidence project',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      })
      const task = storage.tasks.create({
        projectId: project.id,
        title: 'Design evidence task',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        dependencies: [],
      })
      const designText = 'Design: use the existing storage repository pattern.'

      const created = storage.designReviewEvidence.create({
        taskId: task.id,
        designTextHash: computeDesignTextHash(designText),
        reviewLoad: 'critical',
        decision: 'ALIGNED',
        independentReviewRequired: true,
        independentReviewVerdict: 'approved',
      })

      expect(storage.designReviewEvidence.findById(created.id)).toMatchObject({
        taskId: task.id,
        designTextHash: computeDesignTextHash(designText),
        reviewLoad: 'critical',
        decision: 'ALIGNED',
        independentReviewRequired: true,
        independentReviewVerdict: 'approved',
      })
      expect(storage.designReviewEvidence.findByTaskId(task.id)).toHaveLength(1)
      expect(storage.designReviewEvidence.findLatestByTaskId(task.id)?.id).toBe(created.id)
    })

    it('returns the latest Design Review evidence for a Task', async () => {
      const project = storage.projects.create({
        name: 'Latest design evidence project',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      })
      const task = storage.tasks.create({
        projectId: project.id,
        title: 'Latest design evidence task',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        dependencies: [],
      })

      storage.designReviewEvidence.create({
        taskId: task.id,
        designTextHash: computeDesignTextHash('Design: first version.'),
        reviewLoad: 'medium',
        decision: 'CONFLICT',
        independentReviewRequired: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 5))
      const latest = storage.designReviewEvidence.create({
        taskId: task.id,
        designTextHash: computeDesignTextHash('Design: second version.'),
        reviewLoad: 'medium',
        decision: 'ALIGNED',
        independentReviewRequired: false,
      })

      expect(storage.designReviewEvidence.findLatestByTaskId(task.id)?.id).toBe(latest.id)
    })
  })

  describe('auditLog', () => {
    it('creates the table in a new database', () => {
      const dbPath = path.join(os.tmpdir(), `ai-team-audit-log-${randomUUID()}.db`)
      createSQLiteStorage(dbPath)
      const db = new Database(dbPath, { readonly: true })

      try {
        const columns = new Set(
          (db.pragma('table_info(audit_log)') as Array<{ name: string }>)
            .map((column) => column.name),
        )

        expect(columns.has('actor')).toBe(true)
        expect(columns.has('operation')).toBe(true)
        expect(columns.has('entity_type')).toBe(true)
        expect(columns.has('entity_id')).toBe(true)
        expect(columns.has('result')).toBe(true)
      } finally {
        db.close()
      }
    })

    it('records an entry and finds it by entity', () => {
      const recorded = storage.auditLog.record({
        actor: 'api',
        operation: 'delete',
        entityType: 'permission_grant',
        entityId: 'grant-1',
        result: 'success',
      })

      expect(recorded.id).toBeTruthy()
      expect(recorded.createdAt).toBeTruthy()

      const byEntity = storage.auditLog.findByEntity('permission_grant', 'grant-1')
      expect(byEntity).toHaveLength(1)
      expect(byEntity[0]).toMatchObject({
        actor: 'api',
        operation: 'delete',
        entityType: 'permission_grant',
        entityId: 'grant-1',
        result: 'success',
      })

      expect(storage.auditLog.findAll().length).toBeGreaterThanOrEqual(1)
    })

    it('returns entries for an entity newest first', async () => {
      storage.auditLog.record({
        actor: 'api',
        operation: 'approve',
        entityType: 'approval_request',
        entityId: 'req-1',
        result: 'success',
      })
      await new Promise((resolve) => setTimeout(resolve, 5))
      storage.auditLog.record({
        actor: 'api',
        operation: 'reject',
        entityType: 'approval_request',
        entityId: 'req-1',
        result: 'success',
      })

      const entries = storage.auditLog.findByEntity('approval_request', 'req-1')
      expect(entries).toHaveLength(2)
      expect(entries[0].operation).toBe('reject')
      expect(entries[1].operation).toBe('approve')
    })
  })

  describe('projectRoadmapPhases', () => {
    it('creates the table in a new database', () => {
      const dbPath = path.join(os.tmpdir(), `ai-team-project-roadmap-phases-${randomUUID()}.db`)
      createSQLiteStorage(dbPath)
      const db = new Database(dbPath, { readonly: true })

      try {
        const columns = new Set(
          (db.pragma('table_info(project_roadmap_phases)') as Array<{ name: string }>)
            .map((column) => column.name),
        )

        expect(columns.has('project_id')).toBe(true)
        expect(columns.has('phase_number')).toBe(true)
        expect(columns.has('name')).toBe(true)
        expect(columns.has('goal')).toBe(true)
        expect(columns.has('roadmap_active')).toBe(true)
      } finally {
        db.close()
      }
    })

    it('syncs phases alongside tasks and returns them ordered by phaseNumber', () => {
      const project = storage.projects.create({
        name: 'Roadmap phase project',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      })

      storage.tasks.syncRoadmapTasks({
        projectId: project.id,
        tasks: [
          { roadmapTaskKey: 'task-001', title: 'T1', description: '', phase: 2, assignee: 'developer_ai', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
          { roadmapTaskKey: 'task-002', title: 'T2', description: '', phase: 1, assignee: 'developer_ai', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [
          { phaseNumber: 2, name: 'Second', goal: 'G2' },
          { phaseNumber: 1, name: 'First', goal: 'G1' },
        ],
      })

      const phases = storage.projectRoadmapPhases.findByProjectId(project.id)
      expect(phases.map((p) => p.phaseNumber)).toEqual([1, 2])
      expect(phases[0]).toMatchObject({ projectId: project.id, name: 'First', goal: 'G1', roadmapActive: true })
      expect(phases[1]).toMatchObject({ projectId: project.id, name: 'Second', goal: 'G2', roadmapActive: true })
    })

    it('rolls back both task and phase changes when a phase conflict is detected', () => {
      const project = storage.projects.create({
        name: 'Roadmap phase conflict project',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      })

      storage.tasks.syncRoadmapTasks({
        projectId: project.id,
        tasks: [
          { roadmapTaskKey: 'task-001', title: 'T1', description: '', phase: 1, assignee: 'developer_ai', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [{ phaseNumber: 1, name: 'Original', goal: 'Original goal' }],
      })
      const startedTask = storage.tasks.findByProjectId(project.id)[0]
      storage.jobs.create({
        taskId: startedTask.id,
        projectId: project.id,
        agentRole: 'developer_ai',
        status: 'success',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })

      // phase 1 のrepurpose（conflict）と、無関係な新規phase 2・新規taskを同一呼び出しに含める。
      // 同一transactionであれば、phase 1のconflictでロールバックされ、phase 2・task-002も作成されないはず。
      const result = storage.tasks.syncRoadmapTasks({
        projectId: project.id,
        tasks: [
          { roadmapTaskKey: 'task-001', title: 'T1', description: '', phase: 1, assignee: 'developer_ai', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
          { roadmapTaskKey: 'task-002', title: 'T2', description: '', phase: 2, assignee: 'developer_ai', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [
          { phaseNumber: 1, name: 'Repurposed', goal: 'Repurposed goal' },
          { phaseNumber: 2, name: 'Unrelated new phase', goal: 'Unrelated goal' },
        ],
      })

      expect(result.ok).toBe(false)
      expect(result.phaseConflicts).toContainEqual({ phaseNumber: 1, field: 'name' })
      expect(result.phaseConflicts).toContainEqual({ phaseNumber: 1, field: 'goal' })
      expect(storage.projectRoadmapPhases.findByProjectId(project.id)[0].name).toBe('Original')
      // 同一transactionであることの確認: 無関係な新規phase 2・task-002も作成されていない
      expect(storage.projectRoadmapPhases.findByProjectId(project.id)).toHaveLength(1)
      expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1)
    })

    it('rolls back an unrelated new phase when a Task-level conflict is detected in the same call (same-transaction proof)', () => {
      const project = storage.projects.create({
        name: 'Roadmap task conflict blocks phase project',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      })

      storage.tasks.syncRoadmapTasks({
        projectId: project.id,
        tasks: [
          { roadmapTaskKey: 'task-001', title: 'Original title', description: '', phase: 1, assignee: 'developer_ai', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [{ phaseNumber: 1, name: 'Phase 1', goal: 'G1' }],
      })
      const startedTask = storage.tasks.findByProjectId(project.id)[0]
      storage.jobs.create({
        taskId: startedTask.id,
        projectId: project.id,
        agentRole: 'developer_ai',
        status: 'success',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })

      // task-001（着手済み）のtitle変更（task-level conflict）と、無関係な新規phase 2を同一呼び出しに含める。
      const result = storage.tasks.syncRoadmapTasks({
        projectId: project.id,
        tasks: [
          { roadmapTaskKey: 'task-001', title: 'Changed title', description: '', phase: 1, assignee: 'developer_ai', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [
          { phaseNumber: 1, name: 'Phase 1', goal: 'G1' },
          { phaseNumber: 2, name: 'Unrelated new phase', goal: 'Unrelated goal' },
        ],
      })

      expect(result.ok).toBe(false)
      expect(result.conflicts).toContainEqual({ roadmapTaskKey: 'task-001', field: 'title' })
      // task-levelのconflictにもかかわらず、無関係な新規phase 2が作成されていないこと（同一transaction証明）
      expect(storage.projectRoadmapPhases.findByProjectId(project.id)).toHaveLength(1)
      expect(storage.tasks.findById(startedTask.id)?.title).toBe('Original title')
    })

    it('deactivates a phase that disappears from regeneration and reactivates it if it reappears', () => {
      const project = storage.projects.create({
        name: 'Roadmap phase lifecycle project',
        goal: 'g',
        designPhilosophy: [],
        status: 'draft',
      })

      storage.tasks.syncRoadmapTasks({
        projectId: project.id,
        tasks: [
          { roadmapTaskKey: 'task-001', title: 'T1', description: '', phase: 1, assignee: 'developer_ai', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [{ phaseNumber: 1, name: 'First', goal: 'G1' }],
      })

      storage.tasks.syncRoadmapTasks({
        projectId: project.id,
        tasks: [
          { roadmapTaskKey: 'task-002', title: 'T2', description: '', phase: 2, assignee: 'developer_ai', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [{ phaseNumber: 2, name: 'Second', goal: 'G2' }],
      })

      const afterDeactivate = storage.projectRoadmapPhases.findByProjectId(project.id)
      expect(afterDeactivate.find((p) => p.phaseNumber === 1)?.roadmapActive).toBe(false)

      storage.tasks.syncRoadmapTasks({
        projectId: project.id,
        tasks: [
          { roadmapTaskKey: 'task-001', title: 'T1', description: '', phase: 1, assignee: 'developer_ai', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
          { roadmapTaskKey: 'task-002', title: 'T2', description: '', phase: 2, assignee: 'developer_ai', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [
          { phaseNumber: 1, name: 'First', goal: 'G1' },
          { phaseNumber: 2, name: 'Second', goal: 'G2' },
        ],
      })

      const afterReactivate = storage.projectRoadmapPhases.findByProjectId(project.id)
      expect(afterReactivate.find((p) => p.phaseNumber === 1)?.roadmapActive).toBe(true)
    })
  })
})
