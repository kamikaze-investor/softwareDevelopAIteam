import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Job } from '@ai-team/shared'
import { prepareRepairFlow } from './repairFlow'
import { repairStepKeyFor } from './repairPolicy'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import {
  executeQueuedRun,
  recoverAndRekickAtStartup,
  toExecuteDesignReviewResult,
} from './queuedRunDispatch'

/**
 * **U4 — queued run を正しい executor へ送る。**
 *
 * 固定する invariant:
 *
 *   repair 目的の queued run は、どの recovery 経路から拾われても
 *   `executeQueuedRepair` へ行き、repair Job を作る機会を失わない。
 *
 * これが無いと、kick を逃した repair run は汎用 executor に terminal 化され、
 * `findQueued()` に二度と現れなくなる（Checkpoint 1 の runtime E2E で実測）。
 */

const ALIGNED = JSON.stringify({
  focusedReviewResults: [],
  integrationReviewResult: { decision: 'ALIGNED' },
  finalDecision: 'ALIGNED',
})

/** runner 起動を数える deps。どの executor が走ったかは Job / evidence 側で見る。 */
function countingDeps(stdout: string = ALIGNED) {
  let spawns = 0
  return {
    spawns: () => spawns,
    deps: {
      runnerCommand: 'node',
      runnerArgs: [],
      homeDirectory: '/tmp',
      workingDir: '/tmp',
      execute: async () => {
        spawns += 1
        return { ok: true, stdout, timedOut: false }
      },
    },
  }
}

