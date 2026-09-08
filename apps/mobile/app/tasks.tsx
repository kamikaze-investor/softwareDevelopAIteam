/**
 * Cross-project task status list for CEO review.
 */

import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { JobStatus, TaskDisplayStatus, TaskSummary, WatchdogEvent } from '@ai-team/shared'
import { router } from 'expo-router'
import { JOB_DISPLAY_STATE_LABEL, type JobDisplayState } from '../lib/taskWorkflow'
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'

import { apiFetch } from '../lib/api'

const TASK_STATUS_BADGE_FALLBACK = {
  backgroundColor: '#73737322',
  borderColor: '#73737355',
}

const TASK_STATUS_TEXT_FALLBACK = {
  color: '#d4d4d4',
}

const TASK_STATUS_BADGE_STYLE: Record<
  TaskDisplayStatus,
  { backgroundColor: string; borderColor: string }
> = {
  blocked: { backgroundColor: '#f59e0b22', borderColor: '#f59e0b66' },
  completed: { backgroundColor: '#22c55e22', borderColor: '#22c55e55' },
  failed: { backgroundColor: '#ef444422', borderColor: '#ef444466' },
  in_progress: { backgroundColor: '#3b82f622', borderColor: '#3b82f655' },
  pending: { backgroundColor: '#73737322', borderColor: '#73737355' },
  queued: { backgroundColor: '#73737322', borderColor: '#73737355' },
  rejected_waiting_instruction: {
    backgroundColor: '#ef444422',
    borderColor: '#ef444466',
  },
  running: { backgroundColor: '#3b82f622', borderColor: '#3b82f655' },
  waiting_approval: { backgroundColor: '#f59e0b22', borderColor: '#f59e0b66' },
}

const TASK_STATUS_TEXT_STYLE: Record<TaskDisplayStatus, { color: string }> = {
  blocked: { color: '#f59e0b' },
  completed: { color: '#22c55e' },
  failed: { color: '#ef4444' },
  in_progress: { color: '#60a5fa' },
  pending: { color: '#a3a3a3' },
  queued: { color: '#a3a3a3' },
  rejected_waiting_instruction: { color: '#ef4444' },
  running: { color: '#60a5fa' },
  waiting_approval: { color: '#f59e0b' },
}

const JOB_STATUS_TEXT_STYLE: Record<JobStatus, { color: string }> = {
  blocked: { color: '#f59e0b' },
  failed: { color: '#ef4444' },
  queued: { color: '#a3a3a3' },
  running: { color: '#60a5fa' },
  success: { color: '#22c55e' },
}

async function fetchWatchdogEventsSafe(): Promise<WatchdogEvent[]> {
  try {
    const response = await apiFetch('/api/watchdog-events')
    if (!response.ok) return []
    return (await response.json()) as WatchdogEvent[]
  } catch {
    return []
  }
}

async function fetchTaskSummaries(): Promise<TaskSummary[]> {
  const response = await apiFetch('/api/tasks/summary')

  if (!response.ok) {
    throw new Error(`Failed to fetch task summaries: ${response.status}`)
  }

  return (await response.json()) as TaskSummary[]
}

function formatDateTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString()
}

function formatDisplayStatus(displayStatus: string): string {
  switch (displayStatus) {
    case 'waiting_approval':
      return '承認待ち'
    case 'rejected_waiting_instruction':
      return '却下により停止・追加指示待ち'
    case 'blocked':
      return '停止中'
    case 'failed':
      return '失敗'
    case 'running':
      return '実行中'
    case 'queued':
      return '待機中'
    case 'completed':
      return '完了'
    case 'in_progress':
      return '進行中'
    case 'pending':
      return '未着手'
    default:
      return `ステータス: ${displayStatus}`
  }
}

function formatJobStatus(status: string): string {
  switch (status) {
    case 'queued':
      return '待機中'
    case 'running':
      return '実行中'
    case 'success':
      return '完了'
    case 'failed':
      return '失敗'
    case 'blocked':
      return '停止中'
    default:
      return `Job状態: ${status}`
  }
}

