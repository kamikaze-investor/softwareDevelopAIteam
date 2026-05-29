// Review / QA結果型定義

import type { AgentRole } from './agent'

export type ReviewStatus = 'approved' | 'changes_requested' | 'rejected'
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical'

export interface ReviewFinding {
  severity: FindingSeverity
  file?: string
  line?: number
  message: string
  rule?: string   // 違反したルール名（例: 'no_business_logic_in_ui'）
}

export interface ReviewResult {
  id: string
  taskId: string
  jobId: string
  reviewer: AgentRole
  status: ReviewStatus
  summary: string
  findings: ReviewFinding[]
  createdAt: string
}

// ---

export type QAStatus = 'passed' | 'failed' | 'skipped'
export type QAType = 'typecheck' | 'unit_test' | 'build' | 'lint' | 'manual_check'

export interface QAResult {
  id: string
  taskId: string
  jobId: string
  type: QAType
  status: QAStatus
  summary: string
  details?: string
  createdAt: string
}
