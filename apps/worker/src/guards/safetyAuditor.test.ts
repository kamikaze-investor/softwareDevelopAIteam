/**
 * Safety Auditor テスト
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 */

import { describe, expect, it } from 'vitest'
import {
  parseDiff,
  runPolicyGuard,
  analyzeChangeImpact,
  runSafetyAudit,
  toGateDecision,
} from './safetyAuditor.js'

// ────────────────────────────────────────────────────────────
// テスト用 diff ヘルパー
// ────────────────────────────────────────────────────────────

function makeDiff(file: string, addedLines: string[]): string {
  const added = addedLines.map((l) => `+${l}`).join('\n')
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,0 +1 @@\n${added}\n`
}

// ────────────────────────────────────────────────────────────
// parseDiff
// ────────────────────────────────────────────────────────────

describe('parseDiff', () => {
  it('extracts changed files from unified diff', () => {
    const diff = makeDiff('src/foo.ts', ['const x = 1'])
    const result = parseDiff(diff)
    expect(result.changedFiles).toContain('src/foo.ts')
  })

  it('counts added and removed lines', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,2 +1,3 @@',
      '-const old = 1',
      '+const new1 = 1',
      '+const new2 = 2',
    ].join('\n')
    const result = parseDiff(diff)
    expect(result.diffSummary[0]).toMatchObject({ file: 'src/foo.ts', added: 2, removed: 1 })
  })

  it('returns empty arrays for empty diff', () => {
    const result = parseDiff('')
    expect(result.changedFiles).toHaveLength(0)
    expect(result.diffSummary).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────
// runPolicyGuard — 危険ファイル検出
// ────────────────────────────────────────────────────────────

describe('runPolicyGuard - dangerous files', () => {
  it('flags .env file as CRITICAL', () => {
    const parsed = parseDiff(makeDiff('.env', ['SECRET=abc']))
    const { hits, maxRiskFromPolicy } = runPolicyGuard(parsed)
    expect(hits.some((h) => h.type === 'file')).toBe(true)
    expect(maxRiskFromPolicy).toBe('CRITICAL')
  })

  it('flags guards/ file as HIGH', () => {
    const parsed = parseDiff(makeDiff('apps/worker/src/guards/permissionGuard.ts', ['// change']))
    const { hits, maxRiskFromPolicy } = runPolicyGuard(parsed)
    expect(hits.some((h) => h.type === 'file')).toBe(true)
    expect(['HIGH', 'CRITICAL']).toContain(maxRiskFromPolicy)
  })

  it('flags approval_rules.md as CRITICAL', () => {
    const parsed = parseDiff(makeDiff('docs/project_memory/rules/approval_rules.md', ['# changed']))
    const { hits, maxRiskFromPolicy } = runPolicyGuard(parsed)
    expect(maxRiskFromPolicy).toBe('CRITICAL')
  })

  it('does not flag normal source files', () => {
    const parsed = parseDiff(makeDiff('src/features/counter.ts', ['const x = 1']))
    const { hits, maxRiskFromPolicy } = runPolicyGuard(parsed)
    expect(hits.filter((h) => h.type === 'file')).toHaveLength(0)
    expect(maxRiskFromPolicy).toBe('LOW')
  })
})

// ────────────────────────────────────────────────────────────
// runPolicyGuard — 危険キーワード検出
// ────────────────────────────────────────────────────────────

describe('runPolicyGuard - dangerous keywords', () => {
  it('flags autoApprove as CRITICAL', () => {
    const parsed = parseDiff(makeDiff('src/service.ts', ['if (autoApprove) return true']))
    const { hits, maxRiskFromPolicy } = runPolicyGuard(parsed)
    expect(hits.some((h) => h.type === 'keyword')).toBe(true)
    expect(maxRiskFromPolicy).toBe('CRITICAL')
  })

  it('flags skipReview as CRITICAL', () => {
    const parsed = parseDiff(makeDiff('src/service.ts', ['skipReview: true']))
    const { hits, maxRiskFromPolicy } = runPolicyGuard(parsed)
    expect(maxRiskFromPolicy).toBe('CRITICAL')
  })

  it('flags production reference as CRITICAL', () => {
    const parsed = parseDiff(makeDiff('src/deploy.ts', ['if (env === "production") deploy()']))
    const { hits, maxRiskFromPolicy } = runPolicyGuard(parsed)
    expect(maxRiskFromPolicy).toBe('CRITICAL')
  })

  it('flags bypass keyword as HIGH', () => {
    const parsed = parseDiff(makeDiff('src/runner.ts', ['// bypass the check']))
    const { hits, maxRiskFromPolicy } = runPolicyGuard(parsed)
    expect(hits.some((h) => h.type === 'keyword')).toBe(true)
    expect(['HIGH', 'CRITICAL']).toContain(maxRiskFromPolicy)
  })

  it('does not flag removed lines (-) for keywords', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/old.ts',
      '--- a/src/old.ts',
      '+++ b/src/old.ts',
      '@@ -1 +0,0 @@',
      '-const x = autoApprove()',  // 削除行は検査しない
    ].join('\n')
    const parsed = parseDiff(diff)
    const { hits } = runPolicyGuard(parsed)
    const kwHits = hits.filter((h) => h.type === 'keyword')
    expect(kwHits).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────
// analyzeChangeImpact
// ────────────────────────────────────────────────────────────

describe('analyzeChangeImpact', () => {
  it('returns LOW for tiny changes', () => {
    const parsed = parseDiff(makeDiff('src/foo.ts', ['const x = 1', 'const y = 2']))
    expect(analyzeChangeImpact(parsed)).toBe('LOW')
  })

  it('returns MEDIUM for moderate changes', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `const x${i} = ${i}`)
    const diffs = [
      makeDiff('src/a.ts', lines.slice(0, 30)),
      makeDiff('src/b.ts', lines.slice(30, 60)),
    ].join('\n')
    const parsed = parseDiff(diffs)
    const result = analyzeChangeImpact(parsed)
    expect(['MEDIUM', 'HIGH']).toContain(result)
  })

  it('returns LOW for empty diff', () => {
    const parsed = parseDiff('')
    expect(analyzeChangeImpact(parsed)).toBe('LOW')
  })
})

// ────────────────────────────────────────────────────────────
// toGateDecision
// ────────────────────────────────────────────────────────────

describe('toGateDecision', () => {
  it('LOW → ALLOW', () => expect(toGateDecision('LOW')).toBe('ALLOW'))
  it('MEDIUM → ALLOW', () => expect(toGateDecision('MEDIUM')).toBe('ALLOW'))
  it('HIGH → DEEP_REVIEW', () => expect(toGateDecision('HIGH')).toBe('DEEP_REVIEW'))
  it('CRITICAL → BLOCK_CEO_REQUIRED', () => expect(toGateDecision('CRITICAL')).toBe('BLOCK_CEO_REQUIRED'))
})

// ────────────────────────────────────────────────────────────
// runSafetyAudit — 統合テスト
// ────────────────────────────────────────────────────────────

describe('runSafetyAudit', () => {
  it('returns ALLOW for safe change', () => {
    const diff = makeDiff('src/utils/format.ts', ['export function fmt(s: string) { return s.trim() }'])
    const report = runSafetyAudit({ rawDiff: diff, ref: 'abc1234' })
    expect(report.riskLevel).toBe('LOW')
    expect(report.gateDecision).toBe('ALLOW')
    expect(report.dangerousHits).toHaveLength(0)
    expect(report.blockedReason).toBeUndefined()
    expect(report.ref).toBe('abc1234')
    expect(report.changedFiles).toContain('src/utils/format.ts')
  })

  it('blocks CRITICAL change with reason', () => {
    const diff = makeDiff('src/auth.ts', ['if (autoApprove) return true'])
    const report = runSafetyAudit({ rawDiff: diff, ref: 'danger123' })
    expect(report.riskLevel).toBe('CRITICAL')
    expect(report.gateDecision).toBe('BLOCK_CEO_REQUIRED')
    expect(report.blockedReason).toBeDefined()
    expect(report.blockedReason).toContain('CRITICAL')
  })

  it('returns DEEP_REVIEW for HIGH risk (guard file change)', () => {
    const diff = makeDiff('apps/worker/src/guards/permissionGuard.ts', ['// refactor'])
    const report = runSafetyAudit({ rawDiff: diff, ref: 'guard-change' })
    expect(['HIGH', 'CRITICAL']).toContain(report.riskLevel)
    expect(['DEEP_REVIEW', 'BLOCK_CEO_REQUIRED']).toContain(report.gateDecision)
  })

  it('includes auditedAt timestamp', () => {
    const report = runSafetyAudit({ rawDiff: '', ref: 'empty' })
    expect(report.auditedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
