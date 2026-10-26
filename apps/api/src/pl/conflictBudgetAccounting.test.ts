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
  CONFLICT_RECOVERY_ACCOUNTING_EPOCH,
  PL_MAX_LIFETIME_TECHNICAL_FAILURES_PER_STAGE,
  PL_MAX_TECHNICAL_FAILURES_PER_STAGE,
  recordRemediationFailure,
  tallyConflictStage,
  TECHNICAL_FAILURE_OUTCOMES,
} from './remediationStep'
import { PL_MAX_CRITIC_ROUNDS, selectConflictStage, type ConflictRoundResult } from './conflictResolutionStep'

/**
 * CONFLICT 復旧の予算会計（2026-10-23 Production `#2cae0d07` の取り残し）。
 *
 * 予算は **Round** 単位で、設計成果物を正式経路へ出した Round だけを判定として数える（2026-10-26）。
 * 成果物を出さなかった Round は技術的失敗で、現在の accounting epoch の上限
 * `PL_MAX_TECHNICAL_FAILURES_PER_STAGE` と epoch を跨いだ総上限で有界にする。
 * 旧来の audit 行は削除も書き換えもせず、読み方を変えるだけである。
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

/**
 * 旧形式の行（epoch 導入前に Production が書いた形）をそのまま書く。
 * `recordRemediationFailure()` は Round に属さない行にも `epoch=` を付けるので、旧形式の再現には使えない。
 */
function recordLegacyRow(storage: IStorage, taskId: string, detail: string): void {
  storage.auditLog.record({
    actor: 'api', operation: 'pl_independent_remediation', entityType: 'pl_remediation',
    entityId: `remediate:${taskId}`, result: 'success', detail,
  })
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

/** 2026-10-23 05:38–05:41 Production `#2cae0d07` の audit 形（旧形式）: critic runner_failed ×2 + remediation runner_failed ×2。 */
function seedProductionShape(storage: IStorage, taskId: string): void {
  recordLegacyRow(storage, taskId, criticRunnerFailed('codex'))
  recordLegacyRow(storage, taskId, criticRunnerFailed('claude_code'))
  recordLegacyRow(storage, taskId, remediationRunnerFailed('codex'))
  recordLegacyRow(storage, taskId, remediationRunnerFailed('claude_code'))
}

/**
 * 2026-10-23 09:53 時点の Production `#2cae0d07`（旧形式）: 上記 + critic critiqued ×2（PL revision は
 * どちらも unparsable で行なし）+ remediation runner_failed（300 秒 timeout）。
 */
function seedProductionShapeAfterDeploy(storage: IStorage, taskId: string): void {
  seedProductionShape(storage, taskId)
  recordLegacyRow(storage, taskId, 'stage=critic provider=codex model=gpt-5.6-sol vendor=openai reused_model=yes reused_vendor=yes disputes=0 binding_disputes=0 outcome=critiqued')
  recordLegacyRow(storage, taskId, 'stage=critic provider=codex model=gpt-5.6-sol vendor=openai reused_model=yes reused_vendor=yes disputes=0 binding_disputes=0 outcome=critiqued')
  recordLegacyRow(storage, taskId, remediationRunnerFailed('codex'))
}

let roundSeq = 0
/** 現在の epoch の Round を、指定した行の並びで書く（Round 開始行は実装と同じ形）。 */
function recordRound(storage: IStorage, taskId: string, stage: 'critic' | 'remediation', rows: readonly string[]): string {
  roundSeq += 1
  const prefix = `round=00000000-0000-4000-8000-${String(roundSeq).padStart(12, '0')} epoch=${CONFLICT_RECOVERY_ACCOUNTING_EPOCH}`
  recordRemediationFailure(storage, taskId, `${prefix} stage=${stage} outcome=starting`)
  for (const row of rows) recordRemediationFailure(storage, taskId, `${prefix} ${row}`)
  return prefix
}

/** 設計成果物を出した critic Round（critique → PL revision の具体的 spec）。 */
function criticJudgmentRound(storage: IStorage, taskId: string): void {
  recordRound(storage, taskId, 'critic', [
    'stage=critic provider=codex model=m outcome=critiqued',
    `stage=pl_revision proposed=h${roundSeq} fspec=f${roundSeq} rejected_fspec=- outcome=adopting`,
  ])
}

/** 設計成果物を出した remediation Round（abandon）。 */
function remediationJudgmentRound(storage: IStorage, taskId: string): void {
  recordRound(storage, taskId, 'remediation', ['provider=codex model=m stage=remediation outcome=abandon'])
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

describe('classifyConflictRecoveryRow — 著者除外用の行分類（予算は Round 単位で別に数える）', () => {
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
    // 旧形式の critic 行（fspec= 付き）にも特例を置かない（allowlist だけで分類・fail-closed）。
    // Production には該当行が0件（2026-10-23 実測）。未知・旧形式の outcome は判定予算を消費する
    ['critic', 'stage=critic proposed=h fspec=abc rejected_fspec=- outcome=adopting', 'judgment'],
    ['critic', 'stage=critic fspec=x outcome=some_future_outcome', 'judgment'],
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
    recordLegacyRow(storage, taskId, 'stage=critic provider=codex model=m outcome=critiqued')
    recordLegacyRow(storage, taskId, 'stage=challenge chal=abc:scope orig_verdict=CONFLICT outcome=starting')
    recordLegacyRow(storage, taskId, 'stage=challenge chal=abc:scope reversal=no outcome=evaluated')
    recordLegacyRow(storage, taskId, 'stage=pl_revision proposed=h fspec=abc rejected_fspec=- outcome=adopting')

    expect(tallyConflictStage(storage, taskId, 'critic'))
      .toEqual({ judgments: 1, technicalFailures: 0, lifetimeTechnicalFailures: 0 })
    expect(tallyConflictStage(storage, taskId, 'remediation'))
      .toEqual({ judgments: 0, technicalFailures: 0, lifetimeTechnicalFailures: 0 })
  })
})

