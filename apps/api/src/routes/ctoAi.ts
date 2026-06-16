/**
 * CTO AI API Routes（task-101）
 *
 * POST /api/cto/analyze
 *   仕様書テキストを受け取り、Project Memory を生成して target-project に書き出す。
 *   Readiness Score が 70 未満の場合は Gap 一覧を返して開発開始を保留する。
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { analyzeSpec } from '../ctoAi/specAnalyzer.js'
import { writeProjectMemory } from '../ctoAi/projectMemoryWriter.js'

const AnalyzeBody = z.object({
  /** 仕様書テキスト（Markdown） */
  specText: z.string().min(50, '仕様書が短すぎます（最低50文字）'),
  /** target-project のルートパス（絶対パス） */
  targetProjectRoot: z.string().min(1),
  /** テスト用モックレスポンス（本番では使わない） */
  mockResponse: z.string().optional(),
})

export async function ctoAiRoutes(app: FastifyInstance): Promise<void> {

  // POST /api/cto/analyze
  app.post('/analyze', async (req, reply) => {
    const parsed = AnalyzeBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }

    const { specText, targetProjectRoot, mockResponse } = parsed.data

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
      const isApiKeyError = err.message?.includes('ANTHROPIC_API_KEY')
      return reply.status(isApiKeyError ? 503 : 500).send({
        error: isApiKeyError
          ? 'ANTHROPIC_API_KEY が設定されていません'
          : 'CTO AI の実行に失敗しました',
        detail: err.message,
      })
    }
  })
}
