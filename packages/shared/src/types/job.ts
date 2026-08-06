// Job型定義 (Worker実行単位)

import type { AgentRole } from './agent'
import type { SafeCommand } from './command'
import type { AiCliProvider, AiCliMode } from './ai_cli'

export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'blocked'

/**
 * ガード検証結果（監査ログ用）
 * レビュー指摘(2026-05-28): あとから何が起きたか追跡できることが重要
 */
export interface JobGuardResult {
  permissionAllowed: boolean
  permissionReason?: string
  fileChangeAllowed: boolean
  fileViolations?: string[]
}

export interface Job {
  id: string
  taskId: string
  projectId: string

  /** APIが自動workflow内の1回限りのstepへ付与する冪等キー。手動Jobは未設定。 */
  workflowStepKey?: string

  /** 実行AIエージェント（監査ログ用） */
  agentRole: AgentRole

  status: JobStatus

  /**
   * 構造化コマンド（AIに自由なcommand stringを渡させない）
   * レビュー指摘(2026-05-28): command: string は危険
   */
  safeCommand: SafeCommand

  /** dryRunモード: 実際には実行せず検証のみ */
  dryRun?: boolean

  startedAt?: string
  completedAt?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  stdoutPath?: string
  stderrPath?: string
  changedFiles?: string[]
  commitHash?: string
  rollbackInfo?: RollbackInfo

  /** ガード検証結果（監査ログ） */
  guardResult?: JobGuardResult

  /** このJobに関連するApproval ID */
  approvalId?: string

  /**
   * AI CLI 実行パラメータ（task-022）
   * 指定された場合、SafeCommand 実行前に AI CLI を先行実行する。
   * 3フィールドすべて揃った場合のみ AI CLI が起動する（部分指定は無視）。
   */
  aiCliProvider?: AiCliProvider
  aiCliPrompt?: string
  aiCliMode?: AiCliMode

  createdAt: string
}

export interface RollbackInfo {
  previousCommitHash: string
  changedFiles: string[]
  /** Worker が実行する安全なロールバックコマンド（shell文字列ではなくargv） */
  rollbackArgv: string[]
}
