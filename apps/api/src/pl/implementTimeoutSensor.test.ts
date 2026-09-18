import { describe, expect, it } from 'vitest'
import type { Job } from '@ai-team/shared'
import { CLAUDE_IMPLEMENT_TIMEOUT_MS } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import {
  IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS,
  evaluateAndPersistImplementTimeoutSensors,
  evaluateImplementTimeoutSensors,
  implementTimeoutSensorEntityId,
  percentile,
} from './implementTimeoutSensor'

/**
 * 暫定 timeout（900s）を実データで再評価するためのセンサー（CEO 指示・2026-09-18）。
 *
 * ここで固定したいのは 5 点である。
 * 1. A/B/C の 3 条件がそれぞれ正しく発火する
 * 2. **旧 300s 時代の timeout 記録で A が発火しない**（新しい値の評価にならないため）
 * 3. 同じ理由で **2 度目は発火しない**（毎 tick 同じ候補を出さない）
 * 4. timeout 値を変えたら B/C は**もう一度だけ**発火する
 * 5. センサーは timeout 値も Job も**書き換えない**
 */

const BASE = new Date('2026-09-18T00:00:00.000Z').getTime()

function job(overrides: Partial<Job> & { seconds?: number }): Job {
  const { seconds = 60, ...rest } = overrides
  const started = new Date(BASE).toISOString()
  const completed = new Date(BASE + seconds * 1000).toISOString()
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
    completedAt: completed,
    aiCliProvider: 'claude_code',
    aiCliMode: 'implement',
    changedFiles: [],
    ...rest,
  } as Job
}

/** 現在の budget を使い切ったうえで作業中だった Job（= A の対象）。 */
function killedWhileWorking(seconds: number): Job {
  return job({
    seconds,
    status: 'failed',
    changedFiles: ['apps/api/src/pl/executionLoop.ts'],
    failureMetadata: { kind: 'provider_timeout' },
  } as Partial<Job>)
}

