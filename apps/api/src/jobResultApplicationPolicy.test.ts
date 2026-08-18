import { describe, expect, it } from 'vitest'
import { canApplyJobResultStatus, isTerminalJobStatus } from './jobResultApplicationPolicy'
import { createSQLiteStorage } from './storage/sqlite'
import type { IStorage } from './storage/interface'
import type { Job } from '@ai-team/shared'

/**
 * Result State Application Policy の検証。
 *
 * 契約:
 *   - 正当な再送・遅延resultはHTTP 200で受理する（at-least-onceを壊さない）
 *   - DB stateを変更してよいかだけを厳格に判定する
 *   - stale / duplicate は 200 + no-op
 *   - 不正なstate mutationは適用しない
 */

describe('canApplyJobResultStatus（allowed setは既存契約がSource of Truth）', () => {
  it('queuedからはrunningにもterminalにも進める', () => {
    expect(canApplyJobResultStatus('queued', 'running')).toBe(true)
    expect(canApplyJobResultStatus('queued', 'success')).toBe(true)
    expect(canApplyJobResultStatus('queued', 'failed')).toBe(true)
    expect(canApplyJobResultStatus('queued', 'blocked')).toBe(true)
  })

  it('runningからはterminalへ進める', () => {
    expect(canApplyJobResultStatus('running', 'success')).toBe(true)
    expect(canApplyJobResultStatus('running', 'failed')).toBe(true)
    expect(canApplyJobResultStatus('running', 'blocked')).toBe(true)
  })

  it('確定済みterminalは遅延resultで上書きされない', () => {
    expect(canApplyJobResultStatus('success', 'failed')).toBe(false)
    expect(canApplyJobResultStatus('failed', 'success')).toBe(false)
    expect(canApplyJobResultStatus('blocked', 'failed')).toBe(false)
    expect(canApplyJobResultStatus('blocked', 'success')).toBe(false)
  })

  it('requeue（→queued）は許可する', () => {
    expect(canApplyJobResultStatus('failed', 'queued')).toBe(true)
    expect(canApplyJobResultStatus('blocked', 'queued')).toBe(true)
    expect(canApplyJobResultStatus('running', 'queued')).toBe(true)
  })

  it('terminalからrunningへの復帰は許可しない', () => {
    expect(canApplyJobResultStatus('success', 'running')).toBe(false)
    expect(canApplyJobResultStatus('failed', 'running')).toBe(false)
    expect(canApplyJobResultStatus('blocked', 'running')).toBe(false)
  })

  it('同一statusはstate変更ではない', () => {
    expect(canApplyJobResultStatus('running', 'running')).toBe(false)
    expect(canApplyJobResultStatus('success', 'success')).toBe(false)
  })

  it('terminal判定は共通pure logicとして利用できる', () => {
    expect(isTerminalJobStatus('success')).toBe(true)
    expect(isTerminalJobStatus('failed')).toBe(true)
    expect(isTerminalJobStatus('blocked')).toBe(true)
    expect(isTerminalJobStatus('queued')).toBe(false)
    expect(isTerminalJobStatus('running')).toBe(false)
  })
})

