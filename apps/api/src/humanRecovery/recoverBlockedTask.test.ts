/**
 * Human Recovery の契約。
 *
 * 固定する load-bearing invariant:
 *   1. **入口条件** — `blocked` かつ Job 0 件のときだけ受理する。Job があるものは
 *      既存 `resumeBlockedTask()` の責務であり、ここで二重の復旧経路を作らない
 *   2. **やることは1つだけ** — `blocked` → `pending` と audit 記録のみ。Job も Review も
 *      Approval も作らない（CEO 決定・2026-09-18「Implementation Job を直接生成せず」）
 *   3. **有界** — audit_log から数えた試行回数が上限に達したら断る
 *   4. **park を黙って取り消さない**
 *   5. **再投入後に何が動くかを正直に返す**（`nextDriver`）
 *   6. **PL から到達できない** — 語彙も配線も存在しない
 */

import { describe, expect, it } from 'vitest'
import type { IStorage } from '../storage/interface'
import { createSQLiteStorage } from '../storage/sqlite'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildInitialImplementAiCliPrompt } from '../ctoAi/initialImplementWorkflow'
import { PL_ACTION_KINDS } from '@ai-team/shared'
import { WORKER_ALLOWLIST } from '../auth/workerAllowlist'
import {
  countHumanRecoveryAttempts,
  MAX_HUMAN_RECOVERY_ATTEMPTS,
  recoverBlockedTask,
} from './recoverBlockedTask'

interface Seeded {
  storage: IStorage
  taskId: string
  projectId: string
}

function seed(options: {
  taskStatus?: 'pending' | 'blocked' | 'done'
  projectStatus?: 'running' | 'archived'
  roadmapTaskKey?: string
  withJob?: boolean
} = {}): Seeded {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS',
    goal: 'g',
    designPhilosophy: [],
    status: options.projectStatus ?? 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: '止まった Task',
    description: 'body',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: ['apps/api/src'],
    acceptanceCriteria: ['c'],
    ...(options.roadmapTaskKey !== undefined
      ? { roadmapTaskKey: options.roadmapTaskKey, phase: 1, roadmapActive: true }
      : {}),
  } as Parameters<IStorage['tasks']['create']>[0])

  if (options.withJob === true) {
    storage.jobs.create({
      taskId: task.id,
      projectId: project.id,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'noop' },
    } as never)
  }

  storage.tasks.update(task.id, { status: options.taskStatus ?? 'blocked' })
  return { storage, taskId: task.id, projectId: project.id }
}

/** その Task の直近 Design Review を CONFLICT で終端させる（Remediation 対象の形）。 */
function completeReviewAsConflict(storage: IStorage, taskId: string): void {
  const task = storage.tasks.findById(taskId)!
  const designText = buildInitialImplementAiCliPrompt(task)
  const run = storage.designReviewRuns.create({
    taskId,
    taskTitle: task.title,
    designText,
    designTextHash: computeDesignTextHash(designText),
    changedFiles: [],
  })
  const claimed = storage.designReviewRuns.claim(run.id, 3)
  storage.designReviewRuns.complete(
    run.id,
    claimed.claimToken as string,
    'succeeded',
    JSON.stringify({ focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }] }),
  )
}

