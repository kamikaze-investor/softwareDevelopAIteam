/**
 * CEO Dashboard home screen.
 *
 * 30 Second Rule: show the project's current state within 30 seconds.
 */

import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type {
  Approval,
  ApprovalRequest,
  Job,
  Project,
  ProjectStatus,
  Task,
} from '@ai-team/shared'
import { router } from 'expo-router'
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { apiFetch, clearApiToken, getApiToken, setApiToken } from '../lib/api'

const MAX_TASKS_FOR_RECENT_JOBS = 3
const MAX_JOBS_PER_TASK = 2
const MAX_RECENT_JOBS = 5

/**
 * API上でrunningへの遷移が許可されているProject status。
 * `archived`からの再開はMVP-Aの対象操作ではないため、`draft`/`paused`のみを許可する
 * （APIの`PATCH /api/projects/:id`自体はfrom-statusを制限しないが、UI側で意味のある
 * 遷移だけに絞る）。
 */
const STARTABLE_PROJECT_STATUSES: readonly ProjectStatus[] = ['draft', 'paused']

async function fetchProjects(): Promise<Project[]> {
  const response = await apiFetch('/api/projects')

  if (!response.ok) {
    throw new Error(`Failed to fetch projects: ${response.status}`)
  }

  return (await response.json()) as Project[]
}

async function fetchTasks(projectId: string): Promise<Task[]> {
  const response = await apiFetch(
    `/api/tasks?projectId=${encodeURIComponent(projectId)}`,
  )

  if (!response.ok) {
    return []
  }

  return (await response.json()) as Task[]
}

async function fetchJobs(taskId: string): Promise<Job[]> {
  const response = await apiFetch(
    `/api/jobs?taskId=${encodeURIComponent(taskId)}`,
  )

  if (!response.ok) {
    return []
  }

  return (await response.json()) as Job[]
}

async function fetchPendingApprovals(): Promise<Approval[]> {
  const response = await apiFetch('/api/approvals/pending')

  if (!response.ok) {
    throw new Error(`Failed to fetch pending approvals: ${response.status}`)
  }

  return (await response.json()) as Approval[]
}

async function fetchWaitingApprovalRequests(): Promise<ApprovalRequest[]> {
  const response = await apiFetch('/api/approval-requests/waiting')

  if (!response.ok) {
    throw new Error(`Failed to fetch approval requests: ${response.status}`)
  }

  return (await response.json()) as ApprovalRequest[]
}

/** 409時は本体APIの固定エラー文だけを返す（token・内部情報は含めない） */
async function startProject(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await apiFetch(`/api/projects/${projectId}`, {
      body: JSON.stringify({ status: 'running' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH',
    })

    if (response.ok) {
      return { ok: true }
    }

    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      return { ok: false, message: body.error ?? 'このProjectを開始できませんでした' }
    }

    return { ok: false, message: `開始に失敗しました（HTTP ${response.status}）` }
  } catch {
    return { ok: false, message: 'APIに接続できませんでした' }
  }
}

async function fetchRecentJobs(taskIds: string[]): Promise<Job[]> {
  const selectedTaskIds = taskIds.slice(0, MAX_TASKS_FOR_RECENT_JOBS)
  const jobGroups = await Promise.all(selectedTaskIds.map(fetchJobs))

  return jobGroups
    .flatMap((jobs) => jobs.slice(0, MAX_JOBS_PER_TASK))
    .slice(0, MAX_RECENT_JOBS)
}

async function fetchPendingApprovalCount(): Promise<number> {
  const [approvals, approvalRequests] = await Promise.all([
    fetchPendingApprovals(),
    fetchWaitingApprovalRequests(),
  ])

  return approvals.length + approvalRequests.length
}

