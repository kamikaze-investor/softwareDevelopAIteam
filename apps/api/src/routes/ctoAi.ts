/**
 * CTO AI API Routes（task-101）
 *
 * POST /api/cto/analyze
 *   仕様書テキストを受け取り、Project Memory を生成して target-project に書き出す。
 *   Readiness Score が 70 未満の場合は Gap 一覧を返して開発開始を保留する。
 */

import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import { z } from 'zod'
import { analyzeSpec } from '../ctoAi/specAnalyzer.js'
import { writeProjectMemory } from '../ctoAi/projectMemoryWriter.js'
import { initializeApprovedProject, ProjectInitializationError } from '../ctoAi/projectInitialization.js'
import { getStorage } from '../storage'
import { validateTargetRoot } from '../utils/pathGuard.js'

const CONFIGURED_TARGET_ROOT = process.env.TARGET_ROOT ?? '/workspace/target'

const AnalyzeBody = z.object({
  projectId: z.string().min(1),
  /** 仕様書テキスト（Markdown） */
  specText: z.string().min(50, '仕様書が短すぎます（最低50文字）'),
  /** target-project のルートパス（絶対パス） */
  targetProjectRoot: z.string().min(1),
  /** テスト用モックレスポンス（本番では使わない） */
  mockResponse: z.string().optional(),
})

const GenerateRoadmapBody = z.object({
  projectId: z.string().min(1),
  /** Project Memory が書かれた target-project のルートパス */
  targetProjectRoot: z.string().min(1),
  /** specAnalyzer の出力（analyze エンドポイントの analysis フィールド）を渡す */
  analysis: z.object({
    goal: z.string(),
    designPhilosophy: z.array(z.string()),
    mvpScope: z.object({
      description: z.string(),
      includedFeatures: z.array(z.string()),
      excludedFeatures: z.array(z.string()),
    }),
    targetUsers: z.array(z.string()),
    techStack: z.array(z.string()),
    gaps: z.array(z.any()),
    requiredExternalServices: z.array(z.any()),
    readinessScore: z.number(),
    readinessReason: z.string(),
  }),
  /** テスト用モックレスポンス */
  mockResponse: z.string().optional(),
})

export async function ctoAiRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  // POST /api/cto/analyze
  app.post('/analyze', async (req, reply) => {
    const parsed = AnalyzeBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }

    const { projectId, specText, targetProjectRoot, mockResponse } = parsed.data

    const project = storage.projects.findById(projectId)
    if (!project) return reply.status(404).send({ error: 'Project not found' })

    if (project.status !== 'running') {
      return reply.status(409).send({ error: 'Project is not running', detail: `status=${project.status}` })
    }

    // [codex-review P1] パス境界検証
    const pathCheck = validateTargetRoot(targetProjectRoot)
    if (!pathCheck.ok) {
      return reply.status(400).send({ error: 'パス検証エラー', detail: pathCheck.reason })
    }

    if (path.resolve(targetProjectRoot) !== path.resolve(CONFIGURED_TARGET_ROOT)) {
      return reply.status(400).send({
        error: 'targetProjectRoot が設定値と一致しません',
        detail: `configured=${CONFIGURED_TARGET_ROOT}`,
      })
    }

    try {
      // 1. 仕様書解析（ANTHROPIC_API_KEY は環境変数から）
      const analysis = await analyzeSpec(specText, { mockResponse })

      // 2. Project Memory 書き出し
      const writeResult = writeProjectMemory(analysis, targetProjectRoot)

      // 3. Readiness チェック
      const isReady = analysis.readinessScore >= 70
      const mustResolveGaps = analysis.gaps.filter(g => g.severity === 'must_resolve')

      return reply.status(201).send({
        status: isReady ? 'ready' : 'gaps_found',
        readinessScore: analysis.readinessScore,
        readinessReason: analysis.readinessReason,
        mustResolveGaps,
        writtenFiles: writeResult.writtenFiles,
        targetDir: writeResult.targetDir,
        analysis,
        message: isReady
          ? `準備完了（スコア: ${analysis.readinessScore}/100）。開発を開始できます。`
          : `Gap が ${mustResolveGaps.length} 件あります。解決後に再度実行してください。`,
      })
    } catch (err: any) {
      if (err instanceof ProjectInitializationError) {
        return reply.status(err.statusCode).send({ error: err.message, ...err.details })
      }
      const isApiKeyError = err.message?.includes('ANTHROPIC_API_KEY')
      return reply.status(isApiKeyError ? 503 : 500).send({
        error: isApiKeyError
          ? 'ANTHROPIC_API_KEY が設定されていません'
          : 'CTO AI の実行に失敗しました',
        detail: err.message,
      })
    }
  })

  // POST /api/cto/generate-roadmap
  app.post('/generate-roadmap', async (req, reply) => {
    const parsed = GenerateRoadmapBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }

    const { projectId, analysis, targetProjectRoot, mockResponse } = parsed.data

    const project = storage.projects.findById(projectId)
    if (!project) return reply.status(404).send({ error: 'Project not found' })

    if (project.status !== 'running') {
      return reply.status(409).send({ error: 'Project is not running', detail: `status=${project.status}` })
    }

    // [codex-review P1] パス境界検証
    const pathCheck = validateTargetRoot(targetProjectRoot)
    if (!pathCheck.ok) {
      return reply.status(400).send({ error: 'パス検証エラー', detail: pathCheck.reason })
    }

    if (path.resolve(targetProjectRoot) !== path.resolve(CONFIGURED_TARGET_ROOT)) {
      return reply.status(400).send({
        error: 'targetProjectRoot が設定値と一致しません',
        detail: `configured=${CONFIGURED_TARGET_ROOT}`,
      })
    }

    try {
      const result = await initializeApprovedProject(storage, project, targetProjectRoot, {
        analysis,
        mockResponse,
      })
      const { roadmap, syncResult, initialWorkflow } = result

      return reply.status(201).send({
        status: 'roadmap_generated',
        totalTasks: roadmap.totalTasks,
        estimatedWeeks: roadmap.estimatedWeeks,
        phaseCount: roadmap.phases.length,
        syncSummary: {
          created: syncResult.createdTaskIds.length,
          updated: syncResult.updatedTaskIds.length,
          reactivated: syncResult.reactivatedTaskIds.length,
          deactivated: syncResult.deactivatedTaskIds.length,
          phasesCreated: syncResult.createdPhaseNumbers.length,
          phasesUpdated: syncResult.updatedPhaseNumbers.length,
          phasesReactivated: syncResult.reactivatedPhaseNumbers.length,
          phasesDeactivated: syncResult.deactivatedPhaseNumbers.length,
        },
        initialWorkflow,
        writtenFiles: result.writtenFiles,
        targetDir: result.targetDir,
        roadmap,
        message: `ロードマップを生成しました（${roadmap.totalTasks} タスク / ${roadmap.phases.length} フェーズ）`,
      })
    } catch (err: any) {
      if (err instanceof ProjectInitializationError) {
        return reply.status(err.statusCode).send({ error: err.message, ...err.details })
      }
      const isApiKeyError = err.message?.includes('ANTHROPIC_API_KEY')
      return reply.status(isApiKeyError ? 503 : 500).send({
        error: isApiKeyError
          ? 'ANTHROPIC_API_KEY が設定されていません'
          : 'Roadmap 生成に失敗しました',
        detail: err.message,
      })
    }
  })
}
