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

export type RoadmapDesignReviewFreshnessFailureCode =
  | 'MISSING_ROADMAP_DESIGN_REVIEW_EVIDENCE'
  | 'ROADMAP_DESIGN_REVIEW_HASH_MISMATCH'
  | 'ROADMAP_DESIGN_REVIEW_NOT_ALIGNED'
  | 'ROADMAP_DESIGN_REVIEW_INDEPENDENT_REVIEW_NOT_APPROVED'

export type RoadmapDesignReviewFreshnessResult =
  | { ok: true; evidence: DesignReviewEvidence }
  | { ok: false; code: RoadmapDesignReviewFreshnessFailureCode; reason: string }

/**
 * Roadmap review is always critical-load by construction (ROADMAP_REVIEW_LOAD_CLASSIFICATION), so
 * fresh ALIGNED evidence always requires an approved independent review verdict too — same rule
 * checkImplementJobDesignReviewEvidence already applies conditionally for critical-load Task
 * evidence, just unconditional here since roadmap is always critical.
 */
export function checkRoadmapDesignReviewFreshness(
  projectId: string,
  currentReviewMaterial: string,
  evidenceStorage: IDesignReviewEvidenceStorage,
): RoadmapDesignReviewFreshnessResult {
  const evidence = evidenceStorage.findLatestBySubjectId('roadmap', projectId)
  if (!evidence) {
    return { ok: false, code: 'MISSING_ROADMAP_DESIGN_REVIEW_EVIDENCE', reason: 'No Roadmap Design Review evidence exists for this project' }
  }
  if (evidence.designTextHash !== computeDesignTextHash(currentReviewMaterial)) {
    return { ok: false, code: 'ROADMAP_DESIGN_REVIEW_HASH_MISMATCH', reason: 'Latest Roadmap Design Review evidence was created for a different Project Definition, structured constraints, or Roadmap content' }
  }
  if (evidence.decision !== 'ALIGNED') {
    return { ok: false, code: 'ROADMAP_DESIGN_REVIEW_NOT_ALIGNED', reason: `Latest Roadmap Design Review decision is ${evidence.decision}` }
  }
  if (evidence.independentReviewVerdict !== 'approved') {
    return { ok: false, code: 'ROADMAP_DESIGN_REVIEW_INDEPENDENT_REVIEW_NOT_APPROVED', reason: 'Roadmap Design Review is always critical-load and requires an approved independent review verdict' }
  }
  return { ok: true, evidence }
}
