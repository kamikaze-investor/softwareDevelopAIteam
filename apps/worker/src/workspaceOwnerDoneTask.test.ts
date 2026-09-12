/**
 * 終わった Task に取り残された blocked Job が workspace 所有権を握り続ける問題の回帰テスト。
 *
 * `resumeBlockedTask()` は**新しい Job を別行として作り、旧 blocked 行を監査証跡として残す**
 * （`approveAndResumeJob()` は同一行を `blocked -> queued` へ UPDATE するので滞留しない）。
 * そのため resume 経路でだけ「終わった Task に blocked 行が残る」状態が生まれ、
 * `findWorkspaceOwningTaskId()` が Job status しか見ていなかったために所有権が永久に残っていた。
 *
 * 実害: 期限切れ Approval からスマホで正規復旧して commit に成功しても所有権が解放されず、
 * 後続 Task / Project が進まない。解放手段が archive / pause しか無い状態は
 * 「スマホ完結の復旧」と言えない。Production で同一形状を4件観測している（下記 fixture）。
 *
 * **解放の判断は durable な自己申告ではなく worktree の実観測で行う。**
 * `task.status` は `PATCH /api/tasks/:id` が、`job.commitHash` は `PATCH /api/jobs/:id` が
 * いずれも検証なしで書き込めるうえ、`createdAt` の大小は因果順ではない。
 * 「もう dirty が無い」ことを証明できるのは worktree だけなので、そこを見る。
 * 取り残された行は **dirty が残っている間だけ**所有者として振る舞い、clean になれば手放す。
 *
 * 修正は `findWorkspaceOwningTaskId()` の blocked 分岐と、その候補を worktree 観測で解決する
 * `resolveWorkspaceOwnership()` の1段のみ。running / queued の判定、cleanup / quarantine /
 * resume / repair の条件は変更していない。
 */

import type { Job, Task } from '@ai-team/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const manifestMocks = vi.hoisted(() => ({ buildWorktreeManifest: vi.fn() }))
vi.mock('./guards/changeManifest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./guards/changeManifest.js')>()),
  buildWorktreeManifest: manifestMocks.buildWorktreeManifest,
}))

const gitOpMocks = vi.hoisted(() => ({ detectGitOperationState: vi.fn() }))
vi.mock('./guards/gitOperationState.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./guards/gitOperationState.js')>()),
  detectGitOperationState: gitOpMocks.detectGitOperationState,
}))

const outboxMocks = vi.hoisted(() => ({
  recordPending: vi.fn(), deletePending: vi.fn(), resendPending: vi.fn(), hasPending: vi.fn(),
}))
vi.mock('./outbox/outboxStore.js', () => outboxMocks)
vi.mock('./watchdog/watchdog.js', () => ({ startWatchdog: vi.fn() }))
vi.mock('./notifier/notifier.js', () => ({ sendAlert: vi.fn() }))

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

/** dirty path と進行中 git 操作を注入して所有権だけを判定する（ファイルシステムに触れない）。 */
function resolve(
  perTask: Array<{ task: Task; jobs: Job[] }>,
  dirtyPaths: string[],
  gitOperations: string[] = [],
) {
  return resolveWorkspaceOwnership(
    perTask, '/workspace/target', () => dirtyPaths, () => HEAD, () => gitOperations,
  )
}

/**
 * Production で実際に観測された滞留形状。
 *
 * `initial-implement` success → `implement:…:review` success →
 * `review:…:git-commit` **blocked**（期限切れ Approval で止まった行）→
 * `resume:…:1` success（スマホから正規復旧して commit 成功）→ Task は `done`。
 *
 * 2026-09-12 時点の4件。いずれも同一形状で、いずれも archived / paused によってしか
 * 所有権が解放されていなかった。
 */
const PRODUCTION_STALE_OWNERS = [
  { task: '1d50d5d7', blockedJob: 'e60ba617', commitJob: 'e8aee395', commit: 'ac81f6b', project: 'Production E2E test 10' },
  { task: '240d1949', blockedJob: '9b1789e2', commitJob: '0dba4c5f', commit: '36077e2', project: 'Phase1b Approval Level 較正検証用' },
  { task: '3a1aff17', blockedJob: '83041277', commitJob: 'bcaa7a13', commit: 'fab74ba', project: 'Phase1 Shadow Gate 検証用' },
  { task: '9a9c9423', blockedJob: '7a014347', commitJob: 'c346facc', commit: 'ad781bc', project: 'E2E確認用プロジェクト9' },
] as const

