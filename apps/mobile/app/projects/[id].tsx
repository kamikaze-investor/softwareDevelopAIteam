/**
 * Project detail screen with Task status aggregation and Job activity.
 */

import type { ReactElement } from 'react'
import { useCallback, useState } from 'react'
import type {
  Job,
  JobStatus,
  Project,
  ProjectRoadmapPhase,
  ProjectStatus,
  Task,
  TaskStatus,
} from '@ai-team/shared'
import { router, useLocalSearchParams } from 'expo-router'
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'

import { apiFetch } from '../../lib/api'
import { POLLING_INTERVAL_MS, usePolling } from '../../lib/usePolling'

const MAX_TASKS_FOR_RECENT_JOBS = 3
const MAX_JOBS_PER_TASK = 2
const MAX_RECENT_JOBS = 5

const TASK_STATUS_ORDER: readonly TaskStatus[] = [
  'pending',
  'in_progress',
  'review',
  'done',
  'blocked',
]

const PROJECT_STATUS_COLOR: Record<ProjectStatus, string> = {
  archived: '#525252',
  draft: '#737373',
  paused: '#f59e0b',
  running: '#3b82f6',
}

const STATUS_COLOR: Record<TaskStatus | JobStatus, string> = {
  blocked: '#f59e0b',
  done: '#22c55e',
  failed: '#ef4444',
  in_progress: '#3b82f6',
  pending: '#737373',
  queued: '#737373',
  review: '#a855f7',
  running: '#3b82f6',
  success: '#22c55e',
}

interface ProjectDetailData {
  jobsByTaskId: Record<string, Job[]>
  phases: ProjectRoadmapPhase[]
  project: Project
  tasks: Task[]
}

interface TaskJobSummary {
  jobs: Job[]
  task: Task
}

async function fetchProject(projectId: string): Promise<Project | null> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}`,
  )

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch project: ${response.status}`)
  }

  return (await response.json()) as Project
}

async function fetchRoadmapPhases(projectId: string): Promise<ProjectRoadmapPhase[]> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/roadmap`,
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch roadmap: ${response.status}`)
  }

  const body = (await response.json()) as { phases: ProjectRoadmapPhase[] }
  return body.phases
}

async function fetchTasks(projectId: string): Promise<Task[]> {
  const response = await apiFetch(
    `/api/tasks?projectId=${encodeURIComponent(projectId)}`,
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch tasks: ${response.status}`)
  }

  return (await response.json()) as Task[]
}

async function fetchJobs(taskId: string): Promise<Job[]> {
  const response = await apiFetch(
    `/api/jobs?taskId=${encodeURIComponent(taskId)}`,
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch jobs: ${response.status}`)
  }

  return (await response.json()) as Job[]
}

async function fetchJobsByTaskId(
  tasks: Task[],
): Promise<Record<string, Job[]>> {
  const jobGroups = await Promise.all(tasks.map((task) => fetchJobs(task.id)))

  return tasks.reduce<Record<string, Job[]>>((jobsByTaskId, task, index) => {
    jobsByTaskId[task.id] = jobGroups[index] ?? []
    return jobsByTaskId
  }, {})
}

function normalizeProjectId(
  value: string | string[] | undefined,
): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null
  }

  return value ?? null
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to connect to API'
}

function selectActivePhasesWithTasks(
  phases: ProjectRoadmapPhase[],
  tasks: Task[],
): Array<{ phase: ProjectRoadmapPhase; tasks: Task[] }> {
  return phases
    .filter((phase) => phase.roadmapActive)
    .sort((left, right) => left.phaseNumber - right.phaseNumber)
    .map((phase) => ({
      phase,
      tasks: tasks.filter((task) => task.roadmapActive && task.phase === phase.phaseNumber),
    }))
}

type PhaseRoadmapStatus = 'completed' | 'current' | 'upcoming'

interface ClassifiedPhase {
  phase: ProjectRoadmapPhase
  tasks: Task[]
  phaseStatus: PhaseRoadmapStatus
}

const PHASE_STATUS_ICON: Record<PhaseRoadmapStatus, string> = {
  completed: '✅',
  current: '🟡',
  upcoming: '⬜',
}

