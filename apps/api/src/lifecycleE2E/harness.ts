/**
 * Lifecycle E2E の共有 driver。
 *
 * ## 何が本物で、何が simulation か
 *
 * **本物**（production と同じコードが走る）:
 *   - Fastify の route 群（`index.ts` と同じ prefix で登録）と `apiTokenAuth()` の split credential
 *     （Worker は WORKER token、CEO 操作は ADMIN token。`WORKER_ALLOWLIST` も本物が効く）
 *   - SQLite storage（`resetStorage()` で毎回作り直す `:memory:`）
 *   - Approval Gate・git_commit Safety Evidence・resulting commit binding（本物の git worktree に対して）
 *   - Design Review coordinator / repair flow / continuation / PL loop（`runPlTick()`）
 *   - Worker 側の純関数: workspace baseline（`computeWorkspaceBaseline()`）、所有権判定
 *     （`resolveWorkspaceOwnership()`）、change manifest、Gate policy（`resolvePolicy()`）
 *
 * **simulation**（この driver が Worker / AI の代わりをする）:
 *   - Worker の poll / claim / gate / consume / 結果報告の **HTTP 手順**（`apps/worker/src/index.ts`
 *     の `fetchQueuedJob()` / `confirmRunningTransition()` / `persistTerminalUpdate()`、
 *     `jobRunner.ts` の Gate 部分と同じ順序・同じ payload 形）。AI CLI・SafeCommand・
 *     containment は実行しない
 *   - AI の出力: implement は scenario が決めたファイルを書くだけ、review は scenario が決めた
 *     structured verdict を返すだけ
 *   - Gate へ送る `targetDiffHash` は API と同じ `readCurrentWorktreeDiff()` で求める
 *     （Worker の `getWorktreeDiffText()` は非公開。production では両者の一致が前提）
 *   - Design Review runner の出力（`runnerStub.ts`）、PL の diagnose / adoption proposal / escalation 配達
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  canonicalizeJobUpdate,
  evaluateRecoverAdmission,
  evaluateResumeAdmission,
  runRiskReview,
  type ApprovalRequest,
  type Job,
  type Project,
  type ReviewResult,
  type Task,
  type TaskDetail,
} from '@ai-team/shared'
import { computeWorkspaceBaseline } from '@ai-team/worker/src/jobRunner.js'
import { resolveWorkspaceOwnership } from '@ai-team/worker/src/index.js'
import { buildWorktreeManifest } from '@ai-team/worker/src/guards/changeManifest.js'
import { resolvePolicy, SAFE_WORK_ALLOWED_COMMAND_KINDS } from '@ai-team/worker/src/guards/gatePolicy.js'
import { toGateDecision } from '@ai-team/worker/src/guards/safetyAuditor.js'
import type { GateCheckResponse } from '@ai-team/worker/src/guards/gateClient.js'
import type { IStorage } from '../storage/interface'
import type { PlEscalationChannelResult, PlLoopDeps, PlTickResult } from '../pl/executionLoop'
import { readCurrentWorktreeDiff } from '../approvalExplain/diffReader'
import { LIFECYCLE_TARGET_DIR, stubCoordinatorDeps } from './runnerStub'

// テスト専用の credential（このプロセス内でだけ hash 化して使う。production の値とは無関係）。
export const ADMIN_TOKEN = 'lifecycle-e2e-admin-credential'
export const WORKER_TOKEN = 'lifecycle-e2e-worker-credential'

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf-8').digest('hex')

export type Caller = 'admin' | 'worker'

export interface ApiResponse<T = unknown> {
  statusCode: number
  body: T
}

/** 小さな ledger を作る（`<!-- roadmap:id=... state=planned -->` 形式）。 */
export function buildLedger(items: ReadonlyArray<{ id: string; title: string; state?: string }>): string {
  const lines = ['# Roadmap', '']
  items.forEach((item, index) => {
    lines.push(`<!-- roadmap:id=${item.id} state=${item.state ?? 'planned'} -->`)
    lines.push(`${index + 1}. [ ] **${item.title}** — lifecycle e2e item ${item.id}`)
    lines.push('')
  })
  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────
// target worktree
// ────────────────────────────────────────────────────────────

export function git(args: string[], cwd: string = LIFECYCLE_TARGET_DIR): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function initTargetRepo(ledger: string): void {
  rmSync(LIFECYCLE_TARGET_DIR, { recursive: true, force: true })
  mkdirSync(LIFECYCLE_TARGET_DIR, { recursive: true })
  // production の Tier A Candidate と同じ branch（awaiting-promotion 判定はこの名前を見る）。
  git(['init', '-q', '-b', 'candidate/self-dev'])
  git(['config', 'user.email', 'lifecycle-e2e@example.invalid'])
  git(['config', 'user.name', 'lifecycle-e2e'])
  git(['config', 'core.autocrlf', 'false'])
  git(['config', 'commit.gpgsign', 'false'])
  mkdirSync(path.join(LIFECYCLE_TARGET_DIR, 'tasks'), { recursive: true })
  mkdirSync(path.join(LIFECYCLE_TARGET_DIR, 'docs', 'project_memory'), { recursive: true })
  writeFileSync(path.join(LIFECYCLE_TARGET_DIR, 'tasks', 'roadmap.md'), ledger)
  writeFileSync(path.join(LIFECYCLE_TARGET_DIR, 'docs', 'README.md'), '# docs\n')
  writeFileSync(path.join(LIFECYCLE_TARGET_DIR, 'docs', 'project_memory', 'goal.md'), '# Goal\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'initial'])
}

export function headCommit(): string {
  return git(['rev-parse', 'HEAD']).trim()
}

export function dirtyPaths(): string[] {
  return buildWorktreeManifest(LIFECYCLE_TARGET_DIR).paths
}

// ────────────────────────────────────────────────────────────
// Worker simulation
// ────────────────────────────────────────────────────────────

/** implement の AI 出力の代わり。 */
export type ImplementOutcome =
  | { kind: 'change'; files: Record<string, string> }
  | { kind: 'fail'; stderr: string; files?: Record<string, string> }
  /** containment が静止を証明できなかった（Worker は quarantine 付き blocked を報告する）。 */
  | { kind: 'quarantine'; reason: string; files?: Record<string, string> }

/** review の AI 出力の代わり。`unstructured` は structured result を返せずに終わった review。 */
export type ReviewOutcome =
  | { kind: 'verdict'; result: Pick<ReviewResult, 'status' | 'summary' | 'findings'> }
  | { kind: 'unstructured' }

export interface WorkerBehaviors {
  implement: (job: Job, task: Task) => ImplementOutcome
  review: (job: Job, task: Task) => ReviewOutcome
}

export const APPROVED_REVIEW: ReviewOutcome = {
  kind: 'verdict',
  result: { status: 'approved', summary: 'looks right', findings: [] },
}

export function changesRequested(message = 'please fix the wording'): ReviewOutcome {
  return {
    kind: 'verdict',
    result: { status: 'changes_requested', summary: 'needs changes', findings: [{ severity: 'medium', message }] },
  }
}

/** 既定の implement: Task の最初の allowedPath（ディレクトリならその下）へ 1 ファイル書く。 */
export function defaultImplement(job: Job, task: Task): ImplementOutcome {
  const allowed = task.allowedPaths?.[0] ?? 'docs'
  const target = /\.[a-z0-9]+$/i.test(allowed) ? allowed : `${allowed.replace(/\/$/, '')}/change-${job.id.slice(0, 8)}.md`
  return { kind: 'change', files: { [target]: `change by ${job.id}\n` } }
}

export interface WorkerStep {
  jobId: string
  taskId: string
  kind: string
  stepKey?: string
  /** claim の HTTP 応答（409 = JOB_CLAIM_REFUSED） */
  claimStatus?: number
  claimCode?: string
  gate?: { decision: string; policy: string; nextAction: string; requestId?: string }
  consumeStatus?: number
  /** Worker が報告した terminal status */
  reported?: Job['status']
  /** 結果 PATCH の HTTP 応答（503 = continuation 待ちで Outbox に残った） */
  reportStatus?: number
  /** 結果 PATCH が 2xx 以外だったときの error 本文 */
  reportError?: string
}

interface PendingOutbox {
  jobId: string
  payload: Record<string, unknown>
}

function withOutbox(payload: Record<string, unknown>, eventId: string = randomUUID()): Record<string, unknown> {
  return { ...payload, eventId, payloadHash: sha256(canonicalizeJobUpdate(payload)) }
}

function writeFiles(files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(LIFECYCLE_TARGET_DIR, relative)
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
}

/** `captureWorkspaceEndFingerprint()` と同じ形（clean なら HEAD のみ、dirty なら HEAD + entries）。 */
function endFingerprint(job: Job): Job['workspaceBaseline'] {
  const asDirty = { ...job, workflowStepKey: `repair:${job.id}:1` } as Job
  const result = computeWorkspaceBaseline(asDirty, LIFECYCLE_TARGET_DIR)
  if (!result.ok) throw new Error(`end fingerprint failed: ${result.reason}`)
  const baseline = result.baseline
  return baseline.mode === 'dirty' && baseline.entries.length === 0
    ? { mode: 'clean', startCommitHash: baseline.startCommitHash }
    : baseline
}

const ALLOWED_GUARD = { permissionAllowed: true, fileChangeAllowed: true, fileViolations: [] as string[] }

export class WorkerSimulator {
  behaviors: WorkerBehaviors = {
    implement: defaultImplement,
    review: () => APPROVED_REVIEW,
  }

  /** Worker の local Outbox（未配送の terminal 結果）。 */
  private pending: PendingOutbox | undefined

  /** 直前に配送した terminal 結果（Outbox event 付き）。重複配送の検証に使う。 */
  lastDelivery: PendingOutbox | undefined

  readonly steps: WorkerStep[] = []

  constructor(private readonly env: LifecycleEnv) {}

  /** `fetchQueuedJob()` と同じ: archived 以外の全 Project で所有権を判定し、running Project だけ claim する。 */
  async findQueuedWork(): Promise<{ job: Job; task: Task; jobs: Job[] } | null> {
    const projects = (await this.env.api<Project[]>('GET', '/api/projects', undefined, 'worker')).body
    const perTask: Array<{ task: Task; jobs: Job[] }> = []
    const claimable = new Set<string>()
    for (const project of projects) {
      if (project.status === 'archived') continue
      const tasks = (await this.env.api<Task[]>('GET', `/api/tasks?projectId=${project.id}`, undefined, 'worker')).body
      for (const task of tasks) {
        const jobs = (await this.env.api<Job[]>('GET', `/api/jobs?taskId=${task.id}`, undefined, 'worker')).body
        perTask.push({ task, jobs })
        if (project.status === 'running') claimable.add(task.id)
      }
    }
    const ownership = resolveWorkspaceOwnership(perTask, LIFECYCLE_TARGET_DIR)
    if (ownership.kind === 'ambiguous') return null
    for (const { task, jobs } of perTask) {
      if (ownership.kind === 'owner' && ownership.taskId !== task.id) continue
      if (!claimable.has(task.id)) continue
      const queued = jobs.find((job) => job.status === 'queued')
      if (queued) return { job: queued, task, jobs }
    }
    return null
  }

  /** Outbox に残った結果の再送（poll cycle の先頭で行う）。配送できたら true。 */
  async resendPending(): Promise<boolean> {
    if (!this.pending) return true
    const res = await this.env.api('PATCH', `/api/jobs/${this.pending.jobId}`, this.pending.payload, 'worker')
    if (res.statusCode >= 200 && res.statusCode < 300) {
      this.pending = undefined
      return true
    }
    return false
  }

  hasPendingOutbox(): boolean {
    return this.pending !== undefined
  }

  /**
   * poll 1 回分。Worker と同じく、Outbox に未配送があれば再送だけして queued Job は取らない。
   * 実行した Job があればその記録を返す。
   */
  async pollOnce(): Promise<WorkerStep | null> {
    // poll cycle の continuation 回収（Worker は 202 を受けて待たない）。
    await this.env.api('POST', '/api/task-continuations/reconcile', undefined, 'worker')
    await this.env.quiesce()
    if (this.pending) {
      await this.resendPending()
      await this.env.quiesce()
      return null
    }
    const work = await this.findQueuedWork()
    if (!work) return null
    const step = await this.process(work.job, work.task)
    this.steps.push(step)
    await this.env.quiesce()
    return step
  }

  /** queued Job が無くなるまで（または上限まで）poll する。 */
  async runUntilIdle(maxPolls = 25): Promise<WorkerStep[]> {
    const executed: WorkerStep[] = []
    for (let i = 0; i < maxPolls; i += 1) {
      const step = await this.pollOnce()
      if (step) {
        executed.push(step)
        continue
      }
      if (!this.pending) break
    }
    return executed
  }

  private async report(job: Job, payload: Record<string, unknown>, step: WorkerStep): Promise<void> {
    const delivery = withOutbox(payload)
    this.lastDelivery = { jobId: job.id, payload: delivery }
    const res = await this.env.api<{ error?: string }>('PATCH', `/api/jobs/${job.id}`, delivery, 'worker')
    step.reported = payload.status as Job['status']
    step.reportStatus = res.statusCode
    if (res.statusCode < 200 || res.statusCode >= 300) {
      if (res.statusCode !== 503 && res.body?.error !== undefined) step.reportError = res.body.error
      this.pending = { jobId: job.id, payload: delivery }
    }
  }

  private async process(job: Job, task: Task): Promise<WorkerStep> {
    const step: WorkerStep = {
      jobId: job.id,
      taskId: task.id,
      kind: job.aiCliMode ?? job.safeCommand.kind,
      ...(job.workflowStepKey !== undefined ? { stepKey: job.workflowStepKey } : {}),
    }

    // ── claim（`confirmRunningTransition()`）──
    const baseline = computeWorkspaceBaseline(job, LIFECYCLE_TARGET_DIR)
    if (!baseline.ok) {
      const initial = job.workflowStepKey === `task:${job.taskId}:initial-implement`
      await this.report(job, initial
        ? { status: 'failed', stderr: `workspace baseline failure: ${baseline.reason}`, completedAt: new Date().toISOString() }
        : {
            status: 'blocked',
            stderr: `workspace baseline failure: ${baseline.reason} (workspace quarantined; ownership retained)`,
            completedAt: new Date().toISOString(),
            failureMetadata: {
              kind: 'workspace_baseline_failure',
              workspaceState: 'unknown',
              quarantined: true,
              quarantineReason: `workspace baseline failure: ${baseline.reason}`,
            },
          }, step)
      return step
    }
    const claim = await this.env.api<{ code?: string }>('PATCH', `/api/jobs/${job.id}`, {
      status: 'running',
      startedAt: new Date().toISOString(),
      workspaceBaseline: baseline.baseline,
    }, 'worker')
    step.claimStatus = claim.statusCode
    if (claim.statusCode !== 200) {
      if (claim.body?.code !== undefined) step.claimCode = claim.body.code
      return step
    }
    const running = { ...job, workspaceBaseline: baseline.baseline } as Job
    // runJob の早期 return（Gate 停止・consume 失敗・Gate 技術障害）は fingerprint を返さず、
    // `persistJobResult()` は **poll で受け取った行の** `workspaceBaseline` を end fingerprint に使う
    // （claim で計算した baseline ではない）。新しい Job ならそれは undefined で、failureMetadata は送られない。
    const earlyEnd: Record<string, unknown> = job.workspaceBaseline !== undefined
      ? { failureMetadata: { workspaceEndFingerprint: job.workspaceBaseline } }
      : {}

    // ── Approval Gate（`jobRunner.ts` Step 3A / 3B）──
    const current = readCurrentWorktreeDiff(LIFECYCLE_TARGET_DIR)
    const changedFiles = dirtyPaths()
    const gateRes = await this.env.api<GateCheckResponse>('POST', '/api/gate/check', {
      jobId: job.id,
      taskId: job.taskId,
      requestedAction: job.safeCommand.kind,
      targetBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      targetCommit: current.headCommit,
      targetDiffHash: current.diffHash,
      changedFiles,
    }, 'worker')
    if (gateRes.statusCode !== 200) {
      await this.report(running, {
        status: 'failed',
        stderr: `Gate check could not be completed: HTTP ${gateRes.statusCode}`,
        completedAt: new Date().toISOString(),
        ...earlyEnd,
      }, step)
      return step
    }
    const check = gateRes.body
    const local = runRiskReview(changedFiles)
    const policy = resolvePolicy({
      finalRiskLevel: local.riskLevel,
      gateDecision: toGateDecision(local.riskLevel),
      auditRiskLevel: local.riskLevel,
      alignmentRiskLevel: 'LOW',
    }, check)
    step.gate = {
      decision: check.outcome.decision,
      policy: policy.policy,
      nextAction: check.nextAction.action,
      ...(check.approvalRequest?.id !== undefined ? { requestId: check.approvalRequest.id } : {}),
    }
    const blocked = (): Record<string, unknown> => ({
      status: 'blocked',
      guardResult: ALLOWED_GUARD,
      completedAt: new Date().toISOString(),
      ...earlyEnd,
    })
    if (policy.policy === 'block_until_approved' || policy.policy === 're_check') {
      await this.report(running, blocked(), step)
      return step
    }
    if (
      policy.policy === 'continue_safe_work_only'
      && !(SAFE_WORK_ALLOWED_COMMAND_KINDS as readonly string[]).includes(job.safeCommand.kind)
    ) {
      await this.report(running, blocked(), step)
      return step
    }
    if (check.nextAction.action === 'call_consume' && check.nextAction.consumedRequestId) {
      const consume = await this.env.api('POST', `/api/approval-requests/${check.nextAction.consumedRequestId}/consume`, {
        jobId: job.id,
        currentCommit: current.headCommit,
        currentDiffHash: current.diffHash,
      }, 'worker')
      step.consumeStatus = consume.statusCode
      if (consume.statusCode !== 200 && consume.statusCode !== 409) {
        await this.report(running, {
          status: 'failed',
          stderr: `Approval consume could not be completed: HTTP ${consume.statusCode}`,
          completedAt: new Date().toISOString(),
          ...earlyEnd,
        }, step)
        return step
      }
      if (consume.statusCode === 409 && (consume.body as { consumed?: boolean; jobId?: string }).jobId !== job.id) {
        await this.report(running, blocked(), step)
        return step
      }
    }

    // ── 実行（AI CLI / SafeCommand の代わり）──
    if (job.aiCliMode === 'implement') {
      const outcome = this.behaviors.implement(job, task)
      if (outcome.files) writeFiles(outcome.files)
      if (outcome.kind === 'quarantine') {
        // `quarantineRunningJob()` と同じ payload（containment / reconciliation が静止を証明できなかった）。
        const message = `workspace could not be proven quiescent: ${outcome.reason}`
        await this.report(running, {
          status: 'blocked',
          stderr: `${message} (workspace quarantined; ownership retained)`,
          completedAt: new Date().toISOString(),
          failureMetadata: {
            kind: 'workspace_containment_failure',
            workspaceState: 'unknown',
            quarantined: true,
            quarantineReason: message,
          },
        }, step)
        return step
      }
      const after = dirtyPaths()
      await this.report(running, outcome.kind === 'change'
        ? {
            status: 'success',
            exitCode: 0,
            stdout: 'implemented',
            changedFiles: after,
            guardResult: ALLOWED_GUARD,
            completedAt: new Date().toISOString(),
            failureMetadata: { workspaceEndFingerprint: endFingerprint(running) },
          }
        : {
            status: 'failed',
            exitCode: 1,
            stderr: outcome.stderr,
            changedFiles: after,
            guardResult: ALLOWED_GUARD,
            completedAt: new Date().toISOString(),
            failureMetadata: { workspaceEndFingerprint: endFingerprint(running) },
          }, step)
      return step
    }

    if (job.aiCliMode === 'review') {
      const outcome = this.behaviors.review(job, task)
      if (outcome.kind === 'unstructured') {
        await this.report(running, {
          status: 'failed',
          exitCode: 0,
          stderr: 'structured review output could not be parsed',
          changedFiles,
          guardResult: ALLOWED_GUARD,
          completedAt: new Date().toISOString(),
          failureMetadata: { workspaceEndFingerprint: endFingerprint(running) },
        }, step)
        return step
      }
      await this.report(running, {
        status: outcome.result.status === 'approved' ? 'success' : 'failed',
        exitCode: 0,
        stdout: outcome.result.summary,
        changedFiles,
        guardResult: ALLOWED_GUARD,
        completedAt: new Date().toISOString(),
        failureMetadata: { workspaceEndFingerprint: endFingerprint(running) },
        reviewResult: outcome.result,
      }, step)
      return step
    }

    if (job.safeCommand.kind === 'git_commit') {
      git(['add', '--', ...changedFiles])
      git(['commit', '-q', '-m', job.safeCommand.params?.commitMessage ?? 'lifecycle e2e commit'])
      const commitHash = headCommit()
      await this.report(running, {
        status: 'success',
        exitCode: 0,
        stdout: `committed ${commitHash}`,
        changedFiles,
        commitHash,
        guardResult: ALLOWED_GUARD,
        completedAt: new Date().toISOString(),
        failureMetadata: { workspaceEndFingerprint: { mode: 'clean', startCommitHash: commitHash } },
      }, step)
      return step
    }

    await this.report(running, {
      status: 'success',
      exitCode: 0,
      guardResult: ALLOWED_GUARD,
      completedAt: new Date().toISOString(),
      failureMetadata: { workspaceEndFingerprint: endFingerprint(running) },
    }, step)
    return step
  }
}

// ────────────────────────────────────────────────────────────
// CEO（ADMIN credential）操作
// ────────────────────────────────────────────────────────────

export class Ceo {
  constructor(private readonly env: LifecycleEnv) {}

  approve(approvalId: string): Promise<ApiResponse<ApprovalRequest & { error?: string }>> {
    return this.env.api('PATCH', `/api/approval-requests/${approvalId}/status`, { status: 'APPROVED' }, 'admin')
  }

  reject(approvalId: string, reason = 'not like this'): Promise<ApiResponse<ApprovalRequest>> {
    return this.env.api('PATCH', `/api/approval-requests/${approvalId}/status`, { status: 'REJECTED', reason }, 'admin')
  }

  resume(taskId: string, instruction = 'Continue the reviewed work.'): Promise<ApiResponse<Job & { code?: string; error?: string }>> {
    return this.env.api('POST', `/api/tasks/${taskId}/resume`, { instruction }, 'admin')
  }

  recover(taskId: string, reason = 'CEO recovers the stopped Task'): Promise<ApiResponse<{ code?: string }>> {
    return this.env.api('POST', `/api/tasks/${taskId}/recover`, { reason }, 'admin')
  }

  repairFromStoredReview(taskId: string, reviewJobId: string): Promise<ApiResponse<{ status?: string; code?: string; approvalRequestId?: string }>> {
    return this.env.api('POST', `/api/tasks/${taskId}/repair-from-stored-review`, { reviewJobId }, 'admin')
  }
}

// ────────────────────────────────────────────────────────────
// Mobile admission（Mobile と同じ GET 応答 → 同じ共有関数）
// ────────────────────────────────────────────────────────────

export interface MobileAdmission {
  resume: ReturnType<typeof evaluateResumeAdmission>
  recover: ReturnType<typeof evaluateRecoverAdmission>
}

// ────────────────────────────────────────────────────────────
// 環境
// ────────────────────────────────────────────────────────────

export interface StartOptions {
  ledger?: string
  /** file-backed DB にする（別 connection で lock を握るシナリオ用）。省略時は :memory:。 */
  dbPath?: string
}

export class LifecycleEnv {
  app!: FastifyInstance
  storage!: IStorage
  readonly worker: WorkerSimulator
  readonly ceo: Ceo
  readonly escalations: Array<{ title: string; body: string }> = []
  /** 採用 proposer が選ぶ roadmap id の優先順（提示された候補のうち最初に一致したもの）。 */
  adoptionPreference: string[] = []
  /** 採用提案の allowedPaths（PL Gate は 2 segment 以上を要求する）。 */
  adoptionAllowedPaths: string[] = ['docs/lifecycle']

  constructor() {
    this.worker = new WorkerSimulator(this)
    this.ceo = new Ceo(this)
  }

  async api<T = unknown>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, as: Caller = 'admin'): Promise<ApiResponse<T>> {
    const res = await this.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${as === 'admin' ? ADMIN_TOKEN : WORKER_TOKEN}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    })
    const text = res.body
    let body: unknown = text
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    return { statusCode: res.statusCode, body: body as T }
  }

  /** fire-and-forget の kick（Design Review / continuation）が落ち着くまで待つ。 */
  async quiesce(): Promise<void> {
    let calm = 0
    let lastSignature = ''
    for (let i = 0; i < 400 && calm < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const runs = this.storage.designReviewRuns
      const signature = JSON.stringify([
        this.storage.auditLog.findAll().length,
        this.storage.projects.findAll().flatMap((p) => this.storage.tasks.findByProjectId(p.id))
          .map((t) => [t.status, this.storage.jobs.findByTaskId(t.id).map((j) => j.status).join(','),
            runs.findLatestByTaskId(t.id)?.status ?? '-']),
      ])
      calm = signature === lastSignature ? calm + 1 : 0
      lastSignature = signature
    }
  }

  plDeps(overrides: Partial<PlLoopDeps> = {}): PlLoopDeps {
    return {
      diagnose: async () => JSON.stringify({ actionKind: 'escalate_to_ceo', rationale: 'lifecycle e2e: no diagnosis', riskLevel: 'LOW' }),
      escalate: async (payload): Promise<readonly PlEscalationChannelResult[]> => {
        this.escalations.push(payload)
        return [{ channel: 'line', success: true }]
      },
      proposeAdoption: async (_system: string, user: string) => {
        const chosen = this.adoptionPreference.find((id) => user.includes(id))
        return JSON.stringify({
          roadmapId: chosen ?? 'no-offered-candidate',
          implementationScope: 'Only the files under docs/.',
          allowedPaths: this.adoptionAllowedPaths,
          acceptanceCriteria: ['the document is updated'],
          rationale: 'small and safe',
        })
      },
      coordinatorDeps: stubCoordinatorDeps(),
      ...overrides,
    }
  }

  async plTick(overrides: Partial<PlLoopDeps> = {}): Promise<PlTickResult> {
    const { runPlTick } = await import('../pl/executionLoop.js')
    const result = await runPlTick(this.storage, this.plDeps(overrides))
    await this.quiesce()
    return result
  }


  /**
   * PL tick 1 回で次の Roadmap 項目を採用させ、その Task を返す（採用しなければ throw）。
   * 採用は本物の `adoptRoadmapItem()` → `createInitialImplementWorkflow()`（Design Review は stub runner）。
   */
  async adoptNext(projectId: string, roadmapId: string): Promise<Task> {
    this.adoptionPreference = [roadmapId, ...this.adoptionPreference.filter((id) => id !== roadmapId)]
    const tick = await this.plTick()
    if (tick.status !== 'acted' || tick.proposedKind !== 'adopt_roadmap_item') {
      throw new Error(`adoption tick did not adopt ${roadmapId}: ${JSON.stringify(tick)}`)
    }
    const task = this.storage.tasks.findByProjectId(projectId).find((candidate) => candidate.roadmapTaskKey === roadmapId)
    if (!task) throw new Error(`adopted Task for ${roadmapId} not found`)
    return task
  }
  async systemState() {
    const { buildSystemState } = await import('../state/systemState.js')
    return buildSystemState(this.storage)
  }

  /** Mobile が Task 画面で読む 3 つの応答から、Mobile と同じ共有関数で前提判定する。 */
  async mobileAdmission(taskId: string): Promise<MobileAdmission> {
    const task = (await this.api<TaskDetail>('GET', `/api/tasks/${taskId}`)).body
    const jobs = (await this.api<Job[]>('GET', `/api/jobs?taskId=${taskId}`)).body
    const approvals = (await this.api<ApprovalRequest[]>('GET', `/api/approval-requests?taskId=${taskId}`)).body
    // `apps/mobile/lib/taskWorkflow.ts` の `jobsInAdmissionOrder()` と同じ並び（createdAt 降順・安定）。
    const ordered = [...jobs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    const nowMs = Date.now()
    return {
      resume: evaluateResumeAdmission({
        taskStatus: task.status,
        parked: task.parked,
        projectStatus: task.projectStatus ?? undefined,
        jobs: ordered,
        approvals,
        nowMs,
      }),
      recover: evaluateRecoverAdmission({
        taskStatus: task.status,
        parked: task.parked,
        projectStatus: task.projectStatus,
        jobCount: jobs.length,
        approvals,
        nowMs,
      }),
    }
  }

  jobsOf(taskId: string): Job[] {
    return this.storage.jobs.findByTaskId(taskId)
  }

  task(taskId: string): Task {
    const task = this.storage.tasks.findById(taskId)
    if (!task) throw new Error(`task ${taskId} not found`)
    return task
  }

  async close(): Promise<void> {
    await this.app.close()
  }
}

