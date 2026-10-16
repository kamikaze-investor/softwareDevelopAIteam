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
import { DesignReviewRunContentionError, type IStorage, type DesignReviewRun } from '../storage/interface'
import type { AppliedPrinciple } from '@ai-team/shared'
import { computeDesignTextHash, type StoredRunJudgment } from '../designReviewEvidencePolicy'
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
  /** runner が REVIEW_UNAVAILABLE を返したときの理由（任意）。 */
  unavailableReason?: unknown
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * runner の出力が判定材料として読める形（null でも配列でも primitive でもない object）か。
 * 読めない出力は「判定」ではなく「使える出力が無い」なので、呼び出し側は runner crash と同じく
 * finalizeFailure で終端する。
 */
export function isUsableRunnerOutput(value: unknown): value is RawStrategicResult {
  return isPlainRecord(value)
}

/**
 * payload に有効な CONFLICT 判定が1件でもあるか（構造が崩れていても拾う）。
 *
 * 数えるのは integration の CONFLICT と、**要求した focus（expectedFocuses）**の CONFLICT だけ。
 * 要求していない focus 名の CONFLICT は誰に何を問うた結果か特定できず（旧 runner の架空 focus 等）、
 * 書き直しても答えようがないので判定として採用しない（従来の構造検証の意図を保つ）。
 */
function payloadHasValidConflict(raw: RawStrategicResult, expectedFocuses: readonly string[]): boolean {
  const isConflict = (value: unknown): boolean => isPlainRecord(value) && value.decision === 'CONFLICT'
  const isRequestedFocusConflict = (value: unknown): boolean =>
    isConflict(value) && typeof (value as { focus?: unknown }).focus === 'string'
      && expectedFocuses.includes((value as { focus: string }).focus)
  return (Array.isArray(raw.focusedReviewResults) && raw.focusedReviewResults.some(isRequestedFocusConflict))
    || isConflict(raw.integrationReviewResult)
}

/** 構造検証で見つかった問題（空なら妥当）。見つかった順に並ぶ。 */
function structuralProblems(
  raw: RawStrategicResult,
  expectedFocuses: readonly string[],
  integrationReviewRequired: boolean,
  independentReviewRequired: boolean,
): string[] {
  const problems: string[] = []

  if (!isFocusResultArray(raw.focusedReviewResults)) {
    problems.push('focusedReviewResults has invalid shape')
  } else {
    const reportedFocuses = raw.focusedReviewResults.map((item) => item.focus)
    // low load でも selectFocuses は [] を返すため、例外を設けず常に集合一致を要求する。
    const focusSetMatches =
      reportedFocuses.length === expectedFocuses.length &&
      expectedFocuses.every((focus) => reportedFocuses.includes(focus))
    if (!focusSetMatches) {
      problems.push(
        `focus set mismatch: expected [${expectedFocuses.join(',')}] but runner reported [${reportedFocuses.join(',')}]`,
      )
    }
    // decision 値も enum に対して明示的に検証する。素通りさせると `resolveFinalDecision` は未知値を
    // UNCERTAIN へ丸めるだけで、「runner が何を返したのか」が evidence から失われる。
    const invalidDecisions = raw.focusedReviewResults
      .map((item) => item.decision)
      .filter((decision) => !isStrategicDecision(decision))
    if (invalidDecisions.length > 0) {
      problems.push(`unknown focused review decision(s): ${invalidDecisions.join(', ')}`)
    }
  }

  // verdict は reviewerAdapter の定義値のみ受理する。未知の文字列を evidence へ保存すると、
  // decision は ALIGNED なのに Job Gate（independentReviewVerdict === 'approved'）が恒久的に落ちる。
  // critical で verdict が無いものは「欠落」であって語彙違いではない（unavailable 側で扱う）。
  const independent = raw.independentReviewResult
  if (independent !== undefined && independent !== null) {
    const verdict = isPlainRecord(independent) ? independent.verdict : undefined
    const missing = typeof verdict !== 'string'
    if (!(independentReviewRequired && missing) && !INDEPENDENT_REVIEW_VERDICTS.includes(verdict as never)) {
      problems.push(`unknown independent review verdict: ${String(verdict)}`)
    }
  }

  // roadmap kind では integration review の存在そのものを必須にする（fail-closed）。
  // `null` は `undefined` と同じく「integration 無し」として扱う（task kind では任意）。
  const integration = raw.integrationReviewResult
  const integrationDecision = isPlainRecord(integration) ? integration.decision : undefined
  if (integrationReviewRequired && typeof integrationDecision !== 'string') {
    problems.push('roadmap review requires an integration review result')
  } else if (integration !== undefined && integration !== null && !isStrategicDecision(integrationDecision)) {
    problems.push(`unknown integration review decision: ${String(integrationDecision)}`)
  }

  return problems
}