/**
 * 全Task完了のPhaseはcompleted、未完了Taskを含む最も早いPhaseがcurrent、それ以降はupcoming。
 * 既存data（Phase順序・Task status）だけで決まる分類で、新しいplanning algorithmは導入しない。
 */
function classifyPhases(
  activePhases: Array<{ phase: ProjectRoadmapPhase; tasks: Task[] }>,
): ClassifiedPhase[] {
  let currentAssigned = false

  return activePhases.map(({ phase, tasks }) => {
    const allDone = tasks.every((task) => task.status === 'done')
    let phaseStatus: PhaseRoadmapStatus

    if (allDone) {
      phaseStatus = 'completed'
    } else if (!currentAssigned) {
      phaseStatus = 'current'
      currentAssigned = true
    } else {
      phaseStatus = 'upcoming'
    }

    return { phase, tasks, phaseStatus }
  })
}

interface RoadmapProgress {
  completed: number
  total: number
  percent: number
}

/** completed active roadmap tasks / total active roadmap tasks。Task weighting等は行わない。 */
function computeRoadmapProgress(tasks: Task[]): RoadmapProgress {
  const activeRoadmapTasks = tasks.filter((task) => task.roadmapActive)
  const completed = activeRoadmapTasks.filter((task) => task.status === 'done').length
  const total = activeRoadmapTasks.length
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100)

  return { completed, total, percent }
}

function countTasksByStatus(tasks: Task[]): Record<TaskStatus, number> {
  const taskStatusCounts: Record<TaskStatus, number> = {
    blocked: 0,
    done: 0,
    in_progress: 0,
    pending: 0,
    review: 0,
  }

  for (const task of tasks) {
    taskStatusCounts[task.status] += 1
  }

  return taskStatusCounts
}

function selectRunningTaskJobs(
  tasks: Task[],
  jobsByTaskId: Record<string, Job[]>,
): TaskJobSummary[] {
  return tasks
    .map((task) => ({
      jobs: (jobsByTaskId[task.id] ?? []).filter(
        (job) => job.status === 'running',
      ),
      task,
    }))
    .filter(
      ({ jobs, task }) => task.status === 'in_progress' || jobs.length > 0,
    )
}

function selectFailedTaskJobs(
  tasks: Task[],
  jobsByTaskId: Record<string, Job[]>,
): TaskJobSummary[] {
  return tasks
    .map((task) => ({
      jobs: (jobsByTaskId[task.id] ?? []).filter(
        (job) => job.status === 'failed',
      ),
      task,
    }))
    .filter(({ jobs, task }) => task.status === 'blocked' || jobs.length > 0)
}

function selectRecentJobs(
  tasks: Task[],
  jobsByTaskId: Record<string, Job[]>,
): Job[] {
  return tasks
    .slice(0, MAX_TASKS_FOR_RECENT_JOBS)
    .flatMap((task) =>
      (jobsByTaskId[task.id] ?? []).slice(0, MAX_JOBS_PER_TASK),
    )
    .slice(0, MAX_RECENT_JOBS)
}

function isProjectDetailPollingEnabled(
  data: ProjectDetailData | null,
): boolean {
  if (data === null || data.project.status === 'running') {
    return true
  }

  if (
    data.tasks.some(
      (task) => task.status === 'in_progress' || task.status === 'review',
    )
  ) {
    return true
  }

  return Object.values(data.jobsByTaskId)
    .flat()
    .some((job) => job.status === 'queued' || job.status === 'running')
}

function StatusBadge({
  color,
  status,
}: {
  color: string
  status: string
}): ReactElement {
  return (
    <View style={[styles.statusBadge, { backgroundColor: color }]}>
      <Text style={styles.statusBadgeText}>{status}</Text>
    </View>
  )
}

function ProjectStatusSection({ project }: { project: Project }): ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Project status</Text>
      <View style={styles.infoCard}>
        <StatusBadge
          color={PROJECT_STATUS_COLOR[project.status]}
          status={project.status}
        />
      </View>
    </View>
  )
}

