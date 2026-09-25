import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSQLiteStorage } from '../storage/sqlite'
import type { DesignReviewRun, IStorage } from '../storage/interface'
import type { Job } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { executeQueuedRepair, prepareRepairFlow } from './repairFlow'
import { repairStepKeyFor } from './repairPolicy'
import { abortTask } from '../pl/abortTask'
import {
  recoverTerminalRepairSuccessor,
  recoverTerminalRepairSuccessors,
} from './terminalRepairSuccessorRecovery'

/**
 * **U2 — ALIGNED 終端した repair-purpose run の successor 回収。**
 *
 * 固定する invariant:
 *
 *   ALIGNED evidence が durable に残っているなら、handoff の手前で落ちても
 *   repair Job は後から作られる。そのとき Design Review は一度も起動しない。
 *
 * これが無いと、run は terminal なので `findQueued()` に現れず、U4 の dispatcher も
 * `claim()` に拒まれて入れないため、**repair Job を作る機会そのものが消える。**
 */

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

/** 実装が失敗した source Job（通常の Stage 2 の入口）。 */
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
 * **U2 の failure window をそのまま作る。**
 *
 * `prepareRepairFlow()` で本物の repair-purpose run を起こし、`completeWithEvidence()` で
 * ALIGNED 終端させ、**repair Job を作らずに止める**。これが「evidence を書いた直後に
 * process が落ちた」状態である。DB を直接書き換えず、production と同じ storage API だけを通す。
 */
function seedTerminalAlignedRepairRun(
  storage: IStorage,
  sourceJobFactory: (s: IStorage, ids: { taskId: string; projectId: string }) => Job = failedImplementJob,
): { ids: { taskId: string; projectId: string }; source: Job; run: DesignReviewRun; stepKey: string } {
  const ids = seed(storage)
  const source = sourceJobFactory(storage, ids)
  const preparation = prepareRepairFlow(storage, { failedJob: source })
  if (preparation.action !== 'queue') throw new Error(`expected queue, got ${preparation.action}`)

  const created = storage.designReviewRuns.create(preparation.run)
  const claimed = storage.designReviewRuns.claim(created.id, 3)
  if (!claimed.run || claimed.claimToken === undefined) throw new Error('fixture failed to claim')
  const evidence = storage.designReviewRuns.completeWithEvidence(
    created.id,
    claimed.claimToken,
    ALIGNED_STDOUT,
    {
      reviewKind: 'task',
      subjectId: ids.taskId,
      taskId: ids.taskId,
      designTextHash: created.designTextHash,
      reviewLoad: 'light',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    } as never,
  )
  if (!evidence) throw new Error('fixture failed to register evidence')

  const run = storage.designReviewRuns.findById(created.id)!
  if (run.status !== 'succeeded' || run.error !== undefined) {
    throw new Error(`fixture is not an aligned terminal run: ${run.status} / ${String(run.error)}`)
  }
  return { ids, source, run, stepKey: preparation.stepKey }
}

/**
 * 本物の runner が返す ALIGNED 出力。**`{"finalDecision":"ALIGNED"}` では足りない** ——
 * `safeRecomputedDecision()` は focus 判定から結論を組み直すので、report された focus 集合が
 * `selectFocuses(reviewLoad, changedFiles)` と一致しないと UNCERTAIN になる。fixture の
 * changedFiles は `docs/readme.md` で focus が選ばれないため、空の focus 集合で成立する。
 */
const ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [],
  integrationReviewResult: { decision: 'ALIGNED' },
  finalDecision: 'ALIGNED',
})

const repairJobsOf = (storage: IStorage, taskId: string, stepKey: string): Job[] =>
  storage.jobs.findByTaskId(taskId).filter((job) => job.workflowStepKey === stepKey)

