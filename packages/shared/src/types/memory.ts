// Project Memory型定義

export type MemoryType =
  | 'goal'
  | 'design_philosophy'
  | 'decision'
  | 'feature'
  | 'rule'
  | 'lesson'

export type MemoryStatus = 'active' | 'archived'

export interface Memory {
  id: string
  type: MemoryType
  title: string
  summary: string
  content: string
  importance: 1 | 2 | 3 | 4 | 5  // 5=Goal, 4=Philosophy, 3=Decision, 2=Feature, 1=Rule/Lesson
  status: MemoryStatus
  createdAt: string
  updatedAt: string
  tags: string[]
  references: string[]  // 関連するmemory ids
}

export interface ContextPack {
  taskId: string
  generatedAt: string
  tokenEstimate: number
  goal: string
  designPhilosophy: string[]
  taskSummary: string
  relevantDecisions: Memory[]
  relevantFeatures: Memory[]
  relevantRules: Memory[]
  lessonsLearned: Memory[]
  relatedCode: string[]
  relatedTasks: string[]
}
