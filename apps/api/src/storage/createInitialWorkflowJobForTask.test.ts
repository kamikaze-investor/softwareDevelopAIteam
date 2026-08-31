import { beforeEach, describe, expect, it } from 'vitest'
import { createSQLiteStorage } from './sqlite'
import type { IStorage } from './interface'

describe('createInitialWorkflowJobForTask', () => {
  let storage: IStorage

  beforeEach(() => {
    storage = createSQLiteStorage(':memory:')
  })

  function createRunningProject() {
    return storage.projects.create({
      name: 'P',
      goal: 'g',
      designPhilosophy: [],
      status: 'running',
    })
  }

  function createTask(projectId: string, overrides: Record<string, unknown> = {}) {
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

  it('creates a job with correct workflowStepKey', () => {
    const project = createRunningProject()
    const task = createTask(project.id)

    const result = storage.jobs.createInitialWorkflowJobForTask(task.id)

    expect(result.created).toBe(true)
    if (!result.created) return
    expect(result.job.workflowStepKey).toBe(`task:${task.id}:initial-implement`)
    expect(result.job.status).toBe('queued')
    expect(result.job.taskId).toBe(task.id)
    expect(result.job.projectId).toBe(project.id)
    expect(result.job.agentRole).toBe('developer_ai')
  })

  it('returns created:false on second call for same task', () => {
    const project = createRunningProject()
    const task = createTask(project.id)

    const first = storage.jobs.createInitialWorkflowJobForTask(task.id)
    expect(first.created).toBe(true)

    const second = storage.jobs.createInitialWorkflowJobForTask(task.id)
    expect(second.created).toBe(false)
  })

  it.each([
    ['queued', 'queued'],
    ['running', 'running'],
    ['blocked', 'blocked'],
  ] as const)('does not create when task has a %s job', (_label, status) => {
    const project = createRunningProject()
    const task = createTask(project.id)

    storage.jobs.create({
      taskId: task.id,
      projectId: project.id,
      agentRole: 'developer_ai',
      status,
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    })

    const result = storage.jobs.createInitialWorkflowJobForTask(task.id)
    expect(result.created).toBe(false)
  })

  it('does not create when project is archived', () => {
    const project = storage.projects.create({
      name: 'Archived',
      goal: 'g',
      designPhilosophy: [],
      status: 'archived',
    })
    const task = createTask(project.id)

    const result = storage.jobs.createInitialWorkflowJobForTask(task.id)
    expect(result.created).toBe(false)
  })

  it('does not create when task status is blocked', () => {
    const project = createRunningProject()
    const task = createTask(project.id, { status: 'blocked' })

    const result = storage.jobs.createInitialWorkflowJobForTask(task.id)
    expect(result.created).toBe(false)
  })

  it('does not create when task status is done', () => {
    const project = createRunningProject()
    const task = createTask(project.id, { status: 'done' })

    const result = storage.jobs.createInitialWorkflowJobForTask(task.id)
    expect(result.created).toBe(false)
  })

  it('returns created:false for non-existent taskId without throwing', () => {
    const result = storage.jobs.createInitialWorkflowJobForTask('non-existent-id')
    expect(result.created).toBe(false)
  })
})
