import type { AiCliMode, AiCliRequest } from '@ai-team/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter } from './claudeCodeAdapter.js'

class TestClaudeCodeAdapter extends ClaudeCodeAdapter {
  testArgv(request: AiCliRequest): string[] {
    return this.buildArgv(request)
  }
}

function createRequest(mode: AiCliMode): AiCliRequest {
  return {
    taskId: 'task-claude-flags',
    provider: 'claude_code',
    workingDir: '/workspace/target',
    prompt: '対象を確認してください',
    contextFiles: [],
    mode,
  }
}

describe('ClaudeCodeAdapter buildArgv', () => {
  const adapter = new TestClaudeCodeAdapter({ provider: 'claude_code' })

  it('implement は非対話実装用の明示的なツール権限だけを渡す', () => {
    const argv = adapter.testArgv(createRequest('implement'))

    expect(argv).toContain('--permission-mode')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(argv).toContain('--tools')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Edit,Write')
    expect(argv).toContain('--allowedTools')
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep,Edit,Write')
  })

  it.each(['review', 'qa', 'summarize'] as const)(
    '%s は読み取り専用ツールだけを渡す',
    mode => {
      const argv = adapter.testArgv(createRequest(mode))

      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
      expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Glob,Grep')
      expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep')
      expect(argv.join(' ')).not.toMatch(/Edit|Write|Bash/)
    },
  )

  it.each(['implement', 'review', 'qa', 'summarize'] as const)(
    '%s のargvに禁止ツールを一切含めない',
    mode => {
      const argv = adapter.testArgv(createRequest(mode))

      expect(argv.join(' ')).not.toMatch(/Bash|WebSearch|WebFetch/)
    },
  )

  it('未知のmodeは明示的な権限なしで実行せずfail-closedにする', () => {
    const request = createRequest('unknown' as unknown as AiCliMode)

    expect(() => adapter.testArgv(request)).toThrow(
      '[ClaudeCodeAdapter] Unknown aiCliMode "unknown" — refusing to run without explicit tool permissions (fail-closed)',
    )
  })
})
