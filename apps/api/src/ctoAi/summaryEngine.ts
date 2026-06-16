/**
 * Summary Engine（task-105）
 *
 * 役割:
 *   Developer AI の実行結果（DeveloperAiResult）を受け取り、
 *   target-project の Dashboard 用サマリーを生成・更新する。
 *
 * 出力:
 *   - docs/dashboard.md（実行履歴 + 進捗サマリー）
 *   - tasks/task_graph.md のステータス更新（完了 → [x]）
 *
 * 設計:
 *   - 副作用のみ（ファイル書き込み）
 *   - AI API は呼ばない（純粋なマークダウン生成）
 *   - 冪等（同じ結果を2回渡しても壊れない）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { DeveloperAiResult } from './developerAiOrchestrator.js'

// ────────────────────────────────────────────────────────────
// 型定義
// ────────────────────────────────────────────────────────────

export interface SummaryEngineResult {
  dashboardPath: string
  taskGraphPath: string
  taskStatusUpdated: boolean
  entriesInDashboard: number
}

export interface ExecutionEntry {
  taskId: string
  provider: string
  status: string
  durationMs: number
  changedFiles: string[]
  executedAt: string
  completedAt: string
  stdout?: string
}

// ────────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────────

const DASHBOARD_HEADER = `# AI Development Dashboard

> このファイルは Summary Engine が自動生成します。手動編集しないでください。

`

function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    success: '✅',
    mock: '🧪',
    failed: '❌',
    blocked: '🚫',
  }
  return map[status] ?? '❓'
}

function formatMs(ms: number): string {
  if (ms === 0) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function buildDashboardEntry(entry: ExecutionEntry): string {
  const lines = [
    `### ${statusEmoji(entry.status)} ${entry.taskId} (${entry.provider})`,
    '',
    `| 項目 | 値 |`,
    `|---|---|`,
    `| ステータス | ${entry.status} |`,
    `| 実行時間 | ${formatMs(entry.durationMs)} |`,
    `| 実行開始 | ${entry.executedAt} |`,
    `| 完了時刻 | ${entry.completedAt} |`,
  ]

  if (entry.changedFiles.length > 0) {
    lines.push(`| 変更ファイル数 | ${entry.changedFiles.length} |`)
    lines.push('')
    lines.push('**変更ファイル:**')
    entry.changedFiles.forEach(f => lines.push(`- \`${f}\``))
  }

  if (entry.stdout && entry.stdout.trim().length > 0) {
    const truncated = entry.stdout.length > 500
      ? entry.stdout.slice(0, 500) + '\n...(省略)'
      : entry.stdout
    lines.push('')
    lines.push('<details><summary>出力ログ</summary>')
    lines.push('')
    lines.push('```')
    lines.push(truncated)
    lines.push('```')
    lines.push('</details>')
  }

  lines.push('')
  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────
// Dashboard 読み書き
// ────────────────────────────────────────────────────────────

function readExistingEntries(dashboardPath: string): string {
  if (!existsSync(dashboardPath)) return ''
  const content = readFileSync(dashboardPath, 'utf-8')
  // DASHBOARD_HEADER 以降のエントリ部分を返す
  const idx = content.indexOf('## 実行履歴')
  if (idx === -1) return ''
  return content.slice(idx)
}

function writeDashboard(
  dashboardPath: string,
  newEntry: ExecutionEntry,
  existingContent: string,
): number {
  const newEntryMd = buildDashboardEntry(newEntry)

  let entriesSection: string
  if (existingContent) {
    // 既存の ## 実行履歴 の下に追記
    const afterHeader = existingContent.replace(/^## 実行履歴\n+/, '')
    entriesSection = `## 実行履歴\n\n${newEntryMd}\n${afterHeader}`
  } else {
    entriesSection = `## 実行履歴\n\n${newEntryMd}`
  }

  // エントリ数をカウント（### で始まる行の数）
  const entryCount = (entriesSection.match(/^### /gm) ?? []).length

  const content = DASHBOARD_HEADER + `**最終更新**: ${new Date().toISOString()}\n\n` + entriesSection
  writeFileSync(dashboardPath, content, 'utf-8')

  return entryCount
}

// ────────────────────────────────────────────────────────────
// task_graph.md ステータス更新
// ────────────────────────────────────────────────────────────

function updateTaskGraph(taskGraphPath: string, taskId: string, newStatus: '[x]' | '[!]'): boolean {
  if (!existsSync(taskGraphPath)) return false

  const content = readFileSync(taskGraphPath, 'utf-8')
  // | task-001 | ... | [ ] | ... のパターンを探して置換
  const regex = new RegExp(`(\\|\\s*${taskId}\\s*\\|[^|]+\\|\\s*)\\[[ >]\\](\\s*\\|)`, 'g')

  if (!regex.test(content)) return false

  const updated = content.replace(
    new RegExp(`(\\|\\s*${taskId}\\s*\\|[^|]+\\|\\s*)\\[[ >]\\](\\s*\\|)`, 'g'),
    `$1${newStatus}$2`,
  )

  if (updated === content) return false

  writeFileSync(taskGraphPath, updated, 'utf-8')
  return true
}

// ────────────────────────────────────────────────────────────
// メイン関数
// ────────────────────────────────────────────────────────────

export function updateDashboard(
  result: DeveloperAiResult,
  targetProjectRoot: string,
): SummaryEngineResult {
  const docsDir = path.join(targetProjectRoot, 'docs')
  const tasksDir = path.join(targetProjectRoot, 'tasks')

  mkdirSync(docsDir, { recursive: true })

  const dashboardPath = path.join(docsDir, 'dashboard.md')
  const taskGraphPath = path.join(tasksDir, 'task_graph.md')

  const entry: ExecutionEntry = {
    taskId: result.taskId,
    provider: result.provider,
    status: result.status,
    durationMs: result.durationMs,
    changedFiles: result.changedFiles ?? [],
    executedAt: result.executedAt,
    completedAt: result.completedAt,
    stdout: result.stdout,
  }

  const existingContent = readExistingEntries(dashboardPath)
  const entriesInDashboard = writeDashboard(dashboardPath, entry, existingContent)

  // [codex-review P2修正]
  // mock / dry-run は実際の変更を伴わないため task_graph を完了扱いにしない。
  // success のみ [x]、failed/blocked は [!]、mock は task_graph を更新しない。
  let taskStatusUpdated = false
  if (result.status === 'success') {
    taskStatusUpdated = updateTaskGraph(taskGraphPath, result.taskId, '[x]')
  } else if (result.status === 'failed' || result.status === 'blocked') {
    taskStatusUpdated = updateTaskGraph(taskGraphPath, result.taskId, '[!]')
  }
  // mock: task_graph 更新なし（進捗への影響を与えない）

  return {
    dashboardPath,
    taskGraphPath,
    taskStatusUpdated,
    entriesInDashboard,
  }
}
