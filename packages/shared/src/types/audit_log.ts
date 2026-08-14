/**
 * Audit Log — 重要な状態変更を後から追跡するための最小記録。
 *
 * 既存のdecision_records/incident_recordsとは責務が異なる（あちらは人間/AIが能動的に
 * 記録する意思決定・事後分析ログ）。監査ログはシステム側が状態変更のたびに自動記録する。
 */

/** 現状APIのみがDBを書き込むため、actorは常に'api'。将来複数actorが発生した場合に拡張する。 */
export type AuditLogActor = 'api'

export interface AuditLogEntry {
  id: string
  actor: AuditLogActor
  /** 例: 'delete' | 'approve' | 'reject' */
  operation: string
  /** 例: 'decision_record' | 'incident_record' | 'approval_request' */
  entityType: string
  entityId: string
  /** 例: 'success' | 'failure' */
  result: string
  /** 秘密情報・長大なpayloadを含めない短い補足のみ */
  detail?: string
  createdAt: string
}
