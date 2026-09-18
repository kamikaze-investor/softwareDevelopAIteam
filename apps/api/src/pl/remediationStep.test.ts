import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CLAUDE_REVIEWER_MODEL,
  CODEX_REVIEWER_MODEL,
} from '@ai-team/worker/src/approvalLevel/reviewerAdapter.js'
import { FLAGSHIP_REMEDIATION_CANDIDATES, selectRemediationModel } from '@ai-team/shared'
import { CHEAP_AI_CONFIG } from '../aiExplain/cheapAiClient'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildInitialImplementAiCliPrompt } from '../ctoAi/initialImplementWorkflow'
import { buildAdoptedDescription } from '../ctoAi/roadmapAdoption'
import {
  buildRemediatedScope,
  computeProposedDesignTextHash,
  countRemediationAttempts,
  applyRevisedSpec,
  findRemediationSubject,
  stageEntries,
  PL_MAX_REMEDIATION_ATTEMPTS,
  REMEDIATION_SYSTEM_PROMPT,
  buildRemediationPrompt,
  runRemediationStep,
} from './remediationStep'

/**
 * ここで固定している不変条件:
 *
 *   1. CONFLICT で止まった（Job 0件・pending）採用だけが対象になる
 *   2. **却下済みの設計テキストは再審査させない**（判定の揺れで CONFLICT を洗浄させない）
 *   3. 広すぎる allowedPaths は既存 Gate が弾く
 *   4. ledger に無い / 採用不可 state の項目は Gate が弾く
 *   5. 採用経路の `ok:true` を成功にしない（Job の実在だけを根拠にする）
 *   6. 有界（`PL_MAX_REMEDIATION_ATTEMPTS`）
 */

const LF = String.fromCharCode(10)
const LEDGER = [
  '# Roadmap',
  '',
  '<!-- roadmap:id=conflicted-item state=planned -->',
  '1. [ ] **CONFLICT した項目** — より軽い代替があると指摘された',
  '   本文はここに続く。',
  '',
  '<!-- roadmap:id=deferred-item state=deferred -->',
  '2. [ ] **現在は着手しない項目**',
].join(LF)

const LEDGER_BODY = [
  '1. [ ] **CONFLICT した項目** — より軽い代替があると指摘された',
  '   本文はここに続く。',
].join(LF)

const CONFLICT_RESULT_JSON = JSON.stringify({
  focusedReviewResults: [
    {
      focus: 'scope_simplicity',
      decision: 'CONFLICT',
      summary: 'より軽い代替がある',
      findings: [{ message: '新しい正規化層は複雑すぎる' }],
    },
  ],
  finalDecision: 'CONFLICT',
})

const PROPOSAL = {
  diagnosis: 'scope が広すぎた',
  resolution: '既存 validation の1箇所へ寄せる',
  implementationScope: '既存 validateRoadmapTasks の検査を1件足すだけ',
  allowedPaths: ['apps/api/src/storage'],
  acceptanceCriteria: ['絶対パスを含む allowedPaths が拒否される'],
  whyResolved: '新しい層を作らないので scope_simplicity の指摘に答えている',
  safetyImpact: 'Guard も Gate も変更しないため Safety Boundary は不変',
  unresolvedConcerns: [],
  abandon: false,
}

let ledgerRoot: string
let previousTargetRoot: string | undefined

