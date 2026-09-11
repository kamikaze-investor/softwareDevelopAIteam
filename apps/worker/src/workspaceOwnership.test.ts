/**
 * M1-a: recoverable dirty workspace ownership
 *
 * PR #150 以降、review が structured result を返せず escalate された Task は
 * Job が `failed`・Task が `blocked` になる。この dirty は `resume:` が正統に継承するため
 * **掃除してはならない**が、`failed` Job は既存の所有者条件（running / blocked /
 * initial-implement 以外の queued）に入らないため所有者不在になり、Worker が次の Task へ進み、
 * その initial-implement が clean worktree 要件で死んでいた。
 *
 * ここでは「現に dirty が残っており、durable な attribution で説明でき、repair/retry/resume が
 * 継承しうる blocked Task」を fallback 所有者として扱うことを固定する。
 * cleanup は一切行わない。quarantine / clear-quarantine の条件も変更しない。
 */

import type { Job, Task } from '@ai-team/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const manifestMocks = vi.hoisted(() => ({ buildWorktreeManifest: vi.fn() }))
vi.mock('./guards/changeManifest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./guards/changeManifest.js')>()),
  buildWorktreeManifest: manifestMocks.buildWorktreeManifest,
}))

const outboxMocks = vi.hoisted(() => ({
  recordPending: vi.fn(), deletePending: vi.fn(), resendPending: vi.fn(), hasPending: vi.fn(),
}))
vi.mock('./outbox/outboxStore.js', () => outboxMocks)
vi.mock('./watchdog/watchdog.js', () => ({ startWatchdog: vi.fn() }))
vi.mock('./notifier/notifier.js', () => ({ sendAlert: vi.fn() }))

// fetchQueuedJob 経由のテストでは実 worktree を読ませない（HEAD も注入する）。
const jobRunnerMocks = vi.hoisted(() => ({ getCommitHash: vi.fn() }))
vi.mock('./jobRunner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jobRunner.js')>()),
  getCommitHash: jobRunnerMocks.getCommitHash,
}))

import { fetchQueuedJob, resolveWorkspaceOwnership } from './index.js'

const PROJECT_ID = 'project-1'
const HEAD = 'head0000000000000000000000000000000000000'

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id, projectId: PROJECT_ID, title: id, description: '', status: 'pending',
    assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  }
}

function job(id: string, taskId: string, overrides: Partial<Job> = {}): Job {
  return {
    id, taskId, projectId: PROJECT_ID, agentRole: 'developer_ai', status: 'failed',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    createdAt: '2026-09-11T00:00:00.000Z',
    workspaceBaseline: { mode: 'clean', startCommitHash: HEAD },
    ...overrides,
  }
}

/** dirty path を注入して所有権だけを判定する（ファイルシステムに触れない）。 */
function resolve(perTask: Array<{ task: Task; jobs: Job[] }>, dirtyPaths: string[], head: string | undefined = HEAD) {
  return resolveWorkspaceOwnership(perTask, '/workspace/target', () => dirtyPaths, () => head)
}

