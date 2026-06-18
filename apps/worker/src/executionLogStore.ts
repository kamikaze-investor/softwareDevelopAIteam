/**
 * Execution Log Store
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * AI の実行内容を JSONL ファイルへ永続化する監査ログ。
 * AIの自己申告ではなく、実際の実行コマンド・diff・Guard結果を記録する。
 *
 * 保存先: JOB_LOG_DIR/execution_log.jsonl（1行 = 1エントリ）
 *
 * 設計:
 *   - JSONL 形式（追記のみ・削除不可）
 *   - 1エントリ = 1 Job の実行サマリー
 *   - AuditReport / AlignmentReport / GateResult を含む
 *   - 改ざん防止のため append-only（上書き禁止）
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ExecutionLog } from '@ai-team/shared'

function resolveLogPath(): string {
  const logDir = process.env.JOB_LOG_DIR ?? path.resolve(process.cwd(), 'data', 'logs')
  mkdirSync(logDir, { recursive: true })
  return path.join(logDir, 'execution_log.jsonl')
}

/**
 * 実行ログを JSONL ファイルに追記する（append-only）。
 * 既存エントリの上書き・削除は行わない。
 */
export function appendExecutionLog(entry: ExecutionLog): void {
  const logPath = resolveLogPath()
  const line = JSON.stringify(entry) + '\n'
  appendFileSync(logPath, line, 'utf-8')
}

/**
 * 実行ログを全件読み込む（監査・確認用）。
 * ファイルが存在しない場合は空配列を返す。
 */
export function readExecutionLogs(): ExecutionLog[] {
  const logPath = resolveLogPath()
  try {
    const content = readFileSync(logPath, 'utf-8')
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ExecutionLog)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw err
  }
}

/**
 * 特定の jobId のログを返す。
 */
export function findExecutionLog(jobId: string): ExecutionLog | undefined {
  return readExecutionLogs().find((e) => e.jobId === jobId)
}

/**
 * リスクレベルでフィルタしたログを返す（HIGH / CRITICAL の監査用）。
 */
export function findHighRiskLogs(): ExecutionLog[] {
  return readExecutionLogs().filter((e) => {
    const risk = e.auditReport?.riskLevel
    return risk === 'HIGH' || risk === 'CRITICAL'
  })
}
