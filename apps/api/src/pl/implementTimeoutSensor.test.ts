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
  isAtOrAfter,
  percentile,
} from './implementTimeoutSensor'

/**
 * 暫定 timeout（900s）を実データで再評価するためのセンサー。
 *
 * ## いま動いている条件は C だけである（CEO 判断・2026-09-21）
 *
 * A（budget に殺されて生成物を失った Job）と B（その率）は **fail-closed で止めてある**。
 * どちらも `failureMetadata.kind === 'provider_timeout'` を根拠にするが、その印が
 * **いま見ている実行のものだと `jobs` 行からは確認できない**ためである
 * （`failure_metadata` を消す経路が存在せず、実行を identify できる列も無い）。
 *
 * 信じてしまうと、timeout していない失敗で A/B が誤発火し、budget ごとの重複排除キーを
 * 本物の証拠より先に使い切って、**センサー自身の再評価能力を壊す**。
 * 根本原因は Roadmap `job-failure-metadata-outlives-its-run` で別に扱う。
 *
 * したがってここで固定するのは:
 * 1. **A/B が fail-closed であること**（教科書どおりの入力でも発火しない）
 * 2. C は stale metadata に依存せず、これまでどおり動くこと
 * 3. 窓の作り方（完了した Job だけ / 未完了に押し出されない）
 * 4. epoch の記録・復旧（A/B を戻すときに要る土台）
 * 5. センサーが Job を書き換えないこと
 */

const EPOCH = '2026-09-18T00:00:00.000Z'
const afterEpoch = (seconds: number): string =>
  new Date(new Date(EPOCH).getTime() + seconds * 1000).toISOString()

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

/** budget に殺され、生成済みの変更を失った Job。A が本来拾いたかった形。 */
function killedWithProducedWork(seconds: number, completedAt = afterEpoch(3600)): Job {
  return job({
    seconds,
    completedAt,
    status: 'failed',
    changedFiles: ['apps/api/src/pl/executionLoop.ts'],
    failureMetadata: { kind: 'provider_timeout' },
  } as Partial<Job>)
}

const T = CLAUDE_IMPLEMENT_TIMEOUT_MS
const A_SENSOR = 'implement-timeout-discards-produced-work'
const B_SENSOR = 'implement-timeout-rate-too-high'
const C_SENSOR = 'implement-p95-approaching-timeout'

describe('A/B は fail-closed で止まっている', () => {
  // **ここが緩むと、センサーが自分の再評価能力を壊す。**
  // timeout していない失敗を timeout と誤認して重複排除キーを使い切り、
  // 後から来る本物の証拠に対して黙るようになる。
  it('A: 教科書どおりの current-budget kill でも発火しない', () => {
    const findings = evaluateImplementTimeoutSensors([killedWithProducedWork(900)], T, EPOCH)
    expect(findings.filter((f) => f.sensorId === A_SENSOR)).toHaveLength(0)
  })

  it('B: 率が閾値を超える入力でも発火しない', () => {
    const jobs = [
      killedWithProducedWork(900), killedWithProducedWork(900),
      ...Array.from({ length: 48 }, () => job({ seconds: 60 })),
    ]
    expect(evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === B_SENSOR)).toHaveLength(0)
  })

  // stale metadata を信じた場合に何が起きるかを、入力として明示しておく。
  // 再実行して成功した行に前回の印が残るのが、fail-closed にした直接の理由である。
  it('再実行して成功した Job に古い provider_timeout が残っていても、当然発火しない', () => {
    const succeededAfterRetry = job({
      seconds: 120,
      status: 'success',
      changedFiles: ['apps/api/src/pl/executionLoop.ts'],
      failureMetadata: { kind: 'provider_timeout' },
    } as Partial<Job>)

    const findings = evaluateImplementTimeoutSensors([succeededAfterRetry], T, EPOCH)
    expect(findings.filter((f) => f.sensorId === A_SENSOR)).toHaveLength(0)
    expect(findings.filter((f) => f.sensorId === B_SENSOR)).toHaveLength(0)
  })
})

