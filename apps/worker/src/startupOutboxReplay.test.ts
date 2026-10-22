/**
 * lifecycle repair C2 / H-01: Worker 再起動時の Outbox replay と startup recovery の順序。
 *
 * 実際の outboxStore（一時ディレクトリの SQLite）と実際の recoverStaleJobs() を使い、API だけを
 * fetch の fake で置き換える。fake API は本物の `PATCH /api/jobs/:id` と同じく、
 * write-once の workspaceEndFingerprint を running→terminal 遷移でしか受け付けない。
 */
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const watchdogMocks = vi.hoisted(() => ({ startWatchdog: vi.fn() }))
const notifierMocks = vi.hoisted(() => ({ sendAlert: vi.fn() }))
const workspaceVerificationMocks = vi.hoisted(() => ({
  observeWorkspace: vi.fn(),
  verifyWorkspaceAgainstBaseline: vi.fn(),
  workspaceObservationMatchesBaseline: vi.fn(),
}))

vi.mock('./watchdog/watchdog.js', () => watchdogMocks)
vi.mock('./notifier/notifier.js', () => notifierMocks)
vi.mock('./workspaceVerification.js', () => workspaceVerificationMocks)

interface FakeJob {
  id: string
  taskId: string
  projectId: string
  status: 'queued' | 'running' | 'success' | 'failed' | 'blocked'
  safeCommand: { kind: string; workingDir: string }
  createdAt: string
  failureMetadata?: Record<string, unknown>
}

interface FakeApi {
  jobs: Map<string, FakeJob>
  /** true の間、`PATCH /api/jobs/:id` は 503 を返す（一時障害）。 */
  patchUnavailable: boolean
  failIfRunningCalls: string[]
  jobPatchStatuses: number[]
}

let tempRoot: string
let cwdSpy: { mockRestore: () => void }
let api: FakeApi

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function runningJob(id: string): FakeJob {
  return {
    id,
    taskId: 'task-1',
    projectId: 'project-1',
    status: 'running',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    createdAt: '2026-10-16T00:00:00.000Z',
  }
}

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input))
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined

  if (method === 'GET' && url.pathname === '/api/projects') {
    return Promise.resolve(jsonResponse([{ id: 'project-1', status: 'running' }]))
  }
  if (method === 'GET' && url.pathname === '/api/tasks') {
    return Promise.resolve(jsonResponse([{ id: 'task-1', projectId: 'project-1', status: 'in_progress' }]))
  }
  if (method === 'GET' && url.pathname === '/api/jobs') {
    return Promise.resolve(jsonResponse([...api.jobs.values()]))
  }

  const failIfRunning = /^\/api\/jobs\/([^/]+)\/fail-if-running$/.exec(url.pathname)
  if (method === 'PATCH' && failIfRunning) {
    const job = api.jobs.get(decodeURIComponent(failIfRunning[1]))
    if (!job) return Promise.resolve(jsonResponse({ error: 'not found' }, 404))
    api.failIfRunningCalls.push(job.id)
    if (job.status !== 'running') {
      return Promise.resolve(jsonResponse({ updated: false, currentStatus: job.status, job }))
    }
    job.status = body?.workspaceVerified === true ? 'failed' : 'blocked'
    return Promise.resolve(jsonResponse({ updated: true, currentStatus: job.status, job }))
  }

  const patchJob = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname)
  if (method === 'PATCH' && patchJob) {
    const job = api.jobs.get(decodeURIComponent(patchJob[1]))
    if (api.patchUnavailable) {
      api.jobPatchStatuses.push(503)
      return Promise.resolve(jsonResponse({ error: 'unavailable' }, 503))
    }
    if (!job) return Promise.resolve(jsonResponse({ error: 'not found' }, 404))
    const metadata = body?.failureMetadata as Record<string, unknown> | undefined
    if (metadata?.workspaceEndFingerprint !== undefined && job.status !== 'running') {
      api.jobPatchStatuses.push(409)
      return Promise.resolve(jsonResponse({
        error: 'workspaceEndFingerprint is only accepted on a running-to-terminal transition',
      }, 409))
    }
    job.status = body?.status as FakeJob['status']
    job.failureMetadata = metadata
    api.jobPatchStatuses.push(200)
    return Promise.resolve(jsonResponse({ job }))
  }

  // supervised run / task continuation reconcile など、本テストの関心外の呼び出し。
  return Promise.resolve(jsonResponse({}, 202))
}

/** Worker が terminal 結果を Outbox に記録した直後（PATCH 未適用）にクラッシュした状態を作る。 */
async function crashAfterOutboxRecord(jobId: string): Promise<void> {
  const store = await import('./outbox/outboxStore.js')
  store.recordPending(jobId, {
    status: 'success',
    exitCode: 0,
    completedAt: '2026-10-16T00:05:00.000Z',
    failureMetadata: { workspaceEndFingerprint: 'fingerprint-1' },
  } as never)
}

