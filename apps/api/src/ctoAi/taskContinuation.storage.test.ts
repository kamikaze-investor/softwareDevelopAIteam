import { describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'

describe('durable task continuation persistence', () => {
  it('atomically records git_commit success, source completion, and one next Task handoff', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'Continuation',
      goal: 'g',
      designPhilosophy: [],
      status: 'running',
    })
    const source = storage.tasks.create({ projectId: project.id, title: 'Source', description: '', status: 'pending', assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1 })
    const next = storage.tasks.create({
      projectId: project.id,
      title: 'Next',
      description: 'Implement next.',
      status: 'pending',
      assignee: 'developer_ai',
      dependencies: [source.id],
      roadmapActive: true,
      phase: 2,
    })
    const commit = storage.jobs.create({ taskId: source.id, projectId: project.id, agentRole: 'developer_ai', status: 'running', safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' } })

    const result = storage.jobs.persistCommitSuccessWithContinuation({
      jobId: commit.id,
      update: { status: 'success', exitCode: 0 },
      outboxEvent: { eventId: 'continuation-1', payloadHash: 'continuation-hash-1' },
    })

    expect(storage.jobs.findById(commit.id)?.status).toBe('success')
    expect(storage.tasks.findById(source.id)?.status).toBe('done')
    expect(result).toMatchObject({ ok: true, continuation: { sourceJobId: commit.id, completedTaskId: source.id, nextTaskId: next.id, status: 'pending' } })
  })
})
