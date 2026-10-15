import { describe, expect, it } from 'vitest'
import type { Job } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { buildSystemState } from './systemState'
import { recordResumeActor } from '../designReview/resumeActor'
import { jobsSupersededByHumanResume } from '../designReview/repairPolicy'

/**
 * **D2: Human Resume で後継が作られた古い blocked / failed Job は、いま Task を止めている Job ではない。**
 *
 * 2026-09-28 production（Task `9fdee5a3`）: 元の blocked Job が残り続けたため `hasMovableJob` が
 * 常に true になり、Human Resume した review の失敗が `job_failed` として一度も出なかった。
 * 古い `job_blocked:<元Job>` は PL が escalate 済みで dedup されていたので、**新しい失敗が
 * 誰にも見えないまま止まった**。
 *
 * ここで固定するのは、superseded が保存済みの resume lineage と `resume_actor` だけから導かれること、
 * AI / unknown / malformed の resume は superseded にしないこと、そして元の行を書き換えないこと。
 */

const NOW = '2026-09-28T10:00:00.000Z'
const now = () => NOW

interface Ctx { storage: IStorage; projectId: string; taskId: string }

function seed(taskStatus: 'blocked' | 'pending' = 'blocked'): Ctx {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({ name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: '',
    status: taskStatus,
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: true,
    phase: 1,
  } as Parameters<IStorage['tasks']['create']>[0])
  return { storage, projectId: project.id, taskId: task.id }
}

function addJob(ctx: Ctx, status: Job['status'], fields: Partial<Job> = {}, taskId = ctx.taskId): Job {
  const created = ctx.storage.jobs.create({
    taskId,
    projectId: ctx.projectId,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    dryRun: false,
    ...fields,
  } as never)
  return status === 'queued' ? created : ctx.storage.jobs.update(created.id, { status })!
}

function resumeOf(ctx: Ctx, source: Job, status: Job['status'], actor: 'human' | 'ai' | 'none', fields: Partial<Job> = {}): Job {
  const job = addJob(ctx, status, { workflowStepKey: `resume:${source.id}:1`, ...fields })
  if (actor !== 'none') {
    recordResumeActor(ctx.storage, {
      jobId: job.id,
      taskId: ctx.taskId,
      actorClass: actor,
      evidence: actor === 'human' ? 'admin_credential' : 'in_process_pl',
    })
  }
  return job
}

function stallItems(ctx: Ctx) {
  return buildSystemState(ctx.storage, { now }).attention
    .filter((a) => a.kind === 'job_blocked' || a.kind === 'job_failed')
    .map((a) => `${a.kind}:${a.jobId}`)
}

