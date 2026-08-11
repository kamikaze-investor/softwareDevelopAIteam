import { describe, it, expect } from 'vitest'
import {
  runRiskReview,
  computeDiffHash,
  resolveEffectiveStatus,
  decideGateOutcome,
  buildApprovalRequest,
} from './approvalGate'
import type { ApprovalRequest, ApprovalGateInput } from '@ai-team/shared'

// ────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────

function makeApprovalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const base: ApprovalRequest = {
    id: 'approval-20260619-00000001',
    taskId: 'task-001',
    targetBranch: 'feat/test',
    targetCommit: 'abc123',
    targetDiffHash: 'deadbeef',
    riskLevel: 'HIGH',
    requestedAction: 'merge feature branch',
    status: 'WAITING_FOR_USER',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    invalidIf: [],
    createdAt: new Date().toISOString(),
  }
  return { ...base, ...overrides }
}

const COMMIT = 'abc123'
const DIFF_HASH = 'deadbeef'
const OTHER_COMMIT = 'xyz999'
const OTHER_DIFF_HASH = 'cafebabe'

// ────────────────────────────────────────────────────────────
// runRiskReview
// ────────────────────────────────────────────────────────────

describe('runRiskReview', () => {
  it('docs-only → LOW, requiresIndependentReview=false', () => {
    const result = runRiskReview(['docs/architecture.md'])
    expect(result.riskLevel).toBe('LOW')
    expect(result.requiresIndependentReview).toBe(false)
    expect(result.triggeredRules).toHaveLength(0)
  })

  // Codex P1: .md でも AI 指示ファイルは CRITICAL
  it('AGENTS.md → CRITICAL (AI instruction file)', () => {
    const result = runRiskReview(['AGENTS.md'])
    expect(result.riskLevel).toBe('CRITICAL')
    expect(result.triggeredRules).toContain('AI instruction file')
  })

  it('CLAUDE.md → CRITICAL (AI instruction file)', () => {
    const result = runRiskReview(['CLAUDE.md'])
    expect(result.riskLevel).toBe('CRITICAL')
    expect(result.triggeredRules).toContain('AI instruction file')
  })

  // Codex P1 review: safe-only パス配下の AGENTS.md / CLAUDE.md も CRITICAL
  it('docs/AGENTS.md → CRITICAL (safe-only path does not bypass CRITICAL rules)', () => {
    const result = runRiskReview(['docs/AGENTS.md'])
    expect(result.riskLevel).toBe('CRITICAL')
    expect(result.triggeredRules).toContain('AI instruction file')
  })

  it('logs/CLAUDE.md → CRITICAL (safe-only path does not bypass CRITICAL rules)', () => {
    const result = runRiskReview(['logs/CLAUDE.md'])
    expect(result.riskLevel).toBe('CRITICAL')
    expect(result.triggeredRules).toContain('AI instruction file')
  })

  // Codex P1: docker-compose.yml / sandbox 配下も HIGH
  it('docker-compose.yml → HIGH', () => {
    const result = runRiskReview(['docker-compose.yml'])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain('docker / sandbox config')
  })

  it('sandbox/config.yml → HIGH', () => {
    const result = runRiskReview(['sandbox/config.yml'])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain('docker / sandbox config')
  })

  // Codex P1: .github/CODEOWNERS など workflows 以外の .github/ も HIGH
  it('.github/CODEOWNERS → HIGH (CI/CD workflow change)', () => {
    const result = runRiskReview(['.github/CODEOWNERS'])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain('CI/CD workflow change')
  })

  it('logs-only → LOW', () => {
    const result = runRiskReview(['logs/dev-sessions/2026-06-19.md'])
    expect(result.riskLevel).toBe('LOW')
  })

  it('plain TS file (no pattern match) → LOW', () => {
    const result = runRiskReview(['src/utils/helper.ts'])
    expect(result.riskLevel).toBe('LOW')
  })

  it('migration file → HIGH', () => {
    const result = runRiskReview(['db/migration/0001_init.ts'])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.requiresIndependentReview).toBe(true)
    expect(result.triggeredRules).toContain('DB migration / schema')
  })

  it('schema.ts → HIGH', () => {
    const result = runRiskReview(['apps/api/src/storage/schema.ts'])
    expect(result.riskLevel).toBe('HIGH')
  })

  it('auth file → HIGH', () => {
    const result = runRiskReview(['apps/api/src/auth/apiToken.ts'])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain('auth / permission guard')
  })

  it('payment file → CRITICAL', () => {
    const result = runRiskReview(['apps/api/src/routes/payment.ts'])
    expect(result.riskLevel).toBe('CRITICAL')
    expect(result.triggeredRules).toContain('payment / billing')
  })

  it('stripe file → CRITICAL', () => {
    const result = runRiskReview(['libs/stripe/index.ts'])
    expect(result.riskLevel).toBe('CRITICAL')
  })

  it('.env file → HIGH', () => {
    const result = runRiskReview(['.env.example'])
    expect(result.riskLevel).toBe('HIGH')
  })

  it('Dockerfile → HIGH', () => {
    const result = runRiskReview(['sandbox/docker/Dockerfile'])
    expect(result.riskLevel).toBe('HIGH')
  })

  it('GitHub workflow → HIGH', () => {
    const result = runRiskReview(['.github/workflows/ci.yml'])
    expect(result.riskLevel).toBe('HIGH')
  })

  it('alignmentCheck file → HIGH', () => {
    const result = runRiskReview(['apps/worker/src/alignmentCheck.ts'])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain('alignment / gate change')
  })

  it('mixed: LOW + HIGH → HIGH (max wins)', () => {
    const result = runRiskReview(['docs/architecture.md', 'db/migration/0001_init.ts'])
    expect(result.riskLevel).toBe('HIGH')
  })

  it('mixed: HIGH + CRITICAL → CRITICAL', () => {
    const result = runRiskReview(['db/migration/0001_init.ts', 'billing/stripe.ts'])
    expect(result.riskLevel).toBe('CRITICAL')
  })

  // Codex P3: 混在変更で triggeredRules が全ルール分揃うことを確認
  it('mixed CRITICAL+HIGH: all triggered rules collected (no early return)', () => {
    const result = runRiskReview(['db/migration/0001_init.ts', 'billing/stripe.ts'])
    expect(result.riskLevel).toBe('CRITICAL')
    expect(result.triggeredRules).toContain('DB migration / schema')
    expect(result.triggeredRules).toContain('payment / billing')
  })

  it('docs/AGENTS.md + migration → CRITICAL with both rules', () => {
    const result = runRiskReview(['docs/AGENTS.md', 'db/migration/0001_init.ts'])
    expect(result.riskLevel).toBe('CRITICAL')
    expect(result.triggeredRules).toContain('AI instruction file')
    expect(result.triggeredRules).toContain('DB migration / schema')
  })

  it('empty list → LOW (no files = no risk)', () => {
    const result = runRiskReview([])
    expect(result.riskLevel).toBe('LOW')
  })
})

