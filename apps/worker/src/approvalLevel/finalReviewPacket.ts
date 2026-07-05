/**
 * Final Review Packet — 既存レビュー結果・安全確認・報告を1つにまとめる「受け皿」。
 *
 * 注意（設計原則。詳細は docs/multi_ai_step_review_flow.md 9章）:
 * - これは新しい判断者・新しいレビュー機構ではない。
 * - 既存のSafety Gate層（Mechanical Safety Checks / Risk Scan / commitGate等）や
 *   Gemini/ChatGPTレビューの結果を"集約して表示する"だけであり、
 *   本モジュール自身がリスク判定・コミット可否判定・自動停止を行うことは一切ない。
 * - jobRunnerへの接続、commitGateの挙動変更、Gemini pre/postレビューの自動接続、
 *   ChatGPT自動呼び出し、Report Translationの実行は本モジュールの範囲外（Step R3/R5/R6）。
 * - ReviewLevel（0-3）は本仕様書11-1章の「実行ルーティング」概念であり、
 *   既存の ApprovalLevel（packages/shared、control repo基準のMechanical Gate分類）や
 *   RiskScanSeverity（Low/Medium/High）とは別役割として扱う。値を混同しないこと。
 */

/** Review Orchestration層の実行ルーティングLevel（11-1章）。ApprovalLevelとは別概念。 */
export type ReviewLevel = 0 | 1 | 2 | 3

/**
 * 未実行・未接続の項目を空欄にせず状態として明示するためのステータス。
 *   not_run      : 今回は実行しなかった（実行条件を満たさなかった等）
 *   not_required : このケースでは元々不要（reviewPolicy等により対象外）
 *   pending      : 実行待ち・結果待ち
 *   done         : 実行済み・結果あり
 */
export type ReviewItemStatus = 'not_run' | 'not_required' | 'pending' | 'done'

/** Packet全体の結論。 */
export type PacketConclusion =
  | 'commit_ok'
  | 'needs_fix_and_rereview'
  | 'pending_judgement'
  | 'stop'

export type SafetyChecklistItemId =
  | 'DB_CHANGE'
  | 'AUTH_PERMISSION_CHANGE'
  | 'SECURITY_CHANGE'
  | 'EXTERNAL_SERVICE_ADDED'
  | 'BILLING_IMPACT'
  | 'PRODUCTION_IMPACT'
  | 'PACKAGE_LOCKFILE_CHANGE'
  | 'BREAKING_CHANGE'

export interface SafetyChecklistItem {
  id: SafetyChecklistItemId
  /** 該当する変更が含まれるか */
  present: boolean
  /** 該当する場合の概要。含まれない場合も「なし」等の説明を入れる */
  detail: string
}

export type VerificationKind = 'test' | 'typecheck' | 'build' | 'lint'

export interface VerificationItem {
  kind: VerificationKind
  status: ReviewItemStatus
  /** 結果概要。not_run/not_requiredの場合はその理由 */
  detail: string
}

export type GeminiReviewKind =
  | 'risk_review'
  | 'alignment_review'
  | 'meta_review'
  | 'pre_review'
  | 'post_review'
  /**
   * Gemini Flash Stepレビュー（Step R3・stepReview.ts）。停止権限を持たない一次判定であり、
   * 'pre_review'/'post_review'（既存preReviewer/postReviewer、blocked概念あり）とは別物。
   */
  | 'step_review'

export interface GeminiReviewItem {
  kind: GeminiReviewKind
  status: ReviewItemStatus
  /** 結果概要。not_run/not_requiredの場合はその理由 */
  summary: string
}

export interface ChatGptReviewNeed {
  needed: boolean
  reason: string
}

export interface HumanCeoJudgementNeed {
  needed: boolean
  reason: string
}

/**
 * Final Review Packetの入力。
 * 自然文の項目（whatWasDone等）は実装担当AI（Claude/Codex）が記述する。
 * 機械的に判定済みの値（reviewLevel/safetyChecklist/verificationResults/
 * geminiReviewResults等）は既存のSafety Gate層・レビュー結果をそのまま渡す。
 */
export interface FinalReviewPacketInput {
  jobId: string
  taskId: string
  /** 1. 今回やったこと */
  whatWasDone: string
  /** 2. なぜ必要だったか */
  whyNeeded: string
  /** 3. どこまで変えたか */
  scope: string
  /** 4. 変えていない重要部分 */
  notChanged: string
  /** 5. Review Level 0-3（11-1章のルーティングをそのまま転記。ここで再判定しない） */
  reviewLevel: ReviewLevel
  /** 6. 安全面チェック（8項目） */
  safetyChecklist: SafetyChecklistItem[]
  /** 7. 検証結果（test/typecheck/build/lint） */
  verificationResults: VerificationItem[]
  /** 8. Geminiレビュー結果（用途別） */
  geminiReviewResults: GeminiReviewItem[]
  /** 9. ChatGPTレビューが必要か */
  chatGptReviewNeeded: ChatGptReviewNeed
  /** 10. Human / CEO判断が必要か */
  humanCeoJudgementNeeded: HumanCeoJudgementNeed
  /** 11 / 結論. コミットしてよいか */
  conclusion: PacketConclusion
  /** 12. 対象ファイル */
  targetFiles: string[]
  /** 13. コミットメッセージ案 */
  commitMessageDraft: string
  /** 14. 未追跡ファイル・対象外ファイルの扱い */
  untrackedFilesHandling: string
  /** 15. 次にやるべき最小アクション */
  nextMinimalAction: string
}

export interface FinalReviewPacket extends FinalReviewPacketInput {
  generatedAt: string
}

