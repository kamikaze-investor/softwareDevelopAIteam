import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Task } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildInitialImplementAiCliPrompt } from './initialImplementWorkflow'
import { recoverReadyTasksWithoutJob } from './projectInitialization'

/**
 * **U7 — adopt 済みなのに初回 Job だけ無い Task を、既存 reconcile から復旧する。**
 *
 * `adoptRoadmapItem()` は Task 行を同期 transaction で commit したあと、初回 Job の生成を
 * `await` で HTTP request のプロセス内に持つ（間に最大 300s の Design Review が入る）。
 * その窓で API が落ちると、残る durable state —— pending / roadmapActive / Job 0 件 /
 * ALIGNED evidence —— は**それ自体は完全に正しい**のに、それを見て動く actor が居ない。
 *
 * ここで固定する本質は2つ:
 *   1. その状態が既存 poll から**自動で復旧する**
 *   2. 復旧時に **Design Review を再実行しない**（CONFLICT Task を毎 poll で回す loop を作らない）
 */

/** Design Review runner の起動回数を数える deps。U7 復旧では 0 のままでなければならない。 */
function countingDeps(): { deps: Record<string, unknown>; spawns: () => number } {
  let spawns = 0
  return {
    spawns: () => spawns,
    deps: {
      runnerCommand: 'node',
      runnerArgs: [],
      homeDirectory: '/tmp',
      workingDir: '/tmp',
      execute: async () => {
        spawns += 1
        return {
          ok: true,
          timedOut: false,
          stdout: JSON.stringify({
            focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED' }],
            integrationReviewResult: { decision: 'ALIGNED' },
          }),
        }
      },
    },
  }
}

function seedProject(storage: IStorage, status: 'running' | 'paused' = 'running'): string {
  return storage.projects.create({
    name: 'P', goal: 'G', designPhilosophy: [], status,
  }).id
}

function seedAdoptedTask(storage: IStorage, projectId: string): Task {
  return storage.tasks.create({
    projectId,
    title: 'T',
    description: 'Implement T.',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: true,
  } as Parameters<IStorage['tasks']['create']>[0])
}

/** その Task の **現行 prompt に一致する** ALIGNED evidence を置く（= Job Gate 成立）。 */
function seedAlignedEvidence(storage: IStorage, task: Task): void {
  storage.designReviewEvidence.create({
    taskId: task.id,
    designTextHash: computeDesignTextHash(buildInitialImplementAiCliPrompt(task)),
    reviewLoad: 'low',
    decision: 'ALIGNED',
    independentReviewRequired: false,
  } as Parameters<IStorage['designReviewEvidence']['create']>[0])
}

/** U7 の failure window そのもの: adopt 済み / Gate 成立 / Job 0 件。 */
function seedU7State(storage: IStorage): { projectId: string; task: Task } {
  const projectId = seedProject(storage)
  const task = seedAdoptedTask(storage, projectId)
  seedAlignedEvidence(storage, task)
  expect(storage.jobs.findByTaskId(task.id)).toHaveLength(0)
  return { projectId, task }
}

