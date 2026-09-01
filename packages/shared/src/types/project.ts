// Project型定義

export type ProjectStatus = 'draft' | 'running' | 'paused' | 'archived'

export interface Project {
  id: string
  name: string
  goal: string
  designPhilosophy: string[]
  status: ProjectStatus
  createdAt: string
  updatedAt: string
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
