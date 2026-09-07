import type { Project, ProjectStartStage } from '@ai-team/shared'
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
  validateTechnicalUncertaintyRefs,
  validateRoadmapTasks,
  type RoadmapSyncPhaseInput,
  type RoadmapSyncTaskInput,
} from '../storage/roadmapTaskValidation.js'
import { writeProjectMemory } from './projectMemoryWriter.js'
import { createInitialImplementWorkflow } from './initialImplementWorkflow.js'
import { collectTechnicalUncertainties, generateRoadmap, type Roadmap, type RoadmapGeneratorOptions, type TechnicalUncertainty } from './roadmapGenerator.js'
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

/**
 * 参照されたAI調査対象の不確実性を、そのタスクの`description`へ決定論的に展開する。
 *
 * Implementerへ届く既存の唯一の経路は`Task.description`であり
 * （`buildInitialImplementAiCliPrompt()`はdescriptionとallowedPathsしか使わない。
 * Context Packは未配線）、生成AIが本文を書き写したかどうかに依存させると不変条件にならない。
 * 生成AIには構造化された参照（`technicalUncertaintyRefs`）だけを返させ、本文の展開は
 * ここで機械的に行う。
 */
function materializeUncertainties(
  description: string,
  refs: readonly string[] | undefined,
  uncertaintyByRef: ReadonlyMap<string, TechnicalUncertainty>,
): string {
  // Zod schemaは`.default([])`を持つが、この関数はテストのモック等
  // schemaを通らないRoadmapからも呼ばれうるため、欠損を許容する。
  const resolved = (refs ?? [])
    .map((ref) => uncertaintyByRef.get(ref))
    .filter((u): u is TechnicalUncertainty => u !== undefined)
  if (resolved.length === 0) return description

  return [
    description,
    '',
    '## 実装前に確定させる技術的事項',
    'CEOへは質問されていない。答えは既存のコード・仕様・テストの中にあるので、推測で決め打ちせず調べてから実装すること。',
    ...resolved.map((u) => `- ${u.description}（調査の手がかり: ${u.suggestion}）`),
  ].join('\n')
}

function buildRoadmapTasks(
  roadmap: Roadmap,
  uncertainties: readonly TechnicalUncertainty[] = [],
): RoadmapSyncTaskInput[] {
  const uncertaintyByRef = new Map(uncertainties.map((u) => [u.ref, u] as const))

  return roadmap.tasks.map((task) => ({
    roadmapTaskKey: task.id,
    title: task.title,
    description: materializeUncertainties(task.description, task.technicalUncertaintyRefs, uncertaintyByRef),
    phase: task.phase,
    assignee: task.assignee,
    category: task.category,
    dependencies: task.dependencies,
    acceptanceCriteria: task.acceptanceCriteria,
    allowedPaths: task.allowedPaths,
    technicalUncertaintyRefs: task.technicalUncertaintyRefs,
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

/**
 * 現行Roadmap（roadmapActiveなTask）全件について、初回Implement Jobが存在することを保証する。
 *
 * crash後のresumeでも使う。**既に永続化されたRoadmapが権威**であり、resume時にRoadmapを
 * 生成し直さない — LLM生成は非決定的なので、再生成すると旧Roadmap由来のTaskが非活性化され、
 * 別内容のTaskが作られてしまう。既にsync済みのRoadmapがあるなら、それを正として
 * 「まだJobが無いTaskへJobを作る」だけで安全に完了へ持っていける。
 */
export async function ensureInitialWorkflowsForActiveTasks(
  storage: IStorage,
  projectId: string,
  deps?: CoordinatorDeps,
): Promise<Array<Awaited<ReturnType<typeof createInitialImplementWorkflow>>>> {
  const activeTaskIds = storage.tasks
    .findByProjectId(projectId)
    .filter((task) => task.roadmapActive)
    .map((task) => task.id)

  // 候補をactive Task全件にしても、実際にJobが作られるかは
  // `createInitialImplementWorkflow()`が既存のeligibility判定で決める。ここでゲートを
  // 迂回しないことが重要で、依存未達のTaskは`dependencies are not yet done`でskipされ、
  // 既にJobがあるTaskは`initial workflow job already exists`でskipされる。
  return Promise.all(
    activeTaskIds.map((taskId) => (
      deps ? createInitialImplementWorkflow(storage, taskId, deps) : createInitialImplementWorkflow(storage, taskId)
    )),
  )
}

export interface ProjectInitializationOptions extends RoadmapGeneratorOptions {
  /**
   * 進行段階の通知。Project開始workflowがstageを永続化するために使う。
   * **実際に到達した段階でのみ呼ぶ**（見せかけの進捗を出さないため、観測できない
   * 段階は通知しない）。未指定なら何もしない＝既存の呼び出し元の挙動は不変。
   */
  onStage?: (stage: ProjectStartStage) => void
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

  // AI調査対象の不確実性は analysis から決定論的に導出する（生成・検証・展開が同じIDを再計算する）。
  const technicalUncertainties = collectTechnicalUncertainties(analysis)
  const notifyStage = (stage: ProjectStartStage): void => { options.onStage?.(stage) }

  for (let attempt = 1; attempt <= ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
    notifyStage(attempt === 1 ? 'roadmap_generation' : 'roadmap_regeneration')
    const candidateRoadmap = await generateRoadmap(analysis, { ...options, priorAttemptFeedback })
    notifyStage('deterministic_validation')
    const candidateTasks = buildRoadmapTasks(candidateRoadmap, technicalUncertainties)
    const candidatePhases = buildRoadmapPhases(candidateRoadmap)
    const constraintValidation = validateRoadmapConstraints(candidateTasks, analysis.structuredConstraints)
    const validationIssues = [
      ...validateRoadmapTasks(candidateTasks),
      ...validateRoadmapPhases(candidatePhases, candidateTasks),
      ...constraintValidation.issues,
      // 参照漏れ・未知refは生成品質エラーとして扱い、既存のbounded retryで再生成させる。
      // 新しいGate/Queueは追加しない。
      ...validateTechnicalUncertaintyRefs(candidateTasks, technicalUncertainties.map((u) => u.ref)),
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

    // Whole-Roadmap Reviewは現状1回の実行でfocused/integration/independentをまとめて返す。
    // 観測できるのはこの単位なので、ここでは`focused_review`だけを通知する。
    // `feasibility_review` / `integration_review`はprovider topology変更で実際に
    // 独立した段になった時点で通知する（観測できない段階を先に出さない）。
    notifyStage('focused_review')
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

  notifyStage('task_sync')
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
  // 初回Jobは`createdTaskIds`ではなく**現行Roadmapのactive Task全件**に対して用意する。
  // replay時（既にsync済みのTaskがある状態での再実行）は`createdTaskIds`が空になるため、
  // それだけを見ているとJobが1件も作られないまま完了扱いになる（独立レビュー指摘、2026-09-07）。
  // `createInitialImplementWorkflow()`は既存Jobがあればskipするので、繰り返し呼んでも重複しない。
  const initialWorkflow = await ensureInitialWorkflowsForActiveTasks(storage, project.id)

  return {
    analysis,
    initialWorkflow,
    roadmap,
    syncResult,
    writtenFiles: [...(projectMemory?.writtenFiles ?? []), ...roadmapFiles.writtenFiles],
    targetDir: roadmapFiles.targetDir,
  }
}