function GoalSection({ project }: { project: Project }): ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Goal</Text>
      <View style={styles.infoCard}>
        <Text style={styles.bodyText}>{project.goal}</Text>
      </View>
    </View>
  )
}

function DesignPhilosophySection({
  designPhilosophy,
}: {
  designPhilosophy: string[]
}): ReactElement | null {
  if (designPhilosophy.length === 0) {
    return null
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Design Philosophy</Text>
      <View style={styles.infoCard}>
        {designPhilosophy.map((item, index) => (
          <Text key={index} style={styles.bulletText}>
            {'• '}{item}
          </Text>
        ))}
      </View>
    </View>
  )
}

function RoadmapProgressBar({ progress }: { progress: RoadmapProgress }): ReactElement {
  return (
    <View style={styles.infoCard}>
      <View style={styles.progressBarTrack}>
        <View style={[styles.progressBarFill, { width: `${progress.percent}%` }]} />
      </View>
      <Text style={styles.progressPercentText}>{progress.percent}%</Text>
      <Text style={styles.taskProgressSummary}>
        {progress.completed} / {progress.total} Tasks completed
      </Text>
    </View>
  )
}

function RoadmapCurrentPositionSummary({
  classifiedPhases,
}: {
  classifiedPhases: ClassifiedPhase[]
}): ReactElement {
  const currentIndex = classifiedPhases.findIndex(({ phaseStatus }) => phaseStatus === 'current')
  const currentPhase = currentIndex === -1 ? null : classifiedPhases[currentIndex]

  return (
    <View style={styles.infoCard}>
      <Text style={styles.taskProgressSummary}>
        {currentPhase
          ? `Current: Phase ${currentPhase.phase.phaseNumber} / ${classifiedPhases.length}`
          : `全Phase完了 / ${classifiedPhases.length}`}
      </Text>
    </View>
  )
}

