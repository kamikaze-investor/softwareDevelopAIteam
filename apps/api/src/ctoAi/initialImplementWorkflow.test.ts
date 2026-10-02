import { beforeEach, describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import { buildInitialImplementAiCliPrompt, createInitialImplementWorkflow } from './initialImplementWorkflow'
import type { IStorage } from '../storage/interface'
import { checkImplementJobDesignReviewEvidence, computeDesignTextHash } from '../designReviewEvidencePolicy'
import { abortTask } from '../pl/abortTask'
import { ensureInitialWorkflowsForActiveTasks } from './projectInitialization'

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
  it('includes the complete Task Contract for an f7c4ff37-shaped Task', () => {
    const acceptanceCriteria = [
      'Latency reason is exposed.',
      'Timeout behavior is documented.',
      'API response remains compatible.',
      'Tests cover the timeout path.',
      'No changes to files outside apps/api/src/aiExplain',
    ]
    const prompt = buildInitialImplementAiCliPrompt({
      description: 'Implement T.',
      allowedPaths: ['apps/api/src/aiExplain'],
      forbiddenPaths: ['apps/worker/src/guards'],
      expectedOutputs: ['apps/api/src/aiExplain/timeout.ts'],
      acceptanceCriteria,
    })

    expect(prompt).toContain('Implement T.')
    expect(prompt).toContain('"allowedPaths": [\n    "apps/api/src/aiExplain"')
    expect(prompt).toContain('"forbiddenPaths": [\n    "apps/worker/src/guards"')
    expect(prompt).toContain('"expectedOutputs": [\n    "apps/api/src/aiExplain/timeout.ts"')
    for (const criterion of acceptanceCriteria) expect(prompt).toContain(criterion)
    expect(prompt).toContain('## Design Contract')
    expect(prompt).toContain('current implementation is evidence, not specification')
  })

  it('builds a prompt for a legacy Task with no declared paths or acceptance criteria', () => {
    const prompt = buildInitialImplementAiCliPrompt({ description: 'Legacy task.' })

    expect(prompt).toContain('Legacy task.')
    expect(prompt).toContain('"acceptanceCriteria": []')
    expect(prompt).toContain('"allowedPaths": []')
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

  // Design Review の待ち時間は数分単位になりうる。その間に CEO が abort_task を承認して
  // Task を park しても、待つ前の判定のまま Job を作れば park は黙って取り消される
  // （Worker は Task の状態を見ずに queued Job を拾う）。
  it('Design Review 中に park された Task へは Job を作らない', async () => {
    const parkingDeps = {
      ...alignedDeps(),
      execute: async () => {
        const request = storage.approvalRequests.create({
          taskId, requestedAction: 'abort_task', riskLevel: 'HIGH',
          targetBranch: 'ai/park', targetCommit: 'c', targetDiffHash: 'd',
          changedFiles: [], triggeredRules: [], invalidIf: ['commit changes'],
          status: 'WAITING_FOR_USER', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        } as Parameters<IStorage['approvalRequests']['create']>[0])
        storage.approvalRequests.updateStatus(request.id, 'APPROVED')
        const parked = abortTask(storage, {
          taskId, approvalRequestId: request.id, reason: 'CEO parked it while the review ran',
        })
        expect(parked).toMatchObject({ ok: true, status: 'parked' })
        return alignedDeps().execute()
      },
    }

    const result = await createInitialImplementWorkflow(storage, taskId, parkingDeps)

    expect(result).toMatchObject({ status: 'skipped' })
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(0)
    expect(storage.tasks.findById(taskId)?.roadmapActive).toBe(false)
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
    expect(checkImplementJobDesignReviewEvidence(jobs[0], storage.designReviewEvidence)).toMatchObject({ ok: true })
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

// Project-start完了時にJobを保証すべきなのは「今実行可能なTask」だけで、依存未達のTaskへ
// 先回りしてJobを作ってはいけない（同じ共有workspaceへ依存元の完了前に書き込まれる）。
describe('ensureInitialWorkflowsForActiveTasks の dependency eligibility', () => {
  let storage: IStorage
  let projectId: string
  let a: string
  let b: string
  let c: string

  beforeEach(() => {
    storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({ name: 'P', goal: 'G', designPhilosophy: [], status: 'running' })
    projectId = project.id
    const make = (title: string, dependencies: string[]): string => storage.tasks.create({
      projectId, title, description: `Implement ${title}.`, status: 'pending',
      assignee: 'developer_ai', dependencies, roadmapActive: true,
    }).id
    a = make('A', [])
    b = make('B', [a])
    c = make('C', [b])
  })

  const jobCount = (taskId: string): number => storage.jobs.findByTaskId(taskId).length

  it('Project-start直後はAだけにJobを作り、B/Cには作らない', async () => {
    await ensureInitialWorkflowsForActiveTasks(storage, projectId, alignedDeps())

    expect(jobCount(a)).toBe(1)
    expect(jobCount(b)).toBe(0)
    expect(jobCount(c)).toBe(0)
  })

  it('A完了後はBだけが実行可能になり、Cはまだ作られない', async () => {
    await ensureInitialWorkflowsForActiveTasks(storage, projectId, alignedDeps())
    storage.tasks.update(a, { status: 'done' })

    await ensureInitialWorkflowsForActiveTasks(storage, projectId, alignedDeps())

    expect(jobCount(a)).toBe(1)
    expect(jobCount(b)).toBe(1)
    expect(jobCount(c)).toBe(0)
  })

  it('B完了後にCが実行可能になる', async () => {
    storage.tasks.update(a, { status: 'done' })
    storage.tasks.update(b, { status: 'done' })

    await ensureInitialWorkflowsForActiveTasks(storage, projectId, alignedDeps())

    expect(jobCount(c)).toBe(1)
  })

  it('restart recoveryの再実行でJobは重複せず、欠けているものだけが補修される', async () => {
    await ensureInitialWorkflowsForActiveTasks(storage, projectId, alignedDeps())
    // 同じ状態で何度呼んでも増えない
    await ensureInitialWorkflowsForActiveTasks(storage, projectId, alignedDeps())
    await ensureInitialWorkflowsForActiveTasks(storage, projectId, alignedDeps())

    expect(jobCount(a)).toBe(1)
    expect(jobCount(b)).toBe(0)
    expect(jobCount(c)).toBe(0)
  })
})