const STATUS_COLOR: Record<string, string> = {
  archived: '#525252',
  blocked: '#f59e0b',
  done: '#22c55e',
  draft: '#737373',
  failed: '#ef4444',
  in_progress: '#3b82f6',
  paused: '#f59e0b',
  pending: '#737373',
  queued: '#737373',
  review: '#a855f7',
  running: '#3b82f6',
  success: '#22c55e',
}

function getStatusColor(status: string): string {
  return STATUS_COLOR[status] ?? '#737373'
}

function ProjectCard({
  project,
  onStarted,
}: {
  project: Project
  onStarted: () => void
}) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let isMounted = true

    async function loadProjectDetails(): Promise<void> {
      const projectTasks = await fetchTasks(project.id)
      const recentJobs = await fetchRecentJobs(projectTasks.map((task) => task.id))

      if (!isMounted) {
        return
      }

      setTasks(projectTasks)
      setJobs(recentJobs)
    }

    loadProjectDetails().catch(() => {
      if (isMounted) {
        setTasks([])
        setJobs([])
      }
    })

    return () => {
      isMounted = false
    }
  }, [project.id])

  const doneTasks = tasks.filter((task) => task.status === 'done').length
  const statusColor = getStatusColor(project.status)
  const canStart = STARTABLE_PROJECT_STATUSES.includes(project.status)

  const handleStart = useCallback(async (): Promise<void> => {
    setStarting(true)
    try {
      const result = await startProject(project.id)
      if (!result.ok) {
        Alert.alert('開始できません', result.message)
        return
      }
      onStarted()
    } finally {
      setStarting(false)
    }
  }, [project.id, onStarted])

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {project.name}
        </Text>
        <View style={[styles.badge, { backgroundColor: statusColor }]}>
          <Text style={styles.badgeText}>{project.status}</Text>
        </View>
      </View>

      <Text style={styles.goalText} numberOfLines={2}>
        Goal: {project.goal}
      </Text>

      <Text style={styles.progressText}>
        Tasks: {doneTasks}/{tasks.length} done
      </Text>

      <View style={styles.cardActions}>
        {canStart && (
          <TouchableOpacity
            accessibilityRole="button"
            disabled={starting}
            onPress={() => void handleStart()}
            style={[styles.startButton, starting && styles.startButtonDisabled]}
          >
            {starting && <ActivityIndicator color="#fff" size="small" />}
            <Text style={styles.startButtonText}>▶ このProjectを開始</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() =>
            router.push({
              params: { projectId: project.id },
              pathname: '/tasks/create',
            })
          }
          style={styles.addTaskButton}
        >
          <Text style={styles.addTaskButtonText}>＋ Taskを追加</Text>
        </TouchableOpacity>
      </View>

      {jobs.length > 0 && (
        <View style={styles.jobsSection}>
          <Text style={styles.sectionLabel}>Recent Jobs</Text>
          {jobs.map((job) => {
            const jobStatusColor = getStatusColor(job.status)

            return (
              <View key={job.id} style={styles.jobRow}>
                <View
                  style={[styles.jobDot, { backgroundColor: jobStatusColor }]}
                />
                <Text style={styles.jobText} numberOfLines={1}>
                  {job.safeCommand.kind}
                </Text>
                <Text style={[styles.jobStatus, { color: jobStatusColor }]}>
                  {job.status}
                </Text>
              </View>
            )
          })}
        </View>
      )}
    </View>
  )
}

