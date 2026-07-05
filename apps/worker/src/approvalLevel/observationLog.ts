/**
 * Review Observation Log — Risk Scan / Gemini Step Review / postReview の観察結果を
 * 後から集計できる形で最小限記録する（Step R3/R4観察モードの前提整理の続き）。
 *
 * 注意（設計原則）:
 * - Gate化・自動停止・commitGate接続・ChatGPT escalation・Human通知は一切行わない。
 *   append-onlyのJSONLへ要約を記録するだけ。
 * - diff本文・prompt本文・stdout/stderr全文・Gemini生応答（rawResponse）は保存しない。
 *   保存するのは要約・enum値・件数・状態のみ。
 * - 書き込み失敗はこのモジュール内部でcatchし、呼び出し元（jobRunner.ts）には伝播させない。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { TargetProjectRiskScanResult } from './targetProjectRiskScan.js'
import type { StepReviewResult } from './stepReview.js'
import type { PostReviewResult } from './postReviewer.js'
import type { SafetyCheckId, SafetyVerificationResult } from './safetyVerifier.js'

const SUMMARY_MAX_LENGTH = 200
const LOG_FILE_NAME = 'review_observation.jsonl'

/**
 * jobRunner.tsの現在の接続方法では、実行結果（CommandExecutionResult）を渡していないため
 * 常にfail-closedになる項目。危険検出とは別に「入力が揃って実質評価できた項目数」を
 * 集計するために使う（詳細は docs/multi_ai_step_review_flow.md 6-3章）。
 */
const CHECKS_WITHOUT_INPUT: SafetyCheckId[] = ['TYPECHECK', 'RELATED_TESTS', 'FULL_TESTS']

export interface ObservationLogInput {
  jobId: string
  taskId: string
  /** job.aiCliProvider をそのまま渡す。AI CLIを使わないJobではundefined */
  provider?: string
  changedFilesCount: number
  targetProjectRiskScanResult?: TargetProjectRiskScanResult
  stepReviewResult?: StepReviewResult
  postReviewResult?: PostReviewResult
  safetyVerificationResult?: SafetyVerificationResult
}

export interface ObservationLogEntry {
  timestamp: string
  jobId: string
  taskId: string
  provider: string | null
  changedFilesCount: number
  riskScan: {
    highestSeverity: 'high' | 'medium' | 'low' | null
    issueLabels: string[]
  }
  stepReview: {
    status: string | null
    importance: string | null
    routing: string | null
    summary: string | null
  }
  postReview: {
    verdict: string | null
    confidence: number | null
    blocked: boolean | null
    alignmentVerdict: string | null
  }
  safetyVerification: {
    overallPassed: boolean | null
    blockingFailures: string[]
    /** 入力が揃って実質評価できた項目数（TYPECHECK/RELATED_TESTS/FULL_TESTSは含まない） */
    supportedChecksCount: number | null
    totalChecksCount: number | null
  }
}

function truncateSummary(text: string | undefined): string | null {
  if (!text) {
    return null
  }

  return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH)}…` : text
}

/** 保存対象の要約エントリを組み立てる（純粋関数。ファイルI/Oは行わない）。 */
export function buildObservationLogEntry(input: ObservationLogInput): ObservationLogEntry {
  return {
    timestamp: new Date().toISOString(),
    jobId: input.jobId,
    taskId: input.taskId,
    provider: input.provider ?? null,
    changedFilesCount: input.changedFilesCount,
    riskScan: {
      highestSeverity: input.targetProjectRiskScanResult?.highestSeverity ?? null,
      issueLabels: input.targetProjectRiskScanResult?.issues.map(issue => issue.label) ?? [],
    },
    stepReview: {
      status: input.stepReviewResult?.status ?? null,
      importance: input.stepReviewResult?.importance ?? null,
      routing: input.stepReviewResult?.routing ?? null,
      summary: truncateSummary(input.stepReviewResult?.summary),
    },
    postReview: {
      verdict: input.postReviewResult?.reviewerResult.verdict ?? null,
      confidence: input.postReviewResult?.reviewerResult.confidence ?? null,
      blocked: input.postReviewResult?.blocked ?? null,
      alignmentVerdict: input.postReviewResult?.alignmentVerdict ?? null,
    },
    safetyVerification: {
      overallPassed: input.safetyVerificationResult?.overallPassed ?? null,
      blockingFailures: input.safetyVerificationResult?.blockingFailures ?? [],
      supportedChecksCount: input.safetyVerificationResult
        ? input.safetyVerificationResult.checks.filter(check => !CHECKS_WITHOUT_INPUT.includes(check.id)).length
        : null,
      totalChecksCount: input.safetyVerificationResult?.checks.length ?? null,
    },
  }
}

function resolveObservationLogPath(): string {
  const logDir = process.env.JOB_LOG_DIR ?? path.resolve(process.cwd(), 'data', 'logs')
  return path.resolve(logDir, LOG_FILE_NAME)
}

/**
 * 観察結果をJSONLへ1行追記する。
 * 書き込み失敗（ディレクトリ権限・ディスク容量等）は内部でcatchし、
 * console.warnにエラー種別のみを出力する。呼び出し元でtry/catchする必要はなく、
 * Jobを止めることもない。
 */
export function appendObservationLog(input: ObservationLogInput): void {
  try {
    const entry = buildObservationLogEntry(input)
    const filePath = resolveObservationLogPath()
    mkdirSync(path.dirname(filePath), { recursive: true })
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8')
  } catch (err) {
    const errorKind = err instanceof Error ? err.constructor.name : typeof err
    console.warn(`[observationLog] 書き込み失敗（Jobは継続）: jobId=${input.jobId} taskId=${input.taskId} errorKind=${errorKind}`)
  }
}
