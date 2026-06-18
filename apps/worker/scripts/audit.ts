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

// .env を手動ロード（dotenv 非依存）— tsx 直接実行時に process.env が未設定になる問題を回避
{
  const envPath = path.resolve(fileURLToPath(import.meta.url), '../../../../.env')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/)
      if (!m) continue
      const key = m[1].trim()
      if (key in process.env) continue
      // 前後のクォート（シングル・ダブル）を除去
      let val = m[2].trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      process.env[key] = val
    }
  }
}
import { runSafetyAudit } from '../src/guards/safetyAuditor.js'
import { runAlignmentCheck } from '../src/guards/alignmentChecker.js'
import { processGate, type GateResult } from '../src/guards/gateProcessor.js'
import { appendExecutionLog } from '../src/executionLogStore.js'
import { callGeminiForReview } from '../src/metaReviewer/geminiClient.js'
import type { AuditReport, AlignmentReport } from '@ai-team/shared'
import { randomUUID } from 'node:crypto'

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../../')
const args = process.argv.slice(2)
const useUI = args.includes('--ui')
const forceUI = args.includes('--force-ui')  // テスト用：ALLOW時もダイアログ表示
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

/**
 * Gemini に「なぜ承認が必要か」を非エンジニア向けの平文で説明させる。
 * 技術的ヒット情報は内部コンテキストとして渡し、出力は目的中心にする。
 */
