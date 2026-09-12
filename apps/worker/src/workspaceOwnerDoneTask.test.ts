/**
 * commit が landed した後に取り残された blocked Job が workspace 所有権を握り続ける問題の回帰テスト。
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
 * 判定は **Task の status だけを信用しない**。`PATCH /api/tasks/:id` は `status: 'done'` を
 * 検証なしで書き込めるため、durable な**実際の commit 痕跡**（当該 blocked 行より後に作られた
 * `commitHash` 持ちの Job）を要求する。
 *
 * 修正は `findWorkspaceOwningTaskId()` の blocked 分岐のみ。
 * running / queued の判定、cleanup / quarantine / resume / repair の条件は変更していない。
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

const jobRunnerMocks = vi.hoisted(() => ({ getCommitHash: vi.fn() }))
vi.mock('./jobRunner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jobRunner.js')>()),
  getCommitHash: jobRunnerMocks.getCommitHash,
}))

import { fetchQueuedJob, resolveWorkspaceOwnership } from './index.js'

const PROJECT_ID = 'project-1'
const HEAD = 'head0000000000000000000000000000000000000'
const COMMIT = 'cf53e84000000000000000000000000000000000'

/** blocked 行より前 / 後 を明確にするための固定時刻。 */
const T_IMPLEMENT = '2026-09-11T00:00:00.000Z'
const T_REVIEW = '2026-09-11T00:01:00.000Z'
const T_BLOCKED = '2026-09-11T00:02:00.000Z'
const T_RESUMED = '2026-09-11T00:03:00.000Z'

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id, projectId: PROJECT_ID, title: id, description: '', status: 'pending',
    assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    createdAt: T_IMPLEMENT, updatedAt: T_IMPLEMENT,
    ...overrides,
  }
}

function job(id: string, taskId: string, overrides: Partial<Job> = {}): Job {
  return {
    id, taskId, projectId: PROJECT_ID, agentRole: 'developer_ai', status: 'failed',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    createdAt: T_BLOCKED,
    workspaceBaseline: { mode: 'clean', startCommitHash: HEAD },
    ...overrides,
  }
}

/** dirty path を注入して所有権だけを判定する（ファイルシステムに触れない）。 */
function resolve(perTask: Array<{ task: Task; jobs: Job[] }>, dirtyPaths: string[]) {
  return resolveWorkspaceOwnership(perTask, '/workspace/target', () => dirtyPaths, () => HEAD)
}