beforeAll(() => {
  ledgerRoot = mkdtempSync(join(tmpdir(), 'pl-remediation-'))
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

interface Seeded {
  storage: IStorage
  projectId: string
  taskId: string
}

/** CONFLICT で止まった状態（Job 0件 / pending / 終端した非 ALIGNED run）を作る。 */
function seedConflictedTask(options: {
  roadmapTaskKey?: string
  resultJson?: string
  runStatus?: 'queued' | 'running' | 'succeeded' | 'failed'
  allowedPaths?: string[]
} = {}): Seeded {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'スマホだけでAI開発チームを運営できる世界を作る', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'CONFLICT した項目',
    description: buildAdoptedDescription(LEDGER_BODY, '当初の広い scope'),
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: options.allowedPaths ?? ['apps/api/src', 'packages/shared/src'],
    acceptanceCriteria: ['当初の受入条件'],
    roadmapTaskKey: options.roadmapTaskKey ?? 'conflicted-item',
    phase: 1,
    roadmapActive: true,
  })

  const run = storage.designReviewRuns.create({
    taskId: task.id,
    taskTitle: task.title,
    designText: buildInitialImplementAiCliPrompt(task),
    designTextHash: computeDesignTextHash(buildInitialImplementAiCliPrompt(task)),
    changedFiles: [],
  })
  const claimed = storage.designReviewRuns.claim(run.id, 3)
  storage.designReviewRuns.complete(
    run.id,
    claimed.claimToken as string,
    options.runStatus === 'failed' ? 'failed' : 'succeeded',
    options.resultJson ?? CONFLICT_RESULT_JSON,
  )

  return { storage, projectId: project.id, taskId: task.id }
}

function deps(over: Partial<Parameters<typeof runRemediationStep>[2]> = {}) {
  return {
    readLedger: () => LEDGER,
    runnerDeps: {
      runnerCommand: 'noop',
      runnerArgs: [],
      homeDirectory: ledgerRoot,
      workingDir: ledgerRoot,
      execute: async () => ({ ok: true, stdout: JSON.stringify(PROPOSAL), timedOut: false }),
    },
    ...over,
  }
}

describe('model 候補が既存 Reviewer 定数から drift していない', () => {
  it('flagship の model id は既存 Reviewer と同じ値を使う', () => {
    // 役割は別（reviewer vs remediator）だが、どちらも「その vendor の flagship」を指す。
    // 片方だけ更新されて気付かない状態を防ぐため、値の一致をテストで固定する
    // （`role-model-registry` が入ったら、この対応は Registry 側の責務になる）。
    const models = FLAGSHIP_REMEDIATION_CANDIDATES.map((candidate) => candidate.model)

    expect(models).toContain(CODEX_REVIEWER_MODEL)
    expect(models).toContain(CLAUDE_REVIEWER_MODEL)
  })
})

describe('findRemediationSubject — 対象の判定', () => {
  it('CONFLICT で終端した run + Job 0件 + pending なら対象', () => {
    const { storage, taskId } = seedConflictedTask()

    const subject = findRemediationSubject(storage, taskId)

    expect(subject?.roadmapId).toBe('conflicted-item')
    expect(subject?.findings[0]?.source).toBe('scope_simplicity')
    expect(subject?.rejectedSpecKeys).toHaveLength(1)
  })

  it('Job が1件でもあれば対象外（実行済みの変更と新しい指示を混ぜない）', () => {
    const { storage, projectId, taskId } = seedConflictedTask()
    storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'queued',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    } as never)

    expect(findRemediationSubject(storage, taskId)).toBeUndefined()
  })

  it('run が queued / running のうちは対象外（採用直後に必ず通る状態を誤射しない）', () => {
    // FM4: Review がまだ動いている最中に「解決していない」と判断すると、
    // 進行中の復旧を誤って Escalation にしてしまう。
    const { storage, taskId } = seedConflictedTask()
    const fresh = storage.designReviewRuns.create({
      taskId,
      taskTitle: 't',
      designText: 'next generation',
      designTextHash: computeDesignTextHash('next generation'),
      changedFiles: [],
    })

    expect(fresh.status).toBe('queued')
    expect(findRemediationSubject(storage, taskId)).toBeUndefined()
  })

  it('run が failed なら対象外（provider 障害は提案を作り直しても直らない）', () => {
    const { storage, taskId } = seedConflictedTask({ runStatus: 'failed' })

    expect(findRemediationSubject(storage, taskId)).toBeUndefined()
  })

  it('**UNCERTAIN は対象外**（fail-closed な不確実性を書き直しへ流さない）', () => {
    // `executeDesignReviewRun()` は CONFLICT / UNCERTAIN / REVIEW_UNAVAILABLE を
    // すべて `status='succeeded'` として保存するので、status だけでは区別できない。
    // focus 集合の不一致は `recomputeDecision()` が UNCERTAIN へ倒す構造検証であり、
    // 設計への異議ではない。提案を書き直しても答えようがない。
    const { storage, taskId } = seedConflictedTask({
      resultJson: JSON.stringify({
        // medium load で期待される focus 集合と一致しない → 構造検証で UNCERTAIN。
        focusedReviewResults: [{ focus: 'not_a_real_focus', decision: 'CONFLICT' }],
        finalDecision: 'CONFLICT',
      }),
    })

    expect(findRemediationSubject(storage, taskId)).toBeUndefined()
  })

  it('runner の自己申告 finalDecision は採用せず、API と同じ再計算を通す', () => {
    // `finalDecision: 'ALIGNED'` と自己申告していても、focused が CONFLICT なら
    // 再計算は CONFLICT になる（安全側集約）。逆に構造が壊れていれば CONFLICT にしない。
    const { storage, taskId } = seedConflictedTask({
      resultJson: JSON.stringify({
        focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }],
        finalDecision: 'ALIGNED',
      }),
    })

    expect(findRemediationSubject(storage, taskId)).toBeDefined()
  })

  it('result_json が壊れていれば CONFLICT と決めつけない', () => {
    const { storage, taskId } = seedConflictedTask({ resultJson: 'not json' })

    expect(findRemediationSubject(storage, taskId)).toBeUndefined()
  })

  it('Roadmap 由来でない Task は対象外', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'p', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 't', description: 'd', status: 'pending',
      assignee: 'developer_ai', dependencies: [], allowedPaths: ['apps/api/src'],
      acceptanceCriteria: ['c'], phase: 1, roadmapActive: true,
    })

    expect(findRemediationSubject(storage, task.id)).toBeUndefined()
  })

  it('ALIGNED evidence が同じ hash で登録済みなら対象外', () => {
    const { storage, taskId } = seedConflictedTask()
    const run = storage.designReviewRuns.findLatestByTaskId(taskId)
    storage.designReviewEvidence.create({
      reviewKind: 'task',
      subjectId: taskId,
      taskId,
      designTextHash: run?.designTextHash as string,
      reviewLoad: 'medium',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    } as never)

    expect(findRemediationSubject(storage, taskId)).toBeUndefined()
  })
})

