/**
 * Job Runner — Job 実行エンジン
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 1Job = 1SafeCommand を安全に実行して結果を返す。
 * AI CLI の呼び出しは task-022 以降で実装する。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Job, JobGuardResult, PermissionBlockEvent, RollbackInfo } from '@ai-team/shared'
import { runRiskReview } from '@ai-team/shared'
import { resolveCommand } from './commandResolver.js'
import { fileChangeGuard } from './guards/fileChangeGuard.js'
import { saveJobLogs } from './jobLogger.js'
import { permissionGuard, permissionGuardWithGrants } from './guards/permissionGuard.js'
import { callGateCheck, callConsume } from './guards/gateClient.js'
import { resolvePolicy } from './guards/gatePolicy.js'
import type { EffectivePolicy } from './guards/gatePolicy.js'
import { toGateDecision } from './guards/safetyAuditor.js'
import type { GateResult } from './guards/gateProcessor.js'

const JOB_TIMEOUT_MS = 120_000
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000'

interface ExecFileFailure {
  status?: number
  stdout?: string | Buffer
  stderr?: string | Buffer
}

export interface JobRunResult {
  status: 'success' | 'failed' | 'blocked'
  exitCode?: number
  stdout?: string
  stderr?: string
  stdoutPath?: string
  stderrPath?: string
  changedFiles?: string[]
  guardResult: JobGuardResult
  startedAt: string
  completedAt: string
  permissionBlockEvent?: PermissionBlockEvent
  rollbackInfo?: RollbackInfo
  gatePolicy?: EffectivePolicy
  gateBlockReason?: string
}

/**
 * Job を実行して結果を返す
 * - Permission Guard (with grants) → Gate Check → commandResolver → execFileSync → File Change Guard
 */
