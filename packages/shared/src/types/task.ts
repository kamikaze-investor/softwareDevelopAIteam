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
  /** 最新Jobの作成時刻（Job.createdAt）。ApprovalRequestとの新旧比較に使う */
  latestJobCreatedAt?: string
  latestApprovalStatus?: ApprovalGateStatus
  /** 最新ApprovalRequestの作成時刻（ApprovalRequest.createdAt） */
  latestApprovalCreatedAt?: string
}

function parseTimeSafe(iso?: string): number | undefined {
  if (!iso) return undefined
  const time = Date.parse(iso)
  return Number.isNaN(time) ? undefined : time
}

/**
 * ApprovalRequestの状態（WAITING_FOR_USER/REJECTED）を「現在のJob停止状態」として扱ってよいかを判定する。
 *
 * Job.approvalIdが未接続のため、taskId一致による簡易な時系列比較に留まる:
 * 最新ApprovalRequestより後に作成されたJobが存在する場合、その承認情報は既に古い試行に対するもの
 * （＝却下/承認待ちの後に新しいJobが動いている）とみなし、現在状態としては扱わない。
 * 時刻が安全に比較できない場合（createdAt欠落・パース失敗）は、誤ってREJECTED/WAITING_FOR_USERを
 * 現在状態と断定せず、Jobベースの判定（blocked等の曖昧だが安全な状態）へフォールバックする。
 */
function isApprovalCurrent(input: TaskDisplayStatusInput): boolean {
  if (input.latestApprovalStatus === undefined) return false

  const approvalTime = parseTimeSafe(input.latestApprovalCreatedAt)
  if (approvalTime === undefined) return false

  const jobTime = parseTimeSafe(input.latestJobCreatedAt)
  if (jobTime === undefined) return true

  return jobTime <= approvalTime
}

export function computeTaskDisplayStatus(input: TaskDisplayStatusInput): TaskDisplayStatus {
  const approvalCurrent = isApprovalCurrent(input)

  if (approvalCurrent && input.latestApprovalStatus === 'WAITING_FOR_USER') return 'waiting_approval'
  if (approvalCurrent && input.latestApprovalStatus === 'REJECTED') return 'rejected_waiting_instruction'
  if (input.latestJobStatus === 'blocked') return 'blocked'
  if (input.latestJobStatus === 'failed') return 'failed'
  if (input.latestJobStatus === 'running') return 'running'
  if (input.latestJobStatus === 'queued') return 'queued'
  if (input.taskStatus === 'done' || input.latestJobStatus === 'success') return 'completed'
  return 'in_progress'
}
