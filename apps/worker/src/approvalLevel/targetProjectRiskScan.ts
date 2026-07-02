import { MECHANICAL_GATE_PATTERNS } from '@ai-team/shared'

export interface TargetProjectRiskScanInput {
  changedFiles: string[]
  diffText: string
}

/**
 * target_project向けリスク種別。
 * 注意: これらの検出（hasRisk:true）は自動停止・CEO承認必須・commit禁止・
 * Level3扱いを一切意味しない。あくまで「注意すべきリスクシグナルが見つかった」
 * ことを示すだけの検出結果である。
 */
export type RiskScanIssueId =
  | 'ENV_FILE_CHANGED'
  | 'CI_WORKFLOW_CHANGED'
  | 'DEPLOY_CONFIG_CHANGED'
  | 'NPMRC_CHANGED'
  | 'INFRA_AS_CODE_CHANGED'
  | 'TEST_SKIP_ADDED'
  | 'GUARD_BYPASS_ADDED'
  | 'GIT_HOOK_SKIP_ADDED'
  | 'FORCE_PUSH_ADDED'
  | 'EMPTY_CATCH_ADDED'
  | 'HARDCODED_SECRET_ADDED'
  | 'DESTRUCTIVE_COMMAND_ADDED'
  | 'PAYMENT_CODE_ADDED'
  | 'PROD_DEPLOY_CONFIG_CHANGED'
  | 'REMOTE_CODE_EXECUTION_ADDED'
  | 'AUTH_CHECK_WEAKENED'

/**
 * リスクの重さの分類（Risk Scan Handling v1）。
 * 注意: この段階ではまだ運用ルールの実行を意味しない。
 * 「highなら停止」「mediumなら通知」「commit不可」「CEO承認必須」等は
 * 一切実装していない。将来の通知/停止/commitGate判断のための土台のみ。
 */
export type RiskScanSeverity = 'high' | 'medium' | 'low'

export interface RiskScanIssue {
  id: RiskScanIssueId
  label: string
  detail: string
  evidence: string[]
  severity: RiskScanSeverity
}

export interface TargetProjectRiskScanResult {
  /**
   * 注意すべきリスクシグナルが1件でもあるか。
   * true であっても、自動停止・CEO承認必須・commit禁止・Level3扱いを
   * 一切意味しない。あくまで検出結果である。
   */
  hasRisk: boolean
  issues: RiskScanIssue[]
  /**
   * issuesの中で最も重いseverity。issuesが空の場合はundefined。
   * こちらも同様に、まだ運用ルールの実行は意味しない。
   */
  highestSeverity?: RiskScanSeverity
  scannedAt: string
}

const ENV_FILE_PATTERN = /(^|\/)\.env(\.|$)/
const CI_WORKFLOW_PATTERN = /^\.github\/workflows\//
const DEPLOY_CONFIG_PATTERN = /docker-compose.*\.ya?ml$|Dockerfile$|vercel\.json$|netlify\.toml$|wrangler\.toml$/i
const NPMRC_PATTERN = /(^|\/)\.npmrc$/
const INFRA_AS_CODE_PATTERN = /\.tf$|^terraform\//i
const REMOTE_CODE_EXECUTION_PATTERN = /^\+.*(curl|wget).*\|\s*(sh|bash)/im
const AUTH_CHECK_WEAKENED_PATTERN = /^-.*(isAdmin|isAuthenticated|requireAuth|checkPermission)/m

const ISSUE_SEVERITY: Record<RiskScanIssueId, RiskScanSeverity> = {
  HARDCODED_SECRET_ADDED: 'high',
  DESTRUCTIVE_COMMAND_ADDED: 'high',
  REMOTE_CODE_EXECUTION_ADDED: 'high',
  ENV_FILE_CHANGED: 'medium',
  CI_WORKFLOW_CHANGED: 'medium',
  DEPLOY_CONFIG_CHANGED: 'medium',
  PROD_DEPLOY_CONFIG_CHANGED: 'medium',
  PAYMENT_CODE_ADDED: 'medium',
  AUTH_CHECK_WEAKENED: 'medium',
  GUARD_BYPASS_ADDED: 'medium',
  NPMRC_CHANGED: 'medium',
  INFRA_AS_CODE_CHANGED: 'medium',
  TEST_SKIP_ADDED: 'low',
  GIT_HOOK_SKIP_ADDED: 'low',
  FORCE_PUSH_ADDED: 'low',
  EMPTY_CATCH_ADDED: 'low',
}

