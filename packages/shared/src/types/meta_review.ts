/**
 * Meta Review型定義
 *
 * AI Development Team OS 自身を監査するレビューシステム。
 * 通常のProject ReviewerとはAIも対象も目的も異なる。
 *
 * 役割:
 * - AI Cannot Modify Its Own Cage の保証
 * - Guard/Sandbox/仕様思想の弱体化を検出
 * - CEO承認が必要な変更を自動検出
 *
 * このレビューはDeveloper AIによるPR前に必ず実行される。
 */

/** レビュー対象エリアの分類 */
export type MetaReviewTargetArea =
  | 'guard'           // permissionGuard / fileChangeGuard
  | 'sandbox'         // Dockerfile / docker-compose
  | 'worker'          // apps/worker/
  | 'api'             // apps/api/
  | 'mobile'          // apps/mobile/
  | 'shared_types'    // packages/shared/
  | 'spec'            // specs/ / CLAUDE.md
  | 'project_memory'  // docs/project_memory/
  | 'tasks'           // tasks/
  | 'target_project'  // target-project/（通常のコードレビュー）

/** 発見事項のカテゴリ */
export type MetaFindingCategory =
  | 'cage_violation'        // Guardを弱める / Control Repo書き換え可能にする
  | 'authority_change'      // Green/Yellow/Red Zoneの変更
  | 'repository_boundary'   // Control/Target境界の侵害
  | 'security_regression'   // セキュリティ劣化
  | 'architecture_drift'    // 仕様思想からの逸脱
  | 'scope_creep'           // 不要な機能追加・過剰実装
  | 'mvp_mismatch'          // MVPスコープとの不整合
  | 'spec_violation'        // CLAUDE.md / specs/への違反
  | 'implementation_coupling'
  | 'over_constraint'
  | 'unverifiable_assumption'

export type MetaReviewStatus = 'approved' | 'changes_requested' | 'blocked'
export type MetaRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface MetaReviewFinding {
  severity: MetaRiskLevel
  category: MetaFindingCategory
  message: string
  file?: string
  line?: number
  suggestion?: string
}

export interface MetaReviewRequest {
  taskId: string
  taskTitle: string
  targetArea: MetaReviewTargetArea
  changedFiles: string[]
  gitDiff: string
  /** レビュー時に参照する仕様書（specs/ファイル名） */
  relatedSpecs: string[]
}

export interface MetaReviewResult {
  id: string
  taskId: string
  status: MetaReviewStatus
  riskLevel: MetaRiskLevel
  summary: string
  findings: MetaReviewFinding[]
  /** trueの場合、CEOへの通知が必要 */
  requiresCeoApproval: boolean
  createdAt: string
}

/**
 * blocked を使うべき条件（最重要）
 *
 * 以下のいずれかに該当する場合は status: 'blocked'
 * - Guardを弱めた（allowlistを広げた、チェックを削除した）
 * - sandboxの制限を外した（cap_drop削除、read-only解除等）
 * - .env / 秘密鍵に触れた
 * - Control Repositoryを書き換え可能にした
 * - CLAUDE.mdの権限ルール（Green/Yellow/Red Zone）を変えた
 * - 外部サービス・課金・本番公開に関わる変更をした
 * - TARGET_ROOT以外への書き込みを可能にした
 */
export const META_REVIEW_BLOCKED_TRIGGERS = [
  'permissionGuard allowlist を削減・削除',
  'fileChangeGuard forbiddenPatterns を削減・削除',
  'sandbox cap_drop / cap_add の変更',
  'docker-compose の read-only mount を解除',
  '.env / *.key / *.pem / secret への書き込み許可',
  'CLAUDE.md の Authority Principle 変更',
  'Green/Yellow/Red Zone の境界変更',
  'TARGET_ROOT 以外への write mount 追加',
  'Control Repository の編集権限を AI に付与',
] as const

/** Review Load: cognitive load required for review. Independent from Risk Level. */
export type ReviewLoad = 'low' | 'medium' | 'high' | 'critical'

/** Candidate focus areas for Focused Review. */
export type MetaReviewFocus =
  | 'strategic_alignment'
  | 'safety_recovery'
  | 'architecture_responsibility'
  | 'data_state_integrity'
  | 'auth_permission'
  | 'operations'
  | 'product_ceo_experience'
  | 'scope_simplicity'

/** Final decision for Strategic Alignment / Integration Review. */
export type StrategicDecision = 'ALIGNED' | 'CONFLICT' | 'UNCERTAIN'

export interface ReviewLoadClassification {
  reviewLoad: ReviewLoad
  reasons: string[]
}

export interface FocusedReviewResult {
  focus: MetaReviewFocus
  decision: StrategicDecision
  summary: string
  findings: MetaReviewFinding[]
}

export interface IntegrationReviewResult {
  decision: StrategicDecision
  summary: string
  conflictingFocuses?: MetaReviewFocus[]
  unresolvedAssumptions?: string[]
}

/**
 * Result of the CRITICAL-only Independent Review call.
 * Executed via a provider genuinely separate from the primary Gemini-based
 * Focused/Integration review (currently Codex, reviewer-only model) — never a
 * copy of the primary review's prompt or result.
 */
export interface IndependentReviewOutcome {
  provider: string
  verdict: 'approved' | 'changes_requested' | 'blocking'
  summary: string
  /** true when the independent reviewer itself could not be reached/parsed (fail-closed). */
  unavailable: boolean
}

/** REVIEW_UNAVAILABLE means a required review could not complete and must not be treated as ALIGNED. */
export interface StrategicMetaReviewResult {
  reviewKind: DesignReviewKind
  /** task: taskId value. roadmap: projectId value. Never a synthetic taskId. */
  subjectId: string
  /** Populated only for reviewKind === 'task' (backward compat with existing consumers). */
  taskId?: string
  reviewLoad: ReviewLoad
  reviewLoadReasons: string[]
  selectedFocuses: MetaReviewFocus[]
  strategicAlignmentResult?: FocusedReviewResult
  focusedReviewResults: FocusedReviewResult[]
  integrationReviewResult?: IntegrationReviewResult
  /** Only populated when reviewLoad === 'critical'. Set together with independentReviewRequired. */
  independentReviewResult?: IndependentReviewOutcome
  finalDecision: StrategicDecision | 'REVIEW_UNAVAILABLE'
  independentReviewRequired: boolean
  requiresCeoApproval: boolean
  createdAt: string
}

export type DesignReviewDecision = StrategicDecision | 'REVIEW_UNAVAILABLE'
export type DesignReviewIndependentVerdict = IndependentReviewOutcome['verdict']
export type DesignReviewKind = 'task' | 'roadmap'

export interface DesignReviewEvidence {
  id: string
  reviewKind: DesignReviewKind
  subjectId: string
  /** Populated only for reviewKind === 'task' (backward compat). undefined for 'roadmap'. */
  taskId?: string
  designTextHash: string
  reviewLoad: ReviewLoad
  decision: DesignReviewDecision
  independentReviewRequired: boolean
  independentReviewVerdict?: DesignReviewIndependentVerdict
  createdAt: string
}