describe('Round 単位の会計（2026-10-26: 成果物を出した Round だけが判定）', () => {
  it('critique の後に PL revision が壊れた応答しか返さなかった Round は、何行書いても技術的失敗1回', () => {
    const { storage, taskId } = seedConflicted()
    recordRound(storage, taskId, 'critic', [
      'stage=critic provider=codex model=m outcome=critiqued',
      'stage=pl_revision outcome=revision_unusable',
    ])

    expect(tallyConflictStage(storage, taskId, 'critic'))
      .toEqual({ judgments: 0, technicalFailures: 1, lifetimeTechnicalFailures: 1 })
  })

  it('critique → 具体的 spec（adopting / not_different / Gate 拒否）を出した Round は判定1回', () => {
    for (const outcome of ['adopting', 'not_different', 'PATHS_TOO_BROAD']) {
      const { storage, taskId } = seedConflicted()
      recordRound(storage, taskId, 'critic', [
        'stage=critic provider=codex model=m outcome=critiqued',
        `stage=pl_revision proposed=h fspec=abc rejected_fspec=- outcome=${outcome}`,
      ])

      expect(tallyConflictStage(storage, taskId, 'critic'))
        .toEqual({ judgments: 1, technicalFailures: 0, lifetimeTechnicalFailures: 0 })
    }
  })

  it('Challenge を予約した critic Round は判定1回（同一設計の再評価を何度も引かせない）', () => {
    const { storage, taskId } = seedConflicted()
    recordRound(storage, taskId, 'critic', [
      'stage=critic provider=codex model=m outcome=critiqued',
      'stage=challenge chal=abc:scope orig_verdict=CONFLICT outcome=starting',
    ])

    expect(tallyConflictStage(storage, taskId, 'critic').judgments).toBe(1)
  })

  it('runner 中に落ちた Round（開始行だけ）も技術的失敗として数える（crash の繰り返しで上限を素通りしない）', () => {
    const { storage, taskId } = seedConflicted()
    recordRound(storage, taskId, 'critic', [])
    recordRound(storage, taskId, 'remediation', [])

    expect(tallyConflictStage(storage, taskId, 'critic').technicalFailures).toBe(1)
    expect(tallyConflictStage(storage, taskId, 'remediation').technicalFailures).toBe(1)
  })

  it('壊れた応答・runner 失敗後の parse 済み結果は成果物ではないので技術的失敗', () => {
    const { storage, taskId } = seedConflicted()
    recordRound(storage, taskId, 'critic', ['stage=critic provider=codex model=m outcome=critique_unusable'])
    recordRound(storage, taskId, 'critic', ['stage=critic provider=codex model=m outcome=runner_failed_after_critique'])
    recordRound(storage, taskId, 'remediation', ['provider=codex model=m stage=remediation outcome=unusable'])
    recordRound(storage, taskId, 'remediation', ['provider=codex model=m stage=remediation outcome=runner_failed_after_proposal'])

    expect(tallyConflictStage(storage, taskId, 'critic'))
      .toEqual({ judgments: 0, technicalFailures: 2, lifetimeTechnicalFailures: 2 })
    expect(tallyConflictStage(storage, taskId, 'remediation'))
      .toEqual({ judgments: 0, technicalFailures: 2, lifetimeTechnicalFailures: 2 })
  })

  it('採用予約（adopting）は下流の Design Review が判定を出さずに失敗しても返金しない', () => {
    const { storage, taskId } = seedConflicted()
    recordRound(storage, taskId, 'remediation', [
      'provider=codex model=m vendor=v stage=remediation rejected_specs=1 proposed=h fspec=abc rejected_fspec=- outcome=adopting',
    ])

    expect(tallyConflictStage(storage, taskId, 'remediation'))
      .toEqual({ judgments: 1, technicalFailures: 0, lifetimeTechnicalFailures: 0 })
  })

  it('2つの Round の行が交互に並んでも Round の同一性で分ける（並びに依存しない）', () => {
    const { storage, taskId } = seedConflicted()
    const a = `round=00000000-0000-4000-8000-aaaaaaaaaaaa epoch=${CONFLICT_RECOVERY_ACCOUNTING_EPOCH}`
    const b = `round=00000000-0000-4000-8000-bbbbbbbbbbbb epoch=${CONFLICT_RECOVERY_ACCOUNTING_EPOCH}`
    recordRemediationFailure(storage, taskId, `${a} stage=critic outcome=starting`)
    recordRemediationFailure(storage, taskId, `${b} stage=critic outcome=starting`)
    recordRemediationFailure(storage, taskId, `${a} stage=critic provider=codex model=m outcome=critiqued`)
    recordRemediationFailure(storage, taskId, `${b} stage=critic provider=codex model=m outcome=critiqued`)
    recordRemediationFailure(storage, taskId, `${a} stage=pl_revision proposed=h fspec=abc rejected_fspec=- outcome=adopting`)
    recordRemediationFailure(storage, taskId, `${b} stage=pl_revision outcome=revision_unusable`)

    expect(tallyConflictStage(storage, taskId, 'critic'))
      .toEqual({ judgments: 1, technicalFailures: 1, lifetimeTechnicalFailures: 1 })
  })

  it('Round に属さない新しい行にも epoch が付く（上限を素通りしない）', () => {
    const { storage, taskId } = seedConflicted()
    recordRemediationFailure(storage, taskId, 'stage=critic outcome=ledger_unreadable')

    const [row] = storage.auditLog.findByEntity('pl_remediation', `remediate:${taskId}`)
    expect(row?.detail).toBe(`epoch=${CONFLICT_RECOVERY_ACCOUNTING_EPOCH} stage=critic outcome=ledger_unreadable`)
    expect(tallyConflictStage(storage, taskId, 'critic').technicalFailures).toBe(1)
  })

  it('旧形式の critiqued 行は時系列で次の critic 行より前に成果物が続いたときだけ判定', () => {
    const { storage, taskId } = seedConflicted()
    // 1件目: 成果物が続かないまま次の critic 行が来た → 技術的失敗
    recordLegacyRow(storage, taskId, 'stage=critic provider=codex model=m outcome=critiqued')
    recordLegacyRow(storage, taskId, criticRunnerFailed('codex'))
    // 2件目: 成果物が続いた → 判定
    recordLegacyRow(storage, taskId, 'stage=critic provider=codex model=m outcome=critiqued')
    recordLegacyRow(storage, taskId, 'stage=pl_revision proposed=h fspec=abc rejected_fspec=- outcome=adopting')

    expect(tallyConflictStage(storage, taskId, 'critic'))
      .toEqual({ judgments: 1, technicalFailures: 0, lifetimeTechnicalFailures: 2 })
  })
})

