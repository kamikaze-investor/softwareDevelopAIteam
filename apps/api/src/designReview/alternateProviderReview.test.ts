import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRoleModelRegistry } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import { DesignReviewRunContentionError, type IStorage } from '../storage/interface'
import { checkImplementJobDesignReviewEvidence } from '../designReviewEvidencePolicy'
import {
  DESIGN_REVIEW_MAX_ATTEMPTS,
  createAndExecuteDesignReview,
  executeDesignReviewRun,
  type RunnerExecution,
} from './designReviewCoordinator'
import { createAlternateProviderDesignReview } from './alternateProviderReview'
import { passDesignReviewRetryCooldown } from './retryCooldownTestClock'
import { classifyReviewLoad } from '@ai-team/worker/src/approvalLevel/reviewLoadClassifier.js'
import { selectFocuses } from '@ai-team/worker/src/approvalLevel/focusSelector.js'

/**
 * 別 provider での正式再審査（`review-provider-exhausted-alternate-rereview`）。
 *
 * 固定する性質: 枯渇 run → 別 provider の新しい run / 既存 BLOCK は新しい run の判定まで残る /
 * 枯渇していない run では動かない / 否定判定を provider 替えで引き直さない / 回数は有界。
 */

afterEach(() => { vi.useRealTimers() })

const CHANGED_FILES = ['docs/readme.md']
const DESIGN_TEXT = 'alternate provider design text'

const registry = parseRoleModelRegistry({
  entries: [
    { role: 'implementer', provider: 'claude_code', model: 'claude-opus-5-5', enabled: true },
    { role: 'meta_reviewer', provider: 'gemini', model: 'gemini-model-a', enabled: true },
    { role: 'meta_reviewer', provider: 'copilot', model: 'mai-code-1.1-flash', enabled: true },
    { role: 'meta_reviewer', provider: 'codex', model: 'codex-model-a', enabled: true },
  ],
})

function seedTask(storage: IStorage): string {
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'draft' })
  return storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  }).id
}

function runnerDeps(execute: (input: string) => Promise<RunnerExecution>) {
  return { runnerCommand: 'node', runnerArgs: [], homeDirectory: '/tmp/home', workingDir: '/tmp/work', execute }
}

const providerOutage = () => Promise.resolve<RunnerExecution>({
  ok: false, stdout: '', error: 'runner exited with code 1', stderr: '[503 Service Unavailable]', timedOut: false,
})

function alignedOutput(extra: Record<string, unknown> = {}): string {
  const focuses = selectFocuses(classifyReviewLoad({ changedFiles: CHANGED_FILES }).reviewLoad, CHANGED_FILES)
  return JSON.stringify({
    focusedReviewResults: focuses.map((focus) => ({ focus, decision: 'ALIGNED' })),
    integrationReviewResult: { decision: 'ALIGNED' },
    finalDecision: 'ALIGNED',
    ...extra,
  })
}

function reviewInput(taskId: string) {
  return { taskId, taskTitle: 'design', designText: DESIGN_TEXT, changedFiles: CHANGED_FILES }
}

/** latest run を provider 障害で attempt 上限まで失敗させる。 */
async function exhaustLatestRun(storage: IStorage, taskId: string): Promise<string> {
  const runId = storage.designReviewRuns.findLatestByTaskId(taskId)!.id
  for (let i = 0; i < DESIGN_REVIEW_MAX_ATTEMPTS + 2; i += 1) {
    const current = storage.designReviewRuns.findById(runId)!
    if (current.status !== 'queued') break
    passDesignReviewRetryCooldown()
    await executeDesignReviewRun(storage, current, runnerDeps(providerOutage))
  }
  const exhausted = storage.designReviewRuns.findById(runId)!
  expect(exhausted).toMatchObject({ status: 'failed', attemptCount: DESIGN_REVIEW_MAX_ATTEMPTS })
  return runId
}

async function seedExhaustedRun(storage: IStorage): Promise<{ taskId: string; exhaustedRunId: string }> {
  const taskId = seedTask(storage)
  await createAndExecuteDesignReview(storage, reviewInput(taskId), runnerDeps(providerOutage))
  return { taskId, exhaustedRunId: await exhaustLatestRun(storage, taskId) }
}

function implementGate(storage: IStorage, taskId: string) {
  return checkImplementJobDesignReviewEvidence(
    { taskId, aiCliMode: 'implement', aiCliPrompt: DESIGN_TEXT }, storage.designReviewEvidence,
  )
}