describe('recoverBlockedTask — 入口条件', () => {
  it('blocked かつ Job 0 件のときに受理し、pending へ戻す', () => {
    const { storage, taskId } = seed()

    const result = recoverBlockedTask(storage, { taskId, reason: 'CONFLICT を確認したので再投入する' })

    expect(result.ok).toBe(true)
    expect(storage.tasks.findById(taskId)?.status).toBe('pending')
  })

  it('**Job を1件でも作らない。** 再投入するだけで、実装は既存ループに委ねる', () => {
    const { storage, taskId } = seed()

    recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(0)
    expect(storage.approvalRequests.findByTaskId(taskId)).toHaveLength(0)
  })

  it('Job を持つ Task は断り、既存 resume 経路へ案内する', () => {
    const { storage, taskId } = seed({ withJob: true })

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result).toMatchObject({ ok: false, code: 'TASK_HAS_JOBS' })
    expect(result.ok === false && result.reason).toContain('/resume')
    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
  })

  it('blocked でない Task は断る', () => {
    const { storage, taskId } = seed({ taskStatus: 'pending' })

    expect(recoverBlockedTask(storage, { taskId, reason: 'r' }))
      .toMatchObject({ ok: false, code: 'TASK_NOT_BLOCKED' })
  })

  it('存在しない Task は断る', () => {
    const { storage } = seed()

    expect(recoverBlockedTask(storage, { taskId: 'nope', reason: 'r' }))
      .toMatchObject({ ok: false, code: 'TASK_NOT_FOUND' })
  })

  it('archived Project の Task は断る', () => {
    const { storage, taskId } = seed({ projectStatus: 'archived' })

    expect(recoverBlockedTask(storage, { taskId, reason: 'r' }))
      .toMatchObject({ ok: false, code: 'PROJECT_UNAVAILABLE' })
  })

  it('park された Task は断る（復旧の副作用で park を取り消さない）', () => {
    const { storage, taskId } = seed()
    storage.auditLog.record({
      actor: 'api',
      operation: 'task_aborted',
      entityType: 'task',
      entityId: taskId,
      result: 'success',
      detail: 'parked by CEO',
    })

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result).toMatchObject({ ok: false, code: 'TASK_PARKED' })
    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
  })
})

describe('recoverBlockedTask — audit と有界性', () => {
  it('成功したときだけ audit を1行残す', () => {
    const { storage, taskId } = seed()

    recoverBlockedTask(storage, { taskId, reason: 'ledger 本文を訂正したので再投入' })

    const entries = storage.auditLog.findByEntity('task', taskId)
      .filter((entry) => entry.operation === 'task_human_recovered')
    expect(entries).toHaveLength(1)
    expect(entries[0].detail).toContain('ledger 本文を訂正したので再投入')
    expect(entries[0].result).toBe('success')
  })

  it('断ったときは audit を残さない（予算だけが減らない）', () => {
    const { storage, taskId } = seed({ withJob: true })

    recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(countHumanRecoveryAttempts(storage, taskId)).toBe(0)
  })

  it(`${MAX_HUMAN_RECOVERY_ATTEMPTS} 回を超えたら断り、別の手段を案内する`, () => {
    const { storage, taskId } = seed()

    for (let i = 0; i < MAX_HUMAN_RECOVERY_ATTEMPTS; i += 1) {
      const attempt = recoverBlockedTask(storage, { taskId, reason: `try ${i}` })
      expect(attempt).toMatchObject({ ok: true, attempt: i + 1 })
      // 次の試行のために、また Job 0 件の blocked へ戻す（Review が通らなかった状況の再現）。
      storage.tasks.update(taskId, { status: 'blocked' })
    }

    const exhausted = recoverBlockedTask(storage, { taskId, reason: 'もう一度' })
    expect(exhausted).toMatchObject({ ok: false, code: 'RECOVERY_BUDGET_EXHAUSTED' })
    expect(exhausted.ok === false && exhausted.reason).toContain('implementationScope')
    // 断られた以上、状態は動いていない。
    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
  })
})

describe('recoverBlockedTask — nextDriver は再投入後に何が動くかを正直に返す', () => {
  it('roadmap 採用 Task が CONFLICT で止まっていれば Independent Remediation が引き取る', () => {
    const { storage, taskId } = seed({ roadmapTaskKey: 'some-item' })
    completeReviewAsConflict(storage, taskId)

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result).toMatchObject({ ok: true, nextDriver: 'pl_independent_remediation' })
  })

  it('roadmap 由来でない Task は自動で動く経路が無く、attention だけになる', () => {
    const { storage, taskId } = seed()

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result).toMatchObject({ ok: true, nextDriver: 'attention_only' })
  })
})

describe('Human Recovery は AI/PL から到達できない（CEO 決定・2026-09-18）', () => {
  it('PL の action 語彙に Human Recovery が存在しない', () => {
    expect(PL_ACTION_KINDS.some((kind) => kind.includes('human'))).toBe(false)
    expect(PL_ACTION_KINDS).not.toContain('recover_task')
  })

  it('WORKER credential から recover route を呼べない（Default Deny のまま）', () => {
    expect(WORKER_ALLOWLIST.some((entry) => entry.url.includes('/recover'))).toBe(false)
  })
})
