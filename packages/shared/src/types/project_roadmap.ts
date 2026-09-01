// Project Roadmap Phase — 一般Project向けRoadmap（AIteamOS自己開発用tasks/roadmap.mdとは別物）
// generate-roadmap実行時にTaskと同一transactionでDBへ同期される、Phase単位の最小メタデータ。

export interface ProjectRoadmapPhase {
  projectId: string
  phaseNumber: number
  name: string
  goal: string
  /** 現行ロードマップに属しているか。再生成で消えたPhaseはfalseになる（削除ではなく非活性化） */
  roadmapActive: boolean
  createdAt: string
  updatedAt: string
}

/**
 * Roadmap生成AIが各Taskへ付与する分類（roadmap item
 * roadmap-task-control-plane-separation）。Roadmap生成のZod schema
 * （apps/api/src/ctoAi/roadmapGenerator.ts）と、DB同期前のRoadmap検証
 * （apps/api/src/storage/roadmapTaskValidation.ts）の双方で使うため、ここに置く
 * （Meta Reviewer指摘、2026-09-01）。
 *
 * 意図的にTaskのDBカラムとしては永続化しない: Roadmap生成→検証（DB同期前）でのみ使う
 * 一時的な分類であり、`control_plane_operation`の機械的拒否は生成時点でfail-closedに
 * 完結する。`INSERT INTO tasks`（apps/api/src/storage/sqlite.ts）にcategoryカラムは無い。
 */
export const ROADMAP_TASK_CATEGORIES = [
  'implementation',
  'verification',
  'control_plane_operation',
  'other',
] as const

export type RoadmapTaskCategory = (typeof ROADMAP_TASK_CATEGORIES)[number]
