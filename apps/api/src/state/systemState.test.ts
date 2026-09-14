import { describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { buildSystemState } from './systemState'

const NOW = '2026-09-14T10:00:00.000Z'
const now = () => NOW

function seed(): { storage: IStorage; projectId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS',
    goal: 'g',
    designPhilosophy: [],
    status: 'running',
  })
  return { storage, projectId: project.id }
}

function addTask(storage: IStorage, projectId: string, over: Partial<Parameters<IStorage['tasks']['create']>[0]> = {}) {
  return storage.tasks.create({
    projectId,
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: true,
    phase: 1,
    ...over,
  } as Parameters<IStorage['tasks']['create']>[0])
}

describe('buildSystemState — 横断状態の読み取り', () => {
  it('archived Project は観測対象に含めない（履歴は既存経路で読む）', () => {
    const { storage } = seed()
    storage.projects.create({ name: 'old', goal: 'g', designPhilosophy: [], status: 'archived' })

    const state = buildSystemState(storage, { now })

    expect(state.projects.map((p) => p.name)).toEqual(['AIteamOS'])
    // totals は全 Project を数える（archived の存在自体は見える）
    expect(state.totals.projects.archived).toBe(1)
  })

  it('roadmapActive で pending なのに Job が無い Task を attention に出す', () => {
    const { storage, projectId } = seed()
    addTask(storage, projectId)

    const state = buildSystemState(storage, { now })

    const item = state.attention.find((a) => a.kind === 'task_ready_without_job')
    expect(item).toBeDefined()
    expect(item?.detail).toContain('nothing will start it')
  })

  it('Project が running でなければ task_ready_without_job を出さない（CEO がまだ進めると決めていない）', () => {
    const { storage, projectId } = seed()
    addTask(storage, projectId)
    storage.projects.update(projectId, { status: 'paused' })

    const state = buildSystemState(storage, { now })

    expect(state.attention.some((a) => a.kind === 'task_ready_without_job')).toBe(false)
  })

  it('quarantine された Job を attention に出し、totals にも数える', () => {
    const { storage, projectId } = seed()
    const task = addTask(storage, projectId)
    const job = storage.jobs.create({
      taskId: task.id,
      projectId,
      agentRole: 'developer_ai',
      status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })
    storage.jobs.update(job.id, {
      failureMetadata: { quarantined: true, quarantineReason: 'workspace could not be proven quiescent' },
    })

    const state = buildSystemState(storage, { now })

    expect(state.totals.quarantinedJobs).toBe(1)
    const item = state.attention.find((a) => a.kind === 'workspace_quarantined')
    expect(item?.detail).toContain('quiescent')
    // quarantine は blocked としては二重計上しない
    expect(state.attention.filter((a) => a.jobId === job.id)).toHaveLength(1)
  })

  it('長時間 running の Job を attention に出す（閾値未満は出さない）', () => {
    const { storage, projectId } = seed()
    const task = addTask(storage, projectId, { status: 'in_progress' })
    // startedAt は create では永続化されない（本番と同じく update で入る）
    const running = storage.jobs.create({
      taskId: task.id,
      projectId,
      agentRole: 'developer_ai',
      status: 'running',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })
    storage.jobs.update(running.id, { startedAt: '2026-09-14T09:00:00.000Z' })

    // 固定時刻ではなく Job の startedAt 基準の相対時刻で判定する
    // （storage の createdAt は実時刻なので、固定 NOW と混ぜると意味が変わる）
    const oneHourLater = () => new Date(Date.parse('2026-09-14T09:00:00.000Z') + 60 * 60 * 1000).toISOString()

    const strict = buildSystemState(storage, { now: oneHourLater, stallHintMs: 5 * 60 * 1000 })
    expect(strict.attention.some((a) => a.kind === 'job_running_long')).toBe(true)

    const lenient = buildSystemState(storage, { now: oneHourLater, stallHintMs: 2 * 60 * 60 * 1000 })
    expect(lenient.attention.some((a) => a.kind === 'job_running_long')).toBe(false)
  })

  it('Project ごとの roadmap 進捗と最新 Job を返す', () => {
    const { storage, projectId } = seed()
    const done = addTask(storage, projectId, { status: 'done' })
    addTask(storage, projectId)
    // commitHash は create では永続化されない（本番と同じく update で入る）
    const committed = storage.jobs.create({
      taskId: done.id,
      projectId,
      agentRole: 'developer_ai',
      status: 'success',
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' },
      dryRun: false,
      aiCliProvider: 'claude_code',
    })
    storage.jobs.update(committed.id, { commitHash: 'abc12345' })

    const state = buildSystemState(storage, { now })
    const p = state.projects[0]

    expect(p.roadmap.totalTaskCount).toBe(2)
    expect(p.roadmap.completedTaskCount).toBe(1)
    expect(p.roadmap.isComplete).toBe(false)
    expect(p.jobs.latest?.status).toBe('success')
    expect(p.jobs.latest?.commitHash).toBe('abc12345')
    expect(p.jobs.latest?.provider).toBe('claude_code')
    expect(p.jobs.byStatus.success).toBe(1)
  })

  it('副作用を持たない（同じ入力で2回呼んでも state が変わらない）', () => {
    const { storage, projectId } = seed()
    addTask(storage, projectId)

    const first = buildSystemState(storage, { now })
    const second = buildSystemState(storage, { now })

    expect(second).toEqual(first)
  })
})

describe('buildSystemState — 終端した Design Review も観測できる（production 検証で判明した欠落）', () => {
  it('failed で終わった design review を attention に出す', () => {
    const { storage, projectId } = seed()
    const task = addTask(storage, projectId)
    const run = storage.designReviewRuns.create({
      reviewKind: 'task',
      subjectId: task.id,
      taskId: task.id,
      designText: 'd',
      designTextHash: 'h',
      taskTitle: 'T',
      changedFiles: [],
    })
    const claimed = storage.designReviewRuns.claim(run.id, 3)
    expect(claimed.run).toBeDefined()
    storage.designReviewRuns.complete(run.id, claimed.run!.claimToken!, 'failed', undefined, 'runner timed out after 120000ms')

    const state = buildSystemState(storage, { now })

    const item = state.attention.find((a) => a.kind === 'design_review_failed')
    expect(item).toBeDefined()
    expect(item?.detail).toContain('timed out')
    // 停止理由として Project サマリにも残る
    expect(state.projects[0].designReview?.status).toBe('failed')
    expect(state.projects[0].designReview?.idle).toBe(false)
  })

  it('succeeded な review は attention に出さない（正常系を異常扱いしない）', () => {
    const { storage, projectId } = seed()
    const task = addTask(storage, projectId)
    const run = storage.designReviewRuns.create({
      reviewKind: 'task',
      subjectId: task.id,
      taskId: task.id,
      designText: 'd',
      designTextHash: 'h',
      taskTitle: 'T',
      changedFiles: [],
    })
    const claimed = storage.designReviewRuns.claim(run.id, 3)
    storage.designReviewRuns.complete(run.id, claimed.run!.claimToken!, 'succeeded', '{}')

    const state = buildSystemState(storage, { now })

    expect(state.attention.some((a) => a.kind === 'design_review_failed')).toBe(false)
    expect(state.attention.some((a) => a.kind === 'design_review_idle')).toBe(false)
    expect(state.projects[0].designReview?.status).toBe('succeeded')
  })
})
