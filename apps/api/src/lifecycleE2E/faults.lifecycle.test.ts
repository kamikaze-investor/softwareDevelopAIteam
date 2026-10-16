/**
 * Lifecycle E2E — Faults（F1 重複報告 / claim 拒否、F2 Technical Abort cleanup の STORAGE_BUSY、
 * F3 quarantine、F4 paused Project の所有者）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
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

import type { Job, JobWorkspaceBaseline } from '@ai-team/shared'
import {
  buildLedger,
  changesRequested,
  claimBody,
  createRunningProject,
  headCommit,
  removeTargetRepo,
  startLifecycle,
  type LifecycleEnv,
} from './harness'
import { resetDesignReviewStub } from './runnerStub'

vi.setConfig({ testTimeout: 240_000 })

let env: LifecycleEnv
let sandbox: string | undefined

beforeEach(() => {
  resetDesignReviewStub()
})
afterEach(async () => {
  await env?.close()
  // Windows keeps the SQLite file locked by the storage singleton; leave the temp dir if it cannot be removed.
  try {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // best-effort cleanup of a temp directory
  }
  sandbox = undefined
})
afterAll(() => {
  removeTargetRepo()
})

async function pauseProject(projectId: string): Promise<void> {
  const res = await env.api('PATCH', `/api/projects/${projectId}`, { status: 'paused' })
  expect(res.statusCode).toBe(200)
}

async function resumeProject(projectId: string): Promise<void> {
  const res = await env.api('PATCH', `/api/projects/${projectId}`, { status: 'running' })
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200)
}

const F1_CASES = [
  { label: 'implement success', duplicate: 'implement' as const },
  { label: 'review changes_requested', duplicate: 'review' as const },
]

/** F1 の開始状態: 採用済み Task の implement（と任意で review）を Worker が実行し終えたところ。 */
async function f1Start(duplicate: 'implement' | 'review') {
  env = await startLifecycle({ ledger: buildLedger([{ id: 'f1', title: 'Fault scenario F1' }]) })
  const project = createRunningProject(env)
  env.adoptionAllowedPaths = ['docs/f1']
  env.worker.behaviors.review = () => changesRequested('tighten the wording')
  const task = await env.adoptNext(project.id, 'f1')
  expect(await env.worker.pollOnce()).toMatchObject({ kind: 'implement', reported: 'success' })
  if (duplicate === 'review') {
    expect(await env.worker.pollOnce()).toMatchObject({ kind: 'review', reported: 'failed' })
  }
  return { project, task }
}

