import { describe, expect, it, beforeEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildInitialImplementAiCliPrompt } from '../ctoAi/initialImplementWorkflow'
import { resetPlLoopInFlightForTest, runPlTick, type PlLoopDeps } from './executionLoop'
import {
  countRemediationAttempts,
  PL_MAX_REMEDIATION_ATTEMPTS,
  recordRemediationFailure,
} from './remediationStep'

/**
 * PL ループ側の配線だけを固定する。Remediation の中身は `remediationStep.test.ts`。
 *
 * ここで一番重要なのは **「既に CEO へ Escalate 済みの Task でも Remediation は走る」** ことである。
 * `hasEscalated()` は Task の生涯にわたる記録で、`task_ready_without_job:<taskId>` というキーは
 * 変わらない。CONFLICT はまず notify-only で1回 Escalate されるので、そこを素通しにしないと
 * **Remediation は構造的に一度も実行されない**（本番で既に止まっている Task はすべて該当する）。
 */

const LF = String.fromCharCode(10)
const LEDGER = [
  '# Roadmap',
  '',
  '<!-- roadmap:id=conflicted-item state=planned -->',
  '1. [ ] **CONFLICT した項目**',
].join(LF)

/** Task 作成から十分に経過した時刻。`task_ready_without_job` の停滞閾値（5分）を超えさせる。 */
const NOW = new Date(Date.now() + 60 * 60 * 1000).toISOString()

let ledgerRoot: string
let previousTargetRoot: string | undefined

beforeAll(() => {
  ledgerRoot = mkdtempSync(join(tmpdir(), 'pl-remediation-loop-'))
  mkdirSync(join(ledgerRoot, 'tasks'), { recursive: true })
  writeFileSync(join(ledgerRoot, 'tasks', 'roadmap.md'), LEDGER, 'utf-8')
  previousTargetRoot = process.env.TARGET_ROOT
  process.env.TARGET_ROOT = ledgerRoot
})

afterAll(() => {
  if (previousTargetRoot === undefined) delete process.env.TARGET_ROOT
  else process.env.TARGET_ROOT = previousTargetRoot
  rmSync(ledgerRoot, { recursive: true, force: true })
})

beforeEach(() => {
  resetPlLoopInFlightForTest()
})

function seedConflicted(options: { runStatus?: 'queued' | 'succeeded' } = {}): {
  storage: IStorage
  taskId: string
} {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'CONFLICT した項目',
    description: 'body',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: ['apps/api/src'],
    acceptanceCriteria: ['c'],
    roadmapTaskKey: 'conflicted-item',
    phase: 1,
    roadmapActive: true,
  } as Parameters<IStorage['tasks']['create']>[0])

  const designText = buildInitialImplementAiCliPrompt(task)
  const run = storage.designReviewRuns.create({
    taskId: task.id,
    taskTitle: task.title,
    designText,
    designTextHash: computeDesignTextHash(designText),
    changedFiles: [],
  })
  if (options.runStatus !== 'queued') {
    const claimed = storage.designReviewRuns.claim(run.id, 3)
    storage.designReviewRuns.complete(
      run.id,
      claimed.claimToken as string,
      'succeeded',
      JSON.stringify({ focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }] }),
    )
  }

  return { storage, taskId: task.id }
}

function deps(over: Partial<PlLoopDeps> = {}): PlLoopDeps {
  return {
    now: () => NOW,
    escalate: async () => {},
    readLedger: () => '',
    diagnose: async () => { throw new Error('diagnose must not be called for a remediable CONFLICT') },
    ...over,
  }
}