/** 1 scenario 分の環境を作る（storage・worktree・route を毎回作り直す）。 */
export async function startLifecycle(options: StartOptions = {}): Promise<LifecycleEnv> {
  initTargetRepo(options.ledger ?? buildLedger([]))
  process.env.DB_PATH = options.dbPath ?? ':memory:'
  process.env.TARGET_ROOT = LIFECYCLE_TARGET_DIR
  process.env.ADMIN_TOKEN_SHA256 = sha256(ADMIN_TOKEN)
  process.env.WORKER_TOKEN_SHA256 = sha256(WORKER_TOKEN)
  delete process.env.API_TOKEN

  const [
    { resetStorage, getStorage },
    { apiTokenAuth },
    { projectRoutes },
    { systemStateRoutes },
    { approvalRoutes },
    { taskRoutes },
    { jobRoutes },
    { reviewRoutes, qaRoutes },
    { taskContinuationRoutes },
    { approvalGateRoutes },
    { resetPlLoopInFlightForTest },
  ] = await Promise.all([
    import('../storage/index.js'),
    import('../auth/apiToken.js'),
    import('../routes/projects.js'),
    import('../routes/systemState.js'),
    import('../routes/approvals.js'),
    import('../routes/tasks.js'),
    import('../routes/jobs.js'),
    import('../routes/reviews.js'),
    import('../routes/taskContinuations.js'),
    import('../routes/approvalGate.js'),
    import('../pl/executionLoop.js'),
  ])
  resetStorage()
  resetPlLoopInFlightForTest()

  const env = new LifecycleEnv()
  const app = Fastify()
  app.addHook('preHandler', async (req, reply): Promise<void> => {
    await apiTokenAuth(req, reply)
  })
  // `index.ts` と同じ prefix。
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(systemStateRoutes, { prefix: '/api' })
  app.register(approvalRoutes, { prefix: '/api' })
  app.register(taskRoutes, { prefix: '/api/tasks', resumeDesignReviewDeps: stubCoordinatorDeps() })
  app.register(jobRoutes, { prefix: '/api/jobs' })
  app.register(reviewRoutes, { prefix: '/api/reviews' })
  app.register(qaRoutes, { prefix: '/api/qa' })
  app.register(taskContinuationRoutes, { prefix: '/api' })
  app.register(approvalGateRoutes, { prefix: '/api', targetWorkingDir: LIFECYCLE_TARGET_DIR })
  await app.ready()
  env.app = app
  env.storage = getStorage()
  return env
}

/** running Project を 1 件作る（`ux_projects_single_running` のため同時に running は 1 件だけ）。 */
export function createRunningProject(env: LifecycleEnv, name = 'AIteamOS'): Project {
  return env.storage.projects.create({ name, goal: 'Run the AI team from a phone', designPhilosophy: [], status: 'running' })
}

export function removeTargetRepo(): void {
  rmSync(LIFECYCLE_TARGET_DIR, { recursive: true, force: true })
}

/** Worker の claim PATCH と同じ body（`confirmRunningTransition()`）。poll と claim の間の競合を作るときに使う。 */
export function claimBody(job: Job): Record<string, unknown> {
  const baseline = computeWorkspaceBaseline(job, LIFECYCLE_TARGET_DIR)
  if (!baseline.ok) throw new Error(`baseline failed: ${baseline.reason}`)
  return { status: 'running', startedAt: new Date().toISOString(), workspaceBaseline: baseline.baseline }
}
