/**
 * Real-Worker lifecycle E2E driver (test-only).
 *
 * `harness.ts` drives the real API but **simulates** the Worker (`WorkerSimulator`). This driver instead runs
 * the **real Worker process loop** — `start()` from `apps/worker/src/index.ts`, i.e. startup Outbox replay →
 * startup recovery → the real `pollJobs()` loop (`reconcileSupervisedRuns` / `reconcileTaskContinuations` /
 * Outbox resend / abort-cleanup reporting / `fetchQueuedJob` / `processQueuedWork` → `runJob` →
 * `persistJobResult` → `cleanupEscalatedWorkspace`) — against the real Fastify API listening on a localhost
 * port, over real HTTP with split credentials generated in-test.
 *
 * ## What is real
 *   - API: Fastify routes (same prefixes as `index.ts`, plus permission-grant and supervised-run routes the
 *     Worker calls), `apiTokenAuth()` split credentials + `WORKER_ALLOWLIST`, SQLite storage (`:memory:`),
 *     Approval Gate / Safety Evidence / consume / resulting-commit binding, repair flow, continuation,
 *     PL loop (`runPlTick()`), Design Review coordinator (only the runner process output is stubbed).
 *   - Worker: the whole `start()` / `pollJobs()` loop, claim + workspace baseline, Permission Guard with grants
 *     (HTTP), Gate check + consume (HTTP, `gateClient.ts`), `resolvePolicy()`, the real AI CLI adapter
 *     (`ClaudeCodeAdapter` argv building, secret scan, constitution overlay, JSON parsing), change manifests,
 *     File Change Guard, git_commit staging (`stageApprovedPaths` / index verification) and the real
 *     `git commit` SafeCommand, final inspection, durable SQLite Outbox, `cleanupEscalatedWorkspace()`.
 *   - git: a real temporary repository (`LIFECYCLE_TARGET_DIR`).
 *
 * ## What is simulated (and why)
 *   - **Containment** (`runContainedCommand.ts`): cgroups do not exist on Windows. The existing test bridge
 *     (`containedCommandTestBridge.ts`) forwards each contained command to `execFileSync`. On top of it,
 *     `installCommandStubs()` routes:
 *       - the AI CLI process (attempt id `ai-cli-*`) → a deterministic stub that writes files / prints a
 *         Claude Code JSON envelope (no LLM is ever called);
 *       - the target project's `pnpm test` SafeCommand → a stub "tests passed" (the temp repo has no project);
 *       - `git …` → real git through the bridge.
 *   - **`TARGET_ROOT`** (`utils/pathUtils.ts`) is a hard-coded `/workspace/target`; the test file mocks the
 *     module so `TARGET_ROOT` / `isInsideTargetRoot()` point at the temp repo (same realpath algorithm).
 *   - Observation-only LLM reviewers (`runStepReview`, `runPostReview`), the notifier (`sendAlert`, captured)
 *     and the watchdog are stubbed in the test file.
 *   - A Worker **restart** is emulated in-process: the old loop is frozen at its next network call (an
 *     AsyncLocalStorage generation id gates `fetch`), the documented in-process state is cleared
 *     (`clearPendingAbortCleanupSubmissions()`), and a new `start()` runs. The Outbox is the real on-disk SQLite
 *     file, so the replay reads durable state; modules are not re-evaluated.
 *   - Design Review runner output (`runnerStub.ts`) and the PL LLM calls (`LifecycleEnv.plDeps()`).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import type { Job, ReviewResult } from '@ai-team/shared'
import {
  clearContainedCommandOverride,
  forwardToExecFileSync,
  setContainedCommandOverride,
  type ExecFileSyncLike,
} from '@ai-team/worker/src/execution/containedCommandTestBridge.js'
import type { ContainedResult, RunContainedCommandOptions } from '@ai-team/worker/src/execution/runContainedCommand.js'
import { LifecycleEnv, startLifecycle, type StartOptions } from './harness'
import { LIFECYCLE_TARGET_DIR, stubCoordinatorDeps } from './runnerStub'

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf-8').digest('hex')

// ────────────────────────────────────────────────────────────
// network guard: localhost only, per-generation freeze, fault injection
// ────────────────────────────────────────────────────────────

const workerContext = new AsyncLocalStorage<{ generation: number }>()
const frozenGenerations = new Set<number>()

export interface NetworkCall {
  generation: number | undefined
  method: string
  path: string
  status: number
  body?: string
}

export interface NetworkGuard {
  readonly calls: NetworkCall[]
  /** Return a status to fail a Worker request without it reaching the API (outage injection). */
  failWith: ((method: string, path: string, body: string | undefined) => number | undefined) | undefined
  restore(): void
}

/**
 * Wraps the global `fetch` for the whole test process:
 * - refuses any host other than the test API (no network beyond localhost);
 * - a frozen Worker generation never gets a response (its loop is dead from then on);
 * - optional fault injection for Worker-originated requests only.
 */
