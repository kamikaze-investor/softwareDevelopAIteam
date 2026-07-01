/**
 * Job Runner — Job 実行エンジン
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 1Job = 1SafeCommand を安全に実行して結果を返す。
 * aiCliProvider / aiCliPrompt / aiCliMode が揃っている場合は
 * SafeCommand 実行前に AI CLI を先行実行する（task-022）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Job, JobGuardResult, PermissionBlockEvent, RollbackInfo, ApprovalLevelResult } from '@ai-team/shared'
import { runRiskReview } from '@ai-team/shared'
import { createAiCliAdapter } from './aiCli/factory.js'
import { evaluateJobApprovalLevel } from './approvalLevel/jobApprovalLevelIntegration.js'
import { resolveCommand } from './commandResolver.js'
import { fileChangeGuard } from './guards/fileChangeGuard.js'
import { saveJobLogs } from './jobLogger.js'
import { permissionGuard, permissionGuardWithGrants } from './guards/permissionGuard.js'
import { callGateCheck, callConsume } from './guards/gateClient.js'
import { resolvePolicy, SAFE_WORK_ALLOWED_COMMAND_KINDS } from './guards/gatePolicy.js'
import type { EffectivePolicy } from './guards/gatePolicy.js'
import { toGateDecision } from './guards/safetyAuditor.js'
import type { GateResult } from './guards/gateProcessor.js'
import { sendAlert } from './notifier/notifier.js'

const JOB_TIMEOUT_MS = 120_000

/** 重複 CEO 通知防止: 同一 approvalRequestId には一度だけ通知する */
const notifiedApprovalRequests = new Set<string>()
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
  /**
   * Approval Level v2 判定結果（Step6-A2）。
   * 既存Approval Gate通過後・AI CLI実行前に計算される。
   * 観察モード: まだこの結果でJobをblockingしない。
   */
  approvalLevelResult?: ApprovalLevelResult
}