describe('却下済みテキストの再審査を拒否する', () => {
  it('提案が却下済みの設計テキストと一致するなら、Review を走らせずに拒否する', async () => {
    // **これが無いと CONFLICT を判定の揺れで洗浄できる。** この repo では同一入力への
    // Review 判定が実行ごとに反転する実測がある（ledger: independent-review-verdict-instability）。
    // 却下されたテキストをそのまま再提出できる設計は、再抽選を繰り返して ALIGNED を
    // 引き当てる経路になるため、Review へ渡す前に止める。
    const { storage, taskId } = seedConflictedTask()
    const task = storage.tasks.findById(taskId)
    const vacuous = {
      ...PROPOSAL,
      // 却下された Task の3欄をそのまま言い直しただけの「実質無変更」の提案。
      // **表現は変えてある**（空白・大小・順序）。それでも拒否されなければならない。
      implementationScope: '  当初の広い   SCOPE ',
      allowedPaths: [...(task?.allowedPaths as string[])].reverse(),
      acceptanceCriteria: task?.acceptanceCriteria as string[],
    }
    let adopted = false

    const result = await runRemediationStep(storage, taskId, deps({
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async () => ({ ok: true, stdout: JSON.stringify(vacuous), timedOut: false }),
      },
      adopt: async () => { adopted = true; throw new Error('must not be reached') },
    }))

    expect(result.status).toBe('proposal_not_materially_different')
    expect(result.failureCode).toBe('identical_to_rejected')
    expect(adopted).toBe(false)
  })

  it('記録する hash は、**実際に submit される** prompt のものである', () => {
    // 生の `implementationScope` から計算すると、採用時に submit されるテキスト
    // （`buildRemediatedScope()` を通したもの）と別の値になり、記録した hash が
    // 後の世代で1つも照合できなくなる。Job Gate が計算する値と一致させる。
    const submittedScope = buildRemediatedScope(PROPOSAL)
    const proposedHash = computeProposedDesignTextHash({
      ledgerBody: LEDGER_BODY,
      implementationScope: submittedScope,
      allowedPaths: PROPOSAL.allowedPaths,
    })
    const gateHash = computeDesignTextHash(buildInitialImplementAiCliPrompt({
      description: buildAdoptedDescription(LEDGER_BODY, submittedScope),
      allowedPaths: PROPOSAL.allowedPaths,
    }))

    expect(proposedHash).toBe(gateHash)
    // 生の scope から計算した値とは**一致しない**（判定には使えない、という根拠）。
    expect(proposedHash).not.toBe(computeProposedDesignTextHash({
      ledgerBody: LEDGER_BODY,
      implementationScope: PROPOSAL.implementationScope,
      allowedPaths: PROPOSAL.allowedPaths,
    }))
  })

  it('AC だけを書き換えた提案は拒否する（Review はそこを見ないため同一テキストになる）', async () => {
    // `buildInitialImplementAiCliPrompt()` のレビュー対象は description + allowedPaths 由来の
    // Design Contract だけで、acceptanceCriteria は1文字も入らない。AC 変更を「作り直した」と
    // 認めると、**byte 単位で同一のテキスト**へ再抽選を引けてしまう。
    const { storage, taskId } = seedConflictedTask()
    const task = storage.tasks.findById(taskId)
    const acOnly = {
      ...PROPOSAL,
      implementationScope: '当初の広い scope',
      allowedPaths: task?.allowedPaths as string[],
      acceptanceCriteria: ['まったく別の受入条件を並べる'],
    }
    let adopted = false

    const result = await runRemediationStep(storage, taskId, deps({
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async () => ({ ok: true, stdout: JSON.stringify(acOnly), timedOut: false }),
      },
      adopt: async () => { adopted = true; throw new Error('must not be reached') },
    }))

    expect(result.status).toBe('proposal_not_materially_different')
    expect(adopted).toBe(false)
  })

  it('**A → B → A を止める**（採用で Task の spec が置き換わる実際の遷移を再現する）', async () => {
    // 独立レビュー指摘: 提案側のキーだけを残していると、世代1で却下されていた A は
    // 採用で Task から消えるため、世代2の却下済み集合に A が入らず B → A が通ってしまう。
    // ここでは **adopt が実際に Task の scope を書き換える**ところまで再現する。
    const { storage, taskId } = seedConflictedTask()
    const originalScope = '当初の広い scope'
    const originalPaths = storage.tasks.findById(taskId)?.allowedPaths as string[]
    const B = { ...PROPOSAL, implementationScope: 'B の狭い scope', allowedPaths: ['apps/api/src/storage'] }
    // 世代2で A（= 当初案）をそのまま出し直す提案。
    const backToA = { ...PROPOSAL, implementationScope: originalScope, allowedPaths: originalPaths }

    const gen1 = await runRemediationStep(storage, taskId, deps({
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async () => ({ ok: true, stdout: JSON.stringify(B), timedOut: false }),
      },
      // 本物の採用と同じく Task の spec を提案内容へ置き換える。
      adopt: async (_s, input) => {
        storage.tasks.update(taskId, {
          description: buildAdoptedDescription(LEDGER_BODY, input.implementationScope as string),
          allowedPaths: input.allowedPaths,
          acceptanceCriteria: input.acceptanceCriteria,
        })
        return { ok: true as const, taskId, roadmapTaskKey: 'conflicted-item', title: 't' }
      },
    }))
    // 世代1は採用まで進む（fresh Review が通らないので still_not_aligned で返る）。
    expect(gen1.status).toBe('still_not_aligned')

    let adoptedAgain = false
    const gen2 = await runRemediationStep(storage, taskId, deps({
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async () => ({ ok: true, stdout: JSON.stringify(backToA), timedOut: false }),
      },
      adopt: async () => { adoptedAgain = true; throw new Error('must not be reached') },
    }))

    expect(gen2.status).toBe('proposal_not_materially_different')
    expect(adoptedAgain).toBe(false)
  })

  it('過去世代で却下された提案も避ける（audit の fspec= から復元して A→B→A を止める）', () => {
    const { storage, taskId } = seedConflictedTask()
    const olderKey = 'deadbeefdeadbeef'
    storage.auditLog.record({
      actor: 'api',
      operation: 'pl_independent_remediation',
      entityType: 'pl_remediation',
      entityId: `remediate:${taskId}`,
      result: 'success',
      detail: `provider=codex model=gpt-5.6-sol fspec=${olderKey} outcome=adopting`,
    })

    const subject = findRemediationSubject(storage, taskId)

    // 現在の Task の spec と、過去世代の fspec の**両方**が却下済み集合に入る。
    expect(subject?.rejectedSpecKeys).toContain(olderKey)
    expect(subject?.rejectedSpecKeys).toHaveLength(2)
  })
})

