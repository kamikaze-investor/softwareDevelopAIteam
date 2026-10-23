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
  classifyConflictRecoveryRow,
  hasRemediationBudgetLeft,
  PL_MAX_REMEDIATION_ATTEMPTS,
  PL_MAX_TECHNICAL_FAILURES_PER_STAGE,
  recordRemediationFailure,
  tallyConflictStage,
  TECHNICAL_FAILURE_OUTCOMES,
} from './remediationStep'
import { PL_MAX_CRITIC_ROUNDS, selectConflictStage, type ConflictRoundResult } from './conflictResolutionStep'

/**
 * CONFLICT 復旧の予算会計（2026-10-23 Production `#2cae0d07` の取り残し）。
 *
 * 予算は**判定（runner が parse 済みの結果を返した行）**だけを数え、判定を生まなかった
 * 技術的失敗は stage ごとの別上限 `PL_MAX_TECHNICAL_FAILURES_PER_STAGE` で有界にする。
 * 旧来の audit 行は削除せず、分類で読み替えるだけである。
 */

const LF = String.fromCharCode(10)
const LEDGER = [
  '# Roadmap',
  '',
  '<!-- roadmap:id=conflicted-item state=planned -->',
  '1. [ ] **CONFLICT した項目**',
].join(LF)

const NOW = new Date(Date.now() + 60 * 60 * 1000).toISOString()

let ledgerRoot: string
let previousTargetRoot: string | undefined

beforeAll(() => {
  ledgerRoot = mkdtempSync(join(tmpdir(), 'pl-conflict-budget-'))
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

function seedConflicted(): { storage: IStorage; taskId: string } {
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
  const claimed = storage.designReviewRuns.claim(run.id, 3)
  storage.designReviewRuns.complete(
    run.id,
    claimed.claimToken as string,
    'succeeded',
    JSON.stringify({ focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }] }),
  )
  return { storage, taskId: task.id }
}

/** Production の critic runner_failed 行と同じ形（provenance は実装が書く形）。 */
function criticRunnerFailed(provider: string): string {
  return `stage=critic provider=${provider} model=m vendor=v reused_model=no reused_vendor=no outcome=runner_failed`
}

/** Production の remediation runner_failed 行と同じ形。 */
function remediationRunnerFailed(provider: string): string {
  return `provider=${provider} model=m vendor=v excluded=- unverified_separation=opencode-go`
    + ' stage=remediation rejected_specs=1 outcome=runner_failed'
}

