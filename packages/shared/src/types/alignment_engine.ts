/**
 * Alignment Engine — 型定義
 *
 * Rule Engine（低コスト・毎回）+ AI（HIGH/CRITICAL 時のみ）の
 * ハイブリッド Alignment Check システムの型。
 *
 * AlignmentReport / AlignmentIssue（Gemini出力）は safety_guard.ts に定義済み。
 * このファイルは Rule Engine の出力と最終判定の型を追加する。
 */

// ────────────────────────────────────────────────────────────
// Enums
// ────────────────────────────────────────────────────────────

/** チェックの種別 */
export type AlignmentCheckKind = 'plan' | 'diff' | 'completion'

/** Rule Engine が算出するリスクレベル */
export type AlignmentEngineRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

/** 最終判定 */
export type AlignmentDecision = 'CONTINUE' | 'WARN' | 'BLOCK'

/** ルールヒットのカテゴリ */
export type AlignmentRuleCategory =
  | 'workaround'      // 迂回・回避行動
  | 'bypass_attempt'  // 安全機構の迂回
  | 'role_change'     // AI役割変更
  | 'approval_bypass' // 承認フロー変更
  | 'control_layer'   // Control Layer 構成要素
  | 'shadow_impl'     // 禁止ファイルの複製実装

// ────────────────────────────────────────────────────────────
// Rule Hit
// ────────────────────────────────────────────────────────────

/** Rule Engine が検出した単一のヒット */
export interface RuleHit {
  ruleId: string
  keyword: string
  matchedText: string
  location: string
  category: AlignmentRuleCategory
  suggestedRisk: AlignmentEngineRisk
}

// ────────────────────────────────────────────────────────────
// Alignment Engine Result
// ────────────────────────────────────────────────────────────

/** Alignment Engine（Rule + 必要時 AI）の最終出力 */
export interface AlignmentEngineResult {
  kind: AlignmentCheckKind
  ref: string
  riskLevel: AlignmentEngineRisk
  decision: AlignmentDecision
  ruleHits: RuleHit[]
  requiresAI: boolean
  aiAligned?: boolean
  aiSummary?: string
  summary: string
  checkedAt: string
}
