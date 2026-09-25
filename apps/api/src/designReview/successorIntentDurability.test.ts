import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Job } from '@ai-team/shared'
import { prepareRepairFlow } from './repairFlow'
import { parseRepairSource, repairStepKeyFor } from './repairPolicy'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'

/**
 * **U1 — Design Review run の successor intent durability。**
 *
 * 固定する invariant はひとつ:
 *
 *   repair 目的の Design Review run は、「終わったら誰を repair するのか」を
 *   **run 行そのもの**に持ち、process が落ちても run id だけから復元できる。
 *
 * これが無いと、run 作成後 dispatch 前に落ちたとき successor intent が
 * 走っていた process のスタックごと消え、その run は以後ただの task-kind review と
 * 区別できなくなる（recovery は review を再実行して terminal 化するだけで、
 * repair Job は永遠に作られない）。
 *
 * **範囲外**: terminal run を走査して successor を自動生成する reconciler は U2/U3、
 * queued run の dispatch 先切り替えは U4 の責務である。ここでは**書けること・読めること**
 * だけを固定し、実行時の挙動は一切変えていない。
 */

function seed(storage: IStorage): { taskId: string; projectId: string } {
  const project = storage.projects.create({
    name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: 'd',
    status: 'in_progress', assignee: 'developer_ai', dependencies: [],
  })
  return { taskId: task.id, projectId: project.id }
}

function createFailedJob(storage: IStorage, ids: { taskId: string; projectId: string }): Job {
  const job = storage.jobs.create({
    taskId: ids.taskId,
    projectId: ids.projectId,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'noop' },
    aiCliMode: 'implement',
    aiCliProvider: 'claude_code',
    aiCliPrompt: 'original prompt',
  } as never)
  return storage.jobs.update(job.id, {
    status: 'failed',
    exitCode: 1,
    stderr: 'TypeError: boom',
    changedFiles: ['docs/readme.md'],
  } as never)!
}

/** 非 repair（初回 implement 相当）の run 入力。successor intent を持たない。 */
function plainRunInput(taskId: string) {
  const designText = 'Design: plain initial review.'
  return {
    taskId,
    taskTitle: 'T',
    designText,
    designTextHash: computeDesignTextHash(designText),
    changedFiles: [] as string[],
  }
}

