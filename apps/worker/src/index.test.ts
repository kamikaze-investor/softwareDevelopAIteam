import type { Job, Task } from '@ai-team/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobRunResult } from './jobRunner.js'
import { ContainmentInfrastructureError } from './execution/runContainedCommand.js'

const outboxMocks = vi.hoisted(() => ({
  recordPending: vi.fn(),
  deletePending: vi.fn(),
  resendPending: vi.fn(),
  hasPending: vi.fn(),
  hasPendingFor: vi.fn(),
}))

const jobStateMocks = vi.hoisted(() => ({
  recoverStaleJobs: vi.fn(),
}))

const watchdogMocks = vi.hoisted(() => ({
  startWatchdog: vi.fn(),
}))

const notifierMocks = vi.hoisted(() => ({
  sendAlert: vi.fn(),
}))

const jobRunnerMocks = vi.hoisted(() => ({
  computeWorkspaceBaseline: vi.fn(),
  revertBlockedJobChanges: vi.fn(),
}))

const workspaceVerificationMocks = vi.hoisted(() => ({
  observeWorkspace: vi.fn(),
  verifyWorkspaceAgainstBaseline: vi.fn(),
  workspaceObservationMatchesBaseline: vi.fn(),
}))

vi.mock('./outbox/outboxStore.js', () => outboxMocks)
vi.mock('./watchdog/watchdog.js', () => watchdogMocks)
vi.mock('./notifier/notifier.js', () => notifierMocks)
vi.mock('./jobRunner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jobRunner.js')>()
  return {
    ...actual,
    computeWorkspaceBaseline: jobRunnerMocks.computeWorkspaceBaseline,
    revertBlockedJobChanges: jobRunnerMocks.revertBlockedJobChanges,
  }
})
vi.mock('./workspaceVerification.js', () => workspaceVerificationMocks)
vi.mock('./jobStateManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jobStateManager.js')>()
  return {
    ...actual,
    recoverStaleJobs: jobStateMocks.recoverStaleJobs,
  }
})

import {
  patchJobWithRetry,
  pollJobs,
  reconcileSupervisedRuns,
  reconcileTaskContinuations,
  persistJobResult,
  processQueuedWork,
  reportAbortCleanupObservations,
  clearPendingAbortCleanupSubmissions,
  pendingAbortCleanupSubmissionJobIds,
  hasPendingAbortCleanupSubmissions,
  start,
} from './index.js'

const NOW = '2026-08-08T01:02:03.000Z'
const fetchMock = vi.fn<typeof fetch>()

const CLEAN_BASELINE = { mode: 'clean', startCommitHash: 'abc123' } as const

const job: Job = {
  id: 'job-1',
  taskId: 'task-1',
  projectId: 'project-1',
  agentRole: 'developer_ai',
  status: 'queued',
  safeCommand: { kind: 'test', workingDir: '/workspace/target' },
  createdAt: '2026-08-08T00:00:00.000Z',
}

const task: Task = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Test task',
  description: '',
  status: 'pending',
  assignee: 'developer_ai',
  dependencies: [],
  roadmapActive: false,
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
}

const runResult: JobRunResult = {
  status: 'success',
  exitCode: 0,
  stdout: 'safe stdout',
  stderr: '',
  changedFiles: ['src/feature.ts'],
  guardResult: {
    permissionAllowed: true,
    fileChangeAllowed: true,
    fileViolations: [],
  },
  startedAt: '2026-08-08T00:01:00.000Z',
  completedAt: '2026-08-08T00:02:00.000Z',
}

