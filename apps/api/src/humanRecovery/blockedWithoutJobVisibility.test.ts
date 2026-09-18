/**
 * 「blocked かつ Job 0 件」を**見えるようにした**ことの検証。
 *
 * この状態は 2026-09-18 の read-only 調査で、`:memory:` storage に同じ状態を作って
 * `attention = []` / `resumeBlockedTask() = "No jobs exist for this task"` を実測した。
 * 直す対象は「復旧経路が無い」ことだけでなく、**誰にも見えない**ことでもある。
 *
 * 固定する invariant:
 *   1. blocked かつ Job 0 件の Task は attention に出る
 *   2. PL はそれを **notify-only** として扱う（診断も Gate も経ず、1回通知して終わる）
 *   3. 通知本文は「あなたの操作だけが解ける」ことを伝える
 *   4. 既存の attention の出方を変えていない
 */

import { describe, expect, it } from 'vitest'
import type { IStorage } from '../storage/interface'
import { createSQLiteStorage } from '../storage/sqlite'
import { buildSystemState } from '../state/systemState'
import { runPlTick, type PlLoopDeps } from '../pl/executionLoop'

function seedBlockedWithoutJob(options: {
  projectStatus?: 'running' | 'paused'
  withJob?: boolean
  parked?: boolean
} = {}): { storage: IStorage; taskId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS',
    goal: 'g',
    designPhilosophy: [],
    status: options.projectStatus ?? 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'continuation が非 retryable に skip した Task',
    description: 'body',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  } as Parameters<IStorage['tasks']['create']>[0])

  if (options.withJob === true) {
    storage.jobs.create({
      taskId: task.id,
      projectId: project.id,
      agentRole: 'developer_ai',
      status: 'blocked',
      safeCommand: { kind: 'noop' },
    } as never)
  }
  if (options.parked === true) {
    storage.auditLog.record({
      actor: 'api',
      operation: 'task_aborted',
      entityType: 'task',
      entityId: task.id,
      result: 'success',
      detail: 'parked',
    })
  }

  storage.tasks.update(task.id, { status: 'blocked' })
  return { storage, taskId: task.id }
}

function deps(over: Partial<PlLoopDeps> = {}): PlLoopDeps {
  return {
    escalate: async () => {},
    readLedger: () => '',
    diagnose: async () => {
      throw new Error('notify-only の attention で diagnose を呼んではならない')
    },
    proposeAdoption: async () => {
      throw new Error('attention が残っているうちは採用へ進んではならない')
    },
    ...over,
  }
}

describe('attention: task_blocked_without_job', () => {
  it('blocked かつ Job 0 件の Task が attention に出る', () => {
    const { storage, taskId } = seedBlockedWithoutJob()

    const state = buildSystemState(storage)

    expect(state.attention).toHaveLength(1)
    expect(state.attention[0]).toMatchObject({ kind: 'task_blocked_without_job', taskId })
  })

  it('Job があるものはこの kind では出さない（既存 job_blocked の担当のまま）', () => {
    const { storage } = seedBlockedWithoutJob({ withJob: true })

    const kinds = buildSystemState(storage).attention.map((item) => item.kind)

    expect(kinds).not.toContain('task_blocked_without_job')
    expect(kinds).toContain('job_blocked')
  })

  it('park された Task は出さない（解消できる者がいないものを鳴らし続けない）', () => {
    const { storage } = seedBlockedWithoutJob({ parked: true })

    expect(buildSystemState(storage).attention).toHaveLength(0)
  })

  it('running でない Project は出さない（CEO がまだ進めると決めていない）', () => {
    const { storage } = seedBlockedWithoutJob({ projectStatus: 'paused' })

    expect(buildSystemState(storage).attention).toHaveLength(0)
  })
})

describe('PL は task_blocked_without_job を通知するだけで、自分では解かない', () => {
  it('診断も Gate も経ずに1回だけ Escalate する', async () => {
    const { storage, taskId } = seedBlockedWithoutJob()
    const sent: Array<{ title: string; body: string }> = []

    const result = await runPlTick(storage, deps({
      escalate: async (payload) => { sent.push(payload) },
    }))

    expect(result.status).toBe('escalated')
    expect(result.target?.kind).toBe('task_blocked_without_job')
    expect(sent).toHaveLength(1)
    // **「あなたの操作だけが解ける」ことを伝える。**
    expect(sent[0].body).toContain('/recover')
    expect(sent[0].body).toContain('Job を1件も持っておらず')
    // PL は状態を動かしていない。
    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(0)
  })

  it('2 tick 目は通知を繰り返さない', async () => {
    const { storage } = seedBlockedWithoutJob()
    let sends = 0
    const d = deps({ escalate: async () => { sends += 1 } })

    await runPlTick(storage, d)
    const second = await runPlTick(storage, d)

    expect(sends).toBe(1)
    expect(second.status).toBe('idle')
  })
})
