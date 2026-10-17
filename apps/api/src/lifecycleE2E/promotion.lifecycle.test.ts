/**
 * Lifecycle E2E — P: Candidate → Promotion → Adoption の結合検証。
 *
 * 本物の route + SQLite（`:memory:`）+ 本物の採用コード（`runPlTick()` → `runAdoptionStep()` →
 * `classifyAdoptionCandidates()` → `adoptRoadmapItem()`）を、temp の git repo 2 つの上で回す:
 *
 *   - Candidate repo（`LIFECYCLE_TARGET_DIR`、branch `candidate/self-dev`）… PL が読む ledger
 *     （`TARGET_ROOT/tasks/roadmap.md`）と、Worker simulation が commit する Tier A Candidate clone
 *   - canonical repo（`<Candidate>-master`、branch `master`）… Promotion の着地先
 *
 * **simulation（本物でないもの）**: Promotion そのもの（PR → CI → merge は GitHub 上の人間操作）。
 * ここでは「master へ Candidate の commit 内容を 1 commit で着地させ、同じ commit で
 * `roadmap:update --state done` + `roadmap:sync` を当て、`roadmap:check` が通る」状態を、
 * CLI と同じ純関数（`updateRoadmapState()` / `generateRoadmapCurrentStateBlock()` /
 * `replaceGeneratedCurrentStateBlock()` / `collectCheckIssues()` と同じ判定）で作る。CLI 自体は repo root を
 * スクリプト位置から決めるので temp repo へ向けられない。Candidate sync は運用記録
 * （2026-10-01: master を merge commit で取り込む）と同じ `git merge --no-ff`。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/targetWorkingDir', async () => {
  const { LIFECYCLE_TARGET_DIR } = await import('./runnerStub.js')
  return { TARGET_WORKING_DIR: LIFECYCLE_TARGET_DIR }
})
vi.mock('../designReview/designReviewCoordinator', async (importOriginal) => {
  const { stubCoordinatorDeps } = await import('./runnerStub.js')
  return {
    ...(await importOriginal<typeof import('../designReview/designReviewCoordinator')>()),
    buildDefaultCoordinatorDeps: stubCoordinatorDeps,
  }
})

import {
  getValidRoadmapItems,
  parseRoadmapMarkdown,
  updateRoadmapState,
} from '@ai-team/worker/scripts/roadmap/roadmapParser.js'
import {
  generateRoadmapCurrentStateBlock,
  isCurrentStateBlockSynced,
  replaceGeneratedCurrentStateBlock,
  validateCurrentStateMarkers,
  ROADMAP_CURRENT_STATE_END,
  ROADMAP_CURRENT_STATE_START,
} from '@ai-team/worker/scripts/roadmap/currentStateSync.js'
import {
  buildLedger,
  createRunningProject,
  git,
  headCommit,
  removeTargetRepo,
  startLifecycle,
  type LifecycleEnv,
} from './harness'
import { LIFECYCLE_TARGET_DIR, resetDesignReviewStub } from './runnerStub'
import { classifyAdoptionCandidates, readAdoptionCandidates } from '../pl/adoptionStep'
import { adoptRoadmapItem, checkRoadmapCompletionAwaitingPromotion } from '../ctoAi/roadmapAdoption'

vi.setConfig({ testTimeout: 300_000 })

const MASTER_DIR = `${LIFECYCLE_TARGET_DIR}-master`
const LEDGER = 'tasks/roadmap.md'
const CURRENT_STATE = 'docs/PROJECT_CURRENT_STATE.md'
const ALLOWED = ['docs/promo']

let env: LifecycleEnv

beforeEach(() => {
  resetDesignReviewStub()
})
afterEach(async () => {
  await env?.close()
})
afterAll(() => {
  removeTargetRepo()
  rmSync(MASTER_DIR, { recursive: true, force: true })
})

// ────────────────────────────────────────────────────────────
// canonical master / Promotion simulation
// ────────────────────────────────────────────────────────────

function gitAt(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * `roadmap:check`（`cli.ts` の `collectCheckIssues()`）と同じ判定を、同じ export 済み純関数で組む。
 * `cli.ts` 自体は `import.meta` を使うため API の tsconfig（CommonJS 出力）では import できない。
 */
