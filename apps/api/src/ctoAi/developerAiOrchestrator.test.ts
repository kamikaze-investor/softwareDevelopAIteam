import { describe, it, expect } from 'vitest'
import { runDeveloperAi, DeveloperAiRequestSchema } from './developerAiOrchestrator.js'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `dev-ai-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('DeveloperAiRequestSchema', () => {
  it('最小限のフィールドでバリデーション通過', () => {
    const result = DeveloperAiRequestSchema.safeParse({
      instruction: '型定義を追加してください',
      targetProjectRoot: '/tmp/project',
      taskId: 'task-001',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.provider).toBe('claude')         // デフォルト
      expect(result.data.timeoutMs).toBe(300_000)         // デフォルト
      expect(result.data.mockRun).toBe(false)             // デフォルト
    }
  })

  it('provider が不正な値はエラー', () => {
    const result = DeveloperAiRequestSchema.safeParse({
      instruction: '何か',
      targetProjectRoot: '/tmp',
      taskId: 'task-001',
      provider: 'gpt4',
    })
    expect(result.success).toBe(false)
  })

  it('instruction が空だとエラー', () => {
    const result = DeveloperAiRequestSchema.safeParse({
      instruction: '',
      targetProjectRoot: '/tmp',
      taskId: 'task-001',
    })
    expect(result.success).toBe(false)
  })
})

describe('runDeveloperAi (mockRun)', () => {
  it('mockRun=true で status=mock を返す', async () => {
    const result = await runDeveloperAi({
      provider: 'claude',
      instruction: '共有型定義を実装してください',
      targetProjectRoot: tmpDir(),
      taskId: 'task-001',
      timeoutMs: 300_000,
      mockRun: true,
    })

    expect(result.status).toBe('mock')
    expect(result.taskId).toBe('task-001')
    expect(result.provider).toBe('claude')
    expect(result.stdout).toContain('[MOCK]')
    expect(result.executedAt).toBeTruthy()
    expect(result.completedAt).toBeTruthy()
  })

  it('mockRun=true で changedFiles は空配列', async () => {
    const result = await runDeveloperAi({
      provider: 'codex',
      instruction: 'テスト',
      targetProjectRoot: tmpDir(),
      taskId: 'task-002',
      timeoutMs: 10_000,
      mockRun: true,
    })
    expect(result.changedFiles).toEqual([])
    expect(result.durationMs).toBe(0)
  })

  // [codex-review P1] mockRun=false は明確なエラーを返す（壊れた動的importを防ぐ）
  it('mockRun=false は NotImplemented エラーをスローする', async () => {
    await expect(runDeveloperAi({
      provider: 'claude',
      instruction: 'テスト',
      targetProjectRoot: tmpDir(),
      taskId: 'task-001',
      timeoutMs: 10_000,
      mockRun: false,
    })).rejects.toThrow('Job Queue')
  })

  it('mockRun=true のとき provider 名が結果に含まれる', async () => {
    const result = await runDeveloperAi({
      provider: 'gemini',
      instruction: 'テスト',
      targetProjectRoot: tmpDir(),
      taskId: 'task-003',
      timeoutMs: 10_000,
      mockRun: true,
    })
    expect(result.provider).toBe('gemini')
    expect(result.stdout).toContain('gemini')
  })
})
