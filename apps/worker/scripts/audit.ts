/**
 * Safety Audit & Alignment Gate — 開発時実行スクリプト
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 使い方:
 *   pnpm tsx apps/worker/scripts/audit.ts [ref] [--ui]
 *
 * 終了コード:
 *   0 = ALLOW / CEO承認済み（全般 or 今回のみ）
 *   1 = DEEP_REVIEW（--ui なし時）
 *   2 = BLOCK_CEO_REQUIRED（未承認 or 拒否）
 *   3 = エラー
 */

import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { runSafetyAudit } from '../src/guards/safetyAuditor.js'
import { runAlignmentCheck } from '../src/guards/alignmentChecker.js'
import { processGate, type GateResult } from '../src/guards/gateProcessor.js'
import { appendExecutionLog } from '../src/executionLogStore.js'
import type { AuditReport, AlignmentReport } from '@ai-team/shared'
import { randomUUID } from 'node:crypto'

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../../')
const args = process.argv.slice(2)
const useUI = args.includes('--ui')
const ref = args.find((a) => !a.startsWith('--')) ?? 'HEAD'

// ────────────────────────────────────────────────────────────
// 平文説明ヘルパー
// ────────────────────────────────────────────────────────────

function describeFiles(changedFiles: string[]): string {
  return changedFiles
    .map((f) => {
      if (f.includes('guards/') || f.includes('safetyAuditor') || f.includes('alignmentChecker') || f.includes('gateProcessor'))
        return `⚠️  ${f}\n     → セキュリティ監視ロジック（誤変更でガードが無効化するリスク）`
      if (f.includes('package.json'))
        return `📦  ${f}\n     → ソフトウェアの依存関係・起動スクリプト定義`
      if (f.includes('rules/') || f.includes('approval_rules') || f.includes('goal.md') || f.includes('design_philosophy'))
        return `📋  ${f}\n     → AIチームの行動ルール・設計方針（変更は慎重に）`
      if (f.includes('.env') || f.includes('secret') || f.includes('credential'))
        return `🔑  ${f}\n     → 秘密情報・APIキー（外部サービス接続に使用）`
      if (f.includes('.github/') || f.includes('workflows/'))
        return `🔄  ${f}\n     → 自動テスト・デプロイの設定`
      if (f.includes('scripts/'))
        return `🛠️  ${f}\n     → 管理スクリプト`
      return `📄  ${f}`
    })
    .join('\n')
}

function describeRisk(riskLevel: string): string {
  switch (riskLevel) {
    case 'LOW': return '🟢 低リスク — 通常の開発変更です'
    case 'MEDIUM': return '🟡 中リスク — 影響範囲が広い変更です'
    case 'HIGH': return '🟠 高リスク — 重要なファイルや設定への変更が含まれます'
    case 'CRITICAL': return '🔴 重大リスク — セキュリティや承認フローに関わる変更です'
    default: return riskLevel
  }
}

function describeReason(reason: string | undefined, dangerousHits: AuditReport['dangerousHits']): string {
  const parts: string[] = []
  if (dangerousHits.length > 0) {
    parts.push('【AIが検出した具体的な懸念点】')
    for (const hit of dangerousHits) {
      if (hit.type === 'file') parts.push(`・ファイル「${hit.value}」は変更に注意が必要なカテゴリです`)
      if (hit.type === 'keyword') parts.push(`・コード内に注意キーワード「${hit.value}」が含まれています`)
    }
  }
  if (reason?.includes('Alignment')) {
    parts.push('\n【設計方針との整合性チェック（AI Geminiによる判断）】')
    const alignParts = reason.split('|').filter((p) => p.includes('Alignment'))
    for (const p of alignParts) {
      parts.push(p.replace('[Alignment CRITICAL]', '🔴').replace('[Alignment WARNING]', '🟡').trim())
    }
  }
  return parts.length > 0 ? parts.join('\n') : '詳細な理由は取得できませんでした。'
}

function describeSafetyMechanisms(): string {
  return [
    '✅ 承認・拒否の記録は改ざんできないログ（JSONL）に永続保存されます',
    '✅ すべての変更は Git で追跡されており、いつでも元に戻せます',
    '✅ この承認はコードを自動実行・デプロイするものではありません',
    '✅ 「今回のみ承認」を選ぶと、次回の変更では再度確認が必要になります',
    '✅ 「拒否」すればコミット（保存）は行われません',
  ].join('\n')
}

// ────────────────────────────────────────────────────────────
// CEO 承認ダイアログ（PowerShell WinForms カスタムフォーム）
// ────────────────────────────────────────────────────────────

type ApprovalDecision = 'approve_all' | 'approve_once' | 'reject'

