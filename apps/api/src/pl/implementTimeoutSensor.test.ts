import { describe, expect, it } from 'vitest'
import type { Job } from '@ai-team/shared'
import { CLAUDE_IMPLEMENT_TIMEOUT_MS } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import {
  IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS,
  ensureImplementTimeoutPolicyEpoch,
  evaluateAndPersistImplementTimeoutSensors,
  evaluateImplementTimeoutSensors,
  implementTimeoutSensorEntityId,
  percentile,
} from './implementTimeoutSensor'

/**
 * 暫定 timeout（900s）を実データで再評価するためのセンサー（CEO 指示・2026-09-18）。
 *
 * ここで固定したいのは 6 点である。
 * 1. A/B/C の 3 条件がそれぞれ正しく発火する
 * 2. **policy epoch より前に完了した Job では A/B が発火しない**
 * 3. **隣接する budget（900s -> 1000s）でも旧 policy の Job が新 policy を発火させない**
 *    —— 経過時間ベースの判定はここで壊れていた
 * 4. 同じ budget で 2 度目は発火しない（毎 tick 同じ候補を出さない）
 * 5. 未完了（queued）の Job が窓を食い潰さない
 * 6. センサーは timeout 値も Job も書き換えない
 */

const EPOCH = '2026-09-18T00:00:00.000Z'
/** epoch から `seconds` 秒後の時刻。テストの時刻をすべて epoch 基準で決める。 */
const afterEpoch = (seconds: number): string =>
  new Date(new Date(EPOCH).getTime() + seconds * 1000).toISOString()
/** epoch より前の時刻。 */
const beforeEpoch = (seconds: number): string =>
  new Date(new Date(EPOCH).getTime() - seconds * 1000).toISOString()

function job(overrides: Partial<Job> & { seconds?: number, completedAt?: string }): Job {
  const { seconds = 60, completedAt = afterEpoch(3600), ...rest } = overrides
  const started = new Date(new Date(completedAt).getTime() - seconds * 1000).toISOString()
  return {
    id: `job-${Math.random().toString(36).slice(2, 10)}`,
    taskId: 'task-1',
    projectId: 'project-1',
    agentRole: 'developer_ai',
    status: 'success',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    dryRun: false,
    createdAt: started,
    startedAt: started,
    completedAt,
    aiCliProvider: 'claude_code',
    aiCliMode: 'implement',
    changedFiles: [],
    ...rest,
  } as Job
}

/** budget に殺され、生成済みの変更を失った Job（= A の対象）。 */
function killedWithProducedWork(seconds: number, completedAt = afterEpoch(3600)): Job {
  return job({
    seconds,
    completedAt,
    status: 'failed',
    changedFiles: ['apps/api/src/pl/executionLoop.ts'],
    failureMetadata: { kind: 'provider_timeout' },
  } as Partial<Job>)
}

