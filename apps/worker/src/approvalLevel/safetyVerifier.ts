import path from 'node:path'
import {
  MECHANICAL_GATE_PATTERNS,
  runMechanicalGate,
} from '@ai-team/shared'
import type {
  ApprovalLevelResult,
  MechanicalGatePattern,
} from '@ai-team/shared'

/** typecheck / test の実行結果（jobRunner側でexecFileSync実行後に渡す。ここでは実行しない） */
export interface CommandExecutionResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export type SafetyCheckId =
  | 'UNEXPECTED_FILES'
  | 'MECHANICAL_GATE_FILES'
  | 'POST_TEST_HOOK'
  | 'META_REVIEW_CODE'
  | 'APPROVAL_GATE_WEAKENING'
  | 'PERMISSION_GUARD_WEAKENING'
  | 'SECRET_SCAN_WEAKENING'
  | 'OUTSIDE_REPO_FILES'
  | 'TYPECHECK'
  | 'RELATED_TESTS'
  | 'FULL_TESTS'
  | 'PURPOSE_DIFF_ALIGNMENT'

export interface SafetyCheckResult {
  id: SafetyCheckId
  passed: boolean
  /** blocking=true なら1件でも失敗でVerifier全体をfail扱いにする */
  blocking: boolean
  detail: string
  /** 検出したファイル名・パターン等の根拠 */
  evidence?: string[]
}

export interface SafetyVerificationInput {
  jobId: string
  taskId: string
  /** 事前に許可された変更範囲。未指定ならUNEXPECTED_FILESチェックをスキップ扱い（passed:true） */
  allowedPaths?: string[]
  changedFiles: string[]
  diffText: string
  /** determineApprovalLevel() の結果をそのまま渡す（実装前のMechanical Gate判定） */
  approvalLevelResult: ApprovalLevelResult
  /** リポジトリルートの絶対パス（境界チェック用） */
  repoRoot: string
  typecheckResult?: CommandExecutionResult
  relatedTestResult?: CommandExecutionResult
  fullTestResult?: CommandExecutionResult
  /**
   * Post-Review AI（別AI）による「実装目的とdiffが整合しているか」の判定。
   * Step3時点ではPost-Reviewは未実装のため、呼び出し側は未指定(undefined)で渡すことになる。
   * 'aligned' | 'misaligned' | 'unknown' | undefined のいずれか。
   */
  postReviewAlignmentVerdict?: 'aligned' | 'misaligned' | 'unknown'
}

export interface SafetyVerificationResult {
  jobId: string
  taskId: string
  /** 12項目すべてpassed（blocking違反なし）の場合のみ true */
  overallPassed: boolean
  checks: SafetyCheckResult[]
  /** blockingかつfailedだったcheckのid一覧（空なら通過） */
  blockingFailures: SafetyCheckId[]
  verifiedAt: string
}

type MechanicalGatePatternType = MechanicalGatePattern['type']

const SECRET_IDENTIFIER_DELETION_PATTERN = /^-.*\b(isPromptSafe|CONTEXT_SECRET_PATTERNS)\b/m

