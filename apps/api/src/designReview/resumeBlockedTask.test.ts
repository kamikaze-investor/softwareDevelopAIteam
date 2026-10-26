import { describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { CoordinatorDeps, RunnerExecution } from './designReviewCoordinator'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import {
  RESUME_DESIGN_REVIEW_FAILED,
  RESUME_DESIGN_REVIEW_PENDING,
  resumeBlockedTaskWithDesignReview,
} from './resumeBlockedTask'

/**
 * **Resume instruction の Design Review が判定を出していないときは失敗にしない**（独立レビュー round 6・2026-10-16）。
 *
 * 同じ resume 要求が重なると、2本目は1本目が握っている run を claim できない（not_claimable）。
 * それをそのまま「レビュー失敗（409）」にすると、1本目が ALIGNED になっても2本目の呼び出し側は
 * 失敗と受け取る。保存済み状態を読み直し、まだ判定が無ければ pending とする。
 */

const PL_ACTOR = { actorClass: 'pl', evidence: 'in_process_pl' } as const

// changedFiles [] の resume review で選ばれる focus（scope_simplicity）に合わせた ALIGNED。
const ALIGNED = JSON.stringify({
  focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED' }],
  integrationReviewResult: { decision: 'ALIGNED' },
  finalDecision: 'ALIGNED',
})

function seedBlockedTask(): { storage: IStorage; task: { id: string; title: string } } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: 'd', status: 'blocked',
    assignee: 'developer_ai', dependencies: [],
  } as Parameters<IStorage['tasks']['create']>[0])
  const originalPrompt = 'Original implementation prompt'
  storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    aiCliProvider: 'codex', aiCliMode: 'implement', aiCliPrompt: originalPrompt,
  } as Parameters<IStorage['jobs']['create']>[0])
  storage.designReviewEvidence.create({
    taskId: task.id, reviewKind: 'task', subjectId: task.id,
    designTextHash: computeDesignTextHash(originalPrompt),
    reviewLoad: 'low', decision: 'ALIGNED', independentReviewRequired: false,
  } as Parameters<IStorage['designReviewEvidence']['create']>[0])
  return { storage, task: { id: task.id, title: task.title } }
}

function coordinator(execute: (input: string) => Promise<RunnerExecution>): CoordinatorDeps {
  return { runnerCommand: 'mock', runnerArgs: [], homeDirectory: '/tmp', workingDir: '/tmp', execute }
}

describe('resumeBlockedTaskWithDesignReview — 判定待ちと重なった要求', () => {
  it('同じ resume が重なっても、2本目はレビュー失敗ではなく pending。1本目が ALIGNED で resume する', async () => {
    const { storage, task } = seedBlockedTask()
    const instructionPrompt = 'Resume with the reviewed plan.'
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let executions = 0
    const slow = coordinator(async () => {
      executions += 1
      await gate
      return { ok: true, stdout: ALIGNED, timedOut: false }
    })

    // 1本目は run を claim し、runner の完了待ちで止まる。
    const first = resumeBlockedTaskWithDesignReview(storage, { task, instructionPrompt, resumedBy: PL_ACTOR, coordinatorDeps: slow })
    const second = await resumeBlockedTaskWithDesignReview(storage, { task, instructionPrompt, resumedBy: PL_ACTOR, coordinatorDeps: slow })

    expect(second).toMatchObject({ ok: false, code: RESUME_DESIGN_REVIEW_PENDING })
    expect(second).not.toMatchObject({ code: RESUME_DESIGN_REVIEW_FAILED })

    release()
    const resumed = await first
    expect(resumed.ok).toBe(true)
    expect(executions).toBe(1)
    expect(storage.designReviewRuns.findByTaskId(task.id)).toHaveLength(1)
  })

  it('他の executor が既に ALIGNED にしていれば、読み直して resume する', async () => {
    const { storage, task } = seedBlockedTask()
    const instructionPrompt = 'Resume with the reviewed plan.'
    // 別 executor が同じ run を先に終端させた状態を、claim を横取りして再現する。
    const run = storage.designReviewRuns.create({
      taskId: task.id, taskTitle: task.title, designText: instructionPrompt,
      designTextHash: computeDesignTextHash(instructionPrompt), changedFiles: [],
    })
    const claim = storage.designReviewRuns.claim
    storage.designReviewRuns.claim = (id, max) => {
      const won = claim.call(storage.designReviewRuns, id, max)
      storage.designReviewRuns.completeWithEvidence(id, won.claimToken!, ALIGNED, {
        reviewKind: 'task', subjectId: task.id, taskId: task.id,
        designTextHash: computeDesignTextHash(instructionPrompt), reviewLoad: 'low', decision: 'ALIGNED',
        independentReviewRequired: false,
      })
      return {}
    }

    const resumed = await resumeBlockedTaskWithDesignReview(storage, {
      task, instructionPrompt, resumedBy: PL_ACTOR, coordinatorDeps: coordinator(async () => { throw new Error('must not run') }),
    })

    expect(resumed.ok).toBe(true)
    expect(storage.designReviewRuns.findById(run.id)?.status).toBe('succeeded')
  })
})

