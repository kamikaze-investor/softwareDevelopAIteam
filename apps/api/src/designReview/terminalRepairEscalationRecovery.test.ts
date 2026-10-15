import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSQLiteStorage } from '../storage/sqlite'
import type { DesignReviewRun, IStorage } from '../storage/interface'
import type { Job } from '@ai-team/shared'
import { prepareRepairFlow } from './repairFlow'
import { abortTask } from '../pl/abortTask'
import { recoverTerminalRepairSuccessors } from './terminalRepairSuccessorRecovery'
import {
  recoverTerminalRepairEscalation,
  recoverTerminalRepairEscalations,
} from './terminalRepairEscalationRecovery'

/**
 * **U3 — 却下で終端した repair run の Human escalation を着地させる。**
 *
 * 固定する invariant:
 *
 *   判定が ALIGNED でない terminal repair run は、escalation が落ちていても後から人へ渡る。
 *   そのとき Design Review は一度も起動せず、repair Job も作られない。
 *
 * これが無いと、却下は durable に残るのに Task は blocked にならず、`succeeded` な run は
 * attention producer（`idle` / `failed` しか見ない）にも現れないため、誰にも渡らず停止する。
 */

/** 本物の runner が返す ALIGNED 出力（focus を報告しない = changedFiles が focus を選ばない形）。 */
const ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [],
  integrationReviewResult: { decision: 'ALIGNED' },
  finalDecision: 'ALIGNED',
})

/** 本物の runner が返す CONFLICT 出力。`recomputeDecision()` は CONFLICT を組み直す。 */
const CONFLICT_STDOUT = JSON.stringify({
  focusedReviewResults: [],
  integrationReviewResult: { decision: 'CONFLICT' },
  finalDecision: 'CONFLICT',
})

/**
 * `ux_projects_single_running` は running な Project を 1 件しか許さない。
 * 複数 Task を同じ DB へ置くテストは**同じ Project の中に**作る必要がある。
 */
function seed(storage: IStorage, projectId?: string): { taskId: string; projectId: string } {
  const project = projectId !== undefined
    ? { id: projectId }
    : storage.projects.create({
        name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
      } as never)
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: 'd',
    status: 'in_progress', assignee: 'developer_ai', dependencies: [],
  } as never)
  return { taskId: task.id, projectId: project.id }
}

function failedImplementJob(storage: IStorage, ids: { taskId: string; projectId: string }): Job {
  const job = storage.jobs.create({
    taskId: ids.taskId, projectId: ids.projectId, agentRole: 'developer_ai', status: 'queued',
    safeCommand: { kind: 'noop' }, aiCliMode: 'implement',
    aiCliProvider: 'claude_code', aiCliPrompt: 'original prompt',
  } as never)
  return storage.jobs.update(job.id, {
    status: 'failed', exitCode: 1, stderr: 'TypeError: boom', changedFiles: ['docs/readme.md'],
  } as never)!
}

/**
 * **U3 の failure window をそのまま作る。**
 *
 * 本物の repair-purpose run を起こし、非 ALIGNED で終端させ、**`escalateTaskToHuman()` を
 * 呼ばずに止める**。これが「却下を書いた直後に process が落ちた」状態である。
 *
 * `withError` で production の 2 つの終端形を撃ち分ける:
 *   - true  … 形が壊れた入力の `reject()` 経路（`error` に理由が入る）
 *   - false … 正常な CONFLICT（task kind では `rejectedReason` が undefined → `error` NULL）
 */
function seedTerminalRejectedRepairRun(
  storage: IStorage,
  options: { withError: boolean; stdout?: string; projectId?: string } = { withError: false },
): { ids: { taskId: string; projectId: string }; source: Job; run: DesignReviewRun; stepKey: string } {
  const ids = seed(storage, options.projectId)
  const source = failedImplementJob(storage, ids)
  const preparation = prepareRepairFlow(storage, { failedJob: source })
  if (preparation.action !== 'queue') throw new Error(`expected queue, got ${preparation.action}`)

  const created = storage.designReviewRuns.create(preparation.run)
  const claimed = storage.designReviewRuns.claim(created.id, 3)
  if (!claimed.run || claimed.claimToken === undefined) throw new Error('fixture failed to claim')
  const fenced = storage.designReviewRuns.complete(
    created.id,
    claimed.claimToken,
    'succeeded',
    options.stdout ?? CONFLICT_STDOUT,
    options.withError ? 'focusedReviewResults has invalid shape' : undefined,
  )
  if (!fenced) throw new Error('fixture failed to complete')

  const run = storage.designReviewRuns.findById(created.id)!
  if (run.status !== 'succeeded') throw new Error(`fixture is not terminal succeeded: ${run.status}`)
  if (options.withError && run.error === undefined) throw new Error('fixture expected an error')
  if (!options.withError && run.error !== undefined) throw new Error('fixture expected no error')
  // escalation は**まだ着地していない**。
  if (storage.tasks.findById(ids.taskId)?.status === 'blocked') throw new Error('fixture already blocked')
  return { ids, source, run, stepKey: preparation.stepKey }
}

