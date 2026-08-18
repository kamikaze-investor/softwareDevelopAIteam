/**
 * Design Review の実行調整（Control Plane側）。
 *
 * 権限分離の要点:
 *   - runner は「レビューを実行して raw result を返す」だけの実行者である
 *   - decision の確定・evidence登録・Job作成は API がここで行う authority である
 *   - runner が返した finalDecision は採用しない。APIが決定論的に再計算する
 *
 * Recovery は次だけで構成し、GET/read経路に副作用を持たせない:
 *   1. run作成時に即claim / runner kick
 *   2. child exit / timeout / coordinator error をその場で requeue / failed へ遷移
 *   3. claim_token による stale completion fencing
 *   4. bounded attempt 超過で failed 終端
 *   5. API process crash時のみ startup sweep で stale running を回収し再kick
 * 新しい scheduler / cron / background framework は導入しない。
 */

import { spawn } from 'node:child_process'
import { classifyReviewLoad } from '@ai-team/worker/src/approvalLevel/reviewLoadClassifier.js'
import { selectFocuses } from '@ai-team/worker/src/approvalLevel/focusSelector.js'
// 判定ロジックは @ai-team/shared の pure 実装を使う。
// worker側 strategicReview.ts は geminiRouter（CLI spawn）や reviewerAdapter（codex CLI）を
// 芋づるでimportするため、APIからimportするとWorkerのprovider/CLI機構がAPI runtimeへ入る。
import {
  applyIndependentReviewOverride,
  resolveFinalDecision,
  type DesignReviewEvidence,
} from '@ai-team/shared'
import type { IStorage, DesignReviewRun } from '../storage/interface'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'

/** bounded attempt。超過したrunはrequeueせずfailedで終端する。 */
export const DESIGN_REVIEW_MAX_ATTEMPTS = 3

/** runner の実行上限。既存 JOB_TIMEOUT_MS と同値に揃える。 */
export const DESIGN_REVIEW_RUNNER_TIMEOUT_MS = 120_000

/** SIGTERMを無視するchildを確実に終わらせるための猶予。 */
export const DESIGN_REVIEW_RUNNER_SIGKILL_GRACE_MS = 5_000

/** runner出力の上限。超過した時点でchildを止め、APIプロセスのメモリを守る。 */
export const DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES = 10 * 1024 * 1024

/** reviewerAdapter が返し得る verdict の全集合。 */
const INDEPENDENT_REVIEW_VERDICTS = ['approved', 'changes_requested', 'blocking'] as const

/**
 * runner へ渡す env。
 *
 * process.env を継承させず、ここで列挙したキーだけを渡す。
 * API_TOKEN / ADMIN_TOKEN_SHA256 / WORKER_TOKEN_SHA256 / OPENCODE_GO_API_KEY は渡さない。
 * reviewer credential も渡さない（runner が .env から allowlist 経由で自力取得する）。
 * 既存 aiExplain/cheapAiClient.ts の buildSubprocessEnv と同じ方針である。
 */
export function buildRunnerEnv(homeDirectory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    LANG: process.env.LANG ?? 'C.UTF-8',
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  }
}

export interface RawStrategicResult {
  reviewLoad?: unknown
  selectedFocuses?: unknown
  focusedReviewResults?: unknown
  integrationReviewResult?: unknown
  independentReviewResult?: unknown
  finalDecision?: unknown
}

export type RecomputedDecision = 'ALIGNED' | 'CONFLICT' | 'UNCERTAIN' | 'REVIEW_UNAVAILABLE'

export interface RecomputeOutcome {
  decision: RecomputedDecision
  reviewLoad: string
  independentReviewRequired: boolean
  independentReviewVerdict?: string
  rejectedReason?: string
}

function isFocusResultArray(value: unknown): value is Array<{ focus: string; decision: string }> {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { focus?: unknown }).focus === 'string' &&
        typeof (item as { decision?: unknown }).decision === 'string',
    )
  )
}

