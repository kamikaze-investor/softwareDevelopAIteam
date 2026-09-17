import type { StrategicDecision } from './meta_review.js'

/**
 * Principle 適用・判定の記録に使う型。
 *
 * **原則の本文・定義はここに無い。** 正本は Git（`specs/21_...md` の marker）であり、
 * この層が持つのは `principleId` と本文から算出した `principleVersionHash` だけである
 * （`supervised_runs` の D-2 と同じ形: 判定ロジックは DB に置かず、registry を引くキーと版だけ持つ）。
 */

/**
 * どの経路でその原則が選ばれたか。
 *
 * 集計の主要な切り口なので、自由文字列にせず閉じた集合にする。
 * - `core`: tier=core の原則。signal によらず毎回適用される
 * - `contextual`: focus（= changedFiles 由来を含む）から選ばれた
 * - `risk`: risk level から選ばれた
 * - `explicit`: 呼び出し側が明示指定した（自動選択ではない）
 */
export type PrincipleSelectionSource = 'core' | 'contextual' | 'risk' | 'explicit'

/**
 * 原則判定を行った Review 工程。
 *
 * **reviewer / provider / model / cost をこの記録へ複製しない。** それらは
 * `reviewRunId` から既存の review 側レコードを引けば分かる（CEO 指示 2026-09-17）。
 * Reviewer disagreement は「同じ subject・同じ原則に対する別 stage の判定差」で算出する。
 */
export type PrincipleReviewStage = 'design' | 'independent' | 'meta'

export const PRINCIPLE_SELECTION_SOURCES: readonly PrincipleSelectionSource[] = [
  'core',
  'contextual',
  'risk',
  'explicit',
] as const

export const PRINCIPLE_REVIEW_STAGES: readonly PrincipleReviewStage[] = [
  'design',
  'independent',
  'meta',
] as const

/**
 * Review が返す原則単位の判定。**判定語彙は `StrategicDecision` を再利用する**
 * （focus 単位の判定と同じ語彙。第二の enum を作らない）。
 */
export interface PrincipleVerdict {
  principleId: string
  verdict: StrategicDecision
  reason: string
}

/**
 * prompt へ実際に載せた原則と、その判定。
 *
 * `principleVersionHash` / `selectionSource` / `selectionReason` は**選択した側**
 * （Review runner）が埋める。Reviewer の自己申告ではないため、
 * 「promptに入っていた本文」と「記録された版」が食い違わない。
 */
export interface AppliedPrinciple extends PrincipleVerdict {
  principleVersionHash: string
  selectionSource: PrincipleSelectionSource
  selectionReason: string
}

/** `principle_applications` の 1 行。 */
export interface PrincipleApplication {
  id: string
  projectId: string
  roadmapItemId?: string
  taskId?: string
  principleId: string
  principleVersionHash: string
  selectionSource: PrincipleSelectionSource
  selectionReason: string
  reviewStage: PrincipleReviewStage
  verdict: StrategicDecision
  reviewRunId?: string
  createdAt: string
}

export type PrincipleApplicationInput = Omit<PrincipleApplication, 'id' | 'createdAt'>

/** 原則ごとの集計。rate は applications が 0 のとき 0 を返す（NaN を出さない）。 */
export interface PrincipleAggregateRow {
  principleId: string
  applications: number
  aligned: number
  conflict: number
  uncertain: number
  conflictRate: number
  uncertainRate: number
}

/**
 * Reviewer disagreement の 1 件。
 *
 * 同一 subject（task または roadmap item）・同一原則に対して、
 * **複数 stage が異なる判定を出した**ものだけが載る。
 */
export interface PrincipleDisagreementRow {
  principleId: string
  subjectKind: 'task' | 'roadmap_item' | 'project'
  subjectId: string
  verdicts: Array<{ reviewStage: PrincipleReviewStage; verdict: StrategicDecision }>
}

/**
 * 版ごとの集計。**センサーはこちらを使う。**
 * 原則本文を書き換えたら版が変わるので、旧版の実績を新版の判断根拠にしない。
 */
export interface PrincipleVersionAggregateRow extends PrincipleAggregateRow {
  principleVersionHash: string
}

export interface PrincipleAggregateQuery {
  projectId?: string
  reviewStage?: PrincipleReviewStage
}

/** センサー id。増やすときは閾値の根拠も併せて記録すること。 */
export type PrincipleSensorId =
  | 'core-principle-never-conflicts'
  | 'principle-review-not-discriminating'

/**
 * センサー発火 1 件 = 「原則そのものを再Reviewする候補」。
 *
 * **これ自体は原則を書き換えない。** 再評価を発火させるところまでが責務である（CEO 指示 2026-09-17）。
 */
export interface PrincipleSensorFinding {
  sensorId: PrincipleSensorId
  /** 特定の原則に紐づくセンサーのみ設定される。機構全体を見るセンサーでは undefined。 */
  principleId?: string
  /** 何を再評価すべきかの 1 行。 */
  summary: string
  /** 発火の根拠になった実測値。 */
  evidence: string
  /** 閾値と、その閾値がどういう根拠で決まっているか（暫定値ならそう書く）。 */
  thresholdNote: string
}
