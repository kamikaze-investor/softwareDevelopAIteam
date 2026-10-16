import type { Job, Project, Task } from '@ai-team/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchQueuedJob } from './index.js'

/**
 * fetchQueuedJob() の workspace 排他ロジックの検証。
 *
 * すべての Job は TARGET_WORKING_DIR という単一の共有ディレクトリを使うため、
 * あるTaskのJobが running/blocked（＝working treeに未commitの変更が残り得る）の間、
 * 別Taskのqueued Jobをclaimしてはならない。
 */

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'P',
    goal: 'G',
    designPhilosophy: [],
    status: 'running',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-a',
    projectId: 'project-1',
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: true,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  }
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    taskId: 'task-a',
    projectId: 'project-1',
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    createdAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * fetchQueuedJob() が叩くエンドポイント（/api/projects, /api/tasks?projectId=,
 * /api/jobs?taskId=）をURLで振り分けて応答するfetchモックを組み立てる。
 */
function mockEndpoints(input: {
  projects: Project[]
  tasksByProjectId: Record<string, Task[]>
  jobsByTaskId: Record<string, Job[]>
  /** この部分文字列を含む URL は 500 を返す（一覧取得の失敗注入）。 */
  failingUrls?: string[]
}): void {
  fetchMock.mockImplementation(async (url) => {
    const href = String(url)
    if (input.failingUrls?.some((fragment) => href.includes(fragment))) {
      return new Response('unavailable', { status: 500 })
    }
    const body = href.includes('/api/projects')
      ? input.projects
      : href.includes('/api/tasks?projectId=')
        ? input.tasksByProjectId[decodeURIComponent(href.split('projectId=')[1])] ?? []
        : href.includes('/api/jobs?taskId=')
          ? input.jobsByTaskId[decodeURIComponent(href.split('taskId=')[1])] ?? []
          : (() => { throw new Error(`unexpected URL in test: ${href}`) })()
    return new Response(JSON.stringify(body), { status: 200 })
  })
}