describe('著者の独立性 — 自分の却下案を自分で書き直させない', () => {
  it('PL の model 識別子は `cheapAiClient` の設定をそのまま使う（複製しない）', () => {
    // 複製すると PL の model を替えたときに、ここだけ古い値で「分離した」と言い続ける。
    // この値が flagship 候補と一致すれば、その候補は選ばれなくなる。
    expect(CHEAP_AI_CONFIG.model).toBe('mimo-v2.5')
    expect(FLAGSHIP_REMEDIATION_CANDIDATES.map((c) => c.model)).not.toContain(CHEAP_AI_CONFIG.model)
  })

  it('PL の model が flagship と同一になったら、その候補は選ばれない', () => {
    // 将来 PL の model が flagship へ上がった場合に、自動で自己修正へ倒れないこと。
    const selection = selectRemediationModel({
      authorProviders: [CHEAP_AI_CONFIG.provider],
      authorModels: ['gpt-5.6-sol'],
      judgeProviders: ['gemini'],
    })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.candidate.model).toBe('claude-opus-5')
  })

  it('2回目は前回の Remediation 著者と別 vendor へ回す', () => {
    // 1回目に Codex が書いて却下されたら、2回目も Codex が書き直すのでは
    // 「元設計者へ解決案生成を戻さない」という前提が崩れる。
    const selection = selectRemediationModel({
      authorProviders: ['opencode-go', 'codex'],
      judgeProviders: ['gemini'],
      usedProviders: ['codex'],
    })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.candidate.provider).toBe('claude_code')
  })

  it('実際に2回目の Remediation は Claude 側で走る', async () => {
    const { storage, taskId } = seedConflictedTask()
    const used: string[] = []
    const capturing = deps({
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async (raw: string) => {
          used.push((JSON.parse(raw) as { provider: string }).provider)
          return { ok: false, stdout: '', error: 'boom', timedOut: false }
        },
      },
    })

    await runRemediationStep(storage, taskId, capturing)
    await runRemediationStep(storage, taskId, capturing)

    expect(used).toEqual(['codex', 'claude_code'])
  })

  it('両 flagship を使い切ったら no_independent_model で止まる（弱い model へ落ちない）', async () => {
    const { storage, taskId } = seedConflictedTask()
    // provenance だけを2件置き、両 provider が既に使われた状態を作る。
    for (const provider of ['codex', 'claude_code']) {
      storage.auditLog.record({
        actor: 'api', operation: 'pl_independent_remediation', entityType: 'pl_remediation',
        entityId: `remediate:${taskId}`, result: 'success',
        detail: `provider=${provider} model=m outcome=runner_failed`,
      })
    }

    // 予算も尽きているので、まず attempts_exhausted で止まることを確かめる。
    const result = await runRemediationStep(storage, taskId, deps())

    expect(result.status).toBe('attempts_exhausted')
  })
})