/**
 * runner の自己申告に依存せず、APIが決定論的に判定を再計算する。
 *
 * 再計算する（=runnerの申告を採用しない）もの:
 *   - reviewLoad         … changedFiles から classifyReviewLoad で再計算
 *   - selectedFocuses    … reviewLoad + changedFiles から selectFocuses で再計算
 *   - finalDecision      … resolveFinalDecision + applyIndependentReviewOverride で再計算
 *
 * 構造検証で不採用にするもの:
 *   - 再計算した focus 集合と runner の focusedReviewResults が一致しない場合
 *   - critical なのに independentReviewResult が欠落している場合
 *
 * 残存リスク（本実装で解消したと主張しないもの）:
 *   各focusのdecision・integrationのdecision・independent reviewのverdict自体は
 *   LLM/実行者の自己申告である。APIはその内容の真偽を検証できない。これは既存の
 *   手動design review運用と同一の残存リスクであり、本実装で悪化はしないが解消もしない。
 */
export function recomputeDecision(raw: RawStrategicResult, changedFiles: string[]): RecomputeOutcome {
  const classification = classifyReviewLoad({ changedFiles })
  const reviewLoad = classification.reviewLoad
  const expectedFocuses = selectFocuses(reviewLoad, changedFiles)
  const independentReviewRequired = reviewLoad === 'critical'

  const reject = (rejectedReason: string): RecomputeOutcome => ({
    decision: 'UNCERTAIN',
    reviewLoad,
    independentReviewRequired,
    rejectedReason,
  })

  if (!isFocusResultArray(raw.focusedReviewResults)) {
    return reject('focusedReviewResults has invalid shape')
  }

  const reportedFocuses = raw.focusedReviewResults.map((item) => item.focus)
  const focusSetMatches =
    reportedFocuses.length === expectedFocuses.length &&
    expectedFocuses.every((focus) => reportedFocuses.includes(focus))

  // low load でも selectFocuses は [] を返すため、例外を設けず常に集合一致を要求する。
  if (!focusSetMatches) {
    return reject(
      `focus set mismatch: expected [${expectedFocuses.join(',')}] but runner reported [${reportedFocuses.join(',')}]`,
    )
  }

  const independent = raw.independentReviewResult as
    | { verdict?: string; unavailable?: boolean }
    | undefined

  if (independentReviewRequired && (!independent || typeof independent.verdict !== 'string')) {
    return reject('critical review load requires an independent review result')
  }

  // verdict は reviewerAdapter の定義値のみ受理する。未知の文字列をそのまま evidence へ
  // 保存すると、decisionはALIGNEDなのにJob Gate（independentReviewVerdict === 'approved'）が
  // 恒久的に落ちる不整合状態になるため、ここで弾く。
  if (independent && !INDEPENDENT_REVIEW_VERDICTS.includes(independent.verdict as never)) {
    return reject(`unknown independent review verdict: ${String(independent.verdict)}`)
  }

  const integration = raw.integrationReviewResult as { decision?: string } | undefined

  let decision: RecomputedDecision = resolveFinalDecision(
    raw.focusedReviewResults as never,
    integration as never,
  )

  if (independentReviewRequired && independent) {
    decision = applyIndependentReviewOverride(decision, independent as never) as RecomputedDecision
  }

  return {
    decision,
    reviewLoad,
    independentReviewRequired,
    independentReviewVerdict: independent?.verdict,
  }
}

export interface RunnerExecution {
  ok: boolean
  stdout: string
  error?: string
  timedOut: boolean
}

export interface CoordinatorDeps {
  runnerCommand: string
  runnerArgs: string[]
  homeDirectory: string
  workingDir: string
  /** テストで差し替えるための実行フック。既定は restricted env での spawn。 */
  execute?: (input: string) => Promise<RunnerExecution>
  timeoutMs?: number
}