function productionStaleOwnerTask(fixture: typeof PRODUCTION_STALE_OWNERS[number]): { task: Task; jobs: Job[] } {
  const t = task(fixture.task, { status: 'done' })
  return {
    task: t,
    jobs: [
      job(`${fixture.task}-implement`, t.id, {
        status: 'success', workflowStepKey: `task:${t.id}:initial-implement`, changedFiles: ['test.js'],
      }),
      job(`${fixture.task}-review`, t.id, {
        status: 'success', workflowStepKey: `implement:${fixture.task}-implement:review`, changedFiles: ['test.js'],
      }),
      // 期限切れ Approval で止まったまま残っている行（resumeBlockedTask は触らない）。
      job(fixture.blockedJob, t.id, {
        status: 'blocked', workflowStepKey: `review:${fixture.task}-review:git-commit`,
      }),
      // スマホからの正規復旧で作られた新しい行。commit が landed して Task は done になった。
      job(fixture.commitJob, t.id, {
        status: 'success', workflowStepKey: `resume:${fixture.blockedJob}:1`,
        changedFiles: ['test.js'], commitHash: fixture.commit,
      }),
    ],
  }
}

function mockApi(tasks: Task[], jobsByTask: Record<string, Job[]>, projectStatus = 'running'): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.includes('/api/projects')) {
      return new Response(JSON.stringify([{ id: PROJECT_ID, status: projectStatus }]), { status: 200 })
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

beforeEach(() => {
  manifestMocks.buildWorktreeManifest.mockReset()
  manifestMocks.buildWorktreeManifest.mockReturnValue({ paths: [], changes: [] })
  jobRunnerMocks.getCommitHash.mockReset()
  jobRunnerMocks.getCommitHash.mockReturnValue(HEAD)
  gitOpMocks.detectGitOperationState.mockReset()
  gitOpMocks.detectGitOperationState.mockReturnValue([])
  outboxMocks.hasPending.mockReturnValue(false)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('終わった Task の滞留 blocked Job: worktree が clean なら所有権を手放す', () => {
  it('done Task の滞留 blocked Job は、worktree が clean なら owner にならない', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      { task: done, jobs: [job('stale-blocked', done.id, { status: 'blocked' })] },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'none' })
  })

  it.each(PRODUCTION_STALE_OWNERS)(
    'Production 実例 $project（task $task / blocked $blockedJob）でも owner にならない',
    (fixture) => {
      expect(resolve([productionStaleOwnerTask(fixture)], [])).toEqual({ kind: 'none' })
    },
  )

  it('done Task を飛ばした先に本物の owner がいればそちらを返す', () => {
    const done = task('task-done', { status: 'done' })
    const blocked = task('task-blocked', { status: 'blocked' })
    const perTask = [
      { task: done, jobs: [job('stale-blocked', done.id, { status: 'blocked' })] },
      { task: blocked, jobs: [job('live-blocked', blocked.id, { status: 'blocked' })] },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'owner', taskId: 'task-blocked' })
  })
})

