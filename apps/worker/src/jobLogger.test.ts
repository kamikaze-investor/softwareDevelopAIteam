import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveJobLogs } from './jobLogger.js'

const TEST_LOG_DIR = path.resolve(process.cwd(), 'data', 'test-logs')
const previousJobLogDir = process.env.JOB_LOG_DIR

beforeEach(() => {
  process.env.JOB_LOG_DIR = TEST_LOG_DIR
})

afterEach(() => {
  rmSync(TEST_LOG_DIR, { recursive: true, force: true })

  if (previousJobLogDir === undefined) {
    delete process.env.JOB_LOG_DIR
  } else {
    process.env.JOB_LOG_DIR = previousJobLogDir
  }
})

describe('saveJobLogs', () => {
  it('writes stdout and stderr to files', () => {
    const result = saveJobLogs('test-job-1', 'hello stdout', 'hello stderr')

    expect(existsSync(result.stdoutPath)).toBe(true)
    expect(existsSync(result.stderrPath)).toBe(true)
    expect(readFileSync(result.stdoutPath, 'utf-8')).toBe('hello stdout')
    expect(readFileSync(result.stderrPath, 'utf-8')).toBe('hello stderr')
  })

  it('returns the first 1000 characters as previews', () => {
    const longOutput = 'x'.repeat(2000)
    const result = saveJobLogs('test-job-2', longOutput, '')

    expect(result.stdoutPreview).toHaveLength(1000)
    expect(result.stdoutPreview).toBe('x'.repeat(1000))
    expect(result.stderrPreview).toBe('')
  })

  it('truncates log files larger than the max log size', () => {
    const hugeOutput = 'y'.repeat(1_100_000)
    const result = saveJobLogs('test-job-3', hugeOutput, '')

    expect(readFileSync(result.stdoutPath, 'utf-8')).toHaveLength(1_000_012)
    expect(readFileSync(result.stdoutPath, 'utf-8').endsWith('[truncated]')).toBe(true)
  })
})