function getTaskStatusBadgeStyle(
  displayStatus: string,
): { backgroundColor: string; borderColor: string } {
  return (
    TASK_STATUS_BADGE_STYLE[displayStatus as TaskDisplayStatus] ??
    TASK_STATUS_BADGE_FALLBACK
  )
}

function getTaskStatusTextStyle(displayStatus: string): { color: string } {
  return (
    TASK_STATUS_TEXT_STYLE[displayStatus as TaskDisplayStatus] ??
    TASK_STATUS_TEXT_FALLBACK
  )
}

function getAttentionText(displayStatus: TaskDisplayStatus): string | null {
  if (displayStatus === 'waiting_approval') {
    return 'CEO承認待ちです'
  }

  if (displayStatus === 'rejected_waiting_instruction') {
    return '却下により停止しています。追加指示が必要です'
  }

  return null
}

/**
 * MOB-001: 一覧でも quarantine / stalled を単なる「停止中」に畳まない。
 * CEO は一覧を見た時点で「対応が要るもの」と「待っていればよいもの」を区別できる必要がある。
 *
 * 新しい status は作らない。既存の latestJob.status / latestJob.quarantined /
 * approvalSummary / WatchdogEvent から導出する。
 */
function deriveSummaryState(
  task: TaskSummary,
  watchdogEvents: WatchdogEvent[],
): JobDisplayState {
  const job = task.latestJob
  if (job === undefined) return 'other'
  if (job.status === 'blocked' && job.quarantined === true) return 'quarantined'
  if (job.status === 'running') {
    // 詳細画面と同じ episode key (jobId, startedAt) で判定する。
    const stalled = watchdogEvents.some((event) => (
      event.jobId === job.jobId &&
      event.startedAt === job.startedAt &&
      event.isStuck === true &&
      event.status !== 'false_alarm' &&
      event.status !== 'resolved'
    ))
    return stalled ? 'running_stalled' : 'running_healthy'
  }
  if (job.status === 'blocked') {
    return task.approvalSummary.hasWaitingApproval ? 'approval_waiting' : 'blocked'
  }
  return 'other'
}

/** 一覧バッジの色。quarantine と stalled は「気づかせる」ため強い色にする。 */
const SUMMARY_STATE_COLOR: Record<JobDisplayState, string> = {
  approval_waiting: '#a855f7',
  blocked: '#f59e0b',
  other: '#737373',
  quarantined: '#dc2626',
  running_healthy: '#3b82f6',
  running_stalled: '#f97316',
}
function TaskCard({ task, watchdogEvents }: { task: TaskSummary; watchdogEvents: WatchdogEvent[] }): ReactElement {
  const execState = deriveSummaryState(task, watchdogEvents)
  const execLabel = JOB_DISPLAY_STATE_LABEL[execState]
  const statusBadgeStyle = getTaskStatusBadgeStyle(task.displayStatus)
  const statusTextStyle = getTaskStatusTextStyle(task.displayStatus)
  const attentionText = getAttentionText(task.displayStatus)
  const latestJobStatus = task.latestJob?.status

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      accessibilityRole="button"
      onPress={() => router.push(`/tasks/${task.taskId}`)}
      style={styles.card}
    >
      <View style={styles.cardTop}>
        <Text style={styles.projectName} numberOfLines={1}>
          {task.projectName}
        </Text>
        <View style={styles.badgeRow}>
          {execLabel !== '' && (
            <View style={[styles.execBadge, { backgroundColor: SUMMARY_STATE_COLOR[execState] }]}>
              <Text style={styles.execBadgeText}>{execLabel}</Text>
            </View>
          )}
          <View style={[styles.statusBadge, statusBadgeStyle]}>
            <Text style={[styles.statusText, statusTextStyle]}>
              {formatDisplayStatus(task.displayStatus)}
            </Text>
          </View>
        </View>
      </View>

      <Text style={styles.itemTitle}>{task.title}</Text>

      {attentionText !== null && (
        <View style={[styles.attentionBox, statusBadgeStyle]}>
          <Text style={[styles.attentionText, statusTextStyle]}>
            {attentionText}
          </Text>
        </View>
      )}

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>最新Job</Text>
        {latestJobStatus === undefined ? (
          <Text style={styles.metaText}>実行履歴なし</Text>
        ) : (
          <Text
            style={[
              styles.metaText,
              styles.jobStatusText,
              JOB_STATUS_TEXT_STYLE[latestJobStatus],
            ]}
          >
            {formatJobStatus(latestJobStatus)}
          </Text>
        )}
      </View>

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>最終更新</Text>
        <Text style={styles.metaText}>{formatDateTime(task.updatedAt)}</Text>
      </View>
    </TouchableOpacity>
  )
}