describe('dirty が残っている間は手放さない（durable な自己申告を信用しない）', () => {
  /**
   * 独立レビューの指摘: durable な値はどれも「もう dirty が無い」ことの証明にならない。
   * `task.status` は `PATCH /api/tasks/:id` が、`job.commitHash` は `PATCH /api/jobs/:id` が
   * いずれも検証なしで書き込め、`createdAt` の大小は因果順ではない。
   * したがって解放は worktree の実観測だけで決める。dirty なら由来を問わず保持する。
   */
  it('外部から done にされただけで dirty が残っていれば owner を維持する', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [job('blocked-with-dirty', done.id, { status: 'blocked', changedFiles: ['test.js'] })],
      },
    ]

    expect(resolve(perTask, ['test.js'])).toEqual({ kind: 'owner', taskId: 'task-done' })
  })

  it('commitHash があっても dirty が残っていれば owner を維持する（commit 後の残差）', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [
          job('stale-blocked', done.id, { status: 'blocked' }),
          job('committed', done.id, { status: 'success', commitHash: 'ac81f6b' }),
        ],
      },
    ]

    expect(resolve(perTask, ['leftover.js'])).toEqual({ kind: 'owner', taskId: 'task-done' })
  })

  it.each(PRODUCTION_STALE_OWNERS)(
    'Production 実例 $project も dirty が残っていれば owner を維持する',
    (fixture) => {
      expect(resolve([productionStaleOwnerTask(fixture)], ['test.js']))
        .toEqual({ kind: 'owner', taskId: fixture.task })
    },
  )

  it('滞留候補が複数あって dirty なら、任意に選ばず fail-closed', () => {
    const a = task('task-a', { status: 'done' })
    const b = task('task-b', { status: 'done' })
    const perTask = [
      { task: a, jobs: [job('stale-a', a.id, { status: 'blocked' })] },
      { task: b, jobs: [job('stale-b', b.id, { status: 'blocked' })] },
    ]

    expect(resolve(perTask, ['test.js'])).toEqual({ kind: 'ambiguous' })
  })

  /**
   * 独立レビュー指摘（CLAIM 19）: `computeWorkspaceBaseline()` は manifest を読む**前に**
   * `detectGitOperationState()` で fail-closed する。manifest が空でも `index.lock` /
   * `MERGE_HEAD` / rebase 途中が残っていれば次の Task は始められないため、
   * そこで手放すと所有者不在のまま後続 Task が必ず落ちる。
   */
  it('manifest が空でも進行中の git 操作があれば owner を維持する（admission と同じ clean 定義）', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      { task: done, jobs: [job('stale-blocked', done.id, { status: 'blocked' })] },
    ]

    expect(resolve(perTask, [], ['MERGE_HEAD'])).toEqual({ kind: 'owner', taskId: 'task-done' })
  })

  it('git 操作の検出に失敗した場合も「無い」とみなさず owner を維持する', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      { task: done, jobs: [job('stale-blocked', done.id, { status: 'blocked' })] },
    ]

    const result = resolveWorkspaceOwnership(
      perTask, '/workspace/target', () => [], () => HEAD,
      () => { throw new Error('git status failed') },
    )

    expect(result).toEqual({ kind: 'owner', taskId: 'task-done' })
  })

  it('進行中の git 操作の確認は manifest が空のときだけ行う（dirty なら呼ばない）', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      { task: done, jobs: [job('stale-blocked', done.id, { status: 'blocked' })] },
    ]

    const readGitOps = vi.fn(() => [] as string[])
    const result = resolveWorkspaceOwnership(
      perTask, '/workspace/target', () => ['test.js'], () => HEAD, readGitOps,
    )

    expect(result).toEqual({ kind: 'owner', taskId: 'task-done' })
    expect(readGitOps).not.toHaveBeenCalled()
  })

  it('worktree を観測できない場合は「dirty 無し」とみなさず fail-closed', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      { task: done, jobs: [job('stale-blocked', done.id, { status: 'blocked' })] },
    ]

    const result = resolveWorkspaceOwnership(perTask, '/workspace/target', () => {
      throw new Error('git failed')
    }, () => HEAD, () => [])

    expect(result).toEqual({ kind: 'ambiguous' })
  })
})

describe('quarantine された blocked Job は worktree が clean でも手放さない', () => {
  it('hard invariant: quarantine 済みは done でも owner を維持する', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [job('quarantined-blocked', done.id, {
          status: 'blocked',
          failureMetadata: { quarantined: true, quarantineReason: 'workspace baseline failure' },
        })],
      },
    ]

    // clean な worktree でも解放しない。
    expect(resolve(perTask, [])).toEqual({ kind: 'owner', taskId: 'task-done' })
  })

  it('quarantine 済みは worktree を観測せずに owner を確定する', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [job('quarantined-blocked', done.id, {
          status: 'blocked',
          failureMetadata: { quarantined: true, quarantineReason: 'workspace baseline failure' },
        })],
      },
    ]

    const readDirty = vi.fn(() => [] as string[])
    const result = resolveWorkspaceOwnership(perTask, '/workspace/target', readDirty, () => HEAD, () => [])

    expect(result).toEqual({ kind: 'owner', taskId: 'task-done' })
    expect(readDirty).not.toHaveBeenCalled()
  })
})

