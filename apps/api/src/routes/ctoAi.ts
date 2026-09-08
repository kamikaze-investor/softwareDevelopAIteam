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
import { analyzeSpec, StructuredConstraintSchema } from '../ctoAi/specAnalyzer.js'
import { writeProjectMemory } from '../ctoAi/projectMemoryWriter.js'
import { initializeApprovedProject, ProjectInitializationError } from '../ctoAi/projectInitialization.js'
import { isProjectDefinitionReady } from '../ctoAi/projectDefinitionAnalysis.js'
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
    structuredConstraints: z.array(StructuredConstraintSchema).default([]),
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
      const readiness = isProjectDefinitionReady(analysis)

      return reply.status(201).send({
        status: readiness.ready ? 'ready' : 'gaps_found',
        readinessScore: analysis.readinessScore,
        readinessReason: analysis.readinessReason,
        mustResolveGaps: readiness.importantGaps,
        writtenFiles: writeResult.writtenFiles,
        targetDir: writeResult.targetDir,
        analysis,
        message: readiness.ready
          ? `準備完了（スコア: ${analysis.readinessScore}/100）。開発を開始できます。`
          : `${readiness.reason}: ${analysis.readinessReason}`,
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

  // POST /api/cto/generate-roadmap was removed in PR C.
  //
  // It called initializeApprovedProject() without writeProjectMemory, so
  // projectInitialization short-circuited straight to Task sync: no Gemini focused reviews,
  // no integration review, no evidence registered. That made it a second Roadmap workflow
  // bypassing the review gate entirely, which contradicts the guarantee this PR exists to
  // establish -- that every Roadmap reaching Task sync was reviewed under the current topology.
  //
  // It had no legitimate consumer: not referenced by Mobile, by any script, doc or CI job,
  // only by its own tests, and 0 production invocations in the checked window. Roadmap
  // generation runs through the canonical Project-start path instead
  // (projectStartWorkflow -> initializeApprovedProject with writeProjectMemory).
  //
  // Deliberately NOT "fixed" by passing writeProjectMemory: a second entry point into the same
  // workflow is a drift source, and the guarantee would then depend on two paths agreeing
  // forever (CEO judgement, 2026-09-08).
}
