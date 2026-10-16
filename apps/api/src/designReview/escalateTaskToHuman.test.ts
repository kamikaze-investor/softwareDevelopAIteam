import { describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { escalateTaskToHuman } from './repairFlow'

/**
 * L5（b8d0fc5d 監査）: escalation は理由を audit に残し、`done` の Task を blocked へ戻さない。
 */

function seed(status: string): { storage: IStorage; taskId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: 'd',
    status,
    assignee: 'developer_ai',
    dependencies: [],
  } as never)
  return { storage, taskId: task.id }
}

const escalations = (storage: IStorage, taskId: string) =>
  storage.auditLog.findByEntity('task', taskId).filter((entry) => entry.operation === 'task_escalated_to_human')

describe('escalateTaskToHuman', () => {
  it('pending の Task を blocked にし、理由を task_escalated_to_human として残す', () => {
    const { storage, taskId } = seed('pending')

    escalateTaskToHuman(storage, taskId, 'repair attempts reached the limit (3)')

    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
    const rows = escalations(storage, taskId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.result).toBe('blocked')
    expect(rows[0]!.detail).toBe('reason=repair attempts reached the limit (3)')
  })

  it('done の Task は動かさない（audit には not_moved_done を残す）', () => {
    const { storage, taskId } = seed('done')

    escalateTaskToHuman(storage, taskId, 'late review escalation')

    expect(storage.tasks.findById(taskId)?.status).toBe('done')
    expect(escalations(storage, taskId).map((row) => row.result)).toEqual(['not_moved_done'])
  })

  it('既に blocked の Task でも escalation の理由は残る', () => {
    const { storage, taskId } = seed('blocked')

    escalateTaskToHuman(storage, taskId)

    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
    const rows = escalations(storage, taskId)
    expect(rows.map((row) => row.result)).toEqual(['already_blocked'])
    expect(rows[0]!.detail).toBe('reason=unspecified')
  })
})
