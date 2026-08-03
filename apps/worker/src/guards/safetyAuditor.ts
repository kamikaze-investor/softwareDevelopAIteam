/**
 * Safety Auditor — Policy Guard + Change Impact Analyzer
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * git diff / changed files を受け取り、以下を出力する:
 *   1. changed files リスト
 *   2. git diff summary（ファイルごとの追加/削除行数）
 *   3. 危険ファイル変更の検出
 *   4. 危険キーワード検出（ファイル名 + diff本文）
 *   5. risk level（LOW / MEDIUM / HIGH / CRITICAL）
 *   6. gate decision（ALLOW / DEEP_REVIEW / BLOCK_CEO_REQUIRED）
 *
 * 設計原則:
 *   - AIの自己申告は信用しない。実際のgit diff / ファイル名を機械的に検査する。
 *   - AIによる承認は無効。明示的な人間承認のみ承認成立とする。
 *   - このファイル自体はAIが編集できない（Control Repository）
 */

import type {
  AuditReport,
  DangerousHit,
  FileDiffSummary,
  GateDecision,
  RiskLevel,
} from '@ai-team/shared'

// ────────────────────────────────────────────────────────────
// 危険ファイルパターン（ファイル名マッチ）
// ────────────────────────────────────────────────────────────

const DANGEROUS_FILE_PATTERNS: Array<{ pattern: RegExp; reason: string; risk: RiskLevel }> = [
  // CRITICAL
  { pattern: /^\.env($|\.)/, reason: 'env file (secrets)', risk: 'CRITICAL' },
  { pattern: /approval_rules\.md$/, reason: 'approval rules definition', risk: 'CRITICAL' },
  { pattern: /design_philosophy\.md$/, reason: 'design philosophy definition', risk: 'CRITICAL' },
  { pattern: /goal\.md$/, reason: 'project goal definition', risk: 'CRITICAL' },
  { pattern: /CLAUDE\.md$/, reason: 'AI instruction file', risk: 'CRITICAL' },
  { pattern: /AGENTS\.md$/, reason: 'AI agent rules file', risk: 'CRITICAL' },
  // HIGH
  { pattern: /guards\//, reason: 'guard implementation (control repo)', risk: 'HIGH' },
  { pattern: /permissionGuard/, reason: 'permission guard', risk: 'HIGH' },
  { pattern: /fileChangeGuard/, reason: 'file change guard', risk: 'HIGH' },
  { pattern: /safetyAuditor/, reason: 'safety auditor (this file)', risk: 'HIGH' },
  { pattern: /alignmentChecker/, reason: 'alignment checker', risk: 'HIGH' },
  { pattern: /gateProcessor/, reason: 'gate processor', risk: 'HIGH' },
  { pattern: /jobRunner/, reason: 'job execution engine', risk: 'HIGH' },
  { pattern: /docker-compose/, reason: 'docker compose config', risk: 'HIGH' },
  { pattern: /Dockerfile/, reason: 'dockerfile', risk: 'HIGH' },
  { pattern: /\.github\/workflows/, reason: 'CI/CD pipeline', risk: 'HIGH' },
  { pattern: /package\.json$/, reason: 'dependency definition', risk: 'HIGH' },
  { pattern: /pnpm-lock\.yaml$/, reason: 'lockfile', risk: 'HIGH' },
  { pattern: /sandbox\//, reason: 'sandbox config', risk: 'HIGH' },
  { pattern: /auth/, reason: 'authentication related', risk: 'HIGH' },
  { pattern: /\.(pem|key|crt)$/, reason: 'certificate/key file', risk: 'CRITICAL' },
  // target側コマンド env allowlist（秘密情報の唯一の関所。2026-08-01 追加）
  { pattern: /^apps\/worker\/src\/utils\/safeEnv\.ts$/, reason: 'target command env allowlist (secrets boundary)', risk: 'CRITICAL' },
]

// ────────────────────────────────────────────────────────────
// 危険キーワード（diff本文マッチ）
// ────────────────────────────────────────────────────────────

const DANGEROUS_KEYWORDS: Array<{ keyword: RegExp; reason: string; risk: RiskLevel }> = [
  // CRITICAL
  { keyword: /\bautoApprove\b/i, reason: 'auto approval logic', risk: 'CRITICAL' },
  { keyword: /\bskipReview\b/i, reason: 'review skip logic', risk: 'CRITICAL' },
  { keyword: /\bbypassApproval\b/i, reason: 'approval bypass', risk: 'CRITICAL' },
  { keyword: /\ballowAll\b/i, reason: 'allow-all permission', risk: 'CRITICAL' },
  { keyword: /aiApproval|ai_approval/i, reason: 'AI treated as approver', risk: 'CRITICAL' },
  { keyword: /isApprovedByAI|approvedByAI/i, reason: 'AI approval check', risk: 'CRITICAL' },
  { keyword: /production/i, reason: 'production reference', risk: 'CRITICAL' },
  { keyword: /deploy\s*\(/i, reason: 'deploy function call', risk: 'CRITICAL' },
  // HIGH
  { keyword: /\bbypass\b/i, reason: 'bypass keyword', risk: 'HIGH' },
  { keyword: /\bforce\b.*push/i, reason: 'force push', risk: 'HIGH' },
  { keyword: /dangerouslyAllow/i, reason: 'dangerous allow flag', risk: 'HIGH' },
  { keyword: /--no-verify/i, reason: 'git hook skip', risk: 'HIGH' },
  { keyword: /process\.env\.(ANTHROPIC|GEMINI|OPENAI)_API_KEY\s*=/i, reason: 'API key assignment', risk: 'HIGH' },
  { keyword: /rm\s+-rf/i, reason: 'dangerous delete command', risk: 'HIGH' },
  { keyword: /sandboxMode\s*=\s*['"]?none/i, reason: 'sandbox disabled', risk: 'HIGH' },
  // MEDIUM
  { keyword: /\bsecret\b/i, reason: 'secret keyword', risk: 'MEDIUM' },
  { keyword: /\bpermission\b/i, reason: 'permission change', risk: 'MEDIUM' },
  { keyword: /external.*service|externalService/i, reason: 'external service reference', risk: 'MEDIUM' },
  { keyword: /approval/i, reason: 'approval logic', risk: 'MEDIUM' },
  { keyword: /sandbox/i, reason: 'sandbox reference', risk: 'MEDIUM' },
]

// ────────────────────────────────────────────────────────────
// リスクレベルの優先度
// ────────────────────────────────────────────────────────────

const RISK_ORDER: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}

// ────────────────────────────────────────────────────────────
// diff パーサー
// ────────────────────────────────────────────────────────────

export interface ParsedDiff {
  changedFiles: string[]
  diffSummary: FileDiffSummary[]
  diffText: string
}

/**
 * `git diff --stat` 形式または unified diff 形式を解析する。
 * changedFiles と追加/削除行数を抽出する。
 */
export function parseDiff(rawDiff: string): ParsedDiff {
  const changedFiles: string[] = []
  const diffSummary: FileDiffSummary[] = []

  // unified diff の "+++ b/path" 行からファイルを抽出
  const fileMatches = rawDiff.matchAll(/^\+\+\+ b\/(.+)$/gm)
  const seenFiles = new Set<string>()

  for (const match of fileMatches) {
    const file = match[1]
    if (!seenFiles.has(file)) {
      seenFiles.add(file)
      changedFiles.push(file)
    }
  }

  // ファイルごとの +/- 行数を集計
  let currentFile = ''
  let added = 0
  let removed = 0

  for (const line of rawDiff.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/)
    if (fileMatch) {
      if (currentFile) {
        diffSummary.push({ file: currentFile, added, removed })
      }
      currentFile = fileMatch[1]
      added = 0
      removed = 0
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  if (currentFile) {
    diffSummary.push({ file: currentFile, added, removed })
  }

  return { changedFiles, diffSummary, diffText: rawDiff }
}

// ────────────────────────────────────────────────────────────
// Policy Guard: 危険ファイル + 危険キーワード検出
// ────────────────────────────────────────────────────────────

export function runPolicyGuard(parsed: ParsedDiff): {
  hits: DangerousHit[]
  maxRiskFromPolicy: RiskLevel
} {
  const hits: DangerousHit[] = []
  let maxRiskFromPolicy: RiskLevel = 'LOW'

  // 1. 危険ファイル検出（ファイル名マッチ）
  for (const file of parsed.changedFiles) {
    for (const { pattern, reason, risk } of DANGEROUS_FILE_PATTERNS) {
      if (pattern.test(file)) {
        hits.push({ type: 'file', value: reason, location: file })
        maxRiskFromPolicy = maxRisk(maxRiskFromPolicy, risk)
        break
      }
    }
  }

  // 2. 危険キーワード検出（diff本文）
  const lines = parsed.diffText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 追加行（+）のみ検査する（削除行は過去のもの）
    if (!line.startsWith('+') || line.startsWith('+++')) continue

    for (const { keyword, reason, risk } of DANGEROUS_KEYWORDS) {
      if (keyword.test(line)) {
        hits.push({
          type: 'keyword',
          value: reason,
          location: `diff:+${i + 1}行付近`,
        })
        maxRiskFromPolicy = maxRisk(maxRiskFromPolicy, risk)
        break
      }
    }
  }

  return { hits, maxRiskFromPolicy }
}

// ────────────────────────────────────────────────────────────
// Change Impact Analyzer: 変更規模からリスクを補正
// ────────────────────────────────────────────────────────────

export function analyzeChangeImpact(parsed: ParsedDiff): RiskLevel {
  const totalAdded = parsed.diffSummary.reduce((s, f) => s + f.added, 0)
  const totalRemoved = parsed.diffSummary.reduce((s, f) => s + f.removed, 0)
  const fileCount = parsed.changedFiles.length

  // 変更規模による基本分類
  if (fileCount === 0 || (totalAdded + totalRemoved) === 0) return 'LOW'
  if (fileCount <= 3 && totalAdded + totalRemoved <= 50) return 'LOW'
  if (fileCount <= 10 && totalAdded + totalRemoved <= 300) return 'MEDIUM'
  if (fileCount <= 20 || totalAdded + totalRemoved <= 1000) return 'HIGH'
  return 'CRITICAL'
}

// ────────────────────────────────────────────────────────────
// Gate Decision
// ────────────────────────────────────────────────────────────

export function toGateDecision(risk: RiskLevel): GateDecision {
  switch (risk) {
    case 'LOW': return 'ALLOW'
    case 'MEDIUM': return 'ALLOW'
    case 'HIGH': return 'DEEP_REVIEW'
    case 'CRITICAL': return 'BLOCK_CEO_REQUIRED'
  }
}

// ────────────────────────────────────────────────────────────
// Main: runSafetyAudit
// ────────────────────────────────────────────────────────────

export interface SafetyAuditInput {
  /** git diff の生テキスト（unified diff形式） */
  rawDiff: string
  /** 識別子（commitハッシュ or タスクID） */
  ref: string
}

/**
 * Safety Audit を実行し AuditReport を返す。
 *
 * AIの自己申告ではなく、実際のgit diffを検査する。
 * AIによる承認は無効。このレポートはログに残す。
 */
export function runSafetyAudit(input: SafetyAuditInput): AuditReport {
  const parsed = parseDiff(input.rawDiff)
  const { hits, maxRiskFromPolicy } = runPolicyGuard(parsed)
  const impactRisk = analyzeChangeImpact(parsed)

  const riskLevel = maxRisk(maxRiskFromPolicy, impactRisk)
  const gateDecision = toGateDecision(riskLevel)

  const blockedReason =
    gateDecision !== 'ALLOW'
      ? buildBlockedReason(riskLevel, hits)
      : undefined

  return {
    ref: input.ref,
    changedFiles: parsed.changedFiles,
    diffSummary: parsed.diffSummary,
    dangerousHits: hits,
    riskLevel,
    gateDecision,
    blockedReason,
    auditedAt: new Date().toISOString(),
  }
}

function buildBlockedReason(risk: RiskLevel, hits: DangerousHit[]): string {
  const parts: string[] = [`Risk: ${risk}`]
  if (hits.length > 0) {
    const fileHits = hits.filter((h) => h.type === 'file').map((h) => h.value)
    const kwHits = hits.filter((h) => h.type === 'keyword').map((h) => h.value)
    if (fileHits.length > 0) parts.push(`Dangerous files: ${fileHits.join(', ')}`)
    if (kwHits.length > 0) parts.push(`Dangerous keywords: ${kwHits.join(', ')}`)
  }
  return parts.join(' | ')
}