function roadmapCheckIssues(roadmapMarkdown: string, currentStateMarkdown: string): string[] {
  const issues = [
    ...parseRoadmapMarkdown(roadmapMarkdown).issues.map((issue) => `roadmap:${issue.code}`),
    ...validateCurrentStateMarkers(currentStateMarkdown).map((issue) => `currentState:${issue.code}`),
  ]
  if (issues.length > 0) return issues
  return isCurrentStateBlockSynced(currentStateMarkdown, generateRoadmapCurrentStateBlock(getValidRoadmapItems(roadmapMarkdown)))
    ? []
    : ['currentState:generated_block_mismatch']
}

function readAt(dir: string, relative: string): string {
  return readFileSync(path.join(dir, relative), 'utf-8')
}

/** Candidate の初期 commit から canonical master を作る（PROJECT_CURRENT_STATE.md を持つ点だけが Candidate と違う）。 */
function createCanonicalMaster(): void {
  rmSync(MASTER_DIR, { recursive: true, force: true })
  mkdirSync(MASTER_DIR, { recursive: true })
  gitAt(MASTER_DIR, ['init', '-q', '-b', 'master'])
  for (const [key, value] of [
    ['user.email', 'lifecycle-e2e@example.invalid'], ['user.name', 'lifecycle-e2e'],
    ['core.autocrlf', 'false'], ['commit.gpgsign', 'false'],
  ]) gitAt(MASTER_DIR, ['config', key!, value!])
  gitAt(MASTER_DIR, ['fetch', '-q', LIFECYCLE_TARGET_DIR, 'candidate/self-dev:refs/remotes/candidate/self-dev'])
  gitAt(MASTER_DIR, ['reset', '-q', '--hard', 'refs/remotes/candidate/self-dev'])
  const items = getValidRoadmapItems(readAt(MASTER_DIR, LEDGER))
  writeFileSync(path.join(MASTER_DIR, CURRENT_STATE), [
    '# Current state', '', ROADMAP_CURRENT_STATE_START, generateRoadmapCurrentStateBlock(items), ROADMAP_CURRENT_STATE_END, '',
  ].join('\n'))
  gitAt(MASTER_DIR, ['add', '.'])
  gitAt(MASTER_DIR, ['commit', '-q', '-m', 'add PROJECT_CURRENT_STATE'])
  expect(roadmapCheckIssues(readAt(MASTER_DIR, LEDGER), readAt(MASTER_DIR, CURRENT_STATE))).toEqual([])
}

/**
 * Promotion の simulation: Candidate commit の内容を master へ 1 commit（squash PR 相当）で着地させ、
 * 同じ commit で ledger を done にして current-state を同期する。`roadmap:check` 相当が通ることを確かめる。
 */
function promoteToMaster(candidateCommits: Array<{ sha: string; roadmapId: string }>): string {
  gitAt(MASTER_DIR, ['fetch', '-q', LIFECYCLE_TARGET_DIR, 'candidate/self-dev:refs/remotes/candidate/self-dev'])
  for (const { sha, roadmapId } of candidateCommits) {
    gitAt(MASTER_DIR, ['cherry-pick', '-n', sha])
    // Candidate commit は ledger を触らない（Tier A の Task は ledger を書かない）ので衝突しない。
    const ledger = updateRoadmapState(readAt(MASTER_DIR, LEDGER), roadmapId, 'done').markdown
    writeFileSync(path.join(MASTER_DIR, LEDGER), ledger)
    const synced = replaceGeneratedCurrentStateBlock(
      readAt(MASTER_DIR, CURRENT_STATE),
      generateRoadmapCurrentStateBlock(getValidRoadmapItems(ledger)),
    ).markdown
    writeFileSync(path.join(MASTER_DIR, CURRENT_STATE), synced)
    expect(roadmapCheckIssues(ledger, synced), `roadmap:check after promoting ${roadmapId}`).toEqual([])
    gitAt(MASTER_DIR, ['add', '-A'])
    gitAt(MASTER_DIR, ['commit', '-q', '-m', `promote ${roadmapId} (squash of ${sha.slice(0, 7)})`])
  }
  return gitAt(MASTER_DIR, ['rev-parse', 'HEAD']).trim()
}

