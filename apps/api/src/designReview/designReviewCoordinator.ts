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
import path from 'node:path'
import { classifyReviewLoad, ROADMAP_REVIEW_LOAD_CLASSIFICATION } from '@ai-team/worker/src/approvalLevel/reviewLoadClassifier.js'
import { selectFocuses, selectRoadmapReviewFocuses } from '@ai-team/worker/src/approvalLevel/focusSelector.js'
// 判定ロジックは @ai-team/shared の pure 実装を使う。
// worker側 strategicReview.ts は geminiRouter（CLI spawn）や reviewerAdapter（codex CLI）を
// 芋づるでimportするため、APIからimportするとWorkerのprovider/CLI機構がAPI runtimeへ入る。
import {
  applyIndependentReviewOverride,
  isStrategicDecision,
  resolveFinalDecision,
  type DesignReviewEvidence,
  type DesignReviewKind,
} from '@ai-team/shared'
import { resolveDefaultControlContextDir } from '@ai-team/shared/src/constitutionPrinciples.js'
import type { IStorage, DesignReviewRun } from '../storage/interface'
import type { AppliedPrinciple } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { recordPrincipleApplications } from '../principles/ledger'

/** bounded attempt。超過したrunはrequeueせずfailedで終端する。 */
export const DESIGN_REVIEW_MAX_ATTEMPTS = 3

/**
 * runner の実行上限。
 *
 * **元は 120_000（JOB_TIMEOUT_MS と同値）だったが、runner 内部の retry 予算と噛み合っていなかった。**
 * `geminiRouter` は transient 失敗（timeout / network / 5xx）を
 * `TRANSIENT_RETRY_DELAYS_MS = [10s, 30s]` で最大3回試し、**待機だけで 40 秒**を使う。
 * これを API 経路と CLI 経路で個別に行い、さらに Copilot fallback がある。
 * つまり provider が少しでも不安定な瞬間に当たると、レビュー自体は正常でも 120 秒を超える。
 *
 * production 実測（2026-09-14、同一入力・同一 spawn）: 2.3s / 15.4s / 44.6s。
 * 44.6s の回は `[geminiRouter] attempt failed: provider=gemini_api ... failureClass=transient` を
 * 出しており、**所要時間のばらつきは provider 由来**であることが確認できた。
 * 一方 production の attempt は3回連続で 120s 超過していた（`design-review-runner-production-timeout`）。
 *
 * ここでは「API 経路が transient retry を1周する（待機 40 秒 + 実試行3回）」を収容できる値に上げる。
 * **worst case（CLI 経路の exec 120 秒 × 3 + Copilot fallback）は依然として収容していない。**
 * それを収容するには caller の timeout を伸ばすのではなく **runner 側の retry 予算を deadline で
 * 縛る**必要があり、別項目として扱う（`design-review-runner-production-timeout`）。
 */
export const DESIGN_REVIEW_RUNNER_TIMEOUT_MS = 300_000

/** SIGTERMを無視するchildを確実に終わらせるための猶予。 */
export const DESIGN_REVIEW_RUNNER_SIGKILL_GRACE_MS = 5_000

/** runner出力の上限。超過した時点でchildを止め、APIプロセスのメモリを守る。 */
export const DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES = 10 * 1024 * 1024

/** 失敗理由へ添える runner stderr の長さ上限。DB の error 列を診断ログにしないための箍。 */
export const DESIGN_REVIEW_STDERR_TAIL_CHARS = 500

/**
 * 失敗理由へ runner stderr の末尾を添える。
 *
 * 原因は末尾に出る（最後の attempt の失敗理由・fallback の結末）ため先頭ではなく末尾を残す。
 * stderr が無ければ理由文をそのまま返す（既存の error 文言は変えない）。
 */
