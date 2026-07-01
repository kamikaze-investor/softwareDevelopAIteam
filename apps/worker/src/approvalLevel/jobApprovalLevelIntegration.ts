import type { ApprovalLevelResult } from '@ai-team/shared'
import { determineApprovalLevel } from '@ai-team/shared'

/**
 * jobRunner.ts が Approval Level 判定に必要な入力を渡すための型。
 * jobRunner.ts はこの型に合わせて既存の情報（Approval Gateで既に取得済みの
 * changedFiles/diffText等）を詰め替えて渡すだけでよい設計にする。
 */
export interface JobApprovalLevelInput {
  jobId: string
  taskId: string
  /** Approval Gate（Step3A）で既に取得済みの preChangedFiles をそのまま渡す想定 */
  changedFiles: string[]
  /** Approval Gate（Step3A）で既に取得済みの preDiffText をそのまま渡す想定 */
  diffText: string
  /**
   * タスク種別のヒント（省略可）。
   * 現状のJob型にはtaskKind相当のフィールドが存在しないため、
   * jobRunner.ts が呼び出す際は未指定(undefined)で渡すことになる。
   * 将来Job型にtaskKindが追加された場合にそのまま渡せるよう、
   * 型としては先行して用意しておく。
   */
  taskKind?: string
}

/**
 * jobRunner.ts から Approval Level 判定を呼び出すための薄いラッパー。
 *
 * このヘルパーは以下を一切行わない:
 *   - blocking判定（呼び出し元に判断を委ねる。ここではapprovalLevelResultを返すのみ）
 *   - ファイルI/O（保存処理は行わない）
 *   - AIレビュー呼び出し（preReviewer/postReviewerは呼ばない）
 *   - safetyVerification / commitGate 呼び出し
 *
 * determineApprovalLevel() をそのまま呼び出すだけの薄い層。
 * ロジックの分岐・追加判断をここに持ち込まないこと
 * （将来のStep6-B/Cでの拡張時に責務が曖昧になるため）。
 */
export function evaluateJobApprovalLevel(
  input: JobApprovalLevelInput,
): ApprovalLevelResult {
  return determineApprovalLevel(
    input.jobId,
    input.taskId,
    input.changedFiles,
    input.diffText,
    input.taskKind,
  )
}
