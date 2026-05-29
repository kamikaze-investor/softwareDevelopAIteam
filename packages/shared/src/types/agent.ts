// Agent型定義 — AIエージェントの役割・権限

import type { ApprovalType } from './project'

export type AgentRole =
  | 'cto_ai'
  | 'context_manager'
  | 'developer_ai'
  | 'meta_reviewer'   // AI Development Team OS 自身を監査するAI
  | 'reviewer_ai'     // target-project/ のコードをレビューするAI
  | 'qa_ai'

/**
 * エージェントごとの権限ポリシー
 * Reviewer/QA AIは実装変更できないことを型で保証する
 */
export interface AgentPolicy {
  role: AgentRole
  canExecuteCommands: boolean
  canModifyFiles: boolean
  canCommit: boolean
  canReadMemory: boolean
  canWriteMemory: boolean
  requiresApprovalFor: ApprovalType[]
}

export const AGENT_POLICIES: Record<AgentRole, AgentPolicy> = {
  meta_reviewer: {
    role: 'meta_reviewer',
    canExecuteCommands: false,  // 実行不可 / 読み取り専用
    canModifyFiles: false,
    canCommit: false,
    canReadMemory: true,        // 仕様・ルールを参照する
    canWriteMemory: false,
    requiresApprovalFor: [],
  },
  cto_ai: {
    role: 'cto_ai',
    canExecuteCommands: false,
    canModifyFiles: false,
    canCommit: false,
    canReadMemory: true,
    canWriteMemory: true,
    requiresApprovalFor: ['goal_change', 'philosophy_change'],
  },
  context_manager: {
    role: 'context_manager',
    canExecuteCommands: false,
    canModifyFiles: false,
    canCommit: false,
    canReadMemory: true,
    canWriteMemory: false,
    requiresApprovalFor: [],
  },
  developer_ai: {
    role: 'developer_ai',
    canExecuteCommands: true,
    canModifyFiles: true,
    canCommit: true,
    canReadMemory: false,  // Context Pack経由のみ
    canWriteMemory: false,
    requiresApprovalFor: ['external_service', 'billing', 'deployment', 'security', 'dependency_add'],
  },
  reviewer_ai: {
    role: 'reviewer_ai',
    canExecuteCommands: false,  // レビューのみ・実装変更不可
    canModifyFiles: false,
    canCommit: false,
    canReadMemory: false,
    canWriteMemory: false,
    requiresApprovalFor: [],
  },
  qa_ai: {
    role: 'qa_ai',
    canExecuteCommands: true,   // テスト実行のみ
    canModifyFiles: false,
    canCommit: false,
    canReadMemory: false,
    canWriteMemory: false,
    requiresApprovalFor: [],
  },
}