describe('F1: duplicate result delivery (same Outbox eventId) is idempotent', () => {
  /**
   * DEFECT D3（Outbox の再送が write-once 検査で 409 になる）。
   *
   * Expected: 同じ eventId / payloadHash の terminal 結果の再送は 200 + `outbox.deduplicated: true`
   *           で、状態も successor も変わらない（at-least-once）。
   * Actual:   409 `workspaceEndFingerprint is write-once and has already been recorded`。
   *           `routes/jobs.ts` の PATCH handler が `failureMetadata.workspaceEndFingerprint` の write-once 検査を
   *           **Outbox の重複判定（`buildOutboxEvent()` → storage の `checkOutboxEvent()`）より前**に行うため。
   *           Worker の terminal 結果は claim 後なら必ず fingerprint を持つ（`persistJobResult()`）ので、
   *           応答が失われた後の再送・git_commit の 503（continuation pending）後の再送はすべて 409 になり、
   *           Worker は Outbox に残し続け（`patchJobWithRetry()` は 409 を JOB_CLAIM_REFUSED 以外 retry 扱い）、
   *           `pollJobs()` は Outbox pending の間 **全 Project の queued Job 取得を止める**。
   */
  for (const { label, duplicate } of F1_CASES) {
    it.fails(`DEFECT D3 ${label}: the re-delivered event is deduplicated (200) and changes nothing`, async () => {
      const { task } = await f1Start(duplicate)
      const jobsBefore = env.jobsOf(task.id).map((job) => [job.id, job.status])
      const runsBefore = env.storage.designReviewRuns.findByTaskId(task.id).length

      // Operation: the Worker's Outbox re-delivers the same terminal event (same eventId + payloadHash).
      const replay = env.worker.lastDelivery!
      const res = await env.api<{ outbox?: { deduplicated: boolean } }>('PATCH', `/api/jobs/${replay.jobId}`, replay.payload, 'worker')

      // Expected: 200 + deduplicated, no new successor Job / repair run.
      expect(res.statusCode).toBe(200)
      expect(res.body.outbox?.deduplicated).toBe(true)
      await env.quiesce()
      expect(env.jobsOf(task.id).map((job) => [job.id, job.status])).toEqual(jobsBefore)
      expect(env.storage.designReviewRuns.findByTaskId(task.id)).toHaveLength(runsBefore)
    })
  }

  it.each(F1_CASES)('$label: a re-delivery never applies twice (no second successor, no second repair run)', async ({ duplicate }) => {
    // Weaker, currently-true invariant (independent of D3): whatever the status code, a replay does not
    // create a second review / repair run, and a different body under the same eventId is refused.
    const { task } = await f1Start(duplicate)
    const jobsBefore = env.jobsOf(task.id).map((job) => [job.id, job.status])
    const runsBefore = env.storage.designReviewRuns.findByTaskId(task.id).length
    const replay = env.worker.lastDelivery!
    await env.api('PATCH', `/api/jobs/${replay.jobId}`, replay.payload, 'worker')
    await env.quiesce()
    expect(env.jobsOf(task.id).map((job) => [job.id, job.status])).toEqual(jobsBefore)
    expect(env.storage.designReviewRuns.findByTaskId(task.id)).toHaveLength(runsBefore)
    const tampered = { ...replay.payload, stdout: 'different' }
    expect((await env.api('PATCH', `/api/jobs/${replay.jobId}`, tampered, 'worker')).statusCode).toBe(409)
  })
})

describe('F1: a claim refused because the Project was paused leaves the Job queued until the Project resumes', () => {
  it.each(F1_CASES)('next Job after $label', async ({ duplicate }) => {
    // Start: implement (and optionally review) done; the next Job is queued.
    const { project } = await f1Start(duplicate)

    // Operation 1: the next queued Job is polled while running, then the CEO pauses the Project before the claim.
    const work = await env.worker.findQueuedWork()
    expect(work).not.toBeNull()
    const next = work!.job
    await pauseProject(project.id)
    const claim = await env.api<{ code?: string }>('PATCH', `/api/jobs/${next.id}`, claimBody(next), 'worker')

    // Expected: 409 JOB_CLAIM_REFUSED, the Job stays queued; a re-sent claim is refused again (not recorded as applied).
    expect(claim.statusCode).toBe(409)
    expect(claim.body.code).toBe('JOB_CLAIM_REFUSED')
    expect(env.storage.jobs.findById(next.id)?.status).toBe('queued')
    expect((await env.api('PATCH', `/api/jobs/${next.id}`, claimBody(next), 'worker')).statusCode).toBe(409)
    // A paused Project's queued Job is not picked up by the poll at all.
    expect(await env.worker.pollOnce()).toBeNull()

    // Operation 2: CEO resumes the Project. Expected: the same Job is claimed and runs.
    await resumeProject(project.id)
    const step = await env.worker.pollOnce()
    expect(step).toMatchObject({ jobId: next.id, claimStatus: 200 })
    expect(env.storage.jobs.findById(next.id)?.status).not.toBe('queued')
  })
})


