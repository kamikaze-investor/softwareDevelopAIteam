// Permission Grant 型定義 — Phase A

export type GrantScope = 'once' | 'task' | 'permanent'

export interface PermissionGrant {
  id: string
  /** 許可対象のタスクID（task スコープ時） */
  taskId?: string
  /** 許可対象のジョブID（once スコープ時） */
  jobId?: string
  /** 許可するコマンド種別（undefined = そのスコープの全コマンド） */
  allowedCommandKinds?: import('./command').CommandKind[]
  /** 許可するエージェントロール */
  agentRole: import('./agent').AgentRole
  /** スコープ: once=1回のみ / task=タスク完了まで / permanent=無期限 */
  scope: GrantScope
  /** 有効期限（ISO 8601）。未設定 = 無期限 */
  expiresAt?: string
  /** CEOが付けたメモ */
  reason?: string
  /** 使用済みか（once スコープで使用後 true になる） */
  used: boolean
  createdAt: string
}

/** jobRunner が返す許可ブロックイベント */
export interface PermissionBlockEvent {
  type: 'grant_expired' | 'grant_not_found' | 'grant_used'
  jobId: string
  taskId: string
  agentRole: string
  commandKind: string
  message: string
  occurredAt: string
}
