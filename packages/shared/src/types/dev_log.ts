/**
 * 開発ログ機能 — 共有型定義
 *
 * ADR-0001 に基づく「意思決定の系譜」を追跡するための型群。
 * 相談ログ / 開発セッション / 実装ログ / Review Packet / レビュー結果 を一本に繋ぐ。
 */

// ────────────────────────────────────────────────────────────
// 共通
// ────────────────────────────────────────────────────────────

export type DevLogStatus = 'draft' | 'approved' | 'committed' | 'archived'
export type ExternalAiSource = 'chatgpt' | 'claude' | 'gemini' | 'codex' | 'manual'
export type AiAgentKind = 'claude_code' | 'codex' | 'gemini' | 'chatgpt' | 'worker' | 'manual'

export type ReviewVerdict = 'approve' | 'revise' | 'split' | 'reject' | 'unknown'

export type ReviewPacketTrigger =
  | 'free_limit'
  | 'control_layer_change'
  | 'meta_review_failed'
  | 'test_failed'
  | 'scope_change'
  | 'ceo_decision_required'
  | 'unknown'

export type PostLintStatus = 'not_run' | 'passed' | 'failed_non_fatal'

// ────────────────────────────────────────────────────────────
// Consultation Log — 相談ログ（外部AI壁打ちの構造化要約）
// ────────────────────────────────────────────────────────────

export interface ConsultationLog {
  /** consult-YYYYMMDD-NNN */
  id: string
  projectId: string
  title: string

  source: ExternalAiSource
  /** アプリへの貼り付け日時 */
  pastedAt: string
  /** 相談を実際に開始した日時（任意） */
  sourceStartedAt?: string
  /** 相談を終了した日時（任意） */
  sourceEndedAt?: string

  /** Raw Conversation Log のファイルパス（logs/conversations/ 以下、Git管理外） */
  rawTextPath?: string

  summary: string
  decisions: string[]
  rejectedIdeas: string[]
  proposedTasks: string[]
  risks: string[]
  nextActions: string[]

  relatedDevSessionIds: string[]
  relatedReviewPacketIds: string[]
  relatedCommitHashes: string[]
  relatedFiles: string[]

  status: 'draft' | 'linked' | 'approved' | 'archived'
  createdAt: string
  updatedAt: string
}

// ────────────────────────────────────────────────────────────
// Development Log — 開発セッションログ
// ────────────────────────────────────────────────────────────

export interface DevelopmentLog {
  /** dev-YYYYMMDD-<slug> */
  id: string
  projectId: string
  title: string

  consultationIds: string[]
  reviewPacketIds: string[]

  startedAt: string
  endedAt?: string

  aiAgents: AiAgentKind[]
  goal: string
  summary: string

  changedFiles: string[]
  commits: string[]
  commandsRun: string[]
  testResults: string[]
  metaReviewResult?: string

  decisions: string[]
  risks: string[]
  nextActions: string[]

  status: DevLogStatus
  createdAt: string
  updatedAt: string
}

// ────────────────────────────────────────────────────────────
// Implementation Log — AI実行1回分の詳細ログ
// ────────────────────────────────────────────────────────────

export interface ImplementationLog {
  /** impl-YYYYMMDD-<commitHash> */
  id: string
  projectId: string
  devSessionId: string
  consultationIds: string[]

  agent: AiAgentKind
  commandKind: string

  startedAt: string
  endedAt?: string

  workingDir: string
  changedFiles: string[]

  /** stdout の保存パス（logs/implementation/ 以下、Git管理外） */
  stdoutPath?: string
  stderrPath?: string

  exitCode?: number
  blocked?: boolean
  blockReason?: string

  postLintStatus?: PostLintStatus
  fileChangeGuardResult?: string
  safetyAuditResult?: string

  relatedCommits: string[]
  createdAt: string
}

// ────────────────────────────────────────────────────────────
// Review Packet — 外部AIレビュー用パケット
// ────────────────────────────────────────────────────────────

export interface ReviewPacket {
  /** rp-YYYYMMDD-NNN */
  id: string
  projectId: string
  consultationIds: string[]
  devSessionId?: string

  createdAt: string
  trigger: ReviewPacketTrigger

  currentContext: string
  proposedChange: string
  recentCommits: string[]
  changedFiles: string[]
  testResults: string[]
  metaReviewResult?: string

  /** ChatGPTなど外部AIへの質問リスト */
  questions: string[]
  /** そのままChatGPTに貼れる形式のプロンプト全文 */
  promptText: string

  status: 'draft' | 'copied' | 'review_imported' | 'resolved' | 'archived'
  updatedAt: string
}

// ────────────────────────────────────────────────────────────
// Review Result — 外部AIレビュー結果（貼り戻し後の構造化）
// ────────────────────────────────────────────────────────────

export interface ExternalReviewResult {
  id: string
  reviewPacketId: string
  projectId: string

  source: ExternalAiSource
  pastedAt: string

  verdict: ReviewVerdict
  reasoning: string
  risks: string[]
  requiredTests: string[]
  saferAlternative?: string
  /** Claude Code への再開指示文 */
  nextInstructionForClaude?: string

  acceptedItems: string[]
  rejectedItems: string[]

  status: 'draft' | 'approved' | 'applied' | 'archived'
  createdAt: string
}