describe('accounting epoch と総上限', () => {
  it('旧 epoch の技術的失敗は現在の epoch の上限に入らないが、総数には入る', () => {
    const { storage, taskId } = seedConflicted()
    seedProductionShape(storage, taskId)

    expect(tallyConflictStage(storage, taskId, 'critic'))
      .toEqual({ judgments: 0, technicalFailures: 0, lifetimeTechnicalFailures: 2 })
  })

  it('総上限に達したら、現在の epoch の技術的失敗が 0 でも stage は使えない', () => {
    const { storage, taskId } = seedConflicted()
    for (let i = 0; i < PL_MAX_LIFETIME_TECHNICAL_FAILURES_PER_STAGE; i += 1) {
      recordLegacyRow(storage, taskId, criticRunnerFailed('codex'))
    }

    const selection = selectConflictStage(storage, taskId)
    expect(selection).toMatchObject({ stage: 'remediation', criticTechnicalFailures: 0, criticLifetimeTechnicalFailures: 6 })
    expect(selection.reason).toContain('6 in total (limit 6)')
  })

  it('判定は epoch に関係なく生涯で数える（epoch で判定予算は戻らない）', () => {
    const { storage, taskId } = seedConflicted()
    recordLegacyRow(storage, taskId, 'provider=codex model=m stage=remediation outcome=abandon')
    recordLegacyRow(storage, taskId, 'provider=claude_code stage=remediation proposed=h fspec=abc rejected_fspec=- outcome=not_different')

    expect(tallyConflictStage(storage, taskId, 'remediation').judgments).toBe(PL_MAX_REMEDIATION_ATTEMPTS)
    expect(hasRemediationBudgetLeft(storage, taskId)).toBe(false)
  })

  it('上限値そのもの', () => {
    expect(PL_MAX_CRITIC_ROUNDS).toBe(2)
    expect(PL_MAX_REMEDIATION_ATTEMPTS).toBe(2)
    expect(PL_MAX_TECHNICAL_FAILURES_PER_STAGE).toBe(3)
    expect(PL_MAX_LIFETIME_TECHNICAL_FAILURES_PER_STAGE).toBe(6)
    expect(CONFLICT_RECOVERY_ACCOUNTING_EPOCH).toBe(1)
  })
})