describe('F3: quarantine → workspace_quarantined attention → one CEO escalation → another Project can still adopt', () => {
  it.each([
    { label: 'containment drain failure', reason: 'cgroup drain did not complete' },
    { label: 'reconciliation marker left', reason: 'MERGE_HEAD present after the Job' },
  ])('$label', async ({ reason }) => {
    // Start: Project A adopts a Task; its implement Job ends quarantined (workspace not provably quiescent).
    env = await startLifecycle({ ledger: buildLedger([{ id: 'f3-a', title: 'Quarantined item' }, { id: 'f3-b', title: 'Other project item' }]) })
    const projectA = createRunningProject(env, 'A')
    env.adoptionAllowedPaths = ['docs/f3a']
    env.worker.behaviors.implement = () => ({ kind: 'quarantine', reason })
    const taskA = await env.adoptNext(projectA.id, 'f3-a')
    expect(await env.worker.pollOnce()).toMatchObject({ kind: 'implement', reported: 'blocked' })
    const quarantined = env.jobsOf(taskA.id)[0]!
    expect(quarantined.failureMetadata).toMatchObject({ quarantined: true })
    expect((await env.systemState()).attention.map((item) => item.kind)).toContain('workspace_quarantined')
    // Resume refuses a quarantined workspace, and Mobile agrees.
    expect((await env.mobileAdmission(taskA.id)).resume).toEqual({ ok: false, code: 'WORKSPACE_QUARANTINED' })
    expect((await env.ceo.resume(taskA.id)).body.code).toBe('WORKSPACE_QUARANTINED')

    // Operation 1: CEO pauses A and starts Project B (only one running Project is allowed).
    await pauseProject(projectA.id)
    const projectB = createRunningProject(env, 'B')

    // Operation 2: PL tick. Expected: the quarantine is escalated exactly once (notify-only, nothing executed).
    const first = await env.plTick()
    expect(first).toMatchObject({ status: 'escalated', target: { kind: 'workspace_quarantined' } })
    expect(env.escalations).toHaveLength(1)

    // Operation 3: next PL tick. Expected: the escalated quarantine does not block adoption in Project B.
    env.adoptionAllowedPaths = ['docs/f3b']
    const taskB = await env.adoptNext(projectB.id, 'f3-b')
    expect(env.jobsOf(taskB.id).map((job) => job.status)).toEqual(['queued'])
    // The quarantine is not cleared by anyone but the observation path, and is not escalated again.
    await env.plTick()
    expect(env.escalations.filter((e) => e.title.includes('workspace_quarantined') || e.body.includes(quarantined.id)).length)
      .toBeLessThanOrEqual(1)
    expect(env.storage.jobs.findById(quarantined.id)?.failureMetadata?.quarantined).toBe(true)
    // The Worker still refuses to claim B while the quarantined owner holds the workspace.
    expect(await env.worker.pollOnce()).toBeNull()
    expect(env.jobsOf(taskB.id)[0]!.status).toBe('queued')
  })
})

