import { describe, expect, it, beforeEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { buildSystemState } from '../state/systemState'
import {
  PL_MAX_ATTEMPTS_PER_TARGET,
  countPriorAttempts,
  extractProposedKind,
  isRecoveryTargetResolved,
  resetPlLoopInFlightForTest,
  DIAGNOSIS_SYSTEM_FOR_TEST,
  runPlTick,
  verifyOutcome,
  type PlDiagnosisInput,
  type PlLoopDeps,
} from './executionLoop'
import { PL_MAX_ADOPTION_ATTEMPTS } from './adoptionStep'

/**
 * ここで固定しているのは「PL が自分の権限で動かない」ことと「操作したら必ず確かめる」ことである。
 * 診断そのものの賢さは対象外（provider 依存であり、ここでは常に注入する）。
 */

const NOW = '2026-09-14T10:00:00.000Z'

function seed(): { storage: IStorage; projectId: string; taskId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS',
    goal: 'g',
    designPhilosophy: [],
    status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: true,
    phase: 1,
  } as Parameters<IStorage['tasks']['create']>[0])
  return { storage, projectId: project.id, taskId: task.id }
}

/** production evidence と同じ形: queued のまま誰も実行していない Design Review run。 */
function seedIdleDesignReview(): { storage: IStorage; taskId: string; runId: string } {
  const { storage, taskId } = seed()
  const run = storage.designReviewRuns.create({
    taskId,
    taskTitle: 'design',
    designText: 'design text',
    designTextHash: 'hash-1',
    changedFiles: ['docs/notes.md'],
  })
  return { storage, taskId, runId: run.id }
}

function deps(over: Partial<PlLoopDeps> = {}): PlLoopDeps {
  return {
    now: () => NOW,
    diagnose: async () => JSON.stringify({ actionKind: 'rekick_design_review', rationale: 'queued run is idle', riskLevel: 'LOW' }),
    rekickDesignReview: async () => ({ status: 'evidence_registered' }),
    escalate: async () => {},
    // 既定では採用候補を空にする。採用経路を検証するテストだけが ledger を渡す。
    readLedger: () => '',
    ...over,
  }
}

beforeEach(() => {
  resetPlLoopInFlightForTest()
})

describe('runPlTick — Observe', () => {
  it('attention が無ければ何もしない', async () => {
    const { storage } = seed()
    // pending Task を消して attention を空にする
    for (const task of storage.tasks.findByProjectId(storage.projects.findAll()[0]!.id)) {
      storage.tasks.update(task.id, { status: 'done', roadmapActive: false })
    }

    const result = await runPlTick(storage, deps())

    expect(result.status).toBe('idle')
  })

  it('executor が無い attention だけのときは、勝手に通知せず idle で止まる', async () => {
    // task_ready_without_job は v1 の executor が無い。既に GET /api/state に出ており、
    // PL が二重に通知すると通知が信用されなくなる。
    const { storage } = seed()
    let escalated = 0

    const result = await runPlTick(storage, deps({ escalate: async () => { escalated += 1 } }))

    expect(result.status).toBe('idle')
    expect(escalated).toBe(0)
  })
})

describe('runPlTick — 停止した failed Job', () => {
  it('停止した failed Job を PL が拾い、Gate に止められた上で最終的に Escalation する', async () => {
    // executor が無いので「実行できない」が、**黙って無視せず人へ伝える**ことを固定する。
    const { storage } = seed()
    const task = storage.tasks.findByProjectId(storage.projects.findAll()[0]!.id)[0]!
    storage.jobs.create({
      taskId: task.id,
      projectId: task.projectId,
      agentRole: 'developer_ai',
      status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })
    const escalations: string[] = []
    const d = deps({
      diagnose: async () => JSON.stringify({ actionKind: 'resume_task', rationale: '再開したい', riskLevel: 'LOW' }),
      escalate: async (p) => { escalations.push(p.title) },
    })

    // 1〜2回目: Gate が根拠不足で止める（workspace を書き換える操作なので当然）
    for (let i = 0; i < PL_MAX_ATTEMPTS_PER_TARGET; i += 1) {
      resetPlLoopInFlightForTest()
      const r = await runPlTick(storage, d)
      expect(r.status, `attempt ${i + 1}`).toBe('blocked')
      expect(r.target?.kind).toBe('job_failed')
    }

    // 3回目: 試行上限に達したので CEO へ上げる
    resetPlLoopInFlightForTest()
    const escalated = await runPlTick(storage, d)

    expect(escalated.status).toBe('escalated')
    expect(escalations.length).toBe(1)
  })
})

describe('runPlTick — Decide / Gate', () => {
  it('PL が未知の action を出しても実行せず blocked になる（自然言語を信用しない）', async () => {
    const { storage } = seedIdleDesignReview()
    let rekicked = 0

    const result = await runPlTick(
      storage,
      deps({
        diagnose: async () => JSON.stringify({ actionKind: 'restart_everything', rationale: 'x', riskLevel: 'LOW' }),
        rekickDesignReview: async () => { rekicked += 1; return { status: 'evidence_registered' } },
      }),
    )

    expect(result.status).toBe('blocked')
    expect(result.proposedKind).toBe('restart_everything')
    expect(rekicked).toBe(0)
  })

  it('PL が Gate 必須の操作を出しても、根拠が無ければ実行しない', async () => {
    const { storage } = seedIdleDesignReview()

    const result = await runPlTick(
      storage,
      deps({
        diagnose: async () => JSON.stringify({ actionKind: 'resume_task', rationale: 'x', riskLevel: 'LOW' }),
      }),
    )

    expect(result.status).toBe('blocked')
    // design_review / approval_gate の根拠レコードが無いので通らない
    expect(result.reason).toContain('resume_task')
  })

  it('PL が LOW と自己申告しても Gate 判定は変わらない', async () => {
    const { storage } = seedIdleDesignReview()

    const result = await runPlTick(
      storage,
      deps({
        diagnose: async () => JSON.stringify({
          actionKind: 'deploy_production',
          rationale: 'PL は安全だと考えた',
          riskLevel: 'LOW',
        }),
      }),
    )

    expect(result.status).toBe('blocked')
  })

  it('構造化された actionKind が取れなければ実行しない', async () => {
    const { storage } = seedIdleDesignReview()
    let rekicked = 0

    const result = await runPlTick(
      storage,
      deps({
        diagnose: async () => 'I think we should just re-run the review.',
        rekickDesignReview: async () => { rekicked += 1; return { status: 'evidence_registered' } },
      }),
    )

    expect(result.status).toBe('diagnosis_unusable')
    expect(rekicked).toBe(0)
  })
})