/**
 * Job を実行して結果を返す
 * - Permission Guard (with grants) → Gate Check → [AI CLI] → commandResolver → execFileSync → File Change Guard
 * - aiCliProvider / aiCliPrompt / aiCliMode が揃っている場合のみ AI CLI を先行実行（task-022）
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

    const approvalRequestId =
      checkResponse?.approvalRequest?.id ??
      checkResponse?.nextAction?.requestId ??
      checkResponse?.nextAction?.consumedRequestId
    const expiresAt = checkResponse?.approvalRequest?.expiresAt

    // dedup: 同一 approvalRequestId への重複通知を抑制
    const dedupKey = approvalRequestId
    if (!dedupKey || !notifiedApprovalRequests.has(dedupKey)) {
      if (dedupKey) notifiedApprovalRequests.add(dedupKey)

      if (gateResult.policy === 'block_until_approved') {
        notifyGateEvent({
          severity: 'critical',
          title: `🚨 承認待ち — ${job.safeCommand.kind} が停止`,
          body: [
            '[ACTION REQUIRED] 人間による承認が必要です。',
            '',
            `コマンド: ${job.safeCommand.kind}`,
            `タスク: ${job.taskId}`,
            `Job: ${job.id}`,
            `理由: ${gateResult.reason}`,
            `承認リクエスト: ${approvalRequestId ?? '不明'}`,
            `承認期限: ${expiresAt ?? '不明'}`,
            `変更ファイル: ${formatChangedFiles(preChangedFiles)}`,
            `コミット: ${targetCommit}`,
            `DiffHash: ${targetDiffHash}`,
            `検出時刻: ${new Date().toISOString()}`,
            '',
            '次のアクション:',
            '承認が必要な場合は approval request を確認してください。',
          ].join('\n'),
          sourceType: 'gate_blocked',
          sourceId: approvalRequestId ?? job.id,
        })
      } else {
        notifyGateEvent({
          severity: 'warning',
          title: `⚠️ 承認無効 — 再確認が必要 (${job.safeCommand.kind})`,
          body: [
            '承認が無効化されたか、再確認が必要です。',
            '',
            `コマンド: ${job.safeCommand.kind}`,
            `タスク: ${job.taskId}`,
            `Job: ${job.id}`,
            `理由: ${gateResult.reason}`,
            `対象リクエスト: ${approvalRequestId ?? '不明'}`,
            `コミット: ${targetCommit}`,
            `DiffHash: ${targetDiffHash}`,
            `検出時刻: ${new Date().toISOString()}`,
            '',
            '次のアクション:',
            'もう一度 Gate check を行い、新しい承認フローを開始してください。',
          ].join('\n'),
          sourceType: 'gate_stale',
          sourceId: approvalRequestId ?? job.id,
        })
      }
    }

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
    if (!(SAFE_WORK_ALLOWED_COMMAND_KINDS as readonly string[]).includes(kind)) {
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
      notifyGateEvent({
        severity: 'critical',
        title: `🚨 承認 consume ID 欠落 — ${job.safeCommand.kind}`,
        body: [
          'Gate API が call_consume を要求しましたが、consumedRequestId がありません。',
          '',
          `コマンド: ${job.safeCommand.kind}`,
          `タスク: ${job.taskId}`,
          `Job: ${job.id}`,
          '理由: API response inconsistency',
          `コミット: ${targetCommit}`,
          `DiffHash: ${targetDiffHash}`,
          `検出時刻: ${new Date().toISOString()}`,
        ].join('\n'),
        sourceType: 'gate_consume_missing_id',
        sourceId: job.id,
      })
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
      notifyGateEvent({
        severity: 'critical',
        title: `🚨 承認 consume 失敗 — ${job.safeCommand.kind}`,
        body: [
          '承認の使用に失敗しました。システム調査が必要です。',
          '',
          `コマンド: ${job.safeCommand.kind}`,
          `タスク: ${job.taskId}`,
          `Job: ${job.id}`,
          `エラー: ${message}`,
          `リクエストID: ${consumeRequestId ?? '不明'}`,
          `コミット: ${targetCommit}`,
          `DiffHash: ${targetDiffHash}`,
          `検出時刻: ${new Date().toISOString()}`,
        ].join('\n'),
        sourceType: 'gate_consume_failed',
        sourceId: consumeRequestId ?? job.id,
      })
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

  // ── Approval Level v2 判定（Step6-A2） ──────────────────────────────────────
  // 既存Approval Gate通過後・AI CLI実行前に判定する。
  // preChangedFiles / preDiffText は Approval Gate（Step3A）で取得済みのものをそのまま再利用する。
  // 観察モード: ここではまだ判定結果でJobをblockingしない（ceo_requiredでも停止しない）。
  const approvalLevelResult = evaluateJobApprovalLevel({
    jobId: job.id,
    taskId: job.taskId,
    changedFiles: preChangedFiles,
    diffText: preDiffText,
  })
  // ── Approval Level v2 判定終端 ───────────────────────────────────────────

  // ── AI CLI 実行ブロック（task-022） ─────────────────────────────────────────
  // aiCliProvider / aiCliPrompt / aiCliMode が3つ揃った場合のみ先行実行する。
  // 成功時は後続の SafeCommand（git_commit 等）を引き続き実行する。
  // 失敗（throw / blocked / exitCode !== 0）時は status: failed で早期リターン。
  if (job.aiCliProvider && job.aiCliPrompt && job.aiCliMode) {
    const adapter = createAiCliAdapter({ provider: job.aiCliProvider })
    let cliResult
    try {
      cliResult = await adapter.run({
        taskId: job.taskId,
        provider: job.aiCliProvider,
        workingDir: job.safeCommand.workingDir,
        prompt: job.aiCliPrompt,
        contextFiles: [],  // task-023 で Context Manager 連携後に拡張
        mode: job.aiCliMode,
        dryRun: job.dryRun,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[jobRunner] AI CLI 実行エラー (${job.aiCliProvider}): ${message}`)
      return {
        status: 'failed',
        exitCode: 1,
        stdout: '',
        stderr: message,
        changedFiles: [],
        guardResult,
        startedAt,
        completedAt: new Date().toISOString(),
        approvalLevelResult,
      }
    }

    const cliFailed = cliResult.blocked === true || (cliResult.exitCode !== 0 && !job.dryRun)
    if (cliFailed) {
      console.error(`[jobRunner] AI CLI 失敗 (${job.aiCliProvider}): exitCode=${cliResult.exitCode} blocked=${cliResult.blocked}`)
      return {
        status: 'failed',
        exitCode: cliResult.exitCode,
        stdout: cliResult.stdout,
        stderr: cliResult.stderr,
        stdoutPath: cliResult.stdoutPath,
        stderrPath: cliResult.stderrPath,
        changedFiles: cliResult.changedFiles,
        guardResult,
        startedAt,
        completedAt: new Date().toISOString(),
        approvalLevelResult,
      }
    }

    console.log(`[jobRunner] AI CLI 成功 (${job.aiCliProvider}): changedFiles=${cliResult.changedFiles.length}件 → SafeCommand に続行`)
  }
  // ── AI CLI 実行ブロック終端 ───────────────────────────────────────────────

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
    approvalLevelResult,
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

// ── Gate 通知ヘルパー ──

/**
 * sendAlert を void で呼び出す best-effort ラッパー。
 * 同期 throw を握りつぶし、Gate 判定に影響させない。
 * 非同期失敗は sendAlert 側が console.error に記録する。
 */
function notifyGateEvent(payload: Parameters<typeof sendAlert>[0]): void {
  try {
    void sendAlert(payload)
  } catch (err) {
    console.error(`[gate] failed to dispatch notification: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 変更ファイル一覧を最大3件に丸めて文字列化する */
function formatChangedFiles(files: string[]): string {
  if (files.length === 0) return 'なし'
  const head = files.slice(0, 3).join(', ')
  return files.length > 3 ? `${head} …他${files.length - 3}件` : head
}

// 後方互換のため permissionGuard を再エクスポート
export { permissionGuard }