export function appendRunnerStderr(error: string, stderr: string | undefined): string {
  const trimmed = stderr?.trim()
  if (!trimmed) return error
  const tail =
    trimmed.length <= DESIGN_REVIEW_STDERR_TAIL_CHARS
      ? trimmed
      : `…${trimmed.slice(-DESIGN_REVIEW_STDERR_TAIL_CHARS)}`
  return `${error} | runner stderr: ${tail}`
}

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
  // Copilot CLI フォールバック（copilotRouter.ts）は ai-team ユーザーの保存済み
  // OAuth credential（HOME配下）で認証する。PAT/token類は一切渡さない
  // （2026-08-28: COPILOT_GITHUB_TOKEN配線をOAuthへ統一するため撤去）。
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

/**
 * Review 1 回分の原則判定を ledger へ渡す。
 *
 * `RawStrategicResult` のフィールドは `unknown` なので、ここで narrowing する。
 * **形が想定と違えば静かに 0 件として扱う。** 記録が取れないことと Review の失敗は別事象であり、
 * 片方をもう片方に巻き込まない。
 */
/**
 * **この関数全体が try で囲われていること自体が不変条件である。**
 *
 * `recordPrincipleApplications()` の内部 catch だけでは足りない: その手前の Task 参照や
 * narrowing で投げると、Reviewer 実行後・run 終端前に `executeDesignReviewRun` を抜けてしまい、
 * claim した run が running のまま取り残される（独立レビュー指摘 2026-09-17）。
 * 記録は Gate ではないので、ここで起きたことが Review の結果を変えてはならない。
 */
function recordPrincipleApplicationsForRun(
  storage: IStorage,
  run: DesignReviewRun,
  raw: RawStrategicResult,
): void {
  try {
    recordPrincipleApplicationsForRunUnsafe(storage, run, raw)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn('[designReview] principle ledger recording failed (review unaffected): ' + reason)
  }
}

function recordPrincipleApplicationsForRunUnsafe(
  storage: IStorage,
  run: DesignReviewRun,
  raw: RawStrategicResult,
): void {
  // roadmap kind の subjectId は projectId そのもの（design_review_runs schema のコメント参照）。
  // task kind は Task から projectId を引く。引けなければ記録しない — projectId を捏造しない。
  const task = run.reviewKind === 'task' && run.taskId !== undefined
    ? storage.tasks.findById(run.taskId)
    : undefined
  const projectId = run.reviewKind === 'roadmap' ? run.subjectId : task?.projectId

  if (projectId === undefined) {
    return
  }

  recordPrincipleApplications(
    storage,
    {
      projectId,
      taskId: task?.id,
      roadmapItemId: task?.roadmapTaskKey,
      reviewRunId: run.id,
    },
    {
      focusedReviewResults: Array.isArray(raw.focusedReviewResults)
        ? raw.focusedReviewResults.map(toAppliedPrincipleCarrier)
        : [],
      independentReviewResult: toAppliedPrincipleCarrier(raw.independentReviewResult),
    },
  )
}

/** `appliedPrinciples` を持ち得るオブジェクトだけを取り出す。それ以外は undefined。 */
function toAppliedPrincipleCarrier(value: unknown): { appliedPrinciples?: AppliedPrinciple[] } | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const applied = (value as { appliedPrinciples?: unknown }).appliedPrinciples
  return Array.isArray(applied) ? { appliedPrinciples: applied as AppliedPrinciple[] } : undefined
}

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

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function findingMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const message = stringField(item as Record<string, unknown>, 'message')
    return message ? [message] : []
  })
}

