/**
 * Execution Log Store テスト
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  appendExecutionLog,
  readExecutionLogs,
  findExecutionLog,
  findHighRiskLogs,
} from './executionLogStore.js'
import type { ExecutionLog } from '@ai-team/shared'

const TEST_LOG_DIR = path.resolve(process.cwd(), 'data', 'test-logs-exec')

function makeLog(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: `log-${Date.now()}-${Math.random()}`,
    jobId: 'job-001',
    taskId: 'task-001',
    executor: 'codex',
    command: 'pnpm test',
    workingDir: '/workspace/target',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    stdout: '',
    stderr: '',
    changedFiles: [],
    gitDiffSummary: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  mkdirSync(TEST_LOG_DIR, { recursive: true })
  process.env.JOB_LOG_DIR = TEST_LOG_DIR
})

afterEach(() => {
  if (existsSync(TEST_LOG_DIR)) {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true })
  }
  delete process.env.JOB_LOG_DIR
})

describe('appendExecutionLog / readExecutionLogs', () => {
  it('appends and reads back a log entry', () => {
    const entry = makeLog({ jobId: 'job-abc' })
    appendExecutionLog(entry)

    const logs = readExecutionLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0].jobId).toBe('job-abc')
  })

  it('appends multiple entries and reads all', () => {
    appendExecutionLog(makeLog({ jobId: 'job-1' }))
    appendExecutionLog(makeLog({ jobId: 'job-2' }))
    appendExecutionLog(makeLog({ jobId: 'job-3' }))

    const logs = readExecutionLogs()
    expect(logs).toHaveLength(3)
    expect(logs.map((l) => l.jobId)).toEqual(['job-1', 'job-2', 'job-3'])
  })

  it('returns empty array when no log file exists', () => {
    const logs = readExecutionLogs()
    expect(logs).toHaveLength(0)
  })

  it('preserves auditReport in the log', () => {
    const entry = makeLog({
      auditReport: {
        ref: 'abc123',
        changedFiles: ['src/foo.ts'],
        diffSummary: [{ file: 'src/foo.ts', added: 3, removed: 1 }],
        dangerousHits: [],
        riskLevel: 'HIGH',
        gateDecision: 'DEEP_REVIEW',
        blockedReason: 'guard file change',
        auditedAt: new Date().toISOString(),
      },
    })
    appendExecutionLog(entry)

    const logs = readExecutionLogs()
    expect(logs[0].auditReport?.riskLevel).toBe('HIGH')
    expect(logs[0].auditReport?.gateDecision).toBe('DEEP_REVIEW')
  })
})

describe('findExecutionLog', () => {
  it('finds log by jobId', () => {
    appendExecutionLog(makeLog({ jobId: 'job-x' }))
    appendExecutionLog(makeLog({ jobId: 'job-y' }))

    const found = findExecutionLog('job-x')
    expect(found?.jobId).toBe('job-x')
  })

  it('returns undefined for unknown jobId', () => {
    appendExecutionLog(makeLog({ jobId: 'job-exists' }))
    expect(findExecutionLog('job-unknown')).toBeUndefined()
  })
})

describe('findHighRiskLogs', () => {
  it('returns only HIGH and CRITICAL logs', () => {
    appendExecutionLog(makeLog({ jobId: 'low', auditReport: { ref: '', changedFiles: [], diffSummary: [], dangerousHits: [], riskLevel: 'LOW', gateDecision: 'ALLOW', auditedAt: '' } }))
    appendExecutionLog(makeLog({ jobId: 'high', auditReport: { ref: '', changedFiles: [], diffSummary: [], dangerousHits: [], riskLevel: 'HIGH', gateDecision: 'DEEP_REVIEW', auditedAt: '' } }))
    appendExecutionLog(makeLog({ jobId: 'critical', auditReport: { ref: '', changedFiles: [], diffSummary: [], dangerousHits: [], riskLevel: 'CRITICAL', gateDecision: 'BLOCK_CEO_REQUIRED', auditedAt: '' } }))
    appendExecutionLog(makeLog({ jobId: 'no-report' }))

    const highRisk = findHighRiskLogs()
    expect(highRisk).toHaveLength(2)
    expect(highRisk.map((l) => l.jobId)).toContain('high')
    expect(highRisk.map((l) => l.jobId)).toContain('critical')
  })
})