describe('C（stale metadata に依存しない条件）', () => {
  it('サンプルが無ければ何も出さない', () => {
    expect(evaluateImplementTimeoutSensors([], T, EPOCH)).toEqual([])
  })

  it('成功 p95 が timeout の 60% 以上なら発火する', () => {
    const jobs = Array.from({ length: 25 }, () => job({ seconds: 600 }))
    const c = evaluateImplementTimeoutSensors(jobs, T, EPOCH).filter((f) => f.sensorId === C_SENSOR)
    expect(c).toHaveLength(1)
    expect(c[0].evidence).toMatchObject({ successSamples: 25, p95Seconds: 600 })
  })

  // **サンプル不足で p95 を口にしない。** 数字を作らないための条件。
  it('成功サンプルが 20 件未満なら p95 を判定しない', () => {
    const jobs = Array.from({ length: 19 }, () => job({ seconds: 600 }))
    expect(evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === C_SENSOR)).toHaveLength(0)
  })

  it('p95 が 60% 未満なら発火しない', () => {
    const jobs = Array.from({ length: 25 }, () => job({ seconds: 200 }))
    expect(evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === C_SENSOR)).toHaveLength(0)
  })

  // C は `status === 'success'` と所要時間だけを見る。failureMetadata を読まない。
  it('failureMetadata の有無で C の判定は変わらない', () => {
    const clean = Array.from({ length: 25 }, () => job({ seconds: 600 }))
    const marked = clean.map((j) => ({ ...j, failureMetadata: { kind: 'provider_timeout' } } as Job))
    const of = (jobs: Job[]) => evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === C_SENSOR).length
    expect(of(marked)).toBe(of(clean))
  })

  it('直近 WINDOW 件だけを母集団にする', () => {
    // WINDOW 件の速い成功で埋めたあとに、遅い成功を窓の外へ置く。
    const jobs = [
      ...Array.from({ length: IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS.WINDOW }, () => job({ seconds: 60 })),
      ...Array.from({ length: 25 }, () => job({ seconds: 600 })),
    ]
    expect(evaluateImplementTimeoutSensors(jobs, T, EPOCH)
      .filter((f) => f.sensorId === C_SENSOR)).toHaveLength(0)
  })
})

describe('isAtOrAfter', () => {
  // **時刻は文字列ではなく時刻として比べる。** ISO 表記は 1 つではない。
  it('別表記（+09:00）でも同じ瞬間として扱う', () => {
    expect(isAtOrAfter('2026-09-18T00:00:00.000Z', '2026-09-18T09:00:00+09:00')).toBe(true)
    expect(isAtOrAfter('2026-09-18T00:00:01.000Z', '2026-09-18T09:00:00+09:00')).toBe(true)
    // 辞書順なら false になってしまう組み合わせ。
    expect('2026-09-18T00:00:01.000Z' >= '2026-09-18T09:00:00+09:00').toBe(false)
  })

  it('解釈できない値や undefined は false（fail-closed）', () => {
    expect(isAtOrAfter('not a date', EPOCH)).toBe(false)
    expect(isAtOrAfter(EPOCH, 'not a date')).toBe(false)
    expect(isAtOrAfter(undefined, EPOCH)).toBe(false)
  })
})

describe('percentile', () => {
  it('サンプルが無ければ undefined', () => {
    expect(percentile([], 0.95)).toBeUndefined()
  })
  it('昇順で分位点を返す', () => {
    expect(percentile([5, 1, 3], 0.5)).toBe(3)
  })
  // C のコメントが主張している性質。閾値未満の標本は p95 を閾値の上へ押し出せない。
  it('閾値未満の標本を足しても p95 は閾値を跨がない', () => {
    const current = Array.from({ length: 20 }, (_, i) => (i === 19 ? 600 : 100))
    const older = Array.from({ length: 20 }, () => 200)
    expect(percentile(current, 0.95)).toBeLessThan(540)
    expect(percentile([...current, ...older], 0.95)!).toBeLessThan(540)
  })
})

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

function createJobRow(storage: IStorage, taskId: string, patch: Record<string, unknown>): string {
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
  storage.jobs.update(created.id, patch as never)
  return created.id
}

const after = (iso: string, seconds: number): string =>
  new Date(new Date(iso).getTime() + seconds * 1000).toISOString()

describe('findRecentAiCliJobs（センサーが見る窓）', () => {
  // **未完了の行に窓を食い潰させない。** production には 7〜20 日 queued のままの Job がある。
  it('新しく作られた queued Job は窓に入らない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seed(storage)
    const finished = createJobRow(storage, taskId, {
      status: 'success', startedAt: EPOCH, completedAt: after(EPOCH, 60),
    })
    for (let i = 0; i < IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS.WINDOW + 5; i++) {
      createJobRow(storage, taskId, {})
    }

    const window = storage.jobs.findRecentAiCliJobs({
      provider: 'claude_code', mode: 'implement', limit: IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS.WINDOW,
    })
    expect(window.map((j) => j.id)).toContain(finished)
  })

  // **requeue された行は `completed_at` が前回のまま残る。**
  // `jobs.update()` は `{ ...existing, ...data }` なので部分更新では消えない。
  it('requeue されて completed_at が残っている行は窓に入らない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seed(storage)
    const finished = createJobRow(storage, taskId, {
      status: 'success', startedAt: EPOCH, completedAt: after(EPOCH, 60),
    })
    for (let i = 0; i < IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS.WINDOW + 5; i++) {
      // status は queued へ戻っているが completed_at はより新しい値のまま。
      createJobRow(storage, taskId, { status: 'queued', completedAt: after(EPOCH, 5_000 + i) })
    }

    const window = storage.jobs.findRecentAiCliJobs({
      provider: 'claude_code', mode: 'implement', limit: IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS.WINDOW,
    })
    expect(window.every((j) => j.status === 'success' || j.status === 'failed')).toBe(true)
    expect(window.map((j) => j.id)).toContain(finished)
  })
})

