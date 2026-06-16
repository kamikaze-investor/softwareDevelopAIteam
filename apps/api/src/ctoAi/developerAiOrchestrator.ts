/**
 * Developer AI Orchestrator（task-104）
 *
 * 役割:
 *   Context Pack を受け取り、Developer AI（claude / codex / gemini）を
 *   target-project の workingDir で実行する。
 *
 * フロー:
 *   Context Pack → instruction をプロンプトに変換
 *   → Worker の AI CLI Adapter を呼び出す
 *   → 結果（stdout / changedFiles / status）を返す
 *
 * 注意:
 *   - workingDir は target-project のルートに固定（allowedPaths はプロンプト内で AI に伝える）
 *   - 実際の AI CLI 実行は Worker に委譲する（直接呼ばない）
 *   - テスト時は mockRun=true でファイル実行をスキップできる
 */

import { z } from 'zod'

// ────────────────────────────────────────────────────────────
// 型定義
// ────────────────────────────────────────────────────────────

export const DeveloperAiRequestSchema = z.object({
  /** Developer AI の種類 */
  provider: z.enum(['claude', 'codex', 'gemini']).default('claude'),
  /** Context Pack の instruction（buildContextPack で生成） */
  instruction: z.string().min(1),
  /** 実行する target-project のルートパス */
  targetProjectRoot: z.string().min(1),
  /** タスクID（ログ用） */
  taskId: z.string(),
  /** タイムアウト（ms） */
  timeoutMs: z.number().int().positive().default(300_000),
  /** true のときは実際の AI 実行をスキップし mock 結果を返す */
  mockRun: z.boolean().default(false),
})

export type DeveloperAiRequest = z.infer<typeof DeveloperAiRequestSchema>

export interface DeveloperAiResult {
  status: 'success' | 'failed' | 'blocked' | 'mock'
  taskId: string
  provider: string
  stdout?: string
  stderr?: string
  changedFiles?: string[]
  exitCode?: number
  executedAt: string
  completedAt: string
  durationMs: number
}

// ────────────────────────────────────────────────────────────
// Mock 実行（テスト用）
// ────────────────────────────────────────────────────────────

function mockExecution(req: DeveloperAiRequest): DeveloperAiResult {
  const now = new Date()
  return {
    status: 'mock',
    taskId: req.taskId,
    provider: req.provider,
    stdout: `[MOCK] ${req.provider} が ${req.taskId} を処理しました。\n実装完了。`,
    changedFiles: [],
    executedAt: now.toISOString(),
    completedAt: now.toISOString(),
    durationMs: 0,
  }
}

// ────────────────────────────────────────────────────────────
// プロンプト構築
// ────────────────────────────────────────────────────────────

function buildPrompt(req: DeveloperAiRequest): string {
  return [
    req.instruction,
    '',
    '---',
    `## 実行情報`,
    `- タスクID: ${req.taskId}`,
    `- Working Directory: ${req.targetProjectRoot}`,
    `- 実行AI: ${req.provider}`,
    '',
    '上記の指示に従って実装を行い、完了したら「実装完了」と報告してください。',
  ].join('\n')
}

// ────────────────────────────────────────────────────────────
// メイン実行関数
// ────────────────────────────────────────────────────────────

export async function runDeveloperAi(
  req: DeveloperAiRequest,
): Promise<DeveloperAiResult> {
  const executedAt = new Date().toISOString()

  if (req.mockRun) {
    return mockExecution(req)
  }

  // Worker の AI CLI Adapter を動的インポートして実行
  // （Worker と API は別パッケージだが、モノレポなので直接インポート可能）
  // 実際の Docker 環境では Worker が別プロセスで動くため、
  // 本番では Job Queue 経由で呼ぶ（task-104はローカル統合テスト用のブリッジ）
  const { createAiCliAdapter } = await import(
    '../../worker/src/aiCli/factory.js'
  ).catch(() => {
    // パス解決失敗時はフォールバック用エラーを投げる
    throw new Error(
      '[DeveloperAI] Worker モジュールへのパスが解決できません。' +
      'Docker 環境では Job Queue 経由で実行してください。'
    )
  })

  const adapter = createAiCliAdapter({ provider: req.provider })
  const prompt = buildPrompt(req)
  const startMs = Date.now()

  const result = await adapter.run({
    prompt,
    workingDir: req.targetProjectRoot,
    provider: req.provider,
    timeoutMs: req.timeoutMs,
    expectJson: false,
  })

  const completedAt = new Date().toISOString()
  const durationMs = Date.now() - startMs

  return {
    status: result.exitCode === 0 ? 'success' : 'failed',
    taskId: req.taskId,
    provider: req.provider,
    stdout: result.stdout,
    stderr: result.stderr,
    changedFiles: result.changedFiles,
    exitCode: result.exitCode,
    executedAt,
    completedAt,
    durationMs,
  }
}
