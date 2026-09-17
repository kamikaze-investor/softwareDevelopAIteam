import { describe, expect, it } from 'vitest'
import { loadEngineeringPrinciples, normalizeAppliedPrinciples, selectPrinciples } from '@ai-team/shared/src/engineeringPrinciples.js'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { createAndExecuteDesignReview } from '../designReview/designReviewCoordinator'
import { PRINCIPLE_SENSOR_THRESHOLDS, buildPrincipleStats, recordPrincipleApplications } from './ledger'

/**
 * 2026-09-17 の Independent Review（Codex）で REFUTED になった指摘の回帰テスト。
 *
 * どれも「実装が主張どおりでなかった」もので、直した後に黙って戻らないよう固定する。
 */

function createStorage(): IStorage {
  return createSQLiteStorage(':memory:')
}

function seed(storage: IStorage): { projectId: string; taskId: string } {
  const project = storage.projects.create({
    name: 'P', goal: 'g', designPhilosophy: [], status: 'draft',
  })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'pending',
    assignee: 'developer_ai', dependencies: [],
  })
  return { projectId: project.id, taskId: task.id }
}

function selection() {
  return selectPrinciples(undefined, loadEngineeringPrinciples())
}

function applied(verdicts: Array<{ principleId: string; verdict: string; reason: string }>) {
  return normalizeAppliedPrinciples(verdicts, selection())
}

describe('claim 3/5: independent stage verdicts reach the ledger and drive disagreement', () => {
  it('independent stage の行が実際に記録される', () => {
    const storage = createStorage()
    const { projectId, taskId } = seed(storage)

    recordPrincipleApplications(storage, { projectId, taskId, reviewRunId: 'run-1' }, {
      independentReviewResult: {
        appliedPrinciples: applied([{ principleId: 'observation-closes-loop', verdict: 'CONFLICT', reason: 'x' }]),
      },
    })

    const independentRows = storage.principleApplications.findAll()
      .filter((row) => row.reviewStage === 'independent')
    expect(independentRows.length).toBe(selection().length)
  })

  it('同じ stage の別 run で判定が割れただけのものは disagreement にしない', () => {
    const storage = createStorage()
    const { projectId, taskId } = seed(storage)
    const target = 'observation-closes-loop'

    // design stage を 2 回。判定は割れているが、reviewer 間の不一致ではなく時間差である。
    recordPrincipleApplications(storage, { projectId, taskId, reviewRunId: 'run-1' }, {
      focusedReviewResults: [{ appliedPrinciples: applied([{ principleId: target, verdict: 'ALIGNED', reason: 'a' }]) }],
    })
    recordPrincipleApplications(storage, { projectId, taskId, reviewRunId: 'run-2' }, {
      focusedReviewResults: [{ appliedPrinciples: applied([{ principleId: target, verdict: 'CONFLICT', reason: 'b' }]) }],
    })

    expect(storage.principleApplications.findDisagreements()).toEqual([])
  })

  it('stage が違って判定も違うときだけ disagreement になる', () => {
    const storage = createStorage()
    const { projectId, taskId } = seed(storage)
    const target = 'observation-closes-loop'

    recordPrincipleApplications(storage, { projectId, taskId, reviewRunId: 'run-1' }, {
      focusedReviewResults: [{ appliedPrinciples: applied([{ principleId: target, verdict: 'ALIGNED', reason: 'a' }]) }],
      independentReviewResult: { appliedPrinciples: applied([{ principleId: target, verdict: 'CONFLICT', reason: 'b' }]) },
    })

    const rows = storage.principleApplications.findDisagreements()
    expect(rows.find((row) => row.principleId === target)?.verdicts.map((v) => v.reviewStage).sort())
      .toEqual(['design', 'independent'])
  })
})

describe('claim 3: unknown principle ids never reach the DB', () => {
  it('registry に無い id は記録せず warn する', () => {
    const storage = createStorage()
    const { projectId, taskId } = seed(storage)

    // normalizeAppliedPrinciples を経由しない、捏造された runner 出力を直接渡す。
    recordPrincipleApplications(storage, { projectId, taskId, reviewRunId: 'run-1' }, {
      focusedReviewResults: [{
        appliedPrinciples: [
          {
            principleId: 'totally-made-up',
            principleVersionHash: 'deadbeefdeadbeef',
            selectionSource: 'core',
            selectionReason: 'forged',
            verdict: 'CONFLICT',
            reason: 'forged',
          },
        ],
      }],
    })

    expect(storage.principleApplications.findAll()).toEqual([])
  })
})

describe('sensors count only the current principle version', () => {
  it('本文が変わった原則の旧版実績で降格を提案しない', () => {
    const storage = createStorage()
    const { projectId } = seed(storage)
    const target = 'observation-closes-loop'

    // 旧版の hash で閾値ぶんの ALIGNED を積む。
    for (let index = 0; index < PRINCIPLE_SENSOR_THRESHOLDS.CORE_DEMOTION_MIN_APPLICATIONS; index += 1) {
      storage.principleApplications.recordMany([{
        projectId,
        taskId: `task-${index}`,
        principleId: target,
        principleVersionHash: 'stale00000000000',
        selectionSource: 'core',
        selectionReason: 'core principle',
        reviewStage: 'design',
        verdict: 'ALIGNED',
        reviewRunId: `run-${index}`,
      }])
    }

    const stats = buildPrincipleStats(storage)
    // 表示上の集計には出る（実際に起きたことなので消さない）。
    expect(stats.aggregates.find((row) => row.principleId === target)?.applications)
      .toBe(PRINCIPLE_SENSOR_THRESHOLDS.CORE_DEMOTION_MIN_APPLICATIONS)
    // しかしセンサーは現在の版の実績が 0 件なので発火しない。
    expect(stats.sensors).toEqual([])
  })
})