/** ALIGNED で終端した repair run（U2 の対象）。 */
function seedTerminalAlignedRepairRun(storage: IStorage, projectId?: string) {
  const ids = seed(storage, projectId)
  const source = failedImplementJob(storage, ids)
  const preparation = prepareRepairFlow(storage, { failedJob: source })
  if (preparation.action !== 'queue') throw new Error('fixture failed')
  const created = storage.designReviewRuns.create(preparation.run)
  const claimed = storage.designReviewRuns.claim(created.id, 3)
  const evidence = storage.designReviewRuns.completeWithEvidence(
    created.id, claimed.claimToken!, ALIGNED_STDOUT,
    {
      reviewKind: 'task', subjectId: ids.taskId, taskId: ids.taskId,
      designTextHash: created.designTextHash, reviewLoad: 'light',
      decision: 'ALIGNED', independentReviewRequired: false,
    } as never,
  )
  if (!evidence) throw new Error('fixture failed to register evidence')
  return { ids, source, run: storage.designReviewRuns.findById(created.id)!, stepKey: preparation.stepKey }
}

const repairJobsOf = (storage: IStorage, taskId: string, stepKey: string): Job[] =>
  storage.jobs.findByTaskId(taskId).filter((job) => job.workflowStepKey === stepKey)

/** abort_task と同じ経路で park する（DB を直接書き換えない）。 */
function park(storage: IStorage, taskId: string): void {
  storage.tasks.update(taskId, { status: 'pending', roadmapActive: true } as never)
  const request = storage.approvalRequests.create({
    taskId, requestedAction: 'abort_task', riskLevel: 'HIGH',
    targetBranch: 'ai/park', targetCommit: 'c', targetDiffHash: 'd',
    changedFiles: [], triggeredRules: [], invalidIf: ['commit changes'],
    status: 'WAITING_FOR_USER', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  } as never)
  storage.approvalRequests.updateStatus(request.id, 'APPROVED')
  const parked = abortTask(storage, { taskId, approvalRequestId: request.id, reason: 'parked' })
  if (!parked.ok || parked.status !== 'parked') throw new Error('fixture failed to park')
}