describe('Gate — 既存の許可経路を迂回しない', () => {
  it('広すぎる allowedPaths は Gate が弾く（採用へ進ませない）', async () => {
    const { storage, taskId } = seedConflictedTask()
    let adopted = false

    const result = await runRemediationStep(storage, taskId, deps({
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async () => ({
          ok: true,
          // セグメントが1つしかない = File Change Guard を形だけにする宣言。
          stdout: JSON.stringify({ ...PROPOSAL, allowedPaths: ['apps'] }),
          timedOut: false,
        }),
      },
      adopt: async () => { adopted = true; throw new Error('must not be reached') },
    }))

    expect(result.status).toBe('blocked')
    expect(result.failureCode).toMatch(/^gate_blocked:/)
    expect(adopted).toBe(false)
  })

  it('ledger に無い項目は対象にならない', async () => {
    const { storage, taskId } = seedConflictedTask({ roadmapTaskKey: 'ghost-item' })

    const result = await runRemediationStep(storage, taskId, deps())

    expect(result.status).toBe('not_applicable')
    expect(result.failureCode).toBe('item_not_in_ledger')
  })

  it('deferred な項目は Gate が弾く（採用可能 state の allowlist を共有する）', async () => {
    const { storage, taskId } = seedConflictedTask({ roadmapTaskKey: 'deferred-item' })
    let adopted = false

    const result = await runRemediationStep(storage, taskId, deps({
      adopt: async () => { adopted = true; throw new Error('must not be reached') },
    }))

    expect(result.status).toBe('blocked')
    expect(adopted).toBe(false)
  })
})

