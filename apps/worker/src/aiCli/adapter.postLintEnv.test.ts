/**
 * postLint（Codex実行後の自動lint）が target-project へ渡す env のテスト
 *
 * P0-2: postLint は target 管理の package script（`pnpm lint --fix`）を経由するため、
 * env を未指定で execFileSync すると Worker プロセスの全環境変数（秘密情報含む）が
 * そのまま継承されてしまっていた。buildTargetCommandEnv() を渡すことで
 * allowlist 化されたことを検証する。
 *
 * adapter.windowsExe.test.ts とは別ファイルに分離する理由: postLint を確実に発火させるには
 * changedFiles.length > 0 が必要で、そのために buildWorktreeManifest をモックする必要があり、
 * 既存の adapter.windowsExe.test.ts（実 changeManifest 呼び出しの tolerant なテスト）とは
 * 前提が異なるため。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
}))

vi.mock('../guards/changeManifest.js', () => ({
  buildWorktreeManifest: vi.fn(() => ({ paths: ['src/changed.ts'], changes: [] })),
}))

import { execFileSync } from 'node:child_process'
import { createAiCliAdapter } from './factory.js'
import type { AiCliRequest } from '@ai-team/shared'

const mockExecFileSync = vi.mocked(execFileSync)

const BASE_REQUEST: AiCliRequest = {
  provider: 'codex',
  taskId: 'post-lint-env-test',
  workingDir: '/workspace/target',
  prompt: 'test',
  contextFiles: [],
  mode: 'implement',
}

const SECRET_ENV_BACKUP: Record<string, string | undefined> = {}

beforeEach(() => {
  vi.clearAllMocks()
  mockExecFileSync.mockReturnValue('' as any)

  for (const key of ['API_TOKEN', 'DB_PATH', 'OPENAI_API_KEY', 'CLAUDE_API_KEY', 'GEMINI_API_KEY']) {
    SECRET_ENV_BACKUP[key] = process.env[key]
    process.env[key] = `secret-${key}`
  }
})

function findPostLintCall() {
  return mockExecFileSync.mock.calls.find((c) => {
    const args = c[1] as string[] | undefined
    return Array.isArray(args) && args.some((a) => a === 'lint')
  })
}

describe('postLint の env allowlist', () => {
  it('postLint 実行時に buildTargetCommandEnv() が渡され、Worker 秘密情報が見えない', async () => {
    const adapter = createAiCliAdapter({ provider: 'codex' })

    await adapter.run({ ...BASE_REQUEST, postLint: undefined }).catch(() => {})

    const lintCall = findPostLintCall()
    expect(lintCall).toBeDefined()

    const options = lintCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined
    expect(options?.env).toBeDefined()
    expect(options?.env?.API_TOKEN).toBeUndefined()
    expect(options?.env?.DB_PATH).toBeUndefined()
    expect(options?.env?.OPENAI_API_KEY).toBeUndefined()
    expect(options?.env?.CLAUDE_API_KEY).toBeUndefined()
    expect(options?.env?.GEMINI_API_KEY).toBeUndefined()
    expect(options?.env?.PATH).toBe(process.env.PATH)
  })

  it('changedFiles が空なら postLint 自体が呼ばれない（既存挙動の確認）', async () => {
    const { buildWorktreeManifest } = await import('../guards/changeManifest.js')
    vi.mocked(buildWorktreeManifest).mockReturnValueOnce({ paths: [], changes: [] } as any)

    const adapter = createAiCliAdapter({ provider: 'codex' })
    await adapter.run({ ...BASE_REQUEST, postLint: undefined }).catch(() => {})

    expect(findPostLintCall()).toBeUndefined()
  })
})
