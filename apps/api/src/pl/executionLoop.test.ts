import { describe, expect, it, beforeEach } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { buildSystemState } from '../state/systemState'
import {
  PL_MAX_ATTEMPTS_PER_TARGET,
  countPriorAttempts,
  extractProposedKind,
  isRecoveryTargetResolved,
  resetPlLoopInFlightForTest,
  runPlTick,
  verifyOutcome,
  type PlLoopDeps,
} from './executionLoop'

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
