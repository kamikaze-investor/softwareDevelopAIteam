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
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildMetaReviewRequest, buildMetaReviewPrompt, parseMetaReviewResult } from './runner.js'
import { callGeminiForReview } from './geminiClient.js'

async function main(): Promise<void> {
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

  // --- Gemini にレビューを依頼 ---
  console.log('\n🤖 Gemini にレビューを依頼中...')
  let rawResponse: string
  try {
    rawResponse = await callGeminiForReview(prompt)
  } catch (err) {
    console.error('❌ Gemini API 呼び出しに失敗しました:', err)
    // API障害は安全のため blocked 扱い
    const errorResult = {
      id: `meta-review-${taskId}-${Date.now()}`,
      taskId,
      status: 'blocked' as const,
      riskLevel: 'critical' as const,
      summary: 'Gemini API 呼び出しに失敗しました。安全のため blocked とします。',
      findings: [{
        severity: 'critical' as const,
        category: 'security_regression' as const,
        message: `Gemini API エラー: ${err instanceof Error ? err.message : String(err)}`,
        suggestion: 'GEMINI_API_KEY と API の状態を確認してください',
      }],
      requiresCeoApproval: true,
      createdAt: new Date().toISOString(),
    }
    writeResultFile(errorResult, resultFilePath)
    printResult(errorResult)
    process.exit(1)
  }

  // --- 結果をパース ---
  const result = parseMetaReviewResult(rawResponse, taskId)
  writeResultFile(result, resultFilePath)
  printResult(result)

  // --- 終了コード ---
  if (result.status === 'blocked') {
    console.error('\n🚫 BLOCKED: このPRはCEO承認なしにマージできません')
    process.exit(1)
  }

  if (result.status === 'changes_requested') {
    console.warn('\n⚠️  CHANGES REQUESTED: 修正後に再レビューが必要です')
    // changes_requested は警告のみ（マージはブロックしない）
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