function buildRoadmapRejectedReason(
  raw: RawStrategicResult,
  decision: RecomputedDecision,
): string | undefined {
  const reasons: string[] = []

  if (Array.isArray(raw.focusedReviewResults)) {
    for (const item of raw.focusedReviewResults) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const focusDecision = stringField(record, 'decision')
      if (!focusDecision || focusDecision === 'ALIGNED') continue

      const focus = stringField(record, 'focus') ?? 'focused_review'
      const details = [
        stringField(record, 'summary'),
        ...findingMessages(record.findings),
      ].filter((part): part is string => Boolean(part))
      reasons.push(details.length > 0 ? `${focus}: ${details.join('; ')}` : `${focus}: ${focusDecision}`)
    }
  }

  if (typeof raw.integrationReviewResult === 'object' && raw.integrationReviewResult !== null) {
    const integration = raw.integrationReviewResult as Record<string, unknown>
    const integrationDecision = stringField(integration, 'decision')
    if (integrationDecision && integrationDecision !== 'ALIGNED') {
      reasons.push(`integration: ${stringField(integration, 'summary') ?? integrationDecision}`)
    }
  }

  if (typeof raw.independentReviewResult === 'object' && raw.independentReviewResult !== null) {
    const independent = raw.independentReviewResult as Record<string, unknown>
    const verdict = stringField(independent, 'verdict')
    const unavailable = independent.unavailable === true
    if (unavailable || (verdict && verdict !== 'approved')) {
      reasons.push(`independent: ${stringField(independent, 'summary') ?? verdict ?? 'unavailable'}`)
    }
  }

  return reasons.length > 0 ? `${decision}: ${reasons.join(' / ')}` : undefined
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
export function recomputeDecision(
  raw: RawStrategicResult,
  reviewKind: DesignReviewKind,
  changedFiles: string[],
): RecomputeOutcome {
  const classification = reviewKind === 'roadmap'
    ? ROADMAP_REVIEW_LOAD_CLASSIFICATION
    : classifyReviewLoad({ changedFiles })
  const reviewLoad = classification.reviewLoad
  const expectedFocuses = reviewKind === 'roadmap'
    ? selectRoadmapReviewFocuses()
    : selectFocuses(reviewLoad, changedFiles)
  // **task kind のみ** 別建ての independent review を要求する。
  // roadmap kind の第二意見は Claude の integration review が担うようになったので
  // （PR C: Codex generator → Gemini focused ×3 → Claude Opus integration）、
  // ここで Codex independent を要求し続けると、Worker が作らないものをAPIが求める
  // 恒久的な不整合になり、新topologyは一度も成立しない。
  const independentReviewRequired = reviewKind !== 'roadmap' && reviewLoad === 'critical'

  // roadmap kind では integration review の存在そのものを必須にする（fail-closed）。
  // 「Claudeが落ちたので統合を省いて続行」を許すと、単独のGemini群だけで承認が通る。
  const integrationReviewRequired = reviewKind === 'roadmap'

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

  // decision 値も enum に対して明示的に検証する。ここを素通りさせると
  // `resolveFinalDecision` は未知値を（fail-closed 化後も）UNCERTAIN へ丸めるだけで、
  // 「runner が何を返したのか」が evidence から失われる。independent review verdict と
  // 同じく、受理できない語彙は理由付きで reject する（下の verdict チェックと対称）。
  const invalidDecisions = raw.focusedReviewResults
    .map((item) => item.decision)
    .filter((decision) => !isStrategicDecision(decision))
  if (invalidDecisions.length > 0) {
    return reject(`unknown focused review decision(s): ${invalidDecisions.join(', ')}`)
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

  if (integrationReviewRequired && (!integration || typeof integration.decision !== 'string')) {
    return reject('roadmap review requires an integration review result')
  }

  // integration 側も同様に enum 検証する。integration review は roadmap kind では必須で、
  // かつ focused が全件 ALIGNED でもここ1件で最終判定を動かせるため、未知値を
  // 黙って UNCERTAIN へ丸めず reject して理由を残す。
  //
  // `null` は `undefined` と同じく「integration 無し」として扱う（独立レビュー指摘）。
  // task kind では integration review は任意であり、runner が JSON で
  // `"integrationReviewResult": null` を返すことがある。`!== undefined` だけで判定すると
  // そこで `integration.decision` が TypeError を投げ、この関数の呼び出し元は
  // 既存の失敗確定 catch の外にあるため、**claim した run が running のまま残り**
  // 既存の reject 経路で終端できなくなる。roadmap kind の `null` は上の
  // `integrationReviewRequired` チェック（`!integration`）が先に reject する。
  if (integration !== undefined && integration !== null && !isStrategicDecision(integration.decision)) {
    return reject(`unknown integration review decision: ${String(integration.decision)}`)
  }

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
    rejectedReason: reviewKind === 'roadmap' && decision !== 'ALIGNED'
      ? buildRoadmapRejectedReason(raw, decision)
      : undefined,
  }
}

