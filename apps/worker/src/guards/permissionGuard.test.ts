import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SafeCommand } from '@ai-team/shared'
import { permissionGuard, permissionGuardWithGrants } from './permissionGuard.js'

const baseCommand: SafeCommand = {
  kind: 'git_status',
  workingDir: '/workspace/target',
}

// Mock isInsideTargetRoot to return true for /workspace/target
vi.mock('../utils/pathUtils.js', () => ({
  isInsideTargetRoot: (dir: string) => dir.startsWith('/workspace/target'),
}))

describe('permissionGuard (static)', () => {
  it('allows developer_ai for git_status', () => {
    const result = permissionGuard(baseCommand, 'developer_ai')
    expect(result.allowed).toBe(true)
  })

  it('blocks reviewer_ai for any command', () => {
    const result = permissionGuard(baseCommand, 'reviewer_ai')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('reviewer_ai')
  })

  it('blocks qa_ai for git_commit', () => {
    const result = permissionGuard({ ...baseCommand, kind: 'git_commit' }, 'qa_ai')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('qa_ai')
  })

  it('allows qa_ai for typecheck', () => {
    const result = permissionGuard({ ...baseCommand, kind: 'typecheck' }, 'qa_ai')
    expect(result.allowed).toBe(true)
  })

  it('blocks when workingDir is outside TARGET_ROOT', () => {
    const result = permissionGuard({ ...baseCommand, workingDir: '/etc' }, 'developer_ai')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('outside TARGET_ROOT')
  })

  it('blocks cto_ai (no canExecuteCommands)', () => {
    const result = permissionGuard(baseCommand, 'cto_ai')
    expect(result.allowed).toBe(false)
  })
})

describe('permissionGuardWithGrants (async)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('returns allowed: true when static policy allows and no grants found', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response)

    const result = await permissionGuardWithGrants(baseCommand, 'developer_ai', 'task-1', 'job-1', 'http://localhost:3000')
    expect(result.allowed).toBe(true)
  })

  it('blocks immediately when static policy rejects (no fetch call)', async () => {
    const result = await permissionGuardWithGrants(baseCommand, 'cto_ai', 'task-1', 'job-1', 'http://localhost:3000')
    expect(result.allowed).toBe(false)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('allows when a valid grant exists', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 'grant-1',
          taskId: 'task-1',
          agentRole: 'developer_ai',
          scope: 'task',
          allowedCommandKinds: ['git_status'],
          used: false,
          createdAt: new Date().toISOString(),
        },
      ],
    } as Response)

    const result = await permissionGuardWithGrants(baseCommand, 'developer_ai', 'task-1', 'job-1', 'http://localhost:3000')
    expect(result.allowed).toBe(true)
    expect(result.grant?.grantId).toBe('grant-1')
  })

  it('returns grant_expired blockEvent for expired grant', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 'grant-expired',
          taskId: 'task-1',
          agentRole: 'developer_ai',
          scope: 'task',
          allowedCommandKinds: ['git_status'],
          expiresAt: '2000-01-01T00:00:00.000Z',
          used: false,
          createdAt: new Date().toISOString(),
        },
      ],
    } as Response)

    const result = await permissionGuardWithGrants(baseCommand, 'developer_ai', 'task-1', 'job-1', 'http://localhost:3000')
    expect(result.allowed).toBe(false)
    expect(result.blockEvent?.type).toBe('grant_expired')
  })

  it('returns grant_used blockEvent for once grant that is used', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 'grant-used',
          taskId: 'task-1',
          agentRole: 'developer_ai',
          scope: 'once',
          allowedCommandKinds: ['git_status'],
          used: true,
          createdAt: new Date().toISOString(),
        },
      ],
    } as Response)

    const result = await permissionGuardWithGrants(baseCommand, 'developer_ai', 'task-1', 'job-1', 'http://localhost:3000')
    expect(result.allowed).toBe(false)
    expect(result.blockEvent?.type).toBe('grant_used')
  })

  it('calls markUsed for once grant after use', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 'grant-once',
            taskId: 'task-1',
            agentRole: 'developer_ai',
            scope: 'once',
            allowedCommandKinds: ['git_status'],
            used: false,
            createdAt: new Date().toISOString(),
          },
        ],
      } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)

    const result = await permissionGuardWithGrants(baseCommand, 'developer_ai', 'task-1', 'job-1', 'http://localhost:3000')
    expect(result.allowed).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain('/use')
    expect(fetchMock.mock.calls[1][1]).toEqual({ method: 'PATCH' })
  })

  it('falls back to allowed on fetch error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'))

    const result = await permissionGuardWithGrants(baseCommand, 'developer_ai', 'task-1', 'job-1', 'http://localhost:3000')
    expect(result.allowed).toBe(true)
  })
})