/**
 * Final Review Packetを生成する（純粋関数）。
 * 入力をそのまま集約するだけであり、ここでリスク判定・コミット可否判定は行わない。
 */
export function generateFinalReviewPacket(input: FinalReviewPacketInput): FinalReviewPacket {
  return {
    ...input,
    generatedAt: new Date().toISOString(),
  }
}

const CONCLUSION_LABEL: Record<PacketConclusion, string> = {
  commit_ok: 'このままコミットして問題ありません',
  needs_fix_and_rereview: '修正後に再レビューが必要です',
  pending_judgement: '判断が保留されています',
  stop: '危険なため停止すべきです',
}

const SAFETY_CHECKLIST_LABEL: Record<SafetyChecklistItemId, string> = {
  DB_CHANGE: 'DB変更',
  AUTH_PERMISSION_CHANGE: '認証・権限変更',
  SECURITY_CHANGE: 'セキュリティ変更',
  EXTERNAL_SERVICE_ADDED: '外部サービス追加',
  BILLING_IMPACT: '課金影響',
  PRODUCTION_IMPACT: '本番環境影響',
  PACKAGE_LOCKFILE_CHANGE: 'package.json / lockfile変更',
  BREAKING_CHANGE: '破壊的変更',
}

const VERIFICATION_LABEL: Record<VerificationKind, string> = {
  test: 'test',
  typecheck: 'typecheck',
  build: 'build',
  lint: 'lint',
}

const GEMINI_REVIEW_LABEL: Record<GeminiReviewKind, string> = {
  risk_review: 'Risk Review',
  alignment_review: 'Alignment Review',
  meta_review: 'Meta Review',
  pre_review: 'preReview',
  post_review: 'postReview',
  step_review: 'Gemini Flash Stepレビュー',
}

const REVIEW_ITEM_STATUS_LABEL: Record<ReviewItemStatus, string> = {
  not_run: '未実行',
  not_required: '不要（対象外）',
  pending: '実行待ち',
  done: '実行済み',
}

/**
 * Final Review Packetを、非エンジニアが読んで判断できるMarkdown形式に整形する（純粋関数）。
 * 結論を先頭に出し、技術ログをそのまま貼らない方針（仕様書9章）に従う。
 * ここで生成した文字列をGemini Flash（Report Translation）へさらに渡す運用を想定するが、
 * この関数自体はGemini呼び出しを行わない。
 */
export function formatFinalReviewPacketMarkdown(packet: FinalReviewPacket): string {
  const lines: string[] = []

  lines.push('# Final Review Packet')
  lines.push('')
  lines.push('## 結論')
  lines.push(`- コミットしてよいか: ${CONCLUSION_LABEL[packet.conclusion]}`)
  lines.push(
    `- ChatGPTレビューが必要か: ${packet.chatGptReviewNeeded.needed ? '要' : '不要'}（${packet.chatGptReviewNeeded.reason}）`,
  )
  lines.push(
    `- Human / CEO判断が必要か: ${packet.humanCeoJudgementNeeded.needed ? '要' : '不要'}（${packet.humanCeoJudgementNeeded.reason}）`,
  )
  lines.push('')

  lines.push('## 1. 今回やったこと')
  lines.push(packet.whatWasDone)
  lines.push('')
  lines.push('## 2. なぜ必要だったか')
  lines.push(packet.whyNeeded)
  lines.push('')
  lines.push('## 3. どこまで変えたか')
  lines.push(packet.scope)
  lines.push('')
  lines.push('## 4. 変えていない重要部分')
  lines.push(packet.notChanged)
  lines.push('')

  lines.push('## 5. Review Level')
  lines.push(`Level ${packet.reviewLevel}`)
  lines.push('')

  lines.push('## 6. 安全面チェック')
  for (const item of packet.safetyChecklist) {
    lines.push(`- ${SAFETY_CHECKLIST_LABEL[item.id]}: ${item.present ? 'あり' : 'なし'} — ${item.detail}`)
  }
  lines.push('')

  lines.push('## 7. 検証結果')
  for (const item of packet.verificationResults) {
    lines.push(`- ${VERIFICATION_LABEL[item.kind]}: ${REVIEW_ITEM_STATUS_LABEL[item.status]} — ${item.detail}`)
  }
  lines.push('')

  lines.push('## 8. Geminiレビュー結果')
  for (const item of packet.geminiReviewResults) {
    lines.push(`- ${GEMINI_REVIEW_LABEL[item.kind]}: ${REVIEW_ITEM_STATUS_LABEL[item.status]} — ${item.summary}`)
  }
  lines.push('')

  lines.push('## 9. ChatGPTレビューが必要か')
  lines.push(`${packet.chatGptReviewNeeded.needed ? '要' : '不要'} — ${packet.chatGptReviewNeeded.reason}`)
  lines.push('')

  lines.push('## 10. Human / CEO判断が必要か')
  lines.push(`${packet.humanCeoJudgementNeeded.needed ? '要' : '不要'} — ${packet.humanCeoJudgementNeeded.reason}`)
  lines.push('')

  lines.push('## 11. コミットしてよいか')
  lines.push(CONCLUSION_LABEL[packet.conclusion])
  lines.push('')

  lines.push('## 12. 対象ファイル')
  for (const file of packet.targetFiles) {
    lines.push(`- ${file}`)
  }
  lines.push('')

  lines.push('## 13. コミットメッセージ案')
  lines.push(packet.commitMessageDraft)
  lines.push('')

  lines.push('## 14. 未追跡ファイル・対象外ファイルの扱い')
  lines.push(packet.untrackedFilesHandling)
  lines.push('')

  lines.push('## 15. 次にやるべき最小アクション')
  lines.push(packet.nextMinimalAction)

  return lines.join('\n')
}
