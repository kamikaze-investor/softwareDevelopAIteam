import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildInitialImplementAiCliPrompt, INITIAL_WORKFLOW_JOB_EXISTS } from '../ctoAi/initialImplementWorkflow'
import { ensureInitialWorkflowsForActiveTasks, recoverReadyTasksWithoutJob } from '../ctoAi/projectInitialization'
import { executeQueuedRun } from '../designReview/queuedRunDispatch'
import { passDesignReviewRetryCooldown } from '../designReview/retryCooldownTestClock'
import { adoptRoadmapItem, buildAdoptedDescription } from '../ctoAi/roadmapAdoption'
import { checkImplementJobDesignReviewEvidence } from '../designReviewEvidencePolicy'
import {
  PL_MAX_REMEDIATION_ATTEMPTS,
  countRemediationAttempts,
  recordRemediationFailure,
  stageEntries,
} from './remediationStep'
import {
  PL_MAX_CRITIC_ROUNDS,
  buildPlRevisedScope,
  parsePlRevision,
  runConflictResolutionRound,
  selectConflictStage,
} from './conflictResolutionStep'

/**
 * 段階フロー全体の不変条件を固定する。
 *
 * ここで一番重要なのは **Challenge が PASS reroll にならないこと** である。
 * Challenge は「同一 frozen spec への once-per-(spec,finding) な fresh formal re-evaluation」
 * に限られ、Binding Safety / Authority の Finding は解除できない。
 */

const LF = String.fromCharCode(10)
const LEDGER = [
  '# Roadmap',
  '',
  '<!-- roadmap:id=conflicted-item state=planned -->',
  '1. [ ] **CONFLICT した項目** — より軽い代替があると指摘された',
  '   本文はここに続く。',
].join(LF)

const LEDGER_BODY = [
  '1. [ ] **CONFLICT した項目** — より軽い代替があると指摘された',
  '   本文はここに続く。',
].join(LF)

/** advisory な focus の CONFLICT（`scope_simplicity` は medium load の既定 focus）。 */
const CONFLICT_RESULT_JSON = JSON.stringify({
  focusedReviewResults: [
    { focus: 'scope_simplicity', decision: 'CONFLICT', summary: 'より軽い代替がある' },
  ],
  finalDecision: 'CONFLICT',
})

const CRITIQUE_BASE = {
  coreProblems: ['採用時の scope が ledger 本文全体を指している'],
  hiddenRisks: [],
  constraintsToPreserve: ['File Change Guard の保護範囲'],
  improvementDirections: ['既存 validation へ1件足す形に絞る'],
  thingsNotToChange: ['ledger 本文'],
  uncertainties: [],
}

const SUPPORTED_CRITIQUE = {
  ...CRITIQUE_BASE,
  findingAssessments: [
    { source: 'scope_simplicity', status: 'supported', rationale: 'より軽い代替が実在する' },
  ],
}

const DISPUTED_CRITIQUE = {
  ...CRITIQUE_BASE,
  findingAssessments: [{
    source: 'scope_simplicity',
    status: 'disputed',
    rationale: 'Finding は成立しない',
    grounds: 'contradicts_code_or_spec',
    evidence: 'validateRoadmapTasks が既に同じ検査をしている',
  }],
}

const ALIGNED_RESULT_JSON = JSON.stringify({
  focusedReviewResults: [
    { focus: 'scope_simplicity', decision: 'ALIGNED', summary: 'ok' },
  ],
  integrationReviewResult: { decision: 'ALIGNED', summary: 'ok' },
  finalDecision: 'ALIGNED',
})

const PL_REVISION = {
  implementationScope: '既存 validateRoadmapTasks の検査を1件足すだけ',
  allowedPaths: ['apps/api/src/storage'],
  acceptanceCriteria: ['絶対パスを含む allowedPaths が拒否される'],
  rationale: 'scope を1件へ絞った',
  respondsTo: 'scope_simplicity の指摘どおり新しい層を作らない',
}

let ledgerRoot: string
let previousTargetRoot: string | undefined