async function generateWhyExplanation(
  rawDiff: string,
  changedFiles: string[],
  dangerousHits: AuditReport['dangerousHits'],
  gateDecision: string,
): Promise<string> {
  const hitSummary = dangerousHits.length > 0
    ? dangerousHits.map((h) => `- [${h.type}] ${h.value} (${h.location})`).join('\n')
    : '（技術的ヒットなし）'

  const diffPreview = rawDiff.split('\n').slice(0, 80).join('\n')

  const prompt = [
    '# 承認理由の説明文を生成してください',
    '',
    'あなたは AI 開発チームのセキュリティゲートです。',
    '以下の変更に対して、非エンジニアの経営者（CEO）が「承認するかどうか」を判断できるよう、',
    '平文で説明する文章を書いてください。',
    '',
    '## 変更されたファイル',
    changedFiles.join('\n'),
    '',
    '## セキュリティシステムが検出した懸念点（技術情報・内部参照用）',
    hitSummary,
    '',
    '## 変更の概要（git diff の先頭部分）',
    '```diff',
    diffPreview,
    '```',
    '',
    '## 出力フォーマット（必ずこの構造で日本語で書くこと）',
    '',
    '【今のままだと何ができないのか】',
    '（この変更をしない場合、何が実現できないか。現在の制約を具体的に説明する。不明な場合は「不明」と書く）',
    '',
    '【この変更で何が可能になるのか】',
    '（承認した場合に追加・改善される機能や仕組みを、目的・用途で説明する）',
    '',
    '【承認しない場合はどうなるか】',
    '（拒否した場合の影響を具体的に説明する。開発が止まるか、代替手段があるか、コストはどう変わるか。',
    ' 例：「開発は止まりませんが、この機能は完成できません」',
    ' 例：「別の方法がありますが、開発時間が増えます」',
    ' 不明な場合は「不明」と書く）',
    '',
    '【AIが懸念していること】',
    '（セキュリティシステムが検出した懸念を、技術用語を使わず説明する。',
    ' リスクを小さく見せないこと。不確実な部分は「不明」と書く。',
    ' この判断はAIによる検出であり、人間の承認の代わりにはならない）',
    '',
    '## 制約（必ず守ること）',
    '- 技術名（TypeScript, Node.js, PowerShell, API など）だけで説明しない',
    '- 「必要だから必要」の循環説明禁止',
    '- リスクを過小評価・隠蔽しない',
    '- AIの判断を人間承認として扱わない（「AIが安全と判断した」等の表現禁止）',
    '- 不確実な情報には「不明」と明記する',
    '- 各セクションは2〜4文程度',
  ].join('\n')

  try {
    const result = await callGeminiForReview(prompt)
    return result.trim()
  } catch {
    // Gemini 失敗時のフォールバック：技術情報ベースの最低限の説明
    const fallback: string[] = [
      '【今のままだと何ができないのか】',
      'Gemini による自動説明の生成に失敗しました。以下の技術情報を参考にしてください。',
      '',
      '【この変更で何が可能になるのか】',
      '（自動生成失敗 — 不明）',
      '',
      '【今やる必要がある理由】',
      '（自動生成失敗 — 不明）',
      '',
      '【AIが懸念していること】',
    ]
    if (dangerousHits.length > 0) {
      for (const h of dangerousHits) {
        if (h.type === 'file') fallback.push(`・重要ファイル「${h.value}」が変更対象に含まれています`)
        if (h.type === 'keyword') fallback.push(`・注意が必要なコード「${h.value}」が変更内に検出されました`)
      }
    } else {
      fallback.push('・技術的な自動検出項目はありませんでした')
    }
    fallback.push('')
    fallback.push(`Gate判定: ${gateDecision}`)
    return fallback.join('\n')
  }
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

type ApprovalDecision =
  | 'approve_all'
  | 'approve_once'
  | 'reject'
  | { kind: 'instructions'; text: string }

function buildPsScript(inputFilePath: string): string {
  // PowerShell スクリプトを行配列で構築（テンプレートリテラル回避）
  const NL = '\n'
  const iPath = inputFilePath.replace(/\\/g, '\\\\')
  const lines: string[] = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '',
    '$data = Get-Content -Raw -Encoding UTF8 -Path \'' + iPath + '\' | ConvertFrom-Json',
    '$script:outFile = $data.outputFile',
    '',
    '# ── フォーム ──',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.Text = "Safety Gate — CEO 承認リクエスト"',
    '$form.Size = New-Object System.Drawing.Size(800, 900)',
    '$form.StartPosition = "CenterScreen"',
    '$form.FormBorderStyle = "Sizable"',
    '$form.MinimumSize = New-Object System.Drawing.Size(700, 700)',
    '$form.BackColor = [System.Drawing.Color]::FromArgb(245, 245, 248)',
    '$form.Font = New-Object System.Drawing.Font("Meiryo UI", 9)',
    '',
    '# ── ヘッダー ──',
    '$hdr = New-Object System.Windows.Forms.Panel',
    '$hdr.Dock = "Top"',
    '$hdr.Height = 70',
    '$hdr.BackColor = if ($data.isBlock) { [System.Drawing.Color]::FromArgb(220,53,69) } else { [System.Drawing.Color]::FromArgb(255,153,0) }',
    '$hdrLbl = New-Object System.Windows.Forms.Label',
    '$hdrLbl.Text = if ($data.isBlock) { "  BLOCK — CEO承認が必要です" } else { "  DEEP REVIEW — 人間のレビューが必要です" }',
    '$hdrLbl.Font = New-Object System.Drawing.Font("Meiryo UI", 13, [System.Drawing.FontStyle]::Bold)',
    '$hdrLbl.ForeColor = [System.Drawing.Color]::White',
    '$hdrLbl.AutoSize = $false; $hdrLbl.Dock = "Fill"; $hdrLbl.TextAlign = "MiddleCenter"',
    '$hdr.Controls.Add($hdrLbl)',
    '$form.Controls.Add($hdr)',
    '',
    '# ── スクロールエリア ──',
    '$scroll = New-Object System.Windows.Forms.Panel',
    '$scroll.Location = New-Object System.Drawing.Point(0, 70)',
    '$scroll.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right',
    '$scroll.Size = New-Object System.Drawing.Size(800, 620)',
    '$scroll.AutoScroll = $true',
    '$script:sy = 10',
    '',
    '# ── セクション追加ヘルパー ──',
    'function Add-Sec($ttl, $body, $r, $g, $b) {',
    '  $pnl = New-Object System.Windows.Forms.Panel',
    '  $pnl.Location = New-Object System.Drawing.Point(10, $script:sy)',
    '  $pnl.Size = New-Object System.Drawing.Size(760, 10)',
    '  $pnl.BackColor = [System.Drawing.Color]::FromArgb($r,$g,$b)',
    '  $tl = New-Object System.Windows.Forms.Label',
    '  $tl.Text = $ttl',
    '  $tl.Font = New-Object System.Drawing.Font("Meiryo UI", 9.5, [System.Drawing.FontStyle]::Bold)',
    '  $tl.ForeColor = [System.Drawing.Color]::FromArgb(30,30,30)',
    '  $tl.Location = New-Object System.Drawing.Point(12, 8); $tl.AutoSize = $true',
    '  $pnl.Controls.Add($tl)',
    '  $bl = New-Object System.Windows.Forms.Label',
    '  $bl.Text = $body',
    '  $bl.Font = New-Object System.Drawing.Font("Meiryo UI", 9)',
    '  $bl.ForeColor = [System.Drawing.Color]::FromArgb(50,50,50)',
    '  $bl.Location = New-Object System.Drawing.Point(12, 30)',
    '  $bl.MaximumSize = New-Object System.Drawing.Size(735, 0); $bl.AutoSize = $true',
    '  $pnl.Controls.Add($bl)',
    '  $pnl.Height = $tl.Height + $bl.PreferredHeight + 48',
    '  $script:scroll.Controls.Add($pnl)',
    '  $script:sy += $pnl.Height + 8',
    '}',
    '',
    '# ── 通常セクション ──',
    'Add-Sec "❓ 何を承認するのか？" ("AIアシスタントが、このリポジトリに " + $data.changedCount + " 個のファイルを変更しようとしています。' + NL + NL + '変更対象ファイル:' + NL + '" + $data.filesText) 235 245 255',
    'Add-Sec "⚠️ なぜ承認が必要なのか？" $data.reasonText 255 248 230',
    'Add-Sec "📊 リスクレベル" ($data.riskLabel + "' + NL + NL + '🟢 低  → 通常の変更（コメント・テスト等）' + NL + '🟡 中  → 影響範囲の広い変更（設定ファイル等）' + NL + '🟠 高  → 重要ファイルへの変更（要確認）' + NL + '🔴 重大 → セキュリティ・ガード系ファイルへの変更") 255 240 240',
    'Add-Sec "🛡️ 安全に運用できる仕組みは？" $data.safetyText 235 255 240',
    '',
    '# ── 技術詳細（タイトル＋TextBox、スクロール可） ──',
    '$techPnl = New-Object System.Windows.Forms.Panel',
    '$techPnl.Location = New-Object System.Drawing.Point(10, $script:sy)',
    '$techPnl.Size = New-Object System.Drawing.Size(760, 210)',
    '$techPnl.BackColor = [System.Drawing.Color]::FromArgb(235, 235, 248)',
    '$techTtl = New-Object System.Windows.Forms.Label',
    '$techTtl.Text = "🔧 技術的な詳細（エンジニア向け）"',
    '$techTtl.Font = New-Object System.Drawing.Font("Meiryo UI", 9.5, [System.Drawing.FontStyle]::Bold)',
    '$techTtl.ForeColor = [System.Drawing.Color]::FromArgb(30,30,30)',
    '$techTtl.Location = New-Object System.Drawing.Point(12, 8)',
    '$techTtl.AutoSize = $true',
    '$techPnl.Controls.Add($techTtl)',
    '$techBox = New-Object System.Windows.Forms.TextBox',
    '$techBox.Text = $data.techDetails',
    '$techBox.Location = New-Object System.Drawing.Point(12, 34)',
    '$techBox.Size = New-Object System.Drawing.Size(736, 160)',
    '$techBox.Multiline = $true',
    '$techBox.ReadOnly = $true',
    '$techBox.ScrollBars = "Vertical"',
    '$techBox.Font = New-Object System.Drawing.Font("Courier New", 8)',
    '$techBox.BackColor = [System.Drawing.Color]::FromArgb(245, 245, 255)',
    '$techPnl.Controls.Add($techBox)',
    '$scroll.Controls.Add($techPnl)',
    '$script:sy += 218',
    '',
    '# ── 指示記入欄 ──',
    '$instrPnl = New-Object System.Windows.Forms.Panel',
    '$instrPnl.Location = New-Object System.Drawing.Point(10, $script:sy)',
    '$instrPnl.Size = New-Object System.Drawing.Size(760, 110)',
    '$instrPnl.BackColor = [System.Drawing.Color]::FromArgb(255, 253, 235)',
    '$instrLbl = New-Object System.Windows.Forms.Label',
    '$instrLbl.Text = "📝 承認せずに指示を出す（例：「原因調査だけして」「依存関係の修正は後回しにして」）"',
    '$instrLbl.Font = New-Object System.Drawing.Font("Meiryo UI", 9, [System.Drawing.FontStyle]::Bold)',
    '$instrLbl.ForeColor = [System.Drawing.Color]::FromArgb(100, 70, 0)',
    '$instrLbl.Location = New-Object System.Drawing.Point(10, 8)',
    '$instrLbl.AutoSize = $true',
    '$instrPnl.Controls.Add($instrLbl)',
    '$instrBox = New-Object System.Windows.Forms.TextBox',
    '$instrBox.Location = New-Object System.Drawing.Point(10, 30)',
    '$instrBox.Size = New-Object System.Drawing.Size(570, 60)',
    '$instrBox.Multiline = $true',
    '$instrBox.ScrollBars = "Vertical"',
    '$instrBox.Font = New-Object System.Drawing.Font("Meiryo UI", 9)',
    '$instrPnl.Controls.Add($instrBox)',
    '$instrBtn = New-Object System.Windows.Forms.Button',
    '$instrBtn.Text = "この指示で止める"',
    '$instrBtn.Location = New-Object System.Drawing.Point(590, 30)',
    '$instrBtn.Size = New-Object System.Drawing.Size(160, 60)',
    '$instrBtn.BackColor = [System.Drawing.Color]::FromArgb(180, 140, 0)',
    '$instrBtn.ForeColor = [System.Drawing.Color]::White',
    '$instrBtn.Font = New-Object System.Drawing.Font("Meiryo UI", 9, [System.Drawing.FontStyle]::Bold)',
    '$instrBtn.FlatStyle = "Flat"',
    '$instrBtn.Add_Click({',
    '  $txt = $instrBox.Text.Trim()',
    '  if ($txt.Length -gt 0) {',
    '    ("instructions:" + $txt) | Out-File -FilePath $script:outFile -Encoding utf8',
    '    $form.Close()',
    '  } else {',
    '    [System.Windows.Forms.MessageBox]::Show("指示内容を入力してください。", "入力エラー") | Out-Null',
    '  }',
    '})',
    '$instrPnl.Controls.Add($instrBtn)',
    '$scroll.Controls.Add($instrPnl)',
    '$script:sy += 118',
    '',
    '$scroll.AutoScrollMinSize = New-Object System.Drawing.Size(760, ($script:sy + 20))',
    '$form.Controls.Add($scroll)',
    '',
    '# ── ボタンパネル ──',
    '$bp = New-Object System.Windows.Forms.Panel',
    '$bp.Dock = "Bottom"',
    '$bp.Height = 76',
    '$bp.BackColor = [System.Drawing.Color]::FromArgb(225, 225, 230)',
    '',
    '$b1 = New-Object System.Windows.Forms.Button',
    '$b1.Text = "✅ 承認する（以降も有効）"',
    '$b1.Size = New-Object System.Drawing.Size(210, 46)',
    '$b1.Location = New-Object System.Drawing.Point(30, 15)',
    '$b1.BackColor = [System.Drawing.Color]::FromArgb(40,167,69)',
    '$b1.ForeColor = [System.Drawing.Color]::White',
    '$b1.Font = New-Object System.Drawing.Font("Meiryo UI", 9.5, [System.Drawing.FontStyle]::Bold)',
    '$b1.FlatStyle = "Flat"',
    '$b1.Add_Click({ "approve_all" | Out-File -FilePath $script:outFile -Encoding utf8; $form.Close() })',
    '',
    '$b2 = New-Object System.Windows.Forms.Button',
    '$b2.Text = "🔁 今回のみ承認"',
    '$b2.Size = New-Object System.Drawing.Size(210, 46)',
    '$b2.Location = New-Object System.Drawing.Point(260, 15)',
    '$b2.BackColor = [System.Drawing.Color]::FromArgb(0,123,255)',
    '$b2.ForeColor = [System.Drawing.Color]::White',
    '$b2.Font = New-Object System.Drawing.Font("Meiryo UI", 9.5, [System.Drawing.FontStyle]::Bold)',
    '$b2.FlatStyle = "Flat"',
    '$b2.Add_Click({ "approve_once" | Out-File -FilePath $script:outFile -Encoding utf8; $form.Close() })',
    '',
    '$b3 = New-Object System.Windows.Forms.Button',
    '$b3.Text = "🚫 拒否する"',
    '$b3.Size = New-Object System.Drawing.Size(210, 46)',
    '$b3.Location = New-Object System.Drawing.Point(490, 15)',
    '$b3.BackColor = [System.Drawing.Color]::FromArgb(108,117,125)',
    '$b3.ForeColor = [System.Drawing.Color]::White',
    '$b3.Font = New-Object System.Drawing.Font("Meiryo UI", 9.5, [System.Drawing.FontStyle]::Bold)',
    '$b3.FlatStyle = "Flat"',
    '$b3.Add_Click({ "reject" | Out-File -FilePath $script:outFile -Encoding utf8; $form.Close() })',
    '',
    '$bp.Controls.AddRange(@($b1, $b2, $b3))',
    '$form.Controls.Add($bp)',
    '$form.ShowDialog() | Out-Null',
  ]
  return lines.join(NL)
}