// ────────────────────────────────────────────────────────────
// computeDiffHash
// ────────────────────────────────────────────────────────────

describe('computeDiffHash', () => {
  it('returns hex string of length 64 (SHA-256)', () => {
    const hash = computeDiffHash('some diff text')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('same text → same hash (deterministic)', () => {
    expect(computeDiffHash('abc')).toBe(computeDiffHash('abc'))
  })

  it('different text → different hash', () => {
    expect(computeDiffHash('diff1')).not.toBe(computeDiffHash('diff2'))
  })
})

// ────────────────────────────────────────────────────────────
// resolveEffectiveStatus
// ────────────────────────────────────────────────────────────

describe('resolveEffectiveStatus', () => {
  it('WAITING_FOR_USER → returns WAITING_FOR_USER', () => {
    const req = makeApprovalRequest({ status: 'WAITING_FOR_USER' })
    expect(resolveEffectiveStatus(req, COMMIT, DIFF_HASH)).toBe('WAITING_FOR_USER')
  })

  it('APPROVED + same commit/diff → APPROVED', () => {
    const req = makeApprovalRequest({ status: 'APPROVED', targetCommit: COMMIT, targetDiffHash: DIFF_HASH })
    expect(resolveEffectiveStatus(req, COMMIT, DIFF_HASH)).toBe('APPROVED')
  })

  it('APPROVED + different commit → STALE', () => {
    const req = makeApprovalRequest({ status: 'APPROVED', targetCommit: COMMIT, targetDiffHash: DIFF_HASH })
    expect(resolveEffectiveStatus(req, OTHER_COMMIT, DIFF_HASH)).toBe('STALE')
  })

  it('APPROVED + different diffHash → STALE', () => {
    const req = makeApprovalRequest({ status: 'APPROVED', targetCommit: COMMIT, targetDiffHash: DIFF_HASH })
    expect(resolveEffectiveStatus(req, COMMIT, OTHER_DIFF_HASH)).toBe('STALE')
  })

  it('APPROVED but expired → EXPIRED', () => {
    const req = makeApprovalRequest({
      status: 'APPROVED',
      targetCommit: COMMIT,
      targetDiffHash: DIFF_HASH,
      expiresAt: new Date(Date.now() - 1000).toISOString(),  // 1 sec ago
    })
    expect(resolveEffectiveStatus(req, COMMIT, DIFF_HASH)).toBe('EXPIRED')
  })

  it('REJECTED + same commit/diff → returns REJECTED', () => {
    const req = makeApprovalRequest({ status: 'REJECTED', targetCommit: COMMIT, targetDiffHash: DIFF_HASH })
    expect(resolveEffectiveStatus(req, COMMIT, DIFF_HASH)).toBe('REJECTED')
  })

  it('REJECTED + different commit/diff → SUPERSEDED', () => {
    const req = makeApprovalRequest({ status: 'REJECTED', targetCommit: COMMIT, targetDiffHash: DIFF_HASH })
    expect(resolveEffectiveStatus(req, OTHER_COMMIT, OTHER_DIFF_HASH)).toBe('SUPERSEDED')
  })

  it('SUPERSEDED → returns SUPERSEDED', () => {
    const req = makeApprovalRequest({ status: 'SUPERSEDED' })
    expect(resolveEffectiveStatus(req, COMMIT, DIFF_HASH)).toBe('SUPERSEDED')
  })

  it('expired WAITING_FOR_USER → EXPIRED', () => {
    const req = makeApprovalRequest({
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    expect(resolveEffectiveStatus(req, COMMIT, DIFF_HASH)).toBe('EXPIRED')
  })
})

// ────────────────────────────────────────────────────────────
// decideGateOutcome
// ────────────────────────────────────────────────────────────

describe('decideGateOutcome', () => {
  const lowReview = { riskLevel: 'LOW' as const, triggeredRules: [], requiresIndependentReview: false }
  const mediumReview = { riskLevel: 'MEDIUM' as const, triggeredRules: [], requiresIndependentReview: false }
  const highReview = { riskLevel: 'HIGH' as const, triggeredRules: ['auth / permission guard'], requiresIndependentReview: true }
  const criticalReview = { riskLevel: 'CRITICAL' as const, triggeredRules: ['payment / billing'], requiresIndependentReview: true }

  it('LOW → ALLOW without any request', () => {
    const outcome = decideGateOutcome(lowReview, undefined, COMMIT, DIFF_HASH)
    expect(outcome.decision).toBe('ALLOW')
    if (outcome.decision === 'ALLOW') expect(outcome.riskLevel).toBe('LOW')
  })

  it('MEDIUM → ALLOW without any request', () => {
    const outcome = decideGateOutcome(mediumReview, undefined, COMMIT, DIFF_HASH)
    expect(outcome.decision).toBe('ALLOW')
  })

  it('HIGH with no request → BLOCKED', () => {
    const outcome = decideGateOutcome(highReview, undefined, COMMIT, DIFF_HASH)
    expect(outcome.decision).toBe('BLOCKED')
  })

  it('CRITICAL with no request → BLOCKED', () => {
    const outcome = decideGateOutcome(criticalReview, undefined, COMMIT, DIFF_HASH)
    expect(outcome.decision).toBe('BLOCKED')
  })

  it('HIGH with WAITING_FOR_USER request → PENDING_APPROVAL', () => {
    const req = makeApprovalRequest({ riskLevel: 'HIGH', status: 'WAITING_FOR_USER', targetCommit: COMMIT, targetDiffHash: DIFF_HASH })
    const outcome = decideGateOutcome(highReview, req, COMMIT, DIFF_HASH)
    expect(outcome.decision).toBe('PENDING_APPROVAL')
    if (outcome.decision === 'PENDING_APPROVAL') expect(outcome.requestId).toBe(req.id)
  })

  it('HIGH with APPROVED (same commit/diff) → ALLOW with consumedRequestId', () => {
    const req = makeApprovalRequest({ riskLevel: 'HIGH', status: 'APPROVED', targetCommit: COMMIT, targetDiffHash: DIFF_HASH })
    const outcome = decideGateOutcome(highReview, req, COMMIT, DIFF_HASH)
    expect(outcome.decision).toBe('ALLOW')
    if (outcome.decision === 'ALLOW') {
      // Codex P2: 一回限りの承認。呼び出し元が consumedRequestId で SUPERSEDED にする
      expect(outcome.consumedRequestId).toBe(req.id)
    }
  })

  it('HIGH with APPROVED but commit changed → STALE', () => {
    const req = makeApprovalRequest({ riskLevel: 'HIGH', status: 'APPROVED', targetCommit: COMMIT, targetDiffHash: DIFF_HASH })
    const outcome = decideGateOutcome(highReview, req, OTHER_COMMIT, DIFF_HASH)
    expect(outcome.decision).toBe('STALE')
    if (outcome.decision === 'STALE') expect(outcome.requestId).toBe(req.id)
  })

  it('HIGH with REJECTED request (same commit/diff) → REJECTED', () => {
    const req = makeApprovalRequest({ riskLevel: 'HIGH', status: 'REJECTED', targetCommit: COMMIT, targetDiffHash: DIFF_HASH })
    const outcome = decideGateOutcome(highReview, req, COMMIT, DIFF_HASH)
    expect(outcome.decision).toBe('REJECTED')
    if (outcome.decision === 'REJECTED') expect(outcome.requestId).toBe(req.id)
  })

  it('HIGH with REJECTED request (different commit/diff) → BLOCKED', () => {
    const req = makeApprovalRequest({ riskLevel: 'HIGH', status: 'REJECTED', targetCommit: COMMIT, targetDiffHash: DIFF_HASH })
    const outcome = decideGateOutcome(highReview, req, OTHER_COMMIT, OTHER_DIFF_HASH)
    expect(outcome.decision).toBe('BLOCKED')
  })

  it('CRITICAL with APPROVED (same commit/diff) → ALLOW with consumedRequestId', () => {
    const req = makeApprovalRequest({ riskLevel: 'CRITICAL', status: 'APPROVED', targetCommit: COMMIT, targetDiffHash: DIFF_HASH })
    const outcome = decideGateOutcome(criticalReview, req, COMMIT, DIFF_HASH)
    expect(outcome.decision).toBe('ALLOW')
    if (outcome.decision === 'ALLOW') expect(outcome.consumedRequestId).toBe(req.id)
  })

  it('LOW with APPROVED request → ALLOW without consumedRequestId', () => {
    // LOW は承認不要。consumedRequestId はない
    const outcome = decideGateOutcome(lowReview, undefined, COMMIT, DIFF_HASH)
    expect(outcome.decision).toBe('ALLOW')
    if (outcome.decision === 'ALLOW') expect(outcome.consumedRequestId).toBeUndefined()
  })

  it('BLOCKED message contains triggered rules', () => {
    const outcome = decideGateOutcome(highReview, undefined, COMMIT, DIFF_HASH)
    expect(outcome.decision).toBe('BLOCKED')
    if (outcome.decision === 'BLOCKED') {
      expect(outcome.reason).toContain('auth / permission guard')
    }
  })
})

// ────────────────────────────────────────────────────────────
// buildApprovalRequest
// ────────────────────────────────────────────────────────────

describe('buildApprovalRequest', () => {
  const input: ApprovalGateInput = {
    taskId: 'task-001',
    targetBranch: 'feat/auth',
    targetCommit: COMMIT,
    targetDiffHash: DIFF_HASH,
    changedFiles: ['apps/api/src/auth/apiToken.ts'],
    requestedAction: 'merge auth feature',
  }

  it('builds correct structure for HIGH', () => {
    const req = buildApprovalRequest(input, 'HIGH')
    expect(req.taskId).toBe(input.taskId)
    expect(req.targetCommit).toBe(COMMIT)
    expect(req.targetDiffHash).toBe(DIFF_HASH)
    expect(req.riskLevel).toBe('HIGH')
    expect(req.status).toBe('WAITING_FOR_USER')
    expect(req.invalidIf.length).toBeGreaterThan(0)
  })

  it.each(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const)(
    '%s expires in ~24 hours (no risk-based branching)',
    (riskLevel) => {
      const req = buildApprovalRequest(input, riskLevel)
      const diffMs = new Date(req.expiresAt).getTime() - Date.now()
      expect(diffMs).toBeGreaterThan(23 * 60 * 60 * 1000)
      expect(diffMs).toBeLessThan(25 * 60 * 60 * 1000)
    },
  )

  it('invalidIf includes the expiry time', () => {
    const req = buildApprovalRequest(input, 'HIGH')
    const hasExpiry = req.invalidIf.some(s => s.includes('を過ぎた場合'))
    expect(hasExpiry).toBe(true)
  })
})