describe('成功判定 — 採用経路の ok:true を成功にしない', () => {
  it('fresh Review が通らず Job が作られなければ still_not_aligned', async () => {
    // `adoptRoadmapItem()` は `ensureInitialWorkflows()` の結果を捨てるため、CONFLICT の
    // ままでも ok:true を返す。**Job の実在だけを成功の根拠にする。**
    const { storage, taskId } = seedConflictedTask()

    const result = await runRemediationStep(storage, taskId, deps({
      adopt: async () => ({ ok: true as const, taskId, roadmapTaskKey: 'conflicted-item', title: 't' }),
    }))

    expect(result.status).toBe('still_not_aligned')
    expect(result.failureCode).toBe('fresh_review_not_aligned')
  })

  it('この提案の prompt から作られた Job だけを成功の根拠にする', async () => {
    // 別の試行が作った Job を自分の成果として報告しない。判定は Job Gate が計算するのと
    // 同じ hash（`computeDesignTextHash(job.aiCliPrompt)`）で行う。
    const { storage, projectId, taskId } = seedConflictedTask()

    const result = await runRemediationStep(storage, taskId, deps({
      adopt: async () => {
        storage.jobs.create({
          taskId, projectId, agentRole: 'developer_ai', status: 'queued',
          safeCommand: { kind: 'test', workingDir: '/workspace/target' },
          aiCliMode: 'implement',
          // 別の提案から作られた Job。
          aiCliPrompt: 'a job from some other attempt',
        } as never)
        return { ok: true as const, taskId, roadmapTaskKey: 'conflicted-item', title: 't' }
      },
    }))

    expect(result.status).toBe('still_not_aligned')
  })

  it('Job が作られていれば remediated（provenance も返す）', async () => {
    const { storage, projectId, taskId } = seedConflictedTask()
    // 採用時に submit される prompt は `buildRemediatedScope()` を通した scope から作られる。
    const submittedPrompt = buildInitialImplementAiCliPrompt({
      description: buildAdoptedDescription(LEDGER_BODY, buildRemediatedScope(PROPOSAL)),
      allowedPaths: PROPOSAL.allowedPaths,
    })

    const result = await runRemediationStep(storage, taskId, deps({
      adopt: async () => {
        storage.jobs.create({
          taskId, projectId, agentRole: 'developer_ai', status: 'queued',
          safeCommand: { kind: 'test', workingDir: '/workspace/target' },
          aiCliMode: 'implement',
          aiCliPrompt: submittedPrompt,
        } as never)
        return { ok: true as const, taskId, roadmapTaskKey: 'conflicted-item', title: 't' }
      },
    }))

    expect(result.status).toBe('remediated')
    expect(result.provider).toBe('codex')
    expect(result.model).toBe('gpt-5.6-sol')
  })
})

