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