describe('ensureImplementTimeoutPolicyEpoch', () => {
  // A/B を戻すときに要る土台。いま A/B は止まっているが、epoch の記録自体は正しく保つ。
  it('同じ値を聞いている間は epoch が動かない', () => {
    const storage = createSQLiteStorage(':memory:')
    const first = ensureImplementTimeoutPolicyEpoch(storage, 900_000, () => EPOCH)
    expect(ensureImplementTimeoutPolicyEpoch(storage, 900_000, () => after(EPOCH, 60))).toBe(first)
  })

  it('budget を戻したときは新しい epoch が始まる', () => {
    const storage = createSQLiteStorage(':memory:')
    const first = ensureImplementTimeoutPolicyEpoch(storage, 900_000, () => EPOCH)
    ensureImplementTimeoutPolicyEpoch(storage, 1_000_000, () => after(EPOCH, 60))
    const back = ensureImplementTimeoutPolicyEpoch(storage, 900_000, () => after(EPOCH, 120))
    expect(back).not.toBe(first)
    expect(back).toBe(after(EPOCH, 120))
  })

  // **壊れた epoch で無言停止しない。** 未来の epoch はどの Job も対象外にしてしまう。
  it('未来日付の epoch は信用せず張り直す', () => {
    const storage = createSQLiteStorage(':memory:')
    storage.auditLog.record({
      actor: 'api',
      operation: 'implement_timeout_policy_epoch_started',
      entityType: 'implement_timeout_policy_epoch',
      entityId: 'current',
      result: 'started',
      detail: JSON.stringify({ timeoutMs: T, effectiveFrom: '9999-01-01T00:00:00.000Z' }),
    })
    expect(ensureImplementTimeoutPolicyEpoch(storage, T, () => EPOCH)).toBe(EPOCH)
  })

  it('解釈できない effectiveFrom も張り直す', () => {
    const storage = createSQLiteStorage(':memory:')
    storage.auditLog.record({
      actor: 'api',
      operation: 'implement_timeout_policy_epoch_started',
      entityType: 'implement_timeout_policy_epoch',
      entityId: 'current',
      result: 'started',
      detail: JSON.stringify({ timeoutMs: T, effectiveFrom: 'not a date' }),
    })
    expect(ensureImplementTimeoutPolicyEpoch(storage, T, () => EPOCH)).toBe(EPOCH)
  })

  // 別表記で保存されていても、返す値は正規化しておく（文字列比較の事故を持ち回らない）。
  it('別表記の effectiveFrom は正規化して返す', () => {
    const storage = createSQLiteStorage(':memory:')
    storage.auditLog.record({
      actor: 'api',
      operation: 'implement_timeout_policy_epoch_started',
      entityType: 'implement_timeout_policy_epoch',
      entityId: 'current',
      result: 'started',
      detail: JSON.stringify({ timeoutMs: T, effectiveFrom: '2026-09-18T09:00:00+09:00' }),
    })
    expect(ensureImplementTimeoutPolicyEpoch(storage, T, () => after(EPOCH, 86_400)))
      .toBe('2026-09-18T00:00:00.000Z')
  })
})

describe('evaluateAndPersistImplementTimeoutSensors', () => {
  it('C の発火を audit_log へ残し、2 度目は残さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seed(storage)
    for (let i = 0; i < 25; i++) {
      createJobRow(storage, taskId, {
        status: 'success',
        startedAt: after(EPOCH, 10_000 + i * 700),
        completedAt: after(EPOCH, 10_600 + i * 700),
      })
    }

    const first = evaluateAndPersistImplementTimeoutSensors(storage, T, () => EPOCH)
    expect(first.some((f) => f.sensorId === C_SENSOR)).toBe(true)

    const second = evaluateAndPersistImplementTimeoutSensors(storage, T, () => EPOCH)
    expect(second.some((f) => f.sensorId === C_SENSOR)).toBe(false)
  })

  it('entity id は sensorId と scope だけで決まる', () => {
    expect(implementTimeoutSensorEntityId({ sensorId: B_SENSOR, scope: '900000' }))
      .toBe('implement-timeout-rate-too-high:900000')
  })

  // **センサーは測る対象を書き換えない。**
  it('Job を書き換えない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seed(storage)
    createJobRow(storage, taskId, {
      status: 'failed',
      startedAt: after(EPOCH, 100),
      completedAt: after(EPOCH, 1_000),
      changedFiles: ['apps/api/src/pl/executionLoop.ts'],
      failureMetadata: { kind: 'provider_timeout' },
    })
    const before = storage.jobs.findByTaskId(taskId).map((j) => ({ ...j }))

    evaluateAndPersistImplementTimeoutSensors(storage, T, () => EPOCH)

    expect(storage.jobs.findByTaskId(taskId)).toEqual(before)
  })
})
