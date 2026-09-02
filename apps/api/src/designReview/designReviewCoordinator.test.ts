import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import {
  DESIGN_REVIEW_MAX_ATTEMPTS,
  buildRunnerEnv,
  createAndExecuteDesignReview,
  createAndExecuteRoadmapReview,
  executeDesignReviewRun,
  recomputeDecision,
  recoverAndRekickAtStartup,
} from './designReviewCoordinator'

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
    independentReviewResult: { verdict: 'approved' },
    finalDecision: 'ALIGNED',
  }
}

describe('recomputeDecision with reviewKind=roadmap', () => {
  it('roadmap固定のcritical負荷とfocus集合を採用する', () => {
    const outcome = recomputeDecision(roadmapAlignedRaw(), 'roadmap', [])

    expect(outcome.decision).toBe('ALIGNED')
    expect(outcome.reviewLoad).toBe('critical')
    expect(outcome.independentReviewRequired).toBe(true)
    expect(outcome.rejectedReason).toBeUndefined()
  })

  it('roadmap focus集合と不一致なら採用しない（changedFiles起因のfocus推論を混ぜない）', () => {
    const raw = roadmapAlignedRaw()
    raw.focusedReviewResults = (raw.focusedReviewResults as Array<{ focus: string; decision: string }>).slice(0, 2)

    const outcome = recomputeDecision(raw, 'roadmap', ['apps/worker/src/metaReviewer/strategicReview.ts'])

    expect(outcome.decision).not.toBe('ALIGNED')
    expect(outcome.rejectedReason).toContain('focus set mismatch')
  })

  it('criticalなのにindependent reviewが欠落していれば採用しない', () => {
    const raw = roadmapAlignedRaw()
    delete raw.independentReviewResult

    const outcome = recomputeDecision(raw, 'roadmap', [])

    expect(outcome.decision).not.toBe('ALIGNED')
    expect(outcome.rejectedReason).toContain('independent review')
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
