import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildInitialImplementAiCliPrompt } from '../ctoAi/initialImplementWorkflow'
import { buildAdoptedDescription } from '../ctoAi/roadmapAdoption'
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

function seed(options: { resultJson?: string } = {}): {
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

  it('Critic も Remediation も尽きたら terminal', () => {
    const { storage, taskId } = seed()
    for (let i = 0; i < PL_MAX_CRITIC_ROUNDS; i += 1) {
      recordRemediationFailure(storage, taskId, 'stage=critic outcome=critiqued')
    }
    for (let i = 0; i < PL_MAX_REMEDIATION_ATTEMPTS; i += 1) {
      recordRemediationFailure(storage, taskId, 'stage=remediation outcome=runner_failed')
    }

    expect(selectConflictStage(storage, taskId).stage).toBe('terminal')
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
        { reEvaluate: async () => { throw new Error('must not re-evaluate without grounds') } },
      ) as never)

      expect(result.stage).toBe('pl_revision')
      expect(stageEntries(storage, taskId, 'challenge')).toHaveLength(0)
    }
  })

  it('根拠付き dispute なら Challenge へ分岐し、**同一 design text** を再評価する', async () => {
    const { storage, taskId, designText } = seed()
    let reEvaluated: string | undefined

    const result = await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE, {
      reEvaluate: async (_s: unknown, input: { designText: string }) => {
        reEvaluated = input.designText
        return { status: 'not_aligned', decision: 'CONFLICT' }
      },
    }) as never)

    expect(result.stage).toBe('challenge')
    // **byte-identical であること。** spec を変更しない。
    expect(reEvaluated).toBe(designText)
  })

  it('Challenge が ALIGNED でなければ release しない（CONFLICT / UNCERTAIN の双方）', async () => {
    for (const decision of ['CONFLICT', 'UNCERTAIN', 'REVIEW_UNAVAILABLE']) {
      const { storage, taskId } = seed()

      const result = await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE, {
        reEvaluate: async () => ({ status: 'not_aligned', decision }),
        ensureJob: async () => { throw new Error('must not create a job') },
      }) as never)

      expect(result.status).toBe('challenge_not_aligned')
    }
  })

  it('Challenge が ALIGNED なら既存 Job Gate 経由で Job が作られる', async () => {
    const { storage, taskId } = seed()
    let gateCalled = false

    const result = await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE, {
      reEvaluate: async () => ({ status: 'evidence_registered', decision: 'ALIGNED' }),
      ensureJob: async () => { gateCalled = true; return { taskId, status: 'created', job: {} } },
    }) as never)

    expect(result.status).toBe('challenge_aligned')
    expect(gateCalled).toBe(true)
  })

  it('**same spec + same finding への Challenge は1回だけ**（PASS reroll にしない）', async () => {
    const { storage, taskId } = seed()
    let evaluations = 0
    const challenging = deps(DISPUTED_CRITIQUE, {
      reEvaluate: async () => {
        evaluations += 1
        return { status: 'not_aligned', decision: 'CONFLICT' }
      },
    })

    const first = await runConflictResolutionRound(storage, taskId, challenging as never)
    const second = await runConflictResolutionRound(storage, taskId, challenging as never)

    expect(first.stage).toBe('challenge')
    // 2回目は上限に当たり、Challenge せず PL revision へ落ちる（止まらない）。
    expect(second.stage).toBe('pl_revision')
    expect(evaluations).toBe(1)
  })

  it('Challenge の上限に当たっても BLOCKED にせず PL revision を続ける', async () => {
    const { storage, taskId } = seed()
    recordRemediationFailure(
      storage,
      taskId,
      `stage=challenge chal=${computeDesignTextHash(
        buildInitialImplementAiCliPrompt({
          description: buildAdoptedDescription(LEDGER_BODY, '当初の広い scope'),
          allowedPaths: ['apps/api/src', 'packages/shared/src'],
        }),
      ).slice(0, 12)}:scope_simplicity outcome=starting`,
    )

    const result = await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE) as never)

    expect(result.stage).toBe('pl_revision')
  })

  it('元 CONFLICT run は履歴として保持される（削除・上書きしない）', async () => {
    const { storage, taskId } = seed()
    const before = storage.designReviewRuns.findLatestByTaskId(taskId)

    await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE, {
      reEvaluate: async () => ({ status: 'not_aligned', decision: 'CONFLICT' }),
    }) as never)

    // 差し替えた reEvaluate は run を作らないので、元 run がそのまま残っていること。
    expect(storage.designReviewRuns.findById(before!.id)).toBeDefined()
    expect(storage.designReviewRuns.findById(before!.id)?.resultJson).toBe(before!.resultJson)
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

    const result = await runConflictResolutionRound(storage, taskId, deps(bindingDispute, {
      reEvaluate: async () => { throw new Error('binding finding must not be challenged') },
    }) as never)

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

describe('audit / observability', () => {
  it('Challenge は orig provider/model を **unavailable** と明示する', async () => {
    // 元 Design Reviewer の provider/model は既存 pipeline が記録していない。
    // 取得できないものを推測で埋めず `unavailable` と書く
    // （owner: review-provider-exhausted-alternate-rereview）。
    const { storage, taskId } = seed()

    await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE, {
      reEvaluate: async () => ({ status: 'not_aligned', decision: 'CONFLICT' }),
    }) as never)
    const details = stageEntries(storage, taskId, 'challenge').map((e) => e.detail ?? '').join(' ')

    expect(details).toContain('orig_provider=unavailable')
    expect(details).toContain('orig_model=unavailable')
  })

  it('verdict reversal を後から追跡できる形で記録する', async () => {
    const { storage, taskId } = seed()

    await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE, {
      reEvaluate: async () => ({ status: 'evidence_registered', decision: 'ALIGNED' }),
      ensureJob: async () => ({ taskId, status: 'created', job: {} }),
    }) as never)
    const details = stageEntries(storage, taskId, 'challenge').map((e) => e.detail ?? '').join(' ')

    expect(details).toContain('orig_verdict=CONFLICT')
    expect(details).toContain('chal_verdict=ALIGNED')
    expect(details).toContain('reversal=yes')
    expect(details).toContain('finding=scope_simplicity')
    expect(details).toContain('grounds=contradicts_code_or_spec')
    expect(details).toContain('evidence=yes')
  })

  it('Challenge の消費は再評価の**前**に記録する（途中で落ちても再抽選できない）', async () => {
    const { storage, taskId } = seed()

    await runConflictResolutionRound(storage, taskId, deps(DISPUTED_CRITIQUE, {
      reEvaluate: async () => { throw new Error('crash during re-evaluation') },
    }) as never).catch(() => undefined)

    expect(stageEntries(storage, taskId, 'challenge').length).toBeGreaterThan(0)
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