function showApprovalDialog(
  gateResult: GateResult,
  auditReport: AuditReport,
  whyText: string,
): ApprovalDecision {
  const tmpDir = path.join(REPO_ROOT, 'data', '.tmp_approval')
  mkdirSync(tmpDir, { recursive: true })
  const inputFile = path.join(tmpDir, 'input.json')
  const outputFile = path.join(tmpDir, 'output.json')

  // 技術詳細（折りたたみセクション用）
  const techLines: string[] = []
  if (auditReport.dangerousHits.length > 0) {
    techLines.push('[Policy Guard 検出]')
    for (const h of auditReport.dangerousHits) {
      techLines.push(`  ${h.type === 'file' ? 'FILE ' : 'KEYWORD '} ${h.value}  (${h.location})`)
    }
  }
  techLines.push(``)
  techLines.push(`[変更ファイル diff サマリー]`)
  for (const d of auditReport.diffSummary) {
    techLines.push(`  ${d.file}  +${d.added} -${d.removed}`)
  }
  techLines.push(``)
  techLines.push(`[Gate 判定]  ${gateResult.finalRiskLevel} → ${gateResult.gateDecision}`)
  if (gateResult.reason) techLines.push(`[理由]  ${gateResult.reason}`)

  const input = {
    riskLabel: describeRisk(gateResult.finalRiskLevel),
    gateDecision: gateResult.gateDecision,
    filesText: describeFiles(auditReport.changedFiles),
    reasonText: whyText,
    techDetails: techLines.join('\n'),
    safetyText: describeSafetyMechanisms(),
    ref,
    changedCount: auditReport.changedFiles.length,
    isBlock: gateResult.gateDecision === 'BLOCK_CEO_REQUIRED',
    outputFile,
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
      } else if (raw.startsWith('instructions:')) {
        decision = { kind: 'instructions', text: raw.slice('instructions:'.length).trim() }
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
    const isInstructions = typeof decision === 'object' && decision.kind === 'instructions'
    const decisionStr = isInstructions ? 'instructions' : decision as string
    const record = {
      id: randomUUID(),
      ref,
      decidedAt: new Date().toISOString(),
      decision: decisionStr,
      instructions: isInstructions ? (decision as { kind: string; text: string }).text : undefined,
      approvedBy: 'CEO_UI_CLICK',
      gateDecision: gateResult.gateDecision,
      finalRiskLevel: gateResult.finalRiskLevel,
      reason: gateResult.reason,
      scope: decisionStr === 'approve_once' ? 'once' : decisionStr === 'approve_all' ? 'permanent' : 'none',
    }
    writeFileSync(
      path.join(approvalDir, 'approval_log.jsonl'),
      JSON.stringify(record) + '\n',
      { flag: 'a', encoding: 'utf-8' },
    )
    const label = decisionStr === 'approve_all' ? '✅ 承認（全般）'
      : decisionStr === 'approve_once' ? '🔁 承認（今回のみ）'
      : decisionStr === 'instructions' ? '📝 指示あり（コミット中止）'
      : '🚫 拒否'
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

  if (gateResult.gateDecision === 'ALLOW' && !forceUI) {
    console.log('✅ ALLOW — コミット可能')
    return 0
  }

  if (gateResult.gateDecision === 'DEEP_REVIEW') {
    console.log('🟡 DEEP_REVIEW — 人間のレビューが必要です')
  } else if (gateResult.gateDecision === 'BLOCK_CEO_REQUIRED') {
    console.log('🔴 BLOCK_CEO_REQUIRED — CEO承認が必要です')
  } else {
    console.log('✅ ALLOW（--force-ui でダイアログ表示）')
  }

  if (useUI || forceUI) {
    console.log('\n📋 承認理由を生成中（Gemini）...')
    const whyText = await generateWhyExplanation(
      rawDiff,
      auditReport.changedFiles,
      auditReport.dangerousHits,
      gateResult.gateDecision,
    )
    console.log('\n📋 承認ダイアログを表示します...')
    const decision = showApprovalDialog(gateResult, auditReport, whyText)
    recordApproval(ref, gateResult, decision)

    if (decision === 'approve_all' || decision === 'approve_once') {
      const label = decision === 'approve_once' ? '今回のみ承認' : '全般承認'
      console.log(`✅ CEO承認済み（${label}）— コミット続行します`)
      return 0
    } else if (typeof decision === 'object' && decision.kind === 'instructions') {
      console.log(`📝 指示を受け取りました — コミット中止します`)
      console.log(`   指示内容: ${decision.text}`)
      return 2
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
