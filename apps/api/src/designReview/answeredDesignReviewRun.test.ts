import { describe, expect, it } from 'vitest'
import type { Job, ReviewResult } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { prepareRepairFlow } from './repairFlow'
import { recordResumeActor } from './resumeActor'

/**
 * **D3: Human Resume で回答済みの Design Review run は、repair admission の根拠から外す。**
 *
 * 2026-09-28 production（Task `9fdee5a3`）: R0 の修正要求から作られた repair run `d0af140a` は
 * REVIEW_UNAVAILABLE で終わり、Task は blocked のまま人へ渡った。CEO はその後 R0 を Human Resume し
 * （R1 = `resume:R0:1`）、R1 も修正を要求した。ところが admission の「最新 Design Review が ALIGNED」は
 * `d0af140a` を最新として読み続け、D1 後も repair が作られなかった。
 *
 * 外してよいのは、次をすべて満たす run だけ:
 *   同じ Task / `repairSourceJobId === decision.sourceJobId` / 引き金の review の resume lineage 上の
 *   Human Resume / その resume の `createdAt > run.completedAt`
 * **verdict では特例にしない。** 残りのうち最も新しい run には従来の規則をそのまま当てる。
 */

const DOC = 'docs/project_memory/decisions/vps-operations.md'
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

interface Shape {
  storage: IStorage
  taskId: string
  projectId: string
  b0: Job
  i1: Job
  r0: Job
}

function job(s: IStorage, shape: { taskId: string; projectId: string }, fields: Record<string, unknown>, terminal: Record<string, unknown>): Job {
  const created = s.jobs.create({
    taskId: shape.taskId,
    projectId: shape.projectId,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code',
    aiCliPrompt: 'prompt',
    ...fields,
  } as never)
  return s.jobs.update(created.id, terminal as never)!
}

function verdict(s: IStorage, taskId: string, jobId: string, overrides: Partial<ReviewResult> = {}): void {
  s.reviewResults.create({
    taskId,
    jobId,
    reviewer: 'qa_ai',
    status: 'changes_requested',
    summary: `verdict of ${jobId}`,
    findings: [{ severity: 'medium', file: DOC, message: `finding from ${jobId}` }],
    ...overrides,
  } as never)
}

/** B0 initial implement（blocked）→ I1 resume:B0:1（human・success）→ R0 implement:I1:review（changes_requested）。 */
async function shapeBeforeRun(): Promise<Shape> {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({ name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'VPS docs',
    description: 'd',
    status: 'blocked',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: [DOC],
    roadmapActive: true,
  } as never)
  const ids = { taskId: task.id, projectId: project.id }
  const b0 = job(storage, ids, { aiCliMode: 'implement', workflowStepKey: `task:${task.id}:initial-implement` }, { status: 'blocked' })
  await tick()
  const i1 = job(storage, ids, { aiCliMode: 'implement', workflowStepKey: `resume:${b0.id}:1` }, { status: 'success', exitCode: 0, changedFiles: [DOC] })
  recordResumeActor(storage, { jobId: i1.id, taskId: task.id, actorClass: 'human', evidence: 'admin_credential' })
  await tick()
  const r0 = job(storage, ids, { agentRole: 'qa_ai', aiCliMode: 'review', workflowStepKey: `implement:${i1.id}:review` }, { status: 'failed', exitCode: 0 })
  verdict(storage, task.id, r0.id)
  await tick()
  return { storage, ...ids, b0, i1, r0 }
}

type RunResult = 'REVIEW_UNAVAILABLE' | 'CONFLICT' | 'ALIGNED'