describe('evaluateImplementTimeoutSensors', () => {
  const T = CLAUDE_IMPLEMENT_TIMEOUT_MS

  it('サンプルが無ければ何も出さない', () => {
    expect(evaluateImplementTimeoutSensors([], T, EPOCH)).toEqual([])
  })

  // ── A ────────────────────────────────────────────────────────
  it('A: budget に殺され、変更を生成済みだった Job は 1 件でも発火する', () => {
    const findings = evaluateImplementTimeoutSensors([killedWithProducedWork(900)], T, EPOCH)
    const a = findings.filter((f) => f.sensorId === 'implement-timeout-discards-produced-work')
    expect(a).toHaveLength(1)
    expect(a[0].evidence).toMatchObject({ durationSeconds: 900, timeoutSeconds: 900 })
  })

  // **epoch より前に完了した Job は、どの budget で走ったか分からないので対象外。**
  it('A: policy epoch より前に完了した timeout では発火しない', () => {
    const old = killedWithProducedWork(900, beforeEpoch(60))
    expect(evaluateImplementTimeoutSensors([old], T, EPOCH)
      .filter((f) => f.sensorId === 'implement-timeout-discards-produced-work')).toHaveLength(0)
  })

  it('A: timeout でも changedFiles が無ければ発火しない（失われた生成物が無い）', () => {
    const noWork = job({
      seconds: 900,
      status: 'failed',
      changedFiles: [],
      failureMetadata: { kind: 'provider_timeout' },
    } as Partial<Job>)
    expect(evaluateImplementTimeoutSensors([noWork], T, EPOCH)
      .filter((f) => f.sensorId === 'implement-timeout-discards-produced-work')).toHaveLength(0)
  })

  // **経過時間では判定しない。** `provider_timeout` は「渡した timeoutMs のタイマーが
  // 発火して kill された」ことだけを意味し、長く走ったこととは別である。
  it('A: provider_timeout でなければ、どれだけ長く走っていても発火しない', () => {
    const slowButFinished = job({
      seconds: 900,
      status: 'failed',
      changedFiles: ['apps/api/src/pl/executionLoop.ts'],
      failureMetadata: { kind: 'other_failure' },
    } as Partial<Job>)
    expect(evaluateImplementTimeoutSensors([slowButFinished], T, EPOCH)
      .filter((f) => f.sensorId === 'implement-timeout-discards-produced-work')).toHaveLength(0)
  })

  // **`completedAt` は後から書き換えられるので regime の根拠にできない。**
  // `releaseBlockedJobAndParkTask()` は blocked のまま残っていた兄弟 Job を failed にするとき
  // `completedAt` をその時刻で上書きする。旧 budget 下で timeout した Job が、後日 park された
  // だけで「今日終わった」ことになり、新しい epoch の証拠として数えられてしまう
  // （独立レビュー指摘。production には 22 時間後に completed_at が書かれた行が実在する）。
  it('epoch より前に開始した timeout は、completedAt が epoch 後に書き換えられても発火しない', () => {
    const reStamped = job({
      // 開始は epoch より前。ここが regime を決める。
      startedAt: beforeEpoch(1_800),
      // park されたときに書き直された completedAt は epoch より後。
      completedAt: afterEpoch(3_600),
      status: 'failed',
      changedFiles: ['apps/api/src/pl/executionLoop.ts'],
      failureMetadata: { kind: 'provider_timeout' },
    } as Partial<Job>)

    const findings = evaluateImplementTimeoutSensors([reStamped], T, EPOCH)
    expect(findings.filter((f) => f.sensorId === 'implement-timeout-discards-produced-work')).toHaveLength(0)
    expect(findings.filter((f) => f.sensorId === 'implement-timeout-rate-too-high')).toHaveLength(0)
  })

  // ── B ────────────────────────────────────────────────────────
  it('B: timeout 率が 3% 以上なら発火する', () => {
    const jobs = [
      killedWithProducedWork(900), killedWithProducedWork(900),
      ...Array.from({ length: 48 }, () => job({ seconds: 60 })),
    ]
    const b = evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === 'implement-timeout-rate-too-high')
    expect(b).toHaveLength(1)
    expect(b[0].evidence).toMatchObject({ windowSize: 50, budgetExhaustedTimeoutCount: 2 })
  })

  // B の分子にも epoch を掛けないと、旧 policy の timeout だけで発火し、
  // budget 値を鍵にした重複排除キーを使い切ってしまう。
  it('B: policy epoch より前の timeout だけでは発火しない', () => {
    const jobs = [
      killedWithProducedWork(900, beforeEpoch(120)),
      killedWithProducedWork(900, beforeEpoch(60)),
      ...Array.from({ length: 48 }, () => job({ seconds: 60 })),
    ]
    expect(evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === 'implement-timeout-rate-too-high')).toHaveLength(0)
  })

  it('B: timeout 率が 3% 未満なら発火しない', () => {
    const jobs = [
      killedWithProducedWork(900),
      ...Array.from({ length: 49 }, () => job({ seconds: 60 })),
    ]
    expect(evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === 'implement-timeout-rate-too-high')).toHaveLength(0)
  })

  // ── C ────────────────────────────────────────────────────────
  it('C: 成功 p95 が timeout の 60% 以上なら発火する', () => {
    const jobs = Array.from({ length: 25 }, () => job({ seconds: 600 }))
    const c = evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === 'implement-p95-approaching-timeout')
    expect(c).toHaveLength(1)
    expect(c[0].evidence).toMatchObject({ successSamples: 25, p95Seconds: 600 })
  })

  // **C は epoch で絞らない（意図的）。** 成功 Job の所要時間は打ち切られていない実測値なので、
  // どの policy 下のものでも標本として有効である。
  it('C: epoch より前の成功 Job も標本に含める', () => {
    const jobs = Array.from({ length: 25 }, () => job({ seconds: 600, completedAt: beforeEpoch(60) }))
    expect(evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === 'implement-p95-approaching-timeout')).toHaveLength(1)
  })

  it('C: 成功サンプルが 20 件未満なら p95 を判定しない', () => {
    const jobs = Array.from({ length: 19 }, () => job({ seconds: 600 }))
    expect(evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === 'implement-p95-approaching-timeout')).toHaveLength(0)
  })

  it('C: p95 が 60% 未満なら発火しない', () => {
    const jobs = Array.from({ length: 25 }, () => job({ seconds: 200 }))
    expect(evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === 'implement-p95-approaching-timeout')).toHaveLength(0)
  })

  it('直近 WINDOW 件だけを母集団にする', () => {
    const jobs = [
      ...Array.from({ length: IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS.WINDOW }, () => job({ seconds: 60 })),
      killedWithProducedWork(900),  // WINDOW の外
    ]
    expect(evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === 'implement-timeout-discards-produced-work')).toHaveLength(0)
  })
})

