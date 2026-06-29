/**
 * AI 組織テンプレート — Agent / Role / Action 型定義
 *
 * 「誰が / どの役割で / 何をしたか」を記録するための型と定数。
 * KG / DecisionRecord / SelfReflection などの metadata として使用する。
 * DB schema 変更なし。文字列揺れ防止のための shared 定義。
 */

export type AgentId =
  | 'human_ceo'
  | 'chatgpt'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'system'

export type RoleId =
  | 'CEO'
  | 'Supervisor'
  | 'Architect'
  | 'Implementer'
  | 'Reviewer'
  | 'Auditor'
  | 'System'

export type ActionType =
  | 'design'
  | 'implement'
  | 'review'
  | 'risk_check'
  | 'approve'
  | 'reject'
  | 'test'
  | 'reflect'
  | 'gate_check'
  | 'consume_approval'

/** actor + role + action の3点セット。KG metadata として使う */
export interface ActorContext {
  actor: AgentId
  role: RoleId
  action: ActionType
  /** KGNode ID / ApprovalRequest ID / taskId など */
  targetId?: string
  /** 'approved' | 'rejected' | 'consumed' | 'stale' など */
  result?: string
  /** ISO 8601 */
  timestamp: string
}

/** Agent のデフォルト Role 割り当て（固定ではなく運用規約として） */
export const DEFAULT_AGENT_ROLES: Record<AgentId, RoleId[]> = {
  human_ceo: ['CEO'],
  chatgpt:   ['Supervisor', 'Reviewer'],
  claude:    ['Architect', 'Reviewer'],
  codex:     ['Implementer'],
  gemini:    ['Auditor'],
  system:    ['System'],
}