describe('Production #2cae0d07 の legacy 形を読み替える（行は削除しない・書き換えない）', () => {
  it('05:41 時点の形（runner_failed ×4）は critic から再開する', () => {
    const { storage, taskId } = seedConflicted()
    seedProductionShape(storage, taskId)

    expect(selectConflictStage(storage, taskId)).toMatchObject({
      stage: 'critic',
      criticRounds: 0,
      remediationAttempts: 0,
      criticTechnicalFailures: 0,
      remediationTechnicalFailures: 0,
      criticLifetimeTechnicalFailures: 2,
      remediationLifetimeTechnicalFailures: 2,
    })
    expect(storage.auditLog.findByEntity('pl_remediation', `remediate:${taskId}`)).toHaveLength(4)
  })

  it('09:53 時点の形（critiqued ×2 は成果物なし・remediation timeout）も critic から再開する', () => {
    const { storage, taskId } = seedConflicted()
    seedProductionShapeAfterDeploy(storage, taskId)

    expect(selectConflictStage(storage, taskId)).toMatchObject({
      stage: 'critic',
      criticRounds: 0,
      remediationAttempts: 0,
      criticLifetimeTechnicalFailures: 4,
      remediationLifetimeTechnicalFailures: 3,
    })
    // 行は1つも消えていない・書き換えていない。
    expect(storage.auditLog.findByEntity('pl_remediation', `remediate:${taskId}`)).toHaveLength(7)
  })

  it('09:53 形から: critic は総上限まであと2回、remediation はあと3回で terminal（有界）', () => {
    const { storage, taskId } = seedConflicted()
    seedProductionShapeAfterDeploy(storage, taskId)

    recordRound(storage, taskId, 'critic', [criticRunnerFailed('codex')])
    expect(selectConflictStage(storage, taskId).stage).toBe('critic')
    recordRound(storage, taskId, 'critic', [criticRunnerFailed('codex')])
    expect(selectConflictStage(storage, taskId).stage).toBe('remediation')

    for (let i = 0; i < PL_MAX_TECHNICAL_FAILURES_PER_STAGE; i += 1) {
      expect(selectConflictStage(storage, taskId).stage).toBe('remediation')
      recordRound(storage, taskId, 'remediation', [remediationRunnerFailed('codex')])
    }
    const terminal = selectConflictStage(storage, taskId)
    expect(terminal.stage).toBe('terminal')
    expect(terminal.reason).toContain('technical failures exhausted the remediation stage')
    expect(hasRemediationBudgetLeft(storage, taskId)).toBe(false)
  })
})

