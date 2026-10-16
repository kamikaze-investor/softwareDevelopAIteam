import { describe, expect, it, beforeEach, vi, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import {
  DESIGN_REVIEW_MAX_ATTEMPTS,
  DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES,
  DESIGN_REVIEW_RUNNER_TIMEOUT_MS,
  DESIGN_REVIEW_STDERR_TAIL_CHARS,
  appendRunnerStderr,
  buildRunnerEnv,
  createAndExecuteDesignReview,
  createAndExecuteRoadmapReview,
  executeDesignReviewRun,
  executeRunner,
  recomputeDecision,
} from './designReviewCoordinator'
import type { CoordinatorDeps } from './designReviewCoordinator'
import { recoverAndRekickAtStartup } from './queuedRunDispatch'
import { classifyReviewLoad } from '@ai-team/worker/src/approvalLevel/reviewLoadClassifier.js'
import { selectFocuses, selectRoadmapReviewFocuses } from '@ai-team/worker/src/approvalLevel/focusSelector.js'

/**
 * Design Review executor の検証。
 *
 * 独立Adversarial Reviewで BLOCKER 指摘された4点
 * （secret least privilege / stale fencing / decision authority / bounded recovery）
 * をそのまま検証対象にしている。
 */

function createStorage(): IStorage {
  return createSQLiteStorage(':memory:')
}

function seedTask(storage: IStorage): string {
  const project = storage.projects.create({
    name: 'Test Project', goal: 'g', designPhilosophy: [], status: 'draft',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  })
  return task.id
}

/** low load になる changedFiles（レビュー負荷分類を実物に委ねる）。 */
const LOW_LOAD_FILES = ['docs/readme.md']

function baseInput(taskId: string) {
  return {
    taskId,
    taskTitle: 'design',
    designText: 'design text',
    designTextHash: 'hash-1',
    changedFiles: LOW_LOAD_FILES,
  }
}

function deps(execute: (input: string) => Promise<{ ok: boolean; stdout: string; error?: string; timedOut: boolean; stderr?: string }>) {
  return {
    runnerCommand: 'node',
    runnerArgs: [],
    homeDirectory: '/tmp/home',
    workingDir: '/tmp/work',
    execute,
  }
}

function alignedResult(focuses: string[]) {
  return JSON.stringify({
    reviewLoad: 'low',
    selectedFocuses: focuses,
    focusedReviewResults: focuses.map((focus) => ({ focus, decision: 'ALIGNED' })),
    integrationReviewResult: { decision: 'ALIGNED' },
    finalDecision: 'ALIGNED',
  })
}

describe('1. secret least privilege', () => {
  it('runnerへ渡すenvにAPI_TOKEN・token類・不要provider keyが含まれない', () => {
    process.env.API_TOKEN = 'must-not-leak'
    process.env.ADMIN_TOKEN_SHA256 = 'must-not-leak'
    process.env.WORKER_TOKEN_SHA256 = 'must-not-leak'
    process.env.OPENCODE_GO_API_KEY = 'must-not-leak'
    process.env.GEMINI_API_KEY = 'must-not-leak-either'

    const env = buildRunnerEnv('/tmp/home')

    expect(env).not.toHaveProperty('API_TOKEN')
    expect(env).not.toHaveProperty('ADMIN_TOKEN_SHA256')
    expect(env).not.toHaveProperty('WORKER_TOKEN_SHA256')
    expect(env).not.toHaveProperty('OPENCODE_GO_API_KEY')
    // reviewer credential すらAPIからは渡さない（runnerが.envからallowlistで自力取得する）
    expect(env).not.toHaveProperty('GEMINI_API_KEY')
    expect(Object.values(env)).not.toContain('must-not-leak')
  })

  it('envは明示allowlistのキーだけで構成される', () => {
    const env = buildRunnerEnv('/tmp/home')
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'NODE_ENV', 'PATH', 'USERPROFILE'])
  })

  it('COPILOT_GITHUB_TOKENが設定されていてもCopilot CLIはOAuth credentialで認証するため渡さない（2026-08-28: PAT配線撤去）', () => {
    process.env.COPILOT_GITHUB_TOKEN = 'must-not-leak-copilot-token'
    process.env.GEMINI_API_KEY = 'must-not-leak-either'
    try {
      const env = buildRunnerEnv('/tmp/home')
      expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'NODE_ENV', 'PATH', 'USERPROFILE'])
      expect(env).not.toHaveProperty('COPILOT_GITHUB_TOKEN')
      expect(env).not.toHaveProperty('GEMINI_API_KEY')
      expect(Object.values(env)).not.toContain('must-not-leak-copilot-token')
    } finally {
      delete process.env.COPILOT_GITHUB_TOKEN
    }
  })
})

describe('2. stale completion fencing', () => {
  let storage: IStorage
  let taskId: string

  beforeEach(() => {
    storage = createStorage()
    taskId = seedTask(storage)
  })

  it('requeue後に遅れて完了した旧attemptはcompleteできない', () => {
    const run = storage.designReviewRuns.create(baseInput(taskId))

    const attempt1 = storage.designReviewRuns.claim(run.id, DESIGN_REVIEW_MAX_ATTEMPTS)
    expect(attempt1.claimToken).toBeDefined()

    // attempt1 が hang したとみなして requeue
    expect(storage.designReviewRuns.requeue(run.id, attempt1.claimToken!, 'timeout')).toBe(true)

    const attempt2 = storage.designReviewRuns.claim(run.id, DESIGN_REVIEW_MAX_ATTEMPTS)
    expect(attempt2.claimToken).toBeDefined()
    expect(attempt2.claimToken).not.toBe(attempt1.claimToken)

    // attempt2 が正常完了
    expect(storage.designReviewRuns.complete(run.id, attempt2.claimToken!, 'succeeded', '{}')).toBe(true)

    // 遅れて attempt1 が完了しても弾かれる
    expect(storage.designReviewRuns.complete(run.id, attempt1.claimToken!, 'succeeded', 'stale')).toBe(false)
    expect(storage.designReviewRuns.findById(run.id)!.resultJson).toBe('{}')
  })

  it('stale attemptはevidenceを登録できない', () => {
    const run = storage.designReviewRuns.create(baseInput(taskId))
    const attempt1 = storage.designReviewRuns.claim(run.id, DESIGN_REVIEW_MAX_ATTEMPTS)
    storage.designReviewRuns.requeue(run.id, attempt1.claimToken!, 'timeout')

    const evidence = storage.designReviewRuns.completeWithEvidence(run.id, attempt1.claimToken!, '{}', {
      taskId,
      designTextHash: 'hash-1',
      reviewLoad: 'low',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    } as never)

    expect(evidence).toBeUndefined()
    expect(storage.designReviewEvidence.findByTaskId(taskId)).toHaveLength(0)
  })

  it('同一Taskにactive runは1件しか作られない', () => {
    const first = storage.designReviewRuns.create(baseInput(taskId))
    const second = storage.designReviewRuns.create(baseInput(taskId))
    expect(second.id).toBe(first.id)
  })
})

