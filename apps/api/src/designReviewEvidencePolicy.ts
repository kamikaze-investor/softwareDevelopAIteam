import { createHash } from 'node:crypto'
import type { DesignReviewEvidence } from '@ai-team/shared'
import {
  isGeneratorSeparatedFromFinalReviewer,
  ROADMAP_FINAL_REVIEWER_PROVIDER,
  ROADMAP_GENERATOR_PROVIDER,
} from '@ai-team/shared'
import type { IDesignReviewEvidenceStorage } from './storage/interface'

export type ImplementDesignReviewPreconditionFailureCode =
  | 'MISSING_AI_CLI_PROMPT'
  | 'MISSING_DESIGN_REVIEW_EVIDENCE'
  | 'DESIGN_REVIEW_HASH_MISMATCH'
  | 'DESIGN_REVIEW_NOT_ALIGNED'
  | 'CRITICAL_INDEPENDENT_REVIEW_NOT_APPROVED'
  | 'DESIGN_REVIEW_SUPERSEDED'

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

/** 保存済み run の判定の分類。`none` は判定が無い（failed / REVIEW_UNAVAILABLE / 結果なし）。 */
export type StoredRunJudgment = 'aligned' | 'negative' | 'none'

/**
 * **同じ subject・同じ design hash では、最新の判定が正である。** ALIGNED evidence を使ってよいのは、
 * それより新しい同じ subject・同じ hash の run が
 *   - active（queued / running）でなく、かつ
 *   - 終端して ALIGNED 以外の判定（CONFLICT / UNCERTAIN）を出していない
 * ときだけである。判定の無い終端（failed / REVIEW_UNAVAILABLE / 結果なし）は evidence を無効にしない。
 *
 * 以前は evidence だけを見ていたため、古い ALIGNED evidence が同じ設計に対する新しい本物の
 * CONFLICT を上書きし、回収経路が Job を作り、Remediation は CONFLICT を見失った
 * （独立レビュー round 8・2026-10-16）。evidence を読む Gate はすべてこの規則を通す
 * （`checkImplementJobDesignReviewEvidence` / `checkRoadmapDesignReviewFreshness` は
 * storage の `findSupersedingRun()` 経由でこの関数を使う）。
 *
 * `runs` は evidence と同じ subject の run（呼び出し側が subject で絞る）。evidence を登録した run
 * 自身は ALIGNED なので数えない。
 *
 * **「新しい」の順序（`isAfterEvidence`）:**
 *   - evidence が生んだ run を知っている（`runId` あり）なら、呼び出し側（storage）が
 *     **その run より後に挿入された run** を渡す。run の挿入順（rowid）は表の中で単調で、
 *     同じ ms の作成や時計の巻き戻りに左右されない（独立レビュー round 10）。
 *   - 生んだ run が分からない evidence（`runId` の無い legacy 行・手動登録）だけは、既定の
 *     **timestamp 規則**（evidence より厳密に後に作られた run）に落とす。同じ ms の run は順序を
 *     決められないので覆さない —— legacy 行に限った、既知の弱さである。
 */
export function findSupersedingRun<TRun extends { status: string; designTextHash: string; createdAt: string }>(
  evidence: Pick<DesignReviewEvidence, 'designTextHash' | 'createdAt'>,
  runs: readonly TRun[],
  judgmentOf: (run: TRun) => StoredRunJudgment,
  isAfterEvidence: (run: TRun) => boolean = (run) => run.createdAt > evidence.createdAt,
): TRun | undefined {
  return runs.find((run) => {
    if (run.designTextHash !== evidence.designTextHash || !isAfterEvidence(run)) return false
    if (run.status === 'queued' || run.status === 'running') return true
    if (run.status !== 'succeeded') return false
    return judgmentOf(run) === 'negative'
  })
}

/** evidence が ALIGNED で、かつ新しい run に覆されていない（使ってよい）か。 */
export function isUsableAlignedEvidence(
  evidence: DesignReviewEvidence | undefined,
  evidenceStorage: IDesignReviewEvidenceStorage,
): evidence is DesignReviewEvidence {
  return evidence !== undefined
    && evidence.decision === 'ALIGNED'
    && evidenceStorage.findSupersedingRun(evidence) === undefined
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

  const superseding = evidenceStorage.findSupersedingRun(evidence)
  if (superseding !== undefined) {
    return {
      ok: false,
      code: 'DESIGN_REVIEW_SUPERSEDED',
      reason: `A newer Design Review run (${superseding.id}, ${superseding.status}) for the same design supersedes this evidence`,
    }
  }

  return { ok: true, evidence }
}

export type RoadmapDesignReviewFreshnessFailureCode =
  | 'MISSING_ROADMAP_DESIGN_REVIEW_EVIDENCE'
  | 'ROADMAP_DESIGN_REVIEW_HASH_MISMATCH'
  | 'ROADMAP_DESIGN_REVIEW_NOT_ALIGNED'
  | 'ROADMAP_DESIGN_REVIEW_INDEPENDENT_REVIEW_NOT_APPROVED'
  | 'ROADMAP_DESIGN_REVIEW_SUPERSEDED'
  // PR C: Roadmapの第二意見はClaude integration reviewが担うようになったため、
  // 特定providerのverdictではなく generator/final の vendor 分離を要求する。
  | 'ROADMAP_DESIGN_REVIEW_VENDOR_NOT_SEPARATED'

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
  const superseding = evidenceStorage.findSupersedingRun(evidence)
  if (superseding !== undefined) {
    return {
      ok: false,
      code: 'ROADMAP_DESIGN_REVIEW_SUPERSEDED',
      reason: `A newer Roadmap Design Review run (${superseding.id}, ${superseding.status}) for the same material supersedes this evidence`,
    }
  }
  // PR C 以前、Roadmap evidence は Codex independent review の approved verdict を要求していた。
  // 新topologyでは Roadmap の第二意見は Claude の integration review が担い、
  // Codex independent review は task kind 専用になったため、Worker はそもそも
  // roadmap 向けの independent verdict を生成しない。要求し続けると恒久的に落ちる。
  //
  // 置き換えとして要求するのは、生成者と最終レビュアーが**別vendorであること**。
  // 「別のAIが見た」ことの実質はこれであって、特定providerの名前ではない。
  // decision が ALIGNED であることは直前で既に確認済み（Gemini focused / Claude integration の
  // いずれかが CONFLICT / UNCERTAIN なら安全側集約でALIGNEDにならない）。
  if (!isGeneratorSeparatedFromFinalReviewer(ROADMAP_GENERATOR_PROVIDER, ROADMAP_FINAL_REVIEWER_PROVIDER)) {
    return { ok: false, code: 'ROADMAP_DESIGN_REVIEW_VENDOR_NOT_SEPARATED', reason: 'Roadmap generator and final reviewer must be different vendors' }
  }
  return { ok: true, evidence }
}