describe('stage ごとの技術的失敗上限（現在の epoch）', () => {
  it('critic の技術的失敗が上限に達したら、判定予算が残っていても remediation へ進む', () => {
    const { storage, taskId } = seedConflicted()
    criticJudgmentRound(storage, taskId)
    for (let i = 0; i < PL_MAX_TECHNICAL_FAILURES_PER_STAGE; i += 1) {
      recordRound(storage, taskId, 'critic', [criticRunnerFailed('codex')])
    }

    const selection = selectConflictStage(storage, taskId)
    expect(selection.stage).toBe('remediation')
    expect(selection.reason).toContain('critic stage hit 3 technical failure(s) in this accounting epoch')
  })

  it('上限未満の技術的失敗では stage を移らない', () => {
    const { storage, taskId } = seedConflicted()
    for (let i = 0; i < PL_MAX_TECHNICAL_FAILURES_PER_STAGE - 1; i += 1) {
      recordRound(storage, taskId, 'critic', [criticRunnerFailed('codex')])
      recordRound(storage, taskId, 'remediation', [remediationRunnerFailed('codex')])
    }

    expect(selectConflictStage(storage, taskId).stage).toBe('critic')
    expect(hasRemediationBudgetLeft(storage, taskId)).toBe(true)
  })

  it('remediation の技術的失敗が上限に達したら、判定予算が残っていても terminal', () => {
    const { storage, taskId } = seedConflicted()
    for (let i = 0; i < PL_MAX_CRITIC_ROUNDS; i += 1) criticJudgmentRound(storage, taskId)
    remediationJudgmentRound(storage, taskId)
    for (let i = 0; i < PL_MAX_TECHNICAL_FAILURES_PER_STAGE; i += 1) {
      recordRound(storage, taskId, 'remediation', [remediationRunnerFailed('codex')])
    }

    expect(selectConflictStage(storage, taskId).stage).toBe('terminal')
    expect(hasRemediationBudgetLeft(storage, taskId)).toBe(false)
  })
})

describe('PL tick — 予算会計の配線', () => {
  it('既に Escalate 済みの Production 形 Task は、予算が残るので再び解決 Round へ回る', async () => {
    const { storage, taskId } = seedConflicted()
    seedProductionShapeAfterDeploy(storage, taskId)
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

  it('成果物を出した critic Round ×2 + remediation Round ×2 は従来どおり terminal で、通知は1回だけ', async () => {
    const { storage, taskId } = seedConflicted()
    for (let i = 0; i < PL_MAX_CRITIC_ROUNDS; i += 1) criticJudgmentRound(storage, taskId)
    remediationJudgmentRound(storage, taskId)
    recordRound(storage, taskId, 'remediation', [
      'provider=claude_code stage=remediation proposed=h fspec=abc rejected_fspec=- outcome=not_different',
    ])
    expect(selectConflictStage(storage, taskId).stage).toBe('terminal')
    const notified: string[] = []
    const tickDeps = deps({ escalate: async (payload) => { notified.push(payload.body) } })

    for (let i = 0; i < 3; i += 1) {
      resetPlLoopInFlightForTest()
      await runPlTick(storage, tickDeps)
    }

    expect(notified).toHaveLength(1)
    expect(notified[0]).toContain('design_review_conflict')
  })

  it('技術的失敗で terminal になった場合も既存の terminal 経路で1回だけ通知し、行は増えない', async () => {
    const { storage, taskId } = seedConflicted()
    for (let i = 0; i < PL_MAX_TECHNICAL_FAILURES_PER_STAGE; i += 1) {
      recordRound(storage, taskId, 'critic', [criticRunnerFailed('codex')])
      recordRound(storage, taskId, 'remediation', [remediationRunnerFailed('codex')])
    }
    const rowsBefore = storage.auditLog.findByEntity('pl_remediation', `remediate:${taskId}`).length
    const notified: string[] = []
    const tickDeps = deps({ escalate: async (payload) => { notified.push(payload.body) } })

    for (let i = 0; i < 3; i += 1) {
      resetPlLoopInFlightForTest()
      await runPlTick(storage, tickDeps)
    }

    expect(notified).toHaveLength(1)
    expect(notified[0]).toContain('design_review_conflict')
    expect(selectConflictStage(storage, taskId).reason)
      .toContain('technical failures exhausted the remediation stage')
    // terminal は何も記録しない（行は増えない = 無制限に再試行しない）。
    expect(storage.auditLog.findByEntity('pl_remediation', `remediate:${taskId}`)).toHaveLength(rowsBefore)
  })

  it('同時に2つの tick が来ても、上限を超えて Round を2つ始められない（既存の in-flight ガード）', async () => {
    const { storage, taskId } = seedConflicted()
    // 技術的失敗が上限まであと1回の状態。
    for (let i = 0; i < PL_MAX_CRITIC_ROUNDS; i += 1) criticJudgmentRound(storage, taskId)
    recordRound(storage, taskId, 'remediation', [remediationRunnerFailed('codex')])
    recordRound(storage, taskId, 'remediation', [remediationRunnerFailed('claude_code')])
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let rounds = 0
    const tickDeps = deps({
      resolveConflict: async (s, id) => {
        rounds += 1
        await gate
        recordRound(s, id, 'remediation', [remediationRunnerFailed('codex')])
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