/** Candidate sync: master を merge commit で取り込む（Candidate-only commit は到達可能なまま）。 */
function syncCandidateWithMaster(): string {
  git(['fetch', '-q', MASTER_DIR, 'master'])
  git(['merge', '-q', '--no-ff', '--no-edit', '-m', 'sync candidate with master', 'FETCH_HEAD'])
  return headCommit()
}

function ledgerState(dir: string, id: string): string | undefined {
  return getValidRoadmapItems(readAt(dir, LEDGER)).find((item) => item.id === id)?.state
}

function classify(projectId: string) {
  return Object.fromEntries(
    classifyAdoptionCandidates(env.storage, projectId, readAdoptionCandidates())
      .map((candidate) => [candidate.id, candidate.notAvailableReason ?? candidate.kind]),
  )
}

/** 1 tick 分の採用。proposer は提示された候補を記録し、`prefer` の順で最初に提示されたものを選ぶ。 */
async function adoptionTick(prefer: string[]) {
  const offered: string[] = []
  let calls = 0
  const tick = await env.plTick({
    proposeAdoption: async (_system: string, user: string) => {
      calls += 1
      offered.push(...user.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).split(' — ')[0]!))
      const chosen = prefer.find((id) => offered.includes(id)) ?? 'no-offered-candidate'
      return JSON.stringify({
        roadmapId: chosen, implementationScope: 'Only the files under docs/promo.', allowedPaths: ALLOWED,
        acceptanceCriteria: ['the document is updated'], rationale: 'small and safe',
      })
    },
  })
  return { tick, offered, calls }
}

async function currentTaskOf(projectId: string) {
  return (await env.systemState()).projects.find((p) => p.id === projectId)?.currentTask
}

function taskFor(projectId: string, key: string) {
  const task = env.storage.tasks.findByProjectId(projectId).find((candidate) => candidate.roadmapTaskKey === key)
  if (!task) throw new Error(`no Task for ${key}`)
  return task
}

function commitJobOf(taskId: string) {
  return env.jobsOf(taskId).filter((job) => job.safeCommand.kind === 'git_commit' && job.status === 'success').at(-1)!
}

async function runTaskToDone(taskId: string): Promise<string> {
  const steps = await env.worker.runUntilIdle()
  expect(steps.map((step) => [step.kind, step.reported])).toEqual([
    ['implement', 'success'], ['review', 'success'], ['git_commit', 'success'],
  ])
  expect(env.task(taskId).status).toBe('done')
  return commitJobOf(taskId).commitHash!
}

// ────────────────────────────────────────────────────────────