describe('U3: 却下で終端した repair run の escalation を着地させる', () => {
  describe('T1 shape A — error が記録された非 ALIGNED', () => {
    it('succeeded + error あり + repairSourceJobId → Task が blocked になる', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run } = seedTerminalRejectedRepairRun(storage, { withError: true })
      expect(run.error).toBeDefined()
      // shared read に出ることを明示する（旧 `error IS NULL` 条件では漏れていた形）。
      expect(storage.designReviewRuns.findTerminalRepairPurposeRuns().map((r) => r.id)).toEqual([run.id])

      const summary = recoverTerminalRepairEscalations(storage)

      expect(summary).toEqual({ scanned: 1, escalated: 1, skipped: 0, failed: 0 })
      expect(storage.tasks.findById(ids.taskId)?.status).toBe('blocked')
    })
  })

  describe('T2 shape B — error NULL の非 ALIGNED', () => {
    it('succeeded + error NULL でも判定が ALIGNED でなければ Task が blocked になる', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run } = seedTerminalRejectedRepairRun(storage, { withError: false })
      expect(run.error).toBeUndefined()

      const summary = recoverTerminalRepairEscalations(storage)

      expect(summary).toEqual({ scanned: 1, escalated: 1, skipped: 0, failed: 0 })
      expect(storage.tasks.findById(ids.taskId)?.status).toBe('blocked')
    })
  })

  describe('T3 review を再実行しない', () => {
    it('escalation は run も evidence も動かさない', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run } = seedTerminalRejectedRepairRun(storage)
      const before = storage.designReviewRuns.findById(run.id)!

      recoverTerminalRepairEscalations(storage)

      // **runner spawn = 0 は構造で保証**（この module は CoordinatorDeps を受け取らない）。
      // 観測可能な副作用でも確かめる: review が走れば evidence か attempt_count が動く。
      const after = storage.designReviewRuns.findById(run.id)!
      expect(after.attemptCount).toBe(before.attemptCount)
      expect(after.status).toBe('succeeded')
      expect(after.resultJson).toBe(before.resultJson)
      expect(storage.designReviewEvidence.findByTaskId(ids.taskId)).toHaveLength(0)
      // repair Job も作らない（それは U2 の action である）。
      expect(storage.jobs.findByTaskId(ids.taskId).filter((j) => j.workflowStepKey?.startsWith('repair:')))
        .toHaveLength(0)
    })
  })

  describe('T4 already escalated', () => {
    it('既に blocked な Task には何もしない', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run } = seedTerminalRejectedRepairRun(storage)
      storage.tasks.update(ids.taskId, { status: 'blocked' } as never)

      const outcome = recoverTerminalRepairEscalation(storage, run)

      expect(outcome.status).toBe('skipped')
      if (outcome.status === 'skipped') expect(outcome.reason).toContain('already blocked')
      expect(storage.tasks.findById(ids.taskId)?.status).toBe('blocked')
    })

    it('done な Task へ却下を持ち込まない', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run } = seedTerminalRejectedRepairRun(storage)
      storage.tasks.update(ids.taskId, { status: 'done' } as never)

      const outcome = recoverTerminalRepairEscalation(storage, run)

      expect(outcome.status).toBe('skipped')
      expect(storage.tasks.findById(ids.taskId)?.status).toBe('done')
    })
  })

  describe('T5 ALIGNED exclusion', () => {
    it('ALIGNED で終端した run（U2 の対象）を escalate しない', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run } = seedTerminalAlignedRepairRun(storage)
      // shared read には出る（U2/U3 が同じ母集団を見る）。
      expect(storage.designReviewRuns.findTerminalRepairPurposeRuns().map((r) => r.id)).toEqual([run.id])

      const summary = recoverTerminalRepairEscalations(storage)

      expect(summary).toEqual({ scanned: 1, escalated: 0, skipped: 1, failed: 0 })
      expect(storage.tasks.findById(ids.taskId)?.status).toBe('in_progress')
    })

    it('同じ DB で U2 と U3 を両方流しても、ALIGNED は repair Job・非 ALIGNED は escalation になる', () => {
      const storage = createSQLiteStorage(':memory:')
      const aligned = seedTerminalAlignedRepairRun(storage)
      const rejected = seedTerminalRejectedRepairRun(storage, {
        withError: false, projectId: aligned.ids.projectId,
      })

      const u2 = recoverTerminalRepairSuccessors(storage)
      const u3 = recoverTerminalRepairEscalations(storage)

      // 母集団は共有、action は分かれている。
      expect(u2.scanned).toBe(2)
      expect(u2.recovered).toBe(1)
      expect(u3.scanned).toBe(2)
      expect(u3.escalated).toBe(1)
      // ALIGNED 側: repair Job ができ、Task は blocked にならない。
      expect(repairJobsOf(storage, aligned.ids.taskId, aligned.stepKey)).toHaveLength(1)
      expect(storage.tasks.findById(aligned.ids.taskId)?.status).toBe('in_progress')
      // 非 ALIGNED 側: repair Job は無く、Task が blocked。
      expect(repairJobsOf(storage, rejected.ids.taskId, rejected.stepKey)).toHaveLength(0)
      expect(storage.tasks.findById(rejected.ids.taskId)?.status).toBe('blocked')
    })
  })

  describe('T6 successor exists', () => {
    it('repair Job が既に在る chain は escalate しない（止まっていない）', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run, stepKey } = seedTerminalRejectedRepairRun(storage)
      // 同じ chain の successor が既に実体化している状態を作る。
      storage.jobs.create({
        taskId: ids.taskId, projectId: ids.projectId, agentRole: 'developer_ai', status: 'queued',
        workflowStepKey: stepKey, safeCommand: { kind: 'noop' }, aiCliMode: 'implement',
        aiCliProvider: 'claude_code', aiCliPrompt: 'the successor that already exists',
      } as never)

      const outcome = recoverTerminalRepairEscalation(storage, run)

      expect(outcome.status).toBe('skipped')
      if (outcome.status === 'skipped') expect(outcome.reason).toContain('already exists')
      expect(storage.tasks.findById(ids.taskId)?.status).not.toBe('blocked')
    })
  })

  describe('T7 parked', () => {
    it('park 済み Task を blocked へ上げない', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run } = seedTerminalRejectedRepairRun(storage)
      park(storage, ids.taskId)

      const outcome = recoverTerminalRepairEscalation(storage, run)

      expect(outcome.status).toBe('skipped')
      if (outcome.status === 'skipped') expect(outcome.reason).toContain('parked')
      expect(storage.tasks.findById(ids.taskId)?.status).not.toBe('blocked')
    })
  })

  describe('T8 restart-equivalent', () => {
    it('process-local な文脈を持たず、DB を開き直しただけで成立する', () => {
      const dbPath = path.join(os.tmpdir(), `u3-restart-${randomUUID()}.db`)

      const before = createSQLiteStorage(dbPath)
      const { ids } = seedTerminalRejectedRepairRun(before)
      expect(before.tasks.findById(ids.taskId)?.status).not.toBe('blocked')

      // ここから先は「再起動後のプロセス」。上の storage も preparation も参照しない。
      const after = createSQLiteStorage(dbPath)
      const summary = recoverTerminalRepairEscalations(after)

      expect(summary.escalated).toBe(1)
      expect(after.tasks.findById(ids.taskId)?.status).toBe('blocked')
    })
  })

  describe('T9 repeated reconcile', () => {
    it('何度流しても副作用が増えない', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids } = seedTerminalRejectedRepairRun(storage)

      const first = recoverTerminalRepairEscalations(storage)
      const second = recoverTerminalRepairEscalations(storage)
      const third = recoverTerminalRepairEscalations(storage)

      expect(first).toEqual({ scanned: 1, escalated: 1, skipped: 0, failed: 0 })
      // 2 回目以降は「既に blocked」で候補から外れる。
      expect(second).toEqual({ scanned: 1, escalated: 0, skipped: 1, failed: 0 })
      expect(third).toEqual({ scanned: 1, escalated: 0, skipped: 1, failed: 0 })
      expect(storage.tasks.findById(ids.taskId)?.status).toBe('blocked')
      expect(storage.jobs.findByTaskId(ids.taskId).filter((j) => j.workflowStepKey?.startsWith('repair:')))
        .toHaveLength(0)
    })
  })

  describe('非 repair run は対象外', () => {
    it('repairSourceJobId が無い terminal run は shared read に出ない', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const designText = 'Design: plain review.'
      const created = storage.designReviewRuns.create({
        taskId: ids.taskId, taskTitle: 'T', designText,
        designTextHash: 'sha256:plain', changedFiles: ['docs/readme.md'],
      })
      const claimed = storage.designReviewRuns.claim(created.id, 3)
      storage.designReviewRuns.complete(created.id, claimed.claimToken!, 'succeeded', CONFLICT_STDOUT, undefined)

      expect(storage.designReviewRuns.findTerminalRepairPurposeRuns()).toHaveLength(0)
      expect(recoverTerminalRepairEscalations(storage))
        .toEqual({ scanned: 0, escalated: 0, skipped: 0, failed: 0 })
      expect(storage.tasks.findById(ids.taskId)?.status).toBe('in_progress')
    })
  })

  describe('failed run は shared read に出ない（design_review_failed attention の領分）', () => {
    it('status=failed の repair run を U3 が二重に escalate しない', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const source = failedImplementJob(storage, ids)
      const preparation = prepareRepairFlow(storage, { failedJob: source })
      if (preparation.action !== 'queue') throw new Error('fixture failed')
      const created = storage.designReviewRuns.create(preparation.run)
      const claimed = storage.designReviewRuns.claim(created.id, 3)
      expect(storage.designReviewRuns.complete(
        created.id, claimed.claimToken!, 'failed', undefined, 'runner timed out',
      )).toBe(true)
      expect(storage.designReviewRuns.findById(created.id)?.status).toBe('failed')

      expect(storage.designReviewRuns.findTerminalRepairPurposeRuns()).toHaveLength(0)
      expect(recoverTerminalRepairEscalations(storage).scanned).toBe(0)
      expect(storage.tasks.findById(ids.taskId)?.status).not.toBe('blocked')
    })
  })
})