describe('runPlTick — Execute / Verify', () => {
  it('idle な Design Review を既存経路で再kickし、状態を読み直して確かめる', async () => {
    const { storage, taskId, runId } = seedIdleDesignReview()
    const rekicked: string[] = []

    const result = await runPlTick(
      storage,
      deps({
        rekickDesignReview: async (s, id) => {
          rekicked.push(id)
          // 実際の再kickと同じく run を終端させる（ここでは成功扱い）
          const claim = s.designReviewRuns.claim(id, 3)
          if (claim.claimToken) {
            s.designReviewRuns.complete(id, claim.claimToken, 'succeeded', '{}', undefined)
          }
          return { status: 'evidence_registered' }
        },
      }),
    )

    expect(rekicked).toEqual([runId])
    expect(result.status).toBe('acted')
    expect(result.proposedKind).toBe('rekick_design_review')
    expect(result.target?.taskId).toBe(taskId)

    // **実行側の戻り値ではなく、状態を読み直した結果で判定している。**
    // review は解消したが、この Task にはまだ Job が無い（= 次に見るべき別の状態）。
    // 「操作が成功した」と「系が正常化した」を同じにしないことがここの要点である。
    expect(result.verification).toBe('different_anomaly')
    const after = buildSystemState(storage, { now: () => NOW })
    expect(after.attention.some((a) => a.kind === 'design_review_idle')).toBe(false)
    expect(after.attention.some((a) => a.kind === 'task_ready_without_job')).toBe(true)
  })

  it('操作しても状態が変わらなければ normalized にしない', async () => {
    const { storage } = seedIdleDesignReview()

    const result = await runPlTick(
      storage,
      // 「成功した」と言うだけで何もしない実行
      deps({ rekickDesignReview: async () => ({ status: 'evidence_registered' }) }),
    )

    expect(result.status).toBe('acted')
    expect(result.verification).toBe('unchanged')
  })

  it('再kickの対象は attention が指す Task の Review だけで、他 Task の Review へ広がらない', async () => {
    // CEO 判断（2026-09-14）の不変条件 7:「同一 Review の再実行以外へ権限を広げない」。
    const { storage, taskId, runId } = seedIdleDesignReview()
    // 同一 Project 内の別 Task（`ux_projects_single_running` があるので Project は増やさない）。
    const otherTask = storage.tasks.create({
      projectId: storage.tasks.findById(taskId)!.projectId,
      title: 'other',
      description: '',
      status: 'pending',
      assignee: 'developer_ai',
      dependencies: [],
      roadmapActive: true,
      phase: 1,
    } as Parameters<IStorage['tasks']['create']>[0])
    const otherRun = storage.designReviewRuns.create({
      taskId: otherTask.id,
      taskTitle: 'other design',
      designText: 'other',
      designTextHash: 'hash-2',
      changedFiles: ['docs/other.md'],
    })
    const touched: string[] = []

    await runPlTick(
      storage,
      deps({ rekickDesignReview: async (_s, id) => { touched.push(id); return { status: 'evidence_registered' } } }),
    )

    expect(touched).toEqual([runId])
    expect(touched).not.toContain(otherRun.id)
    // 他 Task の run は queued のまま、attempt も増えていない
    expect(storage.designReviewRuns.findById(otherRun.id)?.status).toBe('queued')
    expect(storage.designReviewRuns.findById(otherRun.id)?.attemptCount).toBe(0)
    expect(taskId).not.toBe(otherTask.id)
  })

  it('attempt を使い切った run は盲目的に再kickせず、実行しない', async () => {
    const { storage, runId } = seedIdleDesignReview()
    // 3 attempt すべて消費した状態にする
    for (let i = 0; i < 3; i += 1) {
      const claim = storage.designReviewRuns.claim(runId, 3)
      if (claim.claimToken) storage.designReviewRuns.requeue(runId, claim.claimToken, 'timeout')
    }
    let rekicked = 0

    const result = await runPlTick(
      storage,
      deps({ rekickDesignReview: async () => { rekicked += 1; return { status: 'evidence_registered' } } }),
    )

    expect(rekicked).toBe(0)
    expect(result.executionSummary).toContain('attempts')
  })
})

describe('runPlTick — 無限ループを作らない', () => {
  it('同じ対象への試行が上限に達したら、再試行ではなく Escalation へ倒す', async () => {
    const { storage } = seedIdleDesignReview()
    const escalations: string[] = []
    const d = deps({
      rekickDesignReview: async () => ({ status: 'evidence_registered' }),
      escalate: async (payload) => { escalations.push(payload.title) },
    })

    for (let i = 0; i < PL_MAX_ATTEMPTS_PER_TARGET; i += 1) {
      resetPlLoopInFlightForTest()
      await runPlTick(storage, d)
    }

    resetPlLoopInFlightForTest()
    const afterBudget = await runPlTick(storage, d)

    // 上限到達時点（= 最後の tick）で 1 回、それ以降は繰り返さない
    expect(escalations.length).toBe(1)
    expect(afterBudget.status).toBe('idle')
    expect(afterBudget.reason).toContain('already escalated')
  })

  it('Escalation 済みの対象には Diagnose を走らせない（provider を焼き続けない）', async () => {
    // production 初回 tick（2026-09-14）で判明した実挙動への回帰テスト。
    // escalation は attempt として数えないため、選択段階で外さないと CEO の判断待ちの間ずっと
    // tick ごとに provider CLI（実測 25 秒）を呼び続けることになる。
    const { storage } = seedIdleDesignReview()
    let diagnoseCalls = 0
    const d = deps({
      diagnose: async () => {
        diagnoseCalls += 1
        return JSON.stringify({ actionKind: 'escalate_to_ceo', rationale: 'needs CEO', riskLevel: 'HIGH' })
      },
    })

    const first = await runPlTick(storage, d)
    expect(first.status).toBe('escalated')
    expect(diagnoseCalls).toBe(1)

    resetPlLoopInFlightForTest()
    const second = await runPlTick(storage, d)

    expect(second.status).toBe('idle')
    expect(second.reason).toContain('already escalated')
    // 2回目は診断すら呼ばない
    expect(diagnoseCalls).toBe(1)
  })

  it('試行回数は audit_log から数える（新しいテーブルを持たない）', async () => {
    const { storage } = seedIdleDesignReview()
    await runPlTick(storage, deps())

    const keys = storage.auditLog
      .findAll()
      .filter((entry) => entry.operation === 'pl_loop')
      .map((entry) => entry.entityId)

    expect(keys.length).toBeGreaterThan(0)
    expect(countPriorAttempts(storage, keys[0]!)).toBe(1)
  })
})

