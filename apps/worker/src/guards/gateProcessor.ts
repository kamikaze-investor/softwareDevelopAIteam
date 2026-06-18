/**
 * Gate Processor
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * SafetyAuditor（静的解析）と AlignmentChecker（Gemini）の両結果を統合し、
 * 最終的な Gate Decision を決定する。
 *
 * Gate ルール:
 *   LOW / MEDIUM   → ALLOW（自動継続）
 *   HIGH           → DEEP_REVIEW（Deep Review 必須・通知）
 *   CRITICAL       → BLOCK_CEO_REQUIRED（CEO 承認必須・自動停止）
 *
 * 重要原則:
 *   - AuditReport と AlignmentReport のどちらか高い方を採用する
 *   - AlignmentReport に critical issue があれば必ず CRITICAL に格上げ
 *   - AIの判断はあくまで「検出」であり「承認」ではない
 */

import type {
  AuditReport,
  AlignmentReport,
  GateDecision,
  RiskLevel,
} from '@ai-team/shared'
import { toGateDecision } from './safetyAuditor.js'

const RISK_ORDER: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}

// ────────────────────────────────────────────────────────────
// AlignmentReport からリスクレベルを算出
// ────────────────────────────────────────────────────────────

function riskFromAlignment(alignment: AlignmentReport): RiskLevel {
  if (!alignment.aligned) {
    const hasCritical = alignment.issues.some((i) => i.severity === 'critical')
    const hasWarning = alignment.issues.some((i) => i.severity === 'warning')
    if (hasCritical) return 'CRITICAL'
    if (hasWarning) return 'HIGH'
    return 'MEDIUM'
  }
  return 'LOW'
}

// ────────────────────────────────────────────────────────────
// Gate Result
// ────────────────────────────────────────────────────────────

export interface GateResult {
  /** 最終リスクレベル（AuditReport と AlignmentReport の高い方） */
  finalRiskLevel: RiskLevel
  /** 最終 Gate 判定 */
  gateDecision: GateDecision
  /** ブロック / Deep Review の理由 */
  reason?: string
  /** AuditReport のリスク（入力のまま） */
  auditRiskLevel: RiskLevel
  /** AlignmentReport のリスク（なければ LOW） */
  alignmentRiskLevel: RiskLevel
}

/**
 * AuditReport と AlignmentReport（省略可能）を統合して最終 Gate を決定する。
 *
 * @param audit     safetyAuditor の結果（必須）
 * @param alignment alignmentChecker の結果（省略可能 — 実行しなかった場合は undefined）
 */
export function processGate(
  audit: AuditReport,
  alignment?: AlignmentReport,
): GateResult {
  const auditRisk = audit.riskLevel
  const alignmentRisk = alignment ? riskFromAlignment(alignment) : 'LOW'
  const finalRiskLevel = maxRisk(auditRisk, alignmentRisk)
  const gateDecision = toGateDecision(finalRiskLevel)

  const reason = buildReason(gateDecision, audit, alignment)

  return {
    finalRiskLevel,
    gateDecision,
    reason,
    auditRiskLevel: auditRisk,
    alignmentRiskLevel: alignmentRisk,
  }
}

function buildReason(
  decision: GateDecision,
  audit: AuditReport,
  alignment?: AlignmentReport,
): string | undefined {
  if (decision === 'ALLOW') return undefined

  const parts: string[] = []

  if (audit.blockedReason) {
    parts.push(`[Policy] ${audit.blockedReason}`)
  }

  if (alignment && !alignment.aligned) {
    const critical = alignment.issues
      .filter((i) => i.severity === 'critical')
      .map((i) => i.description)
    const warnings = alignment.issues
      .filter((i) => i.severity === 'warning')
      .map((i) => i.description)

    if (critical.length > 0) {
      parts.push(`[Alignment CRITICAL] ${critical.join(' / ')}`)
    }
    if (warnings.length > 0) {
      parts.push(`[Alignment WARNING] ${warnings.join(' / ')}`)
    }
  }

  return parts.length > 0 ? parts.join(' | ') : `Risk: ${audit.riskLevel}`
}