beforeAll(() => {
  ledgerRoot = mkdtempSync(join(tmpdir(), 'pl-conflict-'))
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

function seed(options: { resultJson?: string; roadmapTaskKey?: string } = {}): {
  storage: IStorage
  taskId: string
  designText: string
} {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'スマホだけでAI開発チームを運営できる', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'CONFLICT した項目',
    description: buildAdoptedDescription(LEDGER_BODY, '当初の広い scope'),
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: ['apps/api/src', 'packages/shared/src'],
    acceptanceCriteria: ['当初の受入条件'],
    roadmapTaskKey: options.roadmapTaskKey ?? 'conflicted-item',
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
    options.resultJson ?? CONFLICT_RESULT_JSON,
  )

  return { storage, taskId: task.id, designText }
}

/** Critic runner を差し替える deps。 */
function deps(critique: unknown, over: Record<string, unknown> = {}) {
  return {
    readLedger: () => LEDGER,
    runnerDeps: {
      runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
      execute: async () => ({ ok: true, stdout: JSON.stringify(critique), timedOut: false }),
    },
    revise: async () => JSON.stringify(PL_REVISION),
    // 既定では採用させない（適用そのものは remediationStep.test.ts が持つ）。
    adopt: async () => ({ ok: false as const, code: 'SYNC_FAILED' as const, reason: 'not exercised here' }),
    ...over,
  }
}

describe('selectConflictStage — 既存 state の observer', () => {
  it('Critic Round が残っていれば critic', () => {
    const { storage, taskId } = seed()

    expect(selectConflictStage(storage, taskId).stage).toBe('critic')
  })

  it('Critic Round を使い切ったら remediation へ移る', () => {
    const { storage, taskId } = seed()
    for (let i = 0; i < PL_MAX_CRITIC_ROUNDS; i += 1) {
      recordRemediationFailure(storage, taskId, 'stage=critic outcome=critiqued')
    }

    expect(selectConflictStage(storage, taskId).stage).toBe('remediation')
  })

  it('Critic も Remediation も判定予算が尽きたら terminal（runner_failed ではなく parse 済みの提案で尽きる）', () => {
    // 以前は remediation runner_failed ×2 で terminal としていたが、それは判定 0 件の取り残し
    // （2026-10-23 `#2cae0d07`）を固定していた。判定予算は parse 済みの提案だけが消費する。
    const { storage, taskId } = seed()
    for (let i = 0; i < PL_MAX_CRITIC_ROUNDS; i += 1) {
      recordRemediationFailure(storage, taskId, 'stage=critic outcome=critiqued')
    }
    recordRemediationFailure(storage, taskId, 'stage=remediation outcome=abandon')
    recordRemediationFailure(storage, taskId, 'stage=remediation proposed=h fspec=abc rejected_fspec=- outcome=not_different')

    const selection = selectConflictStage(storage, taskId)
    expect(selection.stage).toBe('terminal')
    expect(selection.reason).toBe('critic rounds and remediation attempts are both exhausted')
  })

  it('Critic 判定が尽き remediation runner_failed ×2 だけなら remediation がまだ使える', () => {
    const { storage, taskId } = seed()
    for (let i = 0; i < PL_MAX_CRITIC_ROUNDS; i += 1) {
      recordRemediationFailure(storage, taskId, 'stage=critic outcome=critiqued')
    }
    for (let i = 0; i < PL_MAX_REMEDIATION_ATTEMPTS; i += 1) {
      recordRemediationFailure(storage, taskId, 'stage=remediation outcome=runner_failed')
    }

    expect(selectConflictStage(storage, taskId).stage).toBe('remediation')
  })

  it('**challenge は selector から返らない**（固定 stage ではなく条件分岐）', () => {
    const { storage, taskId } = seed()
    const stages = new Set<string>()
    for (let i = 0; i <= PL_MAX_CRITIC_ROUNDS + PL_MAX_REMEDIATION_ATTEMPTS; i += 1) {
      stages.add(selectConflictStage(storage, taskId).stage)
      recordRemediationFailure(storage, taskId, 'stage=critic outcome=critiqued')
    }

    expect(stages.has('challenge')).toBe(false)
  })
})

describe('Critic → 条件分岐', () => {
  it('follow-up Task でも base ledger item の本文を Critic へ渡す', async () => {
    const { storage, taskId } = seed({ roadmapTaskKey: 'conflicted-item#2' })
    let criticPrompt = ''

    const result = await runConflictResolutionRound(storage, taskId, deps(SUPPORTED_CRITIQUE, {
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async (raw: string) => {
          criticPrompt = (JSON.parse(raw) as { prompt: string }).prompt
          return { ok: true, stdout: JSON.stringify(SUPPORTED_CRITIQUE), timedOut: false }
        },
      },
    }) as never)

    expect(result.failureCode).not.toBe('item_not_in_ledger')
    expect(criticPrompt).toContain('Roadmap item (the CEO-approved source of truth): conflicted-item')
    expect(criticPrompt).toContain('本文はここに続く。')
  })

  it('follow-up Task の PL revision は同じ Task identity を更新し、fresh Review 後に同じ Task の Job を作る', async () => {
    const { storage, taskId } = seed({ roadmapTaskKey: 'conflicted-item#2' })
    const projectId = storage.tasks.findById(taskId)?.projectId as string
    const taskCount = storage.tasks.findByProjectId(projectId).length
    const originalRun = storage.designReviewRuns.findLatestByTaskId(taskId)

    const result = await runConflictResolutionRound(storage, taskId, deps(SUPPORTED_CRITIQUE, {
      adopt: (s: IStorage, input: Parameters<typeof adoptRoadmapItem>[1]) => adoptRoadmapItem(s, input, {
        ensureInitialWorkflows: (st, pid) => ensureInitialWorkflowsForActiveTasks(st, pid, {
          runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
          execute: async () => ({ ok: true, stdout: ALIGNED_RESULT_JSON, timedOut: false }),
        }),
      }),
    }) as never)

    expect(result).toMatchObject({ status: 'revised_and_aligned', taskId })
    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(taskCount)
    expect(storage.tasks.findById(taskId)?.roadmapTaskKey).toBe('conflicted-item#2')
    expect(storage.designReviewRuns.findLatestByTaskId(taskId)?.id).not.toBe(originalRun?.id)
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(1)
  })

  it('dispute が無ければ Challenge せず PL revision へ進む', async () => {
    const { storage, taskId } = seed()

    const result = await runConflictResolutionRound(storage, taskId, deps(SUPPORTED_CRITIQUE) as never)

    expect(result.stage).toBe('pl_revision')
    expect(stageEntries(storage, taskId, 'challenge')).toHaveLength(0)
  })

  it('**根拠の無い dispute では Challenge しない**（review を消費させない）', async () => {
    // grounds / evidence を欠く dispute は `insufficient_evidence` へ落ちるので、
    // frozen spec の再評価を1回も消費しない。judgment の再抽選を単なる異論で引けない。
    for (const assessment of [
      { source: 'scope_simplicity', status: 'disputed', rationale: '別の考え方もある' },
      { source: 'scope_simplicity', status: 'disputed', rationale: 'r', grounds: 'wrong_premise' },
      { source: 'scope_simplicity', status: 'disputed', rationale: 'r', evidence: 'e' },
      { source: 'scope_simplicity', status: 'disputed', rationale: 'r', grounds: 'i_disagree', evidence: 'e' },
      { source: 'scope_simplicity', status: 'insufficient_evidence', rationale: '判断できない' },
    ]) {
      const { storage, taskId } = seed()

      const result = await runConflictResolutionRound(storage, taskId, deps(
        { ...CRITIQUE_BASE, findingAssessments: [assessment] },
      ) as never)

      expect(result.stage).toBe('pl_revision')
      expect(stageEntries(storage, taskId, 'challenge')).toHaveLength(0)
    }
  })

  it('根拠付き dispute でも**却下済みの同一 spec を再審査しない**（verdict re-roll は DA trigger 7 に反する）', async () => {
    // 以前は byte-identical な spec を fresh Design Review へ再提出し、ALIGNED なら Job を作っていた。
    // 再審査 run が ALIGNED で終われば既存 coordinator が usable evidence を登録し、既存の回収が
    // PL を経由せずに Job を作るので、「ALIGNED でも Job を作らない」では塞がらない。
    const { storage, taskId } = seed()
    const originalRun = storage.designReviewRuns.findLatestByTaskId(taskId)

    const result = await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE) as never)

    // Critique は PL revision へ渡り、同一 spec の review run は作られない。Job も無い。
    expect(result.stage).toBe('pl_revision')
    expect(storage.designReviewRuns.findLatestByTaskId(taskId)?.id).toBe(originalRun?.id)
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(0)
    // 元 CONFLICT run は履歴として保持される（削除・上書きしない）。
    expect(storage.designReviewRuns.findById(originalRun!.id)?.resultJson).toBe(originalRun!.resultJson)
    // 異議は記録する（再審査していないことも明示する）。
    const details = stageEntries(storage, taskId, 'challenge').map((e) => e.detail ?? '')
    expect(details).toHaveLength(1)
    expect(details[0]).toContain('orig_verdict=CONFLICT')
    expect(details[0]).toContain('finding=scope_simplicity')
    expect(details[0]).toContain('grounds=contradicts_code_or_spec')
    expect(details[0]).toContain('evidence=yes')
    expect(details[0]).toContain('rereview=none')
    expect(details[0]).toContain('outcome=critic_dispute_recorded')
  })

  it('同じ (spec, finding) への異議は1行だけ記録する（Round を重ねても二重に書かない）', async () => {
    const { storage, taskId } = seed()

    await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE) as never)
    await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE) as never)

    expect(stageEntries(storage, taskId, 'challenge')).toHaveLength(1)
    // 異議の記録は critic の予算に入らない（Round は critiqued 行で数える）。
    expect(selectConflictStage(storage, taskId).criticRounds).toBe(2)
  })

  it('根拠付き dispute でも、PL が修正した（materially different な）spec は fresh ALIGNED なら従来どおり Job を作る', async () => {
    const { storage, taskId } = seed()
    const originalRun = storage.designReviewRuns.findLatestByTaskId(taskId)

    const result = await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE, {
      adopt: (s: IStorage, input: Parameters<typeof adoptRoadmapItem>[1]) => adoptRoadmapItem(s, input, {
        ensureInitialWorkflows: (st, pid) => ensureInitialWorkflowsForActiveTasks(st, pid, {
          runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
          execute: async () => ({ ok: true, stdout: ALIGNED_RESULT_JSON, timedOut: false }),
        }),
      }),
    }) as never)

    expect(result).toMatchObject({ status: 'revised_and_aligned', taskId })
    expect(storage.designReviewRuns.findLatestByTaskId(taskId)?.designTextHash).not.toBe(originalRun?.designTextHash)
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(1)
  })
})

