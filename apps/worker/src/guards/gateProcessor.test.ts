/**
 * Gate Processor テスト
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 */

import { describe, expect, it } from 'vitest'
import { processGate } from './gateProcessor.js'
import type { AuditReport, AlignmentReport } from '@ai-team/shared'

function makeAudit(riskLevel: AuditReport['riskLevel'], blockedReason?: string): AuditReport {
  return {
    ref: 'test-ref',
    changedFiles: [],
    diffSummary: [],
    dangerousHits: [],
    riskLevel,
    gateDecision: riskLevel === 'LOW' || riskLevel === 'MEDIUM'
      ? 'ALLOW'
      : riskLevel === 'HIGH'
        ? 'DEEP_REVIEW'
        : 'BLOCK_CEO_REQUIRED',
    blockedReason,
    auditedAt: new Date().toISOString(),
  }
}

function makeAlignment(aligned: boolean, severities: Array<'critical' | 'warning' | 'info'> = []): AlignmentReport {
  return {
    ref: 'test-ref',
    aligned,
    summary: aligned ? 'OK' : 'Issues found',
    issues: severities.map((severity, i) => ({
      severity,
      category: 'philosophy_drift' as const,
      description: `Issue ${i}`,
      evidence: `evidence ${i}`,
    })),
    auditedAt: new Date().toISOString(),
  }
}

describe('processGate - audit only', () => {
  it('LOW audit → ALLOW', () => {
    const result = processGate(makeAudit('LOW'))
    expect(result.gateDecision).toBe('ALLOW')
    expect(result.finalRiskLevel).toBe('LOW')
    expect(result.reason).toBeUndefined()
  })

  it('MEDIUM audit → ALLOW', () => {
    const result = processGate(makeAudit('MEDIUM'))
    expect(result.gateDecision).toBe('ALLOW')
    expect(result.finalRiskLevel).toBe('MEDIUM')
  })

  it('HIGH audit → DEEP_REVIEW', () => {
    const result = processGate(makeAudit('HIGH', 'dangerous file'))
    expect(result.gateDecision).toBe('DEEP_REVIEW')
    expect(result.finalRiskLevel).toBe('HIGH')
    expect(result.reason).toContain('Policy')
  })

  it('CRITICAL audit → BLOCK_CEO_REQUIRED', () => {
    const result = processGate(makeAudit('CRITICAL', 'autoApprove detected'))
    expect(result.gateDecision).toBe('BLOCK_CEO_REQUIRED')
    expect(result.finalRiskLevel).toBe('CRITICAL')
    expect(result.reason).toContain('autoApprove detected')
  })
})

describe('processGate - alignment escalation', () => {
  it('LOW audit + aligned alignment → ALLOW', () => {
    const result = processGate(makeAudit('LOW'), makeAlignment(true))
    expect(result.gateDecision).toBe('ALLOW')
    expect(result.alignmentRiskLevel).toBe('LOW')
  })

  it('LOW audit + alignment warning → HIGH (alignment wins)', () => {
    const result = processGate(makeAudit('LOW'), makeAlignment(false, ['warning']))
    expect(result.finalRiskLevel).toBe('HIGH')
    expect(result.gateDecision).toBe('DEEP_REVIEW')
    expect(result.alignmentRiskLevel).toBe('HIGH')
    expect(result.reason).toContain('Alignment WARNING')
  })

  it('LOW audit + alignment critical → CRITICAL (alignment wins)', () => {
    const result = processGate(makeAudit('LOW'), makeAlignment(false, ['critical']))
    expect(result.finalRiskLevel).toBe('CRITICAL')
    expect(result.gateDecision).toBe('BLOCK_CEO_REQUIRED')
    expect(result.reason).toContain('Alignment CRITICAL')
  })

  it('HIGH audit + alignment critical → CRITICAL (takes max)', () => {
    const result = processGate(makeAudit('HIGH', 'guard file'), makeAlignment(false, ['critical']))
    expect(result.finalRiskLevel).toBe('CRITICAL')
    expect(result.gateDecision).toBe('BLOCK_CEO_REQUIRED')
    expect(result.reason).toContain('Policy')
    expect(result.reason).toContain('Alignment CRITICAL')
  })

  it('CRITICAL audit + aligned alignment → CRITICAL (audit wins)', () => {
    const result = processGate(makeAudit('CRITICAL', 'env file'), makeAlignment(true))
    expect(result.finalRiskLevel).toBe('CRITICAL')
    expect(result.gateDecision).toBe('BLOCK_CEO_REQUIRED')
  })

  it('omitting alignment defaults alignmentRiskLevel to LOW', () => {
    const result = processGate(makeAudit('MEDIUM'))
    expect(result.alignmentRiskLevel).toBe('LOW')
  })
})

describe('processGate - reason building', () => {
  it('includes both audit and alignment reasons when both have issues', () => {
    const result = processGate(
      makeAudit('HIGH', 'dangerous keyword: bypass'),
      makeAlignment(false, ['warning']),
    )
    expect(result.reason).toContain('[Policy]')
    expect(result.reason).toContain('[Alignment WARNING]')
  })

  it('reason is undefined when ALLOW', () => {
    const result = processGate(makeAudit('LOW'), makeAlignment(true))
    expect(result.reason).toBeUndefined()
  })
})
