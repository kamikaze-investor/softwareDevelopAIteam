/**
 * Lifecycle E2E — C1: Candidate promotion 待ち。
 *
 * Safety Evidence path（人間承認なし）で commit された Task は Tier A Candidate（`candidate/self-dev`）の
 * 完了であり、canonical master への promotion を待つ。PL はそれを follow-up として採用し直さず、
 * すべての planned 項目が promotion 待ちになったら `awaiting_promotion` を 1 回だけ audit に残す。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/targetWorkingDir', async () => {
  const { LIFECYCLE_TARGET_DIR } = await import('./runnerStub.js')
  return { TARGET_WORKING_DIR: LIFECYCLE_TARGET_DIR }
})
vi.mock('../designReview/designReviewCoordinator', async (importOriginal) => {
  const { stubCoordinatorDeps } = await import('./runnerStub.js')
  return {
    ...(await importOriginal<typeof import('../designReview/designReviewCoordinator')>()),
    buildDefaultCoordinatorDeps: stubCoordinatorDeps,
  }
})

import { buildLedger, createRunningProject, removeTargetRepo, startLifecycle, type LifecycleEnv } from './harness'
import { resetDesignReviewStub } from './runnerStub'

vi.setConfig({ testTimeout: 240_000 })

let env: LifecycleEnv

beforeEach(() => {
  resetDesignReviewStub()
})
afterEach(async () => {
  await env?.close()
})
afterAll(() => {
  removeTargetRepo()
})

describe('C1: completed Candidate Tasks awaiting promotion are not re-adopted; awaiting_promotion is audited once', () => {
  it.each([
    { label: 'one planned item', items: [{ id: 'c1-only', title: 'Only item' }] },
    { label: 'two planned items', items: [{ id: 'c1-first', title: 'First item' }, { id: 'c1-second', title: 'Second item' }] },
  ])('$label', async ({ items }) => {
    // Start: running Project; every planned item is adopted and committed on the Safety Evidence path.
    env = await startLifecycle({ ledger: buildLedger(items) })
    const project = createRunningProject(env)
    env.adoptionAllowedPaths = ['docs/c1']
    for (const item of items) {
      const task = await env.adoptNext(project.id, item.id)
      const steps = await env.worker.runUntilIdle()
      expect(steps.at(-1)).toMatchObject({ kind: 'git_commit', reported: 'success' })
      expect(env.task(task.id).status).toBe('done')
    }

    // Operation: PL ticks while every planned item awaits promotion. The proposer would pick a done item if offered.
    env.adoptionPreference = items.map((item) => item.id)
    let proposals = 0
    const proposeAdoption = async () => {
      proposals += 1
      return JSON.stringify({
        roadmapId: items[0]!.id, implementationScope: 'more', allowedPaths: ['docs/c1'],
        acceptanceCriteria: ['x'], rationale: 'r',
      })
    }
    const ticks = []
    for (let i = 0; i < 3; i += 1) ticks.push(await env.plTick({ proposeAdoption }))

    // Expected: no adoption (idle), no proposal requested, no new Task, and exactly one awaiting_promotion row.
    expect(ticks.map((tick) => tick.status)).toEqual(['idle', 'idle', 'idle'])
    expect(proposals).toBe(0)
    expect(env.storage.tasks.findByProjectId(project.id)).toHaveLength(items.length)
    const adoptRows = env.storage.auditLog.findByEntity('pl_loop_target', `adopt:${project.id}`)
    expect(adoptRows.filter((row) => (row.detail ?? '').startsWith('adoption=no_candidate code=awaiting_promotion'))).toHaveLength(1)
    // Each Candidate completion is itself recorded once as awaiting promotion.
    const completions = env.storage.auditLog.findAll().filter((row) => row.operation === 'roadmap_completion_awaiting_promotion')
    expect(completions).toHaveLength(items.length)
    expect(env.escalations).toEqual([])
    expect((await env.systemState()).attention).toEqual([])
  })
})