describe('Binding Safety / Authority は Challenge で release されない', () => {
  it('safety_recovery の dispute では Challenge へ分岐しない', async () => {
    const { storage, taskId } = seed({
      resultJson: JSON.stringify({
        focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }],
        finalDecision: 'CONFLICT',
      }),
    })
    const bindingDispute = {
      ...CRITIQUE_BASE,
      findingAssessments: [{
        source: 'safety_recovery',
        status: 'disputed',
        rationale: 'Finding は成立しない',
        grounds: 'wrong_premise',
        evidence: 'guard は既にその条件を扱っている',
      }],
    }

    const result = await runConflictResolutionRound(storage, taskId, deps(bindingDispute) as never)

    expect(result.stage).toBe('pl_revision')
    expect(stageEntries(storage, taskId, 'challenge')).toHaveLength(0)
    // 争点は捨てず、呼び出し側（人への通知）へ渡す。
    expect(result.bindingDisputes?.map((d) => d.source)).toEqual(['safety_recovery'])
  })
})

describe('Critic model の Preference と fallback', () => {
  it('別 Critic model が使えるならそちらを優先する', async () => {
    const { storage, taskId } = seed()
    recordRemediationFailure(storage, taskId, 'stage=critic provider=codex model=gpt-5.6-sol outcome=critiqued')
    const used: string[] = []

    await runConflictResolutionRound(storage, taskId, deps(SUPPORTED_CRITIQUE, {
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async (raw: string) => {
          used.push((JSON.parse(raw) as { model: string }).model)
          return { ok: true, stdout: JSON.stringify(SUPPORTED_CRITIQUE), timedOut: false }
        },
      },
    }) as never)

    expect(used).toEqual(['claude-opus-5'])
  })

  it('**Critic model が足りなくても BLOCKED にしない**（Round は進む）', async () => {
    // 同一 model への fallback そのものは `selectCriticModel()` の単体テストが固定している。
    // ここで固定するのは step 側の性質 —— **model 不足を理由に停止しない**こと。
    // Critic Round を使い切っていれば次は remediation であって terminal ではない。
    const { storage, taskId } = seed()
    for (const model of ['gpt-5.6-sol', 'claude-opus-5']) {
      recordRemediationFailure(
        storage,
        taskId,
        `stage=critic provider=x model=${model} outcome=critiqued`,
      )
    }

    expect(selectConflictStage(storage, taskId).stage).toBe('remediation')
  })

  it('Critic の provider / model と再利用状況が audit に残る（可否には影響しない）', async () => {
    const { storage, taskId } = seed()

    await runConflictResolutionRound(storage, taskId, deps(SUPPORTED_CRITIQUE) as never)
    // Critic の実行行（`provider=` を持つ行）を探す。同じ stage には PL revision の行も載る。
    const entry = stageEntries(storage, taskId, 'critic')
      .find((e) => (e.detail ?? '').includes('provider='))

    expect(entry?.detail).toContain('provider=codex')
    expect(entry?.detail).toContain('reused_model=no')
  })
})

