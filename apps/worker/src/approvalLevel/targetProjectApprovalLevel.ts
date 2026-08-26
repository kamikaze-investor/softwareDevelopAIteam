import type { ApprovalLevelResult, ClassifierResult, ReviewPolicy } from '@ai-team/shared'
import type { TargetProjectRiskScanResult } from './targetProjectRiskScan.js'

/**
 * target_project Risk Scan結果を既存のApprovalLevelResultにマッピングする純粋関数。
 *
 * control repo基準の classifier（determineApprovalLevel）は target_project の
 * ファイルパスに適用すると常に UNMATCHED_FALLBACK → Level3/ceo_required になるため、
 * 代わりに既に計算済みの targetProjectRiskScanResult.highestSeverity を
 * 既存の4tier ReviewPolicy に1:1対応させる。
 *
 * この関数は pure function であり、ファイルI/O・DB・AI呼び出し・git操作を行わない。
 * Shadow Commit Gate の観察専用経路でのみ使用する。
 *
 * Mapping:
 *   undefined (no risk issues) → level 0, 'mechanical_only'
 *   'low'                      → level 1, 'light_ai_post_review'
 *   'medium'                   → level 2, 'full_pre_post_review'
 *   'high'                     → level 3, 'ceo_required'
 */
export function deriveTargetProjectApprovalLevel(input: {
  jobId: string
  taskId: string
  riskScanResult: TargetProjectRiskScanResult
}): ApprovalLevelResult {
  const { jobId, taskId, riskScanResult } = input
  const severity = riskScanResult.highestSeverity

  const { level, reviewPolicy, confidence } = mapSeverityToLevel(severity)

  const classifierResult: ClassifierResult = {
    level,
    confidence,
    reasons: buildReasons(riskScanResult, severity),
    needsEscalation: level === 3,
    escalationReason: level === 3
      ? 'target_project Risk Scanでhigh severity問題が検出されたためCEO承認が必要'
      : undefined,
    reviewPolicy,
  }

  const finalReason = buildFinalReason(severity, riskScanResult)

  return {
    jobId,
    taskId,
    level,
    confidence,
    mechanicalGate: { triggered: false, hits: [] },
    classifierResult,
    finalReason,
    decidedAt: new Date().toISOString(),
    requiresChatGptReview: requiresChatGptReview(level, confidence),
    reviewPolicy,
  }
}

function mapSeverityToLevel(severity: 'high' | 'medium' | 'low' | undefined): {
  level: 0 | 1 | 2 | 3
  reviewPolicy: ReviewPolicy
  confidence: number
} {
  switch (severity) {
    case undefined:
      return { level: 0, reviewPolicy: 'mechanical_only', confidence: 0.9 }
    case 'low':
      return { level: 1, reviewPolicy: 'light_ai_post_review', confidence: 0.85 }
    case 'medium':
      return { level: 2, reviewPolicy: 'full_pre_post_review', confidence: 0.95 }
    case 'high':
      return { level: 3, reviewPolicy: 'ceo_required', confidence: 1.0 }
  }
}

function buildReasons(
  riskScanResult: TargetProjectRiskScanResult,
  severity: 'high' | 'medium' | 'low' | undefined,
): ClassifierResult['reasons'] {
  if (severity === undefined || riskScanResult.issues.length === 0) {
    return [{
      rule: 'TARGET_PROJECT_RISK_SCAN_CLEAN',
      detail: 'target_project Risk Scanで問題なし（Severity: none）',
    }]
  }

  return riskScanResult.issues.map(issue => ({
    rule: `TARGET_PROJECT_RISK_SCAN_${issue.id}`,
    file: issue.evidence[0],
    detail: `${issue.label}（severity: ${issue.severity}）`,
  }))
}

function buildFinalReason(
  severity: 'high' | 'medium' | 'low' | undefined,
  riskScanResult: TargetProjectRiskScanResult,
): string {
  if (severity === undefined) {
    return 'target_project Risk Scan結果: リスクなし（mechanical_only相当）'
  }

  const issueSummary = riskScanResult.issues.map(i => i.id).join(', ')
  return `target_project Risk Scan結果（severity: ${severity}）: ${issueSummary}`
}

/**
 * requiresChatGptReview の判定。
 * control repo classifier の requiresChatGptReviewForClassifierResult() と同等の精神で:
 * - level === 3 なら true
 * - confidence < 0.5 なら true
 * - それ以外は false
 *
 * target_project Risk Scan由来の場合、ChatGPT固有のescalation rule
 * （CLAUDE_AGENTS_*系）は存在しないため、level/confidence のみで判定する。
 */
function requiresChatGptReview(level: number, confidence: number): boolean {
  return level === 3 || confidence < 0.5
}
