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
}): void {
  fetchMock.mockImplementation(async (url) => {
    const href = String(url)
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

  it('9. does not serialize across unrelated Projects when only one is running (paused Projects\' active Jobs are ignored)', async () => {
    const taskA = task({ id: 'task-a', projectId: 'project-paused' })
    const taskB = task({ id: 'task-b', projectId: 'project-1' })
    mockEndpoints({
      projects: [project(), project({ id: 'project-paused', status: 'paused' })],
      tasksByProjectId: {
        'project-1': [taskB],
        'project-paused': [taskA],
      },
      jobsByTaskId: {
        // task-a (paused Project) has a stale running Job, but its Project is not running,
        // so it must not block task-b in the currently running Project.
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