async function loadStore(): Promise<typeof import('./outbox/outboxStore.js')> {
  return await import('./outbox/outboxStore.js')
}

beforeEach(() => {
  vi.resetModules()
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'worker-startup-outbox-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempRoot)
  api = { jobs: new Map(), patchUnavailable: false, failIfRunningCalls: [], jobPatchStatuses: [] }
  watchdogMocks.startWatchdog.mockReset()
  notifierMocks.sendAlert.mockReset()
  notifierMocks.sendAlert.mockResolvedValue([])
  workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReset()
  workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({ verified: true })
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  cwdSpy.mockRestore()
  vi.resetModules()
})

function projectFetchCount(): number {
  return vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/projects').length
}

describe('startup Outbox replay before stale-Job recovery (H-01)', () => {
  it('crash after Outbox record -> restart: replay applies the terminal result, recovery leaves the Job alone, intake resumes', async () => {
    api.jobs.set('job-crashed', runningJob('job-crashed'))
    await crashAfterOutboxRecord('job-crashed')

    const { start } = await import('./index.js')
    void start()
    await vi.advanceTimersByTimeAsync(0)

    const store = await loadStore()
    expect(api.jobs.get('job-crashed')?.status).toBe('success')
    expect(api.jobs.get('job-crashed')?.failureMetadata).toEqual({ workspaceEndFingerprint: 'fingerprint-1' })
    expect(api.jobPatchStatuses).toEqual([200])
    expect(api.failIfRunningCalls).toEqual([])
    expect(store.hasPending()).toBe(false)

    // recovery（GET /api/projects 1回）に加えて、最初の poll cycle が queued Job fetch へ到達している
    expect(projectFetchCount()).toBeGreaterThanOrEqual(2)
    expect(vi.mocked(console.warn).mock.calls.some(([message]) =>
      String(message).includes('Pending Outbox events remain'))).toBe(false)
    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()
  })

  it('a transiently failing startup replay does not let recovery synthesize a competing terminal transition', async () => {
    api.jobs.set('job-crashed', runningJob('job-crashed'))
    api.jobs.set('job-orphan', runningJob('job-orphan'))
    await crashAfterOutboxRecord('job-crashed')
    api.patchUnavailable = true

    const { start } = await import('./index.js')
    void start()
    // 起動時 replay の patchJobWithRetry() は 500ms / 1000ms の backoff で3回試行する
    await vi.advanceTimersByTimeAsync(1_500)

    const store = await loadStore()
    // Outbox に結果を持つ Job は running のまま（次の replay に任せる）
    expect(api.jobs.get('job-crashed')?.status).toBe('running')
    expect(api.failIfRunningCalls).not.toContain('job-crashed')
    expect(store.hasPendingFor('job-crashed')).toBe(true)
    // Outbox に何も持たない running Job は従来どおり recovery される
    expect(api.failIfRunningCalls).toContain('job-orphan')
    expect(api.jobs.get('job-orphan')?.status).toBe('failed')

    // API が戻れば、通常 poll の既存再送が本当の結果を適用し、intake が再開する
    api.patchUnavailable = false
    await vi.advanceTimersByTimeAsync(15_000)

    expect(api.jobs.get('job-crashed')?.status).toBe('success')
    expect(api.jobs.get('job-crashed')?.failureMetadata).toEqual({ workspaceEndFingerprint: 'fingerprint-1' })
    expect(store.hasPending()).toBe(false)
    expect(api.jobPatchStatuses).not.toContain(409)
  })

  it('a definitively refused replay is surfaced through the existing CRITICAL Outbox alert (intake stays paused, not silent)', async () => {
    // 修正前の Worker の recovery が既に failed へ動かしてしまった Job（H-01 の残骸）。
    // replay は write-once / running→terminal 制約で毎回 409 になる。
    api.jobs.set('job-crashed', { ...runningJob('job-crashed'), status: 'failed' })
    await crashAfterOutboxRecord('job-crashed')

    const { start } = await import('./index.js')
    void start()
    // startup replay（3試行）+ poll cycle 3回分（各 3試行 + poll interval）
    await vi.advanceTimersByTimeAsync(30_000)

    const store = await loadStore()
    expect(store.hasPendingFor('job-crashed')).toBe(true)
    expect(api.jobPatchStatuses.every((status) => status === 409)).toBe(true)
    expect(api.failIfRunningCalls).toEqual([])
    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
    expect(notifierMocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical', title: 'Worker Outbox resend is blocked' }),
    )
  })
})
