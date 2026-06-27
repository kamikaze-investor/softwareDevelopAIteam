/**
 * Project Knowledge Graph — 共有型定義
 *
 * 本文は持たず軽量メタデータのみ。本文は docs / memory 側に置く。
 * Context Engine の最初の参照先として使う。
 *
 * NOTE: RiskLevel は safety_guard.ts に定義済みのため、重複定義せずそちらからインポートして使用する。
 */

import type { RiskLevel } from './safety_guard'

export type KGNodeType = 'feature' | 'phase' | 'task' | 'decision' | 'incident' | 'file' | 'doc'
export type KGNodeStatus = 'active' | 'archived' | 'inbox'
export type KGEdgeType = 'depends_on' | 'blocks' | 'related_to' | 'belongs_to' | 'impacts'

export interface KGNode {
  /** kg-YYYYMMDD-NNN 形式 */
  id: string
  type: KGNodeType
  title: string
  tags: string[]
  /** 所属 Phase の ID。未指定の場合は inbox 扱い */
  phase?: string
  status: KGNodeStatus
  risk: RiskLevel
  priority: 'low' | 'medium' | 'high'
  /** 1-2行の概要。本文は docs/memory 側に置く */
  summary?: string
  relatedDocs: string[]
  relatedFiles: string[]
  /** 依存する KGNode の ID 一覧 */
  dependsOn: string[]
  /** この Node がブロックする KGNode の ID 一覧 */
  blocks: string[]
  relatedFeatures: string[]
  relatedIncidents: string[]
  relatedDecisions: string[]
  historyRefs: string[]
  createdAt: string
  updatedAt: string
}

export interface KGEdge {
  /** kge-YYYYMMDD-NNN 形式 */
  id: string
  fromNodeId: string
  toNodeId: string
  edgeType: KGEdgeType
  /** 任意の補足ラベル */
  label?: string
  createdAt: string
}

// ────────────────────────────────────────────────────────────
// CEO向け Project Timeline Map 型
// ────────────────────────────────────────────────────────────

export interface TimelineFeature {
  node: KGNode
  /** この Feature に belongs_to エッジで紐づく子ノード */
  children: KGNode[]
  /** この Feature から出ている depends_on / blocks エッジ */
  edges: KGEdge[]
}

export interface TimelinePhase {
  phaseNode: KGNode
  features: TimelineFeature[]
  /** このフェーズ内の集計 */
  stats: {
    total: number
    active: number
    archived: number
    inbox: number
    highRiskCount: number
    criticalRiskCount: number
  }
}

export interface TimelineMap {
  /** Phase ノード順（priority: high→medium→low, createdAt 昇順）に並ぶ */
  phases: TimelinePhase[]
  /** Phase に未所属のノード（status='inbox' または phase=undefined） */
  inbox: KGNode[]
  generatedAt: string
}