describe('P1: a Candidate completion awaiting promotion is not re-adopted, does not block the next item, and promotion retires it', () => {
  it('A done (Candidate only) → B adopted; stale ledger keeps A out; master promotion + Candidate sync retires A', async () => {
    env = await startLifecycle({ ledger: buildLedger([{ id: 'promo-a', title: 'Item A' }, { id: 'promo-b', title: 'Item B' }]) })
    createCanonicalMaster()
    const project = createRunningProject(env)
    env.adoptionAllowedPaths = ALLOWED

    // A: adopt → implement → review → git_commit (Safety Evidence path) → done, committed only in the Candidate.
    const taskA = await env.adoptNext(project.id, 'promo-a')
    const shaA = await runTaskToDone(taskA.id)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('candidate/self-dev')
    // Not on master: the canonical repo does not even have the object.
    expect(() => gitAt(MASTER_DIR, ['cat-file', '-e', `${shaA}^{commit}`])).toThrow()
    expect(ledgerState(LIFECYCLE_TARGET_DIR, 'promo-a')).toBe('planned')

    // A is awaiting promotion (predicate + audit once); B is fresh.
    expect(checkRoadmapCompletionAwaitingPromotion(env.storage, project.id, 'promo-a', new Set(['promo-a', 'promo-b'])))
      .toEqual([{ taskId: taskA.id, sourceJobId: commitJobOf(taskA.id).id, candidateCommitHash: shaA }])
    expect(classify(project.id)).toEqual({ 'promo-a': 'awaiting_promotion', 'promo-b': 'fresh' })

    // Every direct path to re-adopt A is refused by the authoritative seam.
    const spec = { projectId: project.id, roadmapId: 'promo-a', allowedPaths: ALLOWED, acceptanceCriteria: ['x'], implementationScope: 'more' }
    const followUp = await adoptRoadmapItem(env.storage, { ...spec, followUp: true })
    expect(followUp).toMatchObject({ ok: false, code: 'FOLLOW_UP_NOT_ELIGIBLE' })
    expect((followUp as { reason: string }).reason).toContain('awaiting promotion')
    expect(await adoptRoadmapItem(env.storage, spec)).toMatchObject({ ok: false, code: 'ALREADY_EXECUTED' })

    // Project occupancy released after A: no current Task, no pending continuation.
    expect(await currentTaskOf(project.id)).toBeUndefined()
    expect(env.storage.taskContinuations.findPendingByProjectId(project.id)).toEqual([])

    // PL tick with a proposer that would pick A first: A is not offered, B is adopted (A does not block the Project).
    const first = await adoptionTick(['promo-a', 'promo-b'])
    expect(first.offered).toEqual(['promo-b'])
    expect(first.tick).toMatchObject({ status: 'acted', proposedKind: 'adopt_roadmap_item' })
    const taskB = taskFor(project.id, 'promo-b')
    expect(env.jobsOf(taskB.id).map((job) => [job.workflowStepKey, job.status]))
      .toEqual([[`task:${taskB.id}:initial-implement`, 'queued']])
    expect(env.storage.tasks.findByProjectId(project.id).filter((t) => t.roadmapTaskKey?.startsWith('promo-a'))).toHaveLength(1)

    // Promotion lands A on master (ledger done there, roadmap:check OK) — but the Candidate is not synced yet.
    const masterAfterA = promoteToMaster([{ sha: shaA, roadmapId: 'promo-a' }])
    expect(ledgerState(MASTER_DIR, 'promo-a')).toBe('done')
    // The promoted content is A's Candidate commit, file for file.
    const filesA = git(['show', '--name-only', '--pretty=format:', shaA]).trim().split('\n')
    expect(filesA.length).toBeGreaterThan(0)
    for (const file of filesA) expect(readAt(MASTER_DIR, file)).toBe(git(['show', `${shaA}:${file}`]))

    // Stale ledger window: master says done, the Candidate ledger (what the PL reads) still says planned.
    // A stays out on DB evidence alone; B continues.
    expect(ledgerState(LIFECYCLE_TARGET_DIR, 'promo-a')).toBe('planned')
    expect(classify(project.id)['promo-a']).toBe('awaiting_promotion')
    const shaB = await runTaskToDone(taskB.id)
    // Occupancy released again after the second consecutive Task.
    expect(await currentTaskOf(project.id)).toBeUndefined()
    expect(env.storage.taskContinuations.findPendingByProjectId(project.id)).toEqual([])
    expect(classify(project.id)).toEqual({ 'promo-a': 'awaiting_promotion', 'promo-b': 'awaiting_promotion' })
    const idle = await adoptionTick(['promo-a', 'promo-b'])
    expect(idle.tick.status).toBe('idle')
    expect(idle.calls).toBe(0)
    expect(env.storage.auditLog.findByEntity('pl_loop_target', `adopt:${project.id}`)
      .filter((row) => (row.detail ?? '').startsWith('adoption=no_candidate code=awaiting_promotion'))).toHaveLength(1)

    // Candidate sync: the ledger change reaches the Candidate; A leaves the open set entirely.
    const syncedHead = syncCandidateWithMaster()
    expect(gitAt(LIFECYCLE_TARGET_DIR, ['merge-base', '--is-ancestor', masterAfterA, syncedHead])).toBe('')
    expect(ledgerState(LIFECYCLE_TARGET_DIR, 'promo-a')).toBe('done')
    expect(classify(project.id)).toEqual({ 'promo-b': 'awaiting_promotion' })
    expect(await adoptRoadmapItem(env.storage, spec)).toMatchObject({ ok: false, code: 'ITEM_ALREADY_DONE' })

    // Then B is promoted the same way; the ledger has no open item and the PL is plainly idle (not "awaiting").
    promoteToMaster([{ sha: shaB, roadmapId: 'promo-b' }])
    syncCandidateWithMaster()
    expect(readAdoptionCandidates()).toEqual([])
    const done = await adoptionTick(['promo-a', 'promo-b'])
    expect(done.tick.status).toBe('idle')
    expect(done.calls).toBe(0)
    expect(env.storage.tasks.findByProjectId(project.id).map((t) => [t.roadmapTaskKey, t.status]).sort())
      .toEqual([['promo-a', 'done'], ['promo-b', 'done']])
    expect(env.escalations).toEqual([])
    expect((await env.systemState()).attention).toEqual([])
  })

  /**
   * FINDING（設計どおりだが出口が無い）: awaiting-promotion predicate は DB だけで決まり、
   * ledger の state を見ない。「解除」は ledger が done になって open 集合から外れることによる
   * **マスク**であって、predicate 自体はいつまでも成立する（`reconcile_external_completion` audit が無い限り）。
   * よって promotion 後に同じ roadmap id を planned へ戻すと、その項目は恒久的に
   * `awaiting_promotion` となり、採用 seam も follow-up を拒否し続ける。運用ルール
   * 「promotion 後に id を planned へ戻さない（新しい scope は新しい id）」でしか防がれていない。
   */
  it('FINDING: reopening a promoted roadmap id to planned leaves it permanently awaiting promotion', async () => {
    env = await startLifecycle({ ledger: buildLedger([{ id: 'reopen-a', title: 'Item A' }]) })
    createCanonicalMaster()
    const project = createRunningProject(env)
    env.adoptionAllowedPaths = ALLOWED
    const taskA = await env.adoptNext(project.id, 'reopen-a')
    const shaA = await runTaskToDone(taskA.id)
    promoteToMaster([{ sha: shaA, roadmapId: 'reopen-a' }])
    syncCandidateWithMaster()
    expect(readAdoptionCandidates()).toEqual([])

    // Reopen the same id on the Candidate ledger (a convention violation, mechanically possible).
    const reopened = updateRoadmapState(readAt(LIFECYCLE_TARGET_DIR, LEDGER), 'reopen-a', 'planned').markdown
    writeFileSync(path.join(LIFECYCLE_TARGET_DIR, LEDGER), reopened)
    git(['commit', '-q', '-am', 'reopen reopen-a'])

    expect(classify(project.id)).toEqual({ 'reopen-a': 'awaiting_promotion' })
    const tick = await adoptionTick(['reopen-a'])
    expect(tick.tick.status).toBe('idle')
    expect(tick.calls).toBe(0)
    const followUp = await adoptRoadmapItem(env.storage, {
      projectId: project.id, roadmapId: 'reopen-a', allowedPaths: ALLOWED, acceptanceCriteria: ['x'],
      implementationScope: 'new scope', followUp: true,
    })
    expect(followUp).toMatchObject({ ok: false, code: 'FOLLOW_UP_NOT_ELIGIBLE' })
  })
})

