/**
 * Developer AI API Routes（task-104）
 *
 * POST /api/developer-ai/run
 *   Context Pack の instruction を受け取り、AI CLI を target-project で実行する。
 *   mockRun=true でテスト実行が可能（実際のAI呼び出しをスキップ）。
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { runDeveloperAi } from '../ctoAi/developerAiOrchestrator.js'
import { validateTargetRoot } from '../utils/pathGuard.js'

const RunBody = z.object({
  provider: z.enum(['claude', 'codex', 'gemini']).default('claude'),
  instruction: z.string().min(1, 'instruction が空です'),
  targetProjectRoot: z.string().min(1),
  taskId: z.string().min(1),
  timeoutMs: z.number().int().positive().default(300_000),
  /** テスト用フラグ: true のとき実際の AI 実行をスキップ */
  mockRun: z.boolean().default(false),
  /**
   * [codex-review P2] 手動承認ゲート
   * 仕様「投稿は手動確認あり」の実行前ガード。
   * false（デフォルト）のまま実行すると 403 を返す。
   * ユーザーが明示的に approved: true を設定した場合のみ実行する。
   */
  approved: z.boolean().default(false),
})

export async function developerAiRoutes(app: FastifyInstance): Promise<void> {

  // POST /api/developer-ai/run
  app.post('/run', async (req, reply) => {
    const parsed = RunBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }

    const input = parsed.data

    // [codex-review P1] パス境界検証
    const pathCheck = validateTargetRoot(input.targetProjectRoot)
    if (!pathCheck.ok) {
      return reply.status(400).send({ error: 'パス検証エラー', detail: pathCheck.reason })
    }

    // [codex-review P2] 手動承認ゲート（mockRun 時はスキップ）
    if (!input.mockRun && !input.approved) {
      return reply.status(403).send({
        error: '承認が必要です',
        detail: '仕様「投稿は手動確認あり」に基づき、AI 実行前に approved: true の設定が必要です。',
        hint: 'approved: true を付与して再リクエストしてください。',
      })
    }

    try {
      const result = await runDeveloperAi(input)

      const statusCode = result.status === 'failed' ? 422 : 201

      return reply.status(statusCode).send({
        status: result.status,
        taskId: result.taskId,
        provider: result.provider,
        durationMs: result.durationMs,
        changedFiles: result.changedFiles ?? [],
        result,
        message: result.status === 'success' || result.status === 'mock'
          ? `${result.taskId} の実行が完了しました`
          : `${result.taskId} の実行に失敗しました（exitCode: ${result.exitCode}）`,
      })
    } catch (err: any) {
      return reply.status(500).send({
        error: 'Developer AI 実行に失敗しました',
        detail: err.message,
      })
    }
  })
}
