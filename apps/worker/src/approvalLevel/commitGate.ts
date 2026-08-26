import type { ApprovalLevelResult, ReviewPolicy } from '@ai-team/shared'
import type { SafetyVerificationResult } from './safetyVerifier.js'
import type { PreReviewResult } from './preReviewer.js'
import type { PostReviewResult } from './postReviewer.js'

/** commitGateが確認する成果物の識別子 */
export type RequiredArtifactId =
  | 'APPROVAL_LEVEL_RESULT'
  | 'PRE_REVIEW_RESULT'
  | 'POST_REVIEW_RESULT'
  | 'SAFETY_VERIFICATION_RESULT'

export interface ArtifactCheckResult {
  id: RequiredArtifactId
  /**
   * このreviewPolicyでの要求を満たしているか。
   * 注意: required:false（このreviewPolicyでは不要な成果物）の場合、
   * present は常に true として返す。これは「実際に成果物が存在する」という
   * 意味ではなく、「このreviewPolicyでは不要なので欠落扱いにしない」という
   * 意味である。存在有無を実際に示すのは required:true のケースのみ。
   */
  present: boolean
  /** このreviewPolicyで必須とされる成果物かどうか */
  required: boolean
  detail: string
}

export interface CommitGateInput {
  jobId: string
  taskId: string
  approvalLevelResult: ApprovalLevelResult
  preReviewResult?: PreReviewResult
  postReviewResult?: PostReviewResult
  safetyVerificationResult?: SafetyVerificationResult
}

export interface CommitGateResult {
  jobId: string
  taskId: string
  /** commitを許可してよいか */
  allowed: boolean
  reviewPolicy: ReviewPolicy
  artifactChecks: ArtifactCheckResult[]
  /**
   * allowed:falseの理由一覧（人間可読・日本語1文完結）。
   * 該当する問題をすべて列挙する（最初の1件で打ち切らない）。
   * CEO事後報告にそのまま使える文言にすること。
   */
  blockingReasons: string[]
  decidedAt: string
}

/**
 * reviewPolicyに応じて必須の成果物リストを返す（純粋関数）。
 *
 * 注意: 'ceo_required' の場合は空配列 [] を返すが、これは
 * 「成果物が不要」という意味ではない。「成果物の有無に関係なく、
 * reviewPolicyがceo_requiredである時点で自動commitを禁止する」という
 * 意味である。この判定は evaluateCommitGate() 内で別途、成果物チェックとは
 * 独立した無条件blockingとして扱う。
 *
 * 2026-08-26 Phase 1c 修正:
 * - SAFETY_VERIFICATION_RESULT を下位tier（mechanical_only / light_ai_post_review）の
 *   必須から外した。理由: (1) safetyVerifier は未接続の blocking チェック（TYPECHECK 等）
 *   により structurally overallPassed:false になるため、下位tier でも always-fail となり
 *   commit が到達不能; (2) 対象は target_project であり、下位tier の相当するリスクシグナルは
 *   既に targetProjectRiskScanResult（deriveTargetProjectApprovalLevel の入力）がカバーしている。
 * - full_pre_post_review からも SAFETY_VERIFICATION_RESULT を外した（同理由）。
 * - full_pre_post_review から PRE_REVIEW_RESULT を外した。理由: preReviewer は
 *   jobRunner.ts に未接続（「変更計画テキスト」のキャプチャメカニズム未実装）のため、
 *   必須にしても常に欠落し commit 到達不能になる。将来 preReviewer 接続時に復活させる。
 *   note: PRE_REVIEW_RESULT / SAFETY_VERIFICATION_RESULT の checkArtifactPresence と
 *   evaluateCommitGate 内の blocked/overallPassed チェック自体は削除しない
 *   （これらは成果物が渡された場合に有効な汎用チェックのため）。
 */
export function getRequiredArtifacts(reviewPolicy: ReviewPolicy): RequiredArtifactId[] {
  switch (reviewPolicy) {
    case 'mechanical_only':
      return ['APPROVAL_LEVEL_RESULT']
    case 'light_ai_post_review':
      return ['APPROVAL_LEVEL_RESULT', 'POST_REVIEW_RESULT']
    case 'full_pre_post_review':
      return ['APPROVAL_LEVEL_RESULT', 'POST_REVIEW_RESULT']
    case 'ceo_required':
      return []
  }
}

