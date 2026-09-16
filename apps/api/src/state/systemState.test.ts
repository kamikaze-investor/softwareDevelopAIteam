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

  it('生きている承認待ちで止まった Job は job_blocked にしない（approval_waiting と二重に出さない）', () => {
    // 2026-09-15 production 実測: 新しい Approval Request を発行した直後、同じ停滞が
    // `approval_waiting` と `job_blocked` の両方で出た。PL は人の判断待ちの相手に復旧を試み、
    // 試行上限まで使って**二重に CEO を呼ぶ**。
    const { storage, projectId } = seed()
    const task = addTask(storage, projectId)
    const job = storage.jobs.create({
      taskId: task.id,
      projectId,
      agentRole: 'developer_ai',
      status: 'blocked',
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' },
      dryRun: false,
    })
    const created = storage.approvalRequests.createForJob({
      taskId: task.id,
      targetBranch: 'candidate/self-dev',
      targetCommit: 'af60412',
      targetDiffHash: 'hash',
      riskLevel: 'LOW',
      requestedAction: 'git_commit',
      status: 'WAITING_FOR_USER',
      expiresAt: '2026-09-15T10:00:00.000Z',
      invalidIf: [],
      changedFiles: ['apps/worker/src/metaReviewer/autoReview.ts'],
      triggeredRules: ['git_commit requires CEO approval (policy)'],
    } as Parameters<IStorage['approvalRequests']['createForJob']>[0], job.id)
    expect(created.ok).toBe(true)

    const state = buildSystemState(storage, { now })

    expect(state.attention.some((a) => a.kind === 'approval_waiting')).toBe(true)
    expect(state.attention.some((a) => a.kind === 'job_blocked')).toBe(false)
  })

  it('期限切れ / STALE な承認で止まった Job は job_blocked として出す（誰も進められない本物の停滞）', () => {
    const { storage, projectId } = seed()
    const task = addTask(storage, projectId)
    const job = storage.jobs.create({
      taskId: task.id,
      projectId,
      agentRole: 'developer_ai',
      status: 'blocked',
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' },
      dryRun: false,
    })
    const created = storage.approvalRequests.createForJob({
      taskId: task.id,
      targetBranch: 'candidate/self-dev',
      targetCommit: '8ddad05',
      targetDiffHash: 'hash',
      riskLevel: 'LOW',
      requestedAction: 'git_commit',
      status: 'STALE',
      expiresAt: '2026-09-15T10:00:00.000Z',
      invalidIf: [],
      changedFiles: ['apps/worker/src/metaReviewer/autoReview.ts'],
      triggeredRules: ['git_commit requires CEO approval (policy)'],
    } as Parameters<IStorage['approvalRequests']['createForJob']>[0], job.id)
    expect(created.ok).toBe(true)

    const state = buildSystemState(storage, { now })

    expect(state.attention.some((a) => a.kind === 'job_blocked')).toBe(true)
  })

  it('停止理由は provider の警告ではなく jobRunner の診断を出す（CEO 通知の Root Cause）', () => {
    // 2026-09-15 production 実測: 実際の原因は File Change Guard の allowedPaths 不一致だったのに、
    // Escalation 本文の「何が起きているか」は
    // `⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY …` だった。
    // jobRunner は診断を stderr の**先頭**へ置くが、ここは `tail()` で**末尾**を取っていたため。
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
      stderr: '[jobRunner] File Change Guard blocked. Why: docs/a.md — Not in task.allowedPaths.'
        + ' allowedPaths scope (other guard rules also apply): docs/approval-roles\n'
        + '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set',
    })

    const item = buildSystemState(storage, { now }).attention.find((a) => a.kind === 'job_blocked')

    expect(item?.detail).toContain('File Change Guard blocked')
    expect(item?.detail).toContain('allowedPaths')
    expect(item?.detail).not.toContain('ANTHROPIC_API_KEY')
  })

  it('jobRunner の先頭注記が無ければ従来どおり末尾を使う（provider 出力が理由のケースを壊さない）', () => {
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
    storage.jobs.update(job.id, { stderr: 'compiling...\nrunning tests...\nFAIL: 3 tests failed' })

    const item = buildSystemState(storage, { now }).attention.find((a) => a.kind === 'job_blocked')

    expect(item?.detail).toContain('FAIL: 3 tests failed')
  })

  it('done な Task の blocked Job は attention に出さない（誰も解消できない履歴を残さない）', () => {
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

    // Task が pending の間は出る（従来どおり）
    expect(buildSystemState(storage, { now }).attention.some((a) => a.kind === 'job_blocked')).toBe(true)

    storage.tasks.update(task.id, { status: 'done', roadmapActive: false })
    const after = buildSystemState(storage, { now })

    expect(after.attention.some((a) => a.kind === 'job_blocked')).toBe(false)
    // totals の集計からは消さない（履歴としては残っている）
    expect(after.totals.jobs.blocked).toBe(1)
    expect(job.status).toBe('blocked')
  })

  it('done な Task でも quarantine は attention に出し続ける（workspace の実異常は Task status と無関係）', () => {
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
    storage.tasks.update(task.id, { status: 'done', roadmapActive: false })

    const state = buildSystemState(storage, { now })

    expect(state.attention.some((a) => a.kind === 'workspace_quarantined')).toBe(true)
    expect(state.totals.quarantinedJobs).toBe(1)
  })

  it('未完了 Task の最新 Job が failed なら attention に出す（いま止まっているもの）', () => {
    const { storage, projectId } = seed()
    const task = addTask(storage, projectId)
    const job = storage.jobs.create({
      taskId: task.id,
      projectId,
      agentRole: 'developer_ai',
      status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })
    storage.jobs.update(job.id, { stderr: 'provider timed out' })

    const item = buildSystemState(storage, { now }).attention.find((a) => a.kind === 'job_failed')

    expect(item).toBeDefined()
    expect(item?.jobId).toBe(job.id)
    expect(item?.detail).toContain('provider timed out')
  })

  it('done な Task の failed Job は出さない（履歴として残すだけ）', () => {
    const { storage, projectId } = seed()
    const task = addTask(storage, projectId)
    storage.jobs.create({
      taskId: task.id,
      projectId,
      agentRole: 'developer_ai',
      status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })
    storage.tasks.update(task.id, { status: 'done', roadmapActive: false })

    const state = buildSystemState(storage, { now })

    expect(state.attention.some((a) => a.kind === 'job_failed')).toBe(false)
    expect(state.totals.jobs.failed).toBe(1)
  })

  it('動かせる Job が残っていれば failed は出さない（既に引き継がれている）', () => {
    const { storage, projectId } = seed()
    const task = addTask(storage, projectId)
    storage.jobs.create({
      taskId: task.id,
      projectId,
      agentRole: 'developer_ai',
      status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })
    // 後続として作られた Job（これが動く限り、止まってはいない）
    storage.jobs.create({
      taskId: task.id,
      projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })

    expect(buildSystemState(storage, { now }).attention.some((a) => a.kind === 'job_failed')).toBe(false)
  })

  it('quarantine された failed は job_failed として二重に出さない', () => {
    const { storage, projectId } = seed()
    const task = addTask(storage, projectId)
    const job = storage.jobs.create({
      taskId: task.id,
      projectId,
      agentRole: 'developer_ai',
      status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })
    storage.jobs.update(job.id, {
      failureMetadata: { quarantined: true, quarantineReason: 'workspace could not be proven quiescent' },
    })

    const state = buildSystemState(storage, { now })

    expect(state.attention.some((a) => a.kind === 'job_failed')).toBe(false)
    expect(state.attention.some((a) => a.kind === 'workspace_quarantined')).toBe(true)
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