describe('F4: a paused Project owner holds the workspace → claim refused → workspace_held_by_stalled_owner → escalated once', () => {
  it.each([
    { label: 'owner has a queued review', ownerStep: 'review' as const },
    { label: 'owner has a queued git_commit', ownerStep: 'git_commit' as const },
  ])('$label', async ({ ownerStep }) => {
    // Start: Project A's Task is mid-flight (a queued non-initial Job owns the workspace).
    env = await startLifecycle({ ledger: buildLedger([{ id: 'f4-a', title: 'Owner item' }, { id: 'f4-b', title: 'Waiting item' }]) })
    const projectA = createRunningProject(env, 'A')
    env.adoptionAllowedPaths = ['docs/f4a']
    const taskA = await env.adoptNext(projectA.id, 'f4-a')
    await env.worker.pollOnce() // implement
    if (ownerStep === 'git_commit') await env.worker.pollOnce() // review → git_commit queued
    const owner = env.jobsOf(taskA.id).find((job) => job.status === 'queued')!
    expect(owner.aiCliMode === 'review' || owner.safeCommand.kind === 'git_commit').toBe(true)

    // Operation 1: CEO pauses A; Project B starts and PL adopts its item.
    await pauseProject(projectA.id)
    const projectB = createRunningProject(env, 'B')
    env.adoptionAllowedPaths = ['docs/f4b']
    const taskB = await env.adoptNext(projectB.id, 'f4-b')
    const bJob = env.jobsOf(taskB.id)[0]!
    expect(bJob.status).toBe('queued')

    // Operation 2: Worker poll and a direct claim attempt (a claim racing the ownership snapshot).
    // Expected: poll claims nothing; the claim is refused with JOB_CLAIM_REFUSED; B's Job stays queued.
    expect(await env.worker.pollOnce()).toBeNull()
    const claim = await env.api<{ code?: string }>('PATCH', `/api/jobs/${bJob.id}`, {
      // A racing claim: the Worker would not reach this (its own ownership check refuses first), so the body is
      // a schema-valid clean baseline; the API claim guard is what is under test.
      status: 'running', startedAt: new Date().toISOString(), workspaceBaseline: { mode: 'clean', startCommitHash: headCommit() },
    }, 'worker')
    expect(claim.statusCode).toBe(409)
    expect(claim.body.code).toBe('JOB_CLAIM_REFUSED')
    expect(env.storage.jobs.findById(bJob.id)?.status).toBe('queued')

    // Expected: the stop is visible as workspace_held_by_stalled_owner naming the paused owner.
    const held = (await env.systemState()).attention.filter((item) => item.kind === 'workspace_held_by_stalled_owner')
    expect(held.length).toBeGreaterThan(0)
    expect(held.some((item) => item.taskId === taskA.id || (item.detail ?? '').includes(taskA.id))).toBe(true)

    // Operation 3: PL ticks. Expected: escalated exactly once.
    const before = env.escalations.length
    await env.plTick()
    await env.plTick()
    await env.plTick()
    expect(env.escalations.length - before).toBe(1)
    expect(env.storage.jobs.findById(owner.id)?.status).toBe('queued')
  })
})

