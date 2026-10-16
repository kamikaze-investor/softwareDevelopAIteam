/**
 * Lifecycle E2E — M1: Mobile の Resume / Recover 表示判定と API の実際の応答が一致するか。
 *
 * Mobile は `GET /api/tasks/:id`（TaskDetail）・`GET /api/jobs?taskId=`・`GET /api/approval-requests?taskId=` を
 * 読み、共有 `evaluateResumeAdmission()` / `evaluateRecoverAdmission()` でボタンを出す
 * （`apps/mobile/lib/taskWorkflow.ts`）。ここでは lifecycle が実際に作った Task の形ごとに、その判定と
 * `POST /api/tasks/:id/resume` / `POST /api/tasks/:id/recover` の結果を突き合わせる。
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

import {
  APPROVED_REVIEW,
  buildLedger,
  changesRequested,
  createRunningProject,
  removeTargetRepo,
  startLifecycle,
  type LifecycleEnv,
  type ReviewOutcome,
} from './harness'
import { resetDesignReviewStub, scriptDesignReview } from './runnerStub'
import { passDesignReviewRetryCooldown } from '../designReview/retryCooldownTestClock'

vi.setConfig({ testTimeout: 240_000 })

let env: LifecycleEnv

beforeEach(() => {
  resetDesignReviewStub()
})
afterEach(async () => {
  // retry cooldown を明けさせるために進めた壁時計を戻す（retryCooldownTestClock.ts）。
  vi.useRealTimers()
  await env?.close()
})
afterAll(() => {
  removeTargetRepo()
})

const REKICK = async () => JSON.stringify({ actionKind: 'rekick_design_review', rationale: 'idle', riskLevel: 'LOW' })
const HIGH_FINDING: ReviewOutcome = {
  kind: 'verdict',
  result: { status: 'approved', summary: 'caveat', findings: [{ severity: 'high', message: 'check' }] },
}

async function start(id: string, extraItems: Array<{ id: string; title: string }> = []) {
  env = await startLifecycle({ ledger: buildLedger([{ id, title: `Mobile shape ${id}` }, ...extraItems]) })
  const project = createRunningProject(env)
  env.adoptionAllowedPaths = [`docs/${id}`]
  const task = await env.adoptNext(project.id, id)
  return { project, task }
}

interface Agreement {
  shape: string
  mobileResume: string
  apiResume: string
  mobileRecover: string
  apiRecover: string
}

/**
 * 判定と実際の応答を突き合わせる。admit される側の操作は最後に 1 回だけ実行する
 * （拒否される操作は副作用が無いので先に両方試せる）。
 */
async function compare(shape: string, taskId: string): Promise<Agreement> {
  const mobile = await env.mobileAdmission(taskId)
  const label = (admission: { ok: boolean; code?: string }) => (admission.ok ? 'ok' : admission.code ?? '?')
  const apiLabel = (res: { statusCode: number; body: { code?: string } }, okStatus: number) =>
    (res.statusCode === okStatus ? 'ok' : res.body?.code ?? `HTTP ${res.statusCode}`)

  let apiResume = ''
  let apiRecover = ''
  if (mobile.resume.ok) {
    apiRecover = apiLabel(await env.ceo.recover(taskId), 200)
    apiResume = apiLabel(await env.ceo.resume(taskId, 'continue'), 201)
  } else {
    apiResume = apiLabel(await env.ceo.resume(taskId, 'continue'), 201)
    apiRecover = apiLabel(await env.ceo.recover(taskId), 200)
  }
  return { shape, mobileResume: label(mobile.resume), apiResume, mobileRecover: label(mobile.recover), apiRecover }
}

function expectAgreement(result: Agreement): void {
  expect({ shape: result.shape, resume: result.apiResume, recover: result.apiRecover })
    .toEqual({ shape: result.shape, resume: result.mobileResume, recover: result.mobileRecover })
}

