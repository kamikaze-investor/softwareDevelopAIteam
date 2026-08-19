import { createHash } from 'node:crypto'
import type { DesignReviewEvidence } from '@ai-team/shared'
import type { IDesignReviewEvidenceStorage } from './storage/interface'
import { computeCriticalDesignFactsHash } from './designReview/criticalDesignFactsHash'

export type ImplementDesignReviewPreconditionFailureCode =
  | 'MISSING_AI_CLI_PROMPT'
  | 'MISSING_DESIGN_REVIEW_EVIDENCE'
  | 'DESIGN_REVIEW_HASH_MISMATCH'
  | 'DESIGN_REVIEW_NOT_ALIGNED'
  | 'CRITICAL_INDEPENDENT_REVIEW_NOT_APPROVED'
  | 'CRITICAL_FACTS_NOT_REVIEWED'
  | 'CRITICAL_FACTS_CHANGED'

export type ImplementDesignReviewPreconditionResult =
  | { ok: true; evidence?: DesignReviewEvidence }
  | {
      ok: false
      code: ImplementDesignReviewPreconditionFailureCode
      reason: string
    }

export interface ImplementDesignReviewPreconditionInput {
  taskId: string
  aiCliMode?: string
  aiCliPrompt?: string
  currentCriticalFactsHash?: string
}

export function computeDesignTextHash(designText: string): string {
  return createHash('sha256').update(designText, 'utf-8').digest('hex')
}

export { computeCriticalDesignFactsHash }

export function checkImplementJobDesignReviewEvidence(
  input: ImplementDesignReviewPreconditionInput,
  evidenceStorage: IDesignReviewEvidenceStorage,
): ImplementDesignReviewPreconditionResult {
  if (input.aiCliMode !== 'implement') {
    return { ok: true }
  }

  if (input.aiCliPrompt === undefined) {
    return {
      ok: false,
      code: 'MISSING_AI_CLI_PROMPT',
      reason: 'Implement Job is missing aiCliPrompt for Design Review evidence matching',
    }
  }

  const evidence = evidenceStorage.findLatestByTaskId(input.taskId)
  if (!evidence) {
    return {
      ok: false,
      code: 'MISSING_DESIGN_REVIEW_EVIDENCE',
      reason: 'No Design Review evidence exists for this Task',
    }
  }

  if (evidence.designTextHash !== computeDesignTextHash(input.aiCliPrompt)) {
    return {
      ok: false,
      code: 'DESIGN_REVIEW_HASH_MISMATCH',
      reason: 'Latest Design Review evidence was created for different design text',
    }
  }

  if (evidence.decision !== 'ALIGNED') {
    return {
      ok: false,
      code: 'DESIGN_REVIEW_NOT_ALIGNED',
      reason: `Latest Design Review decision is ${evidence.decision}`,
    }
  }

  if (evidence.reviewLoad === 'critical' && evidence.independentReviewVerdict !== 'approved') {
    return {
      ok: false,
      code: 'CRITICAL_INDEPENDENT_REVIEW_NOT_APPROVED',
      reason: 'Critical Design Review evidence is missing an approved independent review verdict',
    }
  }

  if (input.currentCriticalFactsHash !== undefined) {
    if (evidence.criticalFactsHash === undefined) {
      return {
        ok: false,
        code: 'CRITICAL_FACTS_NOT_REVIEWED',
        reason: 'Design Review evidence is missing critical facts hash',
      }
    }
    if (evidence.criticalFactsHash !== input.currentCriticalFactsHash) {
      return {
        ok: false,
        code: 'CRITICAL_FACTS_CHANGED',
        reason: 'Critical Design Facts have changed since Design Review',
      }
    }
  }

  return { ok: true, evidence }
}