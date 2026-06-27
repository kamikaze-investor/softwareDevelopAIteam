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

// ────────────────────────────────────────────────────────────
// Context Engine 型
// ────────────────────────────────────────────────────────────

/** KG Context Pack の1エントリ */
export interface KGContextEntry {
  nodeId: string
  title: string
  type: KGNodeType
  /** 優先度スコア（高いほど重要） */
  priority: number
  /** なぜこのノードが選ばれたか */
  reason: string
  /** 関連ファイルパス */
  relatedFiles: string[]
  /** 関連ドキュメントパス */
  relatedDocs: string[]
  summary?: string
}

// ────────────────────────────────────────────────────────────
// Impact Analyzer 型
// ────────────────────────────────────────────────────────────

/** Impact Analyzer の入力 */
export interface ImpactAnalysisInput {
  changedFiles: string[]
  /** 変更を起こしている Feature の KGNode ID（任意） */
  targetFeatureId?: string
  taskId?: string
}

/** Impact Analyzer の出力 */
export interface ImpactAnalysisResult {
  /** 影響を受ける Feature ノード */
  impactedFeatures: KGNode[]
  /** 影響を受けるドキュメント */
  impactedDocs: string[]
  /** 影響を受けるテストファイル（relatedFiles に .test. を含むもの） */
  impactedTests: string[]
  /** 算出された riskLevel（最大リスクを採用） */
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  /** riskLevel の根拠 */
  riskReasons: string[]
  /** レビューが推奨される担当者・役割（将来拡張用、現在は空配列） */
  requiredReviewers: string[]
  analyzedAt: string
}

/** Context Engine (KG索引ベース) が生成する Context Pack */
export interface KGContextPack {
  taskId: string
  /** Risk level に基づく実行レベル (1-4) */
  executionLevel: 1 | 2 | 3 | 4
  /** 優先順位付き・重複排除済みコンテキスト */
  entries: KGContextEntry[]
  /** このパックに含まれなかったノード数（上限超過） */
  truncatedCount: number
  generatedAt: string
}