describe('createAlternateProviderDesignReview', () => {
  it('枯渇 run から、Registry で選んだ別 provider に束縛した新しい run を作り、既存の判定経路で ALIGNED を登録する', async () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId, exhaustedRunId } = await seedExhaustedRun(storage)
    const execute = vi.fn(async (_input: string) => ({ ok: true, stdout: alignedOutput({ providerUsed: 'codex' }), timedOut: false }))

    passDesignReviewRetryCooldown()
    const result = await createAlternateProviderDesignReview(
      storage, { exhaustedRunId, registry }, runnerDeps(execute),
    )

    expect(result).toMatchObject({ ok: true, runProvider: 'codex', runModel: 'codex-model-a' })
    expect(result.ok && result.review.status).toBe('evidence_registered')

    const runs = storage.designReviewRuns.findByTaskId(taskId)
    expect(runs).toHaveLength(2)
    const [newRun] = runs
    expect(newRun.id).not.toBe(exhaustedRunId)
    expect(newRun).toMatchObject({ reviewProvider: 'codex', reviewModel: 'codex-model-a', status: 'succeeded', attemptCount: 1 })
    // runner には指定が渡る。
    const runnerInput = JSON.parse(execute.mock.calls[0]?.[0] ?? '') as Record<string, unknown>
    expect(runnerInput).toMatchObject({ reviewProvider: 'codex', reviewModel: 'codex-model-a' })
    // 枯渇 run は再利用も書き換えもされない。
    expect(storage.designReviewRuns.findById(exhaustedRunId))
      .toMatchObject({ status: 'failed', attemptCount: DESIGN_REVIEW_MAX_ATTEMPTS, resultJson: undefined })
  })

  it('既存の BLOCK（evidence 無し）は、新しい run の判定が再計算されるまで残る', async () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId, exhaustedRunId } = await seedExhaustedRun(storage)
    expect(implementGate(storage, taskId).ok).toBe(false)

    let gateDuringReview: boolean | undefined
    const execute = vi.fn(async () => {
      // 新しい run の実行中（判定前）。
      gateDuringReview = implementGate(storage, taskId).ok
      return { ok: true, stdout: alignedOutput({ providerUsed: 'codex' }), timedOut: false }
    })

    passDesignReviewRetryCooldown()
    await createAlternateProviderDesignReview(storage, { exhaustedRunId, registry }, runnerDeps(execute))

    expect(gateDuringReview).toBe(false)
    expect(implementGate(storage, taskId).ok).toBe(true)
  })

  it('runner が指定 provider で審査したと申告しなければ判定として採用しない（BLOCK は残る）', async () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId, exhaustedRunId } = await seedExhaustedRun(storage)
    const execute = vi.fn(async () => ({ ok: true, stdout: alignedOutput(), timedOut: false }))

    passDesignReviewRetryCooldown()
    const result = await createAlternateProviderDesignReview(storage, { exhaustedRunId, registry }, runnerDeps(execute))

    expect(result.ok && result.review.status).toBe('requeued')
    expect(implementGate(storage, taskId).ok).toBe(false)
  })

  it('枯渇していない run では新しい run を作らず、runner も呼ばない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    await createAndExecuteDesignReview(storage, reviewInput(taskId), runnerDeps(providerOutage))
    const queued = storage.designReviewRuns.findLatestByTaskId(taskId)!
    expect(queued).toMatchObject({ status: 'queued', attemptCount: 1 })
    const execute = vi.fn(providerOutage)

    const result = await createAlternateProviderDesignReview(
      storage, { exhaustedRunId: queued.id, registry }, runnerDeps(execute),
    )

    expect(result.ok).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(storage.designReviewRuns.findByTaskId(taskId)).toHaveLength(1)
  })

  it('同じ設計に否定判定がある Task では、provider を替えて引き直さない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const conflict = JSON.stringify({
      focusedReviewResults: [],
      integrationReviewResult: { decision: 'CONFLICT', summary: 'conflicts with the goal' },
      finalDecision: 'CONFLICT',
    })
    await createAndExecuteDesignReview(storage, reviewInput(taskId), runnerDeps(async () => ({
      ok: true, stdout: conflict, timedOut: false,
    })))
    await createAndExecuteDesignReview(storage, reviewInput(taskId), runnerDeps(providerOutage))
    const exhaustedRunId = await exhaustLatestRun(storage, taskId)
    const execute = vi.fn(providerOutage)

    const result = await createAlternateProviderDesignReview(storage, { exhaustedRunId, registry }, runnerDeps(execute))

    expect(result.ok).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(storage.designReviewRuns.findByTaskId(taskId)).toHaveLength(2)
  })

  it('別 provider の run も枯渇したら、同じ provider を巡回せず作らない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId, exhaustedRunId } = await seedExhaustedRun(storage)

    passDesignReviewRetryCooldown()
    await createAlternateProviderDesignReview(storage, { exhaustedRunId, registry }, runnerDeps(providerOutage))
    const alternateRunId = await exhaustLatestRun(storage, taskId)
    expect(storage.designReviewRuns.findById(alternateRunId)?.reviewProvider).toBe('codex')
    const execute = vi.fn(providerOutage)

    const result = await createAlternateProviderDesignReview(
      storage, { exhaustedRunId: alternateRunId, registry }, runnerDeps(execute),
    )

    expect(result.ok).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(storage.designReviewRuns.findByTaskId(taskId)).toHaveLength(2)
  })

  it('provider 指定が違う active run は再利用しない（既定連鎖の run を別 provider の run として返さない）', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const base = { ...reviewInput(taskId), designTextHash: 'hash-alt' }
    storage.designReviewRuns.create(base)

    expect(() => storage.designReviewRuns.create({ ...base, reviewProvider: 'codex', reviewModel: 'codex-model-a' }))
      .toThrow(DesignReviewRunContentionError)
    expect(storage.designReviewRuns.findByTaskId(taskId)).toHaveLength(1)
  })

  it('Registry が無ければ作らない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId, exhaustedRunId } = await seedExhaustedRun(storage)

    const result = await createAlternateProviderDesignReview(
      storage, { exhaustedRunId, registry: undefined }, runnerDeps(providerOutage),
    )

    expect(result.ok).toBe(false)
    expect(storage.designReviewRuns.findByTaskId(taskId)).toHaveLength(1)
  })
})
