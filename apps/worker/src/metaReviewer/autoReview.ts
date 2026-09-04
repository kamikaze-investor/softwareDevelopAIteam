/**
 * Meta Review 自動実行エントリポイント
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 実行シナリオ:
 * 1. GitHub Actions から自動実行（PR前・必須チェック）
 * 2. ローカル git pre-push フックから実行
 * 3. Worker Job として実行（将来）
 *
 * 終了コード:
 *   0 = approved / changes_requested（マージ可）
 *   1 = blocked（マージ不可・CEO承認必要）
 *   2 = 実行エラー（安全のため blocked 扱い）
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// .env ロード（runner.ts の動的 import より前に CONTROL_ROOT を設定する）
//
// runner.ts は module-level で CONTROL_ROOT を確定する。ESM では静的 import は
// モジュール本体より先に評価されるため、静的 import のままでは .env ロードが間に
// 合わない。そのため runner.ts / geminiRouter.ts は main() 内で動的 import する。
//
// __dirname = apps/worker/src/metaReviewer/
// ../../../../.env = リポジトリルートの .env
{
  const envPath = resolve(__dirname, '../../../../.env')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/)
      if (!m) continue
      const key = m[1].trim()
      if (key in process.env) continue   // 既存の環境変数を上書きしない
      let val = m[2].trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      process.env[key] = val
    }
  }
}

async function main(): Promise<void> {
  // .env ロード後に runner.ts / geminiRouter.ts / metaReviewFallbackRouter.ts を評価させるため動的 import する
  const { buildMetaReviewRequest, buildMetaReviewPrompt, parseMetaReviewResult } =
    await import('./runner.js')
  const { reviewWithProviderFallback, MetaReviewProviderError, sanitizeMessage } = await import('./metaReviewFallbackRouter.js')
  const { AGY_REVIEW_MODEL } = await import('./geminiRouter.js')

  // --- 環境変数の読み取り ---
  const baseSha = process.env.BASE_SHA       // GitHub Actions: PR の base SHA
  const headSha = process.env.HEAD_SHA       // GitHub Actions: PR の head SHA
  const prTitle = process.env.PR_TITLE ?? 'Manual Meta Review'
  const taskId  = process.env.TASK_ID ?? `pr-${Date.now()}`
  const workingDir = process.cwd()
  const resultFilePath = process.env.META_REVIEW_RESULT_PATH
    ?? resolve(workingDir, 'meta-review-result.json')

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🔍 Meta Review 開始（Gemini）')
  console.log(`   Task    : ${taskId}`)
  console.log(`   Title   : ${prTitle}`)
  console.log(`   Mode    : ${baseSha ? 'GitHub Actions' : 'Local'}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // --- git diff の取得 ---
  let gitDiff: string
  let changedFiles: string[]

  try {
    const diffArgs = baseSha && headSha
      ? ['diff', baseSha, headSha]          // GHA: PRの全差分
      : ['diff', 'HEAD~1', 'HEAD']           // ローカル: 直前コミットとの差分

    const nameOnlyArgs = baseSha && headSha
      ? ['diff', '--name-only', baseSha, headSha]
      : ['diff', '--name-only', 'HEAD~1', 'HEAD']

    gitDiff = execFileSync('git', diffArgs, {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,                          // インジェクション防止
    })

    const rawFiles = execFileSync('git', nameOnlyArgs, {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,
    })

    changedFiles = rawFiles.trim().split('\n').filter(Boolean)
  } catch (err) {
    console.error('❌ git diff の取得に失敗しました:', err)
    process.exit(2)
  }

  if (changedFiles.length === 0) {
    console.log('ℹ️  変更ファイルなし。レビューをスキップします。')
    writeResultFile({
      id: `meta-review-${taskId}-${Date.now()}`,
      taskId,
      status: 'approved',
      riskLevel: 'low',
      summary: '変更ファイルなし。スキップ。',
      findings: [],
      requiresCeoApproval: false,
      createdAt: new Date().toISOString(),
    }, resultFilePath)
    process.exit(0)
  }

  console.log(`\n変更ファイル (${changedFiles.length}件):`)
  changedFiles.forEach(f => console.log(`  - ${f}`))

  // --- Meta Review Request / Prompt の構築 ---
  const request = buildMetaReviewRequest(
    taskId,
    prTitle,
    changedFiles,
    workingDir,
    gitDiff,
  )
  const prompt = buildMetaReviewPrompt(request)

  // --- レビューを依頼（Gemini API → Gemini CLI → Copilot CLI） ---
  // GEMINI_MODEL は meta-review.yml が vars.GEMINI_MODEL（未設定時 gemini-2.5-flash）を渡す。
  // 未設定（ローカル実行等）の場合のみ、このプロジェクトが実運用として使ってきた既定値にフォールバックする。
  // これは **Gemini REST API 側のモデル名**であり、agy CLI の識別子とは別の名前空間。
  // 以前は同じ値を cliModel にも渡していたが、agy は REST 名を受け付けず確定的に失敗するため、
  // CLI 側は AGY_REVIEW_MODEL（model + effort の対）を使う。
  const geminiApiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash'
  console.log('\n🤖 Gemini にレビューを依頼中...')
  let rawResponse: string
  let providerUsed: 'gemini' | 'copilot' = 'gemini'
  try {
    const reviewResult = await reviewWithProviderFallback(prompt, {
      preferCli: true,
      ...AGY_REVIEW_MODEL,
      apiModel: geminiApiModel,
      featureName: 'meta_review',
      // autoReview.ts は使い捨ての CI/pre-push プロセスとして実行されるため、transient
      // （timeout/network/5xx）と判定された失敗を固定回数リトライしてよい。この opt-in が
      // 既定 false なのは、同じ callGeminiWithFallback() を長時間稼働する Worker 本体
      // （watchdog.ts 等）からも呼んでおり、そちらで同期リトライの待機が event loop を
      // ブロックしないようにするため（独立レビュー指摘、2026-09-01）。
      retryTransient: true,
    })
    rawResponse = reviewResult.raw
    providerUsed = reviewResult.providerUsed
    if (providerUsed === 'copilot') {
      console.log('   ℹ️  Gemini が失敗したため Copilot CLI（Microsoft系モデル）で審査しました')
    }
  } catch (err) {
    console.error('❌ Meta Review プロバイダー呼び出しに失敗しました:', err)
    const failureClass = err instanceof MetaReviewProviderError ? err.failureClass : 'unknown'
    // PRコメントに載る finding.message は、MetaReviewProviderError 以外（Copilot フォールバック
    // 自体の失敗を含む。copilotRouter.ts は raw stderr/stdout をそのままエラーメッセージに含める）
    // も含めて必ず sanitizeMessage() を通す。geminiRouter.ts 内の診断情報は個別に sanitize 済みだが、
    // ここを通らないと err.message がそのまま公開 PR コメントに漏れる経路が残る
    // （独立レビュー指摘、2026-09-01）。
    const rawMessage = err instanceof Error ? err.message : String(err)
    // API障害は安全のため blocked 扱い
    const errorResult = {
      id: `meta-review-${taskId}-${Date.now()}`,
      taskId,
      status: 'blocked' as const,
      riskLevel: 'critical' as const,
      summary: 'Meta Review プロバイダー（Gemini / Copilot）呼び出しに失敗しました。安全のため blocked とします。',
      findings: [{
        severity: 'critical' as const,
        category: 'security_regression' as const,
        message: `Meta Review プロバイダーエラー（分類: ${failureClass}）: ${sanitizeMessage(rawMessage)}`,
        suggestion: 'GEMINI_API_KEY / Gemini CLI / Copilot CLI（GITHUB_TOKEN認証）の状態を確認してください。詳細な診断情報（provider/stage/httpStatus/exitCode等）はCI実行ログを参照してください。',
      }],
      requiresCeoApproval: true,
      createdAt: new Date().toISOString(),
      // providerUsed は付与しない（どちらが最終的に応答したか確定していないため）
    }
    writeResultFile(errorResult, resultFilePath)
    printResult(errorResult)
    process.exit(1)
  }

  // --- 結果をパース ---
  // parseMetaReviewResult() の戻り値型・契約は変更しない（既存パーサーはそのまま）。
  // providerUsed は監査証跡用にファイル書き込み時のみ additive に付与する
  // （2026-08-26 独立レビュー指摘: 実際に応答したプロバイダーが記録されず、
  //   PRコメントが常に「Reviewed by Gemini」と表示されていた問題への対応）。
  const result = parseMetaReviewResult(rawResponse, taskId)
  writeResultFile({ ...result, providerUsed }, resultFilePath)
  printResult(result)

  // --- 終了コード ---
  //
  // blocked = exit 1（CI 失敗）の設計について:
  //   Meta Review が genuine なセキュリティ違反を検出した場合、CI を失敗させる。
  //   ただし autoReview.ts 自体が CODEOWNERS の対象ではないため AI が改ざん可能。
  //   本当の防護壁は CODEOWNERS によるセキュリティファイルへの人間承認必須。
  //   詳細: .github/CODEOWNERS を参照。
  //
  if (result.status === 'blocked') {
    console.error('\n🚫 BLOCKED: このPRはCEO承認なしにマージできません')
    process.exit(1)
  }

  if (result.status === 'changes_requested') {
    console.warn('\n⚠️  CHANGES REQUESTED: 修正後に再レビューが必要です')
    process.exit(0)
  }

  console.log('\n✅ APPROVED: マージ可能です')
  process.exit(0)
}

// --- ヘルパー ---

type MetaReviewResultLike = {
  id: string
  taskId: string
  status: 'approved' | 'changes_requested' | 'blocked'
  riskLevel: string
  summary: string
  findings: Array<{
    severity: string
    category: string
    message: string
    suggestion?: string
  }>
  requiresCeoApproval: boolean
  createdAt: string
  /** 監査証跡用（additive・parseMetaReviewResult の契約には含まれない）。未設定 = 従来どおり */
  providerUsed?: 'gemini' | 'copilot'
}

function writeResultFile(result: MetaReviewResultLike, resultFilePath: string): void {
  writeFileSync(resultFilePath, JSON.stringify(result, null, 2))
}

function printResult(result: MetaReviewResultLike): void {
  const symbol = { approved: '✅', changes_requested: '⚠️', blocked: '🚫' }[result.status]
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`${symbol} 判定: ${result.status.toUpperCase()}`)
  console.log(`   リスク  : ${result.riskLevel}`)
  console.log(`   サマリー: ${result.summary}`)

  if (result.findings.length > 0) {
    console.log('\n   検出事項:')
    for (const f of result.findings) {
      console.log(`     [${f.severity}] ${f.message}`)
      if (f.suggestion) {
        console.log(`     → ${f.suggestion}`)
      }
    }
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
}

// 実行
main().catch(err => {
  console.error('❌ Meta Review の実行中に予期しないエラーが発生しました:', err)
  process.exit(2)
})
