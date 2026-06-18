/**
 * Safety Audit & Alignment Gate — 開発時実行スクリプト
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 使い方:
 *   pnpm tsx apps/worker/scripts/audit.ts [ref] [--ui]
 *   pnpm tsx apps/worker/scripts/audit.ts HEAD~1..HEAD
 *   pnpm tsx apps/worker/scripts/audit.ts HEAD --ui   # GUI承認ダイアログあり
 *
 * 終了コード:
 *   0 = ALLOW or CEO承認済み
 *   1 = DEEP_REVIEW（--ui なし時）
 *   2 = BLOCK_CEO_REQUIRED（未承認）
 *   3 = エラー
 *
 * Claude Code はコミット前に必ずこのスクリプトを実行すること。
 * --ui を付けると BLOCK/DEEP_REVIEW 時に CEO 承認ダイアログを表示する。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'
import { runSafetyAudit } from '../src/guards/safetyAuditor.js'
import { runAlignmentCheck } from '../src/guards/alignmentChecker.js'
import { processGate, type GateResult } from '../src/guards/gateProcessor.js'
import { appendExecutionLog } from '../src/executionLogStore.js'
import { randomUUID } from 'node:crypto'

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../../')
const args = process.argv.slice(2)
const useUI = args.includes('--ui')
const ref = args.find((a) => !a.startsWith('--')) ?? 'HEAD'

// ────────────────────────────────────────────────────────────
// CEO 承認ダイアログ（PowerShell MessageBox）
// ────────────────────────────────────────────────────────────

function showApprovalDialog(gateResult: GateResult, changedFiles: string[]): boolean {
  const icon = gateResult.gateDecision === 'BLOCK_CEO_REQUIRED' ? 'Stop' : 'Warning'
  const title = gateResult.gateDecision === 'BLOCK_CEO_REQUIRED'
    ? 'BLOCK_CEO_REQUIRED — CEO承認が必要です'
    : 'DEEP_REVIEW — 人間レビューが必要です'

  const filesText = changedFiles.slice(0, 8).join('\n')
  const moreFiles = changedFiles.length > 8 ? `\n… 他 ${changedFiles.length - 8} ファイル` : ''
  const reasonText = gateResult.reason
    ? `\n\n理由:\n${gateResult.reason.replace(/ \| /g, '\n')}`
    : ''

  const message = [
    `リスクレベル: ${gateResult.finalRiskLevel}`,
    `判定: ${gateResult.gateDecision}`,
    '',
    '変更ファイル:',
    filesText + moreFiles,
    reasonText,
    '',
    '「はい」= 承認してコミット続行',
    '「いいえ」= 拒否してコミット中止',
  ].join('\n')

  // PowerShell で MessageBox を表示
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$result = [System.Windows.Forms.MessageBox]::Show(
  ${JSON.stringify(message)},
  ${JSON.stringify(title)},
  [System.Windows.Forms.MessageBoxButtons]::YesNo,
  [System.Windows.Forms.MessageBoxIcon]::${icon}
)
if ($result -eq 'Yes') { exit 0 } else { exit 1 }
`.trim()

  const res = spawnSync('powershell', ['-NonInteractive', '-Command', ps], {
    stdio: 'inherit',
    shell: false,
  })
  return res.status === 0
}

// ────────────────────────────────────────────────────────────
// 承認記録を JSONL に保存（監査証跡）
// ────────────────────────────────────────────────────────────

function recordApproval(ref: string, gateResult: GateResult, approved: boolean): void {
  try {
    const approvalDir = path.join(REPO_ROOT, 'data', 'approvals')
    mkdirSync(approvalDir, { recursive: true })
    const record = {
      id: randomUUID(),
      ref,
      approvedAt: new Date().toISOString(),
      approved,
      approvedBy: 'CEO_UI_CLICK',
      gateDecision: gateResult.gateDecision,
      finalRiskLevel: gateResult.finalRiskLevel,
      reason: gateResult.reason,
    }
    writeFileSync(
      path.join(approvalDir, 'approval_log.jsonl'),
      JSON.stringify(record) + '\n',
      { flag: 'a', encoding: 'utf-8' },
    )
    console.log(approved ? '✅ 承認記録を保存しました。' : '🚫 拒否記録を保存しました。')
  } catch {
    // 記録失敗はノイズにしない
  }
}

// ────────────────────────────────────────────────────────────
// メイン
// ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  console.log(`\n🔍 Safety Audit & Alignment Gate`)
  console.log(`   ref: ${ref}`)
  console.log(`   repo: ${REPO_ROOT}`)
  if (useUI) console.log(`   mode: GUI承認ダイアログあり\n`)
  else console.log()

  // 1. git diff 取得
  let rawDiff = ''
  try {
    rawDiff = execFileSync('git', ['diff', ref], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      shell: false,
    })
    if (!rawDiff.trim()) {
      rawDiff = execFileSync('git', ['diff', '--cached'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        shell: false,
      })
    }
  } catch {
    try {
      rawDiff = execFileSync('git', ['diff', ...ref.split('..').filter(Boolean)], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        shell: false,
      })
    } catch (err) {
      console.error('❌ git diff 取得失敗:', err)
      return 3
    }
  }

  if (!rawDiff.trim()) {
    console.log('✅ 変更なし。Audit スキップ。')
    return 0
  }

  // 2. Policy Guard + Impact Analyzer（静的解析）
  console.log('⚙️  [1/3] Policy Guard + Impact Analyzer...')
  const auditReport = runSafetyAudit({ rawDiff, ref })

  console.log(`   変更ファイル: ${auditReport.changedFiles.length}件`)
  console.log(`   危険ヒット:   ${auditReport.dangerousHits.length}件`)
  console.log(`   Audit Risk:  ${auditReport.riskLevel}`)
  for (const hit of auditReport.dangerousHits) {
    console.log(`   ⚠️  [${hit.type}] ${hit.value} @ ${hit.location}`)
  }

  // 3. Alignment Check（Gemini）
  console.log('\n⚙️  [2/3] Alignment Check（Gemini）...')
  let alignmentReport = undefined
  try {
    alignmentReport = await runAlignmentCheck(rawDiff, ref, REPO_ROOT)
    console.log(`   Aligned: ${alignmentReport.aligned}`)
    if (!alignmentReport.aligned) {
      for (const issue of alignmentReport.issues) {
        console.log(`   ⚠️  [${issue.severity.toUpperCase()}/${issue.category}] ${issue.description}`)
      }
    }
  } catch (err) {
    console.warn('   ⚠️  Alignment Check 失敗（スキップ）:', (err as Error).message)
  }

  // 4. Gate 判定
  console.log('\n⚙️  [3/3] Gate 判定...')
  const gateResult = processGate(auditReport, alignmentReport)

  console.log(`   Final Risk:    ${gateResult.finalRiskLevel}`)
  console.log(`   Gate Decision: ${gateResult.gateDecision}`)
  if (gateResult.reason) console.log(`   Reason: ${gateResult.reason}`)

  // 5. 実行ログ保存
  try {
    appendExecutionLog({
      id: randomUUID(),
      jobId: `audit-${Date.now()}`,
      taskId: 'manual-audit',
      executor: 'claude_code',
      command: `audit ${ref}`,
      workingDir: REPO_ROOT,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      stdout: '',
      stderr: '',
      changedFiles: auditReport.changedFiles,
      gitDiffSummary: auditReport.diffSummary,
      auditReport,
      alignmentReport,
      createdAt: new Date().toISOString(),
    })
  } catch {
    // ログ保存失敗はノイズにしない
  }

  // 6. 結果表示 & 承認フロー
  console.log('\n' + '─'.repeat(50))

  if (gateResult.gateDecision === 'ALLOW') {
    console.log('✅ ALLOW — コミット可能')
    return 0
  }

  // DEEP_REVIEW / BLOCK_CEO_REQUIRED
  if (gateResult.gateDecision === 'DEEP_REVIEW') {
    console.log('🟡 DEEP_REVIEW — 人間のレビューが必要です')
  } else {
    console.log('🔴 BLOCK_CEO_REQUIRED — CEO承認が必要です')
  }

  if (useUI) {
    console.log('\n📋 承認ダイアログを表示します...')
    const approved = showApprovalDialog(gateResult, auditReport.changedFiles)
    recordApproval(ref, gateResult, approved)

    if (approved) {
      console.log('✅ CEO承認済み — コミット続行します')
      return 0
    } else {
      console.log('🚫 CEO拒否 — コミット中止します')
      return 2
    }
  } else {
    if (gateResult.gateDecision === 'DEEP_REVIEW') {
      console.log('   → ユーザーに報告してから進めること（--ui フラグで承認ダイアログ表示可）')
      return 1
    } else {
      console.log('   → CEO（ユーザー）の明示的な承認なしにコミットしないこと')
      console.log('   → ヒント: pnpm audit:gate -- --ui で承認ダイアログを表示できます')
      return 2
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('❌ Audit エラー:', err)
    process.exit(3)
  })