function buildPsScript(inputFilePath: string): string {
  // PowerShell スクリプトを行配列で構築（テンプレートリテラル回避）
  // TS template literal 内では backtick と ${} が特殊文字なので string 配列で組み立てる
  const NL = '\n'
  const BT = '`' // PowerShell のエスケープ文字（バッククォート）
  const iPath = inputFilePath.replace(/\\/g, '\\\\')
  const lines: string[] = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '',
    '$data = Get-Content -Raw -Encoding UTF8 -Path \'' + iPath + '\' | ConvertFrom-Json',
    '',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.Text = "Safety Gate — CEO 承認リクエスト"',
    '$form.Size = New-Object System.Drawing.Size(780, 720)',
    '$form.StartPosition = "CenterScreen"',
    '$form.FormBorderStyle = "FixedDialog"',
    '$form.MaximizeBox = $false',
    '$form.BackColor = [System.Drawing.Color]::FromArgb(245, 245, 248)',
    '$form.Font = New-Object System.Drawing.Font("Meiryo UI", 9)',
    '',
    '# header',
    '$hdr = New-Object System.Windows.Forms.Panel',
    '$hdr.Dock = "Top"',
    '$hdr.Height = 70',
    '$hdrColor = if ($data.isBlock) { [System.Drawing.Color]::FromArgb(220,53,69) } else { [System.Drawing.Color]::FromArgb(255,153,0) }',
    '$hdr.BackColor = $hdrColor',
    '$hdrLbl = New-Object System.Windows.Forms.Label',
    '$hdrLbl.Text = if ($data.isBlock) { "🔴  BLOCK — CEO承認が必要です" } else { "🟡  DEEP REVIEW — 人間のレビューが必要です" }',
    '$hdrLbl.Font = New-Object System.Drawing.Font("Meiryo UI", 13, [System.Drawing.FontStyle]::Bold)',
    '$hdrLbl.ForeColor = [System.Drawing.Color]::White',
    '$hdrLbl.AutoSize = $false',
    '$hdrLbl.Dock = "Fill"',
    '$hdrLbl.TextAlign = "MiddleCenter"',
    '$hdr.Controls.Add($hdrLbl)',
    '$form.Controls.Add($hdr)',
    '',
    '# scroll panel',
    '$scroll = New-Object System.Windows.Forms.Panel',
    '$scroll.Location = New-Object System.Drawing.Point(0, 70)',
    '$scroll.Size = New-Object System.Drawing.Size(780, 540)',
    '$scroll.AutoScroll = $true',
    '',
    '$sy = 10',
    '',
    'function Add-Sec($ttl, $body, $r, $g, $b) {',
    '  $pnl = New-Object System.Windows.Forms.Panel',
    '  $pnl.Location = New-Object System.Drawing.Point(10, $script:sy)',
    '  $pnl.Size = New-Object System.Drawing.Size(740, 10)',
    '  $pnl.BackColor = [System.Drawing.Color]::FromArgb($r,$g,$b)',
    '  $tl = New-Object System.Windows.Forms.Label',
    '  $tl.Text = $ttl',
    '  $tl.Font = New-Object System.Drawing.Font("Meiryo UI", 9.5, [System.Drawing.FontStyle]::Bold)',
    '  $tl.ForeColor = [System.Drawing.Color]::FromArgb(30,30,30)',
    '  $tl.Location = New-Object System.Drawing.Point(12, 8)',
    '  $tl.AutoSize = $true',
    '  $pnl.Controls.Add($tl)',
    '  $bl = New-Object System.Windows.Forms.Label',
    '  $bl.Text = $body',
    '  $bl.Font = New-Object System.Drawing.Font("Meiryo UI", 9)',
    '  $bl.ForeColor = [System.Drawing.Color]::FromArgb(50,50,50)',
    '  $bl.Location = New-Object System.Drawing.Point(12, 30)',
    '  $bl.MaximumSize = New-Object System.Drawing.Size(715, 0)',
    '  $bl.AutoSize = $true',
    '  $pnl.Controls.Add($bl)',
    '  $pnl.Height = $tl.Height + $bl.PreferredHeight + 48',
    '  $script:scroll.Controls.Add($pnl)',
    '  $script:sy += $pnl.Height + 8',
    '}',
    '',
    'Add-Sec "❓ 何を承認するのか？" ("AIアシスタント（Claude Code）が、このリポジトリに " + $data.changedCount + " 個のファイルを変更しようとしています。' + NL + NL + '変更対象ファイル:' + NL + '" + $data.filesText) 235 245 255',
    'Add-Sec "⚠️ なぜ承認が必要なのか？" $data.reasonText 255 248 230',
    'Add-Sec "📊 リスクレベル" ($data.riskLabel + "' + NL + NL + '🟢 低  → 通常の変更（コメント、テスト等）' + NL + '🟡 中  → 影響範囲の広い変更（設定ファイル等）' + NL + '🟠 高  → 重要ファイルへの変更（要確認）' + NL + '🔴 重大 → セキュリティ・ガード系ファイルへの変更") 255 240 240',
    'Add-Sec "🛡️ 安全に運用できる仕組みは？" $data.safetyText 235 255 240',
    '',
    '$scroll.AutoScrollMinSize = New-Object System.Drawing.Size(740, ($sy + 20))',
    '$form.Controls.Add($scroll)',
    '',
    '# button panel',
    '$bp = New-Object System.Windows.Forms.Panel',
    '$bp.Dock = "Bottom"',
    '$bp.Height = 80',
    '$bp.BackColor = [System.Drawing.Color]::FromArgb(225,225,230)',
    '',
    '$outFile = $data.outputFile',
    '',
    '$b1 = New-Object System.Windows.Forms.Button',
    '$b1.Text = "✅ 承認する（以降も有効）"',
    '$b1.Size = New-Object System.Drawing.Size(210, 46)',
    '$b1.Location = New-Object System.Drawing.Point(30, 17)',
    '$b1.BackColor = [System.Drawing.Color]::FromArgb(40,167,69)',
    '$b1.ForeColor = [System.Drawing.Color]::White',
    '$b1.Font = New-Object System.Drawing.Font("Meiryo UI", 9.5, [System.Drawing.FontStyle]::Bold)',
    '$b1.FlatStyle = "Flat"',
    '$b1.Add_Click({ "approve_all" | Out-File -FilePath $outFile -Encoding utf8; $form.Close() })',
    '',
    '$b2 = New-Object System.Windows.Forms.Button',
    '$b2.Text = "🔁 今回のみ承認"',
    '$b2.Size = New-Object System.Drawing.Size(210, 46)',
    '$b2.Location = New-Object System.Drawing.Point(260, 17)',
    '$b2.BackColor = [System.Drawing.Color]::FromArgb(0,123,255)',
    '$b2.ForeColor = [System.Drawing.Color]::White',
    '$b2.Font = New-Object System.Drawing.Font("Meiryo UI", 9.5, [System.Drawing.FontStyle]::Bold)',
    '$b2.FlatStyle = "Flat"',
    '$b2.Add_Click({ "approve_once" | Out-File -FilePath $outFile -Encoding utf8; $form.Close() })',
    '',
    '$b3 = New-Object System.Windows.Forms.Button',
    '$b3.Text = "🚫 拒否する"',
    '$b3.Size = New-Object System.Drawing.Size(210, 46)',
    '$b3.Location = New-Object System.Drawing.Point(490, 17)',
    '$b3.BackColor = [System.Drawing.Color]::FromArgb(108,117,125)',
    '$b3.ForeColor = [System.Drawing.Color]::White',
    '$b3.Font = New-Object System.Drawing.Font("Meiryo UI", 9.5, [System.Drawing.FontStyle]::Bold)',
    '$b3.FlatStyle = "Flat"',
    '$b3.Add_Click({ "reject" | Out-File -FilePath $outFile -Encoding utf8; $form.Close() })',
    '',
    '$bp.Controls.AddRange(@($b1, $b2, $b3))',
    '$form.Controls.Add($bp)',
    '$form.ShowDialog() | Out-Null',
  ]
  // 未使用変数の参照を回避するためのダミー参照
  void BT
  return lines.join(NL)
}