describe('3. decision authority', () => {
  let storage: IStorage
  let taskId: string

  beforeEach(() => {
    storage = createStorage()
    taskId = seedTask(storage)
  })

  it('runnerがfinalDecision=ALIGNEDと自己申告してもfocus決定がCONFLICTならALIGNEDにならない', async () => {
    // focus集合検証で弾かれるのではなく、判定再計算そのものでCONFLICTになることを検証するため、
    // focus集合はAPIの再計算結果と一致させたうえで decision だけ矛盾させる。
    const run = storage.designReviewRuns.create({
      ...baseInput(taskId),
      changedFiles: ['specs/00_constitution.md'],
    })
    const raw: Record<string, unknown> = {
      focusedReviewResults: [
        { focus: 'strategic_alignment', decision: 'CONFLICT' },
        { focus: 'scope_simplicity', decision: 'ALIGNED' },
      ],
      integrationReviewResult: { decision: 'ALIGNED' },
      independentReviewResult: { verdict: 'approved' },
      finalDecision: 'ALIGNED',
    }

    const result = await executeDesignReviewRun(
      storage, run, deps(async () => ({ ok: true, stdout: JSON.stringify(raw), timedOut: false })),
    )

    expect(result.status).toBe('not_aligned')
    expect(result.decision).toBe('CONFLICT')
    expect(storage.designReviewEvidence.findByTaskId(taskId)).toHaveLength(0)
  })

  it('runnerがok:trueでもstderr診断情報を保持し、decision非ALIGNED時にconsole.warnする', async () => {
    const raw: Record<string, unknown> = {
      focusedReviewResults: [
        { focus: 'strategic_alignment', decision: 'CONFLICT' },
        { focus: 'scope_simplicity', decision: 'ALIGNED' },
      ],
      integrationReviewResult: { decision: 'ALIGNED' },
      independentReviewResult: { verdict: 'approved' },
      finalDecision: 'ALIGNED',
    }
    const stderrDiag = '[geminiRouter] Gemini failed, unknown (feature: strategic-meta-review-scope_simplicity)'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const run = storage.designReviewRuns.create({
        ...baseInput(taskId),
        changedFiles: ['specs/00_constitution.md'],
      })
      const result = await executeDesignReviewRun(
        storage, run, deps(async () => ({
          ok: true,
          stdout: JSON.stringify(raw),
          timedOut: false,
          stderr: stderrDiag,
        })),
      )

      expect(result.status).toBe('not_aligned')
      expect(result.decision).toBe('CONFLICT')
      expect(warnSpy).toHaveBeenCalledOnce()
      expect(warnSpy.mock.calls[0]?.[0]).toContain(stderrDiag)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('runnerがok:trueでstderrが空の場合はconsole.warnしない', async () => {
    const raw: Record<string, unknown> = {
      focusedReviewResults: [
        { focus: 'strategic_alignment', decision: 'CONFLICT' },
        { focus: 'scope_simplicity', decision: 'ALIGNED' },
      ],
      integrationReviewResult: { decision: 'ALIGNED' },
      independentReviewResult: { verdict: 'approved' },
      finalDecision: 'ALIGNED',
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const run = storage.designReviewRuns.create({
        ...baseInput(taskId),
        changedFiles: ['specs/00_constitution.md'],
      })
      const result = await executeDesignReviewRun(
        storage, run, deps(async () => ({
          ok: true,
          stdout: JSON.stringify(raw),
          timedOut: false,
        })),
      )

      expect(result.status).toBe('not_aligned')
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('runnerがok:falseの場合もstderrがerrorに含まれる（既存動作の確認）', async () => {
    const run = storage.designReviewRuns.create(baseInput(taskId))
    const result = await executeDesignReviewRun(
      storage, run, deps(async () => ({
        ok: false,
        stdout: '',
        error: 'runner exited with code 1: some stderr',
        timedOut: false,
        stderr: 'some stderr',
      })),
    )

    expect(result.status).toMatch(/requeued|failed/)
    expect(result.error).toContain('some stderr')
  })

  it('critical loadでindependent reviewが欠落していれば不採用', () => {
    // specs/00_constitution.md は分類器上 critical 固定なので、条件分岐なしで検証できる。
    const criticalFiles = ['specs/00_constitution.md']
    const outcome = recomputeDecision(
      {
        focusedReviewResults: [
          { focus: 'strategic_alignment', decision: 'ALIGNED' },
          { focus: 'scope_simplicity', decision: 'ALIGNED' },
        ],
        integrationReviewResult: { decision: 'ALIGNED' },
        finalDecision: 'ALIGNED',
      },
      'task',
      criticalFiles,
    )

    expect(outcome.reviewLoad).toBe('critical')
    expect(outcome.independentReviewRequired).toBe(true)
    expect(outcome.decision).not.toBe('ALIGNED')
    expect(outcome.rejectedReason).toContain('independent review')
  })

  it('critical loadでindependent reviewがblockingならALIGNEDにならない', () => {
    const outcome = recomputeDecision(
      {
        focusedReviewResults: [
          { focus: 'strategic_alignment', decision: 'ALIGNED' },
          { focus: 'scope_simplicity', decision: 'ALIGNED' },
        ],
        integrationReviewResult: { decision: 'ALIGNED' },
        independentReviewResult: { verdict: 'blocking' },
        finalDecision: 'ALIGNED',
      },
      'task',
      ['specs/00_constitution.md'],
    )

    expect(outcome.decision).not.toBe('ALIGNED')
  })

  // 未知のdecision値は independent review verdict と同じく明示的に reject する。
  // これが無いと、runner の schema drift / typo / provider 差し替えによる語彙違いが
  // 「未レビュー同然の変更の承認」として evidence に載る（2026-09-10 実測）。
  it('未知のfocused decision値はALIGNEDにならず理由付きで不採用', () => {
    const outcome = recomputeDecision(
      {
        focusedReviewResults: [
          { focus: 'strategic_alignment', decision: 'ALIGNED' },
          { focus: 'scope_simplicity', decision: 'NOT_ALIGNED' },
        ],
        integrationReviewResult: { decision: 'ALIGNED' },
        independentReviewResult: { verdict: 'approved' },
        finalDecision: 'ALIGNED',
      },
      'task',
      ['specs/00_constitution.md'],
    )

    expect(outcome.decision).not.toBe('ALIGNED')
    expect(outcome.rejectedReason).toContain('NOT_ALIGNED')
  })

  it('未知のintegration decision値もALIGNEDにならず理由付きで不採用', () => {
    const outcome = recomputeDecision(
      {
        focusedReviewResults: [
          { focus: 'strategic_alignment', decision: 'ALIGNED' },
          { focus: 'scope_simplicity', decision: 'ALIGNED' },
        ],
        integrationReviewResult: { decision: 'LOOKS_FINE' },
        independentReviewResult: { verdict: 'approved' },
        finalDecision: 'ALIGNED',
      },
      'task',
      ['specs/00_constitution.md'],
    )

    expect(outcome.decision).not.toBe('ALIGNED')
    expect(outcome.rejectedReason).toContain('LOOKS_FINE')
  })

  it('runnerが自己申告した finalDecision:ALIGNED は未知値を救済しない', () => {
    // API は runner の自己申告を採用せず自前で再計算する、という既存の decision authority を
    // 未知値ケースでも維持する。
    const outcome = recomputeDecision(
      {
        focusedReviewResults: [
          { focus: 'strategic_alignment', decision: 'NOT_ALIGNED' },
          { focus: 'scope_simplicity', decision: 'NOT_ALIGNED' },
        ],
        integrationReviewResult: { decision: 'ALIGNED' },
        independentReviewResult: { verdict: 'approved' },
        finalDecision: 'ALIGNED',
      },
      'task',
      ['specs/00_constitution.md'],
    )

    expect(outcome.decision).not.toBe('ALIGNED')
  })

  // 独立レビュー指摘（2026-09-11）: enum 検証を `!== undefined` だけで書くと、runner が
  // `"integrationReviewResult": null` を返す task kind で null 参照の TypeError になり、
  // 既存の reject 経路で終端できず claim した run が running のまま残る。
  it('task kind で integrationReviewResult が null でも throw せず、従来どおり扱う', () => {
    const outcome = recomputeDecision(
      {
        focusedReviewResults: [
          { focus: 'strategic_alignment', decision: 'ALIGNED' },
          { focus: 'scope_simplicity', decision: 'ALIGNED' },
        ],
        integrationReviewResult: null,
        independentReviewResult: { verdict: 'approved' },
        finalDecision: 'ALIGNED',
      } as unknown as Parameters<typeof recomputeDecision>[0],
      'task',
      ['specs/00_constitution.md'],
    )

    // null は「integration 無し」= undefined と同じ扱い（本変更前の挙動を維持）。
    expect(outcome.decision).toBe('ALIGNED')
  })

  it('roadmap kind で integrationReviewResult が null なら必須チェックで不採用', () => {
    const outcome = recomputeDecision(
      {
        focusedReviewResults: [
          { focus: 'strategic_alignment', decision: 'ALIGNED' },
          { focus: 'scope_simplicity', decision: 'ALIGNED' },
          { focus: 'architecture_responsibility', decision: 'ALIGNED' },
        ],
        integrationReviewResult: null,
        finalDecision: 'ALIGNED',
      } as unknown as Parameters<typeof recomputeDecision>[0],
      'roadmap',
      [],
    )

    expect(outcome.decision).not.toBe('ALIGNED')
    expect(outcome.rejectedReason).toContain('integration review result')
  })

  it('有効値のみのALIGNED経路は従来どおり通る（回帰防止）', () => {
    const outcome = recomputeDecision(
      {
        focusedReviewResults: [
          { focus: 'strategic_alignment', decision: 'ALIGNED' },
          { focus: 'scope_simplicity', decision: 'ALIGNED' },
        ],
        integrationReviewResult: { decision: 'ALIGNED' },
        independentReviewResult: { verdict: 'approved' },
        finalDecision: 'ALIGNED',
      },
      'task',
      ['specs/00_constitution.md'],
    )

    expect(outcome.decision).toBe('ALIGNED')
    expect(outcome.rejectedReason).toBeUndefined()
  })

  it('壊れた出力ではevidenceを登録せず失敗として確定する', async () => {
    const run = storage.designReviewRuns.create(baseInput(taskId))
    const result = await executeDesignReviewRun(
      storage, run, deps(async () => ({ ok: true, stdout: 'not json', timedOut: false })),
    )

    expect(['requeued', 'failed']).toContain(result.status)
    expect(storage.designReviewEvidence.findByTaskId(taskId)).toHaveLength(0)
  })
})

describe('4. bounded recovery', () => {
  let storage: IStorage
  let taskId: string

  beforeEach(() => {
    storage = createStorage()
    taskId = seedTask(storage)
  })

  it('失敗が続いてもMAX_ATTEMPTSでfailed終端し、無限retryしない', async () => {
    const failing = deps(async () => ({ ok: false, stdout: '', error: 'boom', timedOut: false }))
    const first = await createAndExecuteDesignReview(storage, baseInput(taskId), failing)
    expect(first.status).toBe('requeued')

    const runId = storage.designReviewRuns.findActiveByTaskId(taskId)!.id

    for (let i = 0; i < DESIGN_REVIEW_MAX_ATTEMPTS + 2; i += 1) {
      const active = storage.designReviewRuns.findById(runId)!
      if (active.status !== 'queued') break
      await executeDesignReviewRun(storage, active, failing)
    }

    const final = storage.designReviewRuns.findById(runId)!
    expect(final.status).toBe('failed')
    expect(final.attemptCount).toBeLessThanOrEqual(DESIGN_REVIEW_MAX_ATTEMPTS)
    expect(storage.designReviewRuns.findActiveByTaskId(taskId)).toBeUndefined()
  })

  it('timeoutはrunningのまま放置されず、その場でrequeueされる', async () => {
    const run = storage.designReviewRuns.create(baseInput(taskId))
    const result = await executeDesignReviewRun(
      storage, run, deps(async () => ({ ok: false, stdout: '', error: 'runner timed out', timedOut: true })),
    )

    expect(result.status).toBe('requeued')
    expect(storage.designReviewRuns.findById(run.id)!.status).toBe('queued')
  })

  it('稼働中に誤ってstartup回収を呼んでも、現プロセスが実行中のrunは巻き込まない', async () => {
    const run = storage.designReviewRuns.create(baseInput(taskId))
    const claimed = storage.designReviewRuns.claim(run.id, DESIGN_REVIEW_MAX_ATTEMPTS)
    expect(claimed.claimToken).toBeDefined()

    // 現プロセス起動時刻より後に開始したrunなので回収対象外になる
    const recovered = storage.designReviewRuns.recoverStaleRunningAtStartup(
      DESIGN_REVIEW_MAX_ATTEMPTS,
      '2000-01-01T00:00:00.000Z',
    )

    expect(recovered).toHaveLength(0)
    expect(storage.designReviewRuns.findById(run.id)!.status).toBe('running')
    // 実行中attemptのclaim_tokenが無効化されていないこと
    expect(storage.designReviewRuns.complete(run.id, claimed.claimToken!, 'succeeded', '{}')).toBe(true)
  })

  it('API crash相当のstale runningはstartupで回収され再kickされる', async () => {
    const run = storage.designReviewRuns.create(baseInput(taskId))
    // claimしたままprocessが落ちた状態を再現する
    storage.designReviewRuns.claim(run.id, DESIGN_REVIEW_MAX_ATTEMPTS)
    expect(storage.designReviewRuns.findById(run.id)!.status).toBe('running')

    // 前プロセスが残したrunとして扱わせるため、境界時刻を明示する
    const results = await recoverAndRekickAtStartup(
      storage,
      deps(async () => ({ ok: true, stdout: alignedResult([]), timedOut: false })),
      '9999-12-31T00:00:00.000Z',
    )

    expect(results.length).toBeGreaterThan(0)
    expect(storage.designReviewRuns.findById(run.id)!.status).not.toBe('running')
  })

  it('startup回収でattempt超過分はrequeueせずfailedで終端する', () => {
    const run = storage.designReviewRuns.create(baseInput(taskId))
    for (let i = 0; i < DESIGN_REVIEW_MAX_ATTEMPTS; i += 1) {
      const claimed = storage.designReviewRuns.claim(run.id, DESIGN_REVIEW_MAX_ATTEMPTS)
      if (!claimed.claimToken) break
      storage.designReviewRuns.requeue(run.id, claimed.claimToken, 'retry')
    }
    storage.designReviewRuns.claim(run.id, DESIGN_REVIEW_MAX_ATTEMPTS)

    // 未来時刻を境界にして「前プロセスの残骸」として扱わせる
    storage.designReviewRuns.recoverStaleRunningAtStartup(DESIGN_REVIEW_MAX_ATTEMPTS, '9999-12-31T00:00:00.000Z')

    const final = storage.designReviewRuns.findById(run.id)!
    expect(['failed', 'queued']).toContain(final.status)
    expect(final.status).not.toBe('running')
  })
})

const ROADMAP_FOCUSES = ['strategic_alignment', 'scope_simplicity', 'architecture_responsibility']

function roadmapAlignedRaw(): Record<string, unknown> {
  return {
    reviewKind: 'roadmap',
    subjectId: 'project-roadmap-1',
    reviewLoad: 'critical',
    selectedFocuses: ROADMAP_FOCUSES,
    focusedReviewResults: ROADMAP_FOCUSES.map((focus) => ({ focus, decision: 'ALIGNED' })),
    integrationReviewResult: { decision: 'ALIGNED' },
    // PR C: roadmap kind に independent review は無い。第二意見は Claude の integration review。
    finalDecision: 'ALIGNED',
  }
}

describe('recomputeDecision with reviewKind=roadmap', () => {
  it('roadmap固定のcritical負荷とfocus集合を採用する', () => {
    const outcome = recomputeDecision(roadmapAlignedRaw(), 'roadmap', [])

    expect(outcome.decision).toBe('ALIGNED')
    expect(outcome.reviewLoad).toBe('critical')
    // roadmap kind は別建ての independent review を要求しない（Worker も生成しない）。
    expect(outcome.independentReviewRequired).toBe(false)
    expect(outcome.rejectedReason).toBeUndefined()
  })

  it('roadmap でも runner が REVIEW_UNAVAILABLE を申告したら全件 ALIGNED でも ALIGNED にしない', () => {
    const raw = roadmapAlignedRaw()
    raw.finalDecision = 'REVIEW_UNAVAILABLE'
    raw.unavailableReason = 'Claude integration review unavailable'

    const outcome = recomputeDecision(raw, 'roadmap', [])

    expect(outcome.decision).toBe('REVIEW_UNAVAILABLE')
    expect(outcome.rejectedReason).toContain('Claude integration review unavailable')
  })

  it('roadmap の unavailable 申告でも CONFLICT は CONFLICT のまま', () => {
    const raw = roadmapAlignedRaw()
    raw.finalDecision = 'REVIEW_UNAVAILABLE'
    raw.integrationReviewResult = { decision: 'CONFLICT', summary: 'phases conflict' }

    expect(recomputeDecision(raw, 'roadmap', []).decision).toBe('CONFLICT')
  })

  it('roadmap focus集合と不一致なら採用しない（changedFiles起因のfocus推論を混ぜない）', () => {
    const raw = roadmapAlignedRaw()
    raw.focusedReviewResults = (raw.focusedReviewResults as Array<{ focus: string; decision: string }>).slice(0, 2)

    const outcome = recomputeDecision(raw, 'roadmap', ['apps/worker/src/metaReviewer/strategicReview.ts'])

    expect(outcome.decision).not.toBe('ALIGNED')
    expect(outcome.rejectedReason).toContain('focus set mismatch')
  })

  // PR C: roadmap の第二意見は Claude の integration review。これが欠けたまま
  // 「Gemini群だけ揃ったので承認」にしてはならない。
  it('integration reviewが欠落していれば採用しない（fail-closed）', () => {
    const raw = roadmapAlignedRaw()
    delete raw.integrationReviewResult

    const outcome = recomputeDecision(raw, 'roadmap', [])

    expect(outcome.decision).not.toBe('ALIGNED')
    expect(outcome.rejectedReason).toContain('integration review')
  })

  it('Gemini focused の CONFLICT は ALIGNED にならない', () => {
    const raw = roadmapAlignedRaw()
    const focuses = raw.focusedReviewResults as Array<{ focus: string; decision: string }>
    focuses[1] = { focus: focuses[1].focus, decision: 'CONFLICT' }

    expect(recomputeDecision(raw, 'roadmap', []).decision).toBe('CONFLICT')
  })

  it('Gemini focused の UNCERTAIN は ALIGNED にならない', () => {
    const raw = roadmapAlignedRaw()
    const focuses = raw.focusedReviewResults as Array<{ focus: string; decision: string }>
    focuses[1] = { focus: focuses[1].focus, decision: 'UNCERTAIN' }

    expect(recomputeDecision(raw, 'roadmap', []).decision).toBe('UNCERTAIN')
  })

  // task kind の契約は変えない。critical では従来どおり independent review を要求する。
  it('task kind の critical は従来どおり independent review を要求する', () => {
    const raw = roadmapAlignedRaw()
    raw.reviewKind = 'task'
    delete raw.independentReviewResult

    const outcome = recomputeDecision(
      raw,
      'task',
      ['apps/api/src/storage/sqlite.ts', 'apps/worker/src/jobRunner.ts'],
    )

    expect(outcome.decision).not.toBe('ALIGNED')
  })
})

describe('createAndExecuteRoadmapReview', () => {
  it('roadmap runを起票し、subjectId=projectIdのevidenceを登録する（taskIdは持たない）', async () => {
    const storage = createStorage()
    const projectId = 'project-roadmap-1'
    const reviewMaterial = '# Roadmap Design Review Material'

    const result = await createAndExecuteRoadmapReview(
      storage,
      { projectId, reviewMaterial },
      deps(async () => ({ ok: true, stdout: JSON.stringify(roadmapAlignedRaw()), timedOut: false })),
    )

    expect(result.status).toBe('evidence_registered')
    expect(result.decision).toBe('ALIGNED')
    const evidence = result.evidence!
    expect(evidence.reviewKind).toBe('roadmap')
    expect(evidence.subjectId).toBe(projectId)
    expect(evidence.taskId).toBeUndefined()

    const stored = storage.designReviewEvidence.findLatestBySubjectId('roadmap', projectId)
    expect(stored).toBeDefined()
    expect(stored!.id).toBe(evidence.id)
    expect(stored!.reviewKind).toBe('roadmap')
    expect(stored!.subjectId).toBe(projectId)
    expect(stored!.taskId).toBeUndefined()
  })

  it('runner が REVIEW_UNAVAILABLE を申告したら全件 ALIGNED でも evidence を登録せず、従来どおり非 ALIGNED で終端する', async () => {
    const storage = createStorage()
    const projectId = 'project-roadmap-unavailable'
    const raw = { ...roadmapAlignedRaw(), finalDecision: 'REVIEW_UNAVAILABLE' }

    const result = await createAndExecuteRoadmapReview(
      storage,
      { projectId, reviewMaterial: '# Roadmap Design Review Material' },
      deps(async () => ({ ok: true, stdout: JSON.stringify(raw), timedOut: false })),
    )

    // retry（finalizeFailure）は task kind のみ。roadmap は非 ALIGNED として確定する。
    expect(result).toMatchObject({ status: 'not_aligned', decision: 'REVIEW_UNAVAILABLE' })
    expect(storage.designReviewEvidence.findLatestBySubjectId('roadmap', projectId)).toBeUndefined()
  })

  it('runnerへ渡すinputはreviewKind=roadmap・subjectId=projectId・changedFiles=[] であり、taskIdを合成しない', async () => {
    const storage = createStorage()
    const projectId = 'project-roadmap-input'
    const reviewMaterial = '# Roadmap Design Review Material'

    const execute = vi.fn(async (_input: string) => ({ ok: true, stdout: JSON.stringify(roadmapAlignedRaw()), timedOut: false }))
    await createAndExecuteRoadmapReview(
      storage,
      { projectId, reviewMaterial },
      deps(execute),
    )

    expect(execute).toHaveBeenCalledTimes(1)
    const runnerInput = JSON.parse(execute.mock.calls[0]?.[0] as string) as Record<string, unknown>
    expect(runnerInput.reviewKind).toBe('roadmap')
    expect(runnerInput.subjectId).toBe(projectId)
    expect(runnerInput.taskId).toBeUndefined()
    expect(runnerInput.changedFiles).toEqual([])
  })

  it('runnerへ渡すinputはworkingDir（target）とcontrolContextDir（control）を別々のフィールドとして運ぶ', async () => {
    const storage = createStorage()
    const projectId = 'project-roadmap-two-root'

    const execute = vi.fn(async (_input: string) => ({ ok: true, stdout: JSON.stringify(roadmapAlignedRaw()), timedOut: false }))
    await createAndExecuteRoadmapReview(
      storage,
      { projectId, reviewMaterial: '# Roadmap Design Review Material' },
      { ...deps(execute), workingDir: '/target/root', controlContextDir: '/control/root' },
    )

    expect(execute).toHaveBeenCalledTimes(1)
    const runnerInput = JSON.parse(execute.mock.calls[0]?.[0] as string) as Record<string, unknown>
    expect(runnerInput.workingDir).toBe('/target/root')
    expect(runnerInput.controlContextDir).toBe('/control/root')
    expect(runnerInput.workingDir).not.toBe(runnerInput.controlContextDir)
  })

  it('task系runner inputにもcontrolContextDirを通す', async () => {
    const storage = createStorage()
    const taskId = seedTask(storage)

    const execute = vi.fn(async (_input: string) => ({ ok: true, stdout: alignedResult([]), timedOut: false }))
    await createAndExecuteDesignReview(
      storage,
      { taskId, taskTitle: 'design', designText: 'text', changedFiles: LOW_LOAD_FILES },
      { ...deps(execute), workingDir: '/target/root', controlContextDir: '/control/root' },
    )

    expect(execute).toHaveBeenCalledTimes(1)
    const runnerInput = JSON.parse(execute.mock.calls[0]?.[0] as string) as Record<string, unknown>
    expect(runnerInput.workingDir).toBe('/target/root')
    expect(runnerInput.controlContextDir).toBe('/control/root')
    expect(runnerInput.workingDir).not.toBe(runnerInput.controlContextDir)
  })
})

describe('roadmap review claim/fence dedup', () => {
  it('同一projectIdに対して同時にcreateしてもactive runは1つだけになる（二重起票しない）', () => {
    const storage = createStorage()
    const projectId = 'project-roadmap-dedup'
    const input = {
      reviewKind: 'roadmap' as const,
      subjectId: projectId,
      taskTitle: 'Whole-Roadmap Review',
      designText: '# Roadmap',
      designTextHash: 'hash-r',
      changedFiles: [],
    }

    const first = storage.designReviewRuns.create(input)
    const second = storage.designReviewRuns.create(input)

    expect(second.id).toBe(first.id)
    const queued = storage.designReviewRuns.findQueued()
    expect(queued.filter((run) => run.subjectId === projectId)).toHaveLength(1)
  })
})

describe('executeRunner stderr cap UTF-8 boundary', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'stderr-utf8-test-'))
  const scriptPath = join(tmpDir, 'write-stderr-utf8.js')

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stderr byte length never exceeds cap even when chunk slices mid-multibyte character', async () => {
    const maxBytes = DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES
    // Write enough ASCII to leave room for one multi-byte character to straddle the boundary.
    // A 4-byte emoji (🎉) at the tail end ensures that if the handler byte-slices mid-character,
    // the U+FFFD replacement (3 bytes) can overshoot.
    const paddingLen = maxBytes - 4
    const padding = 'x'.repeat(paddingLen)

    writeFileSync(scriptPath, [
      'const s = ' + JSON.stringify(padding) + ';',
      'process.stderr.write(s);',
      // Write a 4-byte UTF-8 emoji. The stream chunk boundary may or may not split
      // this character; regardless, the handler must not let the total exceed the cap.
      'process.stderr.write("\\u{1F389}");',
      'process.exit(0);',
    ].join('\n'))

    const prevSystemRoot = process.env.SystemRoot
    const prevWindir = process.env.windir
    process.env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    process.env.windir = process.env.windir ?? 'C:\\Windows'

    try {
      const runnerDeps: CoordinatorDeps = {
        runnerCommand: process.execPath,
        runnerArgs: [scriptPath],
        homeDirectory: process.env.HOME ?? process.env.USERPROFILE ?? '/tmp/home',
        workingDir: process.cwd(),
      }

      const result = await executeRunner(runnerDeps, '')

      expect(result.ok).toBe(true)
      expect(result.stderr).toBeDefined()
      const stderrBytes = Buffer.byteLength(result.stderr!, 'utf-8')
      expect(stderrBytes).toBeLessThanOrEqual(maxBytes)
    } finally {
      if (prevSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = prevSystemRoot
      if (prevWindir === undefined) delete process.env.windir
      else process.env.windir = prevWindir
    }
  })
})

describe('executeRunner stderr cap enforcement', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'stderr-cap-test-'))
  const scriptPath = join(tmpDir, 'write-stderr.js')

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stderr byte length never exceeds DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES even with chunks that would overshoot', async () => {
    // Write 12 MB to stderr in a single write. The child process outputs more than
    // DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES (10 MB) to stderr. Under the old
    // check-before-append logic, the full 12 MB would be appended because the check
    // runs before the append (so the first append succeeds when stderr is empty, and
    // subsequent appends continue until the check finally triggers). With the fix,
    // the chunk is truncated to fit the remaining byte budget and no further chunks
    // are appended.
    writeFileSync(scriptPath, `process.stderr.write('x'.repeat(12 * 1024 * 1024)); process.exit(0);`)

    // ExecuteRunner builds a restricted env via buildRunnerEnv. On Windows,
    // SystemRoot/windir are required for child_process.spawn to find executables.
    // We inject them into process.env before calling executeRunner so buildRunnerEnv
    // inherits them, then clean up after.
    const prevSystemRoot = process.env.SystemRoot
    const prevWindir = process.env.windir
    process.env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    process.env.windir = process.env.windir ?? 'C:\\Windows'

    try {
      const runnerDeps: CoordinatorDeps = {
        runnerCommand: process.execPath,
        runnerArgs: [scriptPath],
        homeDirectory: process.env.HOME ?? process.env.USERPROFILE ?? '/tmp/home',
        workingDir: process.cwd(),
      }

      const result = await executeRunner(runnerDeps, '')

      expect(result.ok).toBe(true)
      expect(result.stderr).toBeDefined()
      const stderrBytes = Buffer.byteLength(result.stderr!, 'utf-8')
      expect(stderrBytes).toBeLessThanOrEqual(DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES)
    } finally {
      if (prevSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = prevSystemRoot
      if (prevWindir === undefined) delete process.env.windir
      else process.env.windir = prevWindir
    }
  })
})

