import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHEAP_AI_CONFIG,
  CHEAP_AI_PROPOSER_ID,
  CHEAP_AI_RETRY_BACKOFF_MS,
  PL_ADOPTION_PROPOSAL_AGENT,
  requestText,
} from '../aiExplain/cheapAiClient'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { findProposalDiagnostics } from './adoptionStep'
import { resetPlLoopInFlightForTest, runPlTick, type PlLoopDeps } from './executionLoop'

/**
 * PL の provider 推論が1回 timeout しても、bounded recovery（新しい OpenCode で1回だけ再試行）で
 * 成功すれば **`provider_failure` / `diagnosis_failed` を残さない**ことを、実際の既定経路
 * （`answerOperatorRequest` / `diagnose` を差し替えない）で固定する。
 * 再試行は provider 推論の中だけで、action 実行の前に閉じている。
 */

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
const spawnMock = vi.mocked(spawn)

const NOW = '2026-09-29T10:00:00.000Z'
let nextPid = 50_000

interface ControlledChild { pid: number; close: (code: number | null, signal: NodeJS.Signals | null, stdout?: string) => void }

function arrangeChild(): ControlledChild {
  const pid = nextPid++
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    pid, stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams
  spawnMock.mockImplementationOnce(() => child)
  return {
    pid,
    close: (code, signal, text) => queueMicrotask(() => {
      if (text !== undefined) stdout.write(`${JSON.stringify({ type: 'text', part: { text } })}\n`)
      child.emit('close', code, signal)
    }),
  }
}

/** 1回目: AIteamOS の timeout で止まる子（SIGTERM で終了）/ 2回目: 指定の回答を返す子。 */
function arrangeTimeoutThenAnswer(answer: string): void {
  const first = arrangeChild()
  const second = arrangeChild()
  vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
    if (Math.abs(target) === first.pid && typeof signal === 'string') first.close(null, signal as NodeJS.Signals)
    return true
  }) as typeof process.kill)
  // 2回目の子は、再試行で spawn された後に回答を返す（driveTimeoutThenRetry が呼ぶ）
  pendingSecond = () => second.close(0, null, answer)
}

let pendingSecond: (() => void) | undefined

async function driveTimeoutThenRetry(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CHEAP_AI_CONFIG.timeoutMs)
  await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRY_BACKOFF_MS)
  expect(spawnMock).toHaveBeenCalledTimes(2)
  pendingSecond?.()
}