describe('M1: Mobile admission (shared predicates over GET responses) agrees with POST /resume and /recover', () => {
  it('done Task (N1 shape)', async () => {
    const { task } = await start('m-done')
    await env.worker.runUntilIdle()
    expect(env.task(task.id).status).toBe('done')
    const result = await compare('done', task.id)
    expect(result.mobileResume).toBe('TASK_DONE')
    expectAgreement(result)
  })

  it('git_commit waiting on a live Job-linked approval (N2 / A shape)', async () => {
    const { task } = await start('m-waiting')
    env.worker.behaviors.review = () => HIGH_FINDING
    await env.worker.runUntilIdle()
    const result = await compare('approval waiting', task.id)
    expect(result.mobileResume).toBe('APPROVAL_WAITING')
    expectAgreement(result)
  })

  it('git_commit blocked after the CEO rejected it (A1 shape) — resume admitted', async () => {
    const { task } = await start('m-rejected')
    env.worker.behaviors.review = () => HIGH_FINDING
    await env.worker.runUntilIdle()
    const [approval] = env.storage.approvalRequests.findByTaskId(task.id)
    await env.ceo.reject(approval!.id)
    const result = await compare('rejected commit', task.id)
    expect(result.mobileResume).toBe('ok')
    expectAgreement(result)
  })

  // 生きた Task 単位の人の判断（WAITING abort_task）がある形。Mobile は resumedByHuman: true で判定し、
  // CEO（ADMIN）の resume はその判断を置き換える（storage が同じ transaction で SUPERSEDED にする）。
  // APPROVED ではなく WAITING を使う: APPROVED を live とみなすには approval_actor=human を要求する方向へ
  // 述語が変わる予定で、この形の意味（人の判断が生きている）を WAITING なら変えずに保てる。
  it('rejected commit with a live task-scoped human decision (WAITING abort_task) — human resume admitted', async () => {
    const { task } = await start('m-human-decision')
    env.worker.behaviors.review = () => HIGH_FINDING
    await env.worker.runUntilIdle()
    const [approval] = env.storage.approvalRequests.findByTaskId(task.id)
    await env.ceo.reject(approval!.id)
    const abortRequest = env.storage.approvalRequests.create({
      taskId: task.id, targetBranch: 'candidate/self-dev', targetCommit: 'c', targetDiffHash: 'd',
      riskLevel: 'HIGH', requestedAction: 'abort_task', status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), invalidIf: [],
    } as never)
    const result = await compare('live task-scoped human decision', task.id)
    expect(result.mobileResume).toBe('ok')
    expectAgreement(result)
    expect(env.storage.approvalRequests.findById(abortRequest.id)?.status).toBe('SUPERSEDED')
  })

  it('repair Design Review failed and the Task escalated (R3 shape) — resume admitted', async () => {
    const { task } = await start('m-escalated')
    env.worker.behaviors.review = () => changesRequested('restructure')
    scriptDesignReview('RUNNER_UNAVAILABLE', 'RUNNER_UNAVAILABLE', 'RUNNER_UNAVAILABLE')
    await env.worker.runUntilIdle()
    // Each rekick happens after the retry cooldown (retryCooldown.ts); advance the clock past it.
    passDesignReviewRetryCooldown()
    await env.plTick({ diagnose: REKICK })
    passDesignReviewRetryCooldown()
    await env.plTick({ diagnose: REKICK })
    expect(env.task(task.id).status).toBe('blocked')
    env.worker.behaviors.review = () => APPROVED_REVIEW
    const result = await compare('escalated repair review', task.id)
    expect(result.mobileResume).toBe('ok')
    expectAgreement(result)
  })

  it('quarantined workspace (F3 shape)', async () => {
    const { task } = await start('m-quarantine')
    env.worker.behaviors.implement = () => ({ kind: 'quarantine', reason: 'drain failed' })
    await env.worker.pollOnce()
    const result = await compare('quarantined', task.id)
    expect(result.mobileResume).toBe('WORKSPACE_QUARANTINED')
    expectAgreement(result)
  })

  it('paused Project with an escalated Task (F4 shape)', async () => {
    const { project, task } = await start('m-paused')
    env.worker.behaviors.review = () => changesRequested('restructure')
    scriptDesignReview('CONFLICT')
    await env.worker.runUntilIdle()
    expect(env.task(task.id).status).toBe('blocked')
    expect((await env.api('PATCH', `/api/projects/${project.id}`, { status: 'paused' })).statusCode).toBe(200)
    const result = await compare('paused project', task.id)
    expect(result.mobileResume).toBe('PROJECT_NOT_RUNNING')
    expectAgreement(result)
  })

  it('in-flight Task with a queued Job', async () => {
    const { task } = await start('m-inflight')
    await env.worker.pollOnce() // implement → review queued
    const result = await compare('in flight', task.id)
    expect(result.mobileResume).not.toBe('ok')
    expectAgreement(result)
  })

  it('blocked Task with zero Jobs after a failed continuation — recover admitted', async () => {
    // Start: Task A adopted; Task B already synced (pending, roadmapActive). B's initial Design Review
    // will CONFLICT, so the continuation fails and B becomes blocked without any Job.
    const { project, task } = await start('m-a')
    const taskB = env.storage.tasks.create({
      projectId: project.id, title: 'Next synced', description: 'next', status: 'pending', assignee: 'developer_ai',
      dependencies: [], roadmapActive: true, phase: 2, roadmapTaskKey: 'm-b', allowedPaths: ['docs/m-a'],
      acceptanceCriteria: ['x'],
    } as Parameters<typeof env.storage.tasks.create>[0])
    scriptDesignReview('CONFLICT')
    await env.worker.runUntilIdle(4)
    expect(env.task(task.id).status).toBe('done')
    expect(env.task(taskB.id).status).toBe('blocked')
    expect(env.jobsOf(taskB.id)).toEqual([])
    const result = await compare('blocked without jobs', taskB.id)
    expect(result.mobileRecover).toBe('ok')
    expectAgreement(result)
  })
})