describe('U7: adopt 済みで Job が無い Task の復旧', () => {
  it('T1: ALIGNED evidence があり Job 0 件の Task に、初回 Job が1件作られる', async () => {
    const storage = createSQLiteStorage(':memory:')
    const { task } = seedU7State(storage)
    const { deps } = countingDeps()

    const summary = await recoverReadyTasksWithoutJob(storage, deps as never)

    expect(summary).toMatchObject({ scanned: 1, recovered: 1, skipped: 0 })
    const jobs = storage.jobs.findByTaskId(task.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].workflowStepKey).toBe(`task:${task.id}:initial-implement`)
    expect(jobs[0].status).toBe('queued')
  })

  it('T2: その復旧で Design Review runner は一度も起動されない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const { task } = seedU7State(storage)
    const { deps, spawns } = countingDeps()

    await recoverReadyTasksWithoutJob(storage, deps as never)

    // 既存 evidence を再利用するので review は回らない。ここが CONFLICT loop を防ぐ核心。
    expect(spawns()).toBe(0)
    expect(storage.jobs.findByTaskId(task.id)).toHaveLength(1)
  })

  it('T3: すでに Job がある Task には何もしない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const { projectId, task } = seedU7State(storage)
    const existing = storage.jobs.create({
      taskId: task.id,
      projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      workflowStepKey: `task:${task.id}:initial-implement`,
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      aiCliMode: 'implement',
      aiCliProvider: 'claude_code',
      aiCliPrompt: buildInitialImplementAiCliPrompt(task),
    } as never)
    const { deps, spawns } = countingDeps()

    const summary = await recoverReadyTasksWithoutJob(storage, deps as never)

    expect(summary).toMatchObject({ scanned: 0, recovered: 0 })
    expect(spawns()).toBe(0)
    expect(storage.jobs.findByTaskId(task.id).map((j) => j.id)).toEqual([existing.id])
  })

  it('T4: CONFLICT evidence では executor を起動せず、Design Review も再実行しない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const projectId = seedProject(storage)
    const task = seedAdoptedTask(storage, projectId)
    storage.designReviewEvidence.create({
      taskId: task.id,
      designTextHash: computeDesignTextHash(buildInitialImplementAiCliPrompt(task)),
      reviewLoad: 'low',
      decision: 'CONFLICT',
      independentReviewRequired: false,
    } as Parameters<IStorage['designReviewEvidence']['create']>[0])
    const { deps, spawns } = countingDeps()

    const summary = await recoverReadyTasksWithoutJob(storage, deps as never)

    // CONFLICT の復旧は independent remediation の責務。ここが横取りしない。
    expect(summary).toMatchObject({ scanned: 0, recovered: 0 })
    expect(spawns()).toBe(0)
    expect(storage.jobs.findByTaskId(task.id)).toHaveLength(0)
  })

  it('T4b: evidence が1件も無い Task でも Design Review を起動しない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const projectId = seedProject(storage)
    const task = seedAdoptedTask(storage, projectId)
    const { deps, spawns } = countingDeps()

    const summary = await recoverReadyTasksWithoutJob(storage, deps as never)

    expect(summary).toMatchObject({ scanned: 0, recovered: 0 })
    expect(spawns()).toBe(0)
    expect(storage.jobs.findByTaskId(task.id)).toHaveLength(0)
  })

  it('T5: 現行 prompt と一致しない古い ALIGNED evidence だけなら Job を作らない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const projectId = seedProject(storage)
    const task = seedAdoptedTask(storage, projectId)
    storage.designReviewEvidence.create({
      taskId: task.id,
      designTextHash: computeDesignTextHash('an older design text that no longer matches'),
      reviewLoad: 'low',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    } as Parameters<IStorage['designReviewEvidence']['create']>[0])
    const { deps, spawns } = countingDeps()

    const summary = await recoverReadyTasksWithoutJob(storage, deps as never)

    expect(summary).toMatchObject({ scanned: 0, recovered: 0 })
    expect(spawns()).toBe(0)
    expect(storage.jobs.findByTaskId(task.id)).toHaveLength(0)
  })

  it('T6: 同じ reconcile を繰り返しても Job は1件だけ（次 poll は no-op）', async () => {
    const storage = createSQLiteStorage(':memory:')
    const { task } = seedU7State(storage)
    const { deps, spawns } = countingDeps()

    const first = await recoverReadyTasksWithoutJob(storage, deps as never)
    const second = await recoverReadyTasksWithoutJob(storage, deps as never)
    const third = await recoverReadyTasksWithoutJob(storage, deps as never)

    expect(first).toMatchObject({ recovered: 1 })
    expect(second).toMatchObject({ scanned: 0, recovered: 0 })
    expect(third).toMatchObject({ scanned: 0, recovered: 0 })
    expect(storage.jobs.findByTaskId(task.id)).toHaveLength(1)
    expect(spawns()).toBe(0)
  })

  it('T7: restart 相当（DB を開き直した別 instance）でも durable state だけで復旧できる', async () => {
    const dbPath = path.join(os.tmpdir(), `u7-recovery-${randomUUID()}.db`)

    const before = createSQLiteStorage(dbPath)
    const { task } = seedU7State(before)

    // ここから先は「再起動後のプロセス」。上の storage も deps も参照しない。
    const after = createSQLiteStorage(dbPath)
    const { deps, spawns } = countingDeps()

    const summary = await recoverReadyTasksWithoutJob(after, deps as never)

    expect(summary).toMatchObject({ recovered: 1 })
    expect(spawns()).toBe(0)
    expect(after.jobs.findByTaskId(task.id)).toHaveLength(1)
  })

  it('running でない Project は sweep で突破しない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const projectId = seedProject(storage, 'paused')
    const task = seedAdoptedTask(storage, projectId)
    seedAlignedEvidence(storage, task)
    const { deps, spawns } = countingDeps()

    const summary = await recoverReadyTasksWithoutJob(storage, deps as never)

    expect(summary).toMatchObject({ scanned: 0, recovered: 0 })
    expect(spawns()).toBe(0)
    expect(storage.jobs.findByTaskId(task.id)).toHaveLength(0)
  })

  it('done / 非 roadmapActive な Task は対象にしない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const projectId = seedProject(storage)

    const done = seedAdoptedTask(storage, projectId)
    seedAlignedEvidence(storage, done)
    storage.tasks.update(done.id, { status: 'done' } as never)

    const inactive = seedAdoptedTask(storage, projectId)
    seedAlignedEvidence(storage, inactive)
    storage.tasks.update(inactive.id, { roadmapActive: false } as never)

    const { deps, spawns } = countingDeps()
    const summary = await recoverReadyTasksWithoutJob(storage, deps as never)

    expect(summary).toMatchObject({ scanned: 0, recovered: 0 })
    expect(spawns()).toBe(0)
    expect(storage.jobs.findByTaskId(done.id)).toHaveLength(0)
    expect(storage.jobs.findByTaskId(inactive.id)).toHaveLength(0)
  })

  it('依存が未完了の Task には Job を作らない（sweep 経路で直接固定する）', async () => {
    // admission（`canRecoverInitialImplementJobWithoutReview`）は依存を見ない。見ているのは
    // executor 側（`initialImplementWorkflow.ts` の dependencies guard）である。つまりこの
    // ケースだけは **admission を通ってから executor が skip する**ので、他の除外ケースと
    // 違って `scanned` が 1 になる。
    //
    // 依存 guard が executor 内にあること自体は既存 test が固定しているが、それは
    // 「executor を呼べば守られる」ことしか言わない。sweep が将来 executor を迂回して
    // 自前で Job を作るように変わったら、その保護は消える。**sweep 経路から見て依存が
    // 効いていること**をここで直接固定する。
    const storage = createSQLiteStorage(':memory:')
    const projectId = seedProject(storage)

    const blocker = seedAdoptedTask(storage, projectId)
    const dependent = storage.tasks.create({
      projectId,
      title: 'T-dependent',
      description: 'Implement T.',
      status: 'pending',
      assignee: 'developer_ai',
      dependencies: [blocker.id],
      roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    // 依存以外の条件はすべて満たしておく（除外理由を依存1つに絞るため）。
    seedAlignedEvidence(storage, dependent)

    const { deps, spawns } = countingDeps()
    const summary = await recoverReadyTasksWithoutJob(storage, deps as never)

    // admission は通る（scanned=1）が、executor が依存未達で skip する。
    expect(summary).toMatchObject({ scanned: 1, recovered: 0, skipped: 1 })
    expect(spawns()).toBe(0)
    expect(storage.jobs.findByTaskId(dependent.id)).toHaveLength(0)

    // 依存が done になれば同じ sweep で復旧する（除外理由が依存だったことの裏取り）。
    storage.tasks.update(blocker.id, { status: 'done' } as never)
    const after = await recoverReadyTasksWithoutJob(storage, deps as never)

    expect(after.recovered).toBeGreaterThanOrEqual(1)
    expect(spawns()).toBe(0)
    expect(storage.jobs.findByTaskId(dependent.id)).toHaveLength(1)
  })
})