beforeEach(() => {
  fetchMock.mockReset()
  outboxMocks.recordPending.mockReset()
  outboxMocks.deletePending.mockReset()
  outboxMocks.resendPending.mockReset()
  outboxMocks.hasPending.mockReset()
  outboxMocks.hasPendingFor.mockReset()
  jobStateMocks.recoverStaleJobs.mockReset()
  watchdogMocks.startWatchdog.mockReset()
  notifierMocks.sendAlert.mockReset()
  jobRunnerMocks.computeWorkspaceBaseline.mockReset()
  jobRunnerMocks.revertBlockedJobChanges.mockReset()
  workspaceVerificationMocks.observeWorkspace.mockReset()
  workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReset()
  workspaceVerificationMocks.workspaceObservationMatchesBaseline.mockReset()
  outboxMocks.recordPending.mockReturnValue({
    eventId: 'event-1',
    payloadHash: 'payload-hash-1',
  })
  outboxMocks.resendPending.mockResolvedValue(undefined)
  outboxMocks.hasPending.mockReturnValue(false)
  outboxMocks.hasPendingFor.mockReturnValue(false)
  jobStateMocks.recoverStaleJobs.mockResolvedValue(0)
  notifierMocks.sendAlert.mockResolvedValue([])
  jobRunnerMocks.computeWorkspaceBaseline.mockReturnValue({ ok: true, baseline: CLEAN_BASELINE })
  jobRunnerMocks.revertBlockedJobChanges.mockResolvedValue(undefined)
  workspaceVerificationMocks.observeWorkspace.mockReturnValue({
    observation: CLEAN_BASELINE,
    knownGood: {
      gitOperationMarkers: [],
      worktreeClean: true,
      indexClean: true,
      headValid: true,
      blindSpotsAbsent: true,
    },
  })
  workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({ verified: true })
  workspaceVerificationMocks.workspaceObservationMatchesBaseline.mockReturnValue(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('abort cleanup observation reporting', () => {
  function arrangeAbortCleanup(
    taskStatus: Task['status'],
    jobStatus: Job['status'],
    marked = true,
  ): void {
    const project = {
      id: 'project-1',
      name: 'AIteamOS',
      goal: 'g',
      designPhilosophy: [],
      status: 'running',
      createdAt: NOW,
      updatedAt: NOW,
    }
    const requestedTask: Task = {
      ...task,
      status: taskStatus,
      roadmapActive: taskStatus === 'blocked',
    }
    const requestedJob: Job = {
      ...job,
      status: jobStatus,
      safeCommand: taskStatus === 'blocked' && jobStatus === 'blocked'
        ? { kind: 'git_commit', workingDir: '/workspace/target' }
        : job.safeCommand,
      ...(marked
        ? {
            failureMetadata: {
              abortCleanupRequestedAt: NOW,
              abortApprovalRequestId: 'approval-1',
            },
          }
        : {}),
    }
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const value = String(url)
      if (value.endsWith('/api/projects')) {
        return new Response(JSON.stringify([project]), { status: 200 })
      }
      if (value.includes('/api/tasks?projectId=')) {
        return new Response(JSON.stringify([requestedTask]), { status: 200 })
      }
      if (value.includes('/api/jobs?taskId=')) {
        return new Response(JSON.stringify([requestedJob]), { status: 200 })
      }
      if (value.includes('/abort-cleanup-result')) return new Response(null, { status: 200 })
      throw new Error(`unexpected fetch ${value}`)
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  it.each(['failed', 'success'] as const)(
    'reports the marked terminal %s Job while its Task is blocked',
    async (jobStatus) => {
      arrangeAbortCleanup('blocked', jobStatus)

      await expect(reportAbortCleanupObservations()).resolves.toBe(true)

      expect(workspaceVerificationMocks.observeWorkspace).toHaveBeenCalledWith('/workspace/target')
      const report = fetchMock.mock.calls.find(([url]) => String(url).includes('/abort-cleanup-result'))
      expect(report).toBeDefined()
      expect(JSON.parse(String(report?.[1]?.body))).toEqual({
        observation: CLEAN_BASELINE,
        knownGood: {
          gitOperationMarkers: [],
          worktreeClean: true,
          indexClean: true,
          headValid: true,
          blindSpotsAbsent: true,
        },
      })
    },
  )

  it.each(['failed', 'success'] as const)(
    'ignores a marked terminal %s Job after the Task becomes pending',
    async (jobStatus) => {
      arrangeAbortCleanup('pending', jobStatus)

      await expect(reportAbortCleanupObservations()).resolves.toBe(false)

      expect(workspaceVerificationMocks.observeWorkspace).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/abort-cleanup-result'))).toBe(false)
    },
  )

  it('keeps the existing pending Task + blocked Job reporting behavior', async () => {
    arrangeAbortCleanup('pending', 'blocked')

    await expect(reportAbortCleanupObservations()).resolves.toBe(true)

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/abort-cleanup-result'))).toBe(true)
  })

  it('reports an API-marked latest blocked git_commit without modifying the workspace', async () => {
    arrangeAbortCleanup('blocked', 'blocked')

    await expect(reportAbortCleanupObservations()).resolves.toBe(true)

    expect(workspaceVerificationMocks.observeWorkspace).toHaveBeenCalledTimes(1)
    expect(workspaceVerificationMocks.verifyWorkspaceAgainstBaseline).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/abort-cleanup-result'))).toBe(true)
  })

  it('REJECT alone has no cleanup marker and is not observed', async () => {
    arrangeAbortCleanup('blocked', 'blocked', false)

    await expect(reportAbortCleanupObservations()).resolves.toBe(false)

    expect(workspaceVerificationMocks.observeWorkspace).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/abort-cleanup-result'))).toBe(false)
  })

  it('does not report an old marked terminal Job after a newer Job exists', async () => {
    const project = {
      id: 'project-1', name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
      createdAt: NOW, updatedAt: NOW,
    }
    const requestedTask: Task = { ...task, status: 'blocked', roadmapActive: true }
    const newerJob: Job = { ...job, id: 'job-newer', status: 'failed' }
    const oldMarkedJob: Job = {
      ...job,
      id: 'job-old-marked',
      status: 'failed',
      failureMetadata: {
        abortCleanupRequestedAt: NOW,
        abortApprovalRequestId: 'approval-1',
      },
    }
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const value = String(url)
      if (value.endsWith('/api/projects')) return new Response(JSON.stringify([project]), { status: 200 })
      if (value.includes('/api/tasks?projectId=')) {
        return new Response(JSON.stringify([requestedTask]), { status: 200 })
      }
      if (value.includes('/api/jobs?taskId=')) {
        return new Response(JSON.stringify([newerJob, oldMarkedJob]), { status: 200 })
      }
      throw new Error(`unexpected fetch ${value}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(reportAbortCleanupObservations()).resolves.toBe(false)

    expect(workspaceVerificationMocks.observeWorkspace).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/abort-cleanup-result'))).toBe(false)
  })

  it('continues to later cleanup candidates when an earlier report is refused', async () => {
    const project = {
      id: 'project-1', name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
      createdAt: NOW, updatedAt: NOW,
    }
    const tasks: Task[] = [
      { ...task, id: 'task-refused', status: 'pending' },
      { ...task, id: 'task-accepted', status: 'pending' },
    ]
    const markedJob = (id: string, taskId: string): Job => ({
      ...job,
      id,
      taskId,
      status: 'blocked',
      failureMetadata: {
        abortCleanupRequestedAt: NOW,
        abortApprovalRequestId: `approval-${id}`,
      },
    })
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const value = String(url)
      if (value.endsWith('/api/projects')) return new Response(JSON.stringify([project]), { status: 200 })
      if (value.includes('/api/tasks?projectId=')) return new Response(JSON.stringify(tasks), { status: 200 })
      if (value.includes('/api/jobs?taskId=task-refused')) {
        return new Response(JSON.stringify([markedJob('job-refused', 'task-refused')]), { status: 200 })
      }
      if (value.includes('/api/jobs?taskId=task-accepted')) {
        return new Response(JSON.stringify([markedJob('job-accepted', 'task-accepted')]), { status: 200 })
      }
      if (value.includes('/api/jobs/job-refused/abort-cleanup-result')) {
        return new Response(JSON.stringify({ error: 'refused' }), { status: 409 })
      }
      if (value.includes('/api/jobs/job-accepted/abort-cleanup-result')) {
        return new Response(null, { status: 200 })
      }
      throw new Error(`unexpected fetch ${value}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(reportAbortCleanupObservations()).resolves.toBe(true)

    const reports = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/abort-cleanup-result'))
    expect(reports).toEqual([
      expect.stringContaining('/api/jobs/job-refused/abort-cleanup-result'),
      expect.stringContaining('/api/jobs/job-accepted/abort-cleanup-result'),
    ])
  })

  it('verifies Technical Abort cleanup against the persisted END fingerprint, not the START baseline', async () => {
    const endFingerprint = { mode: 'clean' as const, startCommitHash: 'end-head' }
    const project = {
      id: 'project-1', name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
      createdAt: NOW, updatedAt: NOW,
    }
    const requestedTask: Task = { ...task, status: 'blocked', roadmapActive: true }
    const requestedJob: Job = {
      ...job,
      status: 'failed',
      workspaceBaseline: CLEAN_BASELINE,
      failureMetadata: {
        workspaceEndFingerprint: endFingerprint,
        abortCleanupRequestedAt: NOW,
        abortTechnicalEvidenceId: 'evidence-1',
      },
    }
    workspaceVerificationMocks.observeWorkspace.mockReturnValue({
      observation: endFingerprint,
      knownGood: {
        gitOperationMarkers: [], worktreeClean: true, indexClean: true,
        headValid: true, blindSpotsAbsent: true,
      },
    })
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const value = String(url)
      if (value.endsWith('/api/projects')) return new Response(JSON.stringify([project]), { status: 200 })
      if (value.includes('/api/tasks?projectId=')) return new Response(JSON.stringify([requestedTask]), { status: 200 })
      if (value.includes('/api/jobs?taskId=')) return new Response(JSON.stringify([requestedJob]), { status: 200 })
      if (value.includes('/abort-cleanup-result')) return new Response(null, { status: 200 })
      throw new Error(`unexpected fetch ${value}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(reportAbortCleanupObservations()).resolves.toBe(true)
    expect(workspaceVerificationMocks.verifyWorkspaceAgainstBaseline)
      .toHaveBeenCalledWith('/workspace/target', endFingerprint)
  })

  it('reports mixed manual and Technical Abort metadata without reverting files', async () => {
    const dirtyObservation = {
      mode: 'dirty' as const,
      startCommitHash: 'end-head',
      entries: [{ path: 'src/feature.ts', kind: 'added' as const, worktreeHash: 'sha256:value-free' }],
    }
    const project = {
      id: 'project-1', name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
      createdAt: NOW, updatedAt: NOW,
    }
    const requestedTask: Task = { ...task, status: 'blocked', roadmapActive: true }
    const requestedJob: Job = {
      ...job,
      status: 'failed',
      failureMetadata: {
        workspaceEndFingerprint: dirtyObservation,
        abortCleanupRequestedAt: NOW,
        abortApprovalRequestId: 'approval-1',
        abortTechnicalEvidenceId: 'evidence-1',
      },
    }
    workspaceVerificationMocks.observeWorkspace.mockReturnValue({
      observation: dirtyObservation,
      knownGood: {
        gitOperationMarkers: [], worktreeClean: false, indexClean: true,
        headValid: true, blindSpotsAbsent: true,
      },
    })
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const value = String(url)
      if (value.endsWith('/api/projects')) return new Response(JSON.stringify([project]), { status: 200 })
      if (value.includes('/api/tasks?projectId=')) return new Response(JSON.stringify([requestedTask]), { status: 200 })
      if (value.includes('/api/jobs?taskId=')) return new Response(JSON.stringify([requestedJob]), { status: 200 })
      if (value.includes('/abort-cleanup-result')) return new Response(JSON.stringify({ error: 'refused' }), { status: 409 })
      throw new Error(`unexpected fetch ${value}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(reportAbortCleanupObservations()).resolves.toBe(false)

    expect(jobRunnerMocks.revertBlockedJobChanges).not.toHaveBeenCalled()
    expect(workspaceVerificationMocks.verifyWorkspaceAgainstBaseline).not.toHaveBeenCalled()
    const report = fetchMock.mock.calls.find(([url]) => String(url).includes('/abort-cleanup-result'))
    expect(JSON.parse(String(report?.[1]?.body))).toEqual({
      observation: dirtyObservation,
      knownGood: {
        gitOperationMarkers: [], worktreeClean: false, indexClean: true,
        headValid: true, blindSpotsAbsent: true,
      },
    })
  })
})

describe('dirty Technical Abort cleanup — identical resubmission after a retryable refusal', () => {
  // 同じ carrier + generation の保留があれば、観測も cleanup もやり直さず同じ payload を再送する
  // （Codex review ba0cdae: 観測し直すと clean な workspace が dirty な fingerprint と食い違い quarantine になる）。
  const dirtyEnd = {
    mode: 'dirty' as const,
    startCommitHash: 'end-head',
    entries: [{ path: 'apps/worker/src/index.ts', kind: 'modified' as const, xyStatus: '.M', worktreeHash: 'sha256:owned' }],
  }
  const cleanEnd = { mode: 'clean' as const, startCommitHash: 'end-head' }
  const knownGoodClean = {
    gitOperationMarkers: [], worktreeClean: true, indexClean: true, headValid: true, blindSpotsAbsent: true,
  }
  const knownGoodDirty = { ...knownGoodClean, worktreeClean: false }

  beforeEach(() => {
    clearPendingAbortCleanupSubmissions()
  })

  function arrange(responses: Array<() => Response>, markerGoneAfterCall?: number): {
    reports: () => string[]
  } {
    const project = {
      id: 'project-1', name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
      createdAt: NOW, updatedAt: NOW,
    }
    const requestedTask: Task = { ...task, status: 'blocked', roadmapActive: true }
    const markedJob: Job = {
      ...job,
      id: 'job-dirty',
      status: 'failed',
      failureMetadata: {
        workspaceEndFingerprint: dirtyEnd,
        abortCleanupRequestedAt: NOW,
        abortTechnicalEvidenceId: 'evidence-1',
        abortTechnicalStateFingerprint: 'fp-1',
      },
    }
    const cancelledJob: Job = { ...markedJob, failureMetadata: { workspaceEndFingerprint: dirtyEnd } }
    // 1回目の観測は dirty（cleanup 前）、cleanup 後は clean。以後の観測も clean のまま。
    workspaceVerificationMocks.observeWorkspace
      .mockReturnValueOnce({ observation: dirtyEnd, knownGood: knownGoodDirty })
      .mockReturnValue({ observation: cleanEnd, knownGood: knownGoodClean })
    let reportCount = 0
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const value = String(url)
      if (value.endsWith('/api/projects')) return new Response(JSON.stringify([project]), { status: 200 })
      if (value.includes('/api/tasks?projectId=')) return new Response(JSON.stringify([requestedTask]), { status: 200 })
      if (value.includes('/api/jobs?taskId=')) {
        const gone = markerGoneAfterCall !== undefined && reportCount >= markerGoneAfterCall
        return new Response(JSON.stringify([gone ? cancelledJob : markedJob]), { status: 200 })
      }
      if (value.includes('/abort-cleanup-result')) {
        const respond = responses[reportCount] ?? responses[responses.length - 1]!
        reportCount += 1
        return respond()
      }
      throw new Error(`unexpected fetch ${value}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return {
      reports: () => fetchMock.mock.calls
        .filter(([url]) => String(url).includes('/abort-cleanup-result'))
        .map(([, init]) => String(init?.body)),
    }
  }

  const busy = (): Response => new Response(JSON.stringify({ error: 'busy', code: 'STORAGE_BUSY' }), { status: 409 })

  it('STORAGE_BUSY → the next poll resends the identical evidence without re-observing or re-cleaning → success', async () => {
    const { reports } = arrange([busy, () => new Response(null, { status: 200 })])

    await expect(reportAbortCleanupObservations()).resolves.toBe(false)
    expect(jobRunnerMocks.revertBlockedJobChanges).toHaveBeenCalledTimes(1)
    const observationsAfterFirstPoll = workspaceVerificationMocks.observeWorkspace.mock.calls.length

    await expect(reportAbortCleanupObservations()).resolves.toBe(true)

    // 2回目の poll では観測も cleanup もやり直さない。
    expect(workspaceVerificationMocks.observeWorkspace.mock.calls.length).toBe(observationsAfterFirstPoll)
    expect(jobRunnerMocks.revertBlockedJobChanges).toHaveBeenCalledTimes(1)
    const [first, second] = reports()
    expect(second).toBe(first)
    expect(JSON.parse(first!)).toMatchObject({
      observation: cleanEnd,
      preCleanupObservation: dirtyEnd,
      cleanupSummary: { changedPathCount: 1 },
      // 証拠がどの cleanup generation のものかを名指す（API が現在の marker と照合する）。
      cleanupGeneration: {
        abortCleanupRequestedAt: NOW,
        abortTechnicalEvidenceId: 'evidence-1',
        abortTechnicalStateFingerprint: 'fp-1',
      },
    })
    // refusal（quarantine につながる）は一度も送らない。
    expect(reports().some((body) => body.includes('refusalCode'))).toBe(false)
  })

  it('a resubmission refused as GENERATION_MISMATCH is definitive: the entry is cleared and not resent', async () => {
    const mismatch = (): Response =>
      new Response(JSON.stringify({ error: 'mismatch', code: 'GENERATION_MISMATCH' }), { status: 409 })
    const { reports } = arrange([busy, mismatch])

    await expect(reportAbortCleanupObservations()).resolves.toBe(false)
    expect(pendingAbortCleanupSubmissionJobIds()).toEqual(['job-dirty'])
    await expect(reportAbortCleanupObservations()).resolves.toBe(false)

    expect(pendingAbortCleanupSubmissionJobIds()).toEqual([])
    expect(reports()).toHaveLength(2)
    expect(reports()[1]).toBe(reports()[0])
    expect(reports().some((body) => body.includes('refusalCode'))).toBe(false)
  })

  it('a resubmission refused by a human decision stops resending; the cancelled generation is not re-observed', async () => {
    const conflict = (): Response =>
      new Response(JSON.stringify({ error: 'conflict', code: 'HUMAN_DECISION_CONFLICT' }), { status: 409 })
    const { reports } = arrange([busy, conflict], 2)

    await expect(reportAbortCleanupObservations()).resolves.toBe(false)
    await expect(reportAbortCleanupObservations()).resolves.toBe(false)
    // API が generation を取り消した後の poll では、何も観測せず何も送らない。
    const observations = workspaceVerificationMocks.observeWorkspace.mock.calls.length
    await expect(reportAbortCleanupObservations()).resolves.toBe(false)

    expect(workspaceVerificationMocks.observeWorkspace.mock.calls.length).toBe(observations)
    expect(reports()).toHaveLength(2)
    expect(reports()[1]).toBe(reports()[0])
    expect(reports().some((body) => body.includes('refusalCode'))).toBe(false)
  })
})

describe('pending Technical Abort cleanup delivery gates intake and is swept when its generation disappears', () => {
  // Codex review cf8a33e: 配送待ちの間は queued Job を取らない / generation が消えた保留は掃除する。
  const dirtyEnd = {
    mode: 'dirty' as const,
    startCommitHash: 'end-head',
    entries: [{ path: 'apps/worker/src/index.ts', kind: 'modified' as const, xyStatus: '.M', worktreeHash: 'sha256:owned' }],
  }
  const cleanEnd = { mode: 'clean' as const, startCommitHash: 'end-head' }
  const knownGoodClean = {
    gitOperationMarkers: [], worktreeClean: true, indexClean: true, headValid: true, blindSpotsAbsent: true,
  }
  const project = {
    id: 'project-1', name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
    createdAt: NOW, updatedAt: NOW,
  }
  const carrierTask: Task = { ...task, id: 'task-a', status: 'blocked', roadmapActive: true }
  const carrier: Job = {
    ...job,
    id: 'job-carrier',
    taskId: 'task-a',
    status: 'failed',
    failureMetadata: {
      workspaceEndFingerprint: dirtyEnd,
      abortCleanupRequestedAt: NOW,
      abortTechnicalEvidenceId: 'evidence-1',
      abortTechnicalStateFingerprint: 'fp-1',
    },
  }
  const busy = (): Response => new Response(JSON.stringify({ error: 'busy', code: 'STORAGE_BUSY' }), { status: 409 })

  interface ApiState {
    projectStatus: string
    projectsFail: boolean
    carrierTask: Task
    carrierJobs: Job[]
    extraTasks: Task[]
    extraJobs: Record<string, Job[]>
    /** discovery の fetch を reject（throw）させる対象。 */
    throwOn?: 'projects' | 'tasks' | 'jobs'
    cleanupResponses: Array<() => Response>
    onAccepted?: (state: ApiState) => void
  }

  function stubApi(state: ApiState): void {
    workspaceVerificationMocks.observeWorkspace
      .mockReturnValueOnce({ observation: dirtyEnd, knownGood: { ...knownGoodClean, worktreeClean: false } })
      .mockReturnValue({ observation: cleanEnd, knownGood: knownGoodClean })
    let reports = 0
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url)
      if (state.throwOn === 'projects' && value.endsWith('/api/projects')) throw new TypeError('fetch failed')
      if (state.throwOn === 'tasks' && value.includes('/api/tasks?projectId=')) throw new TypeError('fetch failed')
      if (state.throwOn === 'jobs' && value.includes('/api/jobs?taskId=')) throw new TypeError('fetch failed')
      if (value.endsWith('/api/projects')) {
        if (state.projectsFail) return new Response(null, { status: 503 })
        return new Response(JSON.stringify([{ ...project, status: state.projectStatus }]), { status: 200 })
      }
      if (value.includes('/api/tasks?projectId=')) {
        return new Response(JSON.stringify([state.carrierTask, ...state.extraTasks]), { status: 200 })
      }
      if (value.includes('/api/jobs?taskId=task-a')) return new Response(JSON.stringify(state.carrierJobs), { status: 200 })
      const extra = /\/api\/jobs\?taskId=([^&]+)/.exec(value)
      if (extra) return new Response(JSON.stringify(state.extraJobs[decodeURIComponent(extra[1]!)] ?? []), { status: 200 })
      if (value.includes('/abort-cleanup-result')) {
        const respond = state.cleanupResponses[reports] ?? state.cleanupResponses[state.cleanupResponses.length - 1]!
        reports += 1
        const response = respond()
        if (response.ok) state.onAccepted?.(state)
        return response
      }
      // queued Job の claim（running への PATCH）は 409 で止める。呼ばれたこと自体が claim の証拠。
      if (value.includes('/api/jobs/job-queued') && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ error: 'stop here' }), { status: 409 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  const claimed = (): boolean => fetchMock.mock.calls.some(
    ([url, init]) => String(url).includes('/api/jobs/job-queued') && init?.method === 'PATCH',
  )

  beforeEach(() => {
    clearPendingAbortCleanupSubmissions()
  })

  it('a queued Job is not claimed while the cleanup delivery is pending, and is claimed after acceptance', async () => {
    vi.useFakeTimers()
    const queuedTask: Task = { ...task, id: 'task-b', status: 'pending', roadmapActive: true }
    const queuedJob: Job = { ...job, id: 'job-queued', taskId: 'task-b', status: 'queued' }
    const state: ApiState = {
      projectStatus: 'running',
      projectsFail: false,
      carrierTask,
      carrierJobs: [carrier],
      extraTasks: [queuedTask],
      extraJobs: { 'task-b': [queuedJob] },
      cleanupResponses: [busy, () => new Response(null, { status: 200 })],
      // 受理後の API: Task は park され、carrier から cleanup marker が消える。
      onAccepted: (current) => {
        current.carrierTask = { ...carrierTask, status: 'pending', roadmapActive: false }
        current.carrierJobs = [{ ...carrier, failureMetadata: { workspaceEndFingerprint: dirtyEnd } }]
      },
    }
    stubApi(state)

    void pollJobs()
    await flushPollCycle()
    // poll 1: STORAGE_BUSY で配送待ち → intake しない。
    expect(pendingAbortCleanupSubmissionJobIds()).toEqual(['job-carrier'])
    expect(claimed()).toBe(false)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST)
    // poll 2: 同じ証拠を再送して受理。この poll は従来どおり intake を飛ばす。
    expect(pendingAbortCleanupSubmissionJobIds()).toEqual([])
    expect(claimed()).toBe(false)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST)
    // poll 3: 配送待ちが無いので queued Job を claim しにいく。
    expect(claimed()).toBe(true)
  })

  it('sweeps the pending entry when the API shows the generation was cancelled', async () => {
    const state: ApiState = {
      projectStatus: 'running', projectsFail: false, carrierTask, carrierJobs: [carrier],
      extraTasks: [], extraJobs: {}, cleanupResponses: [busy],
    }
    stubApi(state)
    await reportAbortCleanupObservations()
    expect(pendingAbortCleanupSubmissionJobIds()).toEqual(['job-carrier'])

    // marker が消えた（generation 取り消し / commit 済みで応答だけ失われた）。
    state.carrierJobs = [{ ...carrier, failureMetadata: { workspaceEndFingerprint: dirtyEnd } }]
    await reportAbortCleanupObservations()
    expect(pendingAbortCleanupSubmissionJobIds()).toEqual([])
  })

  it('sweeps the pending entry when its project is no longer running', async () => {
    const state: ApiState = {
      projectStatus: 'running', projectsFail: false, carrierTask, carrierJobs: [carrier],
      extraTasks: [], extraJobs: {}, cleanupResponses: [busy],
    }
    stubApi(state)
    await reportAbortCleanupObservations()
    state.projectStatus = 'paused'
    await reportAbortCleanupObservations()
    expect(pendingAbortCleanupSubmissionJobIds()).toEqual([])
  })

  it('keeps the pending entry (and keeps intake paused) when the API enumeration fails', async () => {
    const state: ApiState = {
      projectStatus: 'running', projectsFail: false, carrierTask, carrierJobs: [carrier],
      extraTasks: [], extraJobs: {}, cleanupResponses: [busy],
    }
    stubApi(state)
    await reportAbortCleanupObservations()
    state.projectsFail = true
    await reportAbortCleanupObservations()
    expect(pendingAbortCleanupSubmissionJobIds()).toEqual(['job-carrier'])
  })

  // Codex review 44ddd0f: 列挙が失敗し続けても、保留は毎回列挙と独立に再送され、上限で必ず（通知付きで）解ける。
  it('with discovery failing every poll, the pending report is still resent each poll and released at the bound with one alert', async () => {
    const state: ApiState = {
      projectStatus: 'running', projectsFail: false, carrierTask, carrierJobs: [carrier],
      extraTasks: [], extraJobs: {}, cleanupResponses: [busy],
    }
    stubApi(state)
    await reportAbortCleanupObservations()
    const cleanupPosts = (): number => fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/abort-cleanup-result')).length
    expect(cleanupPosts()).toBe(1)

    state.projectsFail = true
    let polls = 0
    while (hasPendingAbortCleanupSubmissions() && polls < 50) {
      const before = cleanupPosts()
      await reportAbortCleanupObservations()
      polls += 1
      // 列挙が失敗しても、各 poll で必ず1回再送する（上限が進む）。
      expect(cleanupPosts()).toBe(before + 1)
    }

    // 初回を含めて 20 回で解け、黙らずに一度だけ通知する。
    expect(hasPendingAbortCleanupSubmissions()).toBe(false)
    expect(cleanupPosts()).toBe(20)
    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
    expect(notifierMocks.sendAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      sourceId: 'abort_cleanup:job-carrier',
    }))
    // 全ての再送は同じ証拠。
    const bodies = new Set(fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/abort-cleanup-result'))
      .map(([, init]) => String(init?.body)))
    expect(bodies.size).toBe(1)
  })

  // Codex review 57f2cf6: fetchJson() は reject で throw する。列挙が throw しても保留は残り、毎 poll 独立に再送され、
  // 上限で通知付きで解ける（poll ごと外側の catch へ抜けて黙って止まらない）。
  it.each(['projects', 'tasks', 'jobs'] as const)(
    'with discovery throwing at /api/%s every poll, the pending report is still resent and released at the bound',
    async (throwOn) => {
      const state: ApiState = {
        projectStatus: 'running', projectsFail: false, carrierTask, carrierJobs: [carrier],
        extraTasks: [], extraJobs: {}, cleanupResponses: [busy],
      }
      stubApi(state)
      await reportAbortCleanupObservations()
      expect(pendingAbortCleanupSubmissionJobIds()).toEqual(['job-carrier'])
      const cleanupPosts = (): number => fetchMock.mock.calls
        .filter(([url]) => String(url).includes('/abort-cleanup-result')).length

      state.throwOn = throwOn
      // throw した列挙は authoritative ではない: sweep で消さず、再送は続ける。
      await expect(reportAbortCleanupObservations()).resolves.toBe(false)
      expect(pendingAbortCleanupSubmissionJobIds()).toEqual(['job-carrier'])
      expect(cleanupPosts()).toBe(2)

      let polls = 0
      while (hasPendingAbortCleanupSubmissions() && polls < 50) {
        await reportAbortCleanupObservations()
        polls += 1
      }
      expect(hasPendingAbortCleanupSubmissions()).toBe(false)
      expect(cleanupPosts()).toBe(20)
      expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
    },
  )

  // Codex review 35a1784: 同じ poll で新しい cleanup が受理されても、別の保留の再送を飛ばさない。
  it('a newly accepted cleanup does not starve a separate pending submission in the same poll', async () => {
    const cleanEndOnly = { mode: 'clean' as const, startCommitHash: 'end-head' }
    workspaceVerificationMocks.observeWorkspace.mockReturnValue({ observation: cleanEndOnly, knownGood: knownGoodClean })
    const marked = (id: string, taskId: string, evidence: string): Job => ({
      ...job,
      id,
      taskId,
      status: 'failed',
      failureMetadata: {
        workspaceEndFingerprint: cleanEndOnly,
        abortCleanupRequestedAt: NOW,
        abortTechnicalEvidenceId: evidence,
        abortTechnicalStateFingerprint: `fp-${evidence}`,
      },
    })
    const taskA: Task = { ...task, id: 'task-a', status: 'blocked', roadmapActive: true }
    const taskB: Task = { ...task, id: 'task-b', status: 'blocked', roadmapActive: true }
    const jobA = marked('job-a', 'task-a', 'evidence-a')
    const jobB = marked('job-b', 'task-b', 'evidence-b')
    let bMarked = false
    let aAttempts = 0
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const value = String(url)
      if (value.endsWith('/api/projects')) return new Response(JSON.stringify([project]), { status: 200 })
      // B を先に列挙する: B の受理で列挙が早期に終わり、A には列挙経路では届かない。
      if (value.includes('/api/tasks?projectId=')) {
        return new Response(JSON.stringify(bMarked ? [taskB, taskA] : [taskA]), { status: 200 })
      }
      if (value.includes('/api/jobs?taskId=task-a')) return new Response(JSON.stringify([jobA]), { status: 200 })
      if (value.includes('/api/jobs?taskId=task-b')) return new Response(JSON.stringify([jobB]), { status: 200 })
      if (value.includes('/api/jobs/job-a/abort-cleanup-result')) {
        aAttempts += 1
        return aAttempts === 1 ? busy() : new Response(null, { status: 200 })
      }
      if (value.includes('/api/jobs/job-b/abort-cleanup-result')) return new Response(null, { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // poll 1: A が STORAGE_BUSY で保留になる。
    await reportAbortCleanupObservations()
    expect(pendingAbortCleanupSubmissionJobIds()).toEqual(['job-a'])

    // poll 2: 新しく B の cleanup が要求され受理される。同じ poll で A の保留も再送されて解ける。
    bMarked = true
    await expect(reportAbortCleanupObservations()).resolves.toBe(true)
    const posted = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/abort-cleanup-result'))
    expect(posted.filter((url) => url.includes('job-b'))).toHaveLength(1)
    expect(posted.filter((url) => url.includes('job-a'))).toHaveLength(2)
    expect(pendingAbortCleanupSubmissionJobIds()).toEqual([])
  })

  it('a technical refusal report names the carrier generation', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({ verified: false })
    const state: ApiState = {
      projectStatus: 'running', projectsFail: false, carrierTask, carrierJobs: [carrier],
      extraTasks: [], extraJobs: {}, cleanupResponses: [() => new Response(null, { status: 409 })],
    }
    stubApi(state)
    await reportAbortCleanupObservations()

    const refusal = fetchMock.mock.calls.find(([url]) => String(url).includes('/abort-cleanup-result'))
    expect(JSON.parse(String(refusal?.[1]?.body))).toEqual({
      refusalCode: 'PRE_CLEANUP_BASELINE_MISMATCH',
      cleanupGeneration: {
        abortCleanupRequestedAt: NOW,
        abortTechnicalEvidenceId: 'evidence-1',
        abortTechnicalStateFingerprint: 'fp-1',
      },
    })
  })

  it('with discovery failing, an accepted resubmission clears the entry and releases the gate', async () => {
    const state: ApiState = {
      projectStatus: 'running', projectsFail: false, carrierTask, carrierJobs: [carrier],
      extraTasks: [], extraJobs: {}, cleanupResponses: [busy, () => new Response(null, { status: 200 })],
    }
    stubApi(state)
    await reportAbortCleanupObservations()
    state.projectsFail = true

    await expect(reportAbortCleanupObservations()).resolves.toBe(true)
    expect(hasPendingAbortCleanupSubmissions()).toBe(false)
    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()
  })
})

describe('terminal result persistence', () => {
  it('persists the value-free workspace END fingerprint in existing failureMetadata JSON', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const workspaceEndFingerprint = {
      mode: 'dirty' as const,
      startCommitHash: 'abc123',
      entries: [{ path: 'src/feature.ts', kind: 'modified' as const, worktreeHash: 'sha256:value-free' }],
    }

    await persistJobResult('job-end-fingerprint', {
      ...runResult,
      workspaceEndFingerprint,
    }, 'success', { patchJob })

    expect(patchJob).toHaveBeenCalledWith('job-end-fingerprint', expect.objectContaining({
      failureMetadata: { workspaceEndFingerprint },
    }))
  })

  it('persists a value-free secret-scan refusal in failureMetadata', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const refusal = {
      kind: 'secret_scan' as const,
      patternKinds: ['password assignment' as const],
      repairEligible: true as const,
      repairEligibilityReason: 'implementation_added_generic_assignment' as const,
    }
    const refusedResult: JobRunResult = {
      ...runResult,
      status: 'failed',
      exitCode: 1,
      refusal,
      workspaceState: 'unchanged',
    }

    await persistJobResult('review-refused', refusedResult, 'failed', { patchJob })

    const failureMetadata = { refusal, workspaceState: 'unchanged' }
    expect(patchJob).toHaveBeenCalledWith('review-refused', expect.objectContaining({ failureMetadata }))
    expect(outboxMocks.recordPending).toHaveBeenCalledWith(
      'review-refused',
      expect.objectContaining({ failureMetadata }),
    )
  })

  it('provider failure metadataをterminal PATCHとOutboxへ同じ内容で渡す', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const timeoutResult: JobRunResult = {
      ...runResult,
      status: 'failed',
      exitCode: 1,
      providerFailureKind: 'provider_timeout',
      workspaceState: 'unchanged',
    }

    await persistJobResult('job-timeout', timeoutResult, 'failed', { patchJob })

    const failureMetadata = {
      kind: 'provider_timeout',
      workspaceState: 'unchanged',
    }
    expect(patchJob).toHaveBeenCalledWith('job-timeout', expect.objectContaining({ failureMetadata }))
    expect(outboxMocks.recordPending).toHaveBeenCalledWith(
      'job-timeout',
      expect.objectContaining({ failureMetadata }),
    )
  })

  it('1〜2回目の失敗後に3回目が成功すればterminal resultを成功として扱う', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const reconcileJob = vi.fn()

    await persistJobResult('job-1', runResult, 'success', {
      patchJob: retryingPatchJob(),
      reconcileJob,
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(outboxMocks.deletePending).toHaveBeenCalledWith('job-1')
    expect(reconcileJob).not.toHaveBeenCalled()
  })

  it('3回とも同一terminal payloadを送信する', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    await persistJobResult('job-1', runResult, 'success', {
      patchJob: retryingPatchJob(),
    })

    const bodies = fetchMock.mock.calls.map((call) => String(call[1]?.body))
    expect(new Set(bodies).size).toBe(1)
    expect(JSON.parse(bodies[0])).toMatchObject({
      status: 'success',
      completedAt: runResult.completedAt,
      stdout: runResult.stdout,
      eventId: 'event-1',
      payloadHash: 'payload-hash-1',
    })
  })

  it('3回失敗後にreconcileできればCRITICAL通知しない', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    const alert = vi.fn().mockResolvedValue([])
    const reconcileJob = vi.fn()

    await persistJobResult('job-1', runResult, 'success', {
      patchJob: retryingPatchJob(),
      reconcileJob,
      alert,
      now: () => NOW,
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(outboxMocks.recordPending).toHaveBeenCalledTimes(1)
    expect(outboxMocks.deletePending).not.toHaveBeenCalled()
    expect(reconcileJob).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it('3回失敗後のreconcileがunrecoverableなら機密本文を含まないCRITICAL通知を1回送る', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    const alert = vi.fn().mockResolvedValue([])
    const sensitiveResult: JobRunResult = {
      ...runResult,
      stdout: 'private stdout token-secret-123',
      stderr: 'private stderr token-secret-123',
    }
    const reconcileJob = vi.fn()

    await persistJobResult('job-sensitive', sensitiveResult, 'success', {
      patchJob: retryingPatchJob(),
      reconcileJob,
      alert,
      now: () => NOW,
    })

    expect(outboxMocks.deletePending).not.toHaveBeenCalled()
    expect(reconcileJob).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })
})

/** 既存POLL_INTERVAL_MSの既定値（テスト内で時間を進めるため）。 */
const POLL_INTERVAL_FOR_TEST = 5_000

/**
 * Outbox gating が守っているのは「pending がある間は新しい Job を claim しない」ことであって、
 * 「HTTP を一切出さない」ことではない。#110 Step 3 で supervised run の reconcile を
 * poll cycle 先頭へ置いたため（Outbox 滞留で supervision が止まらないようにするため）、
 * ここでは **queued Job fetch だけが呼ばれていない**ことを確認する。
 */
function expectNoQueuedJobFetch(): void {
  const jobFetches = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/jobs'))
  expect(jobFetches).toHaveLength(0)
}

/**
 * poll cycle が Outbox 分岐へ到達するまで microtask を流し切る。
 *
 * 以前は `await Promise.resolve()` を必要段数だけ並べていたが、poll cycle 先頭の
 * reconcile（supervised run / task continuation）が1つ増えるたびに全テストの段数を
 * 数え直す必要があり壊れやすかった。実時間は進めないので POLL_INTERVAL_MS は跨がない。
 */
async function flushPollCycle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('outbox gating', () => {
  it('pollJobs skips queued Job fetch while pending Outbox events exist', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(true)
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await flushPollCycle()

    expect(outboxMocks.hasPending).toHaveBeenCalled()
    expectNoQueuedJobFetch()
  })

  it('pendingがある間はresendPendingを呼び、新しいJob fetchはしない', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(true)
    outboxMocks.resendPending.mockResolvedValue(undefined)
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await flushPollCycle()

    expect(outboxMocks.resendPending).toHaveBeenCalled()
    expectNoQueuedJobFetch()
  })

  it('resend成功でpendingが消えると、次のpollから通常のJob fetchへ戻る', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValueOnce(true).mockReturnValue(false)
    outboxMocks.resendPending.mockResolvedValue(undefined)
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await flushPollCycle()

    expect(outboxMocks.resendPending).toHaveBeenCalledTimes(1)
    expectNoQueuedJobFetch()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST)
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalled()
  })

  it('resend失敗でもWorkerは落ちず、同一poll内でtight retryせず次pollで再試行する', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(true)
    outboxMocks.resendPending.mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await flushPollCycle()

    // 1 pollにつき1 resend batchであり、同一poll内で繰り返さない
    expect(outboxMocks.resendPending).toHaveBeenCalledTimes(1)
    expectNoQueuedJobFetch()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST)
    await Promise.resolve()

    // 次pollで再試行される（pendingは保持されたまま）
    expect(outboxMocks.resendPending.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('pendingが無いときはresendPendingを呼ばない（既存挙動のまま）', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(false)
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await flushPollCycle()

    expect(outboxMocks.resendPending).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalled()
  })

  it('resendに時間がかかっても同一poll cycleが直列化され並列再送しない', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(true)
    let resolveResend: (() => void) | undefined
    outboxMocks.resendPending.mockImplementation(
      () => new Promise<void>((resolve) => { resolveResend = resolve }),
    )
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await flushPollCycle()

    expect(outboxMocks.resendPending).toHaveBeenCalledTimes(1)

    // resendが未完了のまま時間が進んでも、pollはawaitで直列化されており次のbatchを開始しない
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 3)
    await Promise.resolve()

    expect(outboxMocks.resendPending).toHaveBeenCalledTimes(1)

    resolveResend?.()
  })

  it('pending Outbox が滞留していても supervised run の reconcile は止まらない（独立レビュー Step 3 第2ラウンド #2）', async () => {
    vi.useFakeTimers()
    // Outbox が詰まっている間 supervision も止まると、完了済みの委任が RUNNING のまま残る。
    // Job intake を止める理由（workspace 競合）は supervision には当てはまらない。
    outboxMocks.hasPending.mockReturnValue(true)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await flushPollCycle()
    await Promise.resolve()

    const reconcileCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/supervised-runs/reconcile'),
    )
    expect(reconcileCalls.length).toBeGreaterThanOrEqual(1)
    // それでも新しい Job は claim しない（既存の Outbox gating は維持）。
    expectNoQueuedJobFetch()
  })

  it('pending Outbox が滞留していても task continuation の reconcile は止まらない', async () => {
    vi.useFakeTimers()
    // continuation 回収まで Outbox gating に巻き込むと、次 Task へ進めない状態が
    // Outbox の詰まりが解けるまで続く。Job intake を止める理由（workspace 競合）は
    // continuation 回収には当てはまらない（実際に Job を作るかは API 側の gate が決める）。
    outboxMocks.hasPending.mockReturnValue(true)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await flushPollCycle()

    const continuationCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/task-continuations/reconcile'),
    )
    expect(continuationCalls.length).toBeGreaterThanOrEqual(1)
    // それでも新しい Job は claim しない（既存の Outbox gating は維持）。
    expectNoQueuedJobFetch()
  })

  it('task continuation の reconcile が失敗しても poll cycle は止まらない', async () => {
    vi.useFakeTimers()
    // reconcile は liveness driver であって gate ではない。ここで throw したときに
    // poll cycle ごと落ちると、Job intake も Outbox 再送も巻き添えで止まる。
    outboxMocks.hasPending.mockReturnValue(false)
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/api/task-continuations/reconcile')) {
        throw new TypeError('fetch failed')
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await flushPollCycle()

    // reconcile が投げても、同じ cycle で Job intake 側（fetchQueuedJob）へ到達する。
    // fetchQueuedJob() は GET /api/projects から始まるので、そこへ届いていれば
    // poll cycle は reconcile の例外で中断していない。
    const intakeFetches = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/projects'))
    expect(intakeFetches.length).toBeGreaterThanOrEqual(1)
  })

  it('start does not wait for pending Outbox events before startup recovery/watchdog/polling', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    // pendingが解消しないケース（起動時に限らずずっと残る）でも、recovery/watchdog/
    // pollingの開始そのものはblockされてはならない。
    outboxMocks.hasPending.mockReturnValue(true)

    void start()
    await flushPollCycle()

    // startup sweepとwatchdogは、pending Outboxの解消を待たずに開始する
    expect(jobStateMocks.recoverStaleJobs).toHaveBeenCalledTimes(1)
    expect(watchdogMocks.startWatchdog).toHaveBeenCalledTimes(1)

    // recovery 前の1回（H-01）に加えて、pollJobs自体も開始しており、最初のcycleでpendingの再送を試みている
    expect(outboxMocks.resendPending).toHaveBeenCalledTimes(2)
    // pendingが残っている間はqueued Job fetchだけがこのcycleでskipされる（既存仕様）
    expectNoQueuedJobFetch()
  })

  it('start replays the durable Outbox before stale-Job recovery and passes the per-Job pending check to recovery (H-01)', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const order: string[] = []
    outboxMocks.hasPending.mockReturnValueOnce(true).mockReturnValue(false)
    outboxMocks.resendPending.mockImplementation(async () => { order.push('replay') })
    jobStateMocks.recoverStaleJobs.mockImplementation(async () => { order.push('recovery'); return 0 })
    outboxMocks.hasPendingFor.mockImplementation((jobId: string) => jobId === 'job-with-pending-result')

    void start()
    await flushPollCycle()

    expect(order).toEqual(['replay', 'recovery'])
    const options = jobStateMocks.recoverStaleJobs.mock.calls[0]?.[2] as
      { hasPendingTerminalEvent?: (jobId: string) => boolean } | undefined
    expect(options?.hasPendingTerminalEvent?.('job-with-pending-result')).toBe(true)
    expect(options?.hasPendingTerminalEvent?.('job-without')).toBe(false)
  })

  it('a throwing startup replay still lets recovery, watchdog and polling start', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    outboxMocks.hasPending.mockReturnValue(true)
    outboxMocks.resendPending.mockRejectedValue(new Error('outbox db locked'))

    void start()
    await flushPollCycle()

    expect(jobStateMocks.recoverStaleJobs).toHaveBeenCalledTimes(1)
    expect(watchdogMocks.startWatchdog).toHaveBeenCalledTimes(1)
    expectNoQueuedJobFetch()
  })

  it('startupでpending Outboxが残ったままでも、Worker全体とwatchdogは停止しない', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    outboxMocks.hasPending.mockReturnValue(true)

    void start()
    // start() は recovery の前に1回だけ Outbox を再送する（H-01）ので、microtask を流し切る
    await flushPollCycle()

    expect(jobStateMocks.recoverStaleJobs).toHaveBeenCalledTimes(1)
    expect(watchdogMocks.startWatchdog).toHaveBeenCalledTimes(1)

    // pending Outboxが解消しないまま複数poll cycleが進んでも、
    // poll loop自体は生きていて次のcycleへ進み続ける（system全体のhaltではない）
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 4)
    await Promise.resolve()

    expect(outboxMocks.resendPending.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(watchdogMocks.startWatchdog).toHaveBeenCalledTimes(1)
  })

  it('pendingが3poll cycle連続で解消しない場合にCRITICAL通知を1回送る', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(true)
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await flushPollCycle()
    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 2)
    await Promise.resolve()

    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
    expect(notifierMocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical', title: 'Worker Outbox resend is blocked' }),
    )

    // 4回目以降も連続して残っていても、通知は1回のまま(alert済みフラグ)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 2)
    await Promise.resolve()

    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('pendingが解消した後に再び連続滞留すると、CRITICAL通知が再度送られる', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))

    // 呼び出し回数（1cycleあたりhasPendingは1〜2回呼ばれうる）に依存しないよう、
    // 状態フラグで表現する。
    let pending = true
    outboxMocks.hasPending.mockImplementation(() => pending)

    void pollJobs()
    await flushPollCycle()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 3)
    await Promise.resolve()
    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)

    // 一度解消させる(streak/alert済みフラグがリセットされる)
    pending = false
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST)
    await Promise.resolve()

    // 再び滞留させる
    pending = true
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 3)
    await Promise.resolve()

    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(2)
  })
})

describe('running transition', () => {
  it.each([
    ['queued no-op', { outcome: 'reconciled' as const, updated: false, currentStatus: 'queued' as const }],
    ['failed convergence', { outcome: 'reconciled' as const, updated: true, currentStatus: 'failed' as const }],
  ])('does not run the Job after %s reconciliation', async (_label, reconciliation) => {
    const executeJob = vi.fn()
    const alert = vi.fn().mockResolvedValue([])

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob: vi.fn().mockResolvedValue(false),
      reconcileJob: vi.fn().mockResolvedValue(reconciliation),
      executeJob,
      alert,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(executeJob).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it('treats a structured { ok: false } claim result as failure and never runs the Job (W5)', async () => {
    // patchJobWithRetry() は失敗時に { ok: false } を返す。truthy なので以前は claim 成功とみなされていた。
    const executeJob = vi.fn()
    const reconcileJob = vi.fn().mockResolvedValue({ outcome: 'reconciled' as const, updated: false, currentStatus: 'queued' as const })

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob: vi.fn().mockResolvedValue({ ok: false }),
      reconcileJob,
      executeJob,
      alert: vi.fn().mockResolvedValue([]),
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(executeJob).not.toHaveBeenCalled()
    expect(reconcileJob).toHaveBeenCalledTimes(1)
  })

  it('sends CRITICAL and skips runJob only when reconciliation is unrecoverable', async () => {
    const executeJob = vi.fn()
    const alert = vi.fn().mockResolvedValue([])

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob: vi.fn().mockResolvedValue(false),
      reconcileJob: vi.fn().mockResolvedValue({
        outcome: 'unrecoverable',
        updated: false,
      }),
      executeJob,
      alert,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(executeJob).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it('a JOB_CLAIM_REFUSED 409 is a definitive answer: no retry, no reconcile, no alert, Job not run (W5)', async () => {
    // 通常の CEO pause で起きる。以前は「status persistence technical failure」として CRITICAL が鳴っていた。
    const executeJob = vi.fn().mockResolvedValue(runResult)
    const reconcileJob = vi.fn()
    const alert = vi.fn().mockResolvedValue([])
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: 'Job claim refused: the workspace is quarantined or the Project is not running',
      code: 'JOB_CLAIM_REFUSED',
    }), { status: 409 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob: retryingPatchJob(),
      reconcileJob,
      executeJob,
      alert,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reconcileJob).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()
    expect(executeJob).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it.each([
    ['a transport failure', async () => { throw new TypeError('fetch failed') }],
    ['an unknown 409', async () => new Response(JSON.stringify({ code: 'SOMETHING_ELSE' }), { status: 409 })],
  ])('%s keeps the existing retry + reconcile + alert path', async (_label, respond) => {
    const executeJob = vi.fn().mockResolvedValue(runResult)
    const reconcileJob = vi.fn().mockResolvedValue({ outcome: 'unrecoverable', updated: false })
    const alert = vi.fn().mockResolvedValue([])
    fetchMock.mockImplementation(respond)

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob: retryingPatchJob(),
      reconcileJob,
      executeJob,
      alert,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(reconcileJob).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(executeJob).not.toHaveBeenCalled()
  })

  it('does not call runJob or its AI CLI path while the running PATCH is retrying', async () => {
    const executeJob = vi.fn().mockResolvedValue(runResult)
    const executeCountsDuringPatch: number[] = []
    fetchMock.mockImplementation(async () => {
      executeCountsDuringPatch.push(executeJob.mock.calls.length)
      const status = executeCountsDuringPatch.length < 3 ? 503 : 200
      return new Response(null, { status })
    })

    await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob: retryingPatchJob(),
      reconcileJob: vi.fn(),
      executeJob,
      now: () => NOW,
    })

    expect(executeCountsDuringPatch.slice(0, 3)).toEqual([0, 0, 0])
    expect(executeJob).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

describe('workspace baseline (PR-C)', () => {
  it('bundles the workspace baseline into the running claim PATCH (atomic claim + baseline)', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn().mockResolvedValue(runResult)

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      executeJob,
      now: () => NOW,
    })

    expect(status).toBe('success')
    expect(jobRunnerMocks.computeWorkspaceBaseline).toHaveBeenCalledWith(job, '/workspace/target')
    expect(patchJob.mock.calls[0]?.[1]).toEqual({
      status: 'running',
      startedAt: NOW,
      workspaceBaseline: CLEAN_BASELINE,
    })
    expect(executeJob).toHaveBeenCalledTimes(1)
  })

  it('fails closed without claiming when the workspace baseline cannot be computed', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn()
    jobRunnerMocks.computeWorkspaceBaseline.mockReturnValue({
      ok: false,
      reason: 'workspace has an in-progress git operation (index.lock); ' +
        'cannot establish a durable baseline (fail-closed)',
    })

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      executeJob,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(executeJob).not.toHaveBeenCalled()
    expect(patchJob).toHaveBeenCalledTimes(1)
    expect(patchJob.mock.calls[0]?.[1]).toMatchObject({
      status: 'blocked',
      stderr: expect.stringContaining('index.lock'),
      completedAt: NOW,
    })
    expect(patchJob.mock.calls[0]?.[1]).not.toHaveProperty('status', 'running')
  })

  it('shuts down the Job on a dirty worktree for a normal Job (fail-closed gating)', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn()
    jobRunnerMocks.computeWorkspaceBaseline.mockReturnValue({
      ok: false,
      reason: 'normal Job requires a clean worktree but found 1 changed path(s): src/dirty.ts',
    })

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      executeJob,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(executeJob).not.toHaveBeenCalled()
    expect(patchJob).toHaveBeenCalledTimes(1)
    expect(patchJob.mock.calls[0]?.[1]).toMatchObject({
      status: 'blocked',
      stderr: expect.stringContaining('src/dirty.ts'),
    })
  })


  it('baseline failure on an OWNING Job: ownership is retained (blocked + quarantined), not released', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn()
    const alert = vi.fn().mockResolvedValue([])
    // workflowStepKey が initial-implement ではない queued Job は、
    // findWorkspaceOwningTaskId() 上すでに workspace を所有している。
    const owningJob: Job = { ...job, workflowStepKey: 'repair:job-0:1' }
    jobRunnerMocks.computeWorkspaceBaseline.mockReturnValue({
      ok: false,
      reason: 'fingerprint failed',
    })

    const status = await processQueuedWork({ job: owningJob, task, jobs: [owningJob] }, {
      patchJob,
      executeJob,
      alert,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(executeJob).not.toHaveBeenCalled()
    const payload = patchJob.mock.calls[0]?.[1]
    // 所有権を解放する 'failed' にしてはならない
    expect(payload).toMatchObject({ status: 'blocked' })
    expect(payload.failureMetadata).toMatchObject({ quarantined: true })
    expect(alert).toHaveBeenCalled()
  })

  it('baseline failure on a NON-owning initial-implement Job may still report failed', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn()
    const initialJob: Job = { ...job, workflowStepKey: `task:${job.taskId}:initial-implement` }
    jobRunnerMocks.computeWorkspaceBaseline.mockReturnValue({
      ok: false,
      reason: 'dirty worktree',
    })

    await processQueuedWork({ job: initialJob, task, jobs: [initialJob] }, {
      patchJob,
      executeJob,
      now: () => NOW,
    })

    expect(executeJob).not.toHaveBeenCalled()
    // まだ workspace を所有していないので、保持すべき所有権が無い
    expect(patchJob.mock.calls[0]?.[1]).toMatchObject({ status: 'failed' })
  })})

describe('policy construction failure', () => {
  it('uses the shared retry/reconcile persistence path for running and failed updates', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const reconcileJob = vi.fn()
    const executeJob = vi.fn()

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      reconcileJob,
      executeJob,
      buildPolicy: () => {
        throw new Error('invalid policy')
      },
      now: () => NOW,
    })

    expect(status).toBe('failed')
    expect(patchJob).toHaveBeenCalledTimes(2)
    expect(patchJob.mock.calls[0]?.[1]).toEqual({
      status: 'running',
      startedAt: NOW,
      workspaceBaseline: CLEAN_BASELINE,
    })
    expect(patchJob.mock.calls[1]?.[1]).toMatchObject({
      status: 'failed',
      stderr: expect.stringContaining('invalid policy'),
      completedAt: NOW,
    })
    expect(reconcileJob).not.toHaveBeenCalled()
    expect(executeJob).not.toHaveBeenCalled()
  })
})

function retryingPatchJob(): (
  jobId: string,
  payload: Parameters<typeof patchJobWithRetry>[1],
) => Promise<Awaited<ReturnType<typeof patchJobWithRetry>>> {
  return async (jobId, payload) => patchJobWithRetry(jobId, payload, {
    apiBaseUrl: 'http://api.test',
    headers: { authorization: 'Bearer token' },
    fetchImpl: fetchMock,
    sleepImpl: async () => {},
  })
}

/**
 * P1 Phase 2（独立レビュー B3）:
 * containment / 実行後 reconciliation の失敗が runJob から throw された場合、
 * poll loop の logger まで素通りさせてはならない。素通りすると Job は `running` のまま
 * 残り、誰も面倒を見ないまま workspace の所有権を保持し続ける。
 */
describe('P1 Phase 2: containment 失敗時の quarantine（B3）', () => {
  const containmentFailure = (outcome: string): Error =>
    new ContainmentInfrastructureError({
      outcome,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      killedDescendants: false,
      drainMs: 0,
    } as never)

  it('containment 失敗は blocked + quarantine になり、running のまま放置されない', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn().mockRejectedValue(
      containmentFailure('drain_timeout'),
    )
    const alert = vi.fn().mockResolvedValue(undefined)

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      executeJob,
      alert,
      now: () => NOW,
    })

    expect(status).toBe('blocked')

    const terminal = patchJob.mock.calls.at(-1)?.[1] as {
      status?: string
      failureMetadata?: { quarantined?: boolean; quarantineReason?: string; kind?: string }
    }
    // failed にしてはならない。failed は workspace を所有しないため、
    // 生き残ったプロセスを抱えたまま次の Job へ引き渡してしまう。
    expect(terminal.status).toBe('blocked')
    expect(terminal.failureMetadata?.quarantined).toBe(true)
    expect(terminal.failureMetadata?.kind).toBe('workspace_containment_failure')
    expect(terminal.failureMetadata?.quarantineReason).toContain('drain_timeout')
  })

  it('containment 失敗では CRITICAL アラートを出す', async () => {
    const alert = vi.fn().mockResolvedValue(undefined)

    await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob: vi.fn().mockResolvedValue(true),
      executeJob: vi.fn().mockRejectedValue(
        containmentFailure('cleanup_failed'),
      ),
      alert,
      now: () => NOW,
    })

    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }))
  })

  it('containment と無関係な例外はそのまま伝播する（quarantine で覆い隠さない）', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)

    await expect(processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      executeJob: vi.fn().mockRejectedValue(new Error('unrelated bug')),
      now: () => NOW,
    })).rejects.toThrow('unrelated bug')
  })
})

describe('Outbox 滞留通知 — continuation pending の 503 は想定内（outbox-blocked-critical-false-alarm）', () => {
  const continuation503 = (eventId: string): Response => new Response(
    JSON.stringify({ id: 'job-1', status: 'success', outbox: { eventId, deduplicated: false } }),
    { status: 503 },
  )

  it('送った eventId を返す 503 は continuationPending として返す（retry は従来どおり）', async () => {
    fetchMock.mockImplementation(async () => continuation503('e1'))

    const result = await retryingPatchJob()('job-1', { status: 'success', eventId: 'e1', payloadHash: 'h' } as never)

    expect(result).toEqual({ ok: false, continuationPending: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('eventId を伴わない 503（proxy・障害）は continuationPending にしない', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 }))

    const result = await retryingPatchJob()('job-1', { status: 'success', eventId: 'e1', payloadHash: 'h' } as never)

    expect(result).toEqual({ ok: false })
  })

  it('再送がすべて continuation pending の 503 なら、正常な continuation の長さ（7 cycle）では CRITICAL を出さない', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async (url: string | URL | Request) => (
      String(url).includes('/api/jobs/job-1') ? continuation503('e1') : new Response(JSON.stringify([]), { status: 200 })
    ))
    outboxMocks.hasPending.mockReturnValue(true)
    outboxMocks.resendPending.mockImplementation(async (patchFn: (id: string, p: unknown) => Promise<boolean>) => {
      await patchFn('job-1', { status: 'success', eventId: 'e1', payloadHash: 'h' })
    })

    void pollJobs()
    await flushPollCycle()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 7)
    await Promise.resolve()

    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()
    // 従来の閾値（3 cycle）を十分に超えて滞留しても鳴らない（retry の backoff も fake timer を消費する）。
    expect(outboxMocks.resendPending.mock.calls.length).toBeGreaterThan(3)
  })

  it('本当の配送失敗（eventId の無い 503）は従来どおり 3 cycle で CRITICAL', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async (url: string | URL | Request) => (
      String(url).includes('/api/jobs/job-1')
        ? new Response(JSON.stringify({ error: 'down' }), { status: 503 })
        : new Response(JSON.stringify([]), { status: 200 })
    ))
    outboxMocks.hasPending.mockReturnValue(true)
    outboxMocks.resendPending.mockImplementation(async (patchFn: (id: string, p: unknown) => Promise<boolean>) => {
      await patchFn('job-1', { status: 'success', eventId: 'e1', payloadHash: 'h' })
    })

    void pollJobs()
    await flushPollCycle()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 3)
    await Promise.resolve()

    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
    expect(notifierMocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical', title: 'Worker Outbox resend is blocked' }),
    )
  })
})

describe('Outbox 滞留通知 — 本当の失敗を抑止しない（Tier B 独立レビュー観点）', () => {
  const resendTwo = (): void => {
    outboxMocks.resendPending.mockImplementation(async (patchFn: (id: string, p: unknown) => Promise<boolean>) => {
      await patchFn('job-1', { status: 'success', eventId: 'e1', payloadHash: 'h1' })
      await patchFn('job-2', { status: 'success', eventId: 'e2', payloadHash: 'h2' })
    })
  }

  async function runCycles(cycles: number): Promise<void> {
    void pollJobs()
    await flushPollCycle()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * cycles)
    await Promise.resolve()
  }

  it('本文が JSON でない 503 は本当の失敗として 3 cycle で CRITICAL', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async (url: string | URL | Request) => (
      String(url).includes('/api/jobs/job-1')
        ? new Response('<html>503 Service Unavailable</html>', { status: 503 })
        : new Response(JSON.stringify([]), { status: 200 })
    ))
    outboxMocks.hasPending.mockReturnValue(true)
    outboxMocks.resendPending.mockImplementation(async (patchFn: (id: string, p: unknown) => Promise<boolean>) => {
      await patchFn('job-1', { status: 'success', eventId: 'e1', payloadHash: 'h' })
    })

    await runCycles(3)

    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('同じ cycle に continuation pending と本当の失敗が混じれば、従来どおり 3 cycle で CRITICAL', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const target = String(url)
      if (target.includes('/api/jobs/job-1')) {
        return new Response(JSON.stringify({ id: 'job-1', outbox: { eventId: 'e1', deduplicated: false } }), { status: 503 })
      }
      if (target.includes('/api/jobs/job-2')) return new Response(JSON.stringify({ error: 'down' }), { status: 500 })
      return new Response(JSON.stringify([]), { status: 200 })
    })
    outboxMocks.hasPending.mockReturnValue(true)
    resendTwo()

    // 1 cycle に PATCH が2本（各3回 retry + backoff）あるので、時間ではなく完了した再送 cycle 数で確かめる。
    // 再送の呼び出しが N+1 回目に入った時点で N cycle 分の判定は済んでいる。
    void pollJobs()
    await flushPollCycle()
    const advanceUntilResendCalls = async (calls: number): Promise<void> => {
      for (let i = 0; i < 40 && outboxMocks.resendPending.mock.calls.length < calls; i += 1) {
        await vi.advanceTimersByTimeAsync(500)
      }
    }
    await advanceUntilResendCalls(3)
    expect(outboxMocks.resendPending.mock.calls.length).toBe(3)
    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()
    await advanceUntilResendCalls(4)
    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('別の Job の eventId を返す 503 は continuation pending とみなさない（eventId は完全一致）', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async (url: string | URL | Request) => (
      String(url).includes('/api/jobs/job-1')
        ? new Response(JSON.stringify({ id: 'job-1', outbox: { eventId: 'e1-other', deduplicated: false } }), { status: 503 })
        : new Response(JSON.stringify([]), { status: 200 })
    ))
    outboxMocks.hasPending.mockReturnValue(true)
    outboxMocks.resendPending.mockImplementation(async (patchFn: (id: string, p: unknown) => Promise<boolean>) => {
      await patchFn('job-1', { status: 'success', eventId: 'e1', payloadHash: 'h' })
    })

    await runCycles(3)

    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('再送の例外（resendPending 自体の失敗）は本当の失敗として 3 cycle で CRITICAL', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    outboxMocks.hasPending.mockReturnValue(true)
    outboxMocks.resendPending.mockRejectedValue(new Error('outbox db locked'))

    await runCycles(3)

    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
  })
})

describe('Outbox 滞留通知 — continuation が恒久的に壊れていても壁時計で必ず鳴る', () => {
  it('continuation pending の 503 だけが 10 分を超えて続けば CRITICAL を1回出す', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async (url: string | URL | Request) => (
      String(url).includes('/api/jobs/job-1')
        ? new Response(JSON.stringify({ id: 'job-1', outbox: { eventId: 'e1', deduplicated: false } }), { status: 503 })
        : new Response(JSON.stringify([]), { status: 200 })
    ))
    outboxMocks.hasPending.mockReturnValue(true)
    outboxMocks.resendPending.mockImplementation(async (patchFn: (id: string, p: unknown) => Promise<boolean>) => {
      await patchFn('job-1', { status: 'success', eventId: 'e1', payloadHash: 'h' })
    })

    void pollJobs()
    await flushPollCycle()
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000)
    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
    expect(notifierMocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical', title: 'Worker Outbox resend is blocked' }),
    )
  })
})

describe('poll cycle 先頭の reconcile 呼び出しに期限がある（応答の無い API で loop 全体を止めない）', () => {
  it.each([
    ['task continuation', reconcileTaskContinuations, '/api/task-continuations/reconcile'],
    ['supervised run', reconcileSupervisedRuns, '/api/supervised-runs/reconcile'],
  ] as const)('%s reconcile の fetch は AbortSignal を持つ', async (_label, reconcile, path) => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }))

    await reconcile()

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(path),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('期限切れ（abort）は warn して例外を外へ出さない（次の処理へ進む）', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))

    await expect(reconcileTaskContinuations()).resolves.toBeUndefined()
    await expect(reconcileSupervisedRuns()).resolves.toBeUndefined()
  })
})
