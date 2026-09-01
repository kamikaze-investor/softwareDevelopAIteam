import type { Project } from '@ai-team/shared'
import { buildDefaultCoordinatorDeps, createAndExecuteRoadmapReview } from '../designReview/designReviewCoordinator.js'
import { checkRoadmapDesignReviewFreshness } from '../designReviewEvidencePolicy.js'
import type { IStorage } from '../storage/interface.js'
import { validateRoadmapConstraints, validateRoadmapPhases, validateRoadmapTasks, type RoadmapSyncPhaseInput, type RoadmapSyncTaskInput } from '../storage/roadmapTaskValidation.js'
import { writeProjectMemory } from './projectMemoryWriter.js'
import { createInitialImplementWorkflow } from './initialImplementWorkflow.js'
import { generateRoadmap, type RoadmapGeneratorOptions } from './roadmapGenerator.js'
import { buildSpecTextFromProjectDefinition } from './projectDefinitionAnalysis.js'
import { composeRoadmapReviewMaterial } from './roadmapReviewMaterial.js'
import { buildRoadmapMd, writeRoadmap } from './roadmapWriter.js'
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
    category: task.category,
    dependencies: task.dependencies,
    acceptanceCriteria: task.acceptanceCriteria,
    allowedPaths: task.allowedPaths,
  }))
  const roadmapPhases: RoadmapSyncPhaseInput[] = roadmap.phases.map((phase) => ({
    phaseNumber: phase.number,
    name: phase.name,
    goal: phase.goal,
  }))
  const constraintValidation = validateRoadmapConstraints(roadmapTasks, analysis.structuredConstraints)
  const validationIssues = [
    ...validateRoadmapTasks(roadmapTasks),
    ...validateRoadmapPhases(roadmapPhases, roadmapTasks),
    ...constraintValidation.issues,
  ]
  if (validationIssues.length > 0) {
    throw new ProjectInitializationError('ロードマップの検証に失敗しました', 422, { issues: validationIssues })
  }

  const projectMemory = options.writeProjectMemory
    ? writeProjectMemory(analysis, targetProjectRoot, {
        canonicalDefinitionText: options.canonicalDefinitionText,
      })
    : undefined

  if (projectMemory) {
    const canonicalDefinitionText = options.canonicalDefinitionText
      ?? buildSpecTextFromProjectDefinition({
        goal: analysis.goal,
        designPhilosophy: analysis.designPhilosophy,
      })
    const reviewMaterial = composeRoadmapReviewMaterial({
      canonicalDefinitionText,
      definitionHash: projectMemory.definitionHash,
      structuredConstraints: analysis.structuredConstraints,
      constraintsHash: projectMemory.constraintsHash,
      roadmapMarkdown: buildRoadmapMd(roadmap),
    })
    const deps = buildDefaultCoordinatorDeps()
    let freshness = checkRoadmapDesignReviewFreshness(
      project.id,
      reviewMaterial,
      storage.designReviewEvidence,
    )
    if (!freshness.ok) {
      await createAndExecuteRoadmapReview(storage, { projectId: project.id, reviewMaterial }, deps)
      freshness = checkRoadmapDesignReviewFreshness(
        project.id,
        reviewMaterial,
        storage.designReviewEvidence,
      )
    }
    if (!freshness.ok) {
      throw new ProjectInitializationError(
        'Whole-Roadmap Design Review did not align or could not complete',
        422,
        { code: freshness.code, reason: freshness.reason },
      )
    }
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

  const roadmapFiles = writeRoadmap(roadmap, targetProjectRoot)
  const initialWorkflow = await Promise.all(
    syncResult.createdTaskIds.map((taskId) => createInitialImplementWorkflow(storage, taskId)),
  )

  return {
    analysis,
    initialWorkflow,
    roadmap,
    syncResult,
    writtenFiles: [...(projectMemory?.writtenFiles ?? []), ...roadmapFiles.writtenFiles],
    targetDir: roadmapFiles.targetDir,
  }
}
