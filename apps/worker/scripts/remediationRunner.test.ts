import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/aiCli/factory.js', () => ({
  createAiCliAdapter: vi.fn(),
}))

import { createAiCliAdapter } from '../src/aiCli/factory.js'
import { runRemediation, type RemediationRunnerInput } from './remediationRunner'

/**
 * runner は「実行者であって authority ではない」。ここで固定するのは
 *   1. **model 未指定では走らない**（CLI 既定モデルへ落ちると flagship 保証が黙って破れる）
 *   2. 提案生成中にリポジトリを書き換えられない（read-only sandbox / lint 無効）
 *   3. 応答が取れないことを「修正不要」として下流へ流さない（fail-closed）
 * である。判定・採用・Job 生成はここには無い。
 */

const mockCreateAiCliAdapter = vi.mocked(createAiCliAdapter)

function input(over: Partial<RemediationRunnerInput> = {}): RemediationRunnerInput {
  return {
    taskId: 'task-1',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    prompt: 'remediate this',
    workingDir: '/workspace/target',
    ...over,
  }
}

function adapterReturning(result: Record<string, unknown>): { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn().mockResolvedValue({
    taskId: 'task-1', provider: 'codex', exitCode: 0, stdout: '', stderr: '',
    changedFiles: [], durationMs: 1, ...result,
  })
  mockCreateAiCliAdapter.mockReturnValue({ run } as never)
  return { run }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runRemediation', () => {
  it('model が空なら実行しない（CLI 既定モデルへ落とさない）', async () => {
    const { run } = adapterReturning({ stdout: '{}' })

    await expect(runRemediation(input({ model: '  ' }))).rejects.toThrow(/model は必須/)
    expect(run).not.toHaveBeenCalled()
  })

  it('read-only sandbox で走らせ、lint による書き換えも塞ぐ', async () => {
    // `mode: 'review'` が codexAdapter の `--sandbox read-only` を選ぶ。
    // `postLint: false` で生成後に formatter がファイルを書き換える経路も塞ぐ。
    const { run } = adapterReturning({ stdout: '{"diagnosis":"d"}' })

    await runRemediation(input())

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'review',
      postLint: false,
      expectJson: true,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
    }))
  })

  it('parsedOutput があればそれを権威とする（narration を再 parse しない）', async () => {
    adapterReturning({ stdout: 'noisy narration {}', parsedOutput: { diagnosis: 'd' } })

    await expect(runRemediation(input())).resolves.toBe('{"diagnosis":"d"}')
  })

  it('非 0 exit は throw する（応答が無いことを修正不要にしない）', async () => {
    adapterReturning({ exitCode: 1, stderr: 'quota exceeded' })

    await expect(runRemediation(input())).rejects.toThrow(/exitCode=1/)
  })

  it('guard に block されたら throw する', async () => {
    adapterReturning({ blocked: true, stderr: 'blocked' })

    await expect(runRemediation(input())).rejects.toThrow(/block/)
  })

  it('Claude 経路は CLI envelope から本文を取り出す', async () => {
    adapterReturning({
      stdout: JSON.stringify({ type: 'result', is_error: false, result: '{"diagnosis":"d"}' }),
    })

    await expect(runRemediation(input({ provider: 'claude_code', model: 'claude-opus-5' })))
      .resolves.toBe('{"diagnosis":"d"}')
  })

  it('Claude の envelope が壊れていたら throw する（二段階 parse の両段で fail-closed）', async () => {
    adapterReturning({ stdout: 'not an envelope' })

    await expect(runRemediation(input({ provider: 'claude_code', model: 'claude-opus-5' })))
      .rejects.toThrow(/envelope/)
  })

  it('Claude CLI が自分でエラーを申告していたら本文を採用しない', async () => {
    adapterReturning({
      stdout: JSON.stringify({ type: 'result', is_error: true, result: '{"diagnosis":"d"}' }),
    })

    await expect(runRemediation(input({ provider: 'claude_code', model: 'claude-opus-5' })))
      .rejects.toThrow(/envelope/)
  })
})