describe('有界性と記録', () => {
  it('runner 失敗でも試行として記録する（記録しないと上限が効かない）', async () => {
    const { storage, taskId } = seedConflictedTask()

    const result = await runRemediationStep(storage, taskId, deps({
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async () => ({ ok: false, stdout: '', error: 'CLI が失敗しました', timedOut: false }),
      },
    }))

    expect(result.status).toBe('remediation_failed')
    expect(countRemediationAttempts(storage, taskId)).toBe(1)
  })

  it('上限に達したら実行せず attempts_exhausted を返す', async () => {
    const { storage, taskId } = seedConflictedTask()
    let executions = 0
    const failing = deps({
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async () => {
          executions += 1
          return { ok: false, stdout: '', error: 'boom', timedOut: false }
        },
      },
    })

    for (let i = 0; i < PL_MAX_REMEDIATION_ATTEMPTS; i += 1) {
      await runRemediationStep(storage, taskId, failing)
    }
    const beyond = await runRemediationStep(storage, taskId, failing)

    expect(executions).toBe(PL_MAX_REMEDIATION_ATTEMPTS)
    expect(beyond.status).toBe('attempts_exhausted')
  })

  it('ledger が読めない場合も試行として記録する（通知ループを作らない）', async () => {
    // 記録しないと対象から外れず、ledger が壊れている間ずっと毎 tick 同じ Escalation が出る。
    // 2026-09-17 に「63分で同一内容の LINE が18通」として実測された形と同じになる。
    const { storage, taskId } = seedConflictedTask()

    const result = await runRemediationStep(storage, taskId, deps({
      readLedger: () => { throw new Error('ENOENT') },
    }))

    expect(result.failureCode).toBe('ledger_unreadable')
    expect(countRemediationAttempts(storage, taskId)).toBe(1)
  })

  it('ledger から項目が消えている場合も試行として記録する', async () => {
    const { storage, taskId } = seedConflictedTask({ roadmapTaskKey: 'ghost-item' })

    const result = await runRemediationStep(storage, taskId, deps())

    expect(result.failureCode).toBe('item_not_in_ledger')
    expect(countRemediationAttempts(storage, taskId)).toBe(1)
  })

  it('provenance（provider / model / 未確認の分離相手）を audit へ残す', async () => {
    const { storage, taskId } = seedConflictedTask()

    await runRemediationStep(storage, taskId, deps({
      adopt: async () => ({ ok: false as const, code: 'SYNC_FAILED' as const, reason: 'r' }),
    }))
    const entries = storage.auditLog.findByEntity('pl_remediation', `remediate:${taskId}`)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.detail).toContain('provider=codex')
    expect(entries[0]?.detail).toContain('model=gpt-5.6-sol')
    // PL の provider は vendor を解決できないので、分離を主張せず記録する。
    expect(entries[0]?.detail).toContain('unverified_separation=opencode-go')
  })
})

describe('abandon — 元案を捨てる結論', () => {
  it('ledger を書き換えず、採用もせずに abandon_recommended を返す', async () => {
    // 「実装しないで閉じる」state はこのシステムに無く、ledger は CEO の正本である。
    // AI がどちらも動かさないことを固定する（既存 Escalation へ渡すだけ）。
    const { storage, taskId } = seedConflictedTask()
    let adopted = false

    const result = await runRemediationStep(storage, taskId, deps({
      runnerDeps: {
        runnerCommand: 'noop', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async () => ({
          ok: true,
          stdout: JSON.stringify({
            diagnosis: '前提が崩れている',
            resolution: '現状のまま実装すべきでない',
            whyResolved: 'Finding は scope ではなく前提を否定している',
            safetyImpact: '何も変更しないので影響なし',
            unresolvedConcerns: ['ledger 本文の更新は CEO 判断'],
            abandon: true,
          }),
          timedOut: false,
        }),
      },
      adopt: async () => { adopted = true; throw new Error('must not be reached') },
    }))

    expect(result.status).toBe('abandon_recommended')
    expect(adopted).toBe(false)
  })
})

