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
import type { ConflictRoundResult } from './conflictResolutionStep'

/**
 * PL ループ側の配線だけを固定する。各 stage の中身は
 * `conflictResolutionStep.test.ts` / `remediationStep.test.ts` が持つ。
 *
 * ここで一番重要なのは **「既に CEO へ Escalate 済みの Task でも解決 Round は走る」** ことである。
 * `hasEscalated()` は Task の生涯にわたる記録で、`task_ready_without_job:<taskId>` というキーは
 * 変わらない。CONFLICT はまず notify-only で1回 Escalate されるので、そこを素通しにしないと
 * **解決経路は構造的に一度も実行されない**（本番で既に止まっている Task はすべて該当する）。
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
  ledgerRoot = mkdtempSync(join(tmpdir(), 'pl-conflict-loop-'))
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

function round(over: Partial<ConflictRoundResult> = {}): ConflictRoundResult {
  return { status: 'revised_and_aligned', stage: 'pl_revision', taskId: 't', ...over }
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

describe('PL tick — CONFLICT 解決の配線', () => {
  it('CONFLICT で止まった採用は解決 Round へ回り、通れば acted になる', async () => {
    const { storage, taskId } = seedConflicted()
    let seen: string | undefined

    const result = await runPlTick(storage, deps({
      resolveConflict: async (_s, id) => {
        seen = id
        return round({ taskId: id, criticProvider: 'codex', criticModel: 'gpt-5.6-sol' })
      },
    }))

    expect(seen).toBe(taskId)
    expect(result.status).toBe('acted')
    expect(result.proposedKind).toBe('adopt_roadmap_item')
  })

  it('**既に Escalate 済みでも解決 Round は走る**（生涯キーで永久に塞がない）', async () => {
    const { storage, taskId } = seedConflicted()
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
      resolveConflict: async (_s, id) => { called = true; return round({ taskId: id }) },
    }))

    expect(called).toBe(true)
    expect(result.status).toBe('acted')
  })

  it('challenge が ALIGNED なら acted（既存 Job Gate が Job を作っている）', async () => {
    const { storage } = seedConflicted()

    const result = await runPlTick(storage, deps({
      resolveConflict: async (_s, id) =>
        round({ status: 'challenge_aligned', stage: 'challenge', taskId: id }),
    }))

    expect(result.status).toBe('acted')
  })

  it('**challenge が ALIGNED でなければ実装へ進まない**（release しない）', async () => {
    for (const status of ['challenge_not_aligned', 'challenge_cap_reached'] as const) {
      resetPlLoopInFlightForTest()
      const { storage } = seedConflicted()

      const result = await runPlTick(storage, deps({
        resolveConflict: async (_s, id) => round({ status, stage: 'challenge', taskId: id, reason: 'r' }),
      }))

      expect(result.status).not.toBe('acted')
    }
  })

  it('PL revision が fresh Review を通らなければ acted にしない', async () => {
    const { storage } = seedConflicted()

    const result = await runPlTick(storage, deps({
      resolveConflict: async (_s, id) => round({
        status: 'revised_not_aligned', stage: 'pl_revision', taskId: id, reason: 'fresh review conflicted',
      }),
    }))

    expect(result.status).toBe('escalated')
  })

  it('Critic の分析を添えて既存 Escalation へ渡す', async () => {
    const { storage } = seedConflicted()
    const bodies: string[] = []

    const result = await runPlTick(storage, deps({
      escalate: async (payload) => { bodies.push(`${payload.title}${LF}${payload.body}`) },
      resolveConflict: async (_s, id) => round({
        status: 'revised_not_aligned',
        stage: 'pl_revision',
        taskId: id,
        reason: 'fresh review conflicted',
        critique: {
          coreProblems: ['scope が広すぎた'],
          findingAssessments: [{ source: 'scope_simplicity', status: 'supported', rationale: 'r' }],
          hiddenRisks: [],
          constraintsToPreserve: [],
          improvementDirections: ['既存 validation へ寄せる'],
          thingsNotToChange: [],
          uncertainties: [],
        },
      }),
    }))

    expect(result.status).toBe('escalated')
    expect(bodies[0]).toContain('Design Review CONFLICT')
    expect(bodies[0]).toContain('Critic が挙げた根本原因: scope が広すぎた')
    expect(bodies[0]).toContain('Critic の改善方向: 既存 validation へ寄せる')
  })

  it('**Binding Safety の疑義は Challenge で解除されない旨を人へ明示する**', async () => {
    // 既存方針（Second Independent Review → Meta Review → 未解決なら CEO）へ渡すため、
    // 「Challenge では解除されない」ことを通知本文に出す。
    const { storage } = seedConflicted()
    const bodies: string[] = []

    await runPlTick(storage, deps({
      escalate: async (payload) => { bodies.push(payload.body) },
      resolveConflict: async (_s, id) => round({
        status: 'revised_not_aligned',
        stage: 'pl_revision',
        taskId: id,
        bindingDisputes: [{
          source: 'safety_recovery',
          status: 'disputed',
          rationale: 'r',
          grounds: 'wrong_premise',
          evidence: 'e',
        }],
      }),
    }))

    expect(bodies[0]).toContain('Binding Safety / Authority')
    expect(bodies[0]).toContain('safety_recovery')
    expect(bodies[0]).toContain('Challenge では解除されません')
  })

  it('terminal かつ既に Escalate 済みなら鳴らし直さない', async () => {
    const { storage, taskId } = seedConflicted()
    storage.auditLog.record({
      actor: 'api', operation: 'pl_loop', entityType: 'pl_loop_target',
      entityId: `task_ready_without_job:${taskId}`, result: 'escalated', detail: 'x',
    })
    let notifications = 0

    const result = await runPlTick(storage, deps({
      escalate: async () => { notifications += 1 },
      resolveConflict: async (_s, id) => round({ status: 'terminal', stage: 'terminal', taskId: id }),
    }))

    expect(result.status).toBe('idle')
    expect(notifications).toBe(0)
  })

  it('解決しない CONFLICT でも通知は1回で止まる（鳴り続けない）', async () => {
    // 2026-09-17 の実測（63分で同一内容の LINE が18通）と同じ形を作らないための回帰テスト。
    const { storage } = seedConflicted()
    let notifications = 0
    const failing = deps({
      escalate: async () => { notifications += 1 },
      resolveConflict: async (_s, id) => round({
        status: 'critic_failed', stage: 'critic', taskId: id, reason: 'boom',
      }),
    })

    for (let i = 0; i < 5; i += 1) {
      resetPlLoopInFlightForTest()
      await runPlTick(storage, failing)
    }

    expect(notifications).toBe(1)
  })

  it('Review がまだ走っている（queued）Task は解決 Round へ回さない', async () => {
    // 採用直後は必ずこの状態を通る。ここで誤射すると進行中の復旧を潰す。
    const { storage } = seedConflicted({ runStatus: 'queued' })

    const result = await runPlTick(storage, deps({
      resolveConflict: async () => { throw new Error('must not be called while the review is running') },
    }))

    expect(result.status).toBe('escalated')
  })

  it('例外で落ちても tick を壊さない（diagnosis_failed で記録し、予算を1消費する）', async () => {
    const { storage, taskId } = seedConflicted()

    const result = await runPlTick(storage, deps({
      resolveConflict: async () => { throw new Error('runner spawn failed') },
    }))

    expect(result.status).toBe('diagnosis_failed')
    expect(countRemediationAttempts(storage, taskId)).toBe(1)
  })

  it('**step が既に計上した試行を二重計上しない**（1例外で予算を使い切らせない）', async () => {
    const { storage, taskId } = seedConflicted()

    const result = await runPlTick(storage, deps({
      resolveConflict: async (s, id) => {
        recordRemediationFailure(s, id, 'stage=remediation outcome=adopting')
        throw new Error('adoption threw after the attempt was recorded')
      },
    }))

    expect(result.status).toBe('diagnosis_failed')
    expect(countRemediationAttempts(storage, taskId)).toBe(1)
  })

  it('予算の上限値そのものは既存 policy を使う（重複 policy を作らない）', () => {
    expect(PL_MAX_REMEDIATION_ATTEMPTS).toBe(2)
  })
})