function normalizePathForPattern(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function normalizePathForPrefix(filePath: string): string {
  const normalized = normalizePathForPattern(filePath).replace(/\/+$/u, '')
  return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

function getMechanicalGatePattern(
  id: string,
  expectedType: MechanicalGatePatternType,
): MechanicalGatePattern {
  const pattern = MECHANICAL_GATE_PATTERNS.find(candidate =>
    candidate.id === id && candidate.type === expectedType,
  )

  if (!pattern) {
    throw new Error(`Mechanical Gate pattern ${id} not found`)
  }

  return pattern
}

function getMechanicalGatePatterns(
  ids: string[],
  expectedType: MechanicalGatePatternType,
): MechanicalGatePattern[] {
  return ids.map(id => getMechanicalGatePattern(id, expectedType))
}

function findMatchingFiles(changedFiles: string[], pattern: MechanicalGatePattern): string[] {
  return changedFiles
    .map(normalizePathForPattern)
    .filter(file => pattern.pattern.test(file))
}

function hasMatchingFile(changedFiles: string[], patterns: MechanicalGatePattern[]): boolean {
  return changedFiles
    .map(normalizePathForPattern)
    .some(file => patterns.some(pattern => pattern.pattern.test(file)))
}

function getMatchingDiffPatternLabels(diffText: string, patterns: MechanicalGatePattern[]): string[] {
  return patterns
    .filter(pattern => pattern.pattern.test(diffText))
    .map(pattern => pattern.label)
}

function buildCommandResultCheck(
  id: SafetyCheckId,
  result: CommandExecutionResult | undefined,
  label: string,
): SafetyCheckResult {
  if (!result) {
    return {
      id,
      passed: false,
      blocking: true,
      detail: `${label}が未実行`,
    }
  }

  if (result.exitCode === 0) {
    return {
      id,
      passed: true,
      blocking: true,
      detail: `${label}通過`,
    }
  }

  return {
    id,
    passed: false,
    blocking: true,
    detail: `${label}失敗`,
    evidence: [result.stderr.slice(0, 500)],
  }
}

export function checkUnexpectedFiles(
  changedFiles: string[],
  allowedPaths?: string[],
): SafetyCheckResult {
  if (allowedPaths === undefined) {
    return {
      id: 'UNEXPECTED_FILES',
      passed: true,
      blocking: true,
      detail: 'allowedPaths未指定のためスキップ',
    }
  }

  const normalizedAllowedPaths = allowedPaths.map(normalizePathForPrefix)
  const unexpectedFiles = changedFiles
    .map(normalizePathForPrefix)
    .filter(file => !normalizedAllowedPaths.some(allowedPath =>
      file === allowedPath || file.startsWith(`${allowedPath}/`),
    ))

  if (unexpectedFiles.length === 0) {
    return {
      id: 'UNEXPECTED_FILES',
      passed: true,
      blocking: true,
      detail: '変更ファイルはすべてallowedPaths内',
    }
  }

  return {
    id: 'UNEXPECTED_FILES',
    passed: false,
    blocking: true,
    detail: 'allowedPaths外のファイル変更を検出',
    evidence: unexpectedFiles,
  }
}

export function checkMechanicalGateFiles(
  preImplementationResult: ApprovalLevelResult,
  changedFiles: string[],
  diffText: string,
): SafetyCheckResult {
  const postImplementationResult = runMechanicalGate(changedFiles, diffText)

  if (!preImplementationResult.mechanicalGate.triggered && postImplementationResult.triggered) {
    return {
      id: 'MECHANICAL_GATE_FILES',
      passed: false,
      blocking: true,
      detail: '実装後にMechanical Gate対象への変更を検出',
      evidence: postImplementationResult.hits.map(hit => hit.label),
    }
  }

  return {
    id: 'MECHANICAL_GATE_FILES',
    passed: true,
    blocking: true,
    detail: 'Mechanical Gate対象ファイルへの新規変更なし',
  }
}

export function checkPostTestHookUntouched(changedFiles: string[]): SafetyCheckResult {
  const pattern = getMechanicalGatePattern('MG-F01', 'file')
  const matchedFiles = findMatchingFiles(changedFiles, pattern)

  if (matchedFiles.length === 0) {
    return {
      id: 'POST_TEST_HOOK',
      passed: true,
      blocking: true,
      detail: 'postTestHook.ps1は変更されていない',
    }
  }

  return {
    id: 'POST_TEST_HOOK',
    passed: false,
    blocking: true,
    detail: 'postTestHook.ps1の変更を検出',
    evidence: matchedFiles,
  }
}

export function checkMetaReviewCodeUntouched(changedFiles: string[]): SafetyCheckResult {
  const pattern = getMechanicalGatePattern('MG-F02', 'file')
  const matchedFiles = findMatchingFiles(changedFiles, pattern)

  if (matchedFiles.length === 0) {
    return {
      id: 'META_REVIEW_CODE',
      passed: true,
      blocking: true,
      detail: 'Meta Review関連コードは変更されていない',
    }
  }

  return {
    id: 'META_REVIEW_CODE',
    passed: false,
    blocking: true,
    detail: 'Meta Review関連コードの変更を検出',
    evidence: matchedFiles,
  }
}

export function checkApprovalGateWeakening(changedFiles: string[], diffText: string): SafetyCheckResult {
  const targetFilePatterns = getMechanicalGatePatterns(['MG-F03', 'MG-F04', 'MG-F05'], 'file')
  const weakeningDiffPatterns = getMechanicalGatePatterns(['MG-D06', 'MG-D08'], 'diff')
  const matchedLabels = hasMatchingFile(changedFiles, targetFilePatterns)
    ? getMatchingDiffPatternLabels(diffText, weakeningDiffPatterns)
    : []

  if (matchedLabels.length > 0) {
    return {
      id: 'APPROVAL_GATE_WEAKENING',
      passed: false,
      blocking: true,
      detail: 'Approval Gate関連ファイルで弱体化パターンを検出',
      evidence: matchedLabels,
    }
  }

  return {
    id: 'APPROVAL_GATE_WEAKENING',
    passed: true,
    blocking: true,
    detail: 'Approval Gate弱体化パターンは検出されなかった',
  }
}

export function checkPermissionGuardWeakening(changedFiles: string[], diffText: string): SafetyCheckResult {
  const targetFilePatterns = getMechanicalGatePatterns(['MG-F06'], 'file')
  const weakeningDiffPatterns = getMechanicalGatePatterns(['MG-D06', 'MG-D03'], 'diff')
  const matchedLabels = hasMatchingFile(changedFiles, targetFilePatterns)
    ? getMatchingDiffPatternLabels(diffText, weakeningDiffPatterns)
    : []

  if (matchedLabels.length > 0) {
    return {
      id: 'PERMISSION_GUARD_WEAKENING',
      passed: false,
      blocking: true,
      detail: 'Permission Guard関連ファイルで弱体化パターンを検出',
      evidence: matchedLabels,
    }
  }

  return {
    id: 'PERMISSION_GUARD_WEAKENING',
    passed: true,
    blocking: true,
    detail: 'Permission Guard弱体化パターンは検出されなかった',
  }
}

export function checkSecretScanWeakening(changedFiles: string[], diffText: string): SafetyCheckResult {
  const pathUtilsPattern = getMechanicalGatePattern('MG-F11', 'file')
  const apiKeyPattern = getMechanicalGatePattern('MG-D09', 'diff')
  const evidence: string[] = []
  const matchedPathUtilsFiles = findMatchingFiles(changedFiles, pathUtilsPattern)

  if (apiKeyPattern.pattern.test(diffText)) {
    evidence.push(apiKeyPattern.label)
  }

  if (SECRET_IDENTIFIER_DELETION_PATTERN.test(diffText)) {
    evidence.push('isPromptSafe/CONTEXT_SECRET_PATTERNS削除')
    evidence.push(...matchedPathUtilsFiles)
  }

  if (evidence.length > 0) {
    return {
      id: 'SECRET_SCAN_WEAKENING',
      passed: false,
      blocking: true,
      detail: 'Secret Scan弱体化の疑いを検出',
      evidence,
    }
  }

  return {
    id: 'SECRET_SCAN_WEAKENING',
    passed: true,
    blocking: true,
    detail: 'Secret Scan弱体化パターンは検出されなかった',
  }
}

export function checkOutsideRepoFiles(changedFiles: string[], repoRoot: string): SafetyCheckResult {
  const outsideRepoFiles = changedFiles.filter(file => {
    const resolved = path.resolve(repoRoot, file)
    const relativePath = path.relative(repoRoot, resolved)

    return relativePath.startsWith('..') || path.isAbsolute(relativePath)
  })

  if (outsideRepoFiles.length === 0) {
    return {
      id: 'OUTSIDE_REPO_FILES',
      passed: true,
      blocking: true,
      detail: 'リポジトリ外ファイルの変更なし',
    }
  }

  return {
    id: 'OUTSIDE_REPO_FILES',
    passed: false,
    blocking: true,
    detail: 'リポジトリ外ファイルの変更を検出',
    evidence: outsideRepoFiles,
  }
}

export function checkTypecheckResult(result?: CommandExecutionResult): SafetyCheckResult {
  return buildCommandResultCheck('TYPECHECK', result, 'typecheck')
}

export function checkRelatedTestResult(result?: CommandExecutionResult): SafetyCheckResult {
  return buildCommandResultCheck('RELATED_TESTS', result, '関連テスト')
}

export function checkFullTestResult(result?: CommandExecutionResult): SafetyCheckResult {
  return buildCommandResultCheck('FULL_TESTS', result, '全テスト')
}

export function checkPurposeDiffAlignment(
  verdict?: 'aligned' | 'misaligned' | 'unknown',
): SafetyCheckResult {
  if (verdict === 'aligned') {
    return {
      id: 'PURPOSE_DIFF_ALIGNMENT',
      passed: true,
      blocking: true,
      detail: 'Post-Review verdict: aligned',
    }
  }

  if (verdict === 'misaligned') {
    return {
      id: 'PURPOSE_DIFF_ALIGNMENT',
      passed: false,
      blocking: true,
      detail: 'Post-Review verdict: misaligned',
    }
  }

  return {
    id: 'PURPOSE_DIFF_ALIGNMENT',
    passed: false,
    blocking: true,
    detail: 'Post-Review未実施または判定不能',
  }
}

export function runSafetyVerification(
  input: SafetyVerificationInput,
): SafetyVerificationResult {
  const checks: SafetyCheckResult[] = [
    checkUnexpectedFiles(input.changedFiles, input.allowedPaths),
    checkMechanicalGateFiles(input.approvalLevelResult, input.changedFiles, input.diffText),
    checkPostTestHookUntouched(input.changedFiles),
    checkMetaReviewCodeUntouched(input.changedFiles),
    checkApprovalGateWeakening(input.changedFiles, input.diffText),
    checkPermissionGuardWeakening(input.changedFiles, input.diffText),
    checkSecretScanWeakening(input.changedFiles, input.diffText),
    checkOutsideRepoFiles(input.changedFiles, input.repoRoot),
    checkTypecheckResult(input.typecheckResult),
    checkRelatedTestResult(input.relatedTestResult),
    checkFullTestResult(input.fullTestResult),
    checkPurposeDiffAlignment(input.postReviewAlignmentVerdict),
  ]

  const blockingFailures = checks
    .filter(check => check.blocking && !check.passed)
    .map(check => check.id)

  return {
    jobId: input.jobId,
    taskId: input.taskId,
    overallPassed: blockingFailures.length === 0,
    checks,
    blockingFailures,
    verifiedAt: new Date().toISOString(),
  }
}
