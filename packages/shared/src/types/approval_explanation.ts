import type { QAStatus, QAType, ReviewFinding } from './review'

export type ApprovalExplanationDiffStatus = 'exact' | 'stale' | 'unavailable'

export interface ApprovalVerificationItem {
  kind: QAType
  status: QAStatus
  detail: string
}

/**
 * FinalReviewPacketの主要な説明フィールドをApproval画面向けに絞ったViewModel。
 * Approval Gateの判断結果ではなく、既存の事実をCEO向けに説明する表示専用データ。
 */
export interface ApprovalExplanationViewModel {
  generatedAt: string
  whatWasDone: string
  whyNeeded: string
  scope: string
  notChanged: string
  productionImpact: string
  riskSummary: string
  failureImpact: string
  verificationSummary: string
  verificationResults: ApprovalVerificationItem[]
  reviewSummary: string
  reviewFindings: ReviewFinding[]
  targetFiles: string[]
  nextMinimalAction: string
}

export type ApprovalExplanationResponse =
  | {
      ok: true
      explanation: ApprovalExplanationViewModel
      diffStatus: ApprovalExplanationDiffStatus
      exactDiff?: string
    }
  | {
      ok: false
      error: string
      diffStatus: ApprovalExplanationDiffStatus
    }

export interface ApprovalQuestionTurn {
  role: 'user' | 'assistant'
  content: string
}

export type ApprovalQuestionResponse =
  | {
      ok: true
      answer: string
      diffStatus: ApprovalExplanationDiffStatus
    }
  | {
      ok: false
      error: string
      diffStatus: ApprovalExplanationDiffStatus
    }