/**
 * Production で実際に観測された滞留形状。
 *
 * `initial-implement` success → `implement:…:review` success →
 * `review:…:git-commit` **blocked**（期限切れ Approval で止まった行）→
 * `resume:…:1` success + commitHash（スマホから正規復旧して commit 成功）→ Task は `done`。
 *
 * 2026-09-12 時点の4件。いずれも同一形状で、いずれも archived / paused によってしか
 * 所有権が解放されていなかった。実 DB で4件とも「`commitHash` を持つ Job が blocked 行より後に
 * 存在する」ことを確認済み（done Task 13件すべてが commitHash 持ちの Job を持つ）。
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
        status: 'success', createdAt: T_IMPLEMENT,
        workflowStepKey: `task:${t.id}:initial-implement`, changedFiles: ['test.js'],
      }),
      job(`${fixture.task}-review`, t.id, {
        status: 'success', createdAt: T_REVIEW,
        workflowStepKey: `implement:${fixture.task}-implement:review`, changedFiles: ['test.js'],
      }),
      // 期限切れ Approval で止まったまま残っている行（resumeBlockedTask は触らない）。
      job(fixture.blockedJob, t.id, {
        status: 'blocked', createdAt: T_BLOCKED,
        workflowStepKey: `review:${fixture.task}-review:git-commit`,
      }),
      // スマホからの正規復旧で作られた新しい行。commit が landed して Task は done になった。
      job(fixture.commitJob, t.id, {
        status: 'success', createdAt: T_RESUMED,
        workflowStepKey: `resume:${fixture.blockedJob}:1`,
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
  outboxMocks.hasPending.mockReturnValue(false)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('findWorkspaceOwningTaskId: commit が landed した後の滞留 blocked Job', () => {
  it('done Task の滞留 blocked Job は、後から landed した commit があれば owner にならない', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [
          job('stale-blocked', done.id, { status: 'blocked', createdAt: T_BLOCKED }),
          job('committed', done.id, { status: 'success', createdAt: T_RESUMED, commitHash: COMMIT }),
        ],
      },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'none' })
  })

  it.each(PRODUCTION_STALE_OWNERS)(
    'Production 実例 $project（task $task / blocked $blockedJob）でも owner にならない',
    (fixture) => {
      expect(resolve([productionStaleOwnerTask(fixture)], [])).toEqual({ kind: 'none' })
    },
  )

  it('pending Task の blocked Job は従来どおり owner のまま', () => {
    const pending = task('task-pending', { status: 'pending' })
    const perTask = [
      { task: pending, jobs: [job('blocked-job', pending.id, { status: 'blocked' })] },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'owner', taskId: 'task-pending' })
  })

  it('blocked Task の blocked Job は従来どおり owner のまま', () => {
    const blocked = task('task-blocked', { status: 'blocked' })
    const perTask = [
      { task: blocked, jobs: [job('blocked-job', blocked.id, { status: 'blocked' })] },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'owner', taskId: 'task-blocked' })
  })

  it('quarantine された blocked Job は commit 済みでも owner を維持する（hard invariant）', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [
          job('quarantined-blocked', done.id, {
            status: 'blocked', createdAt: T_BLOCKED,
            failureMetadata: { quarantined: true, quarantineReason: 'workspace baseline failure' },
          }),
          job('committed', done.id, { status: 'success', createdAt: T_RESUMED, commitHash: COMMIT }),
        ],
      },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'owner', taskId: 'task-done' })
  })

  it('done Task を飛ばした先に本物の owner がいればそちらを返す', () => {
    const done = task('task-done', { status: 'done' })
    const blocked = task('task-blocked', { status: 'blocked' })
    const perTask = [
      {
        task: done,
        jobs: [
          job('stale-blocked', done.id, { status: 'blocked', createdAt: T_BLOCKED }),
          job('committed', done.id, { status: 'success', createdAt: T_RESUMED, commitHash: COMMIT }),
        ],
      },
      { task: blocked, jobs: [job('live-blocked', blocked.id, { status: 'blocked' })] },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'owner', taskId: 'task-blocked' })
  })
})

describe('status の自己申告だけでは所有権を手放さない', () => {
  /**
   * 独立レビュー指摘: `PATCH /api/tasks/:id` は `status: 'done'` を**検証なしで**書き込む
   * （`apps/api/src/routes/tasks.ts`）。done という自己申告だけで所有権を外すと、dirty を
   * 抱えたまま外部から done にされた Task の変更が owner 不在になり、後続 Task の
   * initial-implement が clean worktree 要件で死ぬ。
   */
  it('外部から done にされただけで commit 痕跡が無ければ owner を維持する', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [job('blocked-with-dirty', done.id, { status: 'blocked', changedFiles: ['test.js'] })],
      },
    ]

    expect(resolve(perTask, ['test.js'])).toEqual({ kind: 'owner', taskId: 'task-done' })
  })

  it('commit が blocked 行より前にしか無ければ owner を維持する（追い越されていない）', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [
          job('older-commit', done.id, { status: 'success', createdAt: T_IMPLEMENT, commitHash: COMMIT }),
          job('blocked-after-commit', done.id, {
            status: 'blocked', createdAt: T_BLOCKED, changedFiles: ['test.js'],
          }),
        ],
      },
    ]

    expect(resolve(perTask, ['test.js'])).toEqual({ kind: 'owner', taskId: 'task-done' })
  })

  it('createdAt が同値なら追い越しと見なさず owner を維持する（安全側）', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [
          job('blocked-job', done.id, { status: 'blocked', createdAt: T_BLOCKED }),
          job('same-time-commit', done.id, { status: 'success', createdAt: T_BLOCKED, commitHash: COMMIT }),
        ],
      },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'owner', taskId: 'task-done' })
  })
})