beforeEach(() => {
  manifestMocks.buildWorktreeManifest.mockReset()
  jobRunnerMocks.getCommitHash.mockReset()
  jobRunnerMocks.getCommitHash.mockReturnValue(HEAD)
  outboxMocks.hasPending.mockReturnValue(false)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('resolveWorkspaceOwnership', () => {
  it('blocked Task A が自分由来の dirty を保持していれば A が owner になる', () => {
    const a = task('task-a', { status: 'blocked' })
    const b = task('task-b')
    const perTask = [
      { task: a, jobs: [job('job-a', a.id, { status: 'failed', changedFiles: ['test.js'] })] },
      { task: b, jobs: [job('job-b', b.id, { status: 'queued', workflowStepKey: `task:${b.id}:initial-implement` })] },
    ]

    expect(resolve(perTask, ['test.js'])).toEqual({ kind: 'owner', taskId: 'task-a' })
  })

  it('dirty が無ければ blocked Task を owner 扱いしない', () => {
    const a = task('task-a', { status: 'blocked' })
    const perTask = [
      { task: a, jobs: [job('job-a', a.id, { status: 'failed', changedFiles: ['test.js'] })] },
    ]

    // commit 済み等で worktree が clean。ownership は自然に消える。
    expect(resolve(perTask, [])).toEqual({ kind: 'none' })
  })

  it('dirty があっても自分の changedFiles と交差しなければ owner にならない', () => {
    const a = task('task-a', { status: 'blocked' })
    const perTask = [
      { task: a, jobs: [job('job-a', a.id, { status: 'failed', changedFiles: ['other.js'] })] },
    ]

    expect(resolve(perTask, ['test.js'])).toEqual({ kind: 'none' })
  })

  it('quarantine された Task は継承先が無いので fallback owner にしない', () => {
    const a = task('task-a', { status: 'blocked' })
    const perTask = [
      {
        task: a,
        jobs: [job('job-a', a.id, {
          status: 'blocked',
          changedFiles: ['test.js'],
          failureMetadata: { quarantined: true, quarantineReason: 'workspace baseline failure' },
        })],
      },
    ]

    // `blocked` Job なので既存条件で owner になる（挙動不変）。fallback 判定には入らない。
    expect(resolve(perTask, ['test.js'])).toEqual({ kind: 'owner', taskId: 'task-a' })

    // Job が failed へ落ちて既存条件を外れた場合は、quarantine ゆえ候補にしない。
    const perTask2 = [
      {
        task: a,
        jobs: [job('job-a2', a.id, {
          status: 'failed',
          changedFiles: ['test.js'],
          failureMetadata: { quarantined: true, quarantineReason: 'workspace baseline failure' },
        })],
      },
    ]
    expect(resolve(perTask2, ['test.js'])).toEqual({ kind: 'none' })
  })

  it('複数の blocked Task が同じ dirty path に一致したら任意選択せず fail-closed', () => {
    const a = task('task-a', { status: 'blocked' })
    const b = task('task-b', { status: 'blocked' })
    const perTask = [
      { task: a, jobs: [job('job-a', a.id, { status: 'failed', changedFiles: ['test.js'] })] },
      { task: b, jobs: [job('job-b', b.id, { status: 'failed', changedFiles: ['test.js'] })] },
    ]

    expect(resolve(perTask, ['test.js'])).toEqual({ kind: 'ambiguous' })
  })

  it('既存の所有者条件が優先され、挙動は変わらない（worktree は読まない）', () => {
    const a = task('task-a')
    const b = task('task-b', { status: 'blocked' })
    const perTask = [
      { task: a, jobs: [job('job-a', a.id, { status: 'running' })] },
      { task: b, jobs: [job('job-b', b.id, { status: 'failed', changedFiles: ['test.js'] })] },
    ]

    const readDirty = vi.fn(() => ['test.js'])
    const result = resolveWorkspaceOwnership(perTask, '/workspace/target', readDirty)

    expect(result).toEqual({ kind: 'owner', taskId: 'task-a' })
    // 既存 owner がいる限り worktree を観測しない（既存挙動を一切変えない）。
    expect(readDirty).not.toHaveBeenCalled()
  })

  it('worktree を観測できない場合は「dirty 無し」とみなさず fail-closed', () => {
    const a = task('task-a', { status: 'blocked' })
    const perTask = [
      { task: a, jobs: [job('job-a', a.id, { status: 'failed', changedFiles: ['test.js'] })] },
    ]

    const result = resolveWorkspaceOwnership(perTask, '/workspace/target', () => {
      throw new Error('not a git repository')
    })

    expect(result).toEqual({ kind: 'ambiguous' })
  })

  it('同じ durable state と同じ worktree からは同じ判定になる（restart 後も再現する）', () => {
    const a = task('task-a', { status: 'blocked' })
    const perTask = [
      { task: a, jobs: [job('job-a', a.id, { status: 'failed', changedFiles: ['test.js'] })] },
    ]

    // 判定材料は DB（task.status / job.changedFiles）と worktree だけで、
    // プロセス内の状態に依存しない。再計算すれば同じ結果になる。
    const first = resolve(perTask, ['test.js'])
    const second = resolve(perTask, ['test.js'])
    expect(first).toEqual(second)
    expect(first).toEqual({ kind: 'owner', taskId: 'task-a' })
  })

  it('その Job 以降に何かがコミットされていれば（HEAD が baseline と不一致）owner にしない', () => {
    // 独立レビュー指摘（CLAIM 7）: A の変更が既に commit 済みで、同じ path が別の由来で
    // 再び dirty になっただけ、というケースで A を誤って owner にしてはいけない。
    const a = task('task-a', { status: 'blocked' })
    const perTask = [
      { task: a, jobs: [job('job-a', a.id, { status: 'failed', changedFiles: ['src/foo.ts'] })] },
    ]

    expect(resolve(perTask, ['src/foo.ts'], 'different000000000000000000000000000000')).toEqual({ kind: 'none' })
  })

  it('baseline を持たない Job は帰属を証明できないので owner にしない', () => {
    const a = task('task-a', { status: 'blocked' })
    const perTask = [
      { task: a, jobs: [job('job-a', a.id, { status: 'failed', changedFiles: ['src/foo.ts'], workspaceBaseline: undefined })] },
    ]

    expect(resolve(perTask, ['src/foo.ts'])).toEqual({ kind: 'none' })
  })

  it('帰属を説明できない dirty path が混ざっていれば fail-closed', () => {
    // A の記録で説明できない変更（人手・別経路）が残っている場合、A を owner に決めない。
    const a = task('task-a', { status: 'blocked' })
    const perTask = [
      { task: a, jobs: [job('job-a', a.id, { status: 'failed', changedFiles: ['test.js'] })] },
    ]

    expect(resolve(perTask, ['test.js', 'someone-elses.ts'])).toEqual({ kind: 'ambiguous' })
  })
})

describe('fetchQueuedJob: fallback owner による claim 制御', () => {
  function mockApi(tasks: Task[], jobsByTask: Record<string, Job[]>): void {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes('/api/projects')) {
        return new Response(JSON.stringify([{ id: PROJECT_ID, status: 'running' }]), { status: 200 })
      }
      if (u.includes('/api/tasks')) {
        return new Response(JSON.stringify(tasks), { status: 200 })
      }
      if (u.includes('/api/jobs')) {
        const taskId = decodeURIComponent(u.split('taskId=')[1] ?? '')
        return new Response(JSON.stringify(jobsByTask[taskId] ?? []), { status: 200 })
      }
      return new Response('null', { status: 200 })
    }))
  }

  it('blocked Task A が dirty を保持している間、Task B の normal Job は claim されない', async () => {
    const a = task('task-a', { status: 'blocked' })
    const b = task('task-b')
    manifestMocks.buildWorktreeManifest.mockReturnValue({ paths: ['test.js'], changes: [] })
    mockApi([a, b], {
      [a.id]: [job('job-a', a.id, { status: 'failed', changedFiles: ['test.js'] })],
      [b.id]: [job('job-b', b.id, { status: 'queued', workflowStepKey: `task:${b.id}:initial-implement` })],
    })

    expect(await fetchQueuedJob()).toBeNull()
  })

  it('owner Task 自身の resume: Job は claim できる', async () => {
    const a = task('task-a', { status: 'blocked' })
    const b = task('task-b')
    manifestMocks.buildWorktreeManifest.mockReturnValue({ paths: ['test.js'], changes: [] })
    const resumeJob = job('job-a-resume', a.id, {
      status: 'queued', workflowStepKey: 'resume:job-a:1', aiCliMode: 'implement',
    })
    mockApi([a, b], {
      [a.id]: [job('job-a', a.id, { status: 'failed', changedFiles: ['test.js'] }), resumeJob],
      [b.id]: [job('job-b', b.id, { status: 'queued', workflowStepKey: `task:${b.id}:initial-implement` })],
    })

    const work = await fetchQueuedJob()
    expect(work?.job.id).toBe('job-a-resume')
  })

  it('commit 等で workspace が clean になれば ownership は解除され Task B が進める', async () => {
    const a = task('task-a', { status: 'blocked' })
    const b = task('task-b')
    // dirty 無し = A の保持は終わっている。
    manifestMocks.buildWorktreeManifest.mockReturnValue({ paths: [], changes: [] })
    mockApi([a, b], {
      [a.id]: [job('job-a', a.id, { status: 'failed', changedFiles: ['test.js'] })],
      [b.id]: [job('job-b', b.id, { status: 'queued', workflowStepKey: `task:${b.id}:initial-implement` })],
    })

    const work = await fetchQueuedJob()
    expect(work?.job.id).toBe('job-b')
  })

  it('attribution が曖昧なときは他 Task の normal Job を claim しない', async () => {
    const a = task('task-a', { status: 'blocked' })
    const b = task('task-b', { status: 'blocked' })
    const c = task('task-c')
    manifestMocks.buildWorktreeManifest.mockReturnValue({ paths: ['test.js'], changes: [] })
    mockApi([a, b, c], {
      [a.id]: [job('job-a', a.id, { status: 'failed', changedFiles: ['test.js'] })],
      [b.id]: [job('job-b', b.id, { status: 'failed', changedFiles: ['test.js'] })],
      [c.id]: [job('job-c', c.id, { status: 'queued', workflowStepKey: `task:${c.id}:initial-implement` })],
    })

    expect(await fetchQueuedJob()).toBeNull()
  })
})