export async function runJob(job: Job): Promise<JobRunResult> {
  const startedAt = new Date().toISOString()

  const guardCheck = await permissionGuardWithGrants(
    job.safeCommand,
    job.agentRole,
    job.taskId,
    job.id,
    API_BASE_URL,
  )
  const guardResult: JobGuardResult = {
    permissionAllowed: guardCheck.allowed,
    permissionReason: guardCheck.reason,
    fileChangeAllowed: true,
    fileViolations: [],
  }

  if (!guardCheck.allowed) {
    return {
      status: 'blocked',
      guardResult,
      startedAt,
      completedAt: new Date().toISOString(),
      permissionBlockEvent: guardCheck.blockEvent,
    }
  }

  // ── Approval Gate check (Step 3A) ──
  const workingDir = job.safeCommand.workingDir
  const preChangedFiles = getChangedFiles(workingDir)
  const preDiffText = getPreGateDiffText(workingDir)
  const targetDiffHash = createHash('sha256').update(preDiffText, 'utf-8').digest('hex')
  const targetCommit = getCommitHash(workingDir) ?? ''
  const targetBranch = getTargetBranch(workingDir)
  const localGateResult = buildLocalGateResult(preChangedFiles)

  let checkResponse
  let apiError: unknown
  try {
    checkResponse = await callGateCheck({
      taskId: job.taskId,
      requestedAction: job.safeCommand.kind,
      targetBranch,
      targetCommit,
      targetDiffHash,
      changedFiles: preChangedFiles,
    })
  } catch (err) {
    apiError = err
    console.error(`[gate] callGateCheck failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const gateResult = resolvePolicy(localGateResult, checkResponse, apiError)

  if (gateResult.policy === 'block_until_approved' || gateResult.policy === 're_check') {
    console.warn(`[gate] ${gateResult.policy}: taskId=${job.taskId} reason="${gateResult.reason}"`)
    return {
      status: 'blocked',
      guardResult: {
        permissionAllowed: true,
        permissionReason: undefined,
        fileChangeAllowed: true,
        fileViolations: [],
      },
      gatePolicy: gateResult.policy,
      gateBlockReason: gateResult.reason,
      startedAt,
      completedAt: new Date().toISOString(),
    }
  }

  if (gateResult.policy === 'continue_safe_work_only') {
    const kind = job.safeCommand.kind
    if (kind === 'git_commit' || kind === 'git_revert') {
      console.warn(`[gate] safe_work_only: ${kind} is not permitted. taskId=${job.taskId}`)
      return {
        status: 'blocked',
        guardResult: {
          permissionAllowed: true,
          permissionReason: undefined,
          fileChangeAllowed: true,
          fileViolations: [],
        },
        gatePolicy: gateResult.policy,
        gateBlockReason: `safe_work_only: ${kind} not permitted`,
        startedAt,
        completedAt: new Date().toISOString(),
      }
    }
  }

  // ── consume (Step 3B) ──
  if (checkResponse?.nextAction?.action === 'call_consume') {
    const consumeRequestId = checkResponse.nextAction.consumedRequestId
    if (!consumeRequestId) {
      console.error('[gate] consume requested but consumedRequestId is missing')
      return {
        status: 'blocked',
        guardResult: {
          permissionAllowed: true,
          permissionReason: undefined,
          fileChangeAllowed: true,
          fileViolations: [],
        },
        gatePolicy: 'block_until_approved',
        gateBlockReason: 'consume requested but consumedRequestId is missing',
        startedAt,
        completedAt: new Date().toISOString(),
      }
    }

    console.log(`[gate] consuming approval request: requestId=${consumeRequestId}`)
    try {
      const consumeResult = await callConsume(consumeRequestId, {
        currentCommit: targetCommit,
        currentDiffHash: targetDiffHash,
      })
      if (consumeResult.alreadyConsumed) {
        console.warn(`[gate] approval already consumed: requestId=${consumeRequestId}`)
      } else {
        console.log(`[gate] approval consumed: requestId=${consumeRequestId}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[gate] consume failed: ${message}`)
      return {
        status: 'blocked',
        guardResult: {
          permissionAllowed: true,
          permissionReason: undefined,
          fileChangeAllowed: true,
          fileViolations: [],
        },
        gatePolicy: 'block_until_approved',
        gateBlockReason: `consume failed: ${message}`,
        startedAt,
        completedAt: new Date().toISOString(),
      }
    }
  }
  // ── Gate check end ──

  const resolved = resolveCommand(job.safeCommand)
  const isAtomic = ['git_commit', 'git_revert'].includes(job.safeCommand.kind)

  let exitCode = 0
  let stdout = ''
  let stderr = ''
  let beforeCommitHash: string | undefined
  let afterCommitHash: string | undefined

  if (!job.dryRun) {
    // アトミックジョブの場合は実行前コミットハッシュを記録
    if (isAtomic) {
      beforeCommitHash = getCommitHash(job.safeCommand.workingDir)
    }

    try {
      stdout = execFileSync(resolved.argv[0], resolved.argv.slice(1), {
        cwd: job.safeCommand.workingDir,
        shell: false,
        timeout: isAtomic ? undefined : JOB_TIMEOUT_MS,
        encoding: 'utf-8',
      })
    } catch (err: unknown) {
      const failure = toExecFileFailure(err)
      exitCode = typeof failure.status === 'number' ? failure.status : 1
      stdout = outputToString(failure.stdout)
      stderr = outputToString(failure.stderr) || formatUnknownError(err)
    }

    // アトミックジョブの場合は実行後コミットハッシュを記録
    if (isAtomic) {
      afterCommitHash = getCommitHash(job.safeCommand.workingDir)
    }
  }

  const changedFiles = getChangedFiles(job.safeCommand.workingDir)
  const fileGuard = fileChangeGuard(changedFiles)
  guardResult.fileChangeAllowed = fileGuard.allowed
  guardResult.fileViolations = fileGuard.violations
  const logPaths = saveJobLogs(job.id, stdout, stderr)

  // アトミックジョブの RollbackInfo を自動生成
  let rollbackInfo: RollbackInfo | undefined
  if (isAtomic && beforeCommitHash && exitCode === 0) {
    rollbackInfo = {
      previousCommitHash: beforeCommitHash,
      changedFiles,
      rollbackArgv: ['git', 'revert', '--no-edit', afterCommitHash ?? 'HEAD'],
    }
  }

  return {
    status: exitCode === 0 && fileGuard.allowed ? 'success' : 'failed',
    exitCode,
    stdout: logPaths.stdoutPreview,
    stderr: logPaths.stderrPreview,
    stdoutPath: logPaths.stdoutPath,
    stderrPath: logPaths.stderrPath,
    changedFiles,
    guardResult,
    startedAt,
    completedAt: new Date().toISOString(),
    rollbackInfo,
  }
}

function getCommitHash(workingDir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,
    }).trim()
  } catch {
    return undefined
  }
}

function getChangedFiles(workingDir: string): string[] {
  try {
    const result = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,
    })
    return result.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function getPreGateDiffText(workingDir: string): string {
  try {
    return execFileSync('git', ['diff', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,
    })
  } catch {
    return ''
  }
}

function getTargetBranch(workingDir: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,
    }).trim()
  } catch {
    return 'unknown'
  }
}

function buildLocalGateResult(changedFiles: string[]): GateResult {
  const riskReview = runRiskReview(changedFiles)
  return {
    finalRiskLevel: riskReview.riskLevel,
    gateDecision: toGateDecision(riskReview.riskLevel),
    auditRiskLevel: riskReview.riskLevel,
    alignmentRiskLevel: 'LOW',
  }
}

function toExecFileFailure(err: unknown): ExecFileFailure {
  if (typeof err === 'object' && err !== null) {
    return err as ExecFileFailure
  }
  return {}
}

function outputToString(output: string | Buffer | undefined): string {
  if (typeof output === 'string') return output
  if (Buffer.isBuffer(output)) return output.toString('utf-8')
  return ''
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// 後方互換のため permissionGuard を再エクスポート
export { permissionGuard }