describe('有界性', () => {
  it('Critic runner 失敗も Round として記録する（記録しないと予算が効かない）', async () => {
    const { storage, taskId } = seed()

    const result = await runConflictResolutionRound(storage, taskId, deps(SUPPORTED_CRITIQUE, {
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async () => ({ ok: false, stdout: '', error: 'boom', timedOut: false }),
      },
    }) as never)

    expect(result.status).toBe('critic_failed')
    // Critic の失敗は **Critic Round の予算**を消費する（Remediation の予算とは別勘定）。
    expect(stageEntries(storage, taskId, 'critic').length).toBe(1)
    expect(countRemediationAttempts(storage, taskId)).toBe(0)
  })

  it('Critic runner が ok=false でも stdout に完全な Critique があれば判定として数え、その Critique は使わない', async () => {
    const { storage, taskId } = seed()
    let revised = false

    const result = await runConflictResolutionRound(storage, taskId, deps(SUPPORTED_CRITIQUE, {
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async () => ({ ok: false, stdout: JSON.stringify(SUPPORTED_CRITIQUE), error: 'exit 1', timedOut: false }),
      },
      revise: async () => { revised = true; return '' },
    }) as never)

    expect(result.status).toBe('critic_failed')
    expect(revised).toBe(false)
    const rows = stageEntries(storage, taskId, 'critic').map((e) => e.detail ?? '')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('provider=')
    expect(rows[0]).toContain('outcome=runner_failed_after_critique')
    expect(selectConflictStage(storage, taskId)).toMatchObject({ criticRounds: 1, criticTechnicalFailures: 0 })
  })

  it('Critique が壊れていても Round として記録する', async () => {
    const { storage, taskId } = seed()

    const result = await runConflictResolutionRound(storage, taskId, deps('not a critique') as never)

    expect(result.status).toBe('critique_unusable')
    // Critic の失敗は **Critic Round の予算**を消費する（Remediation の予算とは別勘定）。
    expect(stageEntries(storage, taskId, 'critic').length).toBe(1)
    expect(countRemediationAttempts(storage, taskId)).toBe(0)
  })
})