describe('HTTP受理とstate適用の分離', () => {
  it('不正なtransition（terminal→running）は200で受理されるがstateを変えない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 'T', description: '', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [],
    })
    const job = storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai',
      status: 'queued', safeCommand: { kind: 'noop' },
    } as never)
    storage.jobs.update(job.id, { status: 'success' } as never)

    // policyが false を返す遷移は、呼び出し側でstatusを適用しない
    const from = storage.jobs.findById(job.id)!.status
    expect(canApplyJobResultStatus(from, 'running')).toBe(false)

    // 実際に適用しなければstateは変わらない
    const applied = canApplyJobResultStatus(from, 'running')
      ? storage.jobs.update(job.id, { status: 'running' } as never)
      : storage.jobs.findById(job.id)
    expect(applied!.status).toBe('success')
  })

  it('stale判定はstorage側でも二重に効く（provider timeoutはrunning以外へretryを作らない）', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 'T', description: '', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [],
    })
    const job = storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai',
      status: 'queued', safeCommand: { kind: 'noop' },
      aiCliMode: 'implement', aiCliProvider: 'claude_code', aiCliPrompt: 'p',
    } as never)

    const result = storage.jobs.persistProviderTimeoutFailure({
      jobId: job.id,
      update: {
        status: 'failed',
        failureMetadata: { kind: 'provider_timeout', workspaceState: 'unchanged' },
      } as never,
      outboxEvent: { eventId: 'evt-stale', payloadHash: 'h' },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // sourceがrunningでないためretryは作られない
      expect(result.retryJobCreated).toBe(false)
    }
    expect(storage.jobs.findByTaskId(task.id).filter((j: Job) => j.workflowStepKey?.startsWith('retry:'))).toHaveLength(0)
  })

  it('duplicate resultはOutbox冪等化で1回だけ反映される', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 'T', description: '', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [],
    })
    const job = storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai',
      status: 'running', safeCommand: { kind: 'noop' },
    } as never)

    const event = { eventId: 'evt-dup', payloadHash: 'h' }
    const first = storage.jobs.updateWithOutboxEvent(job.id, { status: 'failed', stderr: 'first' } as never, event)
    const second = storage.jobs.updateWithOutboxEvent(job.id, { status: 'failed', stderr: 'second' } as never, event)

    expect(first.ok && first.deduplicated).toBe(false)
    expect(second.ok && second.deduplicated).toBe(true)
    // 2回目は反映されない
    expect(storage.jobs.findById(job.id)!.stderr).toBe('first')
  })

  it('Outbox再送はretry stormにならない（再送してもJobは増えない）', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 'T', description: '', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [],
    })
    const job = storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai',
      status: 'running', safeCommand: { kind: 'noop' },
    } as never)

    const event = { eventId: 'evt-storm', payloadHash: 'h' }
    for (let i = 0; i < 10; i += 1) {
      storage.jobs.updateWithOutboxEvent(job.id, { status: 'failed' } as never, event)
    }

    expect(storage.jobs.findByTaskId(task.id)).toHaveLength(1)
  })
})

describe('stale terminal resultが新しい確定stateを上書きしない', () => {
  function seedJob(status: 'success' | 'failed' | 'blocked') {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 'T', description: '', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [],
    })
    const job = storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai',
      status: 'running', safeCommand: { kind: 'noop' },
    } as never)
    storage.jobs.update(job.id, { status, stderr: 'confirmed' } as never)
    return { storage, jobId: job.id }
  }

  /** PATCH経路と同じ判定でstatusを適用する（適用不可ならstatusを落とす）。 */
  function applyLateResult(
    storage: IStorage,
    jobId: string,
    update: Record<string, unknown>,
  ): Job {
    const existing = storage.jobs.findById(jobId)!
    const next = { ...update }
    const to = next.status as Job['status'] | undefined
    if (to !== undefined && to !== existing.status && !canApplyJobResultStatus(existing.status, to)) {
      delete next.status
    }
    return storage.jobs.update(jobId, next as never)!
  }

  it('success後に遅延failedが届いてもsuccessのまま', () => {
    const { storage, jobId } = seedJob('success')
    const after = applyLateResult(storage, jobId, { status: 'failed', stderr: 'late failure' })

    expect(after.status).toBe('success')
    // statusは守るが、他のフィールド（監査情報）は受理して記録できる
    expect(after.stderr).toBe('late failure')
  })

  it('failed後に遅延successが届いてもfailedのまま', () => {
    const { storage, jobId } = seedJob('failed')
    const after = applyLateResult(storage, jobId, { status: 'success', exitCode: 0 })

    expect(after.status).toBe('failed')
  })

  it('blocked後に遅延terminalが届いてもblockedのまま', () => {
    for (const late of ['success', 'failed'] as const) {
      const { storage, jobId } = seedJob('blocked')
      const after = applyLateResult(storage, jobId, { status: late })
      expect(after.status).toBe('blocked')
    }
  })

  it('requeueはterminalからでも適用される（API起点の明示的な再実行）', () => {
    for (const terminal of ['success', 'failed', 'blocked'] as const) {
      const { storage, jobId } = seedJob(terminal)
      const after = applyLateResult(storage, jobId, { status: 'queued' })
      expect(after.status).toBe('queued')
    }
  })

  it('queuedはまだ確定していないためterminal resultを適用する', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 'T', description: '', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [],
    })
    const job = storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai',
      status: 'queued', safeCommand: { kind: 'noop' },
    } as never)

    const after = applyLateResult(storage, job.id, { status: 'failed' })
    expect(after.status).toBe('failed')
  })
})
