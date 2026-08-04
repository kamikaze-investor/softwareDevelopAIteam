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

  it('returns exactly 4000 characters without a truncation notice', () => {
    const output = 'x'.repeat(4000)
    const result = saveJobLogs('test-job-2', output, '')

    expect(result.stdoutPreview).toHaveLength(4000)
    expect(result.stdoutPreview).toBe(output)
    expect(result.stderrPreview).toBe('')
  })

  it('appends the fixed notice only when a preview exceeds 4000 characters', () => {
    const output = 'x'.repeat(4001)
    const result = saveJobLogs('test-job-4', output, output)

    expect(result.stdoutPreview).toBe(`${'x'.repeat(4000)}\n[表示上限を超えたため一部省略されています]`)
    expect(result.stderrPreview).toContain('[表示上限を超えたため一部省略されています]')
    expect(readFileSync(result.stdoutPath, 'utf-8')).toBe(output)
    expect(readFileSync(result.stderrPath, 'utf-8')).toBe(output)
  })

  it('truncates log files larger than the max log size', () => {
    const hugeOutput = 'y'.repeat(1_100_000)
    const result = saveJobLogs('test-job-3', hugeOutput, '')

    expect(readFileSync(result.stdoutPath, 'utf-8')).toHaveLength(1_000_012)
    expect(readFileSync(result.stdoutPath, 'utf-8').endsWith('[truncated]')).toBe(true)
  })
})