describe('evaluateImplementTimeoutSensors', () => {
  const T = CLAUDE_IMPLEMENT_TIMEOUT_MS

  it('サンプルが無ければ何も出さない', () => {
    expect(evaluateImplementTimeoutSensors([], T)).toEqual([])
  })

  // ── A ────────────────────────────────────────────────────────
  it('A: 現在の budget を使い切って作業中だった Job は 1 件でも発火する', () => {
    const findings = evaluateImplementTimeoutSensors([killedWhileWorking(900)], T)
    const a = findings.filter((f) => f.sensorId === 'implement-timeout-still-kills-working-jobs')
    expect(a).toHaveLength(1)
    expect(a[0].evidence).toMatchObject({ durationSeconds: 900, timeoutSeconds: 900 })
  })

  // **これが一番効くテスト。** 過去の 300s 時代の記録で発火すると、
  // 新しい値の評価ではなく歴史の再掲になってしまう。
  it('A: 旧 300s 時代の timeout 記録では発火しない', () => {
    const findings = evaluateImplementTimeoutSensors([killedWhileWorking(304)], T)
    expect(findings.filter((f) => f.sensorId === 'implement-timeout-still-kills-working-jobs'))
      .toHaveLength(0)
  })

  it('A: timeout でも changedFiles が無ければ発火しない（作業中ではない）', () => {
    const noWork = job({
      seconds: 900,
      status: 'failed',
      changedFiles: [],
      failureMetadata: { kind: 'provider_timeout' },
    } as Partial<Job>)
    expect(evaluateImplementTimeoutSensors([noWork], T)
      .filter((f) => f.sensorId === 'implement-timeout-still-kills-working-jobs')).toHaveLength(0)
  })

  // ── B ────────────────────────────────────────────────────────
  it('B: timeout 率が 3% 以上なら発火する', () => {
    // 50 件中 2 件 = 4%
    const jobs = [
      killedWhileWorking(900), killedWhileWorking(900),
      ...Array.from({ length: 48 }, () => job({ seconds: 60 })),
    ]
    const b = evaluateImplementTimeoutSensors(jobs, T)
      .filter((f) => f.sensorId === 'implement-timeout-rate-too-high')
    expect(b).toHaveLength(1)
    expect(b[0].evidence).toMatchObject({ windowSize: 50, timeoutCount: 2 })
  })

  it('B: timeout 率が 3% 未満なら発火しない', () => {
    // 50 件中 1 件 = 2%
    const jobs = [
      killedWhileWorking(900),
      ...Array.from({ length: 49 }, () => job({ seconds: 60 })),
    ]
    expect(evaluateImplementTimeoutSensors(jobs, T)
      .filter((f) => f.sensorId === 'implement-timeout-rate-too-high')).toHaveLength(0)
  })

  // ── C ────────────────────────────────────────────────────────
  it('C: 成功 p95 が timeout の 60% 以上なら発火する', () => {
    // 25 件すべて 600s（= 900s の 66%）
    const jobs = Array.from({ length: 25 }, () => job({ seconds: 600 }))
    const c = evaluateImplementTimeoutSensors(jobs, T)
      .filter((f) => f.sensorId === 'implement-p95-approaching-timeout')
    expect(c).toHaveLength(1)
    expect(c[0].evidence).toMatchObject({ successSamples: 25, p95Seconds: 600 })
  })

  // **サンプル不足で p95 を口にしない。** 数字を作らないための条件（CEO 指示）。
  it('C: 成功サンプルが 20 件未満なら p95 を判定しない', () => {
    const jobs = Array.from({ length: 19 }, () => job({ seconds: 600 }))
    expect(evaluateImplementTimeoutSensors(jobs, T)
      .filter((f) => f.sensorId === 'implement-p95-approaching-timeout')).toHaveLength(0)
  })

  it('C: p95 が 60% 未満なら発火しない', () => {
    const jobs = Array.from({ length: 25 }, () => job({ seconds: 200 }))
    expect(evaluateImplementTimeoutSensors(jobs, T)
      .filter((f) => f.sensorId === 'implement-p95-approaching-timeout')).toHaveLength(0)
  })

  it('直近 WINDOW 件だけを母集団にする', () => {
    const jobs = [
      ...Array.from({ length: IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS.WINDOW }, () => job({ seconds: 60 })),
      killedWhileWorking(900),  // WINDOW の外
    ]
    expect(evaluateImplementTimeoutSensors(jobs, T)
      .filter((f) => f.sensorId === 'implement-timeout-still-kills-working-jobs')).toHaveLength(0)
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

  function createTimedOutJob(storage: IStorage, taskId: string, seconds: number): void {
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
    const started = new Date(BASE).toISOString()
    storage.jobs.update(created.id, {
      status: 'failed',
      startedAt: started,
      completedAt: new Date(BASE + seconds * 1000).toISOString(),
      changedFiles: ['apps/api/src/pl/executionLoop.ts'],
      failureMetadata: { kind: 'provider_timeout' },
    } as never)
  }

  it('発火を audit_log へ残し、2 度目は残さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seed(storage)
    createTimedOutJob(storage, taskId, 900)

    const first = evaluateAndPersistImplementTimeoutSensors(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS)
    expect(first.filter((f) => f.sensorId === 'implement-timeout-still-kills-working-jobs')).toHaveLength(1)

    // 同じ tick が何度回っても、同じ候補を作り直さない。
    const second = evaluateAndPersistImplementTimeoutSensors(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS)
    expect(second.filter((f) => f.sensorId === 'implement-timeout-still-kills-working-jobs')).toHaveLength(0)
  })

  it('timeout 値を変えると B はもう一度だけ発火する', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seed(storage)
    createTimedOutJob(storage, taskId, 900)

    const first = evaluateAndPersistImplementTimeoutSensors(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS)
    expect(first.some((f) => f.sensorId === 'implement-timeout-rate-too-high')).toBe(true)

    const again = evaluateAndPersistImplementTimeoutSensors(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS)
    expect(again.some((f) => f.sensorId === 'implement-timeout-rate-too-high')).toBe(false)

    const afterChange = evaluateAndPersistImplementTimeoutSensors(storage, 1_200_000)
    expect(afterChange.some((f) => f.sensorId === 'implement-timeout-rate-too-high')).toBe(true)
  })

  // **「直近 N 件」は作成順ではなく結果が出た順。**
  // production には 7〜20 日 queued のままの Job が実在するので、作成順で窓を切ると、
  // 「長く積まれてから今日走って落ちた Job」が窓の外に落ちて A が発火しない（独立レビュー指摘）。
  it('古く作られて今日終わった Job も窓に入る', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seed(storage)

    // 先に「今日終わった、ずっと前に作られた」Job を 1 件作る。
    const old = storage.jobs.create({
      taskId,
      projectId: storage.tasks.findById(taskId)!.projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
      aiCliProvider: 'claude_code',
      aiCliMode: 'implement',
    } as never)
    storage.jobs.update(old.id, {
      status: 'failed',
      startedAt: new Date(BASE).toISOString(),
      completedAt: new Date(BASE + 900 * 1000).toISOString(),
      changedFiles: ['apps/api/src/pl/executionLoop.ts'],
      failureMetadata: { kind: 'provider_timeout' },
    } as never)

    // そのあとに WINDOW 件ぶん、**より新しく作られた**が
    // **より前に終わった** Job を積む。作成順なら古い方が押し出される。
    for (let i = 0; i < IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS.WINDOW; i++) {
      const newer = storage.jobs.create({
        taskId,
        projectId: storage.tasks.findById(taskId)!.projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
        dryRun: false,
        aiCliProvider: 'claude_code',
        aiCliMode: 'implement',
      } as never)
      storage.jobs.update(newer.id, {
        status: 'success',
        startedAt: new Date(BASE - 86_400_000).toISOString(),
        completedAt: new Date(BASE - 86_400_000 + 60_000).toISOString(),
      } as never)
    }

    const fired = evaluateAndPersistImplementTimeoutSensors(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS)
    expect(fired.some((f) => f.sensorId === 'implement-timeout-still-kills-working-jobs')).toBe(true)
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
    createTimedOutJob(storage, taskId, 900)
    const before = storage.jobs.findByTaskId(taskId).map((j) => ({ ...j }))

    evaluateAndPersistImplementTimeoutSensors(storage, CLAUDE_IMPLEMENT_TIMEOUT_MS)

    expect(storage.jobs.findByTaskId(taskId)).toEqual(before)
  })
})