describe('fetchQueuedJob workspace exclusivity', () => {
  it('1. does not claim Task B\'s queued Job while Task A has an uncommitted (running) Job', async () => {
    const taskA = task({ id: 'task-a' })
    const taskB = task({ id: 'task-b' })
    mockEndpoints({
      projects: [project()],
      tasksByProjectId: { 'project-1': [taskA, taskB] },
      jobsByTaskId: {
        'task-a': [job({ id: 'job-a-1', taskId: 'task-a', status: 'running' })],
        'task-b': [job({ id: 'job-b-1', taskId: 'task-b', status: 'queued' })],
      },
    })

    const result = await fetchQueuedJob()

    expect(result).toBeNull()
  })

  it('2. claims Task B\'s queued Job once Task A\'s Job reaches a terminal state (success)', async () => {
    const taskA = task({ id: 'task-a' })
    const taskB = task({ id: 'task-b' })
    mockEndpoints({
      projects: [project()],
      tasksByProjectId: { 'project-1': [taskA, taskB] },
      jobsByTaskId: {
        'task-a': [job({ id: 'job-a-1', taskId: 'task-a', status: 'success' })],
        'task-b': [job({ id: 'job-b-1', taskId: 'task-b', status: 'queued' })],
      },
    })

    const result = await fetchQueuedJob()

    expect(result?.job.id).toBe('job-b-1')
  })

  it('5. does not let Task B start while Task A is mid-repair-chain (repair Job running)', async () => {
    const taskA = task({ id: 'task-a' })
    const taskB = task({ id: 'task-b' })
    mockEndpoints({
      projects: [project()],
      tasksByProjectId: { 'project-1': [taskA, taskB] },
      jobsByTaskId: {
        'task-a': [
          job({ id: 'job-a-1', taskId: 'task-a', status: 'failed', workflowStepKey: 'task:task-a:initial-implement' }),
          job({ id: 'job-a-2', taskId: 'task-a', status: 'running', workflowStepKey: 'repair:job-a-1:1' }),
        ],
        'task-b': [job({ id: 'job-b-1', taskId: 'task-b', status: 'queued' })],
      },
    })

    const result = await fetchQueuedJob()

    expect(result).toBeNull()
  })

  it('6. does not let Task B claim while Task A is blocked awaiting git_commit CEO approval', async () => {
    const taskA = task({ id: 'task-a' })
    const taskB = task({ id: 'task-b' })
    mockEndpoints({
      projects: [project()],
      tasksByProjectId: { 'project-1': [taskA, taskB] },
      jobsByTaskId: {
        'task-a': [job({ id: 'job-a-1', taskId: 'task-a', status: 'blocked', safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' } })],
        'task-b': [job({ id: 'job-b-1', taskId: 'task-b', status: 'queued' })],
      },
    })

    const result = await fetchQueuedJob()

    expect(result).toBeNull()
  })

  it('allows Task A to continue claiming its own follow-up queued Job while it is the workspace owner', async () => {
    const taskA = task({ id: 'task-a' })
    mockEndpoints({
      projects: [project()],
      tasksByProjectId: { 'project-1': [taskA] },
      jobsByTaskId: {
        'task-a': [
          job({ id: 'job-a-1', taskId: 'task-a', status: 'blocked' }),
          job({ id: 'job-a-2', taskId: 'task-a', status: 'queued', workflowStepKey: 'resume:job-a-1:1' }),
        ],
      },
    })

    const result = await fetchQueuedJob()

    expect(result?.job.id).toBe('job-a-2')
  })

  it("does not let Task B claim while Task A's approved git_commit Job sits queued again (approveAndResumeJob blocked->queued window)", async () => {
    const taskA = task({ id: 'task-a' })
    const taskB = task({ id: 'task-b' })
    mockEndpoints({
      projects: [project()],
      tasksByProjectId: { 'project-1': [taskA, taskB] },
      jobsByTaskId: {
        'task-a': [
          job({ id: 'job-a-1', taskId: 'task-a', status: 'success', workflowStepKey: 'task:task-a:initial-implement' }),
          job({ id: 'job-a-2', taskId: 'task-a', status: 'success', workflowStepKey: 'implement:job-a-1:review' }),
          // approveAndResumeJob() just flipped this back to 'queued' (from 'blocked') -
          // it is not literally running/blocked right now, but it is Task A's own
          // git_commit continuation, not a fresh unclaimed initial-implement Job.
          job({ id: 'job-a-3', taskId: 'task-a', status: 'queued', workflowStepKey: 'review:job-a-2:git-commit' }),
        ],
        'task-b': [job({ id: 'job-b-1', taskId: 'task-b', status: 'queued', workflowStepKey: 'task:task-b:initial-implement' })],
      },
    })

    const result = await fetchQueuedJob()

    expect(result?.job.id).toBe('job-a-3')
  })

  it("9. a paused Project's running Job still owns the single target workspace (W5)", async () => {
    // 以前の前提「無関係な Project は直列化しない」は誤り。workspace は deployment ごとに1つ
    // （TARGET_ROOT）なので、paused Project の未 commit の Job の上で別 Project を走らせてはならない。
    const taskA = task({ id: 'task-a', projectId: 'project-paused' })
    const taskB = task({ id: 'task-b', projectId: 'project-1' })
    mockEndpoints({
      projects: [project(), project({ id: 'project-paused', status: 'paused' })],
      tasksByProjectId: {
        'project-1': [taskB],
        'project-paused': [taskA],
      },
      jobsByTaskId: {
        'task-a': [job({ id: 'job-a-1', taskId: 'task-a', status: 'running' })],
        // initial-implement の queued は所有者にならない。所有者は paused Project の task-a だけ。
        'task-b': [job({
          id: 'job-b-1', taskId: 'task-b', status: 'queued', workflowStepKey: 'task:task-b:initial-implement',
        })],
      },
    })

    const result = await fetchQueuedJob()

    expect(result).toBeNull()
  })

  it("9b. a paused Project's blocked owner blocks a running Project's initial-implement claim, and its own queued Job is never claimed (W5)", async () => {
    const taskA = task({ id: 'task-a', projectId: 'project-paused', status: 'blocked' })
    const taskB = task({ id: 'task-b', projectId: 'project-1' })
    mockEndpoints({
      projects: [project(), project({ id: 'project-paused', status: 'paused' })],
      tasksByProjectId: {
        'project-1': [taskB],
        'project-paused': [taskA],
      },
      jobsByTaskId: {
        'task-a': [
          job({ id: 'job-a-2', taskId: 'task-a', status: 'queued', workflowStepKey: 'retry:job-a-1:1' }),
          job({ id: 'job-a-1', taskId: 'task-a', status: 'blocked' }),
        ],
        'task-b': [job({
          id: 'job-b-1', taskId: 'task-b', status: 'queued', workflowStepKey: 'task:task-b:initial-implement',
        })],
      },
    })

    const result = await fetchQueuedJob()

    // 所有者（paused Project の task-a）は claim 対象外、他 Task は所有者でないので claim しない。
    expect(result).toBeNull()
  })

  it('9c. a paused Project with no owner never has its queued Job claimed, while a running Project can proceed (W5)', async () => {
    const taskA = task({ id: 'task-a', projectId: 'project-paused' })
    const taskB = task({ id: 'task-b', projectId: 'project-1' })
    mockEndpoints({
      projects: [project({ id: 'project-paused', status: 'paused' }), project()],
      tasksByProjectId: {
        'project-1': [taskB],
        'project-paused': [taskA],
      },
      jobsByTaskId: {
        'task-a': [job({
          id: 'job-a-1', taskId: 'task-a', status: 'queued', workflowStepKey: 'task:task-a:initial-implement',
        })],
        'task-b': [job({
          id: 'job-b-1', taskId: 'task-b', status: 'queued', workflowStepKey: 'task:task-b:initial-implement',
        })],
      },
    })

    const result = await fetchQueuedJob()

    expect(result?.job.id).toBe('job-b-1')
  })

  it("9d. two owners at once (a running Project's and a paused Project's) are ambiguous: nothing is claimed (W5)", async () => {
    // 以前は API の並び順で先に来た方を所有者にし、その queued Job を claim していた。
    const taskA = task({ id: 'task-a', projectId: 'project-paused' })
    const taskB = task({ id: 'task-b', projectId: 'project-1' })
    mockEndpoints({
      projects: [project(), project({ id: 'project-paused', status: 'paused' })],
      tasksByProjectId: {
        'project-1': [taskB],
        'project-paused': [taskA],
      },
      jobsByTaskId: {
        'task-a': [job({ id: 'job-a-1', taskId: 'task-a', status: 'running' })],
        // repair の続き（initial-implement 以外の queued）なので task-b も所有者になる。
        'task-b': [job({ id: 'job-b-1', taskId: 'task-b', status: 'queued', workflowStepKey: 'repair:job-b-0:1' })],
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await fetchQueuedJob()

    expect(result).toBeNull()
    expect(warn.mock.calls.some(([message]) => String(message).includes('task-b, task-a'))).toBe(true)
    warn.mockRestore()
  })

  it.each([
    ["the paused Project's Task listing", '/api/tasks?projectId=project-paused'],
    ["the paused owner's Job listing", '/api/jobs?taskId=task-a'],
  ])('claims nothing when %s cannot be read (fail-closed, W5)', async (_label, failingUrl) => {
    // 読めなかった一覧を飛ばすと、paused Project の blocked 所有者が判定から消え、
    // running Project の initial-implement を claim してしまう。
    const taskA = task({ id: 'task-a', projectId: 'project-paused', status: 'blocked' })
    const taskB = task({ id: 'task-b', projectId: 'project-1' })
    mockEndpoints({
      projects: [project({ id: 'project-paused', status: 'paused' }), project()],
      tasksByProjectId: { 'project-1': [taskB], 'project-paused': [taskA] },
      jobsByTaskId: {
        'task-a': [job({ id: 'job-a-1', taskId: 'task-a', status: 'blocked' })],
        'task-b': [job({
          id: 'job-b-1', taskId: 'task-b', status: 'queued', workflowStepKey: 'task:task-b:initial-implement',
        })],
      },
      failingUrls: [failingUrl],
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await fetchQueuedJob()

    expect(result).toBeNull()
    warn.mockRestore()
  })

  it('archived Projects do not take part in workspace ownership', async () => {
    const taskA = task({ id: 'task-a', projectId: 'project-archived' })
    const taskB = task({ id: 'task-b', projectId: 'project-1' })
    mockEndpoints({
      projects: [project(), project({ id: 'project-archived', status: 'archived' })],
      tasksByProjectId: { 'project-1': [taskB], 'project-archived': [taskA] },
      jobsByTaskId: {
        'task-a': [job({ id: 'job-a-1', taskId: 'task-a', status: 'running' })],
        'task-b': [job({ id: 'job-b-1', taskId: 'task-b', status: 'queued' })],
      },
    })

    const result = await fetchQueuedJob()

    expect(result?.job.id).toBe('job-b-1')
  })

  it('returns null when no Project is running', async () => {
    mockEndpoints({
      projects: [project({ status: 'paused' })],
      tasksByProjectId: {},
      jobsByTaskId: {},
    })

    const result = await fetchQueuedJob()

    expect(result).toBeNull()
  })
})
