import { beforeEach, describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import { buildInitialImplementAiCliPrompt, createInitialImplementWorkflow } from './initialImplementWorkflow'
import type { IStorage } from '../storage/interface'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'

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

describe('buildInitialImplementAiCliPrompt', () => {
  it('appends a Design Contract using allowedPaths focus signals', () => {
    const prompt = buildInitialImplementAiCliPrompt({
      description: 'Implement T.',
      allowedPaths: ['apps/api/src/storage/sqlite.ts'],
    })

    expect(prompt).toContain('Implement T.')
    expect(prompt).toContain('## Design Contract')
    expect(prompt).toContain('current implementation is evidence, not specification')
    expect(prompt).toContain('Keep security and data boundaries strict')
  })
})

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

  it('creates exactly one reviewed initial implement Job with a Design Contract prompt', async () => {
    const first = await createInitialImplementWorkflow(storage, taskId, alignedDeps())
    const second = await createInitialImplementWorkflow(storage, taskId, alignedDeps())

    expect(first).toMatchObject({ status: 'created' })
    expect(second).toMatchObject({ status: 'skipped', reason: 'initial workflow job already exists' })
    const jobs = storage.jobs.findByTaskId(taskId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      workflowStepKey: `task:${taskId}:initial-implement`,
      aiCliMode: 'implement',
      status: 'queued',
    })
    expect(jobs[0].aiCliPrompt).toContain('Implement T.')
    expect(jobs[0].aiCliPrompt).toContain('## Design Contract')
    expect(jobs[0].aiCliPrompt).toContain('current implementation is evidence, not specification')
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

  it('does not create a Job while the Project is paused, and marks the skip retryable', async () => {
    const task = storage.tasks.findById(taskId)!
    storage.projects.update(task.projectId, { status: 'paused' })
    const result = await createInitialImplementWorkflow(storage, taskId, alignedDeps())
    expect(result).toMatchObject({ status: 'skipped', reason: 'project is not running', retryable: true })
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(0)
  })

  it('resumes creating the Job once a paused Project is running again', async () => {
    const task = storage.tasks.findById(taskId)!
    storage.projects.update(task.projectId, { status: 'paused' })
    const paused = await createInitialImplementWorkflow(storage, taskId, alignedDeps())
    expect(paused).toMatchObject({ status: 'skipped', retryable: true })

    storage.projects.update(task.projectId, { status: 'running' })
    const resumed = await createInitialImplementWorkflow(storage, taskId, alignedDeps())
    expect(resumed).toMatchObject({ status: 'created' })
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(1)
  })
  it('reuses matching ALIGNED evidence after a pre-Job crash without executing a new review', async () => {
    const task = storage.tasks.findById(taskId)!
    storage.designReviewEvidence.create({
      taskId,
      designTextHash: computeDesignTextHash(buildInitialImplementAiCliPrompt(task)),
      reviewLoad: 'medium',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    })

    const result = await createInitialImplementWorkflow(storage, taskId, {
      ...alignedDeps(),
      execute: async () => { throw new Error('existing evidence must avoid a new Design Review') },
    })
    expect(result).toMatchObject({ status: 'created' })
  })

  it('does not create a Job when a declared dependency is not yet done', async () => {
    const project = storage.tasks.findById(taskId)!.projectId
    const dependencyId = storage.tasks.create({
      projectId: project, title: 'Dependency', description: 'D', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    }).id
    const dependentId = storage.tasks.create({
      projectId: project, title: 'Dependent', description: 'Implement dependent.', status: 'pending',
      assignee: 'developer_ai', dependencies: [dependencyId], roadmapActive: true,
    }).id

    const result = await createInitialImplementWorkflow(storage, dependentId, alignedDeps())

    expect(result).toMatchObject({ status: 'skipped', reason: 'task dependencies are not yet done', retryable: true })
    expect(storage.jobs.findByTaskId(dependentId)).toHaveLength(0)
  })

  it('creates the Job once every declared dependency reaches done', async () => {
    const project = storage.tasks.findById(taskId)!.projectId
    const dependencyId = storage.tasks.create({
      projectId: project, title: 'Dependency', description: 'D', status: 'done',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    }).id
    const dependentId = storage.tasks.create({
      projectId: project, title: 'Dependent', description: 'Implement dependent.', status: 'pending',
      assignee: 'developer_ai', dependencies: [dependencyId], roadmapActive: true,
    }).id

    const result = await createInitialImplementWorkflow(storage, dependentId, alignedDeps())

    expect(result).toMatchObject({ status: 'created' })
    expect(storage.jobs.findByTaskId(dependentId)).toHaveLength(1)
  })
})