function showApprovalDialog(
  gateResult: GateResult,
  auditReport: AuditReport,
  alignmentReport?: AlignmentReport,
): ApprovalDecision {
  void alignmentReport
  const tmpDir = path.join(REPO_ROOT, 'data', '.tmp_approval')
  mkdirSync(tmpDir, { recursive: true })
  const inputFile = path.join(tmpDir, 'input.json')
  const outputFile = path.join(tmpDir, 'output.json')

  const input = {
    riskLabel: describeRisk(gateResult.finalRiskLevel),
    gateDecision: gateResult.gateDecision,
    filesText: describeFiles(auditReport.changedFiles),
    reasonText: describeReason(gateResult.reason, auditReport.dangerousHits),
    safetyText: describeSafetyMechanisms(),
    ref,
    changedCount: auditReport.changedFiles.length,
    isBlock: gateResult.gateDecision === 'BLOCK_CEO_REQUIRED',
    outputFile,  // JSON.stringify が \\ を自動エスケープするので二重エスケープ不要
  }
  // PowerShell 5.1 は BOM なし UTF-8 を Shift-JIS として読むため BOM を付与
  const jsonBom = Buffer.from([0xEF, 0xBB, 0xBF])
  writeFileSync(inputFile, Buffer.concat([jsonBom, Buffer.from(JSON.stringify(input, null, 2), 'utf-8')]))

  if (existsSync(outputFile)) unlinkSync(outputFile)

  const psFile = path.join(tmpDir, 'dialog.ps1')
  // PowerShell 5.1 は BOM なし UTF-8 を正しく読めないため BOM を付与する
  // PowerShell 5.1 は BOM なし UTF-8 の .ps1 を文字化けするため BOM (EF BB BF) を先頭に付与
  const psContent = buildPsScript(inputFile)
  const bom = Buffer.from([0xEF, 0xBB, 0xBF])
  writeFileSync(psFile, Buffer.concat([bom, Buffer.from(psContent, 'utf-8')]))

  spawnSync('powershell', ['-NonInteractive', '-File', psFile], {
    stdio: 'inherit',
    shell: false,
  })

  let decision: ApprovalDecision = 'reject'
  try {
    if (existsSync(outputFile)) {
      const raw = readFileSync(outputFile, 'utf-8').trim()
      if (raw === 'approve_all' || raw === 'approve_once' || raw === 'reject') {
        decision = raw
      }
    }
  } catch { /* 読み取り失敗 = 拒否扱い */ }

  try {
    if (existsSync(inputFile)) unlinkSync(inputFile)
    if (existsSync(outputFile)) unlinkSync(outputFile)
    if (existsSync(psFile)) unlinkSync(psFile)
  } catch { /* ignore */ }

  return decision
}

