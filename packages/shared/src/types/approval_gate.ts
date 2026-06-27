/**
 * Approval Gate — 共有型定義
 *
 * 人間承認が必要かどうかを判断し、承認対象を
 * commit hash / diff hash / task_id に紐づけて管理する。
 *
 * 承認は「未来の権限」ではなく「特定 commit/diff に対する一回限りの許可」。
 */

import type { RiskLevel } from './safety_guard'

// ────────────────────────────────────────────────────────────
// Approval Status
// ────────────────────────────────────────────────────────────

export type ApprovalGateStatus =
  | 'WAITING_FOR_USER'  // 承認待ち（人間が応答していない）
  | 'APPROVED'          // 承認済み（commit/diff 照合済み）
  | 'REJECTED'          // 拒否済み
  | 'EXPIRED'           // expires_at を超過
  | 'SUPERSEDED'        // 同 task_id で新しい ApprovalRequest が作成された
  | 'STALE'             // 承認後に commit/diff が変化した（無効化）


// ────────────────────────────────────────────────────────────
// Approval Request
// ────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  /** approval-YYYYMMDD-NNN 形式 */
  id: string
  taskId: string
  /** 対象ブランチ名 */
  targetBranch: string
  /** 対象コミットハッシュ（git rev-parse HEAD） */
  targetCommit: string
  /** git diff HEAD~1..HEAD の SHA-256 ハッシュ */
  targetDiffHash: string
  /** Risk Review が算出したリスクレベル */
  riskLevel: RiskLevel
  /** 何をしようとしているか（人間が読む説明） */
  requestedAction: string
  status: ApprovalGateStatus
  /**
   * 承認有効期限（ISO 8601）
   *   HIGH     → +30分
   *   CRITICAL → +60分
   */
  expiresAt: string
  /**
   * この承認が自動失効する条件（ドキュメント用テキスト）
   * 例: ['commit が変わった場合', 'diff が変わった場合']
   */
  invalidIf: string[]
  /** CEO メモ（承認 / 拒否の理由） */
  reason?: string
  createdAt: string
  reviewedAt?: string
}

// ────────────────────────────────────────────────────────────
// Risk Review Result（簡易ルールベース版）
// TODO: Phase 2 で Independent AI Review に差し替え
// ────────────────────────────────────────────────────────────

export interface RiskReviewResult {
  riskLevel: RiskLevel
  /** どのルールにヒットしたか */
  triggeredRules: string[]
  /** Independent AI Review が必要か（HIGH/CRITICAL の場合 true） */
  requiresIndependentReview: boolean
  /** Independent AI Review の結果（TODO: 将来接続） */
  independentReviewResult?: IndependentReviewResult
}

// ────────────────────────────────────────────────────────────
// Independent AI Review（接続点のみ。フル実装は TODO）
// ────────────────────────────────────────────────────────────

export type IndependentReviewVerdict =
  | 'PASS'
  | 'PASS_WITH_WARNINGS'
  | 'BLOCKED'
  | 'REVIEW_ERROR'

export interface IndependentReviewResult {
  verdict: IndependentReviewVerdict
  summary: string
  warnings: string[]
  reviewedAt: string
  /** レビューに使用した AI モデル */
  reviewerModel: string
}

// ────────────────────────────────────────────────────────────
// Gate Outcome（approvalGate() の戻り値）
// ────────────────────────────────────────────────────────────

export type GateOutcome =
  | {
      decision: 'ALLOW'
      riskLevel: RiskLevel
      /**
       * HIGH/CRITICAL 承認由来の ALLOW の場合のみ設定される。
       * 呼び出し元はこの ID を使って承認リクエストを SUPERSEDED に更新すること
       * （一回限りの承認を強制するため）。
       * LOW/MEDIUM 由来の ALLOW は undefined。
       */
      consumedRequestId?: string
    }
  | { decision: 'PENDING_APPROVAL'; requestId: string; riskLevel: RiskLevel }
  | { decision: 'BLOCKED'; reason: string; riskLevel: RiskLevel }
  | { decision: 'STALE'; requestId: string; reason: string }

// ────────────────────────────────────────────────────────────
// Approval Gate Input
// ────────────────────────────────────────────────────────────

export interface ApprovalGateInput {
  taskId: string
  targetBranch: string
  targetCommit: string
  targetDiffHash: string
  changedFiles: string[]
  requestedAction: string
}