describe('running / queued の判定は変更していない', () => {
  it('running Job は Task が done でも従来どおり owner（worktree を観測しない）', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      { task: done, jobs: [job('running-job', done.id, { status: 'running' })] },
    ]

    const readDirty = vi.fn(() => [] as string[])
    const result = resolveWorkspaceOwnership(perTask, '/workspace/target', readDirty, () => HEAD, () => [])

    expect(result).toEqual({ kind: 'owner', taskId: 'task-done' })
    expect(readDirty).not.toHaveBeenCalled()
  })

  it('initial-implement 以外の queued Job は Task が done でも従来どおり owner', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [job('queued-resume', done.id, { status: 'queued', workflowStepKey: 'resume:stale-blocked:1' })],
      },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'owner', taskId: 'task-done' })
  })

  it('done Task の initial-implement queued Job は従来どおり owner にしない', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [job('queued-initial', done.id, {
          status: 'queued', workflowStepKey: `task:${done.id}:initial-implement`,
        })],
      },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'none' })
  })

  it('pending Task の blocked Job は従来どおり owner のまま（worktree を観測しない）', () => {
    const pending = task('task-pending', { status: 'pending' })
    const perTask = [
      { task: pending, jobs: [job('blocked-job', pending.id, { status: 'blocked' })] },
    ]

    const readDirty = vi.fn(() => [] as string[])
    const result = resolveWorkspaceOwnership(perTask, '/workspace/target', readDirty, () => HEAD, () => [])

    expect(result).toEqual({ kind: 'owner', taskId: 'task-pending' })
    expect(readDirty).not.toHaveBeenCalled()
  })

  it('blocked Task の blocked Job は従来どおり owner のまま', () => {
    const blocked = task('task-blocked', { status: 'blocked' })
    const perTask = [
      { task: blocked, jobs: [job('blocked-job', blocked.id, { status: 'blocked' })] },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'owner', taskId: 'task-blocked' })
  })
})

describe('resume / repair 中の dirty ownership を壊さないこと', () => {
  it('resume 中（Task は done ではない）の dirty ownership は維持される', () => {
    const a = task('task-a', { status: 'pending' })
    const perTask = [
      {
        task: a,
        jobs: [
          job('job-a', a.id, { status: 'blocked', changedFiles: ['test.js'] }),
          job('job-a-resume', a.id, { status: 'queued', workflowStepKey: 'resume:job-a:1' }),
        ],
      },
    ]

    expect(resolve(perTask, ['test.js'])).toEqual({ kind: 'owner', taskId: 'task-a' })
  })

  it('repair 中（Task は blocked）の dirty ownership は維持される', () => {
    const a = task('task-a', { status: 'blocked' })
    const perTask = [
      {
        task: a,
        jobs: [
          job('job-a', a.id, { status: 'blocked', changedFiles: ['test.js'] }),
          job('job-a-repair', a.id, { status: 'queued', workflowStepKey: 'repair:job-a:1' }),
        ],
      },
    ]

    expect(resolve(perTask, ['test.js'])).toEqual({ kind: 'owner', taskId: 'task-a' })
  })

  it('M1-a の fallback（blocked Task + 帰属できる dirty）は影響を受けない', () => {
    const a = task('task-a', { status: 'blocked' })
    const perTask = [
      { task: a, jobs: [job('job-a', a.id, { status: 'failed', changedFiles: ['test.js'] })] },
    ]

    expect(resolve(perTask, ['test.js'])).toEqual({ kind: 'owner', taskId: 'task-a' })
  })
})