export interface RunnerExecution {
  ok: boolean
  stdout: string
  error?: string
  timedOut: boolean
  /** runner の stderr 診断情報。成功時も失敗時も同じ上限（DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES）で収集する。 */
  stderr?: string
}

export interface CoordinatorDeps {
  runnerCommand: string
  runnerArgs: string[]
  homeDirectory: string
  workingDir: string
  /** レビュー方針文書（Constitution / Meta Reviewer checklists）のルート。既定は resolveDefaultControlContextDir()。 */
  controlContextDir?: string
  /** テストで差し替えるための実行フック。既定は restricted env での spawn。 */
  execute?: (input: string) => Promise<RunnerExecution>
  timeoutMs?: number
}

export function executeRunner(deps: CoordinatorDeps, input: string): Promise<RunnerExecution> {
  const timeoutMs = deps.timeoutMs ?? DESIGN_REVIEW_RUNNER_TIMEOUT_MS

  return new Promise<RunnerExecution>((resolvePromise) => {
    // `detached: true` は「切り離して放置する」ためではなく、**まとめて止められるようにする**ため。
    // 子を新しいプロセスグループのリーダーにしておかないと、timeout 時に孫を回収できない（killTree 参照）。
    const child = spawn(deps.runnerCommand, deps.runnerArgs, {
      env: buildRunnerEnv(deps.homeDirectory),
      cwd: deps.workingDir,
      detached: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let overflowed = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    /**
     * 直接の子だけでなく**プロセスグループ全体**へ送る。
     *
     * runner は `npx tsx <script>` で起動するため、実体は
     * `npx → npm exec → sh -c → tsx → node` と4段深くなる。`child.kill()` は先頭の1つしか
     * 落とさないので、**timeout のたびに孫プロセスが生き残って孤児化する**
     * （2026-09-14 production 実測: kill 後も runner の node 2つが systemd へ reparent されて
     * 走り続けていた）。孤児は provider 接続を掴んだままなので、次の attempt の transient 失敗を
     * 増やし、timeout を再発させる側に働く。
     *
     * `detached: true` で子を新しいプロセスグループのリーダーにし、`-pid` へ送って全員を止める。
     * グループが既に消えている場合（ESRCH）は直接の子へフォールバックする。
     */
    const killTree = (signal: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        process.kill(-pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // 既に終了している。何もしない。
        }
      }
    }

    /**
     * SIGTERMを無視するchildでもPromiseが宙吊りにならないよう、SIGKILLへ必ず昇格させ、
     * さらにその猶予後には close を待たずに settle する。
     */
    const terminate = (execution: RunnerExecution): void => {
      killTree('SIGTERM')
      killTimer = setTimeout(() => {
        killTree('SIGKILL')
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
      terminate({ ok: false, stdout, error: `runner timed out after ${timeoutMs}ms`, timedOut: true, stderr: stderr || undefined })
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
          stderr: undefined,
        })
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (overflowed) return
      const currentBytes = Buffer.byteLength(stderr, 'utf-8')
      if (currentBytes >= DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES) return
      const remaining = DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES - currentBytes
      const chunkStr = chunk.toString('utf-8')
      const chunkBytes = Buffer.byteLength(chunkStr, 'utf-8')
      if (chunkBytes <= remaining) {
        stderr += chunkStr
      } else {
        const truncated = chunk.subarray(0, remaining).toString('utf-8')
        if (Buffer.byteLength(stderr + truncated, 'utf-8') > DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES) {
          // decoded fragment pushes total over cap (multi-byte boundary overshoot); drop it
        } else {
          stderr += truncated
        }
      }
    })

    child.on('error', (err) => {
      settle({ ok: false, stdout, error: `spawn failed: ${err.message}`, timedOut, stderr: undefined })
    })

    child.on('close', (code) => {
      if (timedOut) {
        settle({ ok: false, stdout, error: `runner timed out after ${timeoutMs}ms`, timedOut: true, stderr: stderr || undefined })
        return
      }
      if (overflowed) {
        settle({
          ok: false,
          stdout: '',
          error: `runner output exceeded ${DESIGN_REVIEW_RUNNER_MAX_OUTPUT_BYTES} bytes`,
          timedOut: false,
          stderr: undefined,
        })
        return
      }
      if (code !== 0) {
        settle({ ok: false, stdout, error: `runner exited with code ${code}: ${stderr.trim()}`, timedOut: false, stderr: stderr.trim() || undefined })
        return
      }
      settle({ ok: true, stdout, timedOut: false, stderr: stderr.trim() || undefined })
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

  let runnerInput: string

  if (run.reviewKind === 'task') {
    if (run.taskId === undefined) {
      // invariant violation: a task-kind row must always have taskId. Fail-closed exactly like the
      // Phase 1 guard did, same fenced complete() call, same error message shape.
      const fenced = storage.designReviewRuns.complete(
        run.id, claimToken, 'failed', undefined,
        `executeDesignReviewRun: reviewKind='task' requires a taskId but the run has none (invariant violation)`,
      )
      return fenced
        ? { status: 'failed', error: 'task-kind design review run is missing taskId' }
        : { status: 'stale' }
    }
    runnerInput = JSON.stringify({
      reviewKind: 'task',
      subjectId: run.taskId,
      taskTitle,
      designText: run.designText,
      changedFiles,
      workingDir: deps.workingDir,
      controlContextDir: deps.controlContextDir,
    })
  } else if (run.reviewKind === 'roadmap') {
    runnerInput = JSON.stringify({
      reviewKind: 'roadmap',
      subjectId: run.subjectId,
      taskTitle,
      designText: run.designText,
      changedFiles: [],       // always genuinely empty for roadmap kind — never populate this
      workingDir: deps.workingDir,
      controlContextDir: deps.controlContextDir,
    })
  } else {
    // exhaustive fail-closed default for any future reviewKind value this function doesn't support yet.
    const fenced = storage.designReviewRuns.complete(
      run.id, claimToken, 'failed', undefined,
      `executeDesignReviewRun does not yet support reviewKind=${run.reviewKind} (phase 2 must extend this before roadmap reviews reach here)`,
    )
    return fenced
      ? { status: 'failed', error: `unsupported reviewKind: ${run.reviewKind}` }
      : { status: 'stale' }
  }

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
    // **stderr を捨てない。** timeout で終わった run の `error` が
    // 「runner timed out after Nms」だけだと、原因（provider の transient 失敗と retry 待機など）が
    // どこにも残らない。実際 `design-review-runner-production-timeout` は、この情報が
    // 落ちていたために3回の調査でも原因へ到達できなかった。
    // 末尾のみ・長さ上限つきで付ける（runner の env には token を渡していない）。
    return finalizeFailure(
      storage,
      claimed.run,
      claimToken,
      appendRunnerStderr(execution.error ?? 'runner failed', execution.stderr),
    )
  }

  let raw: RawStrategicResult
  try {
    raw = JSON.parse(execution.stdout) as RawStrategicResult
  } catch {
    return finalizeFailure(storage, claimed.run, claimToken, 'runner returned unparsable output')
  }

  const outcome = recomputeDecision(raw, run.reviewKind, changedFiles)

  // **記録は fence を通った後にだけ行う。**
  //
  // ここで先に書くと、claim を失った stale attempt の判定が先に入り、
  // 受理された attempt の判定が `INSERT OR IGNORE` に弾かれる
  // （同じ run.id なので unique index が後勝ちを許さない）。
  // 結果として **Review が採用しなかった判定が ledger に残る**（独立レビュー指摘 2026-09-17 第2回）。
  // ALIGNED でない結果も記録したいので、両方の分岐の fence 直後に置く。

  if (outcome.decision !== 'ALIGNED') {
    if (execution.stderr) {
      console.warn(`[designReview] runner stderr (decision=${outcome.decision}): ${execution.stderr}`)
    }
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
    recordPrincipleApplicationsForRun(storage, run, raw)
    return { status: 'not_aligned', decision: outcome.decision, error: outcome.rejectedReason }
  }

  const evidence = storage.designReviewRuns.completeWithEvidence(run.id, claimToken, execution.stdout, {
    reviewKind: run.reviewKind,
    subjectId: run.subjectId,
    taskId: run.reviewKind === 'task' ? run.taskId : undefined,
    designTextHash: run.designTextHash,
    reviewLoad: outcome.reviewLoad as DesignReviewEvidence['reviewLoad'],
    decision: 'ALIGNED',
    independentReviewRequired: outcome.independentReviewRequired,
    independentReviewVerdict: outcome.independentReviewVerdict as DesignReviewEvidence['independentReviewVerdict'],
  })

  if (!evidence) {
    return { status: 'stale' }
  }

  recordPrincipleApplicationsForRun(storage, run, raw)

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

export interface CreateAndExecuteRoadmapReviewInput {
  projectId: string
  /** Composed canonical text — see composeRoadmapReviewMaterial() in the new
   *  apps/api/src/ctoAi/roadmapReviewMaterial.ts (section 7). Callers build this, this function
   *  just hashes and stores it — keeps this coordinator file subject-shape-agnostic. */
  reviewMaterial: string
  taskTitle?: string   // defaults to 'Whole-Roadmap Review'
}

export async function createAndExecuteRoadmapReview(
  storage: IStorage,
  input: CreateAndExecuteRoadmapReviewInput,
  deps: CoordinatorDeps,
): Promise<ExecuteDesignReviewResult> {
  const run = storage.designReviewRuns.create({
    reviewKind: 'roadmap',
    subjectId: input.projectId,
    taskTitle: input.taskTitle ?? 'Whole-Roadmap Review',
    designText: input.reviewMaterial,
    designTextHash: computeDesignTextHash(input.reviewMaterial),
    changedFiles: [],
  })
  return executeDesignReviewRun(storage, run, deps)
}

/**
 * 既定のrunner起動設定。index.ts側を最小変更に保つため、既定値の構築はここに置く。
 * secretは一切含めない（envはbuildRunnerEnvが明示構築する）。
 */
export function buildDefaultCoordinatorDeps(): CoordinatorDeps {
  const repoRoot = process.env.DESIGN_REVIEW_REPO_ROOT ?? path.resolve(process.cwd(), '../..')
  return {
    runnerCommand: process.env.DESIGN_REVIEW_RUNNER_COMMAND ?? 'npx',
    runnerArgs: [
      ...(process.env.DESIGN_REVIEW_RUNNER_COMMAND ? [] : ['tsx']),
      path.join(repoRoot, 'apps', 'worker', 'scripts', 'designReviewRunner.ts'),
    ],
    homeDirectory: process.env.HOME ?? process.env.USERPROFILE ?? repoRoot,
    workingDir: repoRoot,
    controlContextDir: process.env.DESIGN_REVIEW_CONTROL_CONTEXT_DIR ?? resolveDefaultControlContextDir(),
  }
}

/**
 * **起動時回収は `queuedRunDispatch.ts` へ移した（U4）。**
 *
 * queued run には repair 目的のものが混じる。ここで `executeDesignReviewRun()` を直接呼ぶと
 * repair continuation が失われるため、dispatch は run の successor intent を読める1箇所へ
 * 集約した。この module から `repairFlow` を import すると既存の依存方向
 * （`repairFlow → designReviewCoordinator`）が逆転して循環するので、回収関数ごと移設している。
 */

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
