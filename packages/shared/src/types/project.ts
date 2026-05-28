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

export interface Approval {
  id: string
  title: string
  reason: string
  type: 'goal_change' | 'philosophy_change' | 'external_service' | 'billing' | 'deployment' | 'security'
  createdAt: string
}
