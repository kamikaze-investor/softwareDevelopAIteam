import type { Project } from '@ai-team/shared'
import type { IStorage } from '../storage/interface.js'
import { validateRoadmapPhases, validateRoadmapTasks, type RoadmapSyncPhaseInput, type RoadmapSyncTaskInput } from '../storage/roadmapTaskValidation.js'
import { writeProjectMemory } from './projectMemoryWriter.js'
import { createInitialImplementWorkflow } from './initialImplementWorkflow.js'
import { generateRoadmap, type RoadmapGeneratorOptions } from './roadmapGenerator.js'
import { writeRoadmap } from './roadmapWriter.js'
import type { SpecAnalysis } from './specAnalyzer.js'

export class ProjectInitializationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 409 | 422,
    readonly details: Record<string, unknown>,
  ) {
    super(message)
  }
}

/**
 * Project の承認済み入力を、既存のCTO AI生成器が受け取るSpecAnalysisへ写像する。
 * これは新しいplanning規則ではなく、Project作成時に既に保存済みのGoal/Design Philosophyを
 * Roadmap生成器の既存入力形式に合わせるアダプタである。
 */
export function buildApprovedProjectAnalysis(project: Project): SpecAnalysis {
  return {
    goal: project.goal,
    designPhilosophy: project.designPhilosophy,
    mvpScope: {
      description: project.goal,
      includedFeatures: [],
      excludedFeatures: [],
    },
    targetUsers: [],
    techStack: [],
    gaps: [],
    structuredConstraints: [],
    requiredExternalServices: [],
    readinessScore: 100,
    readinessReason: 'Project start has been approved by the existing Project status transition.',
  }
}

export interface ProjectInitializationOptions extends RoadmapGeneratorOptions {
  analysis?: SpecAnalysis
  writeProjectMemory?: boolean
}

/**
 * 承認済みProjectの既存初期化処理を一箇所に集約する。
 * DB同期・Markdown保存の成功後だけ、既存の初回Implement workflow producerを呼ぶ。
 */
export async function initializeApprovedProject(
  storage: IStorage,
  project: Project,
  targetProjectRoot: string,
  options: ProjectInitializationOptions = {},
) {
  const analysis = options.analysis ?? buildApprovedProjectAnalysis(project)
  const roadmap = await generateRoadmap(analysis, options)
  const roadmapTasks: RoadmapSyncTaskInput[] = roadmap.tasks.map((task) => ({
    roadmapTaskKey: task.id,
    title: task.title,
    description: task.description,
    phase: task.phase,
    assignee: task.assignee,
    dependencies: task.dependencies,
    acceptanceCriteria: task.acceptanceCriteria,
    allowedPaths: task.allowedPaths,
  }))
  const roadmapPhases: RoadmapSyncPhaseInput[] = roadmap.phases.map((phase) => ({
    phaseNumber: phase.number,
    name: phase.name,
    goal: phase.goal,
  }))
  const validationIssues = [
    ...validateRoadmapTasks(roadmapTasks),
    ...validateRoadmapPhases(roadmapPhases, roadmapTasks),
  ]
  if (validationIssues.length > 0) {
    throw new ProjectInitializationError('ロードマップの検証に失敗しました', 422, { issues: validationIssues })
  }

  const syncResult = storage.tasks.syncRoadmapTasks({
    projectId: project.id,
    tasks: roadmapTasks,
    phases: roadmapPhases,
  })
  if (!syncResult.ok) {
    throw new ProjectInitializationError('ロードマップの同期に失敗しました', 409, {
      detail: syncResult.failureReason,
      conflicts: syncResult.conflicts,
      phaseConflicts: syncResult.phaseConflicts,
    })
  }

  const projectMemory = options.writeProjectMemory
    ? writeProjectMemory(analysis, targetProjectRoot, {
        canonicalDefinitionText: options.canonicalDefinitionText,
      })
    : { writtenFiles: [] as string[] }
  const roadmapFiles = writeRoadmap(roadmap, targetProjectRoot)
  const initialWorkflow = await Promise.all(
    syncResult.createdTaskIds.map((taskId) => createInitialImplementWorkflow(storage, taskId)),
  )

  return {
    analysis,
    initialWorkflow,
    roadmap,
    syncResult,
    writtenFiles: [...projectMemory.writtenFiles, ...roadmapFiles.writtenFiles],
    targetDir: roadmapFiles.targetDir,
  }
}
