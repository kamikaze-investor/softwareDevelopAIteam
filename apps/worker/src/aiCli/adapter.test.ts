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

import { describe, it, expect } from 'vitest'
import { isPromptSafe } from '@ai-team/shared'
import { createAiCliAdapter } from './factory.js'

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