function ApiTokenSettings(): ReactElement {
  const [isOpen, setIsOpen] = useState(false)
  const [hasToken, setHasToken] = useState<boolean | null>(null)
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)

  const refreshStatus = useCallback(async (): Promise<void> => {
    const token = await getApiToken()
    setHasToken(token !== null && token.length > 0)
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const handleSave = useCallback(async (): Promise<void> => {
    const trimmed = input.trim()
    if (trimmed.length === 0) {
      Alert.alert('入力エラー', 'APIトークンを入力してください')
      return
    }
    setSaving(true)
    try {
      await setApiToken(trimmed)
      setInput('')
      setIsOpen(false)
      await refreshStatus()
      Alert.alert('保存しました', 'APIトークンを保存しました')
    } finally {
      setSaving(false)
    }
  }, [input, refreshStatus])

  const handleDelete = useCallback((): void => {
    Alert.alert('APIトークンを削除', '削除すると認証が必要なAPIに接続できなくなります。よろしいですか？', [
      { style: 'cancel', text: 'キャンセル' },
      {
        onPress: () => {
          void (async () => {
            await clearApiToken()
            await refreshStatus()
          })()
        },
        style: 'destructive',
        text: '削除',
      },
    ])
  }, [refreshStatus])

  return (
    <View style={styles.tokenSection}>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={() => setIsOpen((prev) => !prev)}
        style={styles.tokenToggle}
      >
        <Text style={styles.tokenToggleText}>
          ⚙ 接続設定（APIトークン: {hasToken === null ? '確認中' : hasToken ? '設定済み' : '未設定'}）
        </Text>
      </TouchableOpacity>

      {isOpen && (
        <View style={styles.tokenBox}>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            editable={!saving}
            onChangeText={setInput}
            placeholder="新しいAPIトークンを入力"
            placeholderTextColor="#555"
            secureTextEntry
            style={styles.tokenInput}
            value={input}
          />
          <View style={styles.tokenActions}>
            <TouchableOpacity
              accessibilityRole="button"
              disabled={saving}
              onPress={() => void handleSave()}
              style={styles.tokenSaveButton}
            >
              <Text style={styles.tokenSaveButtonText}>保存</Text>
            </TouchableOpacity>
            {hasToken === true && (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={handleDelete}
                style={styles.tokenDeleteButton}
              >
                <Text style={styles.tokenDeleteButtonText}>削除</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </View>
  )
}

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([])
  const [pendingApprovalCount, setPendingApprovalCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setError(null)
      const [projectsResult, approvalCountResult] = await Promise.allSettled([
        fetchProjects(),
        fetchPendingApprovalCount(),
      ])

      if (projectsResult.status === 'fulfilled') {
        setProjects(projectsResult.value)
      } else {
        const loadError = projectsResult.reason as unknown
        const message =
          loadError instanceof Error
            ? loadError.message
            : 'Failed to connect to API'
        setError(message)
      }

      setPendingApprovalCount(
        approvalCountResult.status === 'fulfilled'
          ? approvalCountResult.value
          : null,
      )
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback((): void => {
    setRefreshing(true)
    void load()
  }, [load])

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} />
        }
        style={styles.scrollArea}
      >
        <Text style={styles.title}>AI Development Team OS</Text>
        <Text style={styles.subtitle}>CEO Dashboard</Text>

        <ApiTokenSettings />

        <Text style={styles.projectCount}>Projects ({projects.length})</Text>

        {error !== null && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {projects.length === 0 && error === null && (
          <Text style={styles.empty}>No projects yet</Text>
        )}

        {projects.map((project) => (
          <ProjectCard key={project.id} onStarted={load} project={project} />
        ))}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => router.push('/create')}
          style={styles.createButton}
        >
          <Text style={styles.createText}>＋ 新規プロジェクト</Text>
        </TouchableOpacity>

        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => router.push('/approvals')}
          style={styles.approvalButton}
        >
          <Text style={styles.approvalText}>承認待ち一覧</Text>
          <View style={styles.approvalBadge}>
            <Text style={styles.approvalBadgeText}>
              {pendingApprovalCount === null ? '—' : `${pendingApprovalCount}件`}
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => router.push('/tasks')}
          style={styles.taskButton}
        >
          <Text style={styles.taskText}>作業状況を見る</Text>
        </TouchableOpacity>

        <TouchableOpacity
          accessibilityRole="button"
          onPress={load}
          style={styles.refreshButton}
        >
          <Text style={styles.refreshText}>Refresh</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  approvalBadge: {
    backgroundColor: '#f59e0b22',
    borderColor: '#f59e0b44',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  approvalBadgeText: {
    color: '#f59e0b',
    fontSize: 12,
    fontWeight: '700',
  },
  approvalButton: {
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderColor: '#f59e0b44',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginTop: 8,
    padding: 14,
  },
  approvalText: {
    color: '#f59e0b',
    fontSize: 15,
    fontWeight: '600',
  },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    marginBottom: 12,
    padding: 16,
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardTitle: {
    color: '#fff',
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    marginRight: 8,
  },
  cardActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  startButton: {
    alignItems: 'center',
    backgroundColor: '#22c55e',
    borderRadius: 8,
    flexDirection: 'row',
    flexShrink: 0,
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  startButtonDisabled: {
    opacity: 0.6,
  },
  startButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  addTaskButton: {
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderColor: '#3b82f644',
    borderRadius: 8,
    borderWidth: 1,
    flexShrink: 0,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addTaskButtonText: {
    color: '#60a5fa',
    fontSize: 13,
    fontWeight: '700',
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
  },
  content: {
    padding: 16,
    // 固定フッター（新規プロジェクト/承認待ち一覧/Refreshボタン）と重ならないよう、
    // 一覧末尾に十分な余白を確保する。
    paddingBottom: 240,
  },
  footer: {
    backgroundColor: '#0a0a0a',
    borderTopColor: '#2a2a2a',
    borderTopWidth: 1,
    paddingBottom: 24,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  scrollArea: {
    flex: 1,
  },
  createButton: {
    alignItems: 'center',
    backgroundColor: '#3b82f6',
    borderRadius: 12,
    marginBottom: 12,
    marginTop: 8,
    padding: 14,
  },
  createText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  empty: {
    color: '#737373',
    fontSize: 15,
    marginTop: 40,
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
  goalText: {
    color: '#a3a3a3',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 8,
  },
  jobDot: {
    borderRadius: 3,
    height: 6,
    marginRight: 8,
    width: 6,
  },
  jobRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: 5,
  },
  jobStatus: {
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 8,
  },
  jobText: {
    color: '#d4d4d4',
    flex: 1,
    fontSize: 13,
  },
  jobsSection: {
    borderTopColor: '#2a2a2a',
    borderTopWidth: 1,
    marginTop: 4,
    paddingTop: 8,
  },
  progressText: {
    color: '#60a5fa',
    fontSize: 13,
    marginBottom: 8,
  },
  projectCount: {
    color: '#d4d4d4',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
    marginTop: 20,
  },
  taskButton: {
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderColor: '#3b82f644',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
    padding: 14,
  },
  taskText: {
    color: '#60a5fa',
    fontSize: 15,
    fontWeight: '600',
  },
  refreshButton: {
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    marginTop: 8,
    padding: 14,
  },
  refreshText: {
    color: '#3b82f6',
    fontSize: 15,
    fontWeight: '600',
  },
  sectionLabel: {
    color: '#737373',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  subtitle: {
    color: '#8a8a8a',
    fontSize: 13,
    marginTop: 2,
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    marginTop: 52,
  },
  tokenSection: {
    marginTop: 14,
  },
  tokenToggle: {
    paddingVertical: 6,
  },
  tokenToggleText: {
    color: '#737373',
    fontSize: 12,
  },
  tokenBox: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 6,
    padding: 12,
  },
  tokenInput: {
    backgroundColor: '#0f0f0f',
    borderColor: '#333',
    borderRadius: 6,
    borderWidth: 1,
    color: '#fff',
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tokenActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  tokenSaveButton: {
    alignItems: 'center',
    backgroundColor: '#3b82f6',
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  tokenSaveButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  tokenDeleteButton: {
    alignItems: 'center',
    backgroundColor: '#2a1515',
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  tokenDeleteButtonText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '700',
  },
})
