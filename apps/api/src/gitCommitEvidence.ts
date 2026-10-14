/**
 * git_commit の Safety Evidence 検証（Decision Authority Principle Stage 1）。
 *
 * `specs/22_safety_approval_design_principle.md` 1章（2026-10-02 CEO 承認）に基づき、
 * **次の Evidence がすべて成立する LOW / MEDIUM の git_commit だけ**を、人間承認なしで
 * 通してよい。それ以外は既存の ApprovalRequest（人間承認）へ fail closed で送る。
 *
 * ## これは「承認」ではない
 *
 * AI の発言は人間承認として扱わない（`docs/project_memory/rules/approval_rules.md`）。
 * ここで行うのは、**API が自分で読んだ事実だけ**を決定的なコードで照合することであり、
 * ApprovalRequest を APPROVED にはしない。結果は承認とは別の記録として audit に残す。
 *
 * ## exact provenance（推測しない）
 *
 * 「Task の最新 review」「最新 ALLOW」のような探索はしない。次の 1 本の鎖だけを辿る:
 *
 * ```text
 * implement Job（success / exitCode 0 / Design Review ALIGNED）
 *   → implement:<implId>:review の review Job（resume 段なし）
 *   → その review Job 自身の gate_evaluations（ALLOW / authoritative）= review 開始時の exact diff
 *   → その review Job の review result（approved / high・critical finding なし）
 *   → review:<reviewJobId>:git-commit の git_commit Job（今 commit しようとしている diff と全一致）
 * ```
 *
 * ## 判定理由の区別
 *
 * - `insufficient_safety_evidence` … Evidence が欠けている、または Safety の方向（強化か弱化か）を
 *   機械判定できないため fail closed した。**「人間の判断事項だと判定した」のではない**
 * - `human_decision_authority` … 事実から Human Decision Authority と判定した。
 *   **Stage 1 にはこれを事実から確定できる判定器が無いため、この値は出さない**
 *   （ファイルパスや Risk Level だけでは Human Decision Authority は決まらない。spec 22 1-2）
 *
 * HIGH / CRITICAL・Mechanical Gate 該当は Stage 1 では自動通過の対象外だが、
 * それは「HIGH だから人間判断」なのではなく「Safety 方向を判定する Evidence が無い」からである。
 */

import type { ApprovalRequest, Job, RiskReviewResult, Task } from '@ai-team/shared'
import { resolveEffectiveStatus, runMechanicalGate } from '@ai-team/shared'
import {
  buildRuntimeTaskPolicy,
  fileChangeGuard,
} from '@ai-team/worker/src/guards/fileChangeGuard.js'
import type { ChangeManifest, EntryType, FileChange } from '@ai-team/worker/src/guards/changeManifest.js'
import type { ChangeManifestEntry } from './approvalExplain/changeManifestIdentity'
import { checkImplementJobDesignReviewEvidence } from './designReviewEvidencePolicy'
import { resolveReviewedImplementation } from './designReview/repairFlow'
import type { IStorage } from './storage/interface'

export type GitCommitHumanGateReason = 'human_decision_authority' | 'insufficient_safety_evidence'

/** 不成立だった Evidence の識別子。audit に載せる短いコード（秘密情報・diff 本文を含めない）。 */
export type GitCommitEvidenceFailure =
  | 'human_approval_already_requested'
  | 'not_candidate_workspace'
  | 'same_diff_rejected'
  | 'binding_not_authoritative'
  | 'manifest_unavailable'
  | 'empty_change'
  | 'declared_files_mismatch'
  | 'risk_level_not_low_or_medium'
  | 'secret_scan_hit'
  | 'mechanical_gate_hit'
  | 'no_allowed_paths'
  | 'file_policy_violation'
  | 'review_lineage_unresolved'
  | 'review_job_invalid'
  | 'review_resumed'
  | 'review_result_not_unique'
  | 'review_not_approved'
  | 'review_has_high_or_critical_finding'
  | 'review_gate_evidence_not_unique'
  | 'review_gate_evidence_mismatch'
  | 'implementation_unresolved'
  | 'implementation_not_successful'
  | 'design_review_not_aligned'

export type GitCommitEvidenceResult =
  | { passed: true }
  | { passed: false; reason: GitCommitHumanGateReason; failures: GitCommitEvidenceFailure[] }