/** 2026-10-23 Production `#2cae0d07` の audit 形: critic runner_failed ×2 + remediation runner_failed ×2。 */
function seedProductionShape(storage: IStorage, taskId: string): void {
  recordRemediationFailure(storage, taskId, criticRunnerFailed('codex'))
  recordRemediationFailure(storage, taskId, criticRunnerFailed('claude_code'))
  recordRemediationFailure(storage, taskId, remediationRunnerFailed('codex'))
  recordRemediationFailure(storage, taskId, remediationRunnerFailed('claude_code'))
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

function markEscalated(storage: IStorage, taskId: string): void {
  storage.auditLog.record({
    actor: 'api', operation: 'pl_loop', entityType: 'pl_loop_target',
    entityId: `task_ready_without_job:${taskId}`, result: 'escalated', detail: 'design review CONFLICT',
  })
}

describe('classifyConflictRecoveryRow — 判定 / 技術的失敗の唯一の分類表', () => {
  it.each([
    // 技術的失敗は明示 allowlist だけ（model が応答する前に止まった行）
    ['critic', criticRunnerFailed('codex'), 'technical'],
    ['critic', 'stage=critic outcome=item_not_in_ledger', 'technical'],
    ['critic', 'stage=critic outcome=ledger_unreadable', 'technical'],
    ['critic', 'stage=critic outcome=exception', 'technical'],
    ['remediation', remediationRunnerFailed('codex'), 'technical'],
    ['remediation', 'outcome=item_not_in_ledger', 'technical'],
    ['remediation', 'outcome=ledger_unreadable', 'technical'],
    ['remediation', 'outcome=no_independent_flagship', 'technical'],
    ['remediation', 'stage=remediation outcome=exception', 'technical'],
    // 旧形式（pl_revision を別 stage にする前）の critic 行の fspec= は同じ Round の2行目。二重計上しない
    ['critic', 'stage=critic proposed=h fspec=abc rejected_fspec=- outcome=adopting', 'technical'],
    // 判定: parse 済みの結果
    ['critic', 'stage=critic provider=codex model=m disputes=0 binding_disputes=0 outcome=critiqued', 'judgment'],
    ['critic', 'stage=critic provider=codex model=m outcome=runner_failed_after_critique', 'judgment'],
    ['remediation', 'provider=codex model=m stage=remediation rejected_specs=1 outcome=abandon', 'judgment'],
    ['remediation', 'provider=codex stage=remediation proposed=h fspec=abc rejected_fspec=def outcome=not_different', 'judgment'],
    ['remediation', 'provider=codex stage=remediation proposed=h fspec=abc rejected_fspec=- outcome=PATHS_TOO_BROAD', 'judgment'],
    ['remediation', 'provider=codex stage=remediation proposed=h fspec=abc rejected_fspec=- outcome=adopting', 'judgment'],
    ['remediation', 'provider=codex model=m stage=remediation outcome=runner_failed_after_proposal', 'judgment'],
    ['remediation', 'provider=codex model=m stage=remediation outcome=proposal_parsed_apply_exception', 'judgment'],
    // 判定（fail-closed）: model は応答したが壊れていた / 未知の outcome / outcome の無い旧形式
    ['critic', 'stage=critic provider=codex model=m outcome=critique_unusable', 'judgment'],
    ['remediation', 'provider=codex model=m stage=remediation outcome=unusable', 'judgment'],
    ['critic', 'stage=critic outcome=some_future_outcome', 'judgment'],
    ['remediation', 'stage=remediation outcome=some_future_outcome', 'judgment'],
    ['remediation', 'attempt 0', 'judgment'],
    ['remediation', undefined, 'judgment'],
  ] as const)('%s: %s → %s', (stage, detail, expected) => {
    expect(classifyConflictRecoveryRow(stage, detail)).toBe(expected)
  })

  it('技術的失敗の allowlist はコードが記録する outcome そのもの', () => {
    expect([...TECHNICAL_FAILURE_OUTCOMES].sort()).toEqual(
      ['exception', 'item_not_in_ledger', 'ledger_unreadable', 'no_independent_flagship', 'runner_failed'],
    )
  })

  it('challenge / pl_revision の行は critic / remediation の予算に入らない（二重計上しない）', () => {
    const { storage, taskId } = seedConflicted()
    recordRemediationFailure(storage, taskId, 'stage=critic provider=codex model=m outcome=critiqued')
    recordRemediationFailure(storage, taskId, 'stage=challenge chal=abc:scope orig_verdict=CONFLICT outcome=starting')
    recordRemediationFailure(storage, taskId, 'stage=challenge chal=abc:scope reversal=no outcome=evaluated')
    recordRemediationFailure(storage, taskId, 'stage=pl_revision proposed=h fspec=abc rejected_fspec=- outcome=adopting')

    expect(tallyConflictStage(storage, taskId, 'critic')).toEqual({ judgments: 1, technicalFailures: 0 })
    expect(tallyConflictStage(storage, taskId, 'remediation')).toEqual({ judgments: 0, technicalFailures: 0 })
  })
})

describe('Production #2cae0d07 の legacy 形を読み替える（行は削除しない）', () => {
  it('critic runner_failed ×2 + remediation runner_failed ×2 は terminal ではなく critic', () => {
    const { storage, taskId } = seedConflicted()
    seedProductionShape(storage, taskId)

    const selection = selectConflictStage(storage, taskId)
    expect(selection).toMatchObject({
      stage: 'critic',
      criticRounds: 0,
      remediationAttempts: 0,
      criticTechnicalFailures: 2,
      remediationTechnicalFailures: 2,
    })
    // 行は1つも消えていない。
    expect(storage.auditLog.findByEntity('pl_remediation', `remediate:${taskId}`)).toHaveLength(4)
  })

  it('critic runner_failed がもう1回で remediation、remediation runner_failed がもう1回で terminal', () => {
    const { storage, taskId } = seedConflicted()
    seedProductionShape(storage, taskId)

    recordRemediationFailure(storage, taskId, criticRunnerFailed('codex'))
    expect(selectConflictStage(storage, taskId).stage).toBe('remediation')

    recordRemediationFailure(storage, taskId, remediationRunnerFailed('codex'))
    const terminal = selectConflictStage(storage, taskId)
    expect(terminal.stage).toBe('terminal')
    expect(terminal.reason).toContain('technical failures exhausted the remediation stage')
    expect(hasRemediationBudgetLeft(storage, taskId)).toBe(false)
  })
})

describe('stage ごとの技術的失敗上限', () => {
  it('critic の技術的失敗が上限に達したら、判定予算が残っていても remediation へ進む', () => {
    const { storage, taskId } = seedConflicted()
    recordRemediationFailure(storage, taskId, 'stage=critic outcome=critiqued')
    for (let i = 0; i < PL_MAX_TECHNICAL_FAILURES_PER_STAGE; i += 1) {
      recordRemediationFailure(storage, taskId, criticRunnerFailed('codex'))
    }

    const selection = selectConflictStage(storage, taskId)
    expect(selection.stage).toBe('remediation')
    expect(selection.reason).toContain('critic stage hit 3 technical failure(s)')
  })

  it('上限未満の技術的失敗では stage を移らない', () => {
    const { storage, taskId } = seedConflicted()
    for (let i = 0; i < PL_MAX_TECHNICAL_FAILURES_PER_STAGE - 1; i += 1) {
      recordRemediationFailure(storage, taskId, criticRunnerFailed('codex'))
      recordRemediationFailure(storage, taskId, remediationRunnerFailed('codex'))
    }

    expect(selectConflictStage(storage, taskId).stage).toBe('critic')
    expect(hasRemediationBudgetLeft(storage, taskId)).toBe(true)
  })

  it('remediation の技術的失敗が上限に達したら、判定予算が残っていても terminal', () => {
    const { storage, taskId } = seedConflicted()
    for (let i = 0; i < PL_MAX_CRITIC_ROUNDS; i += 1) {
      recordRemediationFailure(storage, taskId, 'stage=critic outcome=critiqued')
    }
    recordRemediationFailure(storage, taskId, 'stage=remediation outcome=abandon')
    for (let i = 0; i < PL_MAX_TECHNICAL_FAILURES_PER_STAGE; i += 1) {
      recordRemediationFailure(storage, taskId, remediationRunnerFailed('codex'))
    }

    expect(selectConflictStage(storage, taskId).stage).toBe('terminal')
    expect(hasRemediationBudgetLeft(storage, taskId)).toBe(false)
  })

  it('上限値そのもの（判定予算は従来どおり、技術的失敗は 3）', () => {
    expect(PL_MAX_CRITIC_ROUNDS).toBe(2)
    expect(PL_MAX_REMEDIATION_ATTEMPTS).toBe(2)
    expect(PL_MAX_TECHNICAL_FAILURES_PER_STAGE).toBe(3)
  })
})

describe('PL tick — 予算会計の配線', () => {
  it('既に Escalate 済みの Production 形 Task は、判定予算が残るので再び解決 Round へ回る', async () => {
    const { storage, taskId } = seedConflicted()
    seedProductionShape(storage, taskId)
    markEscalated(storage, taskId)
    let called: string | undefined

    const result = await runPlTick(storage, deps({
      resolveConflict: async (_s, id) => {
        called = id
        return { status: 'revised_and_aligned', stage: 'pl_revision', taskId: id } satisfies ConflictRoundResult
      },
    }))

    expect(called).toBe(taskId)
    expect(result.status).toBe('acted')
  })

  it('本物の critique ×2 + parse 済みの提案 ×2 は従来どおり terminal で、通知は1回だけ', async () => {
    const { storage, taskId } = seedConflicted()
    for (let i = 0; i < PL_MAX_CRITIC_ROUNDS; i += 1) {
      recordRemediationFailure(storage, taskId, 'stage=critic provider=codex model=m outcome=critiqued')
    }
    recordRemediationFailure(storage, taskId, 'provider=codex model=m stage=remediation outcome=abandon')
    recordRemediationFailure(storage, taskId, 'provider=claude_code stage=remediation proposed=h fspec=abc rejected_fspec=- outcome=not_different')
    expect(selectConflictStage(storage, taskId).stage).toBe('terminal')
    const notified: string[] = []
    const tickDeps = deps({ escalate: async (payload) => { notified.push(payload.body) } })

    for (let i = 0; i < 3; i += 1) {
      resetPlLoopInFlightForTest()
      await runPlTick(storage, tickDeps)
    }

    expect(notified).toHaveLength(1)
    // 通知は既存の CONFLICT 案内（triage）のまま。
    expect(notified[0]).toContain('design_review_conflict')
  })

  it('技術的失敗で terminal になった場合も既存の terminal 経路で1回だけ通知し、理由だけが区別される', async () => {
    const { storage, taskId } = seedConflicted()
    seedProductionShape(storage, taskId)
    recordRemediationFailure(storage, taskId, criticRunnerFailed('codex'))
    recordRemediationFailure(storage, taskId, remediationRunnerFailed('codex'))
    const notified: string[] = []
    const tickDeps = deps({ escalate: async (payload) => { notified.push(payload.body) } })

    for (let i = 0; i < 3; i += 1) {
      resetPlLoopInFlightForTest()
      await runPlTick(storage, tickDeps)
    }

    expect(notified).toHaveLength(1)
    // 通知本文は既存の terminal 経路（triage の CONFLICT 案内）のまま。区別されるのは selector の理由だけ。
    expect(notified[0]).toContain('design_review_conflict')
    expect(selectConflictStage(storage, taskId).reason)
      .toContain('technical failures exhausted the remediation stage')
    // terminal は何も記録しない（行は増えない = 無制限に再試行しない）。
    expect(storage.auditLog.findByEntity('pl_remediation', `remediate:${taskId}`)).toHaveLength(6)
  })

  it('同時に2つの tick が来ても、上限を超えて Round を2つ始められない（既存の in-flight ガード）', async () => {
    const { storage, taskId } = seedConflicted()
    // 技術的失敗が上限まであと1回の状態。
    recordRemediationFailure(storage, taskId, 'stage=critic outcome=critiqued')
    recordRemediationFailure(storage, taskId, 'stage=critic outcome=critiqued')
    recordRemediationFailure(storage, taskId, remediationRunnerFailed('codex'))
    recordRemediationFailure(storage, taskId, remediationRunnerFailed('claude_code'))
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let rounds = 0
    const tickDeps = deps({
      resolveConflict: async (s, id) => {
        rounds += 1
        await gate
        recordRemediationFailure(s, id, remediationRunnerFailed('codex'))
        return { status: 'remediation', stage: 'remediation', taskId: id, reason: 'runner failed' } satisfies ConflictRoundResult
      },
    })

    const first = runPlTick(storage, tickDeps)
    const second = await runPlTick(storage, tickDeps)
    release()
    await first

    expect(second.status).toBe('skipped_in_flight')
    expect(rounds).toBe(1)
    expect(tallyConflictStage(storage, taskId, 'remediation').technicalFailures)
      .toBe(PL_MAX_TECHNICAL_FAILURES_PER_STAGE)
    expect(selectConflictStage(storage, taskId).stage).toBe('terminal')
  })
})