function seed(storage: IStorage): { taskId: string; projectId: string } {
  const project = storage.projects.create({
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

/** repair 目的の queued run（U1 により `repairSourceJobId` が durable）。 */
function seedQueuedRepairRun(storage: IStorage) {
  const ids = seed(storage)
  const failed = failedImplementJob(storage, ids)
  const preparation = prepareRepairFlow(storage, { failedJob: failed })
  if (preparation.action !== 'queue') throw new Error(`expected queue, got ${preparation.action}`)
  const run = storage.designReviewRuns.create(preparation.run)
  expect(run.repairSourceJobId).toBe(failed.id)
  return { ids, failed, run, stepKey: preparation.stepKey }
}

/** repair 目的でない queued run（従来の初回 implement review 相当）。 */
function seedQueuedPlainRun(storage: IStorage) {
  const ids = seed(storage)
  const designText = 'Design: plain review.'
  const run = storage.designReviewRuns.create({
    taskId: ids.taskId,
    taskTitle: 'T',
    designText,
    designTextHash: computeDesignTextHash(designText),
    // focus 集合は changedFiles から決まる（selectFocuses）。repair 側 fixture と
    // 揃えて、同じ ALIGNED stdout が両方で成立するようにする。
    changedFiles: ['docs/readme.md'],
  })
  expect(run.repairSourceJobId).toBeUndefined()
  return { ids, run }
}

const repairJobsOf = (storage: IStorage, taskId: string, stepKey: string): Job[] =>
  storage.jobs.findByTaskId(taskId).filter((j) => j.workflowStepKey === stepKey)

describe('U4: queued run は successor intent に従って dispatch される', () => {
  describe('T1 startup recovery', () => {
    it('repair 目的の queued run は startup recovery から repair executor へ行き、repair Job ができる', async () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run, stepKey } = seedQueuedRepairRun(storage)
      const { deps } = countingDeps()

      await recoverAndRekickAtStartup(storage, deps as never, '9999-12-31T00:00:00.000Z')

      // 汎用 executor だけが走った場合、run は terminal になるが repair Job は作られない。
      // **その差がこの1行**である。
      expect(repairJobsOf(storage, ids.taskId, stepKey)).toHaveLength(1)
      expect(storage.designReviewRuns.findById(run.id)?.status).toBe('succeeded')
    })
  })

  describe('T2 PL rekick', () => {
    it('PL の rekick 経路（executeQueuedRun 直呼び）でも repair executor へ行く', async () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run, stepKey } = seedQueuedRepairRun(storage)
      const { deps } = countingDeps()

      // PL の inline default が行うのと同じこと: runId から run を引いて dispatch する。
      const fetched = storage.designReviewRuns.findById(run.id)!
      const outcome = await executeQueuedRun(storage, fetched, deps as never)

      expect(outcome.kind).toBe('repair')
      expect(repairJobsOf(storage, ids.taskId, stepKey)).toHaveLength(1)
      // PL が受け取る形へ写像しても「何も起きなかった」にはならない。
      expect(toExecuteDesignReviewResult(outcome).status).not.toBe('stale')
    })
  })

  describe('T3 normal queued run', () => {
    it('repairSourceJobId が無い run は従来どおり汎用 executor で処理される', async () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run } = seedQueuedPlainRun(storage)
      const { deps, spawns } = countingDeps()

      const outcome = await executeQueuedRun(storage, run, deps as never)

      expect(outcome.kind).toBe('review')
      expect(spawns()).toBe(1)
      expect(storage.designReviewRuns.findById(run.id)?.status).toBe('succeeded')
      // 汎用 run は evidence を作るだけで Job を作らない（従来の挙動）。
      expect(storage.jobs.findByTaskId(ids.taskId)).toHaveLength(0)
      expect(storage.designReviewEvidence.findByTaskId(ids.taskId).length).toBeGreaterThan(0)
    })
  })

  describe('T4 repeated recovery', () => {
    it('startup recovery を繰り返しても repair Job は1件のまま', async () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, stepKey } = seedQueuedRepairRun(storage)
      const { deps } = countingDeps()

      await recoverAndRekickAtStartup(storage, deps as never, '9999-12-31T00:00:00.000Z')
      await recoverAndRekickAtStartup(storage, deps as never, '9999-12-31T00:00:00.000Z')
      await recoverAndRekickAtStartup(storage, deps as never, '9999-12-31T00:00:00.000Z')

      expect(repairJobsOf(storage, ids.taskId, stepKey)).toHaveLength(1)
    })
  })

  describe('T5 terminal exclusion', () => {
    it('terminal になった run は startup recovery が再 dispatch しない', async () => {
      const storage = createSQLiteStorage(':memory:')
      const { run } = seedQueuedRepairRun(storage)
      const { deps } = countingDeps()

      await recoverAndRekickAtStartup(storage, deps as never, '9999-12-31T00:00:00.000Z')
      const afterFirst = storage.designReviewRuns.findById(run.id)!
      expect(afterFirst.status).toBe('succeeded')
      const attemptsAfterFirst = afterFirst.attemptCount

      // terminal は findQueued() に出ないので、2回目は触らない。
      await recoverAndRekickAtStartup(storage, deps as never, '9999-12-31T00:00:00.000Z')

      expect(storage.designReviewRuns.findById(run.id)?.attemptCount).toBe(attemptsAfterFirst)
    })
  })

  describe('T6 missing source は fail closed', () => {
    it('repairSourceJobId はあるが source Job が引けない run を、汎用 executor へ落とさない', async () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const designText = 'Design: orphaned repair.'
      // U1 の列だけがある run。source Job は存在しない id を指す。
      const orphanSourceId = randomUUID()
      const run = storage.designReviewRuns.create({
        taskId: ids.taskId,
        taskTitle: 'T',
        designText,
        designTextHash: computeDesignTextHash(designText),
        changedFiles: [],
        repairSourceJobId: orphanSourceId,
      })
      const { deps, spawns } = countingDeps()

      const outcome = await executeQueuedRun(storage, run, deps as never)

      // **汎用 executor へ fallback しない。** 分岐条件は「source を解決できたか」ではなく
      // 「repairSourceJobId が記録されているか」である。
      expect(outcome.kind).toBe('repair')
      if (outcome.kind !== 'repair') return
      expect(outcome.outcome.status).toBe('escalated')
      // review そのものが走っていない（fail-closed は review より手前）。
      expect(spawns()).toBe(0)
      expect(storage.designReviewEvidence.findByTaskId(ids.taskId)).toHaveLength(0)
      // 既存 escalation semantics: Task が人へ渡る。
      expect(storage.tasks.findById(ids.taskId)?.status).toBe('blocked')
      // stepKey は列から決定的に導出されている。
      expect(repairStepKeyFor(orphanSourceId)).toBe(`repair:${orphanSourceId}:1`)
    })
  })

  describe('T7 Checkpoint 1 で実測した failure window の回帰', () => {
    it('queued repair-purpose run を持つ DB を開き直して startup recovery しても、repair Job を失わない', async () => {
      // Checkpoint 1（2026-09-25）で実際に起きたこと:
      //   queued repair-purpose run を持つ DB で API を起動する
      //     → startup recovery が findQueued() で拾う
      //     → 汎用 executor へ直行し、review だけ走って run が terminal 化
      //     → repair Job は作られず、run は findQueued() に二度と出ない
      // U4 後はこれが再現しないこと。process-local な文脈を持たない状態から開始する。
      const dbPath = path.join(os.tmpdir(), `u4-regression-${randomUUID()}.db`)

      const before = createSQLiteStorage(dbPath)
      const { ids, run, stepKey } = seedQueuedRepairRun(before)
      expect(before.designReviewRuns.findQueued()).toHaveLength(1)

      // ここから先は「再起動後のプロセス」。上の storage も preparation も参照しない。
      const after = createSQLiteStorage(dbPath)
      const { deps } = countingDeps()
      await recoverAndRekickAtStartup(after, deps as never, '9999-12-31T00:00:00.000Z')

      // 旧挙動では 0 件だった。
      expect(repairJobsOf(after, ids.taskId, stepKey)).toHaveLength(1)
      expect(after.designReviewRuns.findById(run.id)?.status).toBe('succeeded')
      expect(after.designReviewRuns.findQueued()).toHaveLength(0)
    })
  })

  describe('toExecuteDesignReviewResult の写像', () => {
    it('「何も起きなかった」だけを stale として落とす', () => {
      expect(toExecuteDesignReviewResult({
        kind: 'repair', outcome: { status: 'repair_job_created', jobId: 'j', stepKey: 's', attempt: 1 },
      }).status).toBe('evidence_registered')
      expect(toExecuteDesignReviewResult({
        kind: 'repair', outcome: { status: 'already_started', stepKey: 's' },
      }).status).toBe('not_claimable')
      expect(toExecuteDesignReviewResult({
        kind: 'repair', outcome: { status: 'escalated', reason: 'r' },
      }).status).toBe('failed')
      expect(toExecuteDesignReviewResult({
        kind: 'repair', outcome: { status: 'skipped', reason: 'r' },
      }).status).toBe('stale')
      // review 側はそのまま素通しする。
      expect(toExecuteDesignReviewResult({
        kind: 'review', result: { status: 'evidence_registered' },
      }).status).toBe('evidence_registered')
    })
  })
})