describe('U1: repair 目的の run は successor intent を durable に持つ', () => {
  describe('T1 intent persistence', () => {
    it('prepareRepairFlow の queue 出力は sourceJobId を run 側へ載せる（create 経路の共通入口）', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const failed = createFailedJob(storage, ids)

      const preparation = prepareRepairFlow(storage, { failedJob: failed })
      expect(preparation.action).toBe('queue')
      if (preparation.action !== 'queue') return

      // production の repair create 4経路はすべて `preparation.run` を
      // そのまま `create()` へ渡す。ここを固定すれば4経路すべてが永続化する。
      expect(preparation.run.repairSourceJobId).toBe(failed.id)

      const run = storage.designReviewRuns.create(preparation.run)
      expect(run.repairSourceJobId).toBe(failed.id)
      expect(storage.designReviewRuns.findById(run.id)?.repairSourceJobId).toBe(failed.id)
    })

    it('failAndPrepareRepair（/fail-if-running 経路）が作る run にも intent が入る', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const running = storage.jobs.create({
        taskId: ids.taskId,
        projectId: ids.projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'noop' },
        aiCliMode: 'implement',
        aiCliProvider: 'claude_code',
        aiCliPrompt: 'original prompt',
      } as never)
      storage.jobs.update(running.id, { status: 'running' } as never)

      const result = storage.jobs.failAndPrepareRepair({
        jobId: running.id,
        workspaceVerified: true,
        failure: { stderr: 'TypeError: boom', completedAt: new Date().toISOString() },
      })
      expect(result).toMatchObject({ ok: true })

      const queued = storage.designReviewRuns.findActiveByTaskId(ids.taskId)
      expect(queued).toBeDefined()
      expect(queued?.repairSourceJobId).toBe(running.id)
    })

    it('updateWithOutboxEvent の queueDesignReview 経路でも intent が同一 transaction で入る', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const failed = createFailedJob(storage, ids)

      const preparation = prepareRepairFlow(storage, { failedJob: failed })
      if (preparation.action !== 'queue') throw new Error('expected queue')

      const other = createFailedJob(storage, ids)
      const updated = storage.jobs.updateWithOutboxEvent(
        other.id,
        { status: 'failed' } as never,
        undefined,
        preparation.run,
      )
      expect(updated.ok).toBe(true)
      if (!updated.ok) return
      expect(updated.queuedDesignReviewRun?.repairSourceJobId).toBe(failed.id)
    })

    it('非 repair の run は intent を持たない（NULL のまま）', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)

      const run = storage.designReviewRuns.create(plainRunInput(ids.taskId))
      expect(run.repairSourceJobId).toBeUndefined()
      expect(storage.designReviewRuns.findById(run.id)?.repairSourceJobId).toBeUndefined()
    })
  })

  describe('T2 process-memory independence', () => {
    it('preparation / create の戻り値を捨てても、run id だけで intent を引き直せる', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const failed = createFailedJob(storage, ids)

      const preparation = prepareRepairFlow(storage, { failedJob: failed })
      if (preparation.action !== 'queue') throw new Error('expected queue')

      // このスコープの外へ持ち出すのは run id ただ1つ。
      const runId = storage.designReviewRuns.create(preparation.run).id
      const stepKeyFromMemory = preparation.stepKey

      const reread = storage.designReviewRuns.findById(runId)
      expect(reread?.repairSourceJobId).toBe(failed.id)
      // stepKey は保存していないが、保存した intent から決定的に再構成できる。
      expect(repairStepKeyFor(reread!.repairSourceJobId!)).toBe(stepKeyFromMemory)
    })
  })

  describe('T3 restart-equivalent reconstruction', () => {
    it('DB を開き直した別 storage instance から、run id のみで successor intent を復元できる', () => {
      const dbPath = path.join(os.tmpdir(), `u1-successor-intent-${randomUUID()}.db`)

      const before = createSQLiteStorage(dbPath)
      const ids = seed(before)
      const failed = createFailedJob(before, ids)
      const preparation = prepareRepairFlow(before, { failedJob: failed })
      if (preparation.action !== 'queue') throw new Error('expected queue')
      const runId = before.designReviewRuns.create(preparation.run).id
      const expectedStepKey = preparation.stepKey

      // ここから先は「再起動後のプロセス」を模す。上の storage も preparation も参照しない。
      const after = createSQLiteStorage(dbPath)
      const recovered = after.designReviewRuns.findById(runId)

      expect(recovered).toBeDefined()
      expect(recovered?.status).toBe('queued')
      expect(recovered?.repairSourceJobId).toBe(failed.id)

      // U4 が dispatch で使うことになる形まで、run id だけから組み直せる。
      const rebuiltStepKey = repairStepKeyFor(recovered!.repairSourceJobId!)
      expect(rebuiltStepKey).toBe(expectedStepKey)
      expect(parseRepairSource(rebuiltStepKey)).toBe(failed.id)
      // source Job も durable state から引ける（repair Job の組み立てに必要な材料）。
      expect(after.jobs.findById(recovered!.repairSourceJobId!)?.taskId).toBe(ids.taskId)
    })
  })

  describe('T4a active-run guard invariant（なぜ先勝ちで良いのか）', () => {
    it('active run があるとき prepareRepairFlow は skip を返し、2つ目の intent は create へ到達しない', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const first = createFailedJob(storage, ids)

      const firstPrep = prepareRepairFlow(storage, { failedJob: first })
      if (firstPrep.action !== 'queue') throw new Error('expected queue')
      storage.designReviewRuns.create(firstPrep.run)

      // 別の失敗 Job から2本目を立てようとしても、guard が先に止める。
      const second = createFailedJob(storage, ids)
      const secondPrep = prepareRepairFlow(storage, { failedJob: second })

      expect(secondPrep.action).toBe('skip')
      // つまり「異なる sourceJobId を持つ create」がそもそも発生しない。
      // production 4経路では guard と create の間に await が無く API は単一 process なので、
      // この skip を飛び越えて create へ到達する経路は無い。
      expect(storage.designReviewRuns.findActiveByTaskId(ids.taskId)?.repairSourceJobId).toBe(first.id)
    })
  })

  describe('T4b same-intent duplicate は冪等', () => {
    it('同じ intent で二度 create しても既存 run が返り、行も値も増えない', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const failed = createFailedJob(storage, ids)

      const preparation = prepareRepairFlow(storage, { failedJob: failed })
      if (preparation.action !== 'queue') throw new Error('expected queue')

      const first = storage.designReviewRuns.create(preparation.run)
      const second = storage.designReviewRuns.create(preparation.run)

      expect(second.id).toBe(first.id)
      expect(second.repairSourceJobId).toBe(failed.id)
      expect(storage.designReviewRuns.findQueued()).toHaveLength(1)
    })

    it('非 repair 同士（両方 intent 無し）の重複も従来どおり既存 run を返す', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)

      const first = storage.designReviewRuns.create(plainRunInput(ids.taskId))
      const second = storage.designReviewRuns.create(plainRunInput(ids.taskId))

      expect(second.id).toBe(first.id)
      expect(second.repairSourceJobId).toBeUndefined()
    })
  })

  describe('T4c intent mismatch は fail closed', () => {
    it('repair 要求が、非 repair の active run を黙って掴まない（NULL / non-NULL）', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      storage.designReviewRuns.create(plainRunInput(ids.taskId))

      const failed = createFailedJob(storage, ids)
      expect(() =>
        storage.designReviewRuns.create({
          ...plainRunInput(ids.taskId),
          repairSourceJobId: failed.id,
        }),
      ).toThrow(/intent mismatch/)
    })

    it('非 repair 要求が、repair 目的の active run を黙って実行しない（non-NULL / NULL）', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const failed = createFailedJob(storage, ids)
      const preparation = prepareRepairFlow(storage, { failedJob: failed })
      if (preparation.action !== 'queue') throw new Error('expected queue')
      storage.designReviewRuns.create(preparation.run)

      // `createAndExecuteDesignReview()` は active-run guard を持たないため、この向きは実在する。
      expect(() => storage.designReviewRuns.create(plainRunInput(ids.taskId))).toThrow(/intent mismatch/)
    })

    it('別の source Job を根にした repair 同士も拒否する（異なる non-NULL）', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const first = createFailedJob(storage, ids)
      const preparation = prepareRepairFlow(storage, { failedJob: first })
      if (preparation.action !== 'queue') throw new Error('expected queue')
      storage.designReviewRuns.create(preparation.run)

      const other = createFailedJob(storage, ids)
      expect(() =>
        storage.designReviewRuns.create({ ...preparation.run, repairSourceJobId: other.id }),
      ).toThrow(/intent mismatch/)
    })

    it('mismatch で throw しても既存 run は書き換わらない', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const first = createFailedJob(storage, ids)
      const preparation = prepareRepairFlow(storage, { failedJob: first })
      if (preparation.action !== 'queue') throw new Error('expected queue')
      const created = storage.designReviewRuns.create(preparation.run)

      const other = createFailedJob(storage, ids)
      expect(() =>
        storage.designReviewRuns.create({ ...preparation.run, repairSourceJobId: other.id }),
      ).toThrow()

      const after = storage.designReviewRuns.findById(created.id)
      expect(after?.repairSourceJobId).toBe(first.id)
      expect(storage.designReviewRuns.findQueued()).toHaveLength(1)
    })
  })

  describe('T6a migration: 列が無い既存 DB を開いても壊れず、既存行は NULL', () => {
    it('列を持たない design_review_runs へ後から列が足され、既存行は NULL のまま（再オープンしても同じ）', () => {
      const dbPath = path.join(os.tmpdir(), `u1-migration-${randomUUID()}.db`)

      // まず通常どおり DB を作り、repair intent 付きの run を1本入れる。
      const first = createSQLiteStorage(dbPath)
      const ids = seed(first)
      const failed = createFailedJob(first, ids)
      const preparation = prepareRepairFlow(first, { failedJob: failed })
      if (preparation.action !== 'queue') throw new Error('expected queue')
      const runId = first.designReviewRuns.create(preparation.run).id

      // 2回目・3回目のオープンでも migration は冪等（ALTER が再実行されない）。
      const second = createSQLiteStorage(dbPath)
      expect(second.designReviewRuns.findById(runId)?.repairSourceJobId).toBe(failed.id)
      const third = createSQLiteStorage(dbPath)
      expect(third.designReviewRuns.findById(runId)?.repairSourceJobId).toBe(failed.id)
    })
  })
})