/**
 * runner が「review を（一部でも）実行できなかった」ことを示す事実の一覧（空なら無し）。
 *
 * `finalDecision: 'REVIEW_UNAVAILABLE'`、focused / integration / independent の `unavailable: true`、
 * および critical で必須の independent が欠落していること。判定を厳しくする向きにしか使わない。
 * 先頭が rejectedReason の主文になる（runner の理由 → 各結果の印 → independent の状態の順）。
 */
function unavailabilityNotes(raw: RawStrategicResult, independentReviewRequired: boolean): string[] {
  const notes: string[] = []
  const marked = (value: unknown): boolean => isPlainRecord(value) && value.unavailable === true
  const runnerReason = typeof raw.unavailableReason === 'string' && raw.unavailableReason.trim() !== ''
    ? raw.unavailableReason.trim().slice(0, 500)
    : undefined

  if (raw.finalDecision === 'REVIEW_UNAVAILABLE') {
    notes.push(`review unavailable: ${runnerReason ?? 'runner reported REVIEW_UNAVAILABLE without a reason'}`)
  }
  if (Array.isArray(raw.focusedReviewResults) && raw.focusedReviewResults.some(marked)) {
    notes.push('a focused review reported it was unavailable')
  }
  if (marked(raw.integrationReviewResult)) {
    notes.push('the integration review reported it was unavailable')
  }

  const independent = raw.independentReviewResult
  const independentMissing = !isPlainRecord(independent) || typeof independent.verdict !== 'string'
  if (independentReviewRequired && independentMissing) {
    notes.push('critical review load requires an independent review result')
  } else if (marked(independent)) {
    notes.push(independentReviewRequired
      ? 'critical review load requires an independent review result, but it was unavailable'
      : 'the independent review reported it was unavailable')
  }

  // 印が1つでも付いた場合だけ runner の理由を添える（理由の欄だけでは unavailable としない）。
  if (notes.length > 0 && runnerReason !== undefined && raw.finalDecision !== 'REVIEW_UNAVAILABLE') {
    notes.unshift(`review unavailable: ${runnerReason}`)
  }
  return notes
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
 * **判定は1本の順序付き pipeline で決める（task / roadmap 両 kind・全 load 共通）。**
 * 分岐ごとに継ぎ足すと「ある load・ある kind だけ CONFLICT が隠れる / unavailable が ALIGNED に
 * なる」が繰り返し漏れた（独立レビュー round 1〜4・2026-10-16）。不変条件は順序で保証する:
 *
 *   A. object でない出力は判定材料にしない（呼び出し側が finalizeFailure へ送る）。
 *   B. 有効な CONFLICT（integration・要求した focus）があれば CONFLICT（構造の問題・unavailable より先）。
 *   C. unavailable = finalDecision REVIEW_UNAVAILABLE / 各結果の `unavailable: true` /
 *      critical で必須の independent の欠落。
 *   D. 構造検証に落ちたら、unavailable なら REVIEW_UNAVAILABLE、そうでなければ従来どおり UNCERTAIN。
 *   E. 組み直した判定 + critical の independent override。unavailable で CONFLICT でなければ
 *      REVIEW_UNAVAILABLE。ALIGNED は上のどれも起きなかったときだけ。
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

  // A. 読めない出力（null・配列・primitive）。実行経路は事前に弾いて finalizeFailure へ送るが、
  //    保存済み結果を読み直す他の呼び出し側のために、ここでも例外にせず不採用で返す。
  if (!isPlainRecord(raw)) {
    return { decision: 'UNCERTAIN', reviewLoad, independentReviewRequired, rejectedReason: 'runner output is not an object' }
  }

  const independent = isPlainRecord(raw.independentReviewResult) ? raw.independentReviewResult : undefined
  const independentVerdict = typeof independent?.verdict === 'string' ? independent.verdict : undefined
  const problems = structuralProblems(raw, expectedFocuses, integrationReviewRequired, independentReviewRequired)
  const unavailable = unavailabilityNotes(raw, independentReviewRequired)

  // B. **有効な CONFLICT は何より先に返す。** CONFLICT は ALIGNED から遠ざける向きにしか
  //    働かないので、構造が崩れていても・review の一部が実行できなくても判定として採用してよい。
  //    以前は欠落・構造不一致を先に見ていたため、critical の independent 欠落（Task `b8d0fc5d`
  //    の run `c11357e8`）や unavailable 申告で、本物の CONFLICT が「レビューできなかった」に
  //    置き換わり、CONFLICT だけを対象にする remediation が動かなかった。
  if (payloadHasValidConflict(raw, expectedFocuses)) {
    const notes = [...problems, ...unavailable]
    const roadmapReason = reviewKind === 'roadmap' ? buildRoadmapRejectedReason(raw, 'CONFLICT') : undefined
    return {
      decision: 'CONFLICT',
      reviewLoad,
      independentReviewRequired,
      independentReviewVerdict: independentVerdict,
      rejectedReason: notes.length === 0
        ? roadmapReason
        : `${roadmapReason ?? 'review found a CONFLICT'}; ${notes.join('; ')}`,
    }
  }

  // C/D. 判定無し（unavailable）と構造の不採用。unavailable を先に見るのは、実行されなかった
  //    review の構造は期待と合わないことがあり、そのまま reject すると本当の原因が
  //    `focus set mismatch` に置き換わるため（2026-09-28 production・run `d0af140a`:
  //    prompt.md の ENOENT が focus set mismatch として escalation された）。
  const unavailableOutcome = (): RecomputeOutcome => ({
    decision: 'REVIEW_UNAVAILABLE',
    reviewLoad,
    independentReviewRequired,
    independentReviewVerdict: independentVerdict,
    rejectedReason: unavailable.join('; '),
  })
  if (problems.length > 0) {
    return unavailable.length > 0
      ? unavailableOutcome()
      : { decision: 'UNCERTAIN', reviewLoad, independentReviewRequired, rejectedReason: problems.join('; ') }
  }

  // E. 組み直した判定 + critical の independent override（従来どおり安全側にのみ倒す）。
  let decision: RecomputedDecision = resolveFinalDecision(
    raw.focusedReviewResults as never,
    (raw.integrationReviewResult ?? undefined) as never,
  )
  if (independentReviewRequired && independent !== undefined && independentVerdict !== undefined) {
    decision = applyIndependentReviewOverride(decision, independent as never) as RecomputedDecision
  }

  // **申告された unavailable は ALIGNED にしない。** 自己申告を信じないのは ALIGNED への格上げを
  // 防ぐためであって、unavailable を ALIGNED へ格上げしてよい理由にはならない。
  if (unavailable.length > 0 && decision !== 'CONFLICT') {
    return unavailableOutcome()
  }

  return {
    decision,
    reviewLoad,
    independentReviewRequired,
    independentReviewVerdict: independentVerdict,
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
  /**
   * `contended`: 同じ subject に別の同一性の active run が居て、この review を始められない（判定待ち）。
   */
  status: 'evidence_registered' | 'not_aligned' | 'requeued' | 'failed' | 'not_claimable' | 'stale' | 'contended'
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

  let parsed: unknown
  try {
    parsed = JSON.parse(execution.stdout)
  } catch {
    return finalizeFailure(storage, claimed.run, claimToken, 'runner returned unparsable output')
  }
  // `null`・配列・primitive は「使える出力が無い」であって判定ではない。runner crash と同じく
  // finalizeFailure で終端する（以前は `null` で recomputeDecision が投げ、claim した run が
  // running のまま残った。独立レビュー指摘・2026-10-16）。
  if (!isUsableRunnerOutput(parsed)) {
    return finalizeFailure(storage, claimed.run, claimToken, 'runner returned no usable output (not a JSON object)')
  }
  const raw = parsed

  // 再計算で何が投げても run を running のまま残さない。
  let outcome: RecomputeOutcome
  try {
    outcome = recomputeDecision(raw, run.reviewKind, changedFiles)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return finalizeFailure(storage, claimed.run, claimToken, `design review recompute failed: ${reason}`)
  }

  // **記録は fence を通った後にだけ行う。**
  //
  // ここで先に書くと、claim を失った stale attempt の判定が先に入り、
  // 受理された attempt の判定が `INSERT OR IGNORE` に弾かれる
  // （同じ run.id なので unique index が後勝ちを許さない）。
  // 結果として **Review が採用しなかった判定が ledger に残る**（独立レビュー指摘 2026-09-17 第2回）。
  // ALIGNED でない結果も記録したいので、両方の分岐の fence 直後に置く。

  // **task kind の REVIEW_UNAVAILABLE は判定ではない。** runner が使える判定を返さなかった
  // のと同じなので、runner crash と同じ `finalizeFailure()`（attempt 残があれば requeue、
  // 上限で failed）で終端する。以前は `succeeded` / not_aligned として確定させていたため、
  // Codex logout のような一時的な欠落でも retry されず escalation された（Task `b8d0fc5d`）。
  // 判定が無いので principle ledger にも記録しない（finalizeFailure 経路と同じ扱い）。
  // roadmap kind はこの関数の挙動を変えない。
  if (run.reviewKind === 'task' && outcome.decision === 'REVIEW_UNAVAILABLE') {
    const failure = finalizeFailure(
      storage,
      claimed.run,
      claimToken,
      appendRunnerStderr(outcome.rejectedReason ?? 'review unavailable', execution.stderr),
    )
    // 呼び出し側の escalation 理由に「なぜ判定が無いか」を残すため decision を添える。
    return failure.status === 'stale' ? failure : { ...failure, decision: 'REVIEW_UNAVAILABLE' }
  }

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
  return createAndExecute(storage, () => storage.designReviewRuns.create({
    ...input,
    designTextHash: computeDesignTextHash(input.designText),
  }), deps)
}

/**
 * run の作成（または同一性の一致する active run の再利用）→ 実行 → 終端しなかった場合の読み直し。
 *
 * - 別の同一性の active run が居る（`DesignReviewRunContentionError`）→ `contended`。
 *   subject ごとに active は1本なので、相手が終わるまで判定は得られない（否定ではない）。
 * - 別の executor が同じ run を握っていた（`not_claimable` / `stale`）→ **保存済み状態を読み直す**。
 *   queued / running なら `requeued`（判定待ち）、ALIGNED evidence があれば `evidence_registered`、
 *   本当に終端した否定・失敗だけを `not_aligned` / `failed` にする。読み直さずに返すと、
 *   同じ要求が重なっただけで（2本目の resume 等）レビュー失敗として扱われる。
 */
async function createAndExecute(
  storage: IStorage,
  createRun: () => DesignReviewRun,
  deps: CoordinatorDeps,
): Promise<ExecuteDesignReviewResult> {
  let run: DesignReviewRun
  try {
    run = createRun()
  } catch (err) {
    if (err instanceof DesignReviewRunContentionError) {
      return { status: 'contended', error: err.message }
    }
    throw err
  }
  const result = await executeDesignReviewRun(storage, run, deps)
  if (result.status !== 'not_claimable' && result.status !== 'stale') return result
  return readDurableRunOutcome(storage, run.id) ?? result
}

/**
 * 終端した run の判定を、API と同じ再計算で分類する（evidence 失効規則の入力）。
 * succeeded 以外・結果なし・読めない結果・REVIEW_UNAVAILABLE は「判定なし」。
 */
export function classifyStoredRunJudgment(run: DesignReviewRun): StoredRunJudgment {
  if (run.status !== 'succeeded' || run.resultJson === undefined) return 'none'
  try {
    const parsed: unknown = JSON.parse(run.resultJson)
    if (!isUsableRunnerOutput(parsed)) return 'none'
    const decision = recomputeDecision(parsed, run.reviewKind, run.changedFiles).decision
    if (decision === 'ALIGNED') return 'aligned'
    return decision === 'CONFLICT' || decision === 'UNCERTAIN' ? 'negative' : 'none'
  } catch {
    return 'none'
  }
}

/** 他の executor が扱った run の、保存済みの結果。読めなければ undefined（呼び出し側は元の結果を返す）。 */
function readDurableRunOutcome(storage: IStorage, runId: string): ExecuteDesignReviewResult | undefined {
  const run = storage.designReviewRuns.findById(runId)
  if (run === undefined) return undefined
  if (run.status === 'queued' || run.status === 'running') {
    return { status: 'requeued', error: `design review run ${run.id} is ${run.status} in another executor` }
  }
  if (run.status === 'failed') {
    return { status: 'failed', error: run.error }
  }
  // **この run 自身の保存済み結果を先に組み直す。** 同じ design hash の古い ALIGNED evidence が
  // 残っていても、この run が CONFLICT で終わったなら CONFLICT である。evidence を先に見ると、
  // 古い承認がこの run の否定判定を上書きしてしまう（独立レビュー round 7・2026-10-16）。
  if (run.resultJson === undefined) return undefined
  let decision: RecomputedDecision
  let rejectedReason: string | undefined
  try {
    const parsed: unknown = JSON.parse(run.resultJson)
    if (!isUsableRunnerOutput(parsed)) return undefined
    const outcome = recomputeDecision(parsed, run.reviewKind, run.changedFiles)
    decision = outcome.decision
    rejectedReason = outcome.rejectedReason
  } catch {
    return undefined
  }
  if (decision !== 'ALIGNED') {
    return { status: 'not_aligned', decision, error: run.error ?? rejectedReason }
  }
  // この run が ALIGNED のときだけ、それが登録した（同じ hash の）evidence を採用する。
  const evidence = run.reviewKind === 'task' && run.taskId !== undefined
    ? storage.designReviewEvidence.findByTaskId(run.taskId)
      .find((item) => item.designTextHash === run.designTextHash && item.decision === 'ALIGNED')
    : storage.designReviewEvidence.findLatestBySubjectId(run.reviewKind, run.subjectId)
  if (evidence === undefined || evidence.designTextHash !== run.designTextHash || evidence.decision !== 'ALIGNED') {
    return undefined
  }
  // **evidence も単一の失効規則を通す。** 読み直すまでの間に、同じ設計の新しい run が始まっている・
  // CONFLICT で終わっていることがある。その evidence を返すと最新の判定を上書きする（独立レビュー round 9）。
  const superseding = storage.designReviewEvidence.findSupersedingRun(evidence)
  if (superseding === undefined) {
    return { status: 'evidence_registered', decision: 'ALIGNED', evidence }
  }
  if (superseding.status === 'queued' || superseding.status === 'running') {
    return { status: 'requeued', error: `a newer design review run ${superseding.id} for the same design is ${superseding.status}` }
  }
  return readDurableRunOutcome(storage, superseding.id)
    ?? { status: 'not_aligned', error: `a newer design review run ${superseding.id} for the same design did not align` }
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
  return createAndExecute(storage, () => storage.designReviewRuns.create({
    reviewKind: 'roadmap',
    subjectId: input.projectId,
    taskTitle: input.taskTitle ?? 'Whole-Roadmap Review',
    designText: input.reviewMaterial,
    designTextHash: computeDesignTextHash(input.reviewMaterial),
    changedFiles: [],
  }), deps)
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