/** 終端した run を 1 件作る（`d0af140a` と同じ low-load の保存形）。 */
async function terminalRun(shape: Shape, result: RunResult, repairSourceJobId: string | undefined): Promise<string> {
  const designText = `design ${Math.random()}`
  const created = shape.storage.designReviewRuns.create({
    taskId: shape.taskId,
    taskTitle: 'VPS docs',
    designText,
    designTextHash: computeDesignTextHash(designText),
    changedFiles: [DOC],
    ...(repairSourceJobId === undefined ? {} : { repairSourceJobId }),
  })
  const claimed = shape.storage.designReviewRuns.claim(created.id, 3)
  const raw = result === 'REVIEW_UNAVAILABLE'
    ? { reviewLoad: 'low', selectedFocuses: [], focusedReviewResults: [], finalDecision: 'REVIEW_UNAVAILABLE', unavailableReason: 'ENOENT' }
    : {
        reviewLoad: 'low',
        selectedFocuses: [],
        focusedReviewResults: [],
        integrationReviewResult: { decision: result, summary: result, findings: [] },
        finalDecision: result,
      }
  shape.storage.designReviewRuns.complete(created.id, claimed.claimToken!, 'succeeded', JSON.stringify(raw))
  await tick()
  return created.id
}

/** R1 = resume:R0:1（review）。actor を記録してから verdict を保存する。 */
async function resumedReview(shape: Shape, actor: 'human' | 'ai' | 'none' | 'human_without_admin', source: Job = shape.r0): Promise<Job> {
  const r1 = job(shape.storage, shape, { agentRole: 'qa_ai', aiCliMode: 'review', workflowStepKey: `resume:${source.id}:1` }, { status: 'failed', exitCode: 0 })
  if (actor === 'human') recordResumeActor(shape.storage, { jobId: r1.id, taskId: shape.taskId, actorClass: 'human', evidence: 'admin_credential' })
  if (actor === 'ai') recordResumeActor(shape.storage, { jobId: r1.id, taskId: shape.taskId, actorClass: 'ai', evidence: 'in_process_pl' })
  if (actor === 'human_without_admin') recordResumeActor(shape.storage, { jobId: r1.id, taskId: shape.taskId, actorClass: 'human', evidence: 'worker_credential' })
  verdict(shape.storage, shape.taskId, r1.id)
  await tick()
  return r1
}

function admit(shape: Shape, reviewJobId?: string) {
  return prepareRepairFlow(shape.storage, { failedJob: shape.i1, ...(reviewJobId === undefined ? {} : { reviewJobId }) })
}

