import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendObservationLog, buildObservationLogEntry } from './observationLog.js'
import type { ObservationLogInput } from './observationLog.js'

function makeInput(overrides: Partial<ObservationLogInput> = {}): ObservationLogInput {
  return {
    jobId: 'job-1',
    taskId: 'task-1',
    provider: 'claude_code',
    changedFilesCount: 1,
    ...overrides,
  }
}

describe('buildObservationLogEntry', () => {
  it('各結果が全て揃っている場合、必要な要約項目を組み立てる', () => {
    const entry = buildObservationLogEntry(
      makeInput({
        targetProjectRiskScanResult: {
          hasRisk: true,
          issues: [
            { id: 'ENV_FILE_CHANGED', label: '秘密情報ファイル（.env）の変更', detail: 'x', evidence: [], severity: 'medium' },
          ],
          highestSeverity: 'medium',
          scannedAt: '2026-01-01T00:00:00.000Z',
        },
        stepReviewResult: {
          status: 'done',
          importance: 'medium',
          routing: 'proceed_candidate',
          summary: '軽微な懸念のみ',
          concerns: [],
          requiredFixes: [],
          escalationReason: null,
          confidence: 0.8,
          generatedAt: '2026-01-01T00:00:00.000Z',
          rawResponse: 'これは含まれてはいけない生応答',
        },
        postReviewResult: {
          jobId: 'job-1',
          taskId: 'task-1',
          reviewerResult: {
            provider: 'gemini',
            phase: 'post',
            verdict: 'approved',
            summary: '整合している',
            issues: [],
            confidence: 0.9,
            generatedAt: '2026-01-01T00:00:00.000Z',
            rawResponse: 'これも含まれてはいけない生応答',
          },
          alignmentVerdict: 'aligned',
          blocked: false,
          decidedAt: '2026-01-01T00:00:00.000Z',
        },
        safetyVerificationResult: {
          jobId: 'job-1',
          taskId: 'task-1',
          overallPassed: false,
          checks: [
            { id: 'UNEXPECTED_FILES', passed: true, blocking: true, detail: 'x' },
            { id: 'MECHANICAL_GATE_FILES', passed: true, blocking: true, detail: 'x' },
            { id: 'POST_TEST_HOOK', passed: true, blocking: true, detail: 'x' },
            { id: 'META_REVIEW_CODE', passed: true, blocking: true, detail: 'x' },
            { id: 'APPROVAL_GATE_WEAKENING', passed: true, blocking: true, detail: 'x' },
            { id: 'PERMISSION_GUARD_WEAKENING', passed: true, blocking: true, detail: 'x' },
            { id: 'SECRET_SCAN_WEAKENING', passed: true, blocking: true, detail: 'x' },
            { id: 'OUTSIDE_REPO_FILES', passed: true, blocking: true, detail: 'x' },
            { id: 'TYPECHECK', passed: false, blocking: true, detail: 'typecheckが未実行' },
            { id: 'RELATED_TESTS', passed: false, blocking: true, detail: '関連テストが未実行' },
            { id: 'FULL_TESTS', passed: false, blocking: true, detail: '全テストが未実行' },
            { id: 'PURPOSE_DIFF_ALIGNMENT', passed: true, blocking: true, detail: 'Post-Review verdict: aligned' },
          ],
          blockingFailures: ['TYPECHECK', 'RELATED_TESTS', 'FULL_TESTS'],
          verifiedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    )

    expect(entry.jobId).toBe('job-1')
    expect(entry.riskScan.highestSeverity).toBe('medium')
    expect(entry.riskScan.issueLabels).toEqual(['秘密情報ファイル（.env）の変更'])
    expect(entry.stepReview.status).toBe('done')
    expect(entry.stepReview.importance).toBe('medium')
    expect(entry.stepReview.summary).toBe('軽微な懸念のみ')
    expect(entry.postReview.verdict).toBe('approved')
    expect(entry.postReview.confidence).toBe(0.9)
    expect(entry.postReview.alignmentVerdict).toBe('aligned')
    expect(entry.safetyVerification.overallPassed).toBe(false)
    expect(entry.safetyVerification.blockingFailures).toEqual(['TYPECHECK', 'RELATED_TESTS', 'FULL_TESTS'])
    expect(entry.safetyVerification.totalChecksCount).toBe(12)
    expect(entry.safetyVerification.supportedChecksCount).toBe(9)
  })

  it('結果が未計算（undefined）の場合、対応するフィールドはnullになる', () => {
    const entry = buildObservationLogEntry(makeInput())

    expect(entry.riskScan.highestSeverity).toBeNull()
    expect(entry.riskScan.issueLabels).toEqual([])
    expect(entry.stepReview.status).toBeNull()
    expect(entry.postReview.verdict).toBeNull()
    expect(entry.safetyVerification.overallPassed).toBeNull()
    expect(entry.safetyVerification.blockingFailures).toEqual([])
    expect(entry.safetyVerification.supportedChecksCount).toBeNull()
    expect(entry.safetyVerification.totalChecksCount).toBeNull()
  })

  it('rawResponse（Gemini生応答）は一切含まれない', () => {
    const entry = buildObservationLogEntry(
      makeInput({
        stepReviewResult: {
          status: 'done',
          importance: 'low',
          routing: 'proceed_candidate',
          summary: 'ok',
          concerns: [],
          requiredFixes: [],
          escalationReason: null,
          confidence: 0.5,
          generatedAt: '2026-01-01T00:00:00.000Z',
          rawResponse: 'SECRET_RAW_RESPONSE_TEXT',
        },
      }),
    )

    expect(JSON.stringify(entry)).not.toContain('SECRET_RAW_RESPONSE_TEXT')
  })

  it('summaryは200文字を超える場合、切り詰められる', () => {
    const longSummary = 'あ'.repeat(300)
    const entry = buildObservationLogEntry(
      makeInput({
        stepReviewResult: {
          status: 'done',
          importance: 'low',
          routing: 'proceed_candidate',
          summary: longSummary,
          concerns: [],
          requiredFixes: [],
          escalationReason: null,
          confidence: 0.5,
          generatedAt: '2026-01-01T00:00:00.000Z',
          rawResponse: '',
        },
      }),
    )

    expect(entry.stepReview.summary?.length).toBeLessThanOrEqual(201)
  })
})

describe('appendObservationLog', () => {
  let tmpDir: string
  let originalJobLogDir: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'observation-log-test-'))
    originalJobLogDir = process.env.JOB_LOG_DIR
    process.env.JOB_LOG_DIR = tmpDir
  })

  afterEach(() => {
    if (originalJobLogDir === undefined) {
      delete process.env.JOB_LOG_DIR
    } else {
      process.env.JOB_LOG_DIR = originalJobLogDir
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('JSONL形式で1行追記される', () => {
    appendObservationLog(makeInput())

    const filePath = path.join(tmpDir, 'review_observation.jsonl')
    expect(existsSync(filePath)).toBe(true)

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0])).not.toThrow()
  })

  it('複数回呼ぶと追記され、既存の行は残る', () => {
    appendObservationLog(makeInput({ jobId: 'job-1' }))
    appendObservationLog(makeInput({ jobId: 'job-2' }))

    const filePath = path.join(tmpDir, 'review_observation.jsonl')
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).jobId).toBe('job-1')
    expect(JSON.parse(lines[1]).jobId).toBe('job-2')
  })

  it('書き込みが失敗しても例外を投げず、console.warnにエラー種別のみ出力する', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // ログディレクトリと同名のファイルを先に作り、mkdirSyncを失敗させる（ENOTDIR）
    const blockedPath = path.join(tmpDir, 'blocked-as-file')
    writeFileSync(blockedPath, 'not a directory', 'utf-8')
    process.env.JOB_LOG_DIR = blockedPath

    expect(() => appendObservationLog(makeInput())).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[observationLog] 書き込み失敗'))
    expect(warnSpy.mock.calls[0][0]).not.toContain('disk full')

    warnSpy.mockRestore()
  })
})
