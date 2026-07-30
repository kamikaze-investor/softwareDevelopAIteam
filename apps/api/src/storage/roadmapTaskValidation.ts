import type { AgentRole } from '@ai-team/shared'

export interface RoadmapSyncTaskInput {
  roadmapTaskKey: string
  title: string
  description: string
  phase: number
  assignee: AgentRole
  dependencies: string[]
  acceptanceCriteria: string[]
  allowedPaths: string[]
}

export interface RoadmapTaskSpecConflict {
  roadmapTaskKey: string
  field: 'title' | 'description' | 'phase' | 'assignee' | 'allowedPaths' | 'acceptanceCriteria' | 'dependencies'
}

export type RoadmapValidationIssueCode =
  | 'duplicate_roadmap_task_key'
  | 'unknown_dependency'
  | 'self_dependency'
  | 'circular_dependency'
  | 'empty_roadmap'

export interface RoadmapValidationIssue {
  code: RoadmapValidationIssueCode
  roadmapTaskKey?: string
  message: string
}

function buildDuplicateIssues(tasks: RoadmapSyncTaskInput[]): RoadmapValidationIssue[] {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    counts.set(task.roadmapTaskKey, (counts.get(task.roadmapTaskKey) ?? 0) + 1)
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([roadmapTaskKey]) => ({
      code: 'duplicate_roadmap_task_key',
      roadmapTaskKey,
      message: `Duplicate roadmapTaskKey: ${roadmapTaskKey}`,
    }))
}

function buildDependencyIssues(
  tasks: RoadmapSyncTaskInput[],
  roadmapTaskKeys: Set<string>,
): RoadmapValidationIssue[] {
  const issues: RoadmapValidationIssue[] = []

  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.roadmapTaskKey) {
        issues.push({
          code: 'self_dependency',
          roadmapTaskKey: task.roadmapTaskKey,
          message: `Task ${task.roadmapTaskKey} depends on itself`,
        })
        continue
      }

      if (!roadmapTaskKeys.has(dependency)) {
        issues.push({
          code: 'unknown_dependency',
          roadmapTaskKey: task.roadmapTaskKey,
          message: `Task ${task.roadmapTaskKey} depends on unknown task ${dependency}`,
        })
      }
    }
  }

  return issues
}

function buildAdjacency(tasks: RoadmapSyncTaskInput[], roadmapTaskKeys: Set<string>): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()

  for (const task of tasks) {
    if (adjacency.has(task.roadmapTaskKey)) continue

    adjacency.set(
      task.roadmapTaskKey,
      task.dependencies.filter((dependency) => (
        dependency !== task.roadmapTaskKey && roadmapTaskKeys.has(dependency)
      )),
    )
  }

  return adjacency
}

function buildCircularDependencyIssues(
  tasks: RoadmapSyncTaskInput[],
  roadmapTaskKeys: Set<string>,
): RoadmapValidationIssue[] {
  const adjacency = buildAdjacency(tasks, roadmapTaskKeys)
  const visitState = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []
  const seenCycles = new Set<string>()
  const issues: RoadmapValidationIssue[] = []

  function recordCycle(repeatedKey: string): void {
    const cycleStartIndex = stack.indexOf(repeatedKey)
    const cycle = cycleStartIndex >= 0
      ? [...stack.slice(cycleStartIndex), repeatedKey]
      : [repeatedKey]
    const cycleKey = cycle.join(' -> ')

    if (seenCycles.has(cycleKey)) return
    seenCycles.add(cycleKey)
    issues.push({
      code: 'circular_dependency',
      roadmapTaskKey: repeatedKey,
      message: `Circular dependency detected: ${cycleKey}`,
    })
  }

  function visit(roadmapTaskKey: string): void {
    const state = visitState.get(roadmapTaskKey)
    if (state === 'visited') return
    if (state === 'visiting') {
      recordCycle(roadmapTaskKey)
      return
    }

    visitState.set(roadmapTaskKey, 'visiting')
    stack.push(roadmapTaskKey)

    for (const dependency of adjacency.get(roadmapTaskKey) ?? []) {
      visit(dependency)
    }

    stack.pop()
    visitState.set(roadmapTaskKey, 'visited')
  }

  for (const task of tasks) {
    visit(task.roadmapTaskKey)
  }

  return issues
}

/**
 * DB書き込み前に、ロードマップ全体の整合性を検証する。
 * 検証対象はロードマップ入力データ自身の自己整合性のみ（DBは見ない）。
 */
export function validateRoadmapTasks(tasks: RoadmapSyncTaskInput[]): RoadmapValidationIssue[] {
  const roadmapTaskKeys = new Set(tasks.map((task) => task.roadmapTaskKey))

  return [
    ...(tasks.length === 0 ? [{
      code: 'empty_roadmap' as const,
      message: 'Roadmap must include at least one task',
    }] : []),
    ...buildDuplicateIssues(tasks),
    ...buildDependencyIssues(tasks, roadmapTaskKeys),
    ...buildCircularDependencyIssues(tasks, roadmapTaskKeys),
  ]
}
