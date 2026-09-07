// Project型定義

export type ProjectStatus = 'draft' | 'running' | 'paused' | 'archived'

/**
 * Project開始workflowの進行段階。**Provider名ではなくsemantic stage**で表す
 * （Providerを差し替えてもMobileの表示契約が変わらないようにするため）。
 *
 * Mobileはこの値を読んで表示するだけのthin clientであり、GETはProject-start workflowを
 * 進行させない（Task continuationについてはGET側に既存の副作用が残っている）。
 * 実処理はVPS側でclient connectionと独立して進み、stageだけが永続化される。
 *
 * 終端は`completed`と`blocked`の2つ。`blocked`はCEO判断待ちを含む安全停止であり、
 * **自動では再開しない**（fail-closed）。それ以外は中断された進行中stageとみなし、
 * API起動時のrecoveryが再kickする対象になる。
 */
export type ProjectStartStage =
  | 'project_definition'
  | 'roadmap_generation'
  | 'deterministic_validation'
  | 'focused_review'
  | 'feasibility_review'
  | 'integration_review'
  | 'roadmap_regeneration'
  | 'task_sync'
  | 'completed'
  | 'blocked'

/** 自動再開してはいけない終端stage。 */
export const TERMINAL_PROJECT_START_STAGES: readonly ProjectStartStage[] = ['completed', 'blocked']

export function isTerminalProjectStartStage(stage: ProjectStartStage | undefined): boolean {
  return stage !== undefined && TERMINAL_PROJECT_START_STAGES.includes(stage)
}

export interface Project {
  id: string
  name: string
  goal: string
  designPhilosophy: string[]
  status: ProjectStatus
  createdAt: string
  updatedAt: string
  /** Project開始workflowの現在段階。開始要求を受理した時点で初めて設定される。 */
  startStage?: ProjectStartStage
  startStageUpdatedAt?: string
  /** `blocked`のとき、なぜ止まったか（CEOへ提示する理由）。 */
  startBlockedReason?: string
}

/**
 * 現行ロードマップTaskから導出するProject完了状況。
 * ProjectStatusを増やさず、roadmapActiveなTaskだけを対象にする。
 */
export interface ProjectRoadmapCompletion {
  completedTaskCount: number
  isComplete: boolean
  totalTaskCount: number
}

export interface ProjectSummary {
  project: Pick<Project, 'id' | 'name' | 'goal' | 'designPhilosophy' | 'status'>
  progress: number          // 0-100
  currentWork: string[]
  nextWork: string[]
  risks: Risk[]
  openDecisions: Decision[]
  pendingApprovals: Approval[]
  healthScore: number       // 0-100
}

export interface Risk {
  id: string
  title: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  description: string
}

export interface Decision {
  id: string
  title: string
  status: 'ai_thinking' | 'ai_decided' | 'needs_ceo'
  description: string
}

/**
 * 承認タイプ
 * dependency_add追加: npm install/pnpm addはYellow Zone
 * レビュー指摘(2026-05-28): 外部依存追加はセキュリティ・ライセンス・サプライチェーンリスク
 */
export type ApprovalType =
  | 'goal_change'
  | 'philosophy_change'
  | 'external_service'
  | 'billing'
  | 'deployment'
  | 'security'
  | 'dependency_add'  // npm/pnpm add <package> はCEO承認必須

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface Approval {
  id: string
  title: string
  reason: string
  type: ApprovalType
  // レビュー指摘(2026-05-28): CEOの承認・却下状態を追跡するため追加
  status: ApprovalStatus
  reviewedAt?: string
  reviewNote?: string
  createdAt: string
}

/**
 * Gap Analysis（roadmap item interactive-project-definition-readiness）が検出する不足情報。
 * API（`apps/api/src/ctoAi/specAnalyzer.ts`のZod schemaがこの形を実装・検証する）と
 * Mobile UI（`apps/mobile/app/projects/gaps.tsx`等）の双方で使うため、ここに置く
 * （Meta Reviewer指摘、2026-09-01: 以前はMobile側で同じ形を`ProjectDefinitionGap`として
 * 個別に宣言していた）。
 */
export interface Gap {
  category: 'business' | 'technical' | 'data' | 'cost' | 'legal' | 'other'
  description: string
  severity: 'must_resolve' | 'should_resolve' | 'optional'
  suggestion: string
  /**
   * この不足情報を**誰が解決できるか**。`category`（主題）や`severity`（重要度）とは
   * 別の軸で、CEOへ質問すべきかどうかはこの値だけで決まる。
   *
   * - `'ceo'`: CEOにしか決められないsemantic decision（Goalの意図・期待する最終挙動・
   *   許容/非許容・優先順位・Design Philosophy・policy/risk tradeoff）。
   * - `'ai'`: 既存のrepo/spec/testをread-onlyで調査すれば答えが決まる技術的不確実性
   *   （内部データ構造・API形状・挿入箇所・実装手法・test戦略など）。
   *
   * 省略時は`'ceo'`として扱う（fail-closed）。owner軸を持たない旧形式の応答や、
   * 判定できなかった応答でCEOへの質問を落とすより、ノイズを許容する方が安全なため。
   */
  decisionOwner?: 'ceo' | 'ai'
}

/**
 * Natural-language Project DefinitionからAIが機械的に抽出する構造化制約
 * （roadmap item interactive-project-definition-readiness）。
 * API（`specAnalyzer.ts`のZod schema）・Roadmap生成プロンプト・Project Memory
 * （`project_definition.json`）で共通して使うため、ここに置く。
 */
export interface StructuredConstraint {
  kind:
    | 'max_task_count'
    | 'allowed_path_prefixes'
    | 'forbidden_new_files'
    | 'max_dependency_count'
    | 'forbidden_technologies'
    | 'other'
  value: string | number | string[] | boolean
  description: string
  sourceText: string
}
