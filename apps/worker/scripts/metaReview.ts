/**
 * Meta Review スクリプト — ローカル実行用
 *
 * runner.ts の CONTROL_ROOT がハードコードされているため、
 * Windows ローカル環境向けに同等の処理を直接実装する。
 *
 * 使い方:
 *   BASE_SHA=<base> HEAD_SHA=<head> PR_TITLE="..." TASK_ID="..." \
 *     pnpm exec tsx scripts/metaReview.ts
 *
 *   ※引数なしは HEAD~1..HEAD を対象とする
 *
 * 終了コード:
 *   0 = approved / changes_requested
 *   1 = blocked
 *   2 = エラー
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// .env ロード
{
  const envPath = path.resolve(fileURLToPath(import.meta.url), '../../../../.env')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/)
      if (!m) continue
      const key = m[1].trim()
      if (key in process.env) continue
      let val = m[2].trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      process.env[key] = val
    }
  }
}

import { callGeminiWithFallback } from '../src/metaReviewer/geminiRouter.js'
import { parseMetaReviewResult, classifyTargetArea } from '../src/metaReviewer/runner.js'

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../../')
const META_REVIEW_PROMPT_PATH = path.join(REPO_ROOT, 'docs/meta_reviewer/prompt.md')
const META_REVIEW_CHECKLIST_PATH = path.join(REPO_ROOT, 'docs/meta_reviewer/checklist.md')
const CHECKLISTS_DIR = path.join(REPO_ROOT, 'docs/meta_reviewer/checklists')

async function main(): Promise<void> {
  const baseSha = process.env.BASE_SHA
  const headSha = process.env.HEAD_SHA
  const prTitle = process.env.PR_TITLE ?? 'Manual Meta Review'
  const taskId  = process.env.TASK_ID ?? `local-${Date.now()}`

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🔍 Meta Review 開始（Gemini）')
  console.log(`   Task  : ${taskId}`)
  console.log(`   Title : ${prTitle}`)
  console.log(`   Mode  : ${baseSha ? 'SHA指定' : 'HEAD~1..HEAD'}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // git diff 取得
  const diffArgs  = baseSha && headSha ? ['diff', baseSha, headSha]           : ['diff', 'HEAD~1', 'HEAD']
  const nameArgs  = baseSha && headSha ? ['diff', '--name-only', baseSha, headSha] : ['diff', '--name-only', 'HEAD~1', 'HEAD']

  const gitDiff = execFileSync('git', diffArgs, { cwd: REPO_ROOT, encoding: 'utf-8', shell: false })
  const changedFiles = execFileSync('git', nameArgs, { cwd: REPO_ROOT, encoding: 'utf-8', shell: false })
    .split('\n').map((f) => f.trim()).filter(Boolean)

  console.log(`\n変更ファイル (${changedFiles.length}件):`)
  for (const f of changedFiles) console.log(`  - ${f}`)

  // プロンプト構築
  const systemPrompt    = readFileSync(META_REVIEW_PROMPT_PATH, 'utf-8')
  const generalChecklist = readFileSync(META_REVIEW_CHECKLIST_PATH, 'utf-8')
  const fileChecklists  = getFileChecklists(changedFiles)

  const fileChecklistSection = fileChecklists.length > 0
    ? ['## ファイル別チェックリスト', '', ...fileChecklists.flatMap((c) => [c, ''])].join('\n')
    : '## ファイル別チェックリスト\n\n（専用チェックリストなし）'

  const targetArea = classifyTargetArea(changedFiles)

  const prompt = `${systemPrompt}

---

## 汎用チェックリスト

${generalChecklist}

---

${fileChecklistSection}

---

## レビュー依頼

**Task ID**: ${taskId}
**Task**: ${prTitle}
**対象エリア**: ${targetArea}

**変更ファイル**:
${changedFiles.map((f) => `- ${f}`).join('\n')}

**Git Diff**:
\`\`\`diff
${gitDiff.slice(0, 30_000)}
\`\`\`

上記のdiffを確認し、MetaReviewResultのJSON形式で回答してください。
`

  // Gemini に投げる
  console.log('\n⚙️  Gemini 呼び出し中...')
  const rawResponse = await callGeminiWithFallback(prompt, {
    preferCli: true,
    cliModel: 'gemini-3.5-flash',
    apiModel: 'gemini-3.5-flash',
    featureName: 'meta_review',
  })

  const result = parseMetaReviewResult(rawResponse, taskId)

  // 結果表示
  const statusEmoji = result.status === 'approved' ? '✅' : result.status === 'changes_requested' ? '⚠️' : '🚫'
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`${statusEmoji} Meta Review 結果: ${result.status.toUpperCase()} (${result.riskLevel})`)
  console.log(`   ${result.summary}`)

  if (result.findings.length > 0) {
    console.log('\n📋 Finding:')
    for (const f of result.findings) {
      console.log(`  [${f.severity}/${f.category}] ${f.message}`)
      if (f.suggestion) console.log(`    → ${f.suggestion}`)
    }
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  process.exitCode = result.status === 'blocked' ? 1 : 0
}

function getFileChecklists(changedFiles: string[]): string[] {
  const results: string[] = []
  const add = (filename: string) => {
    const p = path.join(CHECKLISTS_DIR, filename)
    if (existsSync(p)) results.push(readFileSync(p, 'utf-8'))
  }
  if (changedFiles.some((f) => f.includes('guards/')))                                          add('guards.md')
  if (changedFiles.some((f) => f.startsWith('apps/api/src/routes/') || f === 'apps/api/src/index.ts')) add('api_routes.md')
  if (changedFiles.some((f) => f.startsWith('apps/api/src/storage/')))                         add('storage.md')
  if (changedFiles.some((f) => f.startsWith('apps/worker/src/') && !f.includes('guards/')))    add('worker.md')
  if (changedFiles.some((f) => f.startsWith('packages/shared/src/types/')))                    add('shared_types.md')
  return results
}

main().catch((err) => {
  console.error('❌ Meta Review エラー:', err instanceof Error ? err.message : String(err))
  process.exitCode = 2
})