describe('PL provider inference: bounded recovery on the default provider path', () => {
  let sandbox: string
  let storage: IStorage
  let projectId: string
  let taskId: string
  const previousKey = process.env.OPENCODE_GO_API_KEY

  beforeEach(async () => {
    process.env.OPENCODE_GO_API_KEY = 'test-key'
    // 隔離 dir の作成（実 I/O）を fake timer の前に済ませる
    const prime = arrangeChild()
    const primed = requestText('prime', 'prime', {}, 10)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    prime.close(0, null, 'ok')
    await primed
    spawnMock.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    resetPlLoopInFlightForTest()
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'provider-recovery-'))
    storage = createSQLiteStorage(path.join(sandbox, 'db.sqlite'))
    projectId = storage.projects.create({ name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' }).id
    taskId = storage.tasks.create({
      projectId, title: 'T', description: 'd', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1,
    } as Parameters<IStorage['tasks']['create']>[0]).id
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    pendingSecond = undefined
    if (previousKey === undefined) delete process.env.OPENCODE_GO_API_KEY
    else process.env.OPENCODE_GO_API_KEY = previousKey
    try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* sqlite handle */ }
  })

  function deps(over: Partial<PlLoopDeps> = {}): PlLoopDeps {
    // answerOperatorRequest / diagnose は差し替えない（既定の requestText 経路を通す）
    return { now: () => NOW, readLedger: () => '', escalate: async () => {}, ...over }
  }

  function operatorAudit(): Array<{ result: string; detail: string }> {
    return storage.auditLog.findAll().filter((row) => row.operation === 'operator_request')
      .map((row) => ({ result: row.result, detail: row.detail ?? '' }))
  }

  it('question: 1回目 timeout → 2回目成功なら回答済みになり、provider_failure を残さない', async () => {
    arrangeTimeoutThenAnswer(JSON.stringify({ disposition: 'answered', response: '現在は正常です' }))
    const request = storage.operatorRequests.create({ requesterClass: 'admin', kind: 'question', message: '現在何が起きている？' })

    const tick = runPlTick(storage, deps())
    await driveTimeoutThenRetry()
    await tick

    expect(storage.operatorRequests.findById(request.id)).toMatchObject({
      status: 'answered', disposition: 'answered', response: '現在は正常です',
    })
    expect(operatorAudit().some((row) => row.result === 'failed')).toBe(false)
    expect(JSON.stringify(operatorAudit())).not.toContain('provider_failure')
  })

  it('自律 PL の diagnosis: 1回目 timeout → 2回目成功なら diagnosis_failed を残さない（試行予算も1回分だけ）', async () => {
    const job = storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', message: 'm' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    storage.jobs.update(job.id, { stderr: 'blocked: approval required' })
    storage.tasks.update(taskId, { status: 'blocked' })
    arrangeTimeoutThenAnswer(JSON.stringify({ actionKind: 'escalate_to_ceo', rationale: 'from evidence', riskLevel: 'LOW' }))

    const tick = runPlTick(storage, deps())
    await driveTimeoutThenRetry()
    const result = await tick

    expect(result.status).not.toBe('diagnosis_failed')
    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[]
      expect(args).not.toContain('--agent')
    }
    const plRows = storage.auditLog.findAll().filter((row) => row.operation === 'pl_loop')
    expect(plRows.some((row) => row.result === 'diagnosis_failed')).toBe(false)
    expect(plRows.length).toBeGreaterThan(0)
  })

  it('default adoption proposal selects the dedicated agent and keeps unparsable diagnostics', async () => {
    storage.tasks.update(taskId, { status: 'done', roadmapActive: false })
    const child = arrangeChild()
    const ledger = [
      '# Roadmap',
      '',
      '<!-- roadmap:id=next-item state=planned -->',
      '1. [ ] **Next item** — candidate',
    ].join('\n')

    const tick = runPlTick(storage, deps({ readLedger: () => ledger }))
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    const args = spawnMock.mock.calls[0]?.[1] as string[]
    const agentFlagIndex = args.indexOf('--agent')
    expect(args.slice(agentFlagIndex, agentFlagIndex + 2)).toEqual([
      '--agent',
      PL_ADOPTION_PROPOSAL_AGENT,
    ])
    child.close(0, null, '<tool_call><function=bash>ls</function></tool_call>')

    await expect(tick).resolves.toMatchObject({ status: 'blocked', attempt: 1 })
    expect(findProposalDiagnostics(storage, projectId)).toEqual([
      expect.objectContaining({
        reason: 'no_json_object_found',
        proposer: CHEAP_AI_PROPOSER_ID,
        raw: '<tool_call><function=bash>ls</function></tool_call>',
      }),
    ])
  })

  it('2回とも timeout なら従来どおり fail-closed（question は provider_failure、3回目は起動しない）', async () => {
    const first = arrangeChild()
    const second = arrangeChild()
    vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
      for (const child of [first, second]) {
        if (Math.abs(target) === child.pid && typeof signal === 'string') child.close(null, signal as NodeJS.Signals)
      }
      return true
    }) as typeof process.kill)
    const request = storage.operatorRequests.create({ requesterClass: 'admin', kind: 'question', message: 'q' })

    const tick = runPlTick(storage, deps())
    await vi.advanceTimersByTimeAsync(CHEAP_AI_CONFIG.timeoutMs + CHEAP_AI_RETRY_BACKOFF_MS + CHEAP_AI_CONFIG.timeoutMs)
    await tick

    expect(storage.operatorRequests.findById(request.id)).toMatchObject({ status: 'failed' })
    expect(storage.operatorRequests.findById(request.id)?.error).toBe(
      'provider_failure: the model provider for the PL could not be used',
    )
    expect(operatorAudit().find((row) => row.result === 'failed')?.detail).toContain('(attempt 2/2; attempt 1: timeout)')
    await vi.advanceTimersByTimeAsync(CHEAP_AI_CONFIG.timeoutMs * 3)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})