describe('claim 10: the recording step cannot fail a review run', () => {
  it('Task 参照が投げても Design Review は正常に終端する', async () => {
    const storage = createStorage()
    const { taskId } = seed(storage)

    // 記録経路が最初に触る storage.tasks.findById を投げるようにする。
    // 以前はこの呼び出しが ledger の try/catch の外にあり、run が running のまま残った。
    const exploding = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'tasks') {
          return new Proxy(target.tasks, {
            get(taskTarget, taskProp, taskReceiver) {
              if (taskProp === 'findById') {
                return () => { throw new Error('ledger lookup exploded') }
              }
              return Reflect.get(taskTarget, taskProp, taskReceiver)
            },
          })
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as IStorage

    const stdout = JSON.stringify({
      reviewLoad: 'low',
      selectedFocuses: [],
      focusedReviewResults: [],
      integrationReviewResult: { decision: 'ALIGNED' },
      finalDecision: 'ALIGNED',
    })

    const result = await createAndExecuteDesignReview(
      exploding,
      { taskId, taskTitle: 'design', designText: 'd', changedFiles: ['docs/readme.md'] },
      {
        runnerCommand: 'node',
        runnerArgs: [],
        homeDirectory: '/tmp/home',
        workingDir: '/tmp/work',
        execute: async () => ({ ok: true, stdout, timedOut: false }),
      },
    )

    // Review は通常どおり終端する。run が running のまま残らない。
    expect(result.status).toBe('evidence_registered')
    expect(storage.designReviewRuns.findQueued()).toEqual([])
  })
})

describe('claim 4: only the attempt that won the claim fence is recorded', () => {
  it('fence に負けた attempt (status=stale) の判定は記録しない', async () => {
    const storage = createStorage()
    const { taskId } = seed(storage)

    const stdout = JSON.stringify({
      reviewLoad: 'low',
      selectedFocuses: [],
      focusedReviewResults: [],
      integrationReviewResult: { decision: 'ALIGNED' },
      finalDecision: 'ALIGNED',
    })

    // completeWithEvidence を「claim を失った」状態に見せる = fence 拒否。
    const losing = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'designReviewRuns') {
          return new Proxy(target.designReviewRuns, {
            get(runTarget, runProp, runReceiver) {
              if (runProp === 'completeWithEvidence') return () => undefined
              return Reflect.get(runTarget, runProp, runReceiver)
            },
          })
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as IStorage

    const result = await createAndExecuteDesignReview(
      losing,
      { taskId, taskTitle: 'design', designText: 'd', changedFiles: ['docs/readme.md'] },
      {
        runnerCommand: 'node',
        runnerArgs: [],
        homeDirectory: '/tmp/home',
        workingDir: '/tmp/work',
        execute: async () => ({ ok: true, stdout, timedOut: false }),
      },
    )

    expect(result.status).toBe('stale')
    // fence が拒否した attempt の判定は ledger に残らない。
    expect(storage.principleApplications.findAll()).toEqual([])
  })
})

describe('round-4: ledger integrity guards', () => {
  it('registry 形式でない版 hash は記録しない', () => {
    const storage = createStorage()
    const { projectId, taskId } = seed(storage)

    recordPrincipleApplications(storage, { projectId, taskId, reviewRunId: 'run-1' }, {
      focusedReviewResults: [{
        appliedPrinciples: [{
          principleId: 'observation-closes-loop',
          principleVersionHash: 'x',
          selectionSource: 'core',
          selectionReason: 'r',
          verdict: 'ALIGNED',
          reason: 'r',
        }],
      }],
    })

    expect(storage.principleApplications.findAll()).toEqual([])
  })

  it('reviewRunId が無い記録は拒否する（重複排除が効かないため）', () => {
    const storage = createStorage()
    const { projectId, taskId } = seed(storage)

    const result = recordPrincipleApplications(storage, { projectId, taskId }, {
      focusedReviewResults: [{ appliedPrinciples: applied([]) }],
    })

    expect(result.recorded).toBe(0)
    expect(result.error).toContain('reviewRunId is required')
    expect(storage.principleApplications.findAll()).toEqual([])
  })

  it('違う版について下された判定は disagreement として突き合わせない', () => {
    const storage = createStorage()
    const { projectId, taskId } = seed(storage)
    const target = 'observation-closes-loop'

    // 同一 run・同一 subject だが、design と independent が別の版を見ている。
    storage.principleApplications.recordMany([
      {
        projectId, taskId, principleId: target,
        principleVersionHash: 'aaaaaaaaaaaaaaaa',
        selectionSource: 'core', selectionReason: 'r',
        reviewStage: 'design', verdict: 'ALIGNED', reviewRunId: 'run-1',
      },
      {
        projectId, taskId, principleId: target,
        principleVersionHash: 'bbbbbbbbbbbbbbbb',
        selectionSource: 'core', selectionReason: 'r',
        reviewStage: 'independent', verdict: 'CONFLICT', reviewRunId: 'run-1',
      },
    ])

    expect(storage.principleApplications.findDisagreements()).toEqual([])
  })
})
