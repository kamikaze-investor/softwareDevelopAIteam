import type { AgentRole, RoadmapTaskCategory, StructuredConstraint } from '@ai-team/shared'

// category の型そのものは packages/shared/src/types/project_roadmap.ts が正本
// （Roadmap生成のZod schemaとも共有するため。Meta Reviewer指摘、2026-09-01）。
export type { RoadmapTaskCategory }

export interface RoadmapSyncTaskInput {
  roadmapTaskKey: string
  title: string
  description: string
  phase: number
  assignee: AgentRole
  category: RoadmapTaskCategory
  dependencies: string[]
  acceptanceCriteria: string[]
  allowedPaths: string[]
}

export interface RoadmapTaskSpecConflict {
  roadmapTaskKey: string
  field: 'title' | 'description' | 'phase' | 'assignee' | 'allowedPaths' | 'acceptanceCriteria' | 'dependencies'
}

export interface RoadmapSyncPhaseInput {
  phaseNumber: number
  name: string
  goal: string
}

export interface RoadmapPhaseSpecConflict {
  phaseNumber: number
  field: 'name' | 'goal'
}

export type RoadmapValidationIssueCode =
  | 'duplicate_roadmap_task_key'
  | 'unknown_dependency'
  | 'self_dependency'
  | 'circular_dependency'
  | 'empty_roadmap'
  | 'duplicate_phase_number'
  | 'unknown_phase'
  | 'task_count_exceeded'
  | 'disallowed_path'
  | 'dependency_count_exceeded'
  | 'control_plane_operation_task'