describe('fetchQueuedJob: clean になれば running Project でも所有権を手放す', () => {
  it('commit 成功で clean になった後、archive/pause せずに次 Task を claim できる', async () => {
    const done = task('task-1', { status: 'done' })
    const next = task('task-2')
    mockApi([done, next], {
      [done.id]: [job('stale-blocked', done.id, { status: 'blocked' })],
      [next.id]: [job('job-2', next.id, {
        status: 'queued', workflowStepKey: `task:${next.id}:initial-implement`,
      })],
    })

    const work = await fetchQueuedJob()

    expect(work?.job.id).toBe('job-2')
    expect(work?.task.id).toBe('task-2')
  })

  it.each(PRODUCTION_STALE_OWNERS)(
    'Production 実例 $project の滞留行があっても次 Task を claim できる',
    async (fixture) => {
      const stale = productionStaleOwnerTask(fixture)
      const next = task('task-next')
      mockApi([stale.task, next], {
        [stale.task.id]: [...stale.jobs],
        [next.id]: [job('job-next', next.id, {
          status: 'queued', workflowStepKey: `task:${next.id}:initial-implement`,
        })],
      })

      const work = await fetchQueuedJob()

      expect(work?.job.id).toBe('job-next')
    },
  )

  it('滞留行があっても worktree が dirty なら次 Task を claim しない', async () => {
    const done = task('task-1', { status: 'done' })
    const next = task('task-2')
    manifestMocks.buildWorktreeManifest.mockReturnValue({ paths: ['test.js'], changes: [] })
    mockApi([done, next], {
      [done.id]: [job('stale-blocked', done.id, { status: 'blocked' })],
      [next.id]: [job('job-2', next.id, {
        status: 'queued', workflowStepKey: `task:${next.id}:initial-implement`,
      })],
    })

    expect(await fetchQueuedJob()).toBeNull()
  })

  it('外部から done にされただけの Task が dirty を抱えていれば次 Task を claim しない', async () => {
    const done = task('task-1', { status: 'done' })
    const next = task('task-2')
    manifestMocks.buildWorktreeManifest.mockReturnValue({ paths: ['test.js'], changes: [] })
    mockApi([done, next], {
      [done.id]: [job('blocked-with-dirty', done.id, { status: 'blocked', changedFiles: ['test.js'] })],
      [next.id]: [job('job-2', next.id, {
        status: 'queued', workflowStepKey: `task:${next.id}:initial-implement`,
      })],
    })

    expect(await fetchQueuedJob()).toBeNull()
  })

  it('done Task がまだ quarantine を抱えている場合は次 Task を claim しない', async () => {
    const done = task('task-1', { status: 'done' })
    const next = task('task-2')
    mockApi([done, next], {
      [done.id]: [job('quarantined-blocked', done.id, {
        status: 'blocked',
        failureMetadata: { quarantined: true, quarantineReason: 'workspace baseline failure' },
      })],
      [next.id]: [job('job-2', next.id, {
        status: 'queued', workflowStepKey: `task:${next.id}:initial-implement`,
      })],
    })

    expect(await fetchQueuedJob()).toBeNull()
  })

  it('修正前に唯一の解放手段だった archive/pause は、引き続き same-as-before で除外される', async () => {
    const done = task('task-1', { status: 'done' })
    const next = task('task-2')
    mockApi([done, next], {
      [done.id]: [job('stale-blocked', done.id, { status: 'blocked' })],
      [next.id]: [job('job-2', next.id, {
        status: 'queued', workflowStepKey: `task:${next.id}:initial-implement`,
      })],
    }, 'archived')

    // running でない Project はそもそも perTask に入らない = claim 対象が無い。
    expect(await fetchQueuedJob()).toBeNull()
  })

  it('滞留行を無視しても、その Task の Job を二重に claim しない', async () => {
    const done = task('task-1', { status: 'done' })
    const next = task('task-2')
    mockApi([done, next], {
      // 滞留 blocked 行は owner ではなくなるが、queued ではないので claim 対象にもならない。
      [done.id]: [
        job('stale-blocked', done.id, { status: 'blocked' }),
        job('committed', done.id, { status: 'success', workflowStepKey: 'resume:stale-blocked:1' }),
      ],
      [next.id]: [job('job-2', next.id, {
        status: 'queued', workflowStepKey: `task:${next.id}:initial-implement`,
      })],
    })

    const first = await fetchQueuedJob()
    expect(first?.job.id).toBe('job-2')

    // 同じ状態をもう一度評価しても、返るのは同じ1件だけ（新しい Job は作られない）。
    const second = await fetchQueuedJob()
    expect(second?.job.id).toBe('job-2')
    expect(second?.task.id).toBe('task-2')
  })

  it('poll cost: 強い owner がいる cycle では worktree を観測しない', async () => {
    const running = task('task-1')
    const next = task('task-2')
    mockApi([running, next], {
      [running.id]: [job('running-job', running.id, { status: 'running' })],
      [next.id]: [job('job-2', next.id, {
        status: 'queued', workflowStepKey: `task:${next.id}:initial-implement`,
      })],
    })

    await fetchQueuedJob()

    expect(manifestMocks.buildWorktreeManifest).not.toHaveBeenCalled()
  })

  // 注: これは**所有権判定が行う観測**の回数。claim 後の
  // `computeWorkspaceBaseline()` は admission のために別途 manifest を読むので、
  // poll cycle 全体としては 1 回ではない（それは本 PR 以前からの既存挙動）。
  it('poll cost: 所有権判定が行う worktree 観測は 1 cycle あたり最大1回', async () => {
    const done = task('task-1', { status: 'done' })
    const next = task('task-2')
    mockApi([done, next], {
      [done.id]: [job('stale-blocked', done.id, { status: 'blocked' })],
      [next.id]: [job('job-2', next.id, {
        status: 'queued', workflowStepKey: `task:${next.id}:initial-implement`,
      })],
    })

    await fetchQueuedJob()

    expect(manifestMocks.buildWorktreeManifest).toHaveBeenCalledTimes(1)
  })
})