describe('U2: ALIGNED 終端した repair run の successor を回収する', () => {
  describe('T1 exact U2', () => {
    it('evidence があり repair Job が 0 件の terminal run から、repair Job が 1 件作られる', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run, stepKey } = seedTerminalAlignedRepairRun(storage)
      // 前提: この時点で successor は無く、queued run としても拾えない。
      expect(repairJobsOf(storage, ids.taskId, stepKey)).toHaveLength(0)
      expect(storage.designReviewRuns.findQueued()).toHaveLength(0)
      expect(storage.designReviewRuns.findAlignedRepairPurposeTerminal().map((r) => r.id)).toEqual([run.id])

      const summary = recoverTerminalRepairSuccessors(storage)

      expect(summary).toEqual({ scanned: 1, recovered: 1, skipped: 0, escalated: 0, failed: 0 })
      const created = repairJobsOf(storage, ids.taskId, stepKey)
      expect(created).toHaveLength(1)
      expect(created[0]!.status).toBe('queued')
      expect(created[0]!.aiCliMode).toBe('implement')
      // stepKey は列から決定的に導出されている。
      expect(created[0]!.workflowStepKey).toBe(`repair:${run.repairSourceJobId!}:1`)
      // review 済み prompt がそのまま渡る（作り直さない）。
      expect(created[0]!.aiCliPrompt).toBe(run.designText)
    })
  })

  describe('T2 review を再実行しない', () => {
    it('回収は runner を起動せず、evidence も増やさない', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids } = seedTerminalAlignedRepairRun(storage)
      const evidenceBefore = storage.designReviewEvidence.findByTaskId(ids.taskId).length
      const runBefore = storage.designReviewRuns.findAlignedRepairPurposeTerminal()[0]!

      recoverTerminalRepairSuccessors(storage)

      // **runner spawn = 0 は構造で保証されている**（この module は CoordinatorDeps を
      // 受け取らないので runner を起動する手段が無い）。観測可能な副作用でも確かめる:
      // review が走れば evidence か attempt_count のどちらかが必ず動く。
      expect(storage.designReviewEvidence.findByTaskId(ids.taskId)).toHaveLength(evidenceBefore)
      const runAfter = storage.designReviewRuns.findById(runBefore.id)!
      expect(runAfter.attemptCount).toBe(runBefore.attemptCount)
      expect(runAfter.status).toBe('succeeded')
      expect(runAfter.resultJson).toBe(runBefore.resultJson)
    })
  })

  describe('T3 repeated reconcile', () => {
    it('何度回収しても repair Job は 1 件のまま', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, stepKey } = seedTerminalAlignedRepairRun(storage)

      const first = recoverTerminalRepairSuccessors(storage)
      const second = recoverTerminalRepairSuccessors(storage)
      const third = recoverTerminalRepairSuccessors(storage)

      expect(first.recovered).toBe(1)
      // 2 回目以降は「既に在る」ので skipped。escalation にはしない。
      expect(second).toEqual({ scanned: 1, recovered: 0, skipped: 1, escalated: 0, failed: 0 })
      expect(third).toEqual({ scanned: 1, recovered: 0, skipped: 1, escalated: 0, failed: 0 })
      expect(repairJobsOf(storage, ids.taskId, stepKey)).toHaveLength(1)
      expect(storage.tasks.findById(ids.taskId)?.status).toBe('in_progress')
    })
  })

  describe('T4 already recovered', () => {
    it('successor が既に存在する terminal run は no-op（already_started）', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run, stepKey } = seedTerminalAlignedRepairRun(storage)
      // 先に successor を作ってしまう（= 落ちる前に handoff が完了していた場合）。
      recoverTerminalRepairSuccessors(storage)
      const existing = repairJobsOf(storage, ids.taskId, stepKey)[0]!

      const outcome = recoverTerminalRepairSuccessor(storage, storage.designReviewRuns.findById(run.id)!)

      expect(outcome.status).toBe('already_started')
      expect(repairJobsOf(storage, ids.taskId, stepKey).map((j) => j.id)).toEqual([existing.id])
    })
  })

  describe('T5 non-repair terminal', () => {
    it('repairSourceJobId が無い terminal run は候補に入らない', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const designText = 'Design: plain review.'
      const created = storage.designReviewRuns.create({
        taskId: ids.taskId, taskTitle: 'T', designText,
        designTextHash: computeDesignTextHash(designText), changedFiles: ['docs/readme.md'],
      })
      expect(created.repairSourceJobId).toBeUndefined()
      const claimed = storage.designReviewRuns.claim(created.id, 3)
      storage.designReviewRuns.completeWithEvidence(
        created.id, claimed.claimToken!, ALIGNED_STDOUT,
        {
          reviewKind: 'task', subjectId: ids.taskId, taskId: ids.taskId,
          designTextHash: created.designTextHash, reviewLoad: 'light',
          decision: 'ALIGNED', independentReviewRequired: false,
        } as never,
      )

      // **推測で repair 目的として扱わない。** query の段階で落ちる。
      expect(storage.designReviewRuns.findAlignedRepairPurposeTerminal()).toHaveLength(0)
      expect(recoverTerminalRepairSuccessors(storage))
        .toEqual({ scanned: 0, recovered: 0, skipped: 0, escalated: 0, failed: 0 })
      expect(storage.jobs.findByTaskId(ids.taskId)).toHaveLength(0)
    })
  })

  describe('T6 missing source は fail closed', () => {
    it('source Job が引けない terminal run を、review 経路へ流さず人へ渡す', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const designText = 'Design: orphaned repair.'
      const orphanSourceId = randomUUID()
      const created = storage.designReviewRuns.create({
        taskId: ids.taskId, taskTitle: 'T', designText,
        designTextHash: computeDesignTextHash(designText), changedFiles: ['docs/readme.md'],
        repairSourceJobId: orphanSourceId,
      })
      const claimed = storage.designReviewRuns.claim(created.id, 3)
      storage.designReviewRuns.completeWithEvidence(
        created.id, claimed.claimToken!, ALIGNED_STDOUT,
        {
          reviewKind: 'task', subjectId: ids.taskId, taskId: ids.taskId,
          designTextHash: created.designTextHash, reviewLoad: 'light',
          decision: 'ALIGNED', independentReviewRequired: false,
        } as never,
      )

      const summary = recoverTerminalRepairSuccessors(storage)

      expect(summary).toEqual({ scanned: 1, recovered: 0, skipped: 0, escalated: 1, failed: 0 })
      // Job も evidence も増やさない（review へ落ちていない）。
      expect(storage.jobs.findByTaskId(ids.taskId)).toHaveLength(0)
      expect(storage.designReviewEvidence.findByTaskId(ids.taskId)).toHaveLength(1)
      // 既存 escalation semantics: Task が人へ渡る。
      expect(storage.tasks.findById(ids.taskId)?.status).toBe('blocked')
      expect(repairStepKeyFor(orphanSourceId)).toBe(`repair:${orphanSourceId}:1`)
    })
  })

  describe('T7 successful source preservation', () => {
    it('source Job が success のまま回収でき、成功記録が壊れない', () => {
      const storage = createSQLiteStorage(':memory:')
      // review が changes_requested を返した通常の Stage 2 と同じ形（#290 の対象経路）。
      const { ids, source, stepKey } = seedTerminalAlignedRepairRun(storage, (s, seeded) => {
        const job = s.jobs.create({
          taskId: seeded.taskId, projectId: seeded.projectId, agentRole: 'developer_ai',
          status: 'queued', safeCommand: { kind: 'noop' }, aiCliMode: 'implement',
          aiCliProvider: 'claude_code', aiCliPrompt: 'original prompt',
        } as never)
        return s.jobs.update(job.id, {
          status: 'success', exitCode: 0, stdout: 'implementation finished',
          changedFiles: ['docs/readme.md'],
        } as never)!
      })
      expect(storage.jobs.findById(source.id)?.status).toBe('success')

      const summary = recoverTerminalRepairSuccessors(storage)

      expect(summary.recovered).toBe(1)
      expect(repairJobsOf(storage, ids.taskId, stepKey)).toHaveLength(1)
      // **#290 の semantics に依存している。** source は非所有な終端なので触らない。
      const after = storage.jobs.findById(source.id)!
      expect(after.status).toBe('success')
      expect(after.exitCode).toBe(0)
      expect(after.stdout).toBe('implementation finished')
    })
  })

  describe('T8 restart-equivalent', () => {
    it('process-local な文脈を持たず、DB を開き直しただけで回収が成立する', () => {
      const dbPath = path.join(os.tmpdir(), `u2-restart-${randomUUID()}.db`)

      const before = createSQLiteStorage(dbPath)
      const { ids, stepKey } = seedTerminalAlignedRepairRun(before)
      expect(repairJobsOf(before, ids.taskId, stepKey)).toHaveLength(0)

      // ここから先は「再起動後のプロセス」。上の storage も preparation も参照しない。
      const after = createSQLiteStorage(dbPath)
      const summary = recoverTerminalRepairSuccessors(after)

      expect(summary.recovered).toBe(1)
      expect(repairJobsOf(after, ids.taskId, stepKey)).toHaveLength(1)
    })
  })

  describe('U3 境界: 非 ALIGNED 終端は U2 の対象外', () => {
    it('error が記録された terminal run（非 ALIGNED）は候補に入らない', () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const source = failedImplementJob(storage, ids)
      const preparation = prepareRepairFlow(storage, { failedJob: source })
      if (preparation.action !== 'queue') throw new Error('fixture failed')
      const created = storage.designReviewRuns.create(preparation.run)
      const claimed = storage.designReviewRuns.claim(created.id, 3)
      // 非 ALIGNED の終端形: status は succeeded だが error に理由が入り、evidence は作られない。
      expect(storage.designReviewRuns.complete(
        created.id, claimed.claimToken!, 'succeeded', '{"finalDecision":"CONFLICT"}', 'not aligned',
      )).toBe(true)
      expect(storage.designReviewRuns.findById(created.id)?.error).toBe('not aligned')

      expect(storage.designReviewRuns.findAlignedRepairPurposeTerminal()).toHaveLength(0)
      expect(recoverTerminalRepairSuccessors(storage).scanned).toBe(0)
      expect(repairJobsOf(storage, ids.taskId, preparation.stepKey)).toHaveLength(0)
    })

    /**
     * **production 形の非 ALIGNED。** 上のテストは `complete()` に error 文字列を渡して
     * いたが、それは production の task kind では起きない形だった:
     * `recomputeDecision()` が `rejectedReason` を埋めるのは `reviewKind === 'roadmap'`
     * のときだけなので、**task kind の非 ALIGNED は `error IS NULL` で終端する**
     * （2026-09-25 独立レビュー指摘）。
     *
     * よって query の `error IS NULL` だけでは非 ALIGNED を排除できない。
     * ここで固定するのは「query には出るが、run 自身の判定が ALIGNED でないので
     * 回収しない」という**実際に効いている防御**である。
     */
    it('task kind の非 ALIGNED は error が NULL のまま終端するが、それでも回収しない', async () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
      const source = failedImplementJob(storage, ids)
      const preparation = prepareRepairFlow(storage, { failedJob: source })
      if (preparation.action !== 'queue') throw new Error('fixture failed')
      const run = storage.designReviewRuns.create(preparation.run)

      // 本物の coordinator 経路で CONFLICT を返させ、production と同じ終端形を作る。
      const conflictStdout = JSON.stringify({
        focusedReviewResults: [],
        integrationReviewResult: { decision: 'CONFLICT' },
        finalDecision: 'CONFLICT',
      })
      const outcome = await executeQueuedRepair(storage, run, preparation.stepKey, {
        runnerCommand: 'node', runnerArgs: [], homeDirectory: '/tmp', workingDir: '/tmp',
        execute: async () => ({ ok: true, stdout: conflictStdout, timedOut: false }),
      } as never)
      expect(outcome.status).toBe('escalated')

      const terminal = storage.designReviewRuns.findById(run.id)!
      // **production の形**: succeeded / error NULL / evidence 無し。
      expect(terminal.status).toBe('succeeded')
      expect(terminal.error).toBeUndefined()
      expect(storage.designReviewEvidence.findByTaskId(ids.taskId)).toHaveLength(0)

      // query は **落とせない**（`error IS NULL` を満たしてしまう）。
      expect(storage.designReviewRuns.findAlignedRepairPurposeTerminal().map((r) => r.id))
        .toEqual([run.id])

      // 回収されないのは run 自身の判定を計算し直しているからである。
      const summary = recoverTerminalRepairSuccessors(storage)
      expect(summary).toEqual({ scanned: 1, recovered: 0, skipped: 1, escalated: 0, failed: 0 })
      expect(repairJobsOf(storage, ids.taskId, preparation.stepKey)).toHaveLength(0)
    })

    /**
     * **非 ALIGNED な run に、同じテキストの ALIGNED evidence が並んでいても回収しない。**
     *
     * evidence は run id を持たないため、Task と `designTextHash` までしか束縛できない。
     * したがって「同じテキストが過去に ALIGNED だった」ことと「この run が ALIGNED だった」
     * ことは別の事実である。前者で後者を代用すると、**却下された review から repair を
     * 作る**ことになる。
     *
     * sweep 全体としては、同じ状態で ALIGNED 側の run が先に回収され stepKey dedup が働くため
     * 最終的な Job 数は変わらない。それでもここを緩めないのは、`recoverTerminalRepairSuccessor()`
     * の authority が「この run の判定」であることを崩さないためである（fail-closed）。
     */
    it('同じテキストの ALIGNED evidence があっても、非 ALIGNED な run からは回収しない', () => {
      const storage = createSQLiteStorage(':memory:')
      // ALIGNED な run #1 が evidence を残した（repair Job はまだ無い = U2 の窓）。
      const { ids, run: aligned } = seedTerminalAlignedRepairRun(storage)
      expect(storage.designReviewEvidence.findByTaskId(ids.taskId)).toHaveLength(1)

      // 同じ source / 同じテキストで、**非 ALIGNED に終端した** run #2。
      // task kind なので `error` は NULL のまま（production と同じ形）。
      const second = storage.designReviewRuns.create({
        taskId: ids.taskId,
        taskTitle: 'U2 task',
        designText: aligned.designText,
        designTextHash: aligned.designTextHash,
        changedFiles: aligned.changedFiles,
        repairSourceJobId: aligned.repairSourceJobId,
      })
      const claimed = storage.designReviewRuns.claim(second.id, 3)
      expect(storage.designReviewRuns.complete(
        second.id,
        claimed.claimToken!,
        'succeeded',
        JSON.stringify({
          focusedReviewResults: [],
          integrationReviewResult: { decision: 'CONFLICT' },
          finalDecision: 'CONFLICT',
        }),
        undefined,
      )).toBe(true)
      const rejected = storage.designReviewRuns.findById(second.id)!
      expect(rejected.error).toBeUndefined()
      // evidence 同一性検査だけなら通ってしまう状態であることを明示する。
      expect(
        storage.designReviewEvidence.findByTaskId(ids.taskId)
          .some((e) => e.decision === 'ALIGNED' && e.designTextHash === rejected.designTextHash),
      ).toBe(true)

      const outcome = recoverTerminalRepairSuccessor(storage, rejected)

      expect(outcome.status).toBe('skipped')
      if (outcome.status === 'skipped') expect(outcome.reason).toContain('ALIGNED')
      expect(repairJobsOf(storage, ids.taskId, repairStepKeyFor(aligned.repairSourceJobId!)))
        .toHaveLength(0)
    })

    /**
     * **evidence は「在るか」ではなく「この run のテキストに対するものか」で見る。**
     *
     * 1 つの Task には複数 run 由来の evidence が並ぶ。repair Job の prompt は
     * `run.designText` そのものなので、その hash に対する ALIGNED evidence が無ければ
     * 「これから作る Job の内容が審査を通っている」と言えない。言えないなら回収しない。
     */
    it('evidence の designTextHash が run と一致しなければ回収しない', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run, stepKey } = seedTerminalAlignedRepairRun(storage)
      // Task には ALIGNED evidence が 1 件あるが、それは別のテキストに対するものだった、
      // という状況を run 側から作る（evidence 表は書き換えない）。
      const mismatched: DesignReviewRun = { ...run, designTextHash: 'sha256:not-the-reviewed-text' }

      const outcome = recoverTerminalRepairSuccessor(storage, mismatched)

      expect(outcome.status).toBe('skipped')
      expect(storage.designReviewEvidence.findByTaskId(ids.taskId)).toHaveLength(1)
      expect(repairJobsOf(storage, ids.taskId, stepKey)).toHaveLength(0)
    })
  })

  describe('park された Task は park のまま', () => {
    it('park 済み Task では repair Job を作らず、blocked へも上げない', () => {
      const storage = createSQLiteStorage(':memory:')
      const { ids, run, stepKey } = seedTerminalAlignedRepairRun(storage)

      // abort_task と同じ経路で park する（DB を直接書き換えない）。
      storage.tasks.update(ids.taskId, { status: 'pending', roadmapActive: true } as never)
      const request = storage.approvalRequests.create({
        taskId: ids.taskId, requestedAction: 'abort_task', riskLevel: 'HIGH',
        targetBranch: 'ai/park', targetCommit: 'c', targetDiffHash: 'd',
        changedFiles: [], triggeredRules: [], invalidIf: ['commit changes'],
        status: 'WAITING_FOR_USER', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      } as never)
      storage.approvalRequests.updateStatus(request.id, 'APPROVED')
      const parked = abortTask(storage, {
        taskId: ids.taskId, approvalRequestId: request.id, reason: 'parked',
      })
      if (!parked.ok || parked.status !== 'parked') throw new Error('fixture failed to park')

      const outcome = recoverTerminalRepairSuccessor(storage, storage.designReviewRuns.findById(run.id)!)

      expect(outcome.status).toBe('skipped')
      expect(repairJobsOf(storage, ids.taskId, stepKey)).toHaveLength(0)
      expect(storage.tasks.findById(ids.taskId)?.status).not.toBe('blocked')
    })
  })
})
