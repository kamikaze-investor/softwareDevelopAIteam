import type { CommandKind } from './command'

export type WatchdogStatus =
  | 'detected'   // スタル検出、AI分析待ち
  | 'analyzing'  // Gemini分析中
  | 'confirmed'  // AI: スタル確認済み → CEO通知待ち
  | 'false_alarm' // AI: スタルではなく低速なだけ
  | 'resolved'   // Jobが完了/失敗して解消

export interface WatchdogEvent {
  id: string
  jobId: string
  taskId: string
  commandKind: CommandKind
  workingDir: string
  startedAt: string
  detectedAt: string
  stallDurationMs: number
  status: WatchdogStatus
  aiAnalysis?: string
  isStuck?: boolean
  resolvedAt?: string
  createdAt: string
}
