/**
 * Alignment Checker テスト
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * Gemini API は vi.mock でモックする（実際のAPI呼び出しなし）
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { runAlignmentCheck } from './alignmentChecker.js'

// geminiRouter をモック
vi.mock('../metaReviewer/geminiRouter.js', () => ({
  callGeminiWithFallback: vi.fn(),
}))

// node:fs/promises をモック（設計ドキュメント読み込み）
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('# Design Doc\nTest content'),
}))

import { callGeminiWithFallback } from '../metaReviewer/geminiRouter.js'
const mockCallGemini = vi.mocked(callGeminiWithFallback)

const SAFE_DIFF = `diff --git a/src/utils/format.ts b/src/utils/format.ts
--- a/src/utils/format.ts
+++ b/src/utils/format.ts
@@ -1 +1 @@
+export function fmt(s: string) { return s.trim() }
`

const DANGEROUS_DIFF = `diff --git a/src/runner.ts b/src/runner.ts
--- a/src/runner.ts
+++ b/src/runner.ts
@@ -1 +1 @@
+if (aiSaysOk) approve() // AI approval treated as human approval
`

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runAlignmentCheck', () => {
  it('returns aligned=true when Gemini reports no issues', async () => {
    mockCallGemini.mockResolvedValue(JSON.stringify({
      aligned: true,
      summary: '設計思想との整合性に問題なし',
      issues: [],
    }))

    const report = await runAlignmentCheck(SAFE_DIFF, 'abc123', 'C:/repo')

    expect(report.aligned).toBe(true)
    expect(report.issues).toHaveLength(0)
    expect(report.ref).toBe('abc123')
    expect(report.auditedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns aligned=false when Gemini detects ai_approval_misuse', async () => {
    mockCallGemini.mockResolvedValue(JSON.stringify({
      aligned: false,
      summary: 'AI承認を人間承認として扱う処理が検出された',
      issues: [{
        severity: 'critical',
        category: 'ai_approval_misuse',
        description: 'AI の判断を人間承認として扱っている',
        evidence: 'if (aiSaysOk) approve()',
      }],
    }))

    const report = await runAlignmentCheck(DANGEROUS_DIFF, 'danger456', 'C:/repo')

    expect(report.aligned).toBe(false)
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0].category).toBe('ai_approval_misuse')
    expect(report.issues[0].severity).toBe('critical')
  })

  it('returns aligned=false when Gemini detects role_change', async () => {
    mockCallGemini.mockResolvedValue(JSON.stringify({
      aligned: false,
      summary: 'テスト担当AIの変更が検出された',
      issues: [{
        severity: 'warning',
        category: 'role_change',
        description: 'Codex担当のテストをClaude Codeに変更している',
        evidence: '// Claude Code now runs tests instead of Codex',
      }],
    }))

    const report = await runAlignmentCheck('', 'role-change', 'C:/repo')

    expect(report.aligned).toBe(false)
    expect(report.issues[0].category).toBe('role_change')
  })

  it('handles Gemini response wrapped in markdown code block', async () => {
    mockCallGemini.mockResolvedValue('```json\n' + JSON.stringify({
      aligned: true,
      summary: 'OK',
      issues: [],
    }) + '\n```')

    const report = await runAlignmentCheck(SAFE_DIFF, 'md-wrap', 'C:/repo')
    expect(report.aligned).toBe(true)
  })

  it('returns fallback report when Gemini response is not valid JSON', async () => {
    mockCallGemini.mockResolvedValue('Gemini returned garbage text here')

    const report = await runAlignmentCheck(SAFE_DIFF, 'bad-json', 'C:/repo')

    expect(report.aligned).toBe(false)
    expect(report.issues[0].category).toBe('other')
    expect(report.issues[0].severity).toBe('warning')
  })

  it('includes the ref in the report', async () => {
    mockCallGemini.mockResolvedValue(JSON.stringify({
      aligned: true, summary: 'OK', issues: [],
    }))

    const report = await runAlignmentCheck('', 'task-999', 'C:/repo')
    expect(report.ref).toBe('task-999')
  })

  it('passes design docs and diff to Gemini prompt', async () => {
    mockCallGemini.mockResolvedValue(JSON.stringify({
      aligned: true, summary: 'OK', issues: [],
    }))

    await runAlignmentCheck('some diff content', 'prompt-check', 'C:/repo')

    expect(mockCallGemini).toHaveBeenCalledOnce()
    const prompt = mockCallGemini.mock.calls[0][0]
    expect(prompt).toContain('some diff content')
    expect(prompt).toContain('AIによる承認は無効')
  })
})
