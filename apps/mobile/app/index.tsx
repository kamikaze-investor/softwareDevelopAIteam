/**
 * CEO Dashboard home screen.
 *
 * 30 Second Rule: show the project's current state within 30 seconds.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Project, Task, Job } from '@ai-team/shared'
import { router } from 'expo-router'
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'

declare const process: {
  env: {
    EXPO_PUBLIC_API_URL?: string
  }
}

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'
const MAX_TASKS_FOR_RECENT_JOBS = 3
const MAX_JOBS_PER_TASK = 2
const MAX_RECENT_JOBS = 5

async function fetchProjects(): Promise<Project[]> {
  const response = await fetch(`${API_BASE}/api/projects`)

  if (!response.ok) {
    throw new Error(`Failed to fetch projects: ${response.status}`)
  }

  return (await response.json()) as Project[]
}

async function fetchTasks(projectId: string): Promise<Task[]> {
  const response = await fetch(
    `${API_BASE}/api/tasks?projectId=${encodeURIComponent(projectId)}`,
  )

  if (!response.ok) {
    return []
  }

  return (await response.json()) as Task[]
}

async function fetchJobs(taskId: string): Promise<Job[]> {
  const response = await fetch(
    `${API_BASE}/api/jobs?taskId=${encodeURIComponent(taskId)}`,
  )

  if (!response.ok) {
    return []
  }

  return (await response.json()) as Job[]
}

async function fetchRecentJobs(taskIds: string[]): Promise<Job[]> {
  const selectedTaskIds = taskIds.slice(0, MAX_TASKS_FOR_RECENT_JOBS)
  const jobGroups = await Promise.all(selectedTaskIds.map(fetchJobs))

  return jobGroups
    .flatMap((jobs) => jobs.slice(0, MAX_JOBS_PER_TASK))
    .slice(0, MAX_RECENT_JOBS)
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

function ProjectCard({ project }: { project: Project }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [jobs, setJobs] = useState<Job[]>([])

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

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setError(null)
      const data = await fetchProjects()
      setProjects(data)
    } catch (loadError) {
      const message =
        loadError instanceof Error
          ? loadError.message
          : 'Failed to connect to API'
      setError(message)
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
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} />
      }
      style={styles.container}
    >
      <Text style={styles.title}>AI Development Team OS</Text>
      <Text style={styles.subtitle}>CEO Dashboard</Text>

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
        <ProjectCard key={project.id} project={project} />
      ))}

      <TouchableOpacity
        accessibilityRole="button"
        onPress={() => router.push('/create')}
        style={styles.createButton}
      >
        <Text style={styles.createText}>＋ 新規プロジェクト</Text>
      </TouchableOpacity>

      <TouchableOpacity
        accessibilityRole="button"
        onPress={load}
        style={styles.refreshButton}
      >
        <Text style={styles.refreshText}>Refresh</Text>
      </TouchableOpacity>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
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
    paddingBottom: 40,
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
})