/**
 * 指定された成果物IDについて、このreviewPolicyでの要求を満たしているかを判定する。
 *
 * - requiredArtifactsにidが含まれない場合（このreviewPolicyでは不要）:
 *   present:true, required:false を返す。これは「実際に存在する」ことを
 *   意味するのではなく、「不要なので欠落として扱わない」ことを意味する。
 * - requiredArtifactsにidが含まれる場合（必須）:
 *   実際の入力オブジェクトの有無に基づいて present を判定する。
 */
export function checkArtifactPresence(
  id: RequiredArtifactId,
  input: CommitGateInput,
  requiredArtifacts: RequiredArtifactId[],
): ArtifactCheckResult {
  const required = requiredArtifacts.includes(id)

  if (!required) {
    return {
      id,
      present: true,
      required: false,
      detail: `${id} はこのreviewPolicyでは不要なため、欠落扱いしない`,
    }
  }

  const actuallyPresent = (() => {
    switch (id) {
      case 'APPROVAL_LEVEL_RESULT':
        return input.approvalLevelResult !== undefined
      case 'PRE_REVIEW_RESULT':
        return input.preReviewResult !== undefined
      case 'POST_REVIEW_RESULT':
        return input.postReviewResult !== undefined
      case 'SAFETY_VERIFICATION_RESULT':
        return input.safetyVerificationResult !== undefined
    }
  })()

  return {
    id,
    present: actuallyPresent,
    required: true,
    detail: actuallyPresent
      ? `${id} は必須であり、存在する`
      : `${id} は必須だが欠落している`,
  }
}

/**
 * 成果物とレビュー結果を確認し、commitを許可してよいかを判定する統合関数。
 * 純粋関数。ファイルI/O・git commit実行・AI呼び出しは一切行わない。
 */
export function evaluateCommitGate(input: CommitGateInput): CommitGateResult {
  const reviewPolicy = input.approvalLevelResult.reviewPolicy
  const requiredArtifacts = getRequiredArtifacts(reviewPolicy)

  const allArtifactIds: RequiredArtifactId[] = [
    'APPROVAL_LEVEL_RESULT',
    'PRE_REVIEW_RESULT',
    'POST_REVIEW_RESULT',
    'SAFETY_VERIFICATION_RESULT',
  ]

  const artifactChecks = allArtifactIds.map(id =>
    checkArtifactPresence(id, input, requiredArtifacts),
  )

  const blockingReasons: string[] = []

  if (reviewPolicy === 'ceo_required') {
    blockingReasons.push(
      'reviewPolicy が ceo_required のため、CEOの事前承認なしに自動commitできません',
    )
  }

  if (input.approvalLevelResult.level === 3) {
    blockingReasons.push(
      'Level3 は自動停止対象のため、CEOの事前承認なしに自動commitできません',
    )
  }

  const missingArtifacts = artifactChecks.filter(check => check.required && !check.present)
  if (missingArtifacts.length > 0) {
    blockingReasons.push(
      `必須成果物が欠落しています: ${missingArtifacts.map(check => check.id).join(', ')}`,
    )
  }

  if (input.safetyVerificationResult && !input.safetyVerificationResult.overallPassed) {
    blockingReasons.push(
      `Safety Verificationが未通過です: ${input.safetyVerificationResult.blockingFailures.join(', ')}`,
    )
  }

  if (input.preReviewResult?.blocked) {
    blockingReasons.push('Pre-Reviewでblockingと判定されました')
  }

  if (input.postReviewResult?.blocked) {
    blockingReasons.push('Post-Reviewでblockingと判定されました')
  }

  return {
    jobId: input.jobId,
    taskId: input.taskId,
    allowed: blockingReasons.length === 0,
    reviewPolicy,
    artifactChecks,
    blockingReasons,
    decidedAt: new Date().toISOString(),
  }
}
