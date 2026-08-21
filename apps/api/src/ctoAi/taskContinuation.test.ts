import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import { ensureTaskContinuation } from './taskContinuation'
import { createInitialImplementWorkflow } from './initialImplementWorkflow'

vi.mock('./initialImplementWorkflow', () => ({
  createInitialImplementWorkflow: vi.fn(),
}))

const createInitialImplementWorkflowMock = vi.mocked(createInitialImplementWorkflow)

function createFixture() {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({ name: 'Continuation', goal: 'g', designPhilosophy: [], status: 'running' })
  const source = storage.tasks.create({ projectId: project.id, title: 'Source', description: '', status: 'done', assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1 })
  const next = storage.tasks.create({ projectId: project.id, title: 'Next', description: 'Implement next.', status: 'pending', assignee: 'developer_ai', dependencies: [source.id], roadmapActive: true, phase: 2 })
  const sourceJob = storage.jobs.create({ taskId: source.id, projectId: project.id, agentRole: 'developer_ai', status: 'success', safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' } })
  const continuation = storage.taskContinuations.create({ sourceJobId: sourceJob.id, projectId: project.id, completedTaskId: source.id, nextTaskId: next.id, status: 'pending' })
  return { storage, next, continuation }
}

describe('ensureTaskContinuation', () => {
  beforeEach(() => {
    createInitialImplementWorkflowMock.mockReset()
  })

  it('leaves a retryable Design Review outcome pending, then completes on a later replay', async () => {
    const { storage, continuation } = createFixture()
    createInitialImplementWorkflowMock.mockResolvedValueOnce({ taskId: continuation.nextTaskId!, status: 'skipped', reason: 'design review did not align (requeued)', retryable: true })
    await ensureTaskContinuation(storage, continuation.id)
    expect(storage.taskContinuations.findById(continuation.id)?.status).toBe('pending')
    createInitialImplementWorkflowMock.mockResolvedValueOnce({ taskId: continuation.nextTaskId!, status: 'created', job: {} as never })
    await ensureTaskContinuation(storage, continuation.id)
    expect(storage.taskContinuations.findById(continuation.id)?.status).toBe('completed')
  })

  it('recovers a crash after initial Job creation by recognizing the deterministic existing Job', async () => {
    const { storage, next, continuation } = createFixture()
    storage.jobs.create({ taskId: next.id, projectId: next.projectId, workflowStepKey: `task:${next.id}:initial-implement`, agentRole: 'developer_ai', status: 'queued', safeCommand: { kind: 'test', workingDir: '/workspace/target' }, aiCliProvider: 'claude_code', aiCliPrompt: next.description, aiCliMode: 'implement' })
    createInitialImplementWorkflowMock.mockResolvedValueOnce({ taskId: next.id, status: 'skipped', reason: 'initial workflow job already exists' })
    await ensureTaskContinuation(storage, continuation.id)
    expect(storage.taskContinuations.findById(continuation.id)?.status).toBe('completed')
    expect(storage.jobs.findByTaskId(next.id)).toHaveLength(1)
  })

  it('marks a terminal failure observable by blocking the target Task and recording an audit entry', async () => {
    const { storage, next, continuation } = createFixture()
    createInitialImplementWorkflowMock.mockResolvedValueOnce({ taskId: next.id, status: 'skipped', reason: 'design review did not align (conflict)' })
    await ensureTaskContinuation(storage, continuation.id)
    expect(storage.taskContinuations.findById(continuation.id)).toMatchObject({ status: 'failed', error: 'design review did not align (conflict)' })
    expect(storage.tasks.findById(next.id)?.status).toBe('blocked')
    expect(storage.auditLog.findByEntity('task_continuation', continuation.id)).toContainEqual(expect.objectContaining({ operation: 'task_continuation_failed', result: 'failure' }))
  })
})
