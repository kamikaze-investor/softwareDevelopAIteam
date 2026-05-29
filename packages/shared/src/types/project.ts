// Project型定義

export type ProjectStatus = 'draft' | 'running' | 'paused' | 'archived'

export interface Project {
  id: string
  name: string
  goal: string
  designPhilosophy: string[]
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}

export interface ProjectSummary {
  project: Pick<Project, 'id' | 'name' | 'goal' | 'designPhilosophy' | 'status'>
  progress: number          // 0-100
  currentWork: string[]
  nextWork: string[]
  risks: Risk[]
  openDecisions: Decision[]
  pendingApprovals: Approval[]
  healthScore: number       // 0-100
}

export interface Risk {
  id: string
  title: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  description: string
}

export interface Decision {
  id: string
  title: string
  status: 'ai_thinking' | 'ai_decided' | 'needs_ceo'
  description: string
}

/**
 * 承認タイプ
 * dependency_add追加: npm install/pnpm addはYellow Zone
 * レビュー指摘(2026-05-28): 外部依存追加はセキュリティ・ライセンス・サプライチェーンリスク
 */
export type ApprovalType =
  | 'goal_change'
  | 'philosophy_change'
  | 'external_service'
  | 'billing'
  | 'deployment'
  | 'security'
  | 'dependency_add'  // npm/pnpm add <package> はCEO承認必須

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface Approval {
  id: string
  title: string
  reason: string
  type: ApprovalType
  // レビュー指摘(2026-05-28): CEOの承認・却下状態を追跡するため追加
  status: ApprovalStatus
  reviewedAt?: string
  reviewNote?: string
  createdAt: string
}
