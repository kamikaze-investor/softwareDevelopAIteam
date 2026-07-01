/** 承認レベル: 0=自動 / 1=別AIレビュー後自動 / 2=前後レビュー必須 / 3=CEO事前承認必須（自動停止） */
export type ApprovalLevel = 0 | 1 | 2 | 3

export interface MechanicalGatePattern {
  /** Mechanical Gateルールを識別する安定ID。 */
  id: string
  /** レビュー結果やログに表示するルール名。 */
  label: string
  /** ファイルパスに適用するか、diff本文に適用するかを示す種別。 */
  type: 'file' | 'diff'
  /** ファイルパスまたはdiff本文に対して評価する正規表現。 */
  pattern: RegExp
  /** ルールがLevel3固定対象になる理由。 */
  reason: string
}

export interface MechanicalGateHit {
  /** マッチしたMechanical GateルールのID。 */
  patternId: string
  /** マッチしたMechanical Gateルールの表示名。 */
  label: string
  /** マッチしたルールがLevel3固定対象になる理由。 */
  reason: string
  /** 実際にマッチしたファイルパスまたはdiff行。 */
  matched: string
}

export interface MechanicalGateResult {
  /** Mechanical Gateルールが1件以上発火したかどうか。 */
  triggered: boolean
  /** 発火したMechanical Gateルールの詳細一覧。 */
  hits: MechanicalGateHit[]
}

export interface ClassifierInput {
  /** git diffなどから得た変更ファイルパス一覧。 */
  changedFiles: string[]
  /** 判定対象のdiff本文。 */
  diffText: string
  /** Workerが把握しているタスク種別。 */
  taskKind?: string
  /** jobRunner.tsに関係する変更が含まれるかどうか。 */
  jobRunnerTouched: boolean
  /** AI CLI関連パスに関係する変更が含まれるかどうか。 */
  aiCliPathTouched: boolean
  /** Context PackやAI指示文などのコンテキスト関連ファイルに関係する変更が含まれるかどうか。 */
  contextFilesTouched: boolean
}

export interface ClassifierReason {
  /** 採用された判定ルール名。 */
  rule: string
  /** ルール判定の主対象になったファイルパス。 */
  file?: string
  /** 判定理由の説明。 */
  detail: string
}

export interface ClassifierResult {
  /** Rule-based Classifierが判定した承認レベル。 */
  level: ApprovalLevel
  /** 判定の信頼度。0.0から1.0までの値。 */
  confidence: number
  /** 承認レベルを決めた理由の一覧。 */
  reasons: ClassifierReason[]
  /** 追加レビューまたは人間確認へ昇格すべきかどうか。 */
  needsEscalation: boolean
  /** 昇格が必要な場合の理由。 */
  escalationReason?: string
}

export interface ApprovalLevelResult {
  /** 判定対象のJob ID。 */
  jobId: string
  /** 判定対象のTask ID。 */
  taskId: string
  /** 最終決定された承認レベル。 */
  level: ApprovalLevel
  /** 最終判定の信頼度。0.0から1.0までの値。 */
  confidence: number
  /** Mechanical Gateの判定結果。 */
  mechanicalGate: MechanicalGateResult
  /** Rule-based Classifierの判定結果。 */
  classifierResult: ClassifierResult
  /** 最終判定理由の一行サマリー。 */
  finalReason: string
  /** 判定を行った日時。ISO 8601形式。 */
  decidedAt: string
  /**
   * ChatGPT レビューへの昇格対象かどうか。
   * MVPではChatGPT API未接続のため、このフラグは実際のAPI呼び出しを意味しない。
   * 将来のCost-aware Review RouterでChatGPTレビューへ昇格するための判定フラグ。
   */
  requiresChatGptReview: boolean
}