/**
 * `design-review-runner-production-timeout` の Root Cause 調査（2026-09-14 production 実測）で
 * 判明した3点への回帰テスト。
 *
 * 1. timeout 時に stderr を捨てていたため、原因（provider の transient 失敗）が DB に残らなかった
 * 2. timeout の kill が直接の子にしか届かず、孫プロセスが孤児化していた
 * 3. runner 内部の retry 予算（待機だけで 40 秒）に対して caller の上限が 120 秒と短すぎた
 */
describe('runner 失敗の診断可能性と終了処理', () => {
  it('timeout の理由に runner stderr の末尾が残る（原因を DB から追える）', () => {
    const diag = '[geminiRouter] attempt failed: provider=gemini_api failureClass=transient httpStatus=503'
    const merged = appendRunnerStderr('runner timed out after 300000ms', `noise\n${diag}`)

    expect(merged).toContain('runner timed out after 300000ms')
    expect(merged).toContain(diag)
  })

  it('stderr が無ければ既存の理由文をそのまま使う', () => {
    expect(appendRunnerStderr('runner failed', undefined)).toBe('runner failed')
    expect(appendRunnerStderr('runner failed', '   ')).toBe('runner failed')
  })

  it('stderr は末尾だけを上限つきで残す（error 列を診断ログにしない）', () => {
    const long = `${'x'.repeat(5000)}THE-LAST-LINE`
    const merged = appendRunnerStderr('runner failed', long)

    expect(merged).toContain('THE-LAST-LINE')
    expect(merged.length).toBeLessThan(DESIGN_REVIEW_STDERR_TAIL_CHARS + 200)
  })

  it('runner の上限は runner 内部の transient retry 予算（待機 40 秒）を収容する', () => {
    // geminiRouter の TRANSIENT_RETRY_DELAYS_MS = [10s, 30s] を API 経路・CLI 経路で個別に消費する。
    // 120 秒では「レビュー自体は正常でも provider が不安定なら超過する」状態だった。
    expect(DESIGN_REVIEW_RUNNER_TIMEOUT_MS).toBeGreaterThan(40_000 * 2)
  })

  // プロセスグループ kill は POSIX の負 PID に依存する。production も CI も Linux。
  // Windows には同等物が無く killTree は直接の子への kill へフォールバックするため、
  // ここで検証しても意味が無い（誤って緑になる）ので明示的に skip する。
  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix('timeout 時は子だけでなくプロセスグループごと落とす（孫を孤児にしない）', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'runner-kill-')), 'grandchild-alive')
    const grandchild =
      `setInterval(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 50)`
    const script =
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`
      + `setTimeout(() => {}, 60000);`

    const execution = await executeRunner(
      {
        runnerCommand: process.execPath,
        runnerArgs: ['-e', script],
        homeDirectory: tmpdir(),
        workingDir: tmpdir(),
        timeoutMs: 2_000,
      },
      '{}',
    )

    expect(execution.timedOut).toBe(true)

    // **まず孫が実在したことを確かめる。** これが無いと「何も起きていない」を合格にしてしまう。
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const first = readFileIfExists(marker)
    expect(first, 'grandchild never ran; the assertion below would be vacuous').toBeDefined()

    // 回収できていれば更新が止まる。孤児化していれば 50ms ごとに書き換わり続ける。
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(readFileIfExists(marker)).toBe(first)
  }, 20_000)
})

function readFileIfExists(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    return undefined
  }
}

/**
 * **「判定が無い」と否定的な判定を分ける**（2026-10-16 production・Task `b8d0fc5d` の run `c11357e8`）。
 *
 * critical load で independent review が取れない（Codex logout）と、focused の実質的な CONFLICT が
 * REVIEW_UNAVAILABLE に置き換わり、しかも not_aligned として確定して retry されなかった。
 */
describe('critical load: independent 欠落と focused CONFLICT の分離', () => {
  const CRITICAL_FILES = ['specs/00_constitution.md']

  function criticalRaw(scopeDecision: string, independent?: Record<string, unknown>) {
    return {
      focusedReviewResults: [
        { focus: 'strategic_alignment', decision: 'UNCERTAIN' },
        { focus: 'scope_simplicity', decision: scopeDecision },
      ],
      ...(independent ? { independentReviewResult: independent } : {}),
      finalDecision: 'REVIEW_UNAVAILABLE',
    }
  }

  it('independent が欠落していても focused が CONFLICT なら CONFLICT を返す', () => {
    const outcome = recomputeDecision(criticalRaw('CONFLICT'), 'task', CRITICAL_FILES)

    expect(outcome.reviewLoad).toBe('critical')
    expect(outcome.decision).toBe('CONFLICT')
    expect(outcome.rejectedReason).toContain('critical review load requires an independent review result')
  })

  it('independent が unavailable でも focused が CONFLICT なら CONFLICT を返す', () => {
    const outcome = recomputeDecision(
      criticalRaw('CONFLICT', { verdict: 'blocking', summary: 'Independent review failed: logged out', unavailable: true }),
      'task',
      CRITICAL_FILES,
    )

    expect(outcome.decision).toBe('CONFLICT')
    expect(outcome.rejectedReason).toContain('requires an independent review result, but it was unavailable')
  })

  it('independent が unavailable で focused に CONFLICT が無ければ REVIEW_UNAVAILABLE', () => {
    const outcome = recomputeDecision(
      criticalRaw('ALIGNED', { verdict: 'blocking', summary: 'failed', unavailable: true }),
      'task',
      CRITICAL_FILES,
    )

    expect(outcome.decision).toBe('REVIEW_UNAVAILABLE')
  })

  it('全 focus ALIGNED でも independent 欠落は REVIEW_UNAVAILABLE になり、run は完了せず requeue される', async () => {
    const storage = createStorage()
    const taskId = seedTask(storage)
    const stdout = JSON.stringify({
      focusedReviewResults: [
        { focus: 'strategic_alignment', decision: 'ALIGNED' },
        { focus: 'scope_simplicity', decision: 'ALIGNED' },
      ],
      finalDecision: 'ALIGNED',
    })
    expect(recomputeDecision(JSON.parse(stdout), 'task', CRITICAL_FILES).decision).toBe('REVIEW_UNAVAILABLE')

    const runner = deps(async () => ({ ok: true, stdout, timedOut: false }))
    const first = await createAndExecuteDesignReview(
      storage, { ...baseInput(taskId), changedFiles: CRITICAL_FILES }, runner,
    )

    expect(first.status).toBe('requeued')
    expect(first.decision).toBe('REVIEW_UNAVAILABLE')
    const runId = storage.designReviewRuns.findLatestByTaskId(taskId)!.id
    const afterFirst = storage.designReviewRuns.findById(runId)!
    expect(afterFirst.status).toBe('queued')
    expect(afterFirst.attemptCount).toBe(1)
    expect(afterFirst.completedAt).toBeUndefined()
    expect(afterFirst.error).toContain('independent review')

    const second = await executeDesignReviewRun(storage, afterFirst, runner)
    expect(second.status).toBe('requeued')
    expect(storage.designReviewRuns.findById(runId)!.attemptCount).toBe(2)

    // attempt 上限で failed 終端する（runner crash と同じ finalizeFailure 経路）。
    for (let i = 0; i < DESIGN_REVIEW_MAX_ATTEMPTS + 2; i += 1) {
      const active = storage.designReviewRuns.findById(runId)!
      if (active.status !== 'queued') break
      await executeDesignReviewRun(storage, active, runner)
    }
    const final = storage.designReviewRuns.findById(runId)!
    expect(final.status).toBe('failed')
    expect(final.attemptCount).toBe(DESIGN_REVIEW_MAX_ATTEMPTS)
    expect(final.resultJson).toBeUndefined()
  })

  it('focused CONFLICT + independent 欠落は従来どおり判定として完了する（retry しない）', async () => {
    const storage = createStorage()
    const taskId = seedTask(storage)
    const runner = deps(async () => ({ ok: true, stdout: JSON.stringify(criticalRaw('CONFLICT')), timedOut: false }))

    const result = await createAndExecuteDesignReview(
      storage, { ...baseInput(taskId), changedFiles: CRITICAL_FILES }, runner,
    )

    expect(result).toMatchObject({ status: 'not_aligned', decision: 'CONFLICT' })
    const run = storage.designReviewRuns.findLatestByTaskId(taskId)!
    expect(run.status).toBe('succeeded')
    expect(run.attemptCount).toBe(1)
  })
})

/**
 * runner の「実行できなかった」申告は判定を厳しくする向きにしか使わない（独立レビュー指摘・2026-10-16）。
 * focused が全件 ALIGNED でも integration が欠けて REVIEW_UNAVAILABLE を申告した payload を、
 * 組み直して ALIGNED にしてはならない。
 */
describe('runner が申告した REVIEW_UNAVAILABLE は ALIGNED へ格上げしない（task kind・全 load）', () => {
  const HIGH_FILES = ['apps/api/src/auth/credentials.ts']
  const unavailablePayload = {
    focusedReviewResults: [
      { focus: 'scope_simplicity', decision: 'ALIGNED' },
      { focus: 'strategic_alignment', decision: 'ALIGNED' },
    ],
    finalDecision: 'REVIEW_UNAVAILABLE',
    unavailableReason: 'integration review unavailable',
  }

  it('high load で focused 全件 ALIGNED・integration 無し・finalDecision=REVIEW_UNAVAILABLE は REVIEW_UNAVAILABLE', () => {
    const outcome = recomputeDecision(unavailablePayload, 'task', HIGH_FILES)

    expect(outcome.reviewLoad).not.toBe('critical')
    expect(outcome.decision).toBe('REVIEW_UNAVAILABLE')
    expect(outcome.rejectedReason).toContain('integration review unavailable')
  })

  it('同じ payload で evidence は登録されず run は requeue される', async () => {
    const storage = createStorage()
    const taskId = seedTask(storage)
    const runner = deps(async () => ({ ok: true, stdout: JSON.stringify(unavailablePayload), timedOut: false }))

    const result = await createAndExecuteDesignReview(storage, { ...baseInput(taskId), changedFiles: HIGH_FILES }, runner)

    expect(result.status).toBe('requeued')
    expect(storage.designReviewEvidence.findByTaskId(taskId)).toEqual([])
  })

  it('unavailable でも focused の CONFLICT は CONFLICT のまま', () => {
    const outcome = recomputeDecision({
      ...unavailablePayload,
      focusedReviewResults: [
        { focus: 'scope_simplicity', decision: 'CONFLICT' },
        { focus: 'strategic_alignment', decision: 'ALIGNED' },
      ],
    }, 'task', HIGH_FILES)

    expect(outcome.decision).toBe('CONFLICT')
  })
})

/**
 * **判定 pipeline の不変条件を全組み合わせで固定する**（独立レビュー round 4・2026-10-16）。
 *
 * kind × load × 構造の妥当性 × unavailable の出どころ × CONFLICT の有無。分岐ごとの継ぎ足しでは
 * 「ある組み合わせだけ CONFLICT が隠れる / unavailable が ALIGNED になる」が漏れ続けたため、
 * 個別ケースではなく表で確かめる:
 *   - 有効な CONFLICT があれば必ず CONFLICT
 *   - unavailable で CONFLICT が無ければ必ず REVIEW_UNAVAILABLE
 *   - unavailable / 構造不正のときは決して ALIGNED にならない
 */
describe('recomputeDecision の判定 pipeline（kind × load × 妥当性 × unavailable × CONFLICT）', () => {
  const FILES_BY_LOAD = {
    low: ['docs/readme.md'],
    medium: ['apps/api/src/pl/executionLoop.ts'],
    high: ['apps/api/src/auth/credentials.ts'],
    critical: ['specs/00_constitution.md'],
  } as const
  const KINDS = ['task', 'roadmap'] as const
  const VALIDITY = ['valid', 'invalid'] as const
  const UNAVAILABLE = ['none', 'finalDecision', 'focus', 'integration', 'independent'] as const
  const CONFLICT_PRESENCE = [true, false] as const

  type Item = { focus?: string; decision: string; unavailable?: boolean; summary?: string }

  function buildPayload(
    kind: (typeof KINDS)[number],
    files: readonly string[],
    validity: (typeof VALIDITY)[number],
    unavailable: (typeof UNAVAILABLE)[number],
    hasConflict: boolean,
  ): { raw: Record<string, unknown>; applicable: boolean } {
    const load = classifyReviewLoad({ changedFiles: [...files] }).reviewLoad
    const expected: string[] = kind === 'roadmap' ? selectRoadmapReviewFocuses() : selectFocuses(load, [...files])
    const focused: Item[] = expected.map((focus) => ({ focus, decision: 'ALIGNED' }))
    const integration: Item = { decision: 'ALIGNED', summary: 'ok' }
    const raw: Record<string, unknown> = { finalDecision: 'ALIGNED' }
    if (kind === 'task' && load === 'critical') {
      raw.independentReviewResult = { verdict: 'approved', summary: 'ok', unavailable: false }
    }

    // CONFLICT は要求した focus があればそこへ、無ければ integration へ置く。
    if (hasConflict) {
      if (focused.length > 0) focused[0].decision = 'CONFLICT'
      else integration.decision = 'CONFLICT'
    }
    if (validity === 'invalid') {
      focused.push({ focus: 'not_a_real_focus', decision: 'UNCERTAIN' })
    }

    switch (unavailable) {
      case 'finalDecision':
        raw.finalDecision = 'REVIEW_UNAVAILABLE'
        raw.unavailableReason = 'matrix: runner could not run the review'
        break
      case 'focus': {
        const target = focused[focused.length - 1]
        // 期待 focus が無い妥当な payload には印を付ける場所が無い（組み合わせとして成立しない）。
        if (target === undefined) return { raw, applicable: false }
        target.unavailable = true
        if (target.decision !== 'CONFLICT') target.decision = 'UNCERTAIN'
        break
      }
      case 'integration':
        integration.unavailable = true
        if (integration.decision !== 'CONFLICT') integration.decision = 'UNCERTAIN'
        break
      case 'independent':
        raw.independentReviewResult = { verdict: 'blocking', summary: 'Independent review failed', unavailable: true }
        break
      case 'none':
        break
    }

    raw.focusedReviewResults = focused
    raw.integrationReviewResult = integration
    return { raw, applicable: true }
  }

  const cases: Array<[string, string, string, string, boolean]> = []
  for (const kind of KINDS) {
    for (const load of Object.keys(FILES_BY_LOAD)) {
      for (const validity of VALIDITY) {
        for (const unavailable of UNAVAILABLE) {
          for (const hasConflict of CONFLICT_PRESENCE) {
            cases.push([kind, load, validity, unavailable, hasConflict])
          }
        }
      }
    }
  }

  it.each(cases)('%s / %s / %s / unavailable=%s / conflict=%s', (kind, load, validity, unavailable, hasConflict) => {
    const files = FILES_BY_LOAD[load as keyof typeof FILES_BY_LOAD]
    const { raw, applicable } = buildPayload(
      kind as (typeof KINDS)[number],
      files,
      validity as (typeof VALIDITY)[number],
      unavailable as (typeof UNAVAILABLE)[number],
      hasConflict,
    )
    if (!applicable) return

    const outcome = recomputeDecision(raw, kind as 'task' | 'roadmap', [...files])

    if (hasConflict) {
      expect(outcome.decision).toBe('CONFLICT')
    } else if (unavailable !== 'none') {
      expect(outcome.decision).toBe('REVIEW_UNAVAILABLE')
    } else if (validity === 'invalid') {
      expect(outcome.decision).toBe('UNCERTAIN')
    } else {
      expect(outcome.decision).toBe('ALIGNED')
    }
    if (unavailable !== 'none' || validity === 'invalid') {
      expect(outcome.decision).not.toBe('ALIGNED')
    }
  })

  it.each([['null'], ['[]'], ['"text"'], ['42']])('runner 出力 %s は finalizeFailure で終端し、run を running のまま残さない', async (stdout) => {
    const storage = createStorage()
    const taskId = seedTask(storage)
    const runner = deps(async () => ({ ok: true, stdout, timedOut: false }))

    const result = await createAndExecuteDesignReview(storage, baseInput(taskId), runner)

    expect(result.status).toBe('requeued')
    const run = storage.designReviewRuns.findLatestByTaskId(taskId)!
    expect(run.status).toBe('queued')
    expect(run.error).toContain('no usable output')
    expect(storage.designReviewEvidence.findByTaskId(taskId)).toEqual([])
  })
})