describe('extractProposedKind / verifyOutcome', () => {
  it('JSON が無い出力からは action を取り出さない', () => {
    expect(extractProposedKind('no json here').kind).toBeUndefined()
    expect(extractProposedKind('```json\n{"actionKind":"retry_job"}\n```').kind).toBe('retry_job')
  })

  it('同じ対象に別の異常が出た場合は normalized と区別する', () => {
    const before = {
      kind: 'design_review_idle' as const,
      projectId: 'p1',
      projectName: 'P',
      taskId: 't1',
      detail: 'idle',
    }
    const after = {
      generatedAt: NOW,
      totals: {
        projects: {}, jobs: {}, quarantinedJobs: 0, approvalsWaiting: 0,
        continuationsPending: 0, activeDesignReviews: 0, activeSupervisedRuns: 0,
      },
      projects: [],
      attention: [
        { kind: 'job_blocked' as const, projectId: 'p1', projectName: 'P', taskId: 't1', detail: 'blocked' },
      ],
    }

    expect(verifyOutcome(before, after)).toBe('different_anomaly')
    expect(verifyOutcome(before, { ...after, attention: [] })).toBe('normalized')
    expect(
      verifyOutcome(before, {
        ...after,
        attention: [{ kind: 'approval_waiting' as const, projectId: 'p1', projectName: 'P', taskId: 't1', detail: 'w' }],
      }),
    ).toBe('needs_gate_or_ceo')
  })
})

describe('Recovery 成功の判定（対象が解消したか）', () => {
  it('対象が消えていれば、後続状態が出ていても Recovery 成功として扱う', () => {
    expect(isRecoveryTargetResolved('normalized')).toBe(true)
    expect(isRecoveryTargetResolved('different_anomaly')).toBe(true)
  })

  it('対象が残っている / 人の判断が要る場合は成功扱いにしない', () => {
    expect(isRecoveryTargetResolved('unchanged')).toBe(false)
    expect(isRecoveryTargetResolved('needs_gate_or_ceo')).toBe(false)
  })

  it('復旧が成功して後続状態が現れただけなら、試行上限でも Escalation しない', async () => {
    // production 実測（2026-09-14）と同じ形: 停止した Design Review を再kickして evidence 登録まで
    // 到達したが、同じ Task に task_ready_without_job が現れて verdict が different_anomaly になった。
    // これを Escalation すると、**成功するたびに CEO を呼ぶ**ことになる。
    const { storage } = seedIdleDesignReview()
    const escalations: string[] = []
    const d = deps({
      rekickDesignReview: async (s, id) => {
        const claim = s.designReviewRuns.claim(id, 3)
        if (claim.claimToken) s.designReviewRuns.complete(id, claim.claimToken, 'succeeded', '{}', undefined)
        return { status: 'evidence_registered' }
      },
      escalate: async (p) => { escalations.push(p.title) },
    })

    const result = await runPlTick(storage, d)

    // 対象（design_review_idle）は消え、同じ Task に task_ready_without_job が出ている
    expect(result.verification).toBe('different_anomaly')
    expect(result.status).toBe('acted')
    expect(escalations).toEqual([])
  })

  it('対象が残ったままなら従来どおり試行上限で Escalation する', async () => {
    const { storage } = seedIdleDesignReview()
    const escalations: string[] = []
    const d = deps({
      // 「成功した」と言うだけで何もしない実行 → 対象は消えない
      rekickDesignReview: async () => ({ status: 'evidence_registered' }),
      escalate: async (p) => { escalations.push(p.title) },
    })

    for (let i = 0; i < PL_MAX_ATTEMPTS_PER_TARGET; i += 1) {
      resetPlLoopInFlightForTest()
      await runPlTick(storage, d)
    }

    expect(escalations.length).toBe(1)
  })
})

