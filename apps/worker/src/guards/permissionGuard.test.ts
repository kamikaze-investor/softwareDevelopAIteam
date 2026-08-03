import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
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

const API_URL = 'http://localhost:3000'

function makeGrant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'grant-1',
    taskId: 'task-1',
    agentRole: 'developer_ai',
    scope: 'task',
    allowedCommandKinds: ['git_status'],
    used: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

/** status を含む最小の Response モック（実 API は 200 を返す） */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function run(role: Parameters<typeof permissionGuardWithGrants>[1] = 'developer_ai') {
  return permissionGuardWithGrants(baseCommand, role, 'task-1', 'job-1', API_URL)
}

describe('permissionGuardWithGrants (async)', () => {
  const TOKEN_BACKUP: { value?: string } = {}

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    TOKEN_BACKUP.value = process.env.API_TOKEN
    delete process.env.API_TOKEN
  })

  afterEach(() => {
    if (TOKEN_BACKUP.value === undefined) delete process.env.API_TOKEN
    else process.env.API_TOKEN = TOKEN_BACKUP.value
  })

  // ── 正常系（既存フローの維持） ────────────────────────────────

  it('200 + 空配列（グラント無し）は既存どおり静的ポリシーの判定で許可する', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse([]))

    const result = await run()
    expect(result.allowed).toBe(true)
    expect(result.technicalFailure).toBeUndefined()
  })

  it('blocks immediately when static policy rejects (no fetch call)', async () => {
    const result = await run('cto_ai')
    expect(result.allowed).toBe(false)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('allows when a valid grant exists', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse([makeGrant()]))

    const result = await run()
    expect(result.allowed).toBe(true)
    expect(result.grant?.grantId).toBe('grant-1')
  })

  it('returns grant_expired blockEvent for expired grant（技術障害ではない）', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse([makeGrant({ id: 'grant-expired', expiresAt: '2000-01-01T00:00:00.000Z' })]),
    )

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.blockEvent?.type).toBe('grant_expired')
    expect(result.technicalFailure).toBeUndefined()
  })

  it('returns grant_used blockEvent for once grant that is used（技術障害ではない）', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse([makeGrant({ id: 'grant-used', scope: 'once', used: true })]),
    )

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.blockEvent?.type).toBe('grant_used')
    expect(result.technicalFailure).toBeUndefined()
  })

  // ── 認証ヘッダー ──────────────────────────────────────────────

  it('API_TOKEN 設定時は Authorization header が付く', async () => {
    process.env.API_TOKEN = 'test-secret-token'
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse([]))

    await run()

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-secret-token')
  })

  it('API_TOKEN 未設定のローカル開発モードでは Authorization header を付けない', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse([]))

    const result = await run()

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    expect(result.allowed).toBe(true)
  })

  it('token を reason へ含めない（401 の場合）', async () => {
    process.env.API_TOKEN = 'super-secret-token-value'
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Invalid token' }, 401))

    const result = await run()
    expect(result.technicalFailure).toBe(true)
    expect(result.reason).not.toContain('super-secret-token-value')
  })

  // ── fail-closed（旧 fail-open 経路） ─────────────────────────

  it.each([401, 403, 404, 409, 429, 500, 503])(
    'HTTP %i を grant 扱いにせず technical failure にする',
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'x' }, status))

      const result = await run()
      expect(result.allowed).toBe(false)
      expect(result.technicalFailure).toBe(true)
      expect(result.reason).toContain(`HTTP ${status}`)
    },
  )

  it('network error を grant 扱いにしない（旧 fail-open の是正）', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
  })

  it('timeout（AbortError）を grant 扱いにしない', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    vi.mocked(fetch).mockRejectedValue(abortErr)

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
    expect(result.reason).toContain('timeout')
  })

  it('不正 JSON を grant 扱いにしない', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
    } as unknown as Response)

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
  })

  it('200 だが配列でないレスポンスを grant 扱いにしない', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'unexpected' }))

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
    expect(result.reason).toContain('invalid response')
  })

  it('200 だが要素が PermissionGrant 形式でないレスポンスを grant 扱いにしない', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse([{ nope: true }]))

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
  })

  // ── closure修正（Codex指摘）: enum検証・timeout範囲・token/本文漏えい ──────

  it('scope が既知の値でない grant を grant 扱いにしない（Codex指摘#2a）', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse([makeGrant({ id: 'g-bad-scope', scope: 'invalid-scope' })]),
    )

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
  })

  it('agentRole が既知の値でない grant を grant 扱いにしない（Codex指摘#2a）', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse([makeGrant({ id: 'g-bad-role', agentRole: 'not_a_real_role' })]),
    )

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
  })

  it('response body の読み取りが停止しても timeout する（Codex指摘#2b）', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal
      return Promise.resolve({
        ok: true,
        status: 200,
        // header 受信後、本文読み取りが完了しない実 fetch の挙動を模倣する:
        // AbortSignal が発火したら json() が AbortError で reject される。
        json: () => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
          })
        }),
      } as unknown as Response)
    })

    const pending = run()
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await pending

    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
    expect(result.reason).toContain('timeout')
    vi.useRealTimers()
  })

  it('reason へ応答本文の断片を含めない（不正 JSON の場合、Codex指摘#6b）', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in <html>LEAKED-SECRET-abc123</html>') },
    } as unknown as Response)

    const result = await run()
    expect(result.technicalFailure).toBe(true)
    expect(result.reason).not.toContain('LEAKED-SECRET')
    expect(result.reason).not.toContain('<html>')
  })

  // ── once グラントの使用済み記録 ───────────────────────────────

  it('once グラントは markUsed 成功後にだけ許可する', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse([makeGrant({ id: 'grant-once', scope: 'once' })]))
      .mockResolvedValueOnce(jsonResponse(makeGrant({ id: 'grant-once', scope: 'once', used: true })))

    const result = await run()
    expect(result.allowed).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain('/use')
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('PATCH')
  })

  it('markUsed に Authorization header が付く', async () => {
    process.env.API_TOKEN = 'test-secret-token'
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse([makeGrant({ id: 'grant-once', scope: 'once' })]))
      .mockResolvedValueOnce(jsonResponse(makeGrant({ id: 'grant-once', scope: 'once', used: true })))

    await run()

    const headers = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-secret-token')
  })

  it.each([401, 404, 500])(
    'markUsed が HTTP %i のとき Job を続行しない（technical failure）',
    async (status) => {
      const fetchMock = vi.mocked(fetch)
      fetchMock
        .mockResolvedValueOnce(jsonResponse([makeGrant({ id: 'grant-once', scope: 'once' })]))
        .mockResolvedValueOnce(jsonResponse({ error: 'x' }, status))

      const result = await run()
      expect(result.allowed).toBe(false)
      expect(result.technicalFailure).toBe(true)
      expect(result.reason).toContain('permission-grants/use')
    },
  )

  it('markUsed が network error のとき Job を続行しない', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse([makeGrant({ id: 'grant-once', scope: 'once' })]))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
  })

  it('markUsed が不正 JSON のとき Job を続行しない', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse([makeGrant({ id: 'grant-once', scope: 'once' })]))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('bad json') },
      } as unknown as Response)

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
  })

  it('markUsed が期待形式でないとき Job を続行しない', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse([makeGrant({ id: 'grant-once', scope: 'once' })]))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
    expect(result.reason).toContain('mark-used not confirmed')
  })

  it('markUsed が別 grant の id を返すとき failed にする（Codex指摘#3）', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse([makeGrant({ id: 'grant-once', scope: 'once' })]))
      .mockResolvedValueOnce(jsonResponse(makeGrant({ id: 'DIFFERENT-GRANT-ID', scope: 'once', used: true })))

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
    expect(result.reason).toContain('mark-used not confirmed')
  })

  it('markUsed が used:false のまま 200 を返すとき failed にする（Codex指摘#3）', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse([makeGrant({ id: 'grant-once', scope: 'once' })]))
      .mockResolvedValueOnce(jsonResponse(makeGrant({ id: 'grant-once', scope: 'once', used: false })))

    const result = await run()
    expect(result.allowed).toBe(false)
    expect(result.technicalFailure).toBe(true)
    expect(result.reason).toContain('mark-used not confirmed')
  })
})