describe('PL tick — Design Review CONFLICT の配線', () => {
  it('CONFLICT で止まった採用は Remediation へ回り、通れば acted になる', async () => {
    const { storage, taskId } = seedConflicted()
    let remediatedTaskId: string | undefined

    const result = await runPlTick(storage, deps({
      remediate: async (_storage, id) => {
        remediatedTaskId = id
        return { status: 'remediated', taskId: id, provider: 'codex', model: 'gpt-5.6-sol' }
      },
    }))

    expect(remediatedTaskId).toBe(taskId)
    expect(result.status).toBe('acted')
    expect(result.proposedKind).toBe('adopt_roadmap_item')
  })

  it('**既に Escalate 済みでも Remediation は走る**（生涯キーで永久に塞がない）', async () => {
    const { storage, taskId } = seedConflicted()
    // 1回目の tick で notify-only の Escalation が記録される状態を作る。
    storage.auditLog.record({
      actor: 'api',
      operation: 'pl_loop',
      entityType: 'pl_loop_target',
      entityId: `task_ready_without_job:${taskId}`,
      result: 'escalated',
      detail: 'design review CONFLICT',
    })
    let called = false

    const result = await runPlTick(storage, deps({
      remediate: async (_storage, id) => {
        called = true
        return { status: 'remediated', taskId: id, provider: 'codex', model: 'gpt-5.6-sol' }
      },
    }))

    expect(called).toBe(true)
    expect(result.status).toBe('acted')
  })

  it('Remediation の予算が尽き、既に Escalate 済みなら鳴らし直さない', async () => {
    const { storage, taskId } = seedConflicted()
    storage.auditLog.record({
      actor: 'api', operation: 'pl_loop', entityType: 'pl_loop_target',
      entityId: `task_ready_without_job:${taskId}`, result: 'escalated', detail: 'x',
    })
    for (let i = 0; i < PL_MAX_REMEDIATION_ATTEMPTS; i += 1) {
      storage.auditLog.record({
        actor: 'api', operation: 'pl_independent_remediation', entityType: 'pl_remediation',
        entityId: `remediate:${taskId}`, result: 'success', detail: 'outcome=runner_failed',
      })
    }
    let notifications = 0

    const result = await runPlTick(storage, deps({
      escalate: async () => { notifications += 1 },
      remediate: async () => { throw new Error('must not be called: budget exhausted') },
    }))

    // Remediation 対象から外れるので、既存の「already escalated」経路で静かに終わる。
    expect(result.status).toBe('idle')
    expect(notifications).toBe(0)
  })

  it('解決しなければ Remediation の診断を添えて既存 Escalation へ渡す', async () => {
    const { storage } = seedConflicted()
    const bodies: string[] = []

    const result = await runPlTick(storage, deps({
      escalate: async (payload) => { bodies.push(`${payload.title}${LF}${payload.body}`) },
      remediate: async () => ({
        status: 'still_not_aligned',
        reason: 'fresh review did not align',
        failureCode: 'fresh_review_not_aligned',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        proposal: {
          diagnosis: 'scope が広すぎた',
          resolution: '既存 validation へ寄せる',
          implementationScope: 's',
          allowedPaths: ['apps/api/src/storage'],
          acceptanceCriteria: ['c'],
          whyResolved: 'w',
          safetyImpact: '不変',
          unresolvedConcerns: [],
          abandon: false,
        },
      }),
    }))

    expect(result.status).toBe('escalated')
    expect(bodies[0]).toContain('Design Review CONFLICT')
    expect(bodies[0]).toContain('独立 AI の診断: scope が広すぎた')
    expect(bodies[0]).toContain('提案された解決: 既存 validation へ寄せる')
  })

  it('解決しない CONFLICT でも通知は予算の回数までで止まる（鳴り続けない）', async () => {
    // 2026-09-17 の実測（63分で同一内容の LINE が18通）と同じ形を作らないための回帰テスト。
    const { storage } = seedConflicted()
    let notifications = 0
    const failing = deps({
      escalate: async () => { notifications += 1 },
      remediate: async (_storage, id) => ({
        status: 'remediation_failed', taskId: id, failureCode: 'runner_failed', reason: 'boom',
      }),
    })

    // **Remediation 側の記録に依存させない。** ここでは予算を消費しない stub を注入しており、
    // それでも 2 通目以降が出ないこと（ループ防止が分岐自身にあること）を固定する。
    for (let i = 0; i < 5; i += 1) {
      resetPlLoopInFlightForTest()
      await runPlTick(storage, failing)
    }

    expect(notifications).toBe(1)
  })

  it('Review がまだ走っている（queued）Task は Remediation へ回さない', async () => {
    // 採用直後は必ずこの状態を通る。ここで誤射すると進行中の復旧を潰す。
    const { storage } = seedConflicted({ runStatus: 'queued' })

    const result = await runPlTick(storage, deps({
      remediate: async () => { throw new Error('must not be called while the review is still running') },
    }))

    // 従来どおり notify-only の Escalation で終わる（挙動は変えていない）。
    expect(result.status).toBe('escalated')
  })

  it('Remediation が例外で落ちても tick を壊さない（diagnosis_failed で記録する）', async () => {
    const { storage, taskId } = seedConflicted()

    const result = await runPlTick(storage, deps({
      remediate: async () => { throw new Error('runner spawn failed') },
    }))

    expect(result.status).toBe('diagnosis_failed')
    expect(
      storage.auditLog
        .findByEntity('pl_loop_target', `task_ready_without_job:${taskId}`)
        .some((entry) => entry.result === 'diagnosis_failed'),
    ).toBe(true)
    // 予算は1消費される（再現する例外を毎 tick 繰り返さないため）。
    expect(countRemediationAttempts(storage, taskId)).toBe(1)
  })

  it('**step が既に計上した試行を二重計上しない**（1例外で予算を使い切らせない）', async () => {
    // step は採用を await する前に `outcome=adopting` を記録する。採用が throw すると
    // 1回の論理試行で2行になり、上限2に対して transient な例外1回で予算が尽きる。
    const { storage, taskId } = seedConflicted()

    const result = await runPlTick(storage, deps({
      remediate: async (s, id) => {
        // step 側が試行を記録したうえで throw する状況を再現する。
        recordRemediationFailure(s, id, 'outcome=adopting')
        throw new Error('adoption threw after the attempt was recorded')
      },
    }))

    expect(result.status).toBe('diagnosis_failed')
    expect(countRemediationAttempts(storage, taskId)).toBe(1)
  })
})