describe('percentile', () => {
  it('サンプルが無ければ undefined', () => {
    expect(percentile([], 0.95)).toBeUndefined()
  })
  it('昇順で分位点を返す', () => {
    expect(percentile([5, 1, 3], 0.5)).toBe(3)
  })
})

describe('evaluateAndPersistImplementTimeoutSensors', () => {
  function seed(storage: IStorage): string {
    const project = storage.projects.create({
      name: 'sensor', goal: 'g', designPhilosophy: [], status: 'draft',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 't', description: 'd', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1,
    } as Parameters<IStorage['tasks']['create']>[0])
    return task.id
  }

  /** `completedAt` を明示して Job を作る。epoch との前後関係をテストが決められるようにする。 */
  function createTimedOutJob(
    storage: IStorage,
    taskId: string,
    seconds: number,
    completedAt: string,
  ): void {
    const created = storage.jobs.create({
      taskId,
      projectId: storage.tasks.findById(taskId)!.projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
      aiCliProvider: 'claude_code',
      aiCliMode: 'implement',
    } as never)
    storage.jobs.update(created.id, {
      status: 'failed',
      startedAt: new Date(new Date(completedAt).getTime() - seconds * 1000).toISOString(),
      completedAt,
      changedFiles: ['apps/api/src/pl/executionLoop.ts'],
      failureMetadata: { kind: 'provider_timeout' },
    } as never)
  }

  /** ある時刻の `seconds` 秒後。 */
  const after = (iso: string, seconds: number): string =>
    new Date(new Date(iso).getTime() + seconds * 1000).toISOString()

  it('発火を audit_log へ残し、2 度目は残さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seed(storage)

    // epoch を先に確定させ、その後に完了した Job を置く。
    const epoch = ensureImplementTimeoutPolicyEpoch(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS, () => EPOCH)
    createTimedOutJob(storage, taskId, 900, after(epoch, 900))

    const first = evaluateAndPersistImplementTimeoutSensors(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS)
    expect(first.filter((f) => f.sensorId === 'implement-timeout-discards-produced-work')).toHaveLength(1)

    // 同じ tick が何度回っても、同じ候補を作り直さない。
    const second = evaluateAndPersistImplementTimeoutSensors(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS)
    expect(second.filter((f) => f.sensorId === 'implement-timeout-discards-produced-work')).toHaveLength(0)
  })

  // **policy regime の判定は経過時間では代用できない。**
  // 旧 budget 900s で落ちた Job は 900 秒走っているので、「新 budget 1000s の 90% = 900 秒以上」
  // という経過時間の条件を満たしてしまう。そのため旧 policy の Job が新 policy の証拠として
  // 数えられ、`...:1000000` の重複排除キーまで使い切っていた（CEO 指示・2026-09-18 の境界ケース）。
  // 300s -> 900s では 90% = 810 > 304 なので偶然通っていただけだった。
  it('隣接する budget へ変えても、旧 policy の Job は新 policy を発火させない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seed(storage)

    // 時刻を明示して進める。epoch の前後関係が 1 ミリ秒差に左右されないようにする。
    const T0 = EPOCH
    const T1 = after(T0, 3_600)   // 旧 policy の Job が終わった時刻
    const T2 = after(T0, 7_200)   // budget を広げた時刻
    const T3 = after(T0, 10_800)  // 新 policy の Job が終わった時刻

    // 旧 policy（900s）の下で 900 秒走って落ちた Job。
    ensureImplementTimeoutPolicyEpoch(storage, 900_000, () => T0)
    createTimedOutJob(storage, taskId, 900, T1)
    const underOldPolicy = evaluateAndPersistImplementTimeoutSensors(storage, 900_000, () => T1)
    expect(underOldPolicy.some((f) => f.sensorId === 'implement-timeout-discards-produced-work')).toBe(true)

    // budget を 1000s へ広げる。**新しい証拠はまだ 1 件も無い。**
    // 旧 Job は 900 秒走っているので、経過時間だけを見ると新 budget の 90% を満たしてしまう。
    const underNewPolicy = evaluateAndPersistImplementTimeoutSensors(storage, 1_000_000, () => T2)
    expect(underNewPolicy.some((f) => f.sensorId === 'implement-timeout-discards-produced-work')).toBe(false)
    expect(underNewPolicy.some((f) => f.sensorId === 'implement-timeout-rate-too-high')).toBe(false)

    // `...:1000000` の重複排除キーが消費されていないこと。
    // 消費されていると、本物の 1000s 時代の証拠が出ても二度と発火しない。
    createTimedOutJob(storage, taskId, 1_000, T3)
    const withRealEvidence = evaluateAndPersistImplementTimeoutSensors(storage, 1_000_000, () => T3)
    expect(withRealEvidence.some((f) => f.sensorId === 'implement-timeout-discards-produced-work')).toBe(true)
    expect(withRealEvidence.some((f) => f.sensorId === 'implement-timeout-rate-too-high')).toBe(true)
  })

  // budget を元へ戻した場合、epoch 行がもう 1 行積まれて新しい起点になる。
  it('budget を戻したときは新しい epoch が始まる', () => {
    const storage = createSQLiteStorage(':memory:')
    const first = ensureImplementTimeoutPolicyEpoch(storage, 900_000, () => EPOCH)
    ensureImplementTimeoutPolicyEpoch(storage, 1_000_000, () => after(EPOCH, 60))
    const back = ensureImplementTimeoutPolicyEpoch(storage, 900_000, () => after(EPOCH, 120))
    expect(back).not.toBe(first)
    expect(back).toBe(after(EPOCH, 120))
    // 同じ値を続けて聞いても epoch は動かない。
    expect(ensureImplementTimeoutPolicyEpoch(storage, 900_000, () => after(EPOCH, 180))).toBe(back)
  })

  // **未完了の Job に窓を食い潰させない。**
  // queued 行は並べ替えの基準に created_at しか持たないので、新しく作られた queued が
  // 大量にあると LIMIT の内側を占め、今日落ちた本物の timeout を押し出してしまう
  // （production には 7〜20 日 queued のままの Job が 3 件実在する）。
  it('新しく作られた queued Job は、完了済みの timeout 証拠を窓から押し出さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seed(storage)

    const epoch = ensureImplementTimeoutPolicyEpoch(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS, () => EPOCH)
    createTimedOutJob(storage, taskId, 900, after(epoch, 900))

    for (let i = 0; i < IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS.WINDOW + 5; i++) {
      storage.jobs.create({
        taskId,
        projectId: storage.tasks.findById(taskId)!.projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
        dryRun: false,
        aiCliProvider: 'claude_code',
        aiCliMode: 'implement',
      } as never)
    }

    const fired = evaluateAndPersistImplementTimeoutSensors(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS)
    expect(fired.some((f) => f.sensorId === 'implement-timeout-discards-produced-work')).toBe(true)
  })

  it('entity id は sensorId と scope だけで決まる', () => {
    expect(implementTimeoutSensorEntityId({
      sensorId: 'implement-timeout-rate-too-high', scope: '900000',
    })).toBe('implement-timeout-rate-too-high:900000')
  })

  // **センサーは測る対象を書き換えない。**
  it('Job を書き換えない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seed(storage)
    const epoch = ensureImplementTimeoutPolicyEpoch(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS, () => EPOCH)
    createTimedOutJob(storage, taskId, 900, after(epoch, 900))
    const before = storage.jobs.findByTaskId(taskId).map((j) => ({ ...j }))

    evaluateAndPersistImplementTimeoutSensors(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS)

    expect(storage.jobs.findByTaskId(taskId)).toEqual(before)
  })
})