describe('PL revision 後に stale な Design Review evidence を再利用できない', () => {
  it('旧 spec の ALIGNED evidence では、PL が修正した spec の Job を通せない', () => {
    // 既存テストは Gate 単体（`reviewedPromptIdentity.test.ts`: 1文字変えた prompt は拒否）を
    // 固定しているが、**PL revision 経路が実際に別 prompt を作ること**は固定していなかった。
    // ここでは revision 経路が組む prompt をそのまま Gate へ当て、hash 不一致になることを示す。
    const { storage, taskId } = seed()
    const task = storage.tasks.findById(taskId)!
    const oldPrompt = buildInitialImplementAiCliPrompt(task)

    // 1. 旧 spec に対して ALIGNED evidence が存在する状態を作る。
    storage.designReviewEvidence.create({
      reviewKind: 'task',
      subjectId: taskId,
      taskId,
      designTextHash: computeDesignTextHash(oldPrompt),
      reviewLoad: 'medium',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    } as never)
    // 旧 prompt ならその evidence で通る（前提の確認）。
    expect(checkImplementJobDesignReviewEvidence(
      { taskId, aiCliMode: 'implement', aiCliPrompt: oldPrompt },
      storage.designReviewEvidence,
    ).ok).toBe(true)

    // 2. PL revision が組む spec（判断記録を折り込んだ最終形）から prompt を作る。
    const revisedPrompt = buildInitialImplementAiCliPrompt({
      description: buildAdoptedDescription(
        LEDGER_BODY,
        buildPlRevisedScope(PL_REVISION, SUPPORTED_CRITIQUE as never),
      ),
      allowedPaths: PL_REVISION.allowedPaths,
    })

    // 3. 旧 evidence では通らない。**fresh formal review が必要になる。**
    const gate = checkImplementJobDesignReviewEvidence(
      { taskId, aiCliMode: 'implement', aiCliPrompt: revisedPrompt },
      storage.designReviewEvidence,
    )

    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.code).toBe('DESIGN_REVIEW_HASH_MISMATCH')
  })
})