describe('resumeBlockedTaskWithDesignReview — resume 対象の固定（C3-c）', () => {
  it('review を起票したときの Job を run に記録し、そのまま resume する', async () => {
    const { storage, task } = seedBlockedTask()
    const source = storage.jobs.findByTaskId(task.id)[0]!
    const resumed = await resumeBlockedTaskWithDesignReview(storage, {
      task, instructionPrompt: 'Resume with the reviewed plan.', resumedBy: PL_ACTOR,
      coordinatorDeps: coordinator(async () => ({ ok: true, stdout: ALIGNED, timedOut: false })),
    })
    expect(resumed.ok).toBe(true)
    if (resumed.ok) expect(resumed.job.workflowStepKey).toBe(`resume:${source.id}:1`)
    expect(storage.designReviewRuns.findLatestByTaskId(task.id)?.resumeSourceJobId).toBe(source.id)
  })

  it('review を待つ間に別の blocked Job が最新になったら RESUME_TARGET_CHANGED で拒否し、何も作らない', async () => {
    const { storage, task } = seedBlockedTask()
    const source = storage.jobs.findByTaskId(task.id)[0]!
    let inserted = ''
    const resumed = await resumeBlockedTaskWithDesignReview(storage, {
      task, instructionPrompt: 'Resume with the reviewed plan.', resumedBy: PL_ACTOR,
      coordinatorDeps: coordinator(async () => {
        // The review is still pending when a different blocked Job (B) appears on the Task.
        inserted = storage.jobs.create({
          taskId: task.id, projectId: source.projectId, agentRole: 'developer_ai', status: 'blocked',
          safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
          aiCliProvider: 'codex', aiCliMode: 'implement', aiCliPrompt: 'another prompt',
        } as Parameters<IStorage['jobs']['create']>[0]).id
        return { ok: true, stdout: ALIGNED, timedOut: false }
      }),
    })

    expect(resumed).toMatchObject({ ok: false, code: 'RESUME_TARGET_CHANGED' })
    expect(storage.designReviewRuns.findLatestByTaskId(task.id)?.resumeSourceJobId).toBe(source.id)
    const keys = storage.jobs.findByTaskId(task.id).map((job) => job.workflowStepKey)
    expect(keys).not.toContain(`resume:${inserted}:1`)
    expect(keys.some((key) => key?.startsWith('resume:'))).toBe(false)
    expect(storage.jobs.findById(inserted)?.status).toBe('blocked')
    expect(storage.jobs.findById(source.id)?.status).toBe('blocked')
  })
})

describe('resumeBlockedTaskWithDesignReview — 対象変更は admission より先に返す（C3-c）', () => {
  async function resumeWhileInserting(
    replacement: (storage: IStorage, taskId: string, projectId: string) => string,
  ) {
    const { storage, task } = seedBlockedTask()
    const source = storage.jobs.findByTaskId(task.id)[0]!
    let inserted = ''
    const resumed = await resumeBlockedTaskWithDesignReview(storage, {
      task, instructionPrompt: 'Resume with the reviewed plan.', resumedBy: PL_ACTOR,
      coordinatorDeps: coordinator(async () => {
        inserted = replacement(storage, task.id, source.projectId)
        return { ok: true, stdout: ALIGNED, timedOut: false }
      }),
    })
    return { storage, task, source, inserted, resumed }
  }

  it('a replacement blocked Job without AI CLI metadata → RESUME_TARGET_CHANGED (not AI_CLI_MODE_MISSING)', async () => {
    const { storage, task, inserted, resumed } = await resumeWhileInserting((storage, taskId, projectId) =>
      storage.jobs.create({
        taskId, projectId, agentRole: 'developer_ai', status: 'blocked',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
      } as Parameters<IStorage['jobs']['create']>[0]).id)

    expect(resumed).toMatchObject({ ok: false, code: 'RESUME_TARGET_CHANGED' })
    expect(storage.jobs.findById(inserted)?.status).toBe('blocked')
    expect(storage.jobs.findByTaskId(task.id).some((job) => job.workflowStepKey?.startsWith('resume:'))).toBe(false)
  })

  it('a queued replacement Job → RESUME_TARGET_CHANGED (not LIVE_JOB_EXISTS)', async () => {
    const { storage, task, inserted, resumed } = await resumeWhileInserting((storage, taskId, projectId) =>
      storage.jobs.create({
        taskId, projectId, agentRole: 'developer_ai', status: 'queued',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
        aiCliProvider: 'codex', aiCliMode: 'implement', aiCliPrompt: 'another prompt',
      } as Parameters<IStorage['jobs']['create']>[0]).id)

    expect(resumed).toMatchObject({ ok: false, code: 'RESUME_TARGET_CHANGED' })
    expect(storage.jobs.findById(inserted)?.status).toBe('queued')
    expect(storage.jobs.findByTaskId(task.id).some((job) => job.workflowStepKey?.startsWith('resume:'))).toBe(false)
  })
})
