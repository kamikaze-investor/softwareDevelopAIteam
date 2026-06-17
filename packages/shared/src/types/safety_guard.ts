/**
 * Safety Guard — 共有型定義
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * AI開発チームの安全運用ガードシステムの型定義。
 * Policy Guard / Change Impact Analyzer / Alignment Check / Execution Log / Gate の共通型。
 */

// ────────────────────────────────────────────────────────────
// Risk Level
// ────────────────────────────────────────────────────────────

/**
 * 変更のリスクレベル
 *
 * LOW      : 文言修正・README・軽微UIなど → 自動継続
 * MEDIUM   : 通常機能追加・小規模リファクタ → 軽量レビュー後に自動継続
 * HIGH     : 認証・DB・依存追加・Worker・Sandbox・外部API → Deep Review必須
 * CRITICAL : Goal変更・承認フロー変更・権限変更・本番公開・個人情報 → CEO承認必須
 */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

// ────────────────────────────────────────────────────────────
// Gate Decision
// ────────────────────────────────────────────────────────────

export type GateDecision = 'ALLOW' | 'DEEP_REVIEW' | 'BLOCK_CEO_REQUIRED'

// ────────────────────────────────────────────────────────────
// Dangerous Hit
// ────────────────────────────────────────────────────────────

/** 危険キーワード / 危険ファイルの検出結果 */
export interface DangerousHit {
  /** 検出種別 */
  type: 'keyword' | 'file'
  /** 検出した語またはファイル名 */
  value: string
  /** 検出箇所（ファイルパスまたは "diff:+N行付近"） */
  location: string
}

// ────────────────────────────────────────────────────────────
// Diff Summary
// ────────────────────────────────────────────────────────────

export interface FileDiffSummary {
  file: string
  added: number
  removed: number
}

// ────────────────────────────────────────────────────────────
// Audit Report（Policy Guard + Impact Analyzer の出力）
// ────────────────────────────────────────────────────────────

export interface AuditReport {
  /** 監査対象のコミットハッシュまたは識別子 */
  ref: string
  /** 変更ファイル一覧 */
  changedFiles: string[]
  /** ファイルごとの追加/削除行数 */
  diffSummary: FileDiffSummary[]
  /** 危険ファイル・危険キーワードのヒット一覧 */
  dangerousHits: DangerousHit[]
  /** 算出されたリスクレベル */
  riskLevel: RiskLevel
  /** Gate判定 */
  gateDecision: GateDecision
  /** Block/要承認の場合の理由 */
  blockedReason?: string
  /** 監査実行日時（ISO 8601） */
  auditedAt: string
}

// ────────────────────────────────────────────────────────────
// Alignment Report（Gemini による設計思想整合性チェック）
// ────────────────────────────────────────────────────────────

export interface AlignmentIssue {
  severity: 'critical' | 'warning' | 'info'
  /** 問題の種別 */
  category:
    | 'role_change'         // AIの責任分担変更
    | 'approval_bypass'     // 承認フロー省略
    | 'philosophy_drift'    // Design Philosophy違反
    | 'human_work_increase' // 人間作業増加
    | 'ai_approval_misuse'  // AI発言を人間承認として扱う
    | 'other'
  description: string
  evidence: string          // diff中の根拠テキスト
}

export interface AlignmentReport {
  ref: string
  aligned: boolean          // false = 設計思想からズレあり
  issues: AlignmentIssue[]
  summary: string
  auditedAt: string
}

// ────────────────────────────────────────────────────────────
// Execution Log（AI実行の監査ログ）
// ────────────────────────────────────────────────────────────

export interface ExecutionLog {
  id: string
  jobId: string
  taskId: string
  /** 実行したAI */
  executor: string
  /** 実行コマンド（sanitized） */
  command: string
  workingDir: string
  startedAt: string
  finishedAt: string
  exitCode: number
  stdout: string
  stderr: string
  changedFiles: string[]
  gitDiffSummary: FileDiffSummary[]
  commitHash?: string
  auditReport?: AuditReport
  alignmentReport?: AlignmentReport
  createdAt: string
}