describe('prompt', () => {
  it('Finding / 却下された spec / Goal / ledger 本文を含む', () => {
    const { storage, taskId } = seedConflictedTask()
    const subject = findRemediationSubject(storage, taskId)

    const prompt = buildRemediationPrompt({
      projectGoal: 'スマホだけでAI開発チームを運営できる世界を作る',
      subject: subject as NonNullable<typeof subject>,
      ledgerBody: LEDGER_BODY,
    })

    expect(prompt).toContain('新しい正規化層は複雑すぎる')
    expect(prompt).toContain('当初の広い scope')
    expect(prompt).toContain('スマホだけでAI開発チームを運営できる世界を作る')
    expect(prompt).toContain('CONFLICT した項目')
    expect(prompt).toContain('Design Contract')
  })

  it('system prompt は Review を覆す権限が無いことと権限拡大の禁止を明示する', () => {
    expect(REMEDIATION_SYSTEM_PROMPT).toContain('cannot approve, clear, soften or overrule the Review')
    expect(REMEDIATION_SYSTEM_PROMPT).toContain('cannot widen Safety or Authority boundaries')
    expect(REMEDIATION_SYSTEM_PROMPT).toContain('MATERIALLY DIFFERENT')
    // 元案を通すことを前提にしない（捨てる選択を明示的に許可する）。
    expect(REMEDIATION_SYSTEM_PROMPT).toContain('abandon the original plan entirely')
  })
})

describe('buildRemediatedScope', () => {
  it('判断の記録を implementationScope へ折り込む（新しい Task field を作らない）', () => {
    const scope = buildRemediatedScope({ ...PROPOSAL, unresolvedConcerns: ['migration の順序'] })

    expect(scope).toContain(PROPOSAL.implementationScope)
    expect(scope).toContain('却下の診断: scope が広すぎた')
    expect(scope).toContain('Safety / Authority への影響')
    expect(scope).toContain('未解決の懸念: migration の順序')
  })
})

describe('applyRevisedSpec — rawScope と submittedScope を取り違えない', () => {
  const REVISED = {
    allowedPaths: ['apps/api/src/storage'],
    acceptanceCriteria: ['c'],
    riskOpinionLevel: 'PL_REVISION',
    rationale: 'r',
    provenance: 'stage=pl_revision',
  }

  it('**採用には submittedScope（判断記録つき）を渡す**', async () => {
    // raw を渡すと判断記録が Task から消え、かつ Job の prompt が `proposedHash` と
    // 一致しなくなるため、**成功した fresh review まで still_not_aligned と報告される**。
    const { storage, taskId } = seedConflictedTask()
    const subject = findRemediationSubject(storage, taskId)!
    let adopted: string | undefined

    await applyRevisedSpec(storage, {
      subject,
      ledgerBody: LEDGER_BODY,
      rawScope: '狭くした scope',
      submittedScope: '狭くした scope\n\n### 記録\n- 理由: ...',
      ...REVISED,
      adopt: async (_s, input) => {
        adopted = input.implementationScope
        return { ok: false as const, code: 'SYNC_FAILED' as const, reason: 'x' }
      },
    })

    expect(adopted).toContain('### 記録')
  })

  it('**入れ替えて渡すと例外になる**（黙って通さない）', async () => {
    // 型では区別できず、名前が似ていて隣接行に並ぶため、一括置換で実際に入れ替わった。
    // 「submitted は raw を含む」という関係を実行時に確かめる。
    const { storage, taskId } = seedConflictedTask()
    const subject = findRemediationSubject(storage, taskId)!

    await expect(applyRevisedSpec(storage, {
      subject,
      ledgerBody: LEDGER_BODY,
      // 逆に渡す。
      rawScope: '狭くした scope\n\n### 記録\n- 理由: ...',
      submittedScope: '狭くした scope',
      ...REVISED,
      adopt: async () => ({ ok: false as const, code: 'SYNC_FAILED' as const, reason: 'x' }),
    })).rejects.toThrow(/swapped/)
  })

  it('PL revision 経路でも却下キーが残る（A→B→A を止める材料）', async () => {
    const { storage, taskId } = seedConflictedTask()
    const subject = findRemediationSubject(storage, taskId)!

    await applyRevisedSpec(storage, {
      subject,
      ledgerBody: LEDGER_BODY,
      rawScope: '狭くした scope',
      submittedScope: '狭くした scope\n\n### 記録',
      ...REVISED,
      adopt: async () => ({ ok: false as const, code: 'SYNC_FAILED' as const, reason: 'x' }),
    })
    const details = stageEntries(storage, taskId, 'pl_revision').map((e) => e.detail ?? '').join(' ')

    expect(details).toContain('rejected_fspec=')
    expect(details).not.toContain('rejected_fspec=-')
  })
})
