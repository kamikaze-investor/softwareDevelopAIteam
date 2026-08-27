/**
 * Design Review 実行専用の one-shot runner。
 *
 * 責務は「レビューを実行して raw な結果を stdout へ返すこと」だけである。
 * evidence登録・Job作成・decisionの確定は行わない。それらはAPI（Control Plane）の権限であり、
 * このプロセスは実行者であって authority ではない。
 *
 * そのためこの runner は API_TOKEN / evidence登録tokenを一切必要とせず、受け取りもしない。
 *
 * 入出力:
 *   stdin  … DesignReviewRunnerInput の JSON
 *   stdout … StrategicMetaReviewResult の JSON（1行目から末尾まで）
 *   exit   … 0=レビュー実行成功（decisionの内容は問わない） / 1=実行失敗
 *
 * exit code は「レビューが実行できたか」だけを表し、ALIGNED/CONFLICT等の判定結果は表さない。
 * 判定はAPI側が result を読んで自前で再計算する。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * .env から読み込んでよいキー。
 *
 * least privilege: レビュー実行経路（metaReviewer/approvalLevel）が実際に参照する
 * secret は GEMINI_API_KEY と、Copilot CLI フォールバック専用の
 * COPILOT_GITHUB_TOKEN だけで、GEMINI_MODEL は非secretの設定値である。
 * GITHUB_TOKEN はGit操作用のcredentialなので、このrunnerには載せない。
 * API_TOKEN / ADMIN_TOKEN_SHA256 / WORKER_TOKEN_SHA256 / OPENCODE_GO_API_KEY /
 * CLAUDE_API_KEY / OPENAI_API_KEY 等は、このプロセスの process.env へ
 * 一切載せない。reviewer child は本プロセスの env を継承するため、ここで載せないことが
 * そのまま child への非伝播になる。
 */
const ENV_ALLOWLIST: readonly string[] = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'COPILOT_GITHUB_TOKEN']

export interface DesignReviewRunnerInput {
  taskId: string
  taskTitle: string
  designText: string
  changedFiles: string[]
  workingDir: string
}

/** .env から ENV_ALLOWLIST のキーだけを process.env へ載せる。他のキーは読み捨てる。 */
export function loadAllowlistedEnv(
  envPath: string,
  target: NodeJS.ProcessEnv,
  allowlist: readonly string[] = ENV_ALLOWLIST,
): void {
  if (!existsSync(envPath)) {
    return
  }

  for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const match = line.match(/^([^#=\s][^=]*)=(.*)$/)
    if (!match) {
      continue
    }

    const key = match[1].trim()
    if (!allowlist.includes(key) || key in target) {
      continue
    }

    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    target[key] = value
  }
}

export function parseRunnerInput(raw: string): DesignReviewRunnerInput {
  const parsed = JSON.parse(raw) as Partial<DesignReviewRunnerInput>

  if (
    typeof parsed.taskId !== 'string' ||
    typeof parsed.taskTitle !== 'string' ||
    typeof parsed.designText !== 'string' ||
    typeof parsed.workingDir !== 'string' ||
    !Array.isArray(parsed.changedFiles)
  ) {
    throw new Error('invalid runner input')
  }

  return {
    taskId: parsed.taskId,
    taskTitle: parsed.taskTitle,
    designText: parsed.designText,
    changedFiles: parsed.changedFiles as string[],
    workingDir: parsed.workingDir,
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

async function main(): Promise<void> {
  loadAllowlistedEnv(resolve(__dirname, '../../../.env'), process.env)

  const input = parseRunnerInput(await readStdin())
  const { runStrategicMetaReview } = await import('../src/metaReviewer/strategicReview.js')

  const result = await runStrategicMetaReview({
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    changedFiles: input.changedFiles,
    gitDiff: input.designText,
    workingDir: input.workingDir,
    materialKind: 'design',
  })

  process.stdout.write(JSON.stringify(result))
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`design review runner failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