describe('runPlTick — 手が空いたら次の Roadmap 項目を採用する', () => {
  // Gate は呼び出し側から ledger を受け取らない（偽造防止）ので、実ファイルを置いて TARGET_ROOT を向ける。
  let ledgerRoot: string
  let previousTargetRoot: string | undefined

  beforeAll(() => {
    ledgerRoot = mkdtempSync(join(tmpdir(), 'pl-loop-adopt-'))
    mkdirSync(join(ledgerRoot, 'tasks'), { recursive: true })
    writeFileSync(
      join(ledgerRoot, 'tasks', 'roadmap.md'),
      ['# Roadmap', '', '<!-- roadmap:id=next-item state=planned -->', '1. [ ] **次にやる項目** — 採用できる'].join('\n'),
      'utf-8',
    )
    previousTargetRoot = process.env.TARGET_ROOT
    process.env.TARGET_ROOT = ledgerRoot
  })

  afterAll(() => {
    if (previousTargetRoot === undefined) delete process.env.TARGET_ROOT
    else process.env.TARGET_ROOT = previousTargetRoot
    rmSync(ledgerRoot, { recursive: true, force: true })
  })

  const LEDGER = [
    '# Roadmap',
    '',
    '<!-- roadmap:id=next-item state=planned -->',
    '1. [ ] **次にやる項目** — 採用できる',
  ].join('\n')

  const PROPOSAL = JSON.stringify({
    roadmapId: 'next-item',
    implementationScope: 'この範囲だけ',
    allowedPaths: ['apps/api/src/ctoAi'],
    acceptanceCriteria: ['test が通る'],
    rationale: '小さく安全',
  })

  function idleProject(): IStorage {
    const storage = createSQLiteStorage(':memory:')
    storage.projects.create({ name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' })
    return storage
  }

  it('attention が無く手が空いていれば採用を試み、結果を audit に残す', async () => {
    const storage = idleProject()
    const adopted: string[] = []

    const result = await runPlTick(storage, deps({
      readLedger: () => LEDGER,
      proposeAdoption: async () => PROPOSAL,
      adopt: async (_s, input) => {
        adopted.push(input.roadmapId)
        return { ok: true as const, taskId: 'task-1', roadmapTaskKey: input.roadmapId, title: 't' }
      },
    }))

    expect(adopted).toEqual(['next-item'])
    expect(result.status).toBe('acted')
    expect(result.proposedKind).toBe('adopt_roadmap_item')
    expect(storage.auditLog.findAll().some((e) => e.entityId === `adopt:${storage.projects.findAll()[0]!.id}`)).toBe(true)
  })

  it('attention が1件でもあるうちは採用しない（止まっているものを放置して仕事を増やさない）', async () => {
    const { storage } = seedIdleDesignReview()
    let adoptCalls = 0

    await runPlTick(storage, deps({
      readLedger: () => LEDGER,
      proposeAdoption: async () => PROPOSAL,
      adopt: async () => { adoptCalls += 1; return { ok: true as const, taskId: 'x', roadmapTaskKey: 'y', title: 't' } },
    }))

    expect(adoptCalls).toBe(0)
  })

  it('Escalation 後も、原因が直れば採用を再開できる（永久に止まらない）', async () => {
    // 2026-09-15 production 実測: Candidate の ledger が master に遅れていたため PL が完了済み
    // 項目を選び、ALREADY_EXECUTED 却下を2回出して Escalation。**ledger を直した後も再開しなかった。**
    // 成功だけを予算の区切りにすると「成功するには採用が要り、採用するには予算が要る」循環になる。
    const storage = idleProject()
    const adopted: string[] = []
    const escalations: string[] = []
    let broken = true
    const d = deps({
      readLedger: () => LEDGER,
      proposeAdoption: async () => (broken ? 'これは JSON ではない' : PROPOSAL),
      adopt: async (_s, input) => {
        adopted.push(input.roadmapId)
        return { ok: true as const, taskId: `task-${adopted.length}`, roadmapTaskKey: input.roadmapId, title: 't' }
      },
      escalate: async (p) => { escalations.push(p.title) },
    })

    // 予算を使い切って Escalation させる
    for (let i = 0; i < PL_MAX_ADOPTION_ATTEMPTS; i += 1) {
      resetPlLoopInFlightForTest()
      expect((await runPlTick(storage, d)).status, `attempt ${i + 1}`).toBe('blocked')
    }
    resetPlLoopInFlightForTest()
    expect((await runPlTick(storage, d)).status).toBe('escalated')
    expect(escalations).toHaveLength(1)

    // 原因が直った（= 提案が壊れなくなった）
    broken = false
    resetPlLoopInFlightForTest()
    const resumed = await runPlTick(storage, d)

    expect(resumed.status).toBe('acted')
    expect(adopted).toEqual(['next-item'])
    // 通知は窓ごとに1回のまま（鳴り続けない）
    expect(escalations).toHaveLength(1)
  })

  // 2026-09-17 production 実測: park 後に採用が失敗し続け、**63分で同一内容の LINE が18通**
  // 送られた。retry window は escalation を境界にして切り替わるのに、重複判定が
  // 「窓の中に escalation があるか」だったため、判定が原理的に成立していなかった。
  describe('CEO 通知の重複（retry window とは別の概念）', () => {
    /** 予算を使い切って1回 escalate させる。1周分。 */
    async function runOneEscalationCycle(storage: IStorage, d: PlLoopDeps): Promise<void> {
      for (let i = 0; i < PL_MAX_ADOPTION_ATTEMPTS; i += 1) {
        resetPlLoopInFlightForTest()
        await runPlTick(storage, d)
      }
      resetPlLoopInFlightForTest()
      const escalated = await runPlTick(storage, d)
      expect(escalated.status).toBe('escalated')
    }

    function brokenAdoption(escalations: string[], over: Partial<PlLoopDeps> = {}): PlLoopDeps {
      return deps({
        readLedger: () => LEDGER,
        proposeAdoption: async () => 'これは JSON ではない',
        escalate: async (p) => { escalations.push(p.title) },
        ...over,
      })
    }

    it('同じ target・同じ失敗なら、窓が何周しても通知は最初の1回だけ', async () => {
      const storage = idleProject()
      const escalations: string[] = []
      const d = brokenAdoption(escalations)

      for (let cycle = 0; cycle < 4; cycle += 1) await runOneEscalationCycle(storage, d)

      expect(escalations).toHaveLength(1)
    })

    it('通知を止めても再試行は続く（窓は従来どおり escalation で切り替わる）', async () => {
      const storage = idleProject()
      const escalations: string[] = []
      const d = brokenAdoption(escalations)

      await runOneEscalationCycle(storage, d)
      await runOneEscalationCycle(storage, d)

      // 2周目も **実際に採用を試みている**（黙っただけで止まっていない）。
      const projectId = storage.projects.findAll()[0]!.id
      const attempts = storage.auditLog
        .findByEntity('pl_loop_target', `adopt:${projectId}`)
        .filter((entry) => entry.result === 'blocked')
      expect(attempts.length).toBe(PL_MAX_ADOPTION_ATTEMPTS * 2)
    })

    it('通知を止めても障害は audit / state から見える（隠さない）', async () => {
      const storage = idleProject()
      const escalations: string[] = []
      const d = brokenAdoption(escalations)

      await runOneEscalationCycle(storage, d)
      await runOneEscalationCycle(storage, d)

      const projectId = storage.projects.findAll()[0]!.id
      const entries = storage.auditLog.findByEntity('pl_loop_target', `adopt:${projectId}`)
      // **escalation の記録は毎回残る。** 通知を送らなかっただけ。
      expect(entries.filter((entry) => entry.result === 'escalated')).toHaveLength(2)
      expect(escalations).toHaveLength(1)
    })

    it('一度採用に成功したあと再発したら、新しい incident として通知する', async () => {
      const storage = idleProject()
      const escalations: string[] = []
      let broken = true
      const d = deps({
        readLedger: () => LEDGER,
        proposeAdoption: async () => (broken ? 'これは JSON ではない' : PROPOSAL),
        adopt: async (_s, input) => ({
          ok: true as const, taskId: 'task-1', roadmapTaskKey: input.roadmapId, title: 't',
        }),
        escalate: async (p) => { escalations.push(p.title) },
      })

      await runOneEscalationCycle(storage, d)
      expect(escalations).toHaveLength(1)

      // 採用が成功する
      broken = false
      resetPlLoopInFlightForTest()
      expect((await runPlTick(storage, d)).status).toBe('acted')

      // また同じ失敗が起きる —— これは前回と地続きではなく、新しい incident。
      broken = true
      await runOneEscalationCycle(storage, d)

      expect(escalations).toHaveLength(2)
    })

    it('failure class が変われば通知する', async () => {
      const storage = idleProject()
      const escalations: string[] = []
      let mode: 'unparsable' | 'throws' = 'unparsable'
      const d = deps({
        readLedger: () => LEDGER,
        proposeAdoption: async () => {
          if (mode === 'throws') throw new Error('provider timed out')
          return 'これは JSON ではない'
        },
        escalate: async (p) => { escalations.push(p.title) },
      })

      await runOneEscalationCycle(storage, d)
      expect(escalations).toHaveLength(1)

      // 原因の種類が変わった（提案が壊れている → provider が落ちている）。
      mode = 'throws'
      await runOneEscalationCycle(storage, d)

      expect(escalations).toHaveLength(2)
    })

    // 同じ status でも原因が違えば別の障害である。ここを status だけで判定すると、
    // 「提案を組み立てられない」で1通出したあと「提示していない id を選んだ」が
    // **既報として黙殺される**（独立レビュー指摘。成功が一度も無い Project で顕著）。
    it('同じ status でも下位分類が違えば通知する', async () => {
      const storage = idleProject()
      const escalations: string[] = []
      let mode: 'unparsable' | 'unoffered' = 'unparsable'
      const d = deps({
        readLedger: () => LEDGER,
        proposeAdoption: async () => (mode === 'unparsable'
          ? 'これは JSON ではない'
          : JSON.stringify({
            roadmapId: 'not-offered-at-all',
            implementationScope: 'x',
            allowedPaths: ['apps/api/src/ctoAi'],
            acceptanceCriteria: ['y'],
          })),
        escalate: async (p) => { escalations.push(p.title) },
      })

      await runOneEscalationCycle(storage, d)
      expect(escalations).toHaveLength(1)

      // どちらも status は proposal_unusable だが、原因は別物。
      mode = 'unoffered'
      await runOneEscalationCycle(storage, d)

      expect(escalations).toHaveLength(2)
    })

    // audit の並びは created_at DESC, rowid DESC。同一ミリ秒の行は時刻比較では順序づかないので、
    // 「前回の成功より後に通知したか」を時刻で判定してはいけない。
    it('同一ミリ秒に記録が並んでも重複通知しない', async () => {
      const storage = idleProject()
      const escalations: string[] = []
      const fixedNow = '2026-09-18T00:00:00.000Z'
      const d = brokenAdoption(escalations, { now: () => fixedNow })

      for (let cycle = 0; cycle < 3; cycle += 1) await runOneEscalationCycle(storage, d)

      expect(escalations).toHaveLength(1)
    })

    it('別 Project なら独立して通知される', async () => {
      const a = idleProject()
      const b = idleProject()
      const escalations: string[] = []
      const d = brokenAdoption(escalations)

      await runOneEscalationCycle(a, d)
      await runOneEscalationCycle(b, d)

      expect(escalations).toHaveLength(2)
    })

    it('CEO への件名に、実在しない attention kind を出さない', async () => {
      const storage = idleProject()
      const escalations: string[] = []

      await runOneEscalationCycle(storage, brokenAdoption(escalations))

      // `task_ready_without_job` は escalateTo を再利用するための内部都合であって、
      // 実際にそういう Task があるわけではない（production 実測で0件）。
      expect(escalations[0]).not.toContain('task_ready_without_job')
      expect(escalations[0]).toContain('Roadmap adoption failure')
    })

    // 通知を止めても「いま失敗が続いている」ことは state から見えなければならない。
    // 見えないと、running なのに currentTask も attention も無い**静かな Project**に見える。
    it('通知を止めても、失敗が続いていることが PL state から見える', async () => {
      const storage = idleProject()
      const escalations: string[] = []
      const d = brokenAdoption(escalations)

      await runOneEscalationCycle(storage, d)
      await runOneEscalationCycle(storage, d)
      expect(escalations).toHaveLength(1)

      const projectId = storage.projects.findAll()[0]!.id
      const state = buildSystemState(storage)
      const project = state.projects.find((candidate) => candidate.id === projectId)

      expect(project?.adoptionFailure?.escalations).toBe(2)
      expect(project?.adoptionFailure?.failureClass).toContain('proposal_unusable')
      expect(project?.adoptionFailure?.since).toBeDefined()
      expect(project?.adoptionFailure?.lastAt).toBeDefined()

      // **attention には出さない。** 出すと maybeAdoptNext() が採用を見送るため、
      // 通知を直すために採用機能そのものを止めることになる。
      expect(state.attention).toHaveLength(0)
    })

    it('採用に成功したら state の表示も消える', async () => {
      const storage = idleProject()
      const escalations: string[] = []
      let broken = true
      const d = deps({
        readLedger: () => LEDGER,
        proposeAdoption: async () => (broken ? 'これは JSON ではない' : PROPOSAL),
        adopt: async (_s, input) => ({
          ok: true as const, taskId: 'task-1', roadmapTaskKey: input.roadmapId, title: 't',
        }),
        escalate: async (p) => { escalations.push(p.title) },
      })

      await runOneEscalationCycle(storage, d)
      const projectId = storage.projects.findAll()[0]!.id
      expect(buildSystemState(storage).projects.find((p) => p.id === projectId)?.adoptionFailure)
        .toBeDefined()

      broken = false
      resetPlLoopInFlightForTest()
      expect((await runPlTick(storage, d)).status).toBe('acted')

      expect(buildSystemState(storage).projects.find((p) => p.id === projectId)?.adoptionFailure)
        .toBeUndefined()
    })

    it('診断の記録は採用サイクルの予算と候補の回転位置を動かさない', async () => {
      const storage = idleProject()
      const escalations: string[] = []
      await runOneEscalationCycle(storage, brokenAdoption(escalations))

      const projectId = storage.projects.findAll()[0]!.id
      // 通知の記録は別 entity に置く。ここへ混ぜると rotationOffset が行数を読むため、
      // 「記録しただけで PL に提示される候補が変わる」ことになる。
      const cycleRows = storage.auditLog.findByEntity('pl_loop_target', `adopt:${projectId}`)
      expect(cycleRows.every((entry) => entry.operation === 'pl_loop')).toBe(true)
    })
  })

  it('採用に成功したら予算は仕切り直す（2件目で打ち止めにならない）', async () => {
    // 2026-09-15 production 実測: 1件目の採用に2回（proposal_unusable → adopted）使った結果、
    // 次のサイクルは 1 tick 目で「PL は 2 回試しましたが採用できませんでした」になり、
    // **採用できる状態（currentTask 無し / attention 0）なのに連続自律開発が止まった。**
    // 予算が縛るべきは連続した失敗であって生涯試行回数ではない。
    const storage = idleProject()
    const adopted: string[] = []
    const escalations: string[] = []
    let proposalIsBroken = true
    const d = deps({
      readLedger: () => LEDGER,
      // 1回目は壊れた提案（= 1 attempt 消費）、以後は正しい提案
      proposeAdoption: async () => (proposalIsBroken ? 'これは JSON ではない' : PROPOSAL),
      adopt: async (_s, input) => {
        adopted.push(input.roadmapId)
        return { ok: true as const, taskId: `task-${adopted.length}`, roadmapTaskKey: input.roadmapId, title: 't' }
      },
      escalate: async (p) => { escalations.push(p.title) },
    })

    // 1サイクル目: 失敗 → 成功（合計2 attempt。従来はここで生涯予算を使い切っていた）
    const first = await runPlTick(storage, d)
    expect(first.status).toBe('blocked')
    proposalIsBroken = false
    resetPlLoopInFlightForTest()
    expect((await runPlTick(storage, d)).status).toBe('acted')

    // 2サイクル目: 成功で仕切り直しているので、また採用できる
    resetPlLoopInFlightForTest()
    const second = await runPlTick(storage, d)

    expect(second.status).toBe('acted')
    expect(adopted).toHaveLength(2)
    expect(escalations).toEqual([])
  })

  it('採用が続けて失敗したら、再試行ではなく CEO へ上げる', async () => {
    const storage = idleProject()
    const escalations: string[] = []
    const d = deps({
      readLedger: () => LEDGER,
      proposeAdoption: async () => 'これは JSON ではない',
      escalate: async (p) => { escalations.push(p.title) },
    })

    for (let i = 0; i < PL_MAX_ADOPTION_ATTEMPTS; i += 1) {
      resetPlLoopInFlightForTest()
      const r = await runPlTick(storage, d)
      expect(r.status, `attempt ${i + 1}`).toBe('blocked')
    }

    resetPlLoopInFlightForTest()
    const escalated = await runPlTick(storage, d)

    expect(escalated.status).toBe('escalated')
    expect(escalations.length).toBe(1)
  })
})

describe('runPlTick — CEO 判断待ちは黙って放置しない', () => {
  function seedApproval(storage: IStorage, taskId: string): string {
    const created = storage.approvalRequests.create({
      taskId,
      targetBranch: 'candidate/self-dev',
      targetCommit: 'abc1234',
      targetDiffHash: 'hash',
      riskLevel: 'LOW',
      requestedAction: 'git_commit',
      status: 'WAITING_FOR_USER',
      expiresAt: '2026-09-16T00:00:00.000Z',
      invalidIf: [],
      changedFiles: ['docs/notes.md'],
      triggeredRules: ['git_commit requires CEO approval (policy)'],
    } as Parameters<IStorage['approvalRequests']['create']>[0])
    return created.id
  }

  it('承認待ちは診断も Gate も経ずに1回だけ通知する', async () => {
    const { storage, taskId } = seed()
    const approvalId = seedApproval(storage, taskId)
    const escalations: string[] = []
    let diagnosed = 0

    const result = await runPlTick(storage, deps({
      diagnose: async () => { diagnosed += 1; return '{}' },
      escalate: async (p) => { escalations.push(p.body) },
    }))

    expect(result.status).toBe('escalated')
    expect(result.target?.kind).toBe('approval_waiting')
    // provider を消費しない（PL にできることは無いので分析しても意味が無い）
    expect(diagnosed).toBe(0)
    expect(escalations).toHaveLength(1)
    expect(escalations[0]).toContain(approvalId)
  })

  it('同じ承認を毎 tick 通知しない', async () => {
    const { storage, taskId } = seed()
    seedApproval(storage, taskId)
    const escalations: string[] = []
    const d = deps({ escalate: async (p) => { escalations.push(p.body) } })

    await runPlTick(storage, d)
    resetPlLoopInFlightForTest()
    await runPlTick(storage, d)

    expect(escalations).toHaveLength(1)
  })
})

describe('runPlTick — 採用したのに動き出さない Task を黙って放置しない', () => {
  // 2026-09-15 production 実測: 自律採用の直後、Design Review が CONFLICT を返して実装 Job が
  // 作られず、`task_ready_without_job` だけが残った。当時この kind は PL の対象外だったため、
  // **誰にも通知されないままチェーンが停止**した。
  function seedAdoptedTaskWithReview(decision: string): { storage: IStorage; taskId: string } {
    const { storage, taskId } = seed()
    const run = storage.designReviewRuns.create({
      taskId,
      taskTitle: 'adopted',
      designText: 'design text',
      designTextHash: 'hash-adopted',
      changedFiles: [],
    })
    const claim = storage.designReviewRuns.claim(run.id, 3)
    storage.designReviewRuns.complete(
      run.id,
      claim.claimToken as string,
      'succeeded',
      JSON.stringify({
        finalDecision: decision,
        integrationReviewResult: { decision, summary: 'MVP scope discipline と衝突する' },
      }),
      undefined,
    )
    return { storage, taskId }
  }

  /** seed した Task の実 createdAt から相対で観測時刻を作る（NOW は固定日付なので使えない）。 */
  function atMinutesAfterTaskCreated(storage: IStorage, taskId: string, minutes: number): string {
    const createdAt = storage.tasks.findById(taskId)?.createdAt as string
    return new Date(new Date(createdAt).getTime() + minutes * 60 * 1000).toISOString()
  }

  it('採用直後は鳴らさない（Job を作る前に Design Review が走るため、即通知は誤報になる）', async () => {
    const { storage, taskId } = seedAdoptedTaskWithReview('CONFLICT')
    const escalations: string[] = []
    const soon = atMinutesAfterTaskCreated(storage, taskId, 1)

    const result = await runPlTick(storage, deps({
      now: () => soon,
      escalate: async (p) => { escalations.push(p.body) },
    }))

    // まだ Design Review 中でありうる時間。ここで鳴らすと採用のたびに誤報になる
    expect(result.status).not.toBe('escalated')
    expect(escalations).toEqual([])
  })

  it('停滞閾値を過ぎたら1回だけ CEO へ通知し、Design Review の判定を添える', async () => {
    const { storage, taskId } = seedAdoptedTaskWithReview('CONFLICT')
    const escalations: string[] = []
    // 閾値（5分）を超えた時刻から観測する
    const later = atMinutesAfterTaskCreated(storage, taskId, 10)
    const d = deps({ now: () => later, escalate: async (p) => { escalations.push(p.body) } })

    const first = await runPlTick(storage, d)

    expect(first.status).toBe('escalated')
    expect(escalations).toHaveLength(1)
    // 「Job が無い」だけでは CEO は判断できない。止めている判定を載せる
    expect(escalations[0]).toContain('CONFLICT')
    expect(escalations[0]).toContain('MVP scope discipline')
    expect(escalations[0]).toContain('Binding Review')

    // 2回目以降は鳴らさない（通知の信用を落とさない）
    resetPlLoopInFlightForTest()
    const second = await runPlTick(storage, d)
    expect(second.status).not.toBe('escalated')
    expect(escalations).toHaveLength(1)
  })
})

describe('runPlTick — job_blocked は Diagnose して sanctioned な復旧を選ぶ', () => {
  function blockedCommitJob(storage: IStorage, taskId: string, projectId: string): string {
    const job = storage.jobs.create({
      taskId,
      projectId,
      agentRole: 'developer_ai',
      status: 'blocked',
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', message: 'm' },
      dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    storage.jobs.update(job.id, { stderr: 'blocked: approval required' })
    storage.tasks.update(taskId, { status: 'blocked' })
    return job.id
  }

  function alignedEvidence(storage: IStorage, taskId: string): void {
    storage.designReviewEvidence.create({
      taskId,
      reviewKind: 'task',
      subjectId: taskId,
      designTextHash: 'hash',
      reviewLoad: 'low',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    } as Parameters<IStorage['designReviewEvidence']['create']>[0])
  }

  it('blocked reason と approval 状態を診断へ渡す', async () => {
    const { storage, taskId, projectId } = seed()
    const jobId = blockedCommitJob(storage, taskId, projectId)
    let seen: PlDiagnosisInput | undefined

    await runPlTick(storage, deps({
      diagnose: async (input) => {
        seen = input
        return JSON.stringify({ actionKind: 'observe_state', rationale: 'wait', riskLevel: 'LOW' })
      },
    }))

    expect(seen?.attention.kind).toBe('job_blocked')
    const ctx = JSON.stringify(seen?.context)
    expect(ctx).toContain(jobId)
    expect(ctx).toContain('approval required')
    // PL が選べる候補に sanctioned な復旧と escalation が並ぶ
    expect(seen?.allowedActionKinds).toContain('resume_task')
    expect(seen?.allowedActionKinds).toContain('escalate_to_ceo')
  })

  it('protected file の違反は allowedPaths の問題と区別して診断へ渡す', async () => {
    // 2026-09-16 production 実測: PL は fileChangeGuard.ts を触ろうとして止まった Job を
    // 「mismatched allowed paths … configuration issue」と診断した。**正しく Escalate したが
    // 分類を外した** — allowedPaths を広げれば通る、と読める。実際には絶対に通らない。
    const { storage, taskId, projectId } = seed()
    const job = storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    storage.jobs.update(job.id, {
      guardResult: {
        permissionAllowed: true,
        fileChangeAllowed: false,
        fileViolations: ['apps/worker/src/guards/fileChangeGuard.ts', 'docs/notes.md'],
      },
    } as Parameters<IStorage['jobs']['update']>[1])
    storage.tasks.update(taskId, { status: 'blocked' })
    let seen: PlDiagnosisInput | undefined

    await runPlTick(storage, deps({
      diagnose: async (input) => {
        seen = input
        return JSON.stringify({ actionKind: 'observe_state', rationale: 'wait', riskLevel: 'LOW' })
      },
    }))

    const ctx = JSON.stringify(seen?.context)
    // 恒久的に書けないものだけが挙がる。scope の問題（docs/notes.md）と混ぜない
    expect(ctx).toContain('protectedViolations')
    expect(ctx).toContain('apps/worker/src/guards/fileChangeGuard.ts')
    const parsed = JSON.parse(ctx) as { blockedJob?: { protectedViolations?: string[] } }
    expect(parsed.blockedJob?.protectedViolations).toEqual(['apps/worker/src/guards/fileChangeGuard.ts'])
  })

  it('scope だけの違反なら protectedViolations は空（誤って protected 扱いしない）', async () => {
    const { storage, taskId, projectId } = seed()
    const job = storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    storage.jobs.update(job.id, {
      guardResult: { permissionAllowed: true, fileChangeAllowed: false, fileViolations: ['docs/a.md'] },
    } as Parameters<IStorage['jobs']['update']>[1])
    storage.tasks.update(taskId, { status: 'blocked' })
    let seen: PlDiagnosisInput | undefined

    await runPlTick(storage, deps({
      diagnose: async (input) => {
        seen = input
        return JSON.stringify({ actionKind: 'observe_state', rationale: 'wait', riskLevel: 'LOW' })
      },
    }))

    const parsed = JSON.parse(JSON.stringify(seen?.context)) as { blockedJob?: { protectedViolations?: string[] } }
    expect(parsed.blockedJob?.protectedViolations).toEqual([])
  })

  it('診断 prompt が「protected は allowedPaths では解決しない」と明示する', () => {
    // 文言そのものを固定する（ここが消えると PL は再び configuration issue と書く）
    expect(DIAGNOSIS_SYSTEM_FOR_TEST).toContain('permanently forbidden')
    expect(DIAGNOSIS_SYSTEM_FOR_TEST).toContain('No allowedPaths value can ever permit them')
  })

  it('ALIGNED evidence があれば resume を Gate に通し、既存の正式操作で新 Job を作る', async () => {
    const { storage, taskId, projectId } = seed()
    blockedCommitJob(storage, taskId, projectId)
    alignedEvidence(storage, taskId)

    const result = await runPlTick(storage, deps({
      diagnose: async () => JSON.stringify({ actionKind: 'resume_task', rationale: '新しい承認サイクルへ', riskLevel: 'LOW' }),
    }))

    expect(result.status).toBe('acted')
    expect(result.executionSummary).toContain('resume queued job')
    // 既存経路が作る resume Job（新しい workflowStepKey）
    expect(storage.jobs.findByTaskId(taskId).some((j) => j.workflowStepKey?.startsWith('resume:'))).toBe(true)
  })

  it('evidence が複数あっても最新だけを Gate へ出す（古いものへ遡らない）', async () => {
    // 2026-09-15 production 実測: `findByTaskId()` は新しい順に返すのに `.pop()` していたため
    // **最も古い** evidence を出しており、Gate に
    // `design_review evidence ... is not the latest for the target` で2回とも弾かれた。
    // evidence が1件の Task では偶然一致して通るので、2件目ができるまで気付けなかった。
    const { storage, taskId, projectId } = seed()
    blockedCommitJob(storage, taskId, projectId)
    alignedEvidence(storage, taskId)   // 古い方
    alignedEvidence(storage, taskId)   // 新しい方（Gate が要求するのはこちら）

    const result = await runPlTick(storage, deps({
      diagnose: async () => JSON.stringify({ actionKind: 'resume_task', rationale: '新しい承認サイクルへ', riskLevel: 'LOW' }),
    }))

    expect(result.reason ?? '').not.toContain('is not the latest for the target')
    expect(result.status).toBe('acted')
  })

  it('evidence が無ければ resume は Gate に止められる（自己申告では通らない）', async () => {
    const { storage, taskId, projectId } = seed()
    blockedCommitJob(storage, taskId, projectId)

    const result = await runPlTick(storage, deps({
      diagnose: async () => JSON.stringify({ actionKind: 'resume_task', rationale: 'やりたい', riskLevel: 'LOW' }),
    }))

    expect(result.status).toBe('blocked')
    expect(storage.jobs.findByTaskId(taskId).some((j) => j.status === 'queued')).toBe(false)
  })

  it('Job 単位の操作には Job 対象が渡る（Task 対象では target_mismatch で必ず落ちていた）', async () => {
    // 2026-09-15 production 実測: `kind=retry_job target_mismatch=task`。
    // 候補に並んでいるのに構造的に一度も Gate の根拠照合へ届かない操作があった。
    const { storage, taskId, projectId } = seed()
    blockedCommitJob(storage, taskId, projectId)

    const result = await runPlTick(storage, deps({
      diagnose: async () => JSON.stringify({ actionKind: 'retry_job', rationale: 'transient', riskLevel: 'LOW' }),
    }))

    // Gate の根拠照合まで到達している。approval_gate の根拠が無いので止まるが、
    // 理由は「対象種別のズレ」ではなく「根拠が足りない」でなければならない。
    expect(result.status).toBe('blocked')
    expect(result.reason).not.toContain('requires a job target')
    expect(result.reason).not.toContain('cannot be addressed')
    expect(result.reason).toContain('approval_gate')
  })

  it('要求される対象を組み立てられない提案は、Gate を呼ばずに fail-closed で止める', async () => {
    const { storage, taskId, projectId } = seed()
    blockedCommitJob(storage, taskId, projectId)

    const result = await runPlTick(storage, deps({
      // system 対象の操作は PL ループの候補に無い。壊れた提案として通さない。
      diagnose: async () => JSON.stringify({ actionKind: 'restart_service', rationale: 'x', riskLevel: 'LOW' }),
    }))

    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('cannot be addressed')
    expect(storage.jobs.findByTaskId(taskId).some((j) => j.status === 'queued')).toBe(false)
  })

  it('executor の無い操作を選んだら実行せず、試行上限で CEO へ上げる', async () => {
    const { storage, taskId, projectId } = seed()
    blockedCommitJob(storage, taskId, projectId)
    alignedEvidence(storage, taskId)
    const escalations: string[] = []
    const d = deps({
      // clear_workspace_quarantine は safety_review を要するため Gate で止まる（fail-closed）
      diagnose: async () => JSON.stringify({ actionKind: 'clear_workspace_quarantine', rationale: 'x', riskLevel: 'LOW' }),
      escalate: async (p) => { escalations.push(p.title) },
    })

    for (let i = 0; i < PL_MAX_ATTEMPTS_PER_TARGET; i += 1) {
      resetPlLoopInFlightForTest()
      await runPlTick(storage, d)
    }
    resetPlLoopInFlightForTest()
    const escalated = await runPlTick(storage, d)

    expect(escalated.status).toBe('escalated')
    expect(escalations.length).toBe(1)
  })
})