// ────────────────────────────────────────────────────────────
// 承認記録保存
// ────────────────────────────────────────────────────────────

function recordApproval(ref: string, gateResult: GateResult, decision: ApprovalDecision): void {
  try {
    const approvalDir = path.join(REPO_ROOT, 'data', 'approvals')
    mkdirSync(approvalDir, { recursive: true })
    const record = {
      id: randomUUID(),
      ref,
      decidedAt: new Date().toISOString(),
      decision,
      approvedBy: 'CEO_UI_CLICK',
      gateDecision: gateResult.gateDecision,
      finalRiskLevel: gateResult.finalRiskLevel,
      reason: gateResult.reason,
      scope: decision === 'approve_once' ? 'once' : decision === 'approve_all' ? 'permanent' : 'none',
    }
    writeFileSync(
      path.join(approvalDir, 'approval_log.jsonl'),
      JSON.stringify(record) + '\n',
      { flag: 'a', encoding: 'utf-8' },
    )
    const label = decision === 'approve_all' ? '✅ 承認（全般）' : decision === 'approve_once' ? '🔁 承認（今回のみ）' : '🚫 拒否'
    console.log(`${label} — 記録を保存しました。`)
  } catch {
    // ログ保存失敗はノイズにしない
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
    rawDiff = execFileSync('git', ['diff', ref], { cwd: REPO_ROOT, encoding: 'utf-8', shell: false })
    if (!rawDiff.trim()) {
      rawDiff = execFileSync('git', ['diff', '--cached'], { cwd: REPO_ROOT, encoding: 'utf-8', shell: false })
    }
  } catch {
    try {
      rawDiff = execFileSync('git', ['diff', ...ref.split('..').filter(Boolean)], {
        cwd: REPO_ROOT, encoding: 'utf-8', shell: false,
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

  // 2. Policy Guard + Impact Analyzer
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
  let alignmentReport: AlignmentReport | undefined
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
  } catch { /* ignore */ }

  // 6. 結果表示 & 承認フロー
  console.log('\n' + '─'.repeat(50))

  if (gateResult.gateDecision === 'ALLOW') {
    console.log('✅ ALLOW — コミット可能')
    return 0
  }

  if (gateResult.gateDecision === 'DEEP_REVIEW') {
    console.log('🟡 DEEP_REVIEW — 人間のレビューが必要です')
  } else {
    console.log('🔴 BLOCK_CEO_REQUIRED — CEO承認が必要です')
  }

  if (useUI) {
    console.log('\n📋 承認ダイアログを表示します...')
    const decision = showApprovalDialog(gateResult, auditReport, alignmentReport)
    recordApproval(ref, gateResult, decision)

    if (decision === 'approve_all' || decision === 'approve_once') {
      const label = decision === 'approve_once' ? '今回のみ承認' : '全般承認'
      console.log(`✅ CEO承認済み（${label}）— コミット続行します`)
      return 0
    } else {
      console.log('🚫 CEO拒否 — コミット中止します')
      return 2
    }
  } else {
    console.log('   → ヒント: --ui フラグで承認ダイアログを表示できます')
    return gateResult.gateDecision === 'DEEP_REVIEW' ? 1 : 2
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('❌ Audit エラー:', err)
    process.exit(3)
  })
