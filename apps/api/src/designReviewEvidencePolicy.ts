import { createHash } from 'node:crypto'
import type { DesignReviewEvidence } from '@ai-team/shared'
import type { IDesignReviewEvidenceStorage } from './storage/interface'

export type ImplementDesignReviewPreconditionFailureCode =
  | 'MISSING_AI_CLI_PROMPT'
  | 'MISSING_DESIGN_REVIEW_EVIDENCE'
  | 'DESIGN_REVIEW_HASH_MISMATCH'
  | 'DESIGN_REVIEW_NOT_ALIGNED'
  | 'CRITICAL_INDEPENDENT_REVIEW_NOT_APPROVED'

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
}

export function computeDesignTextHash(designText: string): string {
  return createHash('sha256').update(designText, 'utf-8').digest('hex')
}

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

  return { ok: true, evidence }
}
