import { beforeEach, describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import { createInitialImplementWorkflow } from './initialImplementWorkflow'
import type { IStorage } from '../storage/interface'

function alignedDeps() {
  return {
    runnerCommand: 'node', runnerArgs: [], homeDirectory: '/tmp', workingDir: '/tmp',
    execute: async () => ({ ok: true, timedOut: false, stdout: JSON.stringify({
      focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED' }], integrationReviewResult: { decision: 'ALIGNED' },
    }) }),
  }
}

function conflictingDeps() {
  return {
    ...alignedDeps(),
    execute: async () => ({ ok: true, timedOut: false, stdout: JSON.stringify({
      focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED' }], integrationReviewResult: { decision: 'CONFLICT' },
    }) }),
  }
}

describe('initial implement workflow', () => {
  let storage: IStorage
  let taskId: string

  beforeEach(() => {
    storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({ name: 'P', goal: 'G', designPhilosophy: [], status: 'running' })
    taskId = storage.tasks.create({
      projectId: project.id, title: 'T', description: 'Implement T.', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    }).id
  })

  it('creates exactly one reviewed initial implement Job with the Task description prompt', async () => {
    const first = await createInitialImplementWorkflow(storage, taskId, alignedDeps())
    const second = await createInitialImplementWorkflow(storage, taskId, alignedDeps())

    expect(first).toMatchObject({ status: 'created' })
    expect(second).toMatchObject({ status: 'skipped', reason: 'initial workflow job already exists' })
    const jobs = storage.jobs.findByTaskId(taskId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      workflowStepKey: `task:${taskId}:initial-implement`, aiCliPrompt: 'Implement T.',
      aiCliMode: 'implement', status: 'queued',
    })
  })

  it('does not create a Job when Design Review is not aligned', async () => {
    const result = await createInitialImplementWorkflow(storage, taskId, conflictingDeps())
    expect(result.status).toBe('skipped')
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(0)
  })

  it('keeps the archived Project boundary', async () => {
    const task = storage.tasks.findById(taskId)!
    storage.projects.update(task.projectId, { status: 'archived' })
    const result = await createInitialImplementWorkflow(storage, taskId, alignedDeps())
    expect(result).toMatchObject({ status: 'skipped', reason: 'project is unavailable' })
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(0)
  })
})
