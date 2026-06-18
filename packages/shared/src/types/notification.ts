export type NotificationChannel = 'line' | 'slack' | 'email'

export type NotificationSeverity = 'info' | 'warning' | 'critical'

export interface NotificationEvent {
  id: string
  channel: NotificationChannel
  severity: NotificationSeverity
  title: string
  body: string
  /** 通知元コンテキスト（例: watchdog_event_id） */
  sourceType?: string
  sourceId?: string
  sentAt: string
  success: boolean
  errorMessage?: string
}