describe('running / queued の判定は変更していない', () => {
  it('running Job は Task が done でも従来どおり owner', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [
          job('running-job', done.id, { status: 'running' }),
          job('committed', done.id, { status: 'success', createdAt: T_RESUMED, commitHash: COMMIT }),
        ],
      },
    ]

    expect(resolve(perTask, [])).toEqual({ kind: 'owner', taskId: 'task-done' })
  })

  it('initial-implement 以外の queued Job は Task が done でも従来どおり owner', () => {
    const done = task('task-done', { status: 'done' })
    const perTask = [
      {
        task: done,
        jobs: [
          job('queued-resume', done.id, { status: 'queued', workflowStepKey: 'resume:stale-blocked:1' }),
          job('committed', done.id, { status: 'success', createdAt: T_RESUMED, commitHash: COMMIT }),
        ],
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
})

describe('resume / repair 中の dirty ownership を壊さないこと', () => {
  it('resume 中（commit 前）の dirty ownership は維持される', () => {
    // resume 実行中は commit 前なので commit 痕跡が無い。done 条件は発火しない。
    const a = task('task-a', { status: 'pending' })
    const perTask = [
      {
        task: a,
        jobs: [
          job('job-a', a.id, { status: 'blocked', changedFiles: ['test.js'] }),
          job('job-a-resume', a.id, { status: 'queued', createdAt: T_RESUMED, workflowStepKey: 'resume:job-a:1' }),
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
          job('job-a-repair', a.id, { status: 'queued', createdAt: T_RESUMED, workflowStepKey: 'repair:job-a:1' }),
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

describe('fetchQueuedJob: commit が landed すれば running Project でも所有権を手放す', () => {
  function staleDoneTaskJobs(taskId: string): Job[] {
    return [
      job('stale-blocked', taskId, { status: 'blocked', createdAt: T_BLOCKED }),
      job('committed', taskId, { status: 'success', createdAt: T_RESUMED, commitHash: COMMIT }),
    ]
  }

  it('commit 成功で done になった後、archive/pause せずに次 Task を claim できる', async () => {
    const done = task('task-1', { status: 'done' })
    const next = task('task-2')
    mockApi([done, next], {
      [done.id]: staleDoneTaskJobs(done.id),
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

  it('修正前に唯一の解放手段だった archive/pause は、引き続き same-as-before で除外される', async () => {
    const done = task('task-1', { status: 'done' })
    const next = task('task-2')
    mockApi([done, next], {
      [done.id]: staleDoneTaskJobs(done.id),
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
      [done.id]: staleDoneTaskJobs(done.id),
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

  it('done Task がまだ quarantine を抱えている場合は次 Task を claim しない', async () => {
    const done = task('task-1', { status: 'done' })
    const next = task('task-2')
    mockApi([done, next], {
      [done.id]: [
        job('quarantined-blocked', done.id, {
          status: 'blocked', createdAt: T_BLOCKED,
          failureMetadata: { quarantined: true, quarantineReason: 'workspace baseline failure' },
        }),
        job('committed', done.id, { status: 'success', createdAt: T_RESUMED, commitHash: COMMIT }),
      ],
      [next.id]: [job('job-2', next.id, {
        status: 'queued', workflowStepKey: `task:${next.id}:initial-implement`,
      })],
    })

    expect(await fetchQueuedJob()).toBeNull()
  })

  it('外部から done にされただけの Task が dirty を抱えていれば次 Task を claim しない', async () => {
    const done = task('task-1', { status: 'done' })
    const next = task('task-2')
    mockApi([done, next], {
      [done.id]: [job('blocked-with-dirty', done.id, { status: 'blocked', changedFiles: ['test.js'] })],
      [next.id]: [job('job-2', next.id, {
        status: 'queued', workflowStepKey: `task:${next.id}:initial-implement`,
      })],
    })

    expect(await fetchQueuedJob()).toBeNull()
  })
})