export function executeRunner(deps: CoordinatorDeps, input: string): Promise<RunnerExecution> {
  const timeoutMs = deps.timeoutMs ?? DESIGN_REVIEW_RUNNER_TIMEOUT_MS

  return new Promise<RunnerExecution>((resolvePromise) => {
    const child = spawn(deps.runnerCommand, deps.runnerArgs, {
      env: buildRunnerEnv(deps.homeDirectory),
      cwd: deps.workingDir,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let overflowed = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    /**
     * SIGTERMを無視するchildでもPromiseが宙吊りにならないよう、SIGKILLへ必ず昇格させ、
     * さらにその猶予後には close を待たずに settle する。
     */
    const terminate = (execution: RunnerExecution): void => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
        settle(execution)
      }, DESIGN_REVIEW_RUNNER_SIGKILL_GRACE_MS)
    }

    const settle = (execution: RunnerExecution): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolvePromise(execution)
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminate({ ok: false, stdout, error: `runner timed out after ${timeoutMs}ms`, timedOut: true })
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      if (overflowed) return
      stdout += chunk.toString('utf-8')
      if (Buffer.byteLength(stdout, 'utf-8') > DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES) {
        overflowed = true
        stdout = ''
        terminate({
          ok: false,
          stdout: '',
          error: `runner output exceeded ${DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES} bytes`,
          timedOut: false,
        })
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (overflowed) return
      if (Buffer.byteLength(stderr, 'utf-8') <= DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES) {
        stderr += chunk.toString('utf-8')
      }
    })

    child.on('error', (err) => {
      settle({ ok: false, stdout, error: `spawn failed: ${err.message}`, timedOut })
    })

    child.on('close', (code) => {
      if (timedOut) {
        settle({ ok: false, stdout, error: `runner timed out after ${timeoutMs}ms`, timedOut: true })
        return
      }
      if (overflowed) {
        settle({
          ok: false,
          stdout: '',
          error: `runner output exceeded ${DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES} bytes`,
          timedOut: false,
        })
        return
      }
      if (code !== 0) {
        settle({ ok: false, stdout, error: `runner exited with code ${code}: ${stderr.trim()}`, timedOut: false })
        return
      }
      settle({ ok: true, stdout, timedOut: false })
    })

    // spawn失敗時などに stdin への書き込みが EPIPE を投げてプロセスを落とさないようにする。
    child.stdin.on('error', () => {
      /* child側で既に終了している場合は 'error' / 'close' 側で settle される */
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

export interface ExecuteDesignReviewResult {
  status: 'evidence_registered' | 'not_aligned' | 'requeued' | 'failed' | 'not_claimable' | 'stale'
  decision?: RecomputedDecision
  evidence?: DesignReviewEvidence
  error?: string
}

/**
 * 1回のattemptを実行する。claim → runner実行 → 判定再計算 → 終端まで、
 * 失敗経路も含めてこの関数内で必ずrunの状態を確定させる（runningのまま放置しない）。
 */
export async function executeDesignReviewRun(
  storage: IStorage,
  run: DesignReviewRun,
  deps: CoordinatorDeps,
): Promise<ExecuteDesignReviewResult> {
  const changedFiles = run.changedFiles
  const taskTitle = run.taskTitle

  const claimed = storage.designReviewRuns.claim(run.id, DESIGN_REVIEW_MAX_ATTEMPTS)
  if (!claimed.run || !claimed.claimToken) {
    return { status: 'not_claimable' }
  }

  const claimToken = claimed.claimToken
  const runnerInput = JSON.stringify({
    taskId: run.taskId,
    taskTitle,
    designText: run.designText,
    changedFiles,
    workingDir: deps.workingDir,
  })

  let execution: RunnerExecution
  try {
    execution = deps.execute ? await deps.execute(runnerInput) : await executeRunner(deps, runnerInput)
  } catch (err) {
    execution = {
      ok: false,
      stdout: '',
      error: `coordinator error: ${err instanceof Error ? err.message : String(err)}`,
      timedOut: false,
    }
  }

  if (!execution.ok) {
    return finalizeFailure(storage, claimed.run, claimToken, execution.error ?? 'runner failed')
  }

  let raw: RawStrategicResult
  try {
    raw = JSON.parse(execution.stdout) as RawStrategicResult
  } catch {
    return finalizeFailure(storage, claimed.run, claimToken, 'runner returned unparsable output')
  }

  const outcome = recomputeDecision(raw, changedFiles)

  if (outcome.decision !== 'ALIGNED') {
    const fenced = storage.designReviewRuns.complete(
      run.id,
      claimToken,
      'succeeded',
      execution.stdout,
      outcome.rejectedReason,
    )
    if (!fenced) {
      return { status: 'stale' }
    }
    return { status: 'not_aligned', decision: outcome.decision, error: outcome.rejectedReason }
  }

  const evidence = storage.designReviewRuns.completeWithEvidence(run.id, claimToken, execution.stdout, {
    taskId: run.taskId,
    designTextHash: run.designTextHash,
    reviewLoad: outcome.reviewLoad as DesignReviewEvidence['reviewLoad'],
    decision: 'ALIGNED',
    independentReviewRequired: outcome.independentReviewRequired,
    independentReviewVerdict: outcome.independentReviewVerdict as DesignReviewEvidence['independentReviewVerdict'],
  })

  if (!evidence) {
    return { status: 'stale' }
  }

  return { status: 'evidence_registered', decision: 'ALIGNED', evidence }
}

/**
 * run作成と同時にclaim/kickする。GET/read経路には一切副作用を置かない代わりに、
 * 実行契機はここ（作成時）とstartup recoveryだけに限定する。
 */
export async function createAndExecuteDesignReview(
  storage: IStorage,
  input: {
    taskId: string
    taskTitle: string
    designText: string
    changedFiles: string[]
  },
  deps: CoordinatorDeps,
): Promise<ExecuteDesignReviewResult> {
  // hashは呼び出し元から受け取らず、レビュー対象そのもの（designText）から算出する。
  // これにより design_text → design_text_hash → evidence.designTextHash →
  // Job Gate が計算する computeDesignTextHash(job.aiCliPrompt) が同一内容でのみ一致し、
  // review後にpromptを書き換えた実行を通せない。
  const run = storage.designReviewRuns.create({
    ...input,
    designTextHash: computeDesignTextHash(input.designText),
  })
  return executeDesignReviewRun(storage, run, deps)
}

/**
 * API process crash後の起動時回収。runningのまま残ったrunをqueuedへ戻し、そのまま再kickする。
 * 新しいscheduler/cronは導入せず、起動時の一度だけ実行する。
 */
export async function recoverAndRekickAtStartup(
  storage: IStorage,
  deps: CoordinatorDeps,
  processStartedAt: string = new Date().toISOString(),
): Promise<ExecuteDesignReviewResult[]> {
  // processStartedAt より後に開始したrunは現プロセスのものとして除外されるため、
  // 稼働中に誤って呼ばれても実行中attemptをrequeueしてしまうことはない。
  storage.designReviewRuns.recoverStaleRunningAtStartup(DESIGN_REVIEW_MAX_ATTEMPTS, processStartedAt)

  const results: ExecuteDesignReviewResult[] = []
  for (const queued of storage.designReviewRuns.findQueued()) {
    results.push(await executeDesignReviewRun(storage, queued, deps))
  }
  return results
}

/**
 * 失敗をその場で確定させる。attemptが残っていればrequeue、超過ならfailed終端。
 * どちらもclaim_token一致が条件なので、stale attemptの失敗が現行attemptを壊すことはない。
 */
function finalizeFailure(
  storage: IStorage,
  run: DesignReviewRun,
  claimToken: string,
  error: string,
): ExecuteDesignReviewResult {
  if (run.attemptCount >= DESIGN_REVIEW_MAX_ATTEMPTS) {
    const fenced = storage.designReviewRuns.complete(run.id, claimToken, 'failed', undefined, error)
    return fenced ? { status: 'failed', error } : { status: 'stale' }
  }

  const fenced = storage.designReviewRuns.requeue(run.id, claimToken, error)
  return fenced ? { status: 'requeued', error } : { status: 'stale' }
}