export function installNetworkGuard(apiBase: string): NetworkGuard {
  const original = globalThis.fetch
  const allowed = new URL(apiBase)
  const guard: NetworkGuard = {
    calls: [],
    failWith: undefined,
    restore: () => {
      globalThis.fetch = original
    },
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.host !== allowed.host) {
      throw new Error(`real-worker e2e: refused network access to ${url.host}`)
    }
    const generation = workerContext.getStore()?.generation
    if (generation !== undefined && frozenGenerations.has(generation)) {
      return new Promise<Response>(() => { /* the frozen Worker never continues */ })
    }
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? init.body : undefined
    if (generation !== undefined) {
      const injected = guard.failWith?.(method, url.pathname, body)
      if (injected !== undefined) {
        guard.calls.push({ generation, method, path: url.pathname, status: injected, ...(body ? { body } : {}) })
        return new Response(JSON.stringify({ error: 'simulated outage' }), { status: injected })
      }
    }
    const res = await original(input, init)
    if (generation !== undefined) {
      guard.calls.push({ generation, method, path: url.pathname, status: res.status, ...(body ? { body } : {}) })
    }
    return res
  }) as typeof fetch
  return guard
}

// ────────────────────────────────────────────────────────────
// AI CLI / SafeCommand stubs (below the real adapter, at the containment seam)
// ────────────────────────────────────────────────────────────

export type ReviewVerdict = Pick<ReviewResult, 'status' | 'summary' | 'findings'>

export interface ImplementScript {
  files: Record<string, string>
  /** Non-zero = the AI CLI process failed after writing `files`. */
  exitCode?: number
}

export interface AiBehaviors {
  implement: (job: Job) => ImplementScript
  review: (job: Job) => ReviewVerdict
}

export const APPROVED: ReviewVerdict = { status: 'approved', summary: 'looks right', findings: [] }

export interface CommandLog {
  jobId: string
  attemptId: string
  kind: 'ai-cli' | 'safe-command-stub' | 'git' | 'unexpected'
  argv0: string
  mode?: string
}

function contained(exitCode: number, stdout: string, stderr = ''): ContainedResult {
  return {
    outcome: 'clean',
    signal: null,
    killedDescendants: false,
    drainMs: 0,
    exitCode,
    stdout,
    stderr,
    timedOut: false,
  } as ContainedResult
}

/**
 * Routes contained commands: AI CLI → deterministic stub, target `pnpm …` → stub success, git → real git.
 * Anything else is recorded as unexpected and fails (exit 127) so a test can assert there were none.
 */
export function installCommandStubs(
  findJob: (jobId: string) => Job | undefined,
  behaviors: () => AiBehaviors,
): { log: CommandLog[]; restore(): void } {
  const log: CommandLog[] = []
  setContainedCommandOverride(async (raw) => {
    const options = raw as RunContainedCommandOptions
    const argv0 = options.argv[0] ?? ''
    if (options.attemptId.startsWith('ai-cli')) {
      const job = findJob(options.jobId)
      log.push({ jobId: options.jobId, attemptId: options.attemptId, kind: 'ai-cli', argv0, mode: job?.aiCliMode })
      if (!job) return contained(127, '', `stub: unknown job ${options.jobId}`)
      if (job.aiCliMode === 'implement') {
        const script = behaviors().implement(job)
        for (const [relative, content] of Object.entries(script.files)) {
          const absolute = path.join(options.cwd, relative)
          mkdirSync(path.dirname(absolute), { recursive: true })
          writeFileSync(absolute, content)
        }
        const exitCode = script.exitCode ?? 0
        const envelope = { type: 'result', subtype: 'success', is_error: exitCode !== 0, result: 'stub implement done', permission_denials: [] }
        return contained(exitCode, JSON.stringify(envelope), exitCode === 0 ? '' : 'stub: implement process failed')
      }
      if (job.aiCliMode === 'review') {
        const verdict = behaviors().review(job)
        const envelope = { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(verdict) }
        return contained(0, JSON.stringify(envelope))
      }
      return contained(127, '', `stub: unsupported mode ${job.aiCliMode}`)
    }
    if (argv0 === 'git') {
      log.push({ jobId: options.jobId, attemptId: options.attemptId, kind: 'git', argv0 })
      return forwardToExecFileSync(execFileSync as unknown as ExecFileSyncLike, options)
    }
    if (options.attemptId.startsWith('safe-command') && argv0 === 'pnpm') {
      log.push({ jobId: options.jobId, attemptId: options.attemptId, kind: 'safe-command-stub', argv0 })
      return contained(0, 'stub: target project tests passed\n')
    }
    log.push({ jobId: options.jobId, attemptId: options.attemptId, kind: 'unexpected', argv0 })
    return contained(127, '', `stub: unexpected contained command ${argv0}`)
  })
  return { log, restore: clearContainedCommandOverride }
}

// ────────────────────────────────────────────────────────────
// Worker process generations
// ────────────────────────────────────────────────────────────

export interface WorkerProcess {
  generation: number
  /** Freeze the loop at its next network call (process death). */
  kill(): Promise<void>
}

let generationCounter = 0

/**
 * Boots one Worker "process": the real `start()` (startup Outbox replay → startup recovery → `pollJobs()`).
 * `pollJobs()` never returns; `kill()` freezes it.
 */