export interface RoadmapValidationIssue {
  code: RoadmapValidationIssueCode
  roadmapTaskKey?: string
  phaseNumber?: number
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

function buildDuplicatePhaseIssues(phases: RoadmapSyncPhaseInput[]): RoadmapValidationIssue[] {
  const counts = new Map<number, number>()
  for (const phase of phases) {
    counts.set(phase.phaseNumber, (counts.get(phase.phaseNumber) ?? 0) + 1)
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([phaseNumber]) => ({
      code: 'duplicate_phase_number' as const,
      phaseNumber,
      message: `Duplicate phaseNumber: ${phaseNumber}`,
    }))
}

function buildUnknownPhaseIssues(
  tasks: RoadmapSyncTaskInput[],
  phaseNumbers: Set<number>,
): RoadmapValidationIssue[] {
  return tasks
    .filter((task) => !phaseNumbers.has(task.phase))
    .map((task) => ({
      code: 'unknown_phase' as const,
      roadmapTaskKey: task.roadmapTaskKey,
      phaseNumber: task.phase,
      message: `Task ${task.roadmapTaskKey} references unknown phase ${task.phase}`,
    }))
}

/**
 * DB書き込み前に、Roadmap Phase自身の自己整合性を検証する（DBは見ない）。
 * Task側の`phase`が実在するPhaseを参照しているかもここで検証する。
 */
export function validateRoadmapPhases(
  phases: RoadmapSyncPhaseInput[],
  tasks: RoadmapSyncTaskInput[],
): RoadmapValidationIssue[] {
  const phaseNumbers = new Set(phases.map((phase) => phase.phaseNumber))

  return [
    ...buildDuplicatePhaseIssues(phases),
    ...buildUnknownPhaseIssues(tasks, phaseNumbers),
  ]
}

// ────────────────────────────────────────────────────────────
// 構造化制約（Structured Constraints）の機械的検証
//
// ここではタスク一覧の構造化フィールドから機械的に数えられる制約だけを検証する
// （max_task_count / allowed_path_prefixes / max_dependency_count / category拒否）。
//
// 承認済みギャップ（ACKNOWLEDGED-GAP-constraint-validation）:
//   forbidden_new_files と forbidden_technologies は意味的判断が必要（このdiff計画が
//   新規ファイルを生むか？/ この説明が禁止技術を暗示するか？）なため、機械的検証は
//   行わない。これらは別途設計中のセマンティックReview経路の責務である。
//   本関数はこれらのkindを検証対象とせず、返り値の`checkedKinds`で「何を検証したか」を
//   明示する。`uncheckedKinds`に含まれるkindは検証していないという事実を監査可能にする。
// ────────────────────────────────────────────────────────────

export interface RoadmapConstraintValidationResult {
  issues: RoadmapValidationIssue[]
  checkedKinds: string[]
  uncheckedKinds: string[]
}

const KINDS_NOT_MECHANICALLY_CHECKED = ['forbidden_new_files', 'forbidden_technologies'] as const

function buildMaxTaskCountIssues(
  tasks: RoadmapSyncTaskInput[],
  constraint: StructuredConstraint,
): RoadmapValidationIssue[] {
  if (typeof constraint.value !== 'number') return []
  if (tasks.length <= constraint.value) return []
  return [{
    code: 'task_count_exceeded' as const,
    message: `Task count ${tasks.length} exceeds max_task_count constraint (${constraint.value})`,
  }]
}

/**
 * pathがprefixのpath-segment境界で始まっているかを判定する。
 * 単純な`path.startsWith(prefix)`だと、prefix="apps/eng"がpath="apps/engine-evil/x.ts"にも
 * マッチしてしまう（ディレクトリ境界を無視した文字列prefix一致）。allowed_path_prefixesは
 * scope境界そのものを強制する制約のため、この取り違えは許容しない。
 */
function matchesPathPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true
  const boundedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`
  return path.startsWith(boundedPrefix)
}

function buildDisallowedPathIssues(
  tasks: RoadmapSyncTaskInput[],
  constraint: StructuredConstraint,
): RoadmapValidationIssue[] {
  if (!Array.isArray(constraint.value)) return []
  const prefixes = constraint.value
  const issues: RoadmapValidationIssue[] = []
  for (const task of tasks) {
    for (const path of task.allowedPaths) {
      if (!prefixes.some((prefix) => matchesPathPrefix(path, prefix))) {
        issues.push({
          code: 'disallowed_path' as const,
          roadmapTaskKey: task.roadmapTaskKey,
          message: `Task ${task.roadmapTaskKey} has disallowed path "${path}" (allowed prefixes: ${prefixes.join(', ')})`,
        })
      }
    }
  }
  return issues
}

function buildDependencyCountIssues(
  tasks: RoadmapSyncTaskInput[],
  constraint: StructuredConstraint,
): RoadmapValidationIssue[] {
  if (typeof constraint.value !== 'number') return []
  const issues: RoadmapValidationIssue[] = []
  for (const task of tasks) {
    if (task.dependencies.length > constraint.value) {
      issues.push({
        code: 'dependency_count_exceeded' as const,
        roadmapTaskKey: task.roadmapTaskKey,
        message: `Task ${task.roadmapTaskKey} has ${task.dependencies.length} dependencies (limit: ${constraint.value})`,
      })
    }
  }
  return issues
}

function buildControlPlaneOperationIssues(tasks: RoadmapSyncTaskInput[]): RoadmapValidationIssue[] {
  const issues: RoadmapValidationIssue[] = []
  for (const task of tasks) {
    if (task.category === 'control_plane_operation') {
      issues.push({
        code: 'control_plane_operation_task' as const,
        roadmapTaskKey: task.roadmapTaskKey,
        message: `Task ${task.roadmapTaskKey} duplicates AIteamOS control-plane machinery (category: control_plane_operation) and must not exist as a Task`,
      })
    }
  }
  return issues
}

/**
 * DB書き込み前に、生成されたRoadmapが Structured Constraints に機械的に適合するか検証する。
 * 検証対象はタスク一覧の構造化フィールドのみ（DBは見ず、意味的判断はしない）。
 *
 * NOTE: セマンティックReview経路の責務である forbidden_new_files / forbidden_technologies の
 * 機械的チェックは意図的に行わない（ACKNOWLEDGED-GAP-constraint-validation）。
 * 本関数はcheckedKinds / uncheckedKinds で「何を検証したか」を明示し、検証漏れを隠さない。
 */
export function validateRoadmapConstraints(
  tasks: RoadmapSyncTaskInput[],
  constraints: StructuredConstraint[],
): RoadmapConstraintValidationResult {
  const issues: RoadmapValidationIssue[] = []
  const checkedKinds = new Set<string>()
  const uncheckedKinds = new Set<string>()

  for (const constraint of constraints) {
    switch (constraint.kind) {
      case 'max_task_count':
        issues.push(...buildMaxTaskCountIssues(tasks, constraint))
        checkedKinds.add('max_task_count')
        break
      case 'allowed_path_prefixes':
        issues.push(...buildDisallowedPathIssues(tasks, constraint))
        checkedKinds.add('allowed_path_prefixes')
        break
      case 'max_dependency_count':
        issues.push(...buildDependencyCountIssues(tasks, constraint))
        checkedKinds.add('max_dependency_count')
        break
      case 'forbidden_new_files':
      case 'forbidden_technologies':
        uncheckedKinds.add(constraint.kind)
        break
      case 'other':
        // 'other' is user-supplied free-form; nothing mechanical to check here.
        checkedKinds.add('other')
        break
      default:
        uncheckedKinds.add(String(constraint.kind))
    }
  }

  // カテゴリ拒否は常に強制（structuredConstraints の有無に関わらず実行）
  issues.push(...buildControlPlaneOperationIssues(tasks))

  return {
    issues,
    checkedKinds: [...checkedKinds].sort(),
    uncheckedKinds: [...uncheckedKinds].sort(),
  }
}
