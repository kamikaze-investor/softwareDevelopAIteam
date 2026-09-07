/**
 * AI CLI Adapter テスト
 *
 * Meta Review 指摘（low）: テストコードなし → 追加
 *
 * テスト対象:
 *   - workingDir 検証（TARGET_ROOT 外でエラー）
 *   - Secret Scan（プロンプトにsecretが混入したらエラー）
 *   - dryRun モード（実際に実行しない）
 *   - isPromptSafe() のパターンマッチ
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isPromptSafe, shouldFallback } from '@ai-team/shared'
import { createAiCliAdapter } from './factory.js'

const {
  execFileSyncMock,
  buildWorktreeManifestMock,
  saveJobLogsMock,
} = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  buildWorktreeManifestMock: vi.fn(),
  saveJobLogsMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}))

vi.mock('../guards/changeManifest.js', () => ({
  buildWorktreeManifest: buildWorktreeManifestMock,
}))

vi.mock('../jobLogger.js', () => ({
  saveJobLogs: saveJobLogsMock,
}))

vi.mock('../utils/pathUtils.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/pathUtils.js')>('../utils/pathUtils.js')
  return {
    ...actual,
    isInsideTargetRoot: (workingDir: string): boolean => {
      const cwd = process.cwd()
      return (
        actual.isInsideTargetRoot(workingDir) ||
        workingDir === cwd ||
        workingDir.startsWith(`${cwd}\\`) ||
        workingDir.startsWith(`${cwd}/`)
      )
    },
  }
})

beforeEach(() => {
  execFileSyncMock.mockReset()
  buildWorktreeManifestMock.mockReset()
  saveJobLogsMock.mockReset()
  buildWorktreeManifestMock.mockReturnValue({ changes: [], paths: [] })
  saveJobLogsMock.mockReturnValue({
    stdoutPath: 'stdout.log',
    stderrPath: 'stderr.log',
  })
})

// ────────────────────────────────────────────────────────────
// isPromptSafe() のテスト
// ────────────────────────────────────────────────────────────

describe('isPromptSafe', () => {
  it('通常のプロンプトは安全と判定する', () => {
    expect(isPromptSafe('ユーザー認証機能を実装してください')).toBe(true)
    expect(isPromptSafe('task-018: SQLite Storage を実装する')).toBe(true)
  })

  it('APIキーが含まれるプロンプトは危険と判定する', () => {
    expect(isPromptSafe('CLAUDE_API_KEY=sk-ant-...')).toBe(false)
    expect(isPromptSafe('ANTHROPIC_API_KEY=sk-ant-...')).toBe(false)
    expect(isPromptSafe('GEMINI_API_KEY=AIza...')).toBe(false)
    expect(isPromptSafe('GITHUB_TOKEN=ghp_...')).toBe(false)
  })

  it('秘密鍵が含まれるプロンプトは危険と判定する', () => {
    expect(isPromptSafe('-----BEGIN RSA PRIVATE KEY-----')).toBe(false)
    expect(isPromptSafe('-----BEGIN PRIVATE KEY-----')).toBe(false)
  })

  it('passwordが含まれるプロンプトは危険と判定する', () => {
    expect(isPromptSafe('password: mysecretpassword')).toBe(false)
    expect(isPromptSafe('secret=mysecretvalue')).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────
// BaseCliAdapter セキュリティチェックのテスト
// ────────────────────────────────────────────────────────────

describe('BaseCliAdapter セキュリティチェック', () => {
  const adapter = createAiCliAdapter({ provider: 'claude_code' })

  it('TARGET_ROOT 外の workingDir はエラーになる', async () => {
    await expect(adapter.run({
      taskId: 'test-001',
      provider: 'claude_code',
      workingDir: '/workspace/control',   // ⚠️ Control Repo → 禁止
      prompt: 'テスト',
      contextFiles: [],
      mode: 'implement',
    })).rejects.toThrow('TARGET_ROOT 外')
  })

  it('ホームディレクトリへのアクセスはエラーになる', async () => {
    await expect(adapter.run({
      taskId: 'test-002',
      provider: 'claude_code',
      workingDir: '/root',                // ⚠️ ホームディレクトリ → 禁止
      prompt: 'テスト',
      contextFiles: [],
      mode: 'implement',
    })).rejects.toThrow('TARGET_ROOT 外')
  })

  it('パストラバーサルはエラーになる', async () => {
    await expect(adapter.run({
      taskId: 'test-003',
      provider: 'claude_code',
      workingDir: '/workspace/target/../control',  // ⚠️ パストラバーサル
      prompt: 'テスト',
      contextFiles: [],
      mode: 'implement',
    })).rejects.toThrow('TARGET_ROOT 外')
  })

  it('secretが含まれるプロンプトはエラーになる', async () => {
    await expect(adapter.run({
      taskId: 'test-004',
      provider: 'claude_code',
      workingDir: '/workspace/target',
      prompt: 'GEMINI_API_KEY=AIzaSecretKey を使って実装してください',
      contextFiles: [],
      mode: 'implement',
    })).rejects.toThrow('secret が検出')
  })

  it('dryRun モードは実際に実行せず即座に返る', async () => {
    // dryRun は workingDir チェック後に評価されるため、
    // TARGET_ROOT 外でも dryRun より先にエラーになることを確認
    await expect(adapter.run({
      taskId: 'test-005',
      provider: 'claude_code',
      workingDir: '/workspace/target',   // ここは通る（TARGET_ROOT 内）
      prompt: '正常なプロンプト',
      contextFiles: [],
      mode: 'implement',
      dryRun: true,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: '[DRY RUN] 実行をスキップしました',
      changedFiles: [],
    })
  })
})

// ────────────────────────────────────────────────────────────
// H-1対策: CLAUDE.md注入のテスト
// ────────────────────────────────────────────────────────────

describe('H-1対策: CLAUDE.md注入', () => {
  it('codex provider は dryRun=true でも injectClaudeMd が動作しない（dryRunは注入前にreturn）', async () => {
    const codexAdapter = createAiCliAdapter({ provider: 'codex' })
    const result = await codexAdapter.run({
      taskId: 'test-h1-1',
      provider: 'codex',
      workingDir: '/workspace/target',
      prompt: 'テスト実装',
      contextFiles: [],
      mode: 'implement',
      dryRun: true,
    })
    // dryRun は注入なしで即リターン（注入はCLI実行直前に行われる）
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('[DRY RUN]')
  })

  it('claude_code provider は injectClaudeMd=false でも注入しない（もともと不要）', async () => {
    const claudeAdapter = createAiCliAdapter({ provider: 'claude_code' })
    // claude_code は CLAUDE.md を自動読込するので注入不要
    // injectClaudeMd フラグは claude_code では無視される（adapter.ts の条件分岐で skip）
    await expect(claudeAdapter.run({
      taskId: 'test-h1-2',
      provider: 'claude_code',
      workingDir: '/workspace/target',
      prompt: '正常なプロンプト',
      contextFiles: [],
      mode: 'implement',
      dryRun: true,
    })).resolves.toMatchObject({ exitCode: 0 })
  })
})

// ────────────────────────────────────────────────────────────
// M-2対策: FallbackPolicy のテスト
// ────────────────────────────────────────────────────────────

describe('M-2対策: shouldFallback', () => {
  it('api_error 条件: APIエラー時のみフォールバック', () => {
    const policy = { fallbackProvider: 'codex' as const, condition: 'api_error' as const }
    expect(shouldFallback(policy, 1, false, true)).toBe(true)   // APIエラー → fallback
    expect(shouldFallback(policy, 1, true, false)).toBe(false)  // timeout → no fallback
    expect(shouldFallback(policy, 1, false, false)).toBe(false) // その他エラー → no fallback
  })

  it('timeout 条件: タイムアウト時のみフォールバック', () => {
    const policy = { fallbackProvider: 'codex' as const, condition: 'timeout' as const }
    expect(shouldFallback(policy, 1, true, false)).toBe(true)   // timeout → fallback
    expect(shouldFallback(policy, 1, false, true)).toBe(false)  // APIエラー → no fallback
  })

  it('any_error 条件: 任意エラーでフォールバック', () => {
    const policy = { fallbackProvider: 'codex' as const, condition: 'any_error' as const }
    expect(shouldFallback(policy, 0, false, false)).toBe(false) // 成功 → no fallback
    expect(shouldFallback(policy, 1, false, false)).toBe(true)  // エラー → fallback
  })
})

// ────────────────────────────────────────────────────────────
// CodexAdapter: stdin prompt テスト
// ────────────────────────────────────────────────────────────

import { CodexAdapter } from './codexAdapter.js'
import type { AiCliRequest } from '@ai-team/shared'

describe('CodexAdapter — stdin prompt', () => {
  it('buildArgv は末尾に - を置く（プロンプトは stdin 経由）', () => {
    class TestCodexAdapter extends CodexAdapter {
      testArgv(r: AiCliRequest) { return this.buildArgv(r) }
    }
    const adapter = new TestCodexAdapter({ provider: 'codex' })
    const argv = adapter.testArgv({
      provider: 'codex',
      taskId: 't1',
      workingDir: '/workspace/target/app',
      prompt: 'hello world',
      contextFiles: [],
      mode: 'implement',
    })
    expect(argv[argv.length - 1]).toBe('-')
    expect(argv.join(' ')).not.toContain('hello world')
  })

  it('model 指定時は --model とモデルIDを隣接して argv に含め、末尾は - のままにする', () => {
    class TestCodexAdapter extends CodexAdapter {
      testArgv(r: AiCliRequest): string[] { return this.buildArgv(r) }
    }
    const adapter = new TestCodexAdapter({ provider: 'codex' })
    const argv = adapter.testArgv({
      provider: 'codex',
      taskId: 't1',
      workingDir: '/workspace/target/app',
      prompt: 'hello world',
      contextFiles: [],
      mode: 'review',
      model: 'gpt-5.6-sol',
    })
    const modelFlagIndex = argv.indexOf('--model')

    expect(modelFlagIndex).toBeGreaterThanOrEqual(0)
    expect(argv[modelFlagIndex + 1]).toBe('gpt-5.6-sol')
    expect(argv[argv.length - 1]).toBe('-')
  })

  it('reasoningEffort 指定時は -c model_reasoning_effort を argv に含め、末尾は - のままにする', () => {
    class TestCodexAdapter extends CodexAdapter {
      testArgv(r: AiCliRequest): string[] { return this.buildArgv(r) }
    }
    const adapter = new TestCodexAdapter({ provider: 'codex' })
    const argv = adapter.testArgv({
      provider: 'codex',
      taskId: 't1',
      workingDir: '/workspace/target/app',
      prompt: 'hello world',
      contextFiles: [],
      mode: 'review',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
    })
    const flagIndex = argv.indexOf('-c')

    expect(flagIndex).toBeGreaterThanOrEqual(0)
    expect(argv[flagIndex + 1]).toBe('model_reasoning_effort="xhigh"')
    expect(argv[argv.length - 1]).toBe('-')
  })

  it('reasoningEffort 未指定時は -c を argv に含めない（既存呼び出し元のargvは不変）', () => {
    class TestCodexAdapter extends CodexAdapter {
      testArgv(r: AiCliRequest): string[] { return this.buildArgv(r) }
    }
    const adapter = new TestCodexAdapter({ provider: 'codex' })
    const argv = adapter.testArgv({
      provider: 'codex',
      taskId: 't1',
      workingDir: '/workspace/target/app',
      prompt: 'hello world',
      contextFiles: [],
      mode: 'review',
    })

    expect(argv).not.toContain('-c')
  })

  it('review modeは --sandbox read-only で起動する（生成中にrepoを書き換えさせない）', () => {
    class TestCodexAdapter extends CodexAdapter {
      testArgv(r: AiCliRequest): string[] { return this.buildArgv(r) }
    }
    const adapter = new TestCodexAdapter({ provider: 'codex' })
    const argv = adapter.testArgv({
      provider: 'codex',
      taskId: 't1',
      workingDir: '/workspace/target/app',
      prompt: 'p',
      contextFiles: [],
      mode: 'review',
    })
    const sandboxIndex = argv.indexOf('--sandbox')

    expect(argv[sandboxIndex + 1]).toBe('read-only')
  })

  it('model 未指定時は --model を argv に含めない', () => {
    class TestCodexAdapter extends CodexAdapter {
      testArgv(r: AiCliRequest): string[] { return this.buildArgv(r) }
    }
    const adapter = new TestCodexAdapter({ provider: 'codex' })
    const argv = adapter.testArgv({
      provider: 'codex',
      taskId: 't1',
      workingDir: '/workspace/target/app',
      prompt: 'hello world',
      contextFiles: [],
      mode: 'implement',
    })

    expect(argv).not.toContain('--model')
  })
})

describe('CodexAdapter --output-last-message structured output', () => {
  let testDir: string | undefined

  afterEach(() => {
    if (testDir !== undefined) {
      rmSync(testDir, { recursive: true, force: true })
      testDir = undefined
    }
  })

  function makeWorkingDir(): string {
    testDir = mkdtempSync(path.join(process.cwd(), '.adapter-test-codex-'))
    return testDir
  }

  function makeRequest(workingDir: string): AiCliRequest {
    return {
      taskId: 'test-codex-last-message',
      provider: 'codex',
      workingDir,
      prompt: 'Return JSON only.',
      contextFiles: [],
      mode: 'review',
      expectJson: true,
      injectClaudeMd: false,
      postLint: false,
    }
  }

  it('uses last-message JSON and skips stdout retry when parsing succeeds', async () => {
    const workingDir = makeWorkingDir()
    const adapter = new CodexAdapter({ provider: 'codex', cliPath: 'codex', maxRetries: 2 })

    execFileSyncMock.mockImplementation((_exe: string, argv: readonly string[] | undefined): string => {
      const args = argv ?? []
      const outputFlagIndex = args.indexOf('--output-last-message')
      expect(outputFlagIndex).toBeGreaterThanOrEqual(0)
      const outputPath = args[outputFlagIndex + 1]
      expect(outputPath).toBeTruthy()
      if (outputPath === undefined) throw new Error('missing --output-last-message path')
      writeFileSync(outputPath, '{"ok":true,"source":"last-message"}', 'utf-8')
      return 'not json'
    })

    const result = await adapter.run(makeRequest(workingDir))

    expect(result.parsedOutput).toEqual({ ok: true, source: 'last-message' })
    expect(result.blocked).toBe(false)
    expect(result.retryCount).toBe(0)
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    const initialArgv = execFileSyncMock.mock.calls[0]?.[1]
    expect(initialArgv).toContain('--output-last-message')
    const outputPath = initialArgv?.[initialArgv.indexOf('--output-last-message') + 1]
    expect(outputPath).toBeTruthy()
    if (outputPath === undefined) throw new Error('missing --output-last-message path')
    expect(existsSync(outputPath)).toBe(false)
    expect(buildWorktreeManifestMock).toHaveBeenCalledWith(workingDir)
  })

  // Regression: the `--output-last-message` capture file used to be created directly inside
  // `workingDir`, i.e. inside the target repository. It was removed afterwards, but a crash or
  // SIGKILL between the two left an untracked file behind, and a "read-only" reviewer/generator
  // that writes into the repo at all cannot honestly claim the repo is untouched.
  // The assertion is deliberately stronger than "cleaned up afterwards": the repo must be
  // untouched **during** the run too, which is what a mid-run snapshot checks.
  it('creates the capture file outside workingDir and never writes into the repo', async () => {
    const workingDir = makeWorkingDir()
    const adapter = new CodexAdapter({ provider: 'codex', cliPath: 'codex', maxRetries: 2 })
    let repoContentsDuringRun: string[] | undefined
    let capturedPath: string | undefined

    execFileSyncMock.mockImplementation((_exe: string, argv: readonly string[] | undefined): string => {
      const args = argv ?? []
      capturedPath = args[args.indexOf('--output-last-message') + 1]
      if (capturedPath === undefined) throw new Error('missing --output-last-message path')
      writeFileSync(capturedPath, '{"ok":true}', 'utf-8')
      // Snapshot the target repo at the moment Codex would be running.
      repoContentsDuringRun = readdirSync(workingDir)
      return 'not json'
    })

    const result = await adapter.run(makeRequest(workingDir))
    expect(result.parsedOutput).toEqual({ ok: true })

    if (capturedPath === undefined) throw new Error('missing --output-last-message path')
    expect(capturedPath.startsWith(workingDir)).toBe(false)
    expect(capturedPath.startsWith(os.tmpdir())).toBe(true)

    // not even for an instant
    expect(repoContentsDuringRun).toEqual([])
    expect(readdirSync(workingDir)).toEqual([])

    // the dedicated temp directory is cleaned up as well, not just the file
    expect(existsSync(capturedPath)).toBe(false)
    expect(existsSync(path.dirname(capturedPath))).toBe(false)
  })

  // Independent review finding 1 (2026-09-08): a lexical `startsWith` prefix check authorised
  // recursive deletion, so a path like `<tmp>/codex-lastmsg-x/../../srv/data/f.json` passed the
  // check and then `rmSync` resolved the `..` and deleted an unrelated directory.
  it('does not delete a directory reached by traversing out of the temp prefix', async () => {
    const { cleanupCodexOutputLastMessage } = await import('./adapter.js')

    const victim = mkdtempSync(path.join(os.tmpdir(), 'victim-'))
    writeFileSync(path.join(victim, 'precious.txt'), 'do not delete', 'utf-8')

    // Built by string concatenation on purpose: `path.join` would normalise the `..` away at
    // construction time and the crafted path would never reach the guard. Lexically this still
    // starts with the capture prefix, but it resolves to the victim directory -- which is exactly
    // what the old `startsWith` check authorised `rmSync` to delete recursively.
    const traversal = os.tmpdir() + path.sep + 'codex-lastmsg-fake' + path.sep + '..'
      + path.sep + path.basename(victim) + path.sep + 'result.json'

    cleanupCodexOutputLastMessage(traversal)

    expect(existsSync(victim)).toBe(true)
    expect(existsSync(path.join(victim, 'precious.txt'))).toBe(true)
    rmSync(victim, { recursive: true, force: true })
  })

  // Independent review finding 2 (2026-09-08): `os.tmpdir()` was assumed to be outside the
  // target repo. With TMPDIR pointing inside it, the capture file lands in the repository and
  // silently breaks the read-only guarantee. Fail closed instead.
  it('refuses to run when the OS temp dir resolves inside the target repo', async () => {
    const workingDir = makeWorkingDir()
    const insideRepo = path.join(workingDir, '.tmp')
    mkdirSync(insideRepo, { recursive: true })

    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }
    process.env.TMPDIR = insideRepo
    process.env.TEMP = insideRepo
    process.env.TMP = insideRepo

    try {
      const adapter = new CodexAdapter({ provider: 'codex', cliPath: 'codex', maxRetries: 2 })
      await expect(adapter.run(makeRequest(workingDir))).rejects.toThrow(/OS temp directory/)
      expect(execFileSyncMock).not.toHaveBeenCalled()
    } finally {
      process.env.TMPDIR = saved.TMPDIR
      process.env.TEMP = saved.TEMP
      process.env.TMP = saved.TMP
    }
  })

  it('falls back to stdout retry when last-message parsing fails', async () => {
    const workingDir = makeWorkingDir()
    const adapter = new CodexAdapter({ provider: 'codex', cliPath: 'codex', maxRetries: 2 })
    let firstOutputPath: string | undefined

    execFileSyncMock.mockImplementation((_exe: string, argv: readonly string[] | undefined): string => {
      const args = argv ?? []
      const outputFlagIndex = args.indexOf('--output-last-message')
      if (outputFlagIndex >= 0) {
        const outputPath = args[outputFlagIndex + 1]
        if (outputPath === undefined) throw new Error('missing --output-last-message path')
        firstOutputPath = outputPath
        writeFileSync(outputPath, 'not json', 'utf-8')
        return 'still not json'
      }
      return '{"ok":true,"source":"stdout-retry"}'
    })

    const result = await adapter.run(makeRequest(workingDir))

    expect(result.parsedOutput).toEqual({ ok: true, source: 'stdout-retry' })
    expect(result.blocked).toBe(false)
    expect(result.retryCount).toBe(1)
    expect(execFileSyncMock).toHaveBeenCalledTimes(2)
    expect(execFileSyncMock.mock.calls[0]?.[1]).toContain('--output-last-message')
    expect(execFileSyncMock.mock.calls[1]?.[1]).not.toContain('--output-last-message')
    expect(firstOutputPath).toBeTruthy()
    if (firstOutputPath === undefined) throw new Error('missing --output-last-message path')
    expect(existsSync(firstOutputPath)).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────
// factory のテスト
// ────────────────────────────────────────────────────────────

describe('createAiCliAdapter', () => {
  it('claude_code プロバイダーを生成できる', () => {
    expect(() => createAiCliAdapter({ provider: 'claude_code' })).not.toThrow()
  })

  it('gemini プロバイダーを生成できる', () => {
    expect(() => createAiCliAdapter({ provider: 'gemini' })).not.toThrow()
  })

  it('codex プロバイダーを生成できる', () => {
    expect(() => createAiCliAdapter({ provider: 'codex' })).not.toThrow()
  })
})
