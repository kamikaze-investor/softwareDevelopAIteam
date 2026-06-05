import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const PREVIEW_LENGTH = 1000
const MAX_LOG_SIZE = 1_000_000

export interface JobLogPaths {
  stdoutPath: string
  stderrPath: string
  stdoutPreview: string
  stderrPreview: string
}

export function saveJobLogs(jobId: string, stdout: string, stderr: string): JobLogPaths {
  const jobLogDir = resolveJobLogDir(jobId)
  mkdirSync(jobLogDir, { recursive: true })

  const stdoutPath = path.join(jobLogDir, 'stdout.txt')
  const stderrPath = path.join(jobLogDir, 'stderr.txt')

  writeFileSync(stdoutPath, truncateLog(stdout), 'utf-8')
  writeFileSync(stderrPath, truncateLog(stderr), 'utf-8')

  return {
    stdoutPath,
    stderrPath,
    stdoutPreview: stdout.slice(0, PREVIEW_LENGTH),
    stderrPreview: stderr.slice(0, PREVIEW_LENGTH),
  }
}

function resolveJobLogDir(jobId: string): string {
  const logDir = process.env.JOB_LOG_DIR ?? path.resolve(process.cwd(), 'data', 'logs')
  const rootDir = path.resolve(logDir)
  const jobLogDir = path.resolve(rootDir, jobId)

  if (!isPathInside(jobLogDir, rootDir)) {
    throw new Error(`Invalid job log path for job ${jobId}`)
  }

  return jobLogDir
}

function isPathInside(targetPath: string, rootDir: string): boolean {
  const relative = path.relative(rootDir, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function truncateLog(output: string): string {
  if (output.length <= MAX_LOG_SIZE) {
    return output
  }

  return `${output.slice(0, MAX_LOG_SIZE)}\n[truncated]`
}