const SEVERITY_ORDER: Record<RiskScanSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
}

const MECHANICAL_GATE_DIFF_ISSUE_IDS: Partial<Record<string, RiskScanIssueId>> = {
  'MG-D01': 'TEST_SKIP_ADDED',
  'MG-D02': 'TEST_SKIP_ADDED',
  'MG-D03': 'GUARD_BYPASS_ADDED',
  'MG-D04': 'GIT_HOOK_SKIP_ADDED',
  'MG-D05': 'FORCE_PUSH_ADDED',
  'MG-D06': 'GUARD_BYPASS_ADDED',
  'MG-D07': 'EMPTY_CATCH_ADDED',
  'MG-D08': 'GUARD_BYPASS_ADDED',
  'MG-D09': 'HARDCODED_SECRET_ADDED',
  'MG-D10': 'DESTRUCTIVE_COMMAND_ADDED',
  'MG-D11': 'PAYMENT_CODE_ADDED',
  'MG-D12': 'PROD_DEPLOY_CONFIG_CHANGED',
}

function normalizePathForPattern(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function findMatchingChangedFiles(changedFiles: string[], pattern: RegExp): string[] {
  return changedFiles
    .map(normalizePathForPattern)
    .filter(file => pattern.test(file))
}

function buildFileIssue(
  changedFiles: string[],
  pattern: RegExp,
  id: RiskScanIssueId,
  label: string,
  detail: string,
): RiskScanIssue | undefined {
  const matched = findMatchingChangedFiles(changedFiles, pattern)

  if (matched.length === 0) return undefined

  return {
    id,
    label,
    detail,
    evidence: matched,
    severity: ISSUE_SEVERITY[id],
  }
}

function getPatternMatchText(pattern: RegExp, text: string): string | undefined {
  const matcher = new RegExp(pattern.source, pattern.flags)
  const match = matcher.exec(text)

  return match?.[0]
}

function buildDiffIssue(
  diffText: string,
  pattern: RegExp,
  id: RiskScanIssueId,
  label: string,
  detail: string,
): RiskScanIssue | undefined {
  const matched = getPatternMatchText(pattern, diffText)

  if (matched === undefined) return undefined

  return {
    id,
    label,
    detail,
    evidence: [matched],
    severity: ISSUE_SEVERITY[id],
  }
}

export function checkEnvFileChanged(changedFiles: string[]): RiskScanIssue | undefined {
  return buildFileIssue(
    changedFiles,
    ENV_FILE_PATTERN,
    'ENV_FILE_CHANGED',
    '秘密情報ファイル（.env）の変更',
    '.env または .env.* ファイルが変更されています。秘密情報の露出に注意してください。',
  )
}

export function checkCiWorkflowChanged(changedFiles: string[]): RiskScanIssue | undefined {
  return buildFileIssue(
    changedFiles,
    CI_WORKFLOW_PATTERN,
    'CI_WORKFLOW_CHANGED',
    'CIワークフローの変更',
    '.github/workflows 配下のCI/CD設定が変更されています。自動実行環境への影響に注意してください。',
  )
}

export function checkDeployConfigChanged(changedFiles: string[]): RiskScanIssue | undefined {
  return buildFileIssue(
    changedFiles,
    DEPLOY_CONFIG_PATTERN,
    'DEPLOY_CONFIG_CHANGED',
    'デプロイ設定の変更',
    'Dockerfile、docker-compose、Vercel、Netlify、Wranglerなどのデプロイ設定が変更されています。',
  )
}

export function checkNpmrcChanged(changedFiles: string[]): RiskScanIssue | undefined {
  return buildFileIssue(
    changedFiles,
    NPMRC_PATTERN,
    'NPMRC_CHANGED',
    '.npmrcの変更',
    '.npmrc が変更されています。レジストリ設定や認証設定の露出に注意してください。',
  )
}

export function checkInfraAsCodeChanged(changedFiles: string[]): RiskScanIssue | undefined {
  return buildFileIssue(
    changedFiles,
    INFRA_AS_CODE_PATTERN,
    'INFRA_AS_CODE_CHANGED',
    'Infrastructure as Codeの変更',
    'Terraform関連ファイルが変更されています。インフラ構成への影響に注意してください。',
  )
}

export function checkMechanicalGateDiffPatterns(diffText: string): RiskScanIssue[] {
  return MECHANICAL_GATE_PATTERNS
    .filter(pattern => pattern.type === 'diff')
    .map((pattern): RiskScanIssue | undefined => {
      const issueId = MECHANICAL_GATE_DIFF_ISSUE_IDS[pattern.id]
      const matched = getPatternMatchText(pattern.pattern, diffText)

      if (issueId === undefined || matched === undefined) return undefined

      return {
        id: issueId,
        label: pattern.label,
        detail: pattern.reason,
        evidence: [matched],
        severity: ISSUE_SEVERITY[issueId],
      }
    })
    .filter((issue): issue is RiskScanIssue => issue !== undefined)
}

export function checkRemoteCodeExecution(diffText: string): RiskScanIssue | undefined {
  return buildDiffIssue(
    diffText,
    REMOTE_CODE_EXECUTION_PATTERN,
    'REMOTE_CODE_EXECUTION_ADDED',
    'リモートコード実行コマンドの追加',
    'curl または wget の出力を shell に直接渡す変更が追加されています。',
  )
}

export function checkAuthCheckWeakened(diffText: string): RiskScanIssue | undefined {
  return buildDiffIssue(
    diffText,
    AUTH_CHECK_WEAKENED_PATTERN,
    'AUTH_CHECK_WEAKENED',
    '認証・認可チェックの削除',
    'isAdmin、isAuthenticated、requireAuth、checkPermission などの認証・認可チェック削除が検出されました。',
  )
}

export function scanTargetProjectRisk(
  input: TargetProjectRiskScanInput,
): TargetProjectRiskScanResult {
  const fileIssues = [
    checkEnvFileChanged(input.changedFiles),
    checkCiWorkflowChanged(input.changedFiles),
    checkDeployConfigChanged(input.changedFiles),
    checkNpmrcChanged(input.changedFiles),
    checkInfraAsCodeChanged(input.changedFiles),
  ].filter((issue): issue is RiskScanIssue => issue !== undefined)

  const diffIssues = [
    ...checkMechanicalGateDiffPatterns(input.diffText),
    checkRemoteCodeExecution(input.diffText),
    checkAuthCheckWeakened(input.diffText),
  ].filter((issue): issue is RiskScanIssue => issue !== undefined)

  const issues = [...fileIssues, ...diffIssues]

  return {
    hasRisk: issues.length > 0,
    issues,
    highestSeverity: computeHighestSeverity(issues),
    scannedAt: new Date().toISOString(),
  }
}

function computeHighestSeverity(issues: RiskScanIssue[]): RiskScanSeverity | undefined {
  if (issues.length === 0) return undefined

  return issues.reduce<RiskScanSeverity>(
    (highest, issue) => (SEVERITY_ORDER[issue.severity] > SEVERITY_ORDER[highest] ? issue.severity : highest),
    issues[0].severity,
  )
}

/**
 * TargetProjectRiskScanResult を人間が読める一行サマリーに整形する。
 *
 * これはwarning表示・通知・自動停止への接続ではない。
 * risk scan結果を読みやすい文字列に整形するだけのヘルパー関数である。
 */
export function formatRiskScanSummary(result: TargetProjectRiskScanResult): string | undefined {
  if (!result.hasRisk || result.issues.length === 0) return undefined

  const severity = result.highestSeverity ?? computeHighestSeverity(result.issues)
  const issueLabels = result.issues.map(issue => issue.label).join(', ')

  return `[Target Project Risk Scan] ${severity} risk detected: ${issueLabels}`
}