function RoadmapSection({
  phases,
  tasks,
}: {
  phases: ProjectRoadmapPhase[]
  tasks: Task[]
}): ReactElement | null {
  const activePhases = selectActivePhasesWithTasks(phases, tasks)

  if (activePhases.length === 0) {
    return null
  }

  const classifiedPhases = classifyPhases(activePhases)
  const activeRoadmapTasks = tasks.filter((task) => task.roadmapActive)
  const progress = computeRoadmapProgress(activeRoadmapTasks)

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Roadmap Progress</Text>
      <RoadmapProgressBar progress={progress} />

      <Text style={styles.sectionTitle}>Roadmap</Text>
      <RoadmapCurrentPositionSummary classifiedPhases={classifiedPhases} />
      {classifiedPhases.map(({ phase, tasks: phaseTasks, phaseStatus }) => {
        const phaseTaskStatusCounts = countTasksByStatus(phaseTasks)
        const doneCount = phaseTaskStatusCounts.done

        return (
          <View key={phase.phaseNumber} style={styles.itemCard}>
            <Text style={styles.itemTitle}>
              {PHASE_STATUS_ICON[phaseStatus]} Phase {phase.phaseNumber}: {phase.name}
              {phaseStatus === 'current' ? ' ← Current' : ''}
            </Text>
            <Text style={styles.phaseGoal}>{phase.goal}</Text>
            <Text style={styles.taskProgressSummary}>
              完了Task: {doneCount} / {phaseTasks.length}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

function TaskProgressSection({ tasks }: { tasks: Task[] }): ReactElement {
  const taskStatusCounts = countTasksByStatus(tasks)

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Task進捗</Text>
      <View style={styles.infoCard}>
        <Text style={styles.taskProgressSummary}>
          完了Task: {taskStatusCounts.done} / {tasks.length}
        </Text>
        <View style={styles.statusBreakdown}>
          {TASK_STATUS_ORDER.map((status) => (
            <View key={status} style={styles.statusBreakdownRow}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: STATUS_COLOR[status] },
                ]}
              />
              <Text style={styles.statusBreakdownLabel}>{status}</Text>
              <Text style={styles.statusBreakdownCount}>
                {taskStatusCounts[status]}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  )
}

function RunningTaskJobsSection({
  jobsByTaskId,
  tasks,
}: {
  jobsByTaskId: Record<string, Job[]>
  tasks: Task[]
}): ReactElement {
  const runningTaskJobs = selectRunningTaskJobs(tasks, jobsByTaskId)

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>現在実行中のTask / Job</Text>
      {runningTaskJobs.length === 0 && (
        <Text style={styles.sectionEmpty}>実行中のTask / Jobはありません</Text>
      )}
      {runningTaskJobs.map(({ jobs, task }) => (
        <View key={task.id} style={styles.itemCard}>
          <View style={styles.itemHeader}>
            <Text style={styles.itemTitle} numberOfLines={2}>
              {task.title}
            </Text>
            {task.status === 'in_progress' && (
              <StatusBadge
                color={STATUS_COLOR.in_progress}
                status={task.status}
              />
            )}
          </View>
          {jobs.map((job) => (
            <View key={job.id} style={styles.jobRow}>
              <Text style={styles.jobCommand} numberOfLines={1}>
                {job.safeCommand.kind}
              </Text>
              <Text
                style={[styles.jobStatus, { color: STATUS_COLOR[job.status] }]}
              >
                {job.status}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}

function FailedTasksSection({
  jobsByTaskId,
  tasks,
}: {
  jobsByTaskId: Record<string, Job[]>
  tasks: Task[]
}): ReactElement {
  const failedTaskJobs = selectFailedTaskJobs(tasks, jobsByTaskId)

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>要対応Task</Text>
      {failedTaskJobs.length === 0 && (
        <Text style={styles.sectionEmpty}>要対応Taskはありません</Text>
      )}
      {failedTaskJobs.map(({ jobs, task }) => (
        <View key={task.id} style={styles.itemCard}>
          <Text style={styles.itemTitle} numberOfLines={2}>
            {task.title}
          </Text>
          {task.status === 'blocked' && (
            <Text style={[styles.failureText, { color: STATUS_COLOR.blocked }]}>
              停止中 / 要対応（Approval待ち・安全停止等を含む）
            </Text>
          )}
          {jobs.length > 0 && (
            <Text style={[styles.failureText, { color: STATUS_COLOR.failed }]}>
              実行失敗: {jobs.length}件
            </Text>
          )}
        </View>
      ))}
    </View>
  )
}

function RecentJobsSection({
  jobsByTaskId,
  tasks,
}: {
  jobsByTaskId: Record<string, Job[]>
  tasks: Task[]
}): ReactElement {
  const recentJobs = selectRecentJobs(tasks, jobsByTaskId)
  const taskTitleById = new Map(tasks.map((task) => [task.id, task.title]))

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Recent Jobs</Text>
      {recentJobs.length === 0 && (
        <Text style={styles.sectionEmpty}>Job履歴はありません</Text>
      )}
      {recentJobs.map((job) => (
        <View key={job.id} style={styles.itemCard}>
          <Text style={styles.itemTitle} numberOfLines={1}>
            {taskTitleById.get(job.taskId) ?? job.taskId}
          </Text>
          <View style={styles.jobRow}>
            <Text style={styles.jobCommand} numberOfLines={1}>
              {job.safeCommand.kind}
            </Text>
            <Text
              style={[styles.jobStatus, { color: STATUS_COLOR[job.status] }]}
            >
              {job.status}
            </Text>
          </View>
        </View>
      ))}
    </View>
  )
}

export default function ProjectDetailScreen(): ReactElement {
  const params = useLocalSearchParams()
  const projectId = normalizeProjectId(params.id)
  const [data, setData] = useState<ProjectDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  const loadProjectDetail = useCallback(async (): Promise<void> => {
    if (projectId === null || projectId.length === 0) {
      setError('Project IDが指定されていません')
      setLoading(false)
      return
    }

    try {
      setError(null)
      setNotFound(false)

      const project = await fetchProject(projectId)
      if (project === null) {
        setData(null)
        setNotFound(true)
        return
      }

      const tasks = await fetchTasks(projectId)
      const [jobsByTaskId, phases] = await Promise.all([
        fetchJobsByTaskId(tasks),
        fetchRoadmapPhases(projectId),
      ])
      setData({ jobsByTaskId, phases, project, tasks })
    } catch (loadError) {
      setError(getErrorMessage(loadError))
      Alert.alert('エラー', 'Project詳細の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  usePolling(loadProjectDetail, {
    enabled: isProjectDetailPollingEnabled(data),
    intervalMs: POLLING_INTERVAL_MS,
  })

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    )
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>← 戻る</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={2}>
          {data?.project.name ?? 'Project詳細'}
        </Text>
      </View>

      {error !== null && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {notFound && error === null && (
        <Text style={styles.empty}>Projectが見つかりません</Text>
      )}

      {data !== null && (
        <>
          <ProjectStatusSection project={data.project} />
          <GoalSection project={data.project} />
          <DesignPhilosophySection designPhilosophy={data.project.designPhilosophy} />
          <RoadmapSection phases={data.phases} tasks={data.tasks} />
          <TaskProgressSection tasks={data.tasks} />
          <RunningTaskJobsSection
            jobsByTaskId={data.jobsByTaskId}
            tasks={data.tasks}
          />
          <FailedTasksSection
            jobsByTaskId={data.jobsByTaskId}
            tasks={data.tasks}
          />
          <RecentJobsSection
            jobsByTaskId={data.jobsByTaskId}
            tasks={data.tasks}
          />
        </>
      )}

      <View style={styles.bottomSpacer} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  back: {
    marginRight: 12,
    paddingVertical: 4,
  },
  backText: {
    color: '#3b82f6',
    fontSize: 15,
  },
  bodyText: {
    color: '#d4d4d4',
    fontSize: 14,
    lineHeight: 20,
  },
  bulletText: {
    color: '#d4d4d4',
    fontSize: 14,
    lineHeight: 22,
  },
  phaseGoal: {
    color: '#a3a3a3',
    fontSize: 13,
    marginTop: 4,
  },
  progressBarTrack: {
    backgroundColor: '#2a2a2a',
    borderRadius: 6,
    height: 12,
    overflow: 'hidden',
    width: '100%',
  },
  progressBarFill: {
    backgroundColor: '#3b82f6',
    borderRadius: 6,
    height: '100%',
  },
  progressPercentText: {
    color: '#f5f5f5',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 10,
  },
  bottomSpacer: {
    height: 48,
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
    fontSize: 15,
    marginTop: 40,
    textAlign: 'center',
  },
  errorBox: {
    backgroundColor: '#2a1515',
    borderRadius: 8,
    marginBottom: 16,
    padding: 12,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
  },
  failureText: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 6,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    marginBottom: 20,
  },
  infoCard: {
    alignItems: 'flex-start',
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 16,
  },
  itemCard: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    marginBottom: 10,
    padding: 14,
  },
  itemHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  itemTitle: {
    color: '#f5f5f5',
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    marginRight: 10,
  },
  jobCommand: {
    color: '#d4d4d4',
    flex: 1,
    fontSize: 13,
  },
  jobRow: {
    alignItems: 'center',
    borderTopColor: '#2a2a2a',
    borderTopWidth: 1,
    flexDirection: 'row',
    marginTop: 10,
    paddingTop: 8,
  },
  jobStatus: {
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 8,
  },
  taskProgressSummary: {
    color: '#60a5fa',
    fontSize: 16,
    fontWeight: '700',
  },
  section: {
    marginBottom: 22,
  },
  sectionEmpty: {
    color: '#737373',
    fontSize: 14,
  },
  sectionTitle: {
    color: '#f5f5f5',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 10,
  },
  statusBadge: {
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  statusBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  statusBreakdown: {
    marginTop: 14,
    width: '100%',
  },
  statusBreakdownCount: {
    color: '#f5f5f5',
    fontSize: 13,
    fontWeight: '700',
  },
  statusBreakdownLabel: {
    color: '#d4d4d4',
    flex: 1,
    fontSize: 13,
  },
  statusBreakdownRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: 8,
  },
  statusDot: {
    borderRadius: 4,
    height: 8,
    marginRight: 8,
    width: 8,
  },
  title: {
    color: '#fff',
    flex: 1,
    fontSize: 22,
    fontWeight: '700',
  },
})