describe('P2: a Candidate HEAD move while a git_commit approval is pending makes it STALE, with a visible exit', () => {
  it('Candidate sync during B\'s pending approval → approve → STALE → blocked + resume → fresh approval → B done', async () => {
    env = await startLifecycle({ ledger: buildLedger([{ id: 'stale-a', title: 'Item A' }, { id: 'stale-b', title: 'Item B' }]) })
    createCanonicalMaster()
    const project = createRunningProject(env)
    env.adoptionAllowedPaths = ALLOWED

    const taskA = await env.adoptNext(project.id, 'stale-a')
    const shaA = await runTaskToDone(taskA.id)

    // B: the review approves with a high-severity finding → git_commit Safety Evidence fails → Job-linked approval.
    env.worker.behaviors.review = () => ({
      kind: 'verdict',
      result: { status: 'approved', summary: 'ok with a caveat', findings: [{ severity: 'high', message: 'double-check wording' }] },
    })
    const first = await adoptionTick(['stale-a', 'stale-b'])
    expect(first.offered).toEqual(['stale-b'])
    const taskB = taskFor(project.id, 'stale-b')
    const blockedSteps = await env.worker.runUntilIdle()
    expect(blockedSteps.map((step) => [step.kind, step.reported])).toEqual([
      ['implement', 'success'], ['review', 'success'], ['git_commit', 'blocked'],
    ])
    const commitJob = env.jobsOf(taskB.id).find((job) => job.safeCommand.kind === 'git_commit')!
    const [approval] = env.storage.approvalRequests.findByTaskId(taskB.id)
    expect(approval).toMatchObject({ requestedAction: 'git_commit', status: 'WAITING_FOR_USER', targetCommit: shaA, targetBranch: 'candidate/self-dev' })
    const dirtyBefore = git(['status', '--porcelain']).trim()
    expect(dirtyBefore).not.toBe('')

    // Promotion of A + Candidate sync while B's approval is pending (the operating-sequence error of 2026-09-15).
    promoteToMaster([{ sha: shaA, roadmapId: 'stale-a' }])
    const movedHead = syncCandidateWithMaster()
    expect(movedHead).not.toBe(shaA)
    expect(git(['status', '--porcelain']).trim()).toBe(dirtyBefore)

    // The pending request still looks approvable: nothing re-checks the Candidate HEAD before the CEO decides.
    expect(env.storage.approvalRequests.findById(approval!.id)?.status).toBe('WAITING_FOR_USER')
    expect((await env.ceo.approve(approval!.id)).statusCode).toBe(200)
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('queued')

    // The requeued run hits the Gate with the new HEAD → STALE (re_check) → the Worker reports blocked; nothing committed.
    const staleRun = await env.worker.runUntilIdle()
    expect(staleRun.map((step) => [step.kind, step.reported, step.gate?.decision, step.gate?.nextAction]))
      .toEqual([['git_commit', 'blocked', 'STALE', 're_check']])
    expect(env.storage.approvalRequests.findById(approval!.id)?.status).toBe('STALE')
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('blocked')
    expect(headCommit()).toBe(movedHead)
    expect(env.task(taskB.id).status).not.toBe('done')

    // Visible exit: attention shows the blocked Job, and resume is admitted (Mobile's shared predicate).
    expect((await env.systemState()).attention.map((item) => item.kind)).toContain('job_blocked')
    expect((await env.mobileAdmission(taskB.id)).resume).toMatchObject({ ok: true })

    // Re-approving the dead request does nothing.
    expect((await env.ceo.approve(approval!.id)).statusCode).not.toBe(200)

    // Resume → new git_commit Job (no inherited approval) → the Gate mints a fresh approval bound to the new HEAD.
    const resumed = await env.ceo.resume(taskB.id)
    expect(resumed.statusCode, JSON.stringify(resumed.body)).toBeLessThan(300)
    await env.quiesce()
    const afterResume = await env.worker.runUntilIdle()
    expect(afterResume.at(-1)).toMatchObject({ kind: 'git_commit', reported: 'blocked' })
    const resumeJob = env.storage.jobs.findById(afterResume.at(-1)!.jobId)!
    expect(resumeJob.workflowStepKey).toBe(`resume:${commitJob.id}:1`)
    const fresh = env.storage.approvalRequests.findByTaskId(taskB.id).find((a) => a.id !== approval!.id)!
    expect(fresh).toMatchObject({ status: 'WAITING_FOR_USER', targetCommit: movedHead, targetBranch: 'candidate/self-dev' })
    expect(resumeJob.approvalId).toBe(fresh.id)

    // CEO approves the fresh request → consume → commit → B done (Human Approval path) → B awaiting promotion.
    expect((await env.ceo.approve(fresh.id)).statusCode).toBe(200)
    const committed = await env.worker.runUntilIdle()
    expect(committed.at(-1)).toMatchObject({ kind: 'git_commit', consumeStatus: 200, reported: 'success' })
    expect(env.task(taskB.id).status).toBe('done')
    expect(env.storage.approvalRequests.findById(fresh.id)?.status).toBe('CONSUMED')
    expect(git(['status', '--porcelain']).trim()).toBe('')
    expect(classify(project.id)).toEqual({ 'stale-b': 'awaiting_promotion' })
    expect(await currentTaskOf(project.id)).toBeUndefined()
  })
})