export interface GitCommitEvidenceInput {
  /** `/gate/check` が検証済みの git_commit Job（task / action の一致は呼び出し側で確認済み）。 */
  gitCommitJob: Job
  task: Task
  targetCommit: string
  targetDiffHash: string
  /** Worker が申告した changedFiles。API 自身の manifest と一致しなければ通さない。 */
  declaredChangedFiles: readonly string[]
  /** `/gate/check` が算出した Risk Review（申告 changedFiles と diffText の secret scan を反映済み）。 */
  riskReview: RiskReviewResult
  /**
   * API が実 worktree から読んだ diff 本文。`readExactApprovalDiff` が HEAD と diff hash の
   * **両方**を照合できたときだけ渡す（= bindingVerification が authoritative）。
   */
  authoritativeDiffText: string | undefined
  /** API が実 worktree から作った canonical change manifest。作れなかったら undefined。 */
  manifest: readonly ChangeManifestEntry[] | undefined
  /** その diff 本文に対する secret scan の検出件数。 */
  secretScanHitCount: number | undefined
  workingDir: string
  /** その Task の ApprovalRequest 全件（REJECTED 判定に使う。探索の意味は既存 Gate と同じ）。 */
  taskApprovalRequests: readonly ApprovalRequest[]
}

const GIT_COMMIT_STEP_KEY = /^review:([^:]+):git-commit$/

/**
 * API の canonical manifest（add / modify / delete + mode）を、Worker の File Change Guard が
 * 受け取る形へ写す。**判定ロジックは複製しない** —— ALWAYS_FORBIDDEN_PATTERNS・forbiddenPaths・
 * allowedPaths・symlink / gitlink 拒否は `fileChangeGuard()` を正本としてそのまま使う。
 *
 * rename は API manifest 上 delete + add の 2 件で現れるため、旧パス・新パスの両方が検査される。
 */
function toGuardManifest(entries: readonly ChangeManifestEntry[]): ChangeManifest {
  const changes: FileChange[] = entries.map((entry) => {
    if (entry.kind === 'delete') {
      return { path: entry.path, kind: 'deleted' }
    }
    return {
      path: entry.path,
      kind: entry.kind === 'add' ? 'added' : 'modified',
      afterType: entryTypeForMode(entry.mode),
      afterMode: entry.mode,
    }
  })
  return { changes, paths: entries.map((entry) => entry.path) }
}

function entryTypeForMode(mode: string): EntryType {
  if (mode === '100644' || mode === '100755') return 'regular'
  if (mode === '120000') return 'symlink'
  if (mode === '160000') return 'gitlink'
  return 'special'
}

function sameFileSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size !== right.size) return false
  for (const path of left) {
    if (!right.has(path)) return false
  }
  return true
}

/**
 * 同じ `requestedAction=git_commit` + targetCommit + targetDiffHash に対する REJECTED があるか。
 *
 * 既存 Gate と同じ semantics（`resolveEffectiveStatus()`）で判定する: diff が変わった REJECTED は
 * SUPERSEDED 扱いになり、**その Task を永久には汚染しない**。CEO が却下した diff を AI が修正して
 * 別 diff になった場合は、改めて Evidence で判定される。
 */
function isSameDiffRejected(
  requests: readonly ApprovalRequest[],
  targetCommit: string,
  targetDiffHash: string,
): boolean {
  return requests.some((request) =>
    request.requestedAction === 'git_commit'
    && request.status === 'REJECTED'
    && resolveEffectiveStatus(request, targetCommit, targetDiffHash) === 'REJECTED')
}

/**
 * git_commit の Safety Evidence をすべて照合する。
 *
 * 1 件目の不成立で打ち切らず、**不成立だったものをすべて**返す（audit で原因を追えるように）。
 * ただし前段が欠けて後段を評価する材料が無い場合は、後段を評価せずに止める。
 */
