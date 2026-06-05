/**
 * Job Runner — Job 実行エンジン
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 1Job = 1SafeCommand を安全に実行して結果を返す。
 * AI CLI の呼び出しは task-022 以降で実装する。
 */

import { execFileSync } from 'node:child_process'
import type { Job, JobGuardResult } from '@ai-team/shared'
import { resolveCommand } from './commandResolver.js'
import { fileChangeGuard } from './guards/fileChangeGuard.js'
import { permissionGuard } from './guards/permissionGuard.js'

const JOB_TIMEOUT_MS = 120_000
const MAX_OUTPUT_LENGTH = 10_000

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
  changedFiles?: string[]
  guardResult: JobGuardResult
  startedAt: string
  completedAt: string
}

/**
 * Job を実行して結果を返す
 * - Permission Guard → commandResolver → execFileSync → File Change Guard
 */
export async function runJob(job: Job): Promise<JobRunResult> {
  const startedAt = new Date().toISOString()

  const guardCheck = permissionGuard(job.safeCommand, job.agentRole)
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
    }
  }

  const resolved = resolveCommand(job.safeCommand)

  let exitCode = 0
  let stdout = ''
  let stderr = ''

  if (!job.dryRun) {
    try {
      stdout = execFileSync(resolved.argv[0], resolved.argv.slice(1), {
        cwd: job.safeCommand.workingDir,
        shell: false,
        timeout: JOB_TIMEOUT_MS,
        encoding: 'utf-8',
      })
    } catch (err: unknown) {
      const failure = toExecFileFailure(err)
      exitCode = typeof failure.status === 'number' ? failure.status : 1
      stdout = outputToString(failure.stdout)
      stderr = outputToString(failure.stderr) || formatUnknownError(err)
    }
  }

  const changedFiles = getChangedFiles(job.safeCommand.workingDir)
  const fileGuard = fileChangeGuard(changedFiles)
  guardResult.fileChangeAllowed = fileGuard.allowed
  guardResult.fileViolations = fileGuard.violations

  return {
    status: exitCode === 0 && fileGuard.allowed ? 'success' : 'failed',
    exitCode,
    stdout: stdout.slice(0, MAX_OUTPUT_LENGTH),
    stderr: stderr.slice(0, MAX_OUTPUT_LENGTH),
    changedFiles,
    guardResult,
    startedAt,
    completedAt: new Date().toISOString(),
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