export async function bootWorker(): Promise<WorkerProcess> {
  const worker = await import('@ai-team/worker/src/index.js')
  // A real restart loses the in-process abort-cleanup resubmission map (documented residual in index.ts).
  worker.clearPendingAbortCleanupSubmissions()
  generationCounter += 1
  const generation = generationCounter
  void workerContext.run({ generation }, () => worker.start()).catch((err: unknown) => {
    console.error(`[real-worker e2e] worker generation ${generation} crashed: ${String(err)}`)
  })
  return {
    generation,
    kill: async () => {
      frozenGenerations.add(generation)
      // Let any request already in flight settle into its next (frozen) network call.
      await new Promise((resolve) => setTimeout(resolve, 400))
    },
  }
}

// ────────────────────────────────────────────────────────────
// API on a real localhost port
// ────────────────────────────────────────────────────────────

export interface HttpResponse<T = unknown> {
  status: number
  body: T
}

export interface RealWorkerEnv {
  env: LifecycleEnv
  /** CEO / ADMIN call over real HTTP. */
  admin<T = unknown>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<HttpResponse<T>>
  close(): Promise<void>
}

/**
 * Same storage / worktree setup as `startLifecycle()`, but the API listens on `apiBase` (the port the Worker
 * module read at import time) with freshly generated ADMIN / WORKER credentials. The Worker authenticates with
 * `API_TOKEN` = the WORKER credential, exactly as in production.
 */
export async function startRealWorkerApi(apiBase: string, options: StartOptions = {}): Promise<RealWorkerEnv> {
  const env = await startLifecycle(options)
  await env.app.close()

  const adminToken = randomBytes(24).toString('hex')
  const workerToken = randomBytes(24).toString('hex')
  process.env.ADMIN_TOKEN_SHA256 = sha256(adminToken)
  process.env.WORKER_TOKEN_SHA256 = sha256(workerToken)
  process.env.API_TOKEN = workerToken

  const [
    { apiTokenAuth },
    { projectRoutes },
    { systemStateRoutes },
    { approvalRoutes },
    { taskRoutes },
    { jobRoutes },
    { reviewRoutes, qaRoutes },
    { taskContinuationRoutes },
    { approvalGateRoutes },
    { permissionGrantRoutes },
    { supervisedRunRoutes },
  ] = await Promise.all([
    import('../auth/apiToken.js'),
    import('../routes/projects.js'),
    import('../routes/systemState.js'),
    import('../routes/approvals.js'),
    import('../routes/tasks.js'),
    import('../routes/jobs.js'),
    import('../routes/reviews.js'),
    import('../routes/taskContinuations.js'),
    import('../routes/approvalGate.js'),
    import('../routes/permissionGrants.js'),
    import('../routes/supervisedRuns.js'),
  ])
  const app = Fastify()
  app.addHook('preHandler', async (req, reply): Promise<void> => {
    await apiTokenAuth(req, reply)
  })
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(systemStateRoutes, { prefix: '/api' })
  app.register(approvalRoutes, { prefix: '/api' })
  app.register(taskRoutes, { prefix: '/api/tasks', resumeDesignReviewDeps: stubCoordinatorDeps() })
  app.register(jobRoutes, { prefix: '/api/jobs' })
  app.register(reviewRoutes, { prefix: '/api/reviews' })
  app.register(qaRoutes, { prefix: '/api/qa' })
  app.register(permissionGrantRoutes, { prefix: '/api' })
  app.register(supervisedRunRoutes, { prefix: '/api' })
  app.register(taskContinuationRoutes, { prefix: '/api' })
  app.register(approvalGateRoutes, { prefix: '/api', targetWorkingDir: LIFECYCLE_TARGET_DIR })
  const url = new URL(apiBase)
  await app.listen({ host: url.hostname, port: Number(url.port) })
  env.app = app

  return {
    env,
    async admin<T>(method: 'GET' | 'POST' | 'PATCH', route: string, payload?: unknown): Promise<HttpResponse<T>> {
      const res = await fetch(`${apiBase}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${adminToken}`,
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      })
      const text = await res.text()
      let body: unknown = text
      try {
        body = text.length > 0 ? JSON.parse(text) : undefined
      } catch {
        body = text
      }
      return { status: res.status, body: body as T }
    },
    close: () => app.close(),
  }
}

// ────────────────────────────────────────────────────────────
// waiting
// ────────────────────────────────────────────────────────────

export async function waitFor(
  check: () => boolean,
  describe: () => string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting: ${describe()}`)
}

/** `[stepKey-with-ids-normalized, status]` for every Job of a Task, oldest first. */
export function jobTrail(env: LifecycleEnv, taskId: string): string[][] {
  // `findByTaskId()` returns newest first (same as harness.ts `stepKeysOf()`).
  return env.storage.jobs.findByTaskId(taskId)
    .slice()
    .reverse()
    .map((job) => [(job.workflowStepKey ?? '-').replace(/[0-9a-f-]{36}/g, '<id>'), job.status])
}

export function git(args: string[]): string {
  return execFileSync('git', args, { cwd: LIFECYCLE_TARGET_DIR, encoding: 'utf-8' })
}