describe('F2: Technical Abort cleanup report under STORAGE_BUSY, and a generation mismatch', () => {
  const KNOWN_GOOD = {
    gitOperationMarkers: [] as string[], worktreeClean: true, indexClean: true, headValid: true, blindSpotsAbsent: true,
  }
  const TECHNICAL_LEDGER = buildLedger([{ id: 'technical-item', title: 'Technical item' }])

  /**
   * carrier（protected path の Guard 違反で blocked になった Job）は storage へ直接 seed し、
   * Technical Abort の要求は PL が使う `requestTechnicalAbort()` を直接呼ぶ（simulation）。
   * Worker の報告から先（route・BEGIN IMMEDIATE・別 connection の lock）は本物。
   */
  async function seedTechnicalAbort() {
    const { buildSystemState } = await import('../state/systemState.js')
    const { requestTechnicalAbort } = await import('../pl/abortTask.js')
    const storage = env.storage
    const project = createRunningProject(env)
    const task = storage.tasks.create({
      projectId: project.id, title: 'Technical item', description: 'protected runtime work', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true, roadmapTaskKey: 'technical-item',
      allowedPaths: ['apps/worker/src/index.ts'], acceptanceCriteria: ['done'],
    } as Parameters<typeof storage.tasks.create>[0])
    const baseline: JobWorkspaceBaseline = { mode: 'clean', startCommitHash: headCommit() }
    storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'success',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      workspaceBaseline: baseline, failureMetadata: { workspaceEndFingerprint: baseline },
    } as Parameters<typeof storage.jobs.create>[0])
    const carrier = storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      workspaceBaseline: baseline, failureMetadata: { workspaceEndFingerprint: baseline },
    } as Parameters<typeof storage.jobs.create>[0])
    storage.jobs.update(carrier.id, {
      guardResult: { permissionAllowed: true, fileChangeAllowed: false, fileViolations: ['apps/worker/src/index.ts'] },
    } as Parameters<typeof storage.jobs.update>[1])
    const attention = buildSystemState(storage).attention.find((item) => item.taskId === task.id)
    if (!attention) throw new Error('technical attention missing')
    const requested = requestTechnicalAbort(storage, { taskId: task.id, attention, readLedger: () => TECHNICAL_LEDGER })
    if (!requested.ok || requested.status !== 'cleanup_requested') throw new Error(JSON.stringify(requested))
    return { task, carrier, baseline }
  }

  function generationOf(job: Job | undefined) {
    return {
      abortCleanupRequestedAt: job?.failureMetadata?.abortCleanupRequestedAt ?? '',
      abortTechnicalEvidenceId: job?.failureMetadata?.abortTechnicalEvidenceId ?? '',
      abortTechnicalStateFingerprint: job?.failureMetadata?.abortTechnicalStateFingerprint ?? '',
    }
  }

  it.each([
    { label: 'clean report' },
    { label: 'clean report after a stale-generation report' },
  ])('$label', async ({ label }) => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'lifecycle-f2-'))
    const dbPath = path.join(sandbox, 'api.db')
    env = await startLifecycle({ ledger: TECHNICAL_LEDGER, dbPath })
    const { task, carrier, baseline } = await seedTechnicalAbort()
    const generation = generationOf(env.storage.jobs.findById(carrier.id))
    expect(generation.abortCleanupRequestedAt).not.toBe('')
    const report = (cleanupGeneration: ReturnType<typeof generationOf>) => ({
      observation: baseline, preCleanupObservation: baseline, knownGood: KNOWN_GOOD,
      cleanupSummary: { changedPathCount: 0, restoredPathCount: 0, removedPathCount: 0 },
      cleanupGeneration,
    })

    if (label.includes('stale')) {
      // A report naming another generation is refused and changes nothing.
      const stale = await env.api<{ code?: string }>('POST', `/api/jobs/${carrier.id}/abort-cleanup-result`,
        report({ ...generation, abortTechnicalStateFingerprint: 'an-older-generation' }), 'worker')
      expect(stale.statusCode).toBe(409)
      expect(stale.body.code).toBe('GENERATION_MISMATCH')
      expect(env.storage.jobs.findById(carrier.id)?.failureMetadata?.quarantined).toBeUndefined()
      expect(env.storage.jobs.findById(carrier.id)?.status).toBe('blocked')
    }

    // Operation 1: another connection (e.g. a human write in another process) holds the write lock while the
    // Worker reports. Expected: 409 STORAGE_BUSY, nothing changed, no quarantine, generation kept.
    const metadataBefore = env.storage.jobs.findById(carrier.id)?.failureMetadata
    const other = new Database(dbPath)
    other.exec('BEGIN IMMEDIATE')
    let busy: { statusCode: number; body: { code?: string } }
    try {
      busy = await env.api<{ code?: string }>('POST', `/api/jobs/${carrier.id}/abort-cleanup-result`, report(generation), 'worker')
    } finally {
      other.exec('ROLLBACK')
      other.close()
    }
    expect(busy.statusCode).toBe(409)
    expect(busy.body.code).toBe('STORAGE_BUSY')
    const whileBusy = env.storage.jobs.findById(carrier.id)
    expect(whileBusy?.status).toBe('blocked')
    expect(whileBusy?.failureMetadata).toEqual(metadataBefore)
    expect(whileBusy?.failureMetadata?.quarantined).toBeUndefined()

    // Operation 2: the Worker re-sends the identical report after the lock is gone.
    // Expected: accepted, carrier released (failed), Task parked (roadmapActive=false), no quarantine.
    const ok = await env.api<{ parked?: boolean }>('POST', `/api/jobs/${carrier.id}/abort-cleanup-result`, report(generation), 'worker')
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.parked).toBe(true)
    expect(env.storage.jobs.findById(carrier.id)?.status).toBe('failed')
    expect(env.storage.jobs.findById(carrier.id)?.failureMetadata?.quarantined).toBeUndefined()
    expect(env.storage.tasks.findById(task.id)?.roadmapActive).toBe(false)
    expect(env.storage.tasks.isParked(task.id)).toBe(true)
  }, 120_000)
})