describe('parsePlRevision', () => {
  it('完全な修正案を受理する', () => {
    expect(parsePlRevision(JSON.stringify(PL_REVISION))?.allowedPaths).toEqual(['apps/api/src/storage'])
  })

  it('respondsTo / rationale の欠落は拒否する（Finding への回答を省かせない）', () => {
    const { respondsTo: _r, ...noResponds } = PL_REVISION
    const { rationale: _a, ...noRationale } = PL_REVISION

    expect(parsePlRevision(JSON.stringify(noResponds))).toBeUndefined()
    expect(parsePlRevision(JSON.stringify(noRationale))).toBeUndefined()
  })

  it('空の allowedPaths / acceptanceCriteria は拒否する', () => {
    expect(parsePlRevision(JSON.stringify({ ...PL_REVISION, allowedPaths: [] }))).toBeUndefined()
    expect(parsePlRevision(JSON.stringify({ ...PL_REVISION, acceptanceCriteria: [] }))).toBeUndefined()
  })
})
/**
 * **Challenge の再評価が判定を出さなかった（requeued）場合**（独立レビュー round 5・2026-10-16）。
 *
 * 評価済み・否定として記録せず pending で返す。同じ run が rekick で判定まで進み、ALIGNED なら
 * 既存 `recoverReadyTasksWithoutJob()` が Job を1回だけ作る。Challenge を引き直すことはしない。
 */
describe('Critic runner は TARGET_ROOT 未設定でも target root で AI CLI を動かす（2026-10-23 Production）', () => {
  it('TARGET_ROOT が無いとき workingDir は /workspace/target（Stable の runner workingDir ではない）', async () => {
    const { storage, taskId } = seed()
    const saved = process.env.TARGET_ROOT
    let captured: { workingDir?: string } | undefined
    try {
      delete process.env.TARGET_ROOT
      await runConflictResolutionRound(storage, taskId, deps(SUPPORTED_CRITIQUE, {
        readLedger: () => LEDGER,
        runnerDeps: {
          runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: '/srv/ai-team/stable-checkout',
          execute: async (input: string) => {
            captured = JSON.parse(input) as { workingDir?: string }
            return { ok: true, stdout: JSON.stringify(SUPPORTED_CRITIQUE), timedOut: false }
          },
        },
      }) as never)
    } finally {
      if (saved === undefined) delete process.env.TARGET_ROOT
      else process.env.TARGET_ROOT = saved
    }

    expect(captured?.workingDir).toBe(resolve('/workspace/target'))
  })
})