export default function TasksScreen(): ReactElement {
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  // MOB-001: stalled を一覧でも見分けるため。既存エンドポイントを読むだけ。
  const [watchdogEvents, setWatchdogEvents] = useState<WatchdogEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadTaskSummaries = useCallback(async (): Promise<void> => {
    try {
      setError(null)
      const taskSummaries = await fetchTaskSummaries()
      setTasks(taskSummaries)
      // 取得失敗は致命的でない: stalled 表示が出ないだけで一覧は壊さない。
      setWatchdogEvents(await fetchWatchdogEventsSafe())
    } catch (loadError) {
      const message =
        loadError instanceof Error
          ? loadError.message
          : 'Failed to connect to API'
      setError(message)
      Alert.alert('エラー', '作業状況の取得に失敗しました')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadTaskSummaries()
  }, [loadTaskSummaries])

  const refresh = useCallback((): void => {
    setRefreshing(true)
    void loadTaskSummaries()
  }, [loadTaskSummaries])

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    )
  }

  return (
    <ScrollView
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} />
      }
      style={styles.container}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>← 戻る</Text>
        </TouchableOpacity>
        <Text style={styles.title}>作業状況</Text>
      </View>

      {error !== null && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {tasks.length === 0 && error === null && (
        <Text style={styles.empty}>表示できる作業がありません</Text>
      )}

      {tasks.map((task) => (
        <TaskCard key={task.taskId} task={task} watchdogEvents={watchdogEvents} />
      ))}

      <View style={styles.bottomSpacer} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  attentionBox: {
    borderRadius: 6,
    borderWidth: 1,
    marginBottom: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  attentionText: {
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  back: {
    marginRight: 12,
  },
  backText: {
    color: '#3b82f6',
    fontSize: 15,
  },
  bottomSpacer: {
    height: 40,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    marginBottom: 12,
    padding: 16,
  },
  badgeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  execBadge: {
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  execBadgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },
  cardTop: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  center: {
    alignItems: 'center',
    backgroundColor: '#0a0a0a',
    flex: 1,
    justifyContent: 'center',
  },
  container: {
    backgroundColor: '#0a0a0a',
    flex: 1,
    padding: 16,
  },
  empty: {
    color: '#737373',
    fontSize: 16,
    marginTop: 60,
    textAlign: 'center',
  },
  errorBox: {
    backgroundColor: '#2a1515',
    borderRadius: 8,
    marginBottom: 12,
    padding: 12,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: 20,
    marginTop: 52,
  },
  itemTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 22,
    marginBottom: 12,
  },
  jobStatusText: {
    fontWeight: '700',
  },
  metaLabel: {
    color: '#737373',
    fontSize: 12,
    fontWeight: '700',
    marginRight: 12,
    minWidth: 64,
  },
  metaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: 6,
  },
  metaText: {
    color: '#a3a3a3',
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  projectName: {
    color: '#737373',
    flex: 1,
    fontSize: 12,
    marginRight: 8,
  },
  statusBadge: {
    borderRadius: 6,
    borderWidth: 1,
    flexShrink: 0,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold',
  },
})