describe('D2: Human Resume successor がある blocked / failed Job は Attention の停止原因にしない', () => {
  it('resume 前: blocked Job は従来どおり job_blocked に出る', () => {
    const ctx = seed()
    const blocked = addJob(ctx, 'blocked')

    expect(stallItems(ctx)).toEqual([`job_blocked:${blocked.id}`])
  })

  it('valid な Human Resume successor が動いている間: 古い job_blocked は出ない', () => {
    const ctx = seed()
    const blocked = addJob(ctx, 'blocked')
    resumeOf(ctx, blocked, 'running', 'human')

    expect(stallItems(ctx)).toEqual([])
  })

  it('successor が失敗したら: 新しい job_failed:<successor> が出る（古い key に隠れない）', () => {
    const ctx = seed()
    const blocked = addJob(ctx, 'blocked')
    const successor = resumeOf(ctx, blocked, 'failed', 'human')

    expect(stallItems(ctx)).toEqual([`job_failed:${successor.id}`])
  })

  it('successor が成功したら: 古い blocked も古い failed も復活しない', () => {
    const ctx = seed()
    const blocked = addJob(ctx, 'blocked')
    const middle = resumeOf(ctx, blocked, 'failed', 'human')
    resumeOf(ctx, middle, 'success', 'human')

    expect(stallItems(ctx)).toEqual([])
  })

  it('failed の元 Job に Human Resume successor があり、それが失敗したら successor を出す（古い failed ではない）', () => {
    const ctx = seed()
    const failed = addJob(ctx, 'failed')
    const successor = resumeOf(ctx, failed, 'failed', 'human')

    expect(stallItems(ctx)).toEqual([`job_failed:${successor.id}`])
  })

  it('AI resume は superseded にしない（従来どおり元の blocked が残る）', () => {
    const ctx = seed()
    const blocked = addJob(ctx, 'blocked')
    resumeOf(ctx, blocked, 'failed', 'ai')

    expect(stallItems(ctx)).toEqual([`job_blocked:${blocked.id}`])
  })

  it('actor の記録が無い resume（unknown）は superseded にしない', () => {
    const ctx = seed()
    const blocked = addJob(ctx, 'blocked')
    resumeOf(ctx, blocked, 'failed', 'none')

    expect(stallItems(ctx)).toEqual([`job_blocked:${blocked.id}`])
  })

  it('human と書いてあっても admin_credential の根拠が無い resume は superseded にしない', () => {
    const ctx = seed()
    const blocked = addJob(ctx, 'blocked')
    const successor = resumeOf(ctx, blocked, 'failed', 'none')
    recordResumeActor(ctx.storage, { jobId: successor.id, taskId: ctx.taskId, actorClass: 'human', evidence: 'worker_credential' })

    expect(stallItems(ctx)).toEqual([`job_blocked:${blocked.id}`])
  })

  it('malformed な resume key は superseded にしない', () => {
    const ctx = seed()
    const blocked = addJob(ctx, 'blocked')
    const successor = addJob(ctx, 'failed', { workflowStepKey: `resume:${blocked.id}:x` })
    recordResumeActor(ctx.storage, { jobId: successor.id, taskId: ctx.taskId, actorClass: 'human', evidence: 'admin_credential' })

    expect(stallItems(ctx)).toContain(`job_blocked:${blocked.id}`)
  })

  it('別 Task の Job を指す resume は superseded にしない（lineage が同一 Task で閉じない）', () => {
    const ctx = seed()
    const otherTask = ctx.storage.tasks.create({
      projectId: ctx.projectId,
      title: 'other',
      description: '',
      status: 'pending',
      assignee: 'developer_ai',
      dependencies: [],
      roadmapActive: false,
      phase: 1,
    } as Parameters<IStorage['tasks']['create']>[0])
    const foreign = addJob(ctx, 'blocked', {}, otherTask.id)
    const blocked = addJob(ctx, 'blocked')
    const successor = addJob(ctx, 'failed', { workflowStepKey: `resume:${foreign.id}:1` })
    recordResumeActor(ctx.storage, { jobId: successor.id, taskId: ctx.taskId, actorClass: 'human', evidence: 'admin_credential' })

    expect(stallItems(ctx)).toContain(`job_blocked:${blocked.id}`)
  })

  it('quarantine された Job は superseded でも workspace_quarantined を出し続ける（実異常は隠さない）', () => {
    const ctx = seed()
    const blocked = addJob(ctx, 'blocked')
    ctx.storage.jobs.update(blocked.id, { failureMetadata: { quarantined: true, quarantineReason: 'dirty' } })
    resumeOf(ctx, blocked, 'failed', 'human')

    const kinds = buildSystemState(ctx.storage, { now }).attention.map((a) => `${a.kind}:${a.jobId}`)
    expect(kinds).toContain(`workspace_quarantined:${blocked.id}`)
  })

  it('元の行は書き換えない（superseded は読み取り時の解釈だけ）', () => {
    const ctx = seed()
    const blocked = addJob(ctx, 'blocked')
    resumeOf(ctx, blocked, 'failed', 'human')

    buildSystemState(ctx.storage, { now })

    expect(ctx.storage.jobs.findById(blocked.id)?.status).toBe('blocked')
  })

  it('production 9fdee5a3 の形: 古い blocked B0 ではなく、Human Resume した review の失敗 R1 が見える', () => {
    // B0 initial implement（blocked のまま）→ I1 resume:B0:1（human・success）
    // → R0 implement:I1:review（failed）→ R1 resume:R0:1（human・failed）
    const ctx = seed()
    const b0 = addJob(ctx, 'blocked', { aiCliMode: 'implement', workflowStepKey: `task:${ctx.taskId}:initial-implement` })
    const i1 = resumeOf(ctx, b0, 'success', 'human', { aiCliMode: 'implement' })
    const r0 = addJob(ctx, 'failed', { aiCliMode: 'review', workflowStepKey: `implement:${i1.id}:review` })
    const r1 = resumeOf(ctx, r0, 'failed', 'human', { aiCliMode: 'review' })

    // 変更前は job_blocked:B0 だけが出て（PL は escalate 済みで dedup）、R1 は見えなかった。
    expect(stallItems(ctx)).toEqual([`job_failed:${r1.id}`])
  })
})

describe('jobsSupersededByHumanResume — 保存済み lineage だけから導く', () => {
  const human = { resumeActorClass: 'human' as const, facts: {} }

  it('cycle を含む lineage は superseded を作らない（fail-closed）', () => {
    const superseded = jobsSupersededByHumanResume([
      { id: 'a', workflowStepKey: 'resume:b:1', status: 'blocked', ...human },
      { id: 'b', workflowStepKey: 'resume:a:1', status: 'failed', ...human },
    ])

    expect([...superseded]).toEqual([])
  })

  it('source が存在しない resume は superseded を作らない', () => {
    const superseded = jobsSupersededByHumanResume([
      { id: 's', workflowStepKey: 'resume:missing:1', status: 'failed', ...human },
    ])

    expect([...superseded]).toEqual([])
  })

  it('Human Resume が連続したら各段の元 Job が superseded になる', () => {
    const superseded = jobsSupersededByHumanResume([
      { id: 'b0', status: 'blocked', facts: {} },
      { id: 'h1', workflowStepKey: 'resume:b0:1', status: 'blocked', ...human },
      { id: 'h2', workflowStepKey: 'resume:h1:1', status: 'failed', ...human },
    ])

    expect([...superseded].sort()).toEqual(['b0', 'h1'])
  })
})