describe('D3: Human Resume で回答済みの repair run は admission の根拠にしない', () => {
  it('production 9fdee5a3: REVIEW_UNAVAILABLE で終わった repair run の後の Human Resume review は repair を queue する', async () => {
    const shape = await shapeBeforeRun()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE', shape.i1.id)
    const r1 = await resumedReview(shape, 'human')

    const result = admit(shape, r1.id)

    expect(result).toMatchObject({ action: 'queue', stepKey: `repair:${shape.i1.id}:1` })
    if (result.action !== 'queue') return
    expect(result.run.repairSourceJobId).toBe(shape.i1.id)
  })

  it('verdict で特例にしない: CONFLICT で終わった repair run でも、人が後から答えていれば同じく外す', async () => {
    const shape = await shapeBeforeRun()
    await terminalRun(shape, 'CONFLICT', shape.i1.id)
    const r1 = await resumedReview(shape, 'human')

    expect(admit(shape, r1.id).action).toBe('queue')
  })

  it('run の完了より前に作られた resume は回答ではない（従来どおり skip、runId を返す）', async () => {
    const shape = await shapeBeforeRun()
    const r1 = await resumedReview(shape, 'human')
    const runId = await terminalRun(shape, 'REVIEW_UNAVAILABLE', shape.i1.id)

    expect(admit(shape, r1.id)).toEqual({
      action: 'skip',
      reason: 'task is blocked (latest design review is REVIEW_UNAVAILABLE)',
      runId,
    })
  })

  it.each([
    ['AI resume', 'ai'],
    ['actor の記録が無い resume（unknown）', 'none'],
    ['admin_credential の根拠が無い human 記録', 'human_without_admin'],
  ] as const)('%s は回答として扱わない', async (_label, actor) => {
    const shape = await shapeBeforeRun()
    const runId = await terminalRun(shape, 'REVIEW_UNAVAILABLE', shape.i1.id)
    const r1 = await resumedReview(shape, actor)

    expect(admit(shape, r1.id)).toMatchObject({ action: 'skip', runId })
  })

  it('別の repairSourceJobId の run は外さない（別 lineage）', async () => {
    const shape = await shapeBeforeRun()
    const runId = await terminalRun(shape, 'REVIEW_UNAVAILABLE', shape.b0.id)
    const r1 = await resumedReview(shape, 'human')

    expect(admit(shape, r1.id)).toMatchObject({ action: 'skip', runId })
  })

  it('Task 設計由来の run（repairSourceJobId 無し）の CONFLICT は、Human Resume の後でも外さない', async () => {
    const shape = await shapeBeforeRun()
    const runId = await terminalRun(shape, 'CONFLICT', undefined)
    const r1 = await resumedReview(shape, 'human')

    expect(admit(shape, r1.id)).toEqual({
      action: 'skip',
      reason: 'task is blocked (latest design review is CONFLICT)',
      runId,
    })
  })

  it('回答済み run を外した後は、その下の run に従来の規則を当てる（Task 設計の CONFLICT は残る）', async () => {
    const shape = await shapeBeforeRun()
    const taskDesignRun = await terminalRun(shape, 'CONFLICT', undefined)
    await terminalRun(shape, 'REVIEW_UNAVAILABLE', shape.i1.id)
    const r1 = await resumedReview(shape, 'human')

    expect(admit(shape, r1.id)).toMatchObject({ action: 'skip', runId: taskDesignRun })
  })

  it('回答済み run を外した後、その下が ALIGNED なら queue する', async () => {
    const shape = await shapeBeforeRun()
    await terminalRun(shape, 'ALIGNED', undefined)
    await terminalRun(shape, 'REVIEW_UNAVAILABLE', shape.i1.id)
    const r1 = await resumedReview(shape, 'human')

    expect(admit(shape, r1.id).action).toBe('queue')
  })

  it('active な run（queued）は回答済みにならず、従来どおり skip する', async () => {
    const shape = await shapeBeforeRun()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE', shape.i1.id)
    const r1 = await resumedReview(shape, 'human')
    const designText = 'still queued'
    const active = shape.storage.designReviewRuns.create({
      taskId: shape.taskId,
      taskTitle: 'VPS docs',
      designText,
      designTextHash: computeDesignTextHash(designText),
      changedFiles: [DOC],
      repairSourceJobId: shape.i1.id,
    })

    expect(admit(shape, r1.id)).toMatchObject({ action: 'skip', runId: active.id })
  })

  it('selector 無しの通常 review 経路は resume lineage を持たないので、従来どおり skip する', async () => {
    const shape = await shapeBeforeRun()
    const runId = await terminalRun(shape, 'REVIEW_UNAVAILABLE', shape.i1.id)
    await resumedReview(shape, 'human')

    expect(admit(shape)).toMatchObject({ action: 'skip', runId })
  })

  it('2 段の resume: lineage 上の手前の段が Human Resume なら回答として数える', async () => {
    const shape = await shapeBeforeRun()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE', shape.i1.id)
    const r1 = await resumedReview(shape, 'human')
    const r2 = await resumedReview(shape, 'ai', r1)

    expect(admit(shape, r2.id).action).toBe('queue')
  })

  it('lineage 外の Human Resume（同じ Task の別の Job）は回答として数えない', async () => {
    const shape = await shapeBeforeRun()
    const runId = await terminalRun(shape, 'REVIEW_UNAVAILABLE', shape.i1.id)
    // 同じ Task に、run の後に作られた human resume があるが、引き金の review の lineage ではない。
    const unrelated = job(shape.storage, shape, { aiCliMode: 'implement', workflowStepKey: `resume:${shape.b0.id}:2` }, { status: 'failed' })
    recordResumeActor(shape.storage, { jobId: unrelated.id, taskId: shape.taskId, actorClass: 'human', evidence: 'admin_credential' })
    await tick()
    const r1 = await resumedReview(shape, 'ai')

    expect(admit(shape, r1.id)).toMatchObject({ action: 'skip', runId })
  })
})
