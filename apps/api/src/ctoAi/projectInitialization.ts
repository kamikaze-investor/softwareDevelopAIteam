import type { Project } from '@ai-team/shared'
import {
  buildDefaultCoordinatorDeps,
  createAndExecuteRoadmapReview,
  type CoordinatorDeps,
  type ExecuteDesignReviewResult,
} from '../designReview/designReviewCoordinator.js'
import { checkRoadmapDesignReviewFreshness } from '../designReviewEvidencePolicy.js'
import type { IStorage } from '../storage/interface.js'
import {
  validateRoadmapConstraints,
  validateRoadmapPhases,
  validateRoadmapTasks,
  type RoadmapSyncPhaseInput,
  type RoadmapSyncTaskInput,
} from '../storage/roadmapTaskValidation.js'
import { writeProjectMemory } from './projectMemoryWriter.js'
import { createInitialImplementWorkflow } from './initialImplementWorkflow.js'
import { generateRoadmap, type Roadmap, type RoadmapGeneratorOptions } from './roadmapGenerator.js'
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

const ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS = 3

function isNonTerminalReviewStatus(status: ExecuteDesignReviewResult['status']): boolean {
  return status === 'requeued' || status === 'not_claimable' || status === 'stale'
}

/**
 * Drains the existing run-level bounded retry for the same roadmap review material.
 * Roadmap content only changes in the outer regeneration loop after a decisive CONFLICT.
 */
async function executeRoadmapReviewToTerminal(
  storage: IStorage,
  projectId: string,
  reviewMaterial: string,
  deps: CoordinatorDeps,
): Promise<ExecuteDesignReviewResult> {
  const SAFETY_CAP = 3
  let result: ExecuteDesignReviewResult | undefined
  for (let i = 0; i < SAFETY_CAP; i += 1) {
    result = await createAndExecuteRoadmapReview(storage, { projectId, reviewMaterial }, deps)
    if (!isNonTerminalReviewStatus(result.status)) {
      return result
    }
  }

  if (!result) {
    throw new Error('unreachable: roadmap review terminal drain ran zero attempts')
  }
  return result
}

function buildRoadmapTasks(roadmap: Roadmap): RoadmapSyncTaskInput[] {
  return roadmap.tasks.map((task) => ({
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
}

function buildRoadmapPhases(roadmap: Roadmap): RoadmapSyncPhaseInput[] {
  return roadmap.phases.map((phase) => ({
    phaseNumber: phase.number,
    name: phase.name,
    goal: phase.goal,
  }))
}

/**
 * Adapts an already-approved Project into the SpecAnalysis shape consumed by roadmap generation.
 * It does not re-plan the Project Definition; Goal and Design Philosophy stay authoritative.
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
 * Initializes an approved Project from generated roadmap content.
 * Task sync runs only after deterministic validation and, when enabled, Whole-Roadmap Review pass.
 */
export async function initializeApprovedProject(
  storage: IStorage,
  project: Project,
  targetProjectRoot: string,
  options: ProjectInitializationOptions = {},
) {
  const analysis = options.analysis ?? buildApprovedProjectAnalysis(project)
  const projectMemory = options.writeProjectMemory
    ? writeProjectMemory(analysis, targetProjectRoot, {
        canonicalDefinitionText: options.canonicalDefinitionText,
      })
    : undefined

  let roadmap: Roadmap | undefined
  let roadmapTasks: RoadmapSyncTaskInput[] | undefined
  let roadmapPhases: RoadmapSyncPhaseInput[] | undefined
  let priorAttemptFeedback: string | undefined

  for (let attempt = 1; attempt <= ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
    const candidateRoadmap = await generateRoadmap(analysis, { ...options, priorAttemptFeedback })
    const candidateTasks = buildRoadmapTasks(candidateRoadmap)
    const candidatePhases = buildRoadmapPhases(candidateRoadmap)
    const constraintValidation = validateRoadmapConstraints(candidateTasks, analysis.structuredConstraints)
    const validationIssues = [
      ...validateRoadmapTasks(candidateTasks),
      ...validateRoadmapPhases(candidatePhases, candidateTasks),
      ...constraintValidation.issues,
    ]

    if (validationIssues.length > 0) {
      if (attempt === ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS) {
        throw new ProjectInitializationError('ロードマップの検証に失敗しました', 422, {
          issues: validationIssues,
          attempts: attempt,
        })
      }
      priorAttemptFeedback = `Deterministic validation failed: ${JSON.stringify(validationIssues)}`
      continue
    }

    if (!projectMemory) {
      roadmap = candidateRoadmap
      roadmapTasks = candidateTasks
      roadmapPhases = candidatePhases
      break
    }

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
      roadmapMarkdown: buildRoadmapMd(candidateRoadmap),
    })
    const deps = buildDefaultCoordinatorDeps()
    let freshness = checkRoadmapDesignReviewFreshness(
      project.id,
      reviewMaterial,
      storage.designReviewEvidence,
    )
    if (freshness.ok) {
      roadmap = candidateRoadmap
      roadmapTasks = candidateTasks
      roadmapPhases = candidatePhases
      break
    }

    const reviewResult = await executeRoadmapReviewToTerminal(storage, project.id, reviewMaterial, deps)
    freshness = checkRoadmapDesignReviewFreshness(
      project.id,
      reviewMaterial,
      storage.designReviewEvidence,
    )
    if (freshness.ok) {
      roadmap = candidateRoadmap
      roadmapTasks = candidateTasks
      roadmapPhases = candidatePhases
      break
    }

    if (reviewResult.decision === 'CONFLICT') {
      if (attempt === ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS) {
        throw new ProjectInitializationError(
          'Whole-Roadmap Design Review remained CONFLICT after bounded retry',
          422,
          {
            decision: 'CONFLICT',
            reason: reviewResult.error,
            attempts: attempt,
          },
        )
      }
      priorAttemptFeedback = reviewResult.error
        ?? 'Whole-Roadmap Design Review returned CONFLICT for the previous roadmap.'
      continue
    }

    throw new ProjectInitializationError(
      'Whole-Roadmap Design Review did not align or could not complete',
      422,
      {
        decision: reviewResult.decision,
        status: reviewResult.status,
        reason: reviewResult.error ?? freshness.reason,
        attempts: attempt,
      },
    )
  }

  if (!roadmap || !roadmapTasks || !roadmapPhases) {
    throw new Error('unreachable: roadmap recovery loop exited without an accepted roadmap or error')
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