export function evaluateGitCommitEvidence(
  storage: IStorage,
  input: GitCommitEvidenceInput,
): GitCommitEvidenceResult {
  const failures: GitCommitEvidenceFailure[] = []
  const fail = (failure: GitCommitEvidenceFailure): void => {
    if (!failures.includes(failure)) failures.push(failure)
  }
  const result = (): GitCommitEvidenceResult =>
    failures.length === 0
      ? { passed: true }
      : { passed: false, reason: 'insufficient_safety_evidence', failures }

  const { gitCommitJob, task, targetCommit, targetDiffHash } = input

  // ── 既に人間承認の流れに入っている Job は、そのまま人間承認で終える ──
  // 待機中・承認済みの ApprovalRequest を Evidence で横から無効化しない。
  if (gitCommitJob.approvalId !== undefined) fail('human_approval_already_requested')
  // Candidate 限定（spec 22 14-3）: commit する Job の作業場所が、API が Evidence を読んだ
  // Candidate workspace そのものでなければ通さない。
  if (gitCommitJob.safeCommand.workingDir !== input.workingDir) fail('not_candidate_workspace')
  if (isSameDiffRejected(input.taskApprovalRequests, targetCommit, targetDiffHash)) fail('same_diff_rejected')

  // ── commit しようとしている diff そのもの（API 自身の読み取り） ──
  if (input.authoritativeDiffText === undefined) fail('binding_not_authoritative')
  const manifest = input.manifest
  if (manifest === undefined) {
    fail('manifest_unavailable')
  } else if (manifest.length === 0) {
    fail('empty_change')
  } else {
    const manifestPaths = manifest.map((entry) => entry.path)
    if (!sameFileSet(manifestPaths, input.declaredChangedFiles)) fail('declared_files_mismatch')

    // Safety 方向（強化か弱化か）を機械判定できない変更は fail closed（Stage 1）。
    // 分類の正本は既存の RISK_RULES / Mechanical Gate / File Change Guard である。
    if (input.riskReview.riskLevel !== 'LOW' && input.riskReview.riskLevel !== 'MEDIUM') {
      fail('risk_level_not_low_or_medium')
    }
    if (input.authoritativeDiffText !== undefined) {
      if (runMechanicalGate(manifestPaths, input.authoritativeDiffText).triggered) fail('mechanical_gate_hit')
    }
    if ((task.allowedPaths ?? []).length === 0) {
      fail('no_allowed_paths')
    } else {
      const guard = fileChangeGuard(toGuardManifest(manifest), buildRuntimeTaskPolicy(task), input.workingDir)
      if (!guard.allowed) fail('file_policy_violation')
    }
  }
  if (input.secretScanHitCount === undefined || input.secretScanHitCount > 0) fail('secret_scan_hit')

  // ── exact provenance: git_commit Job → review Job ──
  const stepMatch = GIT_COMMIT_STEP_KEY.exec(gitCommitJob.workflowStepKey ?? '')
  if (!stepMatch) {
    fail('review_lineage_unresolved')
    return result()
  }
  const reviewJob = storage.jobs.findById(stepMatch[1] as string)
  if (
    !reviewJob
    || reviewJob.taskId !== gitCommitJob.taskId
    || reviewJob.projectId !== gitCommitJob.projectId
    || reviewJob.aiCliMode !== 'review'
  ) {
    fail('review_job_invalid')
    return result()
  }

  // review result は、その review Job 自身のものが 1 件だけ
  const reviewResults = storage.reviewResults.findByTaskId(task.id).filter((r) => r.jobId === reviewJob.id)
  if (reviewResults.length !== 1) {
    fail('review_result_not_unique')
  } else {
    const review = reviewResults[0]!
    if (review.status !== 'approved') fail('review_not_approved')
    if (review.findings.some((f) => f.severity === 'high' || f.severity === 'critical')) {
      fail('review_has_high_or_critical_finding')
    }
  }

  // review 開始時の exact diff（その review Job 自身の Gate 評価だけを見る）
  const reviewEvaluations = storage.gateEvaluations.findByJobId(reviewJob.id)
  if (reviewEvaluations.length !== 1) {
    fail('review_gate_evidence_not_unique')
  } else {
    const evidence = reviewEvaluations[0]!
    if (
      evidence.decision !== 'ALLOW'
      || evidence.bindingVerification !== 'authoritative'
      || evidence.targetCommit !== targetCommit
      || evidence.targetDiffHash !== targetDiffHash
    ) {
      fail('review_gate_evidence_mismatch')
    }
  }

  // ── review Job → implement Job ──
  const reviewed = resolveReviewedImplementation(storage, reviewJob.id)
  if (!reviewed.ok) {
    fail('implementation_unresolved')
    return result()
  }
  // resume を挟んだ review は、implement 終了から review 開始までの間に worktree が変わり得る。
  // Stage 1 では対象外とする（範囲を狭める方向の制限）。
  if (reviewed.resumeHops.length > 0) fail('review_resumed')
  const implementJob = reviewed.implementJob
  if (implementJob.status !== 'success' || implementJob.exitCode !== 0) fail('implementation_not_successful')

  const designReview = checkImplementJobDesignReviewEvidence(
    { taskId: task.id, aiCliMode: implementJob.aiCliMode, aiCliPrompt: implementJob.aiCliPrompt },
    storage.designReviewEvidence,
  )
  if (!designReview.ok || designReview.evidence === undefined) fail('design_review_not_aligned')

  return result()
}
