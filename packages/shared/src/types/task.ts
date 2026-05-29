// Task型定義

import type { AgentRole } from './agent'

export type TaskStatus = 'pending' | 'in_progress' | 'review' | 'done' | 'blocked'

export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskStatus
  assignee: AgentRole
  dependencies: string[]  // task ids
  branchName?: string
  commitHash?: string

  /**
   * AIが変更してよいパス（target-project/配下の相対パス）
   * 指定なしの場合はFile Change Guardがデフォルト禁止リストのみ適用
   * レビュー指摘(2026-05-28): タスクごとに変更範囲を制限
   */
  allowedPaths?: string[]

  /**
   * AIが変更してはいけないパス（allowedPathsより優先）
   */
  forbiddenPaths?: string[]

  /**
   * タスク完了の受け入れ条件
   * QA AIがこれを元に判定する
   */
  acceptanceCriteria?: string[]

  /**
   * 期待される出力ファイル
   */
  expectedOutputs?: string[]

  createdAt: string
  updatedAt: string
}
