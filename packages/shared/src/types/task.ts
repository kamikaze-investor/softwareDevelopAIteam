// Task型定義

import type { AgentRole } from './agent'
import type { AiCliProvider } from './ai_cli'
import type { ApprovalGateStatus } from './approval_gate'
import type { JobStatus } from './job'
import type { RiskLevel } from './safety_guard'

export type TaskStatus = 'pending' | 'in_progress' | 'review' | 'done' | 'blocked'

export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskStatus
  assignee: AgentRole

  /**
   * 使用するAI CLIプロバイダー
   * 1タスク = 1プロバイダー原則（Rule-001: Codex統合リスク M-1）
   * 指定なしの場合は claude_code をデフォルトとして使用する
   */
  provider?: AiCliProvider

  dependencies: string[]  // task ids
  branchName?: string
  commitHash?: string

  /**
   * AIが変更してよいパス（target-project/配下の相対パス）
   * 指定なしの場合はFile Change Guardがデフォルト禁止リストのみ適用
   * レビュー指摘(2026-05-28): タスクごとに変更範囲を制限
   */
  allowedPaths?: string[]

  /**
   * AIが変更してはいけないパス（allowedPathsより優先）
   */
  forbiddenPaths?: string[]

  /**
   * タスク完了の受け入れ条件
   * QA AIがこれを元に判定する
   */
  acceptanceCriteria?: string[]

  /**
   * 期待される出力ファイル
   */
  expectedOutputs?: string[]

  /**
   * ロードマップ上の論理ID（例: task-001）。
   * ロードマップ同期で作成されたTaskのみ設定される。手動作成Taskはundefined。
   */
  roadmapTaskKey?: string

  /** ロードマップ上のPhase番号。手動作成Taskはundefined */
  phase?: number

  /**
   * 現行ロードマップに属しているか。
   * 手動作成Task・既存Taskはfalse。ロードマップ同期で作成/再登場したTaskのみtrue。
   */
  roadmapActive: boolean

  createdAt: string
  updatedAt: string
}

export type TaskDisplayStatus =
  | 'waiting_approval'
  | 'rejected_waiting_instruction'
  | 'blocked'
  | 'failed'
  | 'running'
  | 'queued'
  | 'completed'
  | 'pending'
  | 'in_progress'

export interface TaskSummary {
  taskId: string
  projectId: string
  projectName: string
  title: string
  description: string
  taskStatus: TaskStatus
  latestJob?: {
    jobId: string
    status: JobStatus
    approvalId?: string
    startedAt?: string
    completedAt?: string
  }
  approvalSummary: {
    hasWaitingApproval: boolean
    hasRejectedApproval: boolean
    latestApprovalRequestId?: string
    latestApprovalStatus?: ApprovalGateStatus
    latestApprovalRiskLevel?: RiskLevel
  }
  displayStatus: TaskDisplayStatus
  updatedAt: string
}

export interface TaskDisplayStatusInput {
  taskStatus: TaskStatus
  latestJobStatus?: JobStatus
  /** Approval referenced by the latest Job's approvalId, if that link resolves. */
  linkedApprovalStatus?: ApprovalGateStatus
}

export function computeTaskDisplayStatus(input: TaskDisplayStatusInput): TaskDisplayStatus {
  if (input.latestJobStatus === 'blocked' && input.linkedApprovalStatus === 'WAITING_FOR_USER') {
    return 'waiting_approval'
  }
  if (input.latestJobStatus === 'blocked' && input.linkedApprovalStatus === 'REJECTED') {
    return 'rejected_waiting_instruction'
  }
  if (input.latestJobStatus === 'blocked') return 'blocked'
  if (input.latestJobStatus === 'failed') return 'failed'
  if (input.latestJobStatus === 'running') return 'running'
  if (input.latestJobStatus === 'queued') return 'queued'
  if (input.taskStatus === 'done' || input.latestJobStatus === 'success') return 'completed'
  if (input.latestJobStatus === undefined && input.taskStatus === 'pending') return 'pending'
  return 'in_progress'
}
