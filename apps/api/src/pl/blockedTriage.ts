/**
 * Blocked Resolution Triage — 「なぜ止まったか」を機械的事実から分類し、
 * **既存の正しい解決レーンを選ぶ**ところまでを担う。
 *
 * ## これは Blocked を解除する機構ではない
 *
 * ここが返すのは `recommendedLane` という**提案**であって permission ではない。
 * 実行可否は従来どおり `authorizePlAction()`（Mandatory Gate）だけが決める。
 * Triage の判定で Gate が1つでも減ることは無い —— 影響するのは
 * 「PL に何を提案させてよいか」の**絞り込み（narrowing）だけ**で、
 * `triageAllowedActions()` は必ず既存の候補集合との積になる。
 *
 * ## 何を「作っていない」か
 *
 * - **新しい workflow engine を作っていない。** 既存 PL ループの Diagnose / Decide の
 *   手前に入る純粋関数1つである
 * - **新しい DB table / state store を作っていない。** 材料は既存 `jobs` / `tasks` /
 *   `approval_requests` / `design_review_runs` / `design_review_evidence` の実レコードだけ、
 *   記録先は既存 `audit_log` である
 * - **新しい Gate / Review / TaskStatus / JobStatus / AttentionKind / notification を作っていない**
 * - **Independent Remediation / Review Class B の本体を実装していない。** どちらも未実装なので、
 *   ここが持つのは**接続点だけ**である（下記「未実装レーンの扱い」）
 *
 * ## 4つのレーン
 *
 * | lane | 意味 | 今日この lane が実際に到達する先 |
 * |---|---|---|
 * | `auto_recovery` | 既存の bounded recovery で解決しうる | 既存 PL Diagnose → Gate → 既存操作 |
 * | `independent_remediation` | 設計・scope の問題。別設計なら解決しうる | **Design Review CONFLICT のみ配線済み**（`remediateConflict()`）。それ以外は CEO Escalation |
 * | `maintenance_lane` | 通常 Executor では触れない protected 領域 | 未実装（Maintenance Lane v0 = Tier B は `planned`）→ Tier B handoff を添えた CEO Escalation |
 * | `ceo_escalation` | AI だけで決めてはいけない | CEO Escalation |
 *
 * ## レーンと実行の分離（重要な安全性質）
 *
 * **分類はレーンの選択であって実行ではない。** 配線済みの復旧経路がある対象は、この分類より
 * **先に**その経路が扱う（`runPlTick()` は `remediateConflict()` を Triage の手前に置く）。
 * Triage が受け持つのは「渡す先がまだ無いもの」だけで、それらは**すべて CEO Escalation で終端する**。
 *
 * この性質のおかげで、**レーン分類を誤っても CEO を迂回することが原理的に起きない**:
 * B / C / D で未配線のものはすべて人へ届き、A だけが既存 Gate 経由で自動実行へ進む。
 * そして A は「既存の bounded recovery が実在する」機械的事実が立ったときにしか選ばれない。
 *
 * ## 効果検証可能性（Design Philosophy 8）
 *
 * `formatTriageAuditDetail()` が `lane=` / `cause=` / `layer=` / `conf=` を既存
 * `audit_log.detail` の**先頭**へ構造化して載せ、`summarizeBlockedTriage()` が
 * そこから件数・route 別内訳・AUTO_RECOVERY 成功率・CEO escalation 率・UNKNOWN 率・
 * 同一原因の再発数を導く。**新しい metrics backend は作らない**
 * （`adoptionFailure.ts` と同じ形である）。
 */

import { ALWAYS_FORBIDDEN_PATTERNS } from '@ai-team/worker/src/guards/fileChangeGuard.js'
import {
  DESIGN_REVIEW_MAX_ATTEMPTS,
  recomputeDecision,
  type RawStrategicResult,
} from '../designReview/designReviewCoordinator'
import { DEFAULT_STALL_HINT_MS, type AttentionItem } from '../state/systemState'
import type { AuditLogEntry, Job } from '@ai-team/shared'
import type { DesignReviewRun, IStorage } from '../storage/interface'

// ────────────────────────────────────────────────────────────
// 語彙
// ────────────────────────────────────────────────────────────

/** 解決レーン。**増やさない。** 分類を増やす前に、既存4つで表せないかを先に疑うこと。 */
export const BLOCKED_LANES = [
  'auto_recovery',
  'independent_remediation',
  'maintenance_lane',
  'ceo_escalation',
] as const

Object.freeze(BLOCKED_LANES)

export type BlockedLane = (typeof BLOCKED_LANES)[number]

/**
 * 原因分類。**自由文からは作らない。**
 *
 * 1つ1つが production で実際に出ている代表ケースに対応する（初期スコープ）。
 * 対応する実例が無い値をここへ足さないこと —— 集計の分母がぼやける。
 */
export const BLOCKED_ROOT_CAUSE_CLASSES = [
  /** provider CLI の timeout。既存の1回限り自動 retry が対象とする形。 */
  'provider_transient',
  /** provider は落ちたが workspace が未確定。既存の自動 retry 条件を満たさない。 */
  'provider_failure_workspace_dirty',
  /** task-kind Design Review が ALIGNED を出さなかった（CONFLICT / UNCERTAIN 等）。 */
  'design_review_conflict',
  /** queued / failed のまま進んでいない run。attempt が残っている。 */
  'design_review_stalled',
  /** attempt を使い切った run。再kickしても claim できない。 */
  'design_review_exhausted',
  /** File Change Guard 違反。ただし allowedPaths を直せば通りうる範囲。 */
  'allowed_paths_mismatch',
  /** protected file だが Safety / Authority policy 本体ではない（runtime engine 等）。 */
  'protected_path',
  /** Safety / Authority policy 本体、または secret。PL が触れてはならない。 */
  'safety_or_authority_boundary',
  /** workspace が未検証のまま隔離されている。 */
  'workspace_quarantined',
  /** 生きている承認待ち。止めているのは人の判断そのもの。 */
  'approval_waiting',
  /** 承認が STALE / EXPIRED / REJECTED で、その行では誰も進められない。 */
  'approval_not_actionable',
  /** ALIGNED evidence はあるのに実装 Job が作られていない。 */
  'task_ready_without_job',
  /** 機械的事実から原因を特定できなかった。**推測で retry してはならない。** */
  'unknown',
] as const

Object.freeze(BLOCKED_ROOT_CAUSE_CLASSES)

export type BlockedRootCauseClass = (typeof BLOCKED_ROOT_CAUSE_CLASSES)[number]

/** どの層で止まっているか。説明と集計の軸に使い、**権限判断には使わない**。 */
export type BlockingLayer =
  | 'provider'
  | 'design_review'
  | 'file_change_guard'
  | 'workspace'
  | 'approval'
  | 'job_creation'
  | 'unknown'

/**
 * 判定に使った機械的事実。**自由文・PL の申告は入れない。**
 * ここに載るのは実レコードの id と、列挙値・パス・件数のような機械が出した値だけである。
 */
export interface BlockedEvidence {
  /** どの事実か（例: `job.guardResult.fileViolations`）。 */
  fact: string
  /** 該当レコードの id（あれば）。 */
  id?: string
  /** その事実の値。 */
  value: string
}

/**
 * 観測待ちの明示。**「今回は様子を見る」で終わらせないための欄。**
 *
 * 何を見るか・いつ再評価するか・どれだけ待つか・待ち切ったらどこへ行くかを全部書く。
 * threshold は既存の停滞閾値をそのまま使い、**新しい数字を作らない**。
 */
export interface BlockedObservation {
  /** 観測対象（例: `job:<id>`）。 */
  watch: string
  /** 再評価の契機。現状 PL tick だけが再評価を起こす。 */
  reevaluateOn: 'pl_tick'
  /** ここを超えても変わらなければ次の lane へ倒す。 */
  thresholdMs: number
  /** 待ち切ったときに進む lane。 */
  nextLane: BlockedLane
}

/**
 * 構造化された Blocked 診断。**schema は必要最小限に留める。**
 * 欄を足したくなったら、まず既存 record から導けないかを疑うこと。
 */
export interface BlockedDiagnosis {
  rootCauseClass: BlockedRootCauseClass
  blockingLayer: BlockingLayer
  evidence: readonly BlockedEvidence[]
  /**
   * CEO 判断を要さないレーン（auto_recovery / independent_remediation）で
   * blocker そのものを取り除きうるか。
   */
  recoverable: boolean
  /** **提案であって permission ではない。** Gate bypass には決して使わない。 */
  recommendedLane: BlockedLane
  requiresAuthorityChange: boolean
  requiresSafetyBoundaryChange: boolean
  irreversible: boolean
  /** いま配線済みの既存復旧操作が実在するか（rekick / resume / 自動 retry 等）。 */
  existingRecoveryAvailable: boolean
  /** `low` は「機械的事実で特定できなかった」の意味。**low で自動実行はしない。** */
  confidence: 'high' | 'low'
  observation?: BlockedObservation
  /** 人間向けの説明。**routing には一切使わない。** */
  summary: string
}

// ────────────────────────────────────────────────────────────
// protected file の判定
// ────────────────────────────────────────────────────────────

/**
 * 違反ファイルのうち、**allowedPaths を直しても絶対に書けない**もの。
 *
 * 判定は Guard 本体の export をそのまま使う。**一覧を複製しない**（複製すると必ずずれる）。
 */
export function protectedViolations(fileViolations: readonly string[] | undefined): string[] {
  return (fileViolations ?? []).filter(
    (file: string) => ALWAYS_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file)),
  )
}

/**
 * protected file のうち、**Maintenance Lane（Tier B）で扱いうる** runtime / infrastructure。
 *
 * **allowlist であることが安全性質の中心である。** `ALWAYS_FORBIDDEN_PATTERNS` は今後も増えるが、
 * ここへ足さない限り新しい protected path は既定で `safety_or_authority_boundary` = CEO へ倒れる。
 * 逆向き（未知のものを Maintenance へ倒す）にすると、Guard が1行増えるたびに
 * 静かに CEO を迂回する経路が生まれる。
 *
 * ここに載るのは「Job 実行エンジン・Worker 起動・provider adapter」だけで、
 * Safety Policy・Gate・Approval・permission・認証・secret は**1つも含まない**。
 */
const MAINTENANCE_ELIGIBLE_PROTECTED: readonly RegExp[] = Object.freeze([
  /jobRunner/i,
  /^apps\/worker\/src\/index\.ts$/i,
  /^apps\/worker\/src\/aiCli\/adapter\.ts$/i,
  /metaReviewer\/geminiClient/i,
])

/** secret そのもの。復旧でも維持でもなく、**AI が触れてはならない**もの。 */
const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|\/)\.env$/i,
  /(^|\/)\.env\./i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)id_ed25519/i,
  /service-account\.json$/i,
  /\.secrets/i,
])

/**
 * Maintenance Lane で扱ってよい protected file か。
 *
 * **secret は何があっても対象外にする。** allowlist の pattern は `/jobRunner/i` のように
 * 語単位で、パス全体を固定していない。そのため `apps/worker/src/jobRunner.key` のような
 * 名前は「maintenance 対象」と「secret」の両方に一致しうる —— secret を先に落とさないと、
 * **秘密ファイルが Maintenance Lane へ流れる**（独立レビュー指摘 2026-09-18）。
 */
function isMaintenanceEligible(file: string): boolean {
  if (isSecret(file)) return false
  return MAINTENANCE_ELIGIBLE_PROTECTED.some((pattern) => pattern.test(file))
}

function isSecret(file: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(file))
}

// ────────────────────────────────────────────────────────────
// Design Review の判定を実レコードから読む
// ────────────────────────────────────────────────────────────

/** 最新 Design Review run の機械的な要約。**判定は `resultJson` の実値から読む。** */
export interface LatestDesignReviewVerdict {
  runId: string
  status: DesignReviewRun['status']
  attemptCount: number
  /**
   * 結果 JSON が存在したか。**`decision` の有無とは別である。**
   *
   * run が結果を持っていても `finalDecision` を持たない形はある（例:
   * `{"focusedReviewResults":[{"focus":"scope_simplicity","decision":"CONFLICT"}]}` —— これは
   * #255 が実際に書く CONFLICT の形である）。「結果が無い」と「判定欄が読めない」を
   * 同じ扱いにすると、**結果はあるのに『結果なし』の短い文面**を人へ出すことになる。
   */
  hasResult: boolean
  /** `finalDecision`（ALIGNED / CONFLICT / UNCERTAIN / REVIEW_UNAVAILABLE）。読めなければ undefined。 */
  decision?: string
  /** Integration Review の要約。**人向けの説明にだけ使う。** */
  summary?: string
  error?: string
}

/**
 * その Task の最新 Design Review run を、**終端したものも含めて**読む。
 *
 * `findActiveByTaskId()` は queued / running しか返さないため、CONFLICT で終わった run が
 * 見えない。停止理由の特定にはそれが要る。
 */
export function readLatestDesignReview(
  storage: IStorage,
  taskId: string,
): LatestDesignReviewVerdict | undefined {
  const run = storage.designReviewRuns.findLatestByTaskId(taskId)
  if (!run) return undefined

  const base: LatestDesignReviewVerdict = {
    runId: run.id,
    status: run.status,
    attemptCount: run.attemptCount,
    hasResult: run.resultJson !== undefined,
    ...(run.error !== undefined ? { error: run.error } : {}),
  }
  if (run.resultJson === undefined) return base

  try {
    const parsed = JSON.parse(run.resultJson) as Record<string, unknown>
    const decision = parsed.finalDecision
    const summary = (parsed.integrationReviewResult as Record<string, unknown> | undefined)?.summary
    return {
      ...base,
      ...(typeof decision === 'string' ? { decision } : {}),
      ...(typeof summary === 'string' ? { summary } : {}),
    }
  } catch {
    // 壊れた resultJson は「判定が読めなかった」として扱う。ここで投げると Triage 全体が止まる。
    // **`hasResult` は true のまま**である（結果は存在した。読めなかっただけである）。
    return base
  }
}

// ────────────────────────────────────────────────────────────
// 分類
// ────────────────────────────────────────────────────────────

interface Facts {
  item: AttentionItem
  job?: Job
  taskJobs: readonly Job[]
  approvalStatus?: string
  approvalId?: string
  review?: LatestDesignReviewVerdict
  alignedEvidenceId?: string
}

function gatherFacts(storage: IStorage, item: AttentionItem): Facts {
  const job = item.jobId !== undefined ? storage.jobs.findById(item.jobId) : undefined
  const taskJobs = item.taskId !== undefined ? storage.jobs.findByTaskId(item.taskId) : []
  const approval =
    item.taskId !== undefined ? storage.approvalRequests.findActiveByTaskId(item.taskId) : undefined
  const review = item.taskId !== undefined ? readLatestDesignReview(storage, item.taskId) : undefined
  const evidence =
    item.taskId !== undefined
      ? storage.designReviewEvidence.findLatestByTaskId(item.taskId)
      : undefined

  return {
    item,
    ...(job !== undefined ? { job } : {}),
    taskJobs,
    ...(approval !== undefined ? { approvalStatus: approval.status, approvalId: approval.id } : {}),
    ...(review !== undefined ? { review } : {}),
    ...(evidence?.decision === 'ALIGNED' && evidence.reviewKind === 'task'
      ? { alignedEvidenceId: evidence.id }
      : {}),
  }
}

/**
 * 既定値。各 rule は違う欄だけを上書きする。
 *
 * **既定の lane は `ceo_escalation` である。** rule が機械的事実を根拠に明示的に降ろさない限り、
 * 診断は人へ上がる（欄を1つ書き忘れて安全側から外れることが無いようにするため）。
 */
function base(item: AttentionItem): BlockedDiagnosis {
  return {
    rootCauseClass: 'unknown',
    blockingLayer: 'unknown',
    evidence: [],
    recoverable: false,
    recommendedLane: 'ceo_escalation',
    requiresAuthorityChange: false,
    requiresSafetyBoundaryChange: false,
    irreversible: false,
    existingRecoveryAvailable: false,
    confidence: 'low',
    summary: `${item.kind}: ${item.detail}`,
  }
}

/**
 * 既存の provider timeout 自動 retry が**既に作られているか**。
 *
 * API は条件を満たす implement Job の timeout に対して `retry:<jobId>:1` を1回だけ作る
 * （`persistProviderTimeoutFailure()`）。それが既にある状態で PL がさらに retry を提案すると、
 * 同じ失敗を二重に押し進めることになる。ここが `true` なら「待つ」が正しい。
 */
function hasAutomaticRetryJob(facts: Facts, jobId: string): boolean {
  return facts.taskJobs.some((job) => job.workflowStepKey === `retry:${jobId}:1`)
}

/** この Task に、いま動かせる Job があるか（あれば resume は要らないし通らない）。 */
function hasLiveJob(facts: Facts): boolean {
  return facts.taskJobs.some((job) => job.status === 'queued' || job.status === 'running')
}

/**
 * Blocked の原因を機械的事実から分類し、渡すべきレーンを選ぶ。
 *
 * **`AttentionItem` と storage しか受け取らない。** PL の自然言語・riskLevel 申告は
 * 引数に存在しないので、**自己申告で分類を動かすことが構造的にできない**。
 */
/**
 * 直近 Design Review run の判定を、**API 側の再計算で**求める。
 *
 * `findRemediationSubject()`（#255）が Remediation 対象を決めるのに使っているのと同じ
 * `recomputeDecision()` を通す。**判定ロジックをここに書き写さない** —— 2箇所に書くと、
 * 同じ run に対して Triage と Remediation が違う結論を出す。
 * 読めない・再計算できないものは `undefined`（＝ CONFLICT と決めつけない。fail-closed）。
 */
function recomputedDecisionOf(storage: IStorage, taskId: string | undefined): string | undefined {
  if (taskId === undefined) return undefined
  const run = storage.designReviewRuns.findLatestByTaskId(taskId)
  if (!run?.resultJson) return undefined
  try {
    const raw = JSON.parse(run.resultJson) as RawStrategicResult
    return recomputeDecision(raw, 'task', run.changedFiles).decision
  } catch {
    return undefined
  }
}

export function triageBlocked(storage: IStorage, item: AttentionItem): BlockedDiagnosis {
  const facts = gatherFacts(storage, item)
  const result = base(item)

  // ── 1. protected / secret。allowedPaths では絶対に解決しない ──────────────
  const violations = protectedViolations(facts.job?.guardResult?.fileViolations)
  if (violations.length > 0) {
    const secrets = violations.filter(isSecret)
    const policyCore = violations.filter((file) => !isMaintenanceEligible(file))
    const evidence: BlockedEvidence[] = [
      {
        fact: 'job.guardResult.fileViolations (always-forbidden)',
        ...(facts.job !== undefined ? { id: facts.job.id } : {}),
        value: violations.join(', '),
      },
    ]

    if (policyCore.length > 0) {
      return {
        ...result,
        rootCauseClass: 'safety_or_authority_boundary',
        blockingLayer: 'file_change_guard',
        evidence,
        requiresSafetyBoundaryChange: true,
        requiresAuthorityChange: true,
        irreversible: secrets.length > 0,
        confidence: 'high',
        recommendedLane: 'ceo_escalation',
        summary:
          'この Task は Safety / Authority 中核ファイルを要求している'
          + `（${policyCore.join(', ')}）。どんな allowedPaths でも通らない。`,
      }
    }

    return {
      ...result,
      rootCauseClass: 'protected_path',
      blockingLayer: 'file_change_guard',
      evidence,
      confidence: 'high',
      recommendedLane: 'maintenance_lane',
      summary:
        'この Task は protected な runtime / infrastructure ファイルを要求している'
        + `（${violations.join(', ')}）。通常 Executor では扱えない。`,
    }
  }

  // ── 2. workspace quarantine ──────────────────────────────────────────
  // 解除には Worker による workspace 観測が要り、`clear_workspace_quarantine` は
  // `safety_review`（`UNVERIFIABLE_GATES`）を要求する。PL 単独では構造的に充足できない。
  if (facts.job?.failureMetadata?.quarantined === true) {
    return {
      ...result,
      rootCauseClass: 'workspace_quarantined',
      blockingLayer: 'workspace',
      evidence: [
        {
          fact: 'job.failureMetadata.quarantineReason',
          id: facts.job.id,
          value: facts.job.failureMetadata.quarantineReason ?? 'quarantined',
        },
      ],
      confidence: 'high',
      recommendedLane: 'ceo_escalation',
      summary: 'workspace が未検証のまま隔離されている。解除には workspace の観測と検証が要る。',
    }
  }

  // ── 3. File Change Guard の scope 違反（protected ではない）────────────────
  const scopeViolations = facts.job?.guardResult?.fileViolations ?? []
  if (facts.job?.guardResult?.fileChangeAllowed === false && scopeViolations.length > 0) {
    return {
      ...result,
      rootCauseClass: 'allowed_paths_mismatch',
      blockingLayer: 'file_change_guard',
      evidence: [
        {
          fact: 'job.guardResult.fileViolations',
          id: facts.job.id,
          value: scopeViolations.join(', '),
        },
      ],
      recoverable: true,
      confidence: 'high',
      recommendedLane: 'independent_remediation',
      summary:
        '宣言した allowedPaths と実際に必要な変更対象がずれている。'
        + '同じ設計のまま再実行しても同じ違反になる。',
    }
  }

  // ── 4. 生きている承認待ち。止めているのは人の判断そのもの ──────────────────
  if (item.kind === 'approval_waiting') {
    return {
      ...result,
      rootCauseClass: 'approval_waiting',
      blockingLayer: 'approval',
      evidence: [
        {
          fact: 'approval_request.status',
          ...(facts.approvalId !== undefined ? { id: facts.approvalId } : {}),
          value: facts.approvalStatus ?? 'WAITING_FOR_USER',
        },
      ],
      confidence: 'high',
      recommendedLane: 'ceo_escalation',
      summary: 'CEO の承認待ちで止まっている。AI 側にできることは無い。',
    }
  }

  // ── 4.5 blocked かつ Job 0 件。**配線済みの復旧経路がどれも構造的に届かない** ──────
  //
  // `remediateConflict()`（#255）は `findRemediationSubject()` が `status === 'pending'` を
  // 要求するため、この Task を**一度も試さない**。`resumeBlockedTask()` は latestJob から
  // 新 Job を組み立てるので Job 0 件では必ず失敗する。つまり下の 5 と同じ CONFLICT でも、
  // この状態にあるものは Remediation レーンへ渡してはならない ——
  // 渡すと CEO には「Remediation を試したが解決しなかった」と読める報告が届く（実際は未実行）。
  //
  // **判定を書き直さない。** 「blocked かつ Job 0 件」の判定は `systemState.ts` が
  // `task_blocked_without_job` として既に行っており、ここはその結論を使うだけである。
  //
  // 解けるのは CEO の明示操作（Human Recovery）だけなので `ceo_escalation` で終端する。
  if (item.kind === 'task_blocked_without_job') {
    const stalled = facts.review
    // **判定は runner の自己申告ではなく API 側の再計算で決める。**
    //
    // `readLatestDesignReview()` が返す `decision` は top-level `finalDecision` の生値である。
    // #255 が書く CONFLICT は `{"focusedReviewResults":[...]}` だけで **`finalDecision` を持たない**
    // ので、生値で `=== 'CONFLICT'` と比べると**本番で最も多い形が丸ごと漏れる**
    // （独立レビュー round 3 指摘。round 2 で「ALIGNED 以外」を絞った際に入れた退行）。
    // 逆に、壊れた出力が `finalDecision: 'CONFLICT'` と自己申告していても信用してはならない。
    //
    // よって `findRemediationSubject()` と**同一の** `recomputeDecision()` を通す。
    // 2つの経路が同じ入力を違う判定にすることが無くなる。
    // **判定は1度だけ再計算し、分類・証拠・本文の全部で同じ値を使う。**
    // 分類を再計算値で行いながら本文へ生値を出すと、#255 形では
    // 「Design Review は undefined」と書かれた high-confidence な CONFLICT 報告になる
    // （独立レビュー round 4 指摘）。
    const recomputed = recomputedDecisionOf(storage, item.taskId)
    const reviewIsConflict = stalled?.status === 'succeeded' && recomputed === 'CONFLICT'

    return {
      ...result,
      // 原因の語彙は増やさない。CONFLICT で止まったならそれが原因であり、
      // この分岐が変えるのは**レーン**（到達可能性）だけである。
      rootCauseClass: reviewIsConflict ? 'design_review_conflict' : 'unknown',
      blockingLayer: reviewIsConflict ? 'design_review' : 'job_creation',
      evidence: [
        { fact: 'task.status', ...(item.taskId !== undefined ? { id: item.taskId } : {}), value: 'blocked' },
        { fact: 'jobs.count', value: '0' },
        ...(stalled !== undefined
          ? [{
            fact: 'design_review_run.finalDecision',
            id: stalled.runId,
            // 生値ではなく再計算値。分類と食い違う証拠を CEO へ出さない。
            value: `${recomputed ?? stalled.decision ?? 'unknown'} (status=${stalled.status})`,
          }]
          : []),
      ],
      recoverable: true,
      // CONFLICT が読めているときだけ原因を断定できる。読めないなら状態しか分かっていない。
      confidence: reviewIsConflict ? 'high' : 'low',
      recommendedLane: 'ceo_escalation',
      summary:
        'Task が blocked のまま Job を1件も持っておらず、配線済みの自動復旧経路が'
        + '構造的にどれも到達できない（Independent Remediation は pending を、'
        + 'resume は既存 Job を要求する）。'
        + (reviewIsConflict
          ? `直近の task-kind Design Review は ${recomputed} で、evidence が登録されていない。`
          : '')
        + ' CEO が Human Recovery（`POST /api/tasks/:id/recover`）で既存ループへ戻すか、'
        + '訂正した implementationScope / allowedPaths で採用し直す必要がある。',
    }
  }

  // ── 5. Design Review が ALIGNED を出していない ─────────────────────────
  const review = facts.review
  if (review !== undefined) {
    const reviewEvidence: BlockedEvidence[] = [
      {
        fact: 'design_review_run.finalDecision',
        id: review.runId,
        value:
          `${review.decision ?? 'unknown'} `
          + `(status=${review.status}, attempt=${review.attemptCount}/${DESIGN_REVIEW_MAX_ATTEMPTS})`,
      },
    ]

    if (
      review.status === 'succeeded'
      && review.decision !== undefined
      && review.decision !== 'ALIGNED'
    ) {
      return {
        ...result,
        rootCauseClass: 'design_review_conflict',
        blockingLayer: 'design_review',
        evidence: reviewEvidence,
        recoverable: true,
        confidence: 'high',
        recommendedLane: 'independent_remediation',
        summary:
          `task-kind Design Review が ${review.decision} を返しており evidence が登録されていない。`
          + (review.summary !== undefined ? ` 理由: ${review.summary}` : '')
          + ' これは Binding Review であり、PL も元の設計者も判定を覆せない。',
      }
    }

    if (review.status !== 'succeeded' && review.attemptCount >= DESIGN_REVIEW_MAX_ATTEMPTS) {
      return {
        ...result,
        rootCauseClass: 'design_review_exhausted',
        blockingLayer: 'design_review',
        evidence: reviewEvidence,
        confidence: 'high',
        recommendedLane: 'ceo_escalation',
        summary:
          `Design Review が attempt を使い切っている（${review.attemptCount}/${DESIGN_REVIEW_MAX_ATTEMPTS}）。`
          + '再kickしても claim できず、残っている bounded recovery は無い。',
      }
    }

    if (
      (review.status === 'queued' || review.status === 'failed')
      && review.attemptCount < DESIGN_REVIEW_MAX_ATTEMPTS
    ) {
      return {
        ...result,
        rootCauseClass: 'design_review_stalled',
        blockingLayer: 'design_review',
        evidence: reviewEvidence,
        recoverable: true,
        existingRecoveryAvailable: true,
        confidence: 'high',
        recommendedLane: 'auto_recovery',
        summary:
          `Design Review run が ${review.status} のまま進んでいない`
          + `（attempt ${review.attemptCount}/${DESIGN_REVIEW_MAX_ATTEMPTS}）。`
          + '既存の bounded rekick が残っている。',
      }
    }
  }

  // ── 6. provider timeout ───────────────────────────────────────────
  if (facts.job?.failureMetadata?.kind === 'provider_timeout') {
    const workspaceState = facts.job.failureMetadata.workspaceState
    const providerEvidence: BlockedEvidence[] = [
      {
        fact: 'job.failureMetadata',
        id: facts.job.id,
        value: `kind=provider_timeout workspaceState=${workspaceState ?? 'unknown'}`,
      },
    ]

    if (workspaceState !== 'unchanged') {
      return {
        ...result,
        rootCauseClass: 'provider_failure_workspace_dirty',
        blockingLayer: 'provider',
        evidence: providerEvidence,
        confidence: 'high',
        recommendedLane: 'ceo_escalation',
        summary:
          'provider が timeout したが workspace が未確定のまま残っている。'
          + '既存の自動 retry は `workspaceState=unchanged` のときだけ許されており、この Job は該当しない。',
      }
    }

    // 既存の1回限り自動 retry が既に作られているなら、**待つ**のが正しい。
    if (hasAutomaticRetryJob(facts, facts.job.id)) {
      return {
        ...result,
        rootCauseClass: 'provider_transient',
        blockingLayer: 'provider',
        evidence: [
          ...providerEvidence,
          { fact: 'jobs.workflowStepKey', value: `retry:${facts.job.id}:1 exists` },
        ],
        recoverable: true,
        existingRecoveryAvailable: true,
        confidence: 'high',
        recommendedLane: 'auto_recovery',
        observation: {
          watch: `job:${facts.job.id} -> retry:${facts.job.id}:1`,
          reevaluateOn: 'pl_tick',
          thresholdMs: DEFAULT_STALL_HINT_MS,
          nextLane: 'ceo_escalation',
        },
        summary: '既存の1回限り自動 retry が既に作られている。二重に押し進めず、その結果を待つ。',
      }
    }

    return {
      ...result,
      rootCauseClass: 'provider_transient',
      blockingLayer: 'provider',
      evidence: providerEvidence,
      recoverable: true,
      existingRecoveryAvailable: true,
      confidence: 'high',
      recommendedLane: 'auto_recovery',
      summary: 'provider の一時障害で止まっている。既存 policy が retry 可能と定めている形である。',
    }
  }

  // ── 7. blocked Job + 既存 resume 経路が使える ────────────────────────
  //
  // ここまでのどの rule にも当たらない blocked Job は、承認サイクルが完了していないことで
  // 止まっている（Guard 違反と quarantine は上で処理済み、生きている承認待ちは
  // `systemState` が `job_blocked` に出さない）。承認行が **STALE / EXPIRED / REJECTED でも、
  // そもそも発行されていなくても**、進め方は同じ1つ —— 既存 resume が
  // **新しい**承認サイクルを始める（古い承認は再利用も再承認もされない）。
  //
  // 「承認行が存在すること」を条件にしない。実測（2026-09-15 production）で復旧不能になったのは
  // まさに承認行が実質使えない状態であり、そこを条件にすると復旧対象そのものを外す。
  if (facts.job?.status === 'blocked' && !hasLiveJob(facts)) {
    return {
      ...result,
      rootCauseClass: 'approval_not_actionable',
      blockingLayer: 'approval',
      evidence: [
        {
          fact: 'approval_request.status',
          ...(facts.approvalId !== undefined ? { id: facts.approvalId } : {}),
          value: facts.approvalStatus ?? 'none',
        },
        { fact: 'job.status', id: facts.job.id, value: 'blocked' },
      ],
      recoverable: true,
      existingRecoveryAvailable: true,
      confidence: 'high',
      recommendedLane: 'auto_recovery',
      summary:
        `承認が ${facts.approvalStatus ?? '未発行'} で、その行では誰も進められない。`
        + '既存 resume は新しい承認サイクルを開始する（古い承認を再利用しない）。',
    }
  }

  // ── 8. ALIGNED なのに Job が作られていない ────────────────────────────
  if (item.kind === 'task_ready_without_job' && facts.alignedEvidenceId !== undefined) {
    return {
      ...result,
      rootCauseClass: 'task_ready_without_job',
      blockingLayer: 'job_creation',
      evidence: [
        { fact: 'design_review_evidence.decision', id: facts.alignedEvidenceId, value: 'ALIGNED' },
        { fact: 'jobs.count', value: String(facts.taskJobs.length) },
      ],
      confidence: 'high',
      recommendedLane: 'ceo_escalation',
      summary:
        'ALIGNED evidence が登録されているのに実装 Job が作られていない。'
        + 'PL に Job 生成の権限は無く、配線されている既存復旧も無い。',
    }
  }

  // ── 9. 特定できなかった。**推測で retry しない** ───────────────────────
  return {
    ...result,
    summary: '機械的事実から原因を特定できなかった。証拠不足のまま状態を変える操作は行わない。',
  }
}

// ────────────────────────────────────────────────────────────
// narrowing —— lane は候補を減らすことしかできない
// ────────────────────────────────────────────────────────────

/** 読み取りだけで状態を変えない応答。証拠不足のとき PL に残すのはこれだけである。 */
const READ_ONLY_RESPONSES: readonly string[] = Object.freeze(['observe_state', 'escalate_to_ceo'])

/**
 * Triage の結果で、PL に提案させてよい action を**絞る**。
 *
 * **必ず既存候補との積を返す。** `baseline` に無い action がここから増えることは無いので、
 * Triage が新しい権限を作ることは構造的に起こらない。
 *
 * - `auto_recovery` … 既存候補のまま（絞らない）
 * - それ以外 + `confidence: 'low'` … 読み取り専用の応答だけ（証拠不足で状態を変えない）
 * - それ以外 … `escalate_to_ceo` だけ
 *
 * **正確な不変条件**: 戻り値は `baseline` の部分集合であるか、それに `escalate_to_ceo` を
 * 1つ足したものである。`escalate_to_ceo` を足すのは、Policy が BLOCK のたびに PL へ残すと
 * 保証している応答だからで、落とすと「PL に残された4つの行動」が取れなくなる。
 * **この1つ以外は決して足さない。** `escalate_to_ceo` は `ACTION_GATE_TABLE` 上 Gate を持たず
 * forbidden にもならない唯一の write 操作なので、足しても権限は増えない。
 */
export function triageAllowedActions(
  diagnosis: BlockedDiagnosis,
  baseline: readonly string[],
): readonly string[] {
  if (diagnosis.recommendedLane === 'auto_recovery') return baseline
  const permitted = diagnosis.confidence === 'low' ? READ_ONLY_RESPONSES : ['escalate_to_ceo']
  const narrowed = baseline.filter((kind) => permitted.includes(kind))
  return narrowed.includes('escalate_to_ceo') ? narrowed : [...narrowed, 'escalate_to_ceo']
}

/** provider 診断を回す価値があるか。escalate しか選べないなら回すだけ無駄である。 */
export function needsProviderDiagnosis(allowed: readonly string[]): boolean {
  return allowed.some((kind) => kind !== 'escalate_to_ceo')
}

// ────────────────────────────────────────────────────────────
// CEO へ渡す構造化された報告
// ────────────────────────────────────────────────────────────

/** その診断で CEO に求める判断と、**複数の**安全な選択肢。1つに決め打ちしない。 */
function ceoDecisionAndOptions(diagnosis: BlockedDiagnosis): { decision: string; options: string[] } {
  if (diagnosis.recommendedLane === 'maintenance_lane') {
    return {
      decision:
        'protected な runtime / infrastructure への最小変更を、Maintenance Lane（Tier B）として '
        + '外部実行者へ出してよいか。',
      options: [
        'Tier B として最小差分だけを外部実行者へ出し、Independent Review / CI を通して '
        + '`reconcile_external_completion` で戻す',
        'protected 領域に触れない代替設計を Independent Remediation へ回す',
        'この Task を park する（`abort_task`）',
      ],
    }
  }
  if (diagnosis.recommendedLane === 'independent_remediation') {
    // Design Review CONFLICT はここへ来た時点で Remediation を**既に試して**解決しなかった
    // （配線済みの経路が Triage の手前で走るため）。同じ手をもう一度勧めない。
    return diagnosis.rootCauseClass === 'design_review_conflict'
      ? {
        decision:
          'Independent Remediation では解決しませんでした。この設計をどう扱うか。',
        options: [
          '対象項目の実装範囲を CEO が直接指定し直す',
          'Design Review の指摘そのものを見直す（Second Independent Review / Meta Review）',
          'この Task を park する（`abort_task`）',
        ],
      }
      : {
        decision: '設計・scope の訂正を、元の設計者ではなく独立した経路へ回してよいか。',
        options: [
          '対象項目の allowedPaths と実装範囲を CEO が指定し直す',
          'この原因にも Remediation を配線するかを別項目として判断する',
          'この Task を park する（`abort_task`）',
        ],
      }
  }

  switch (diagnosis.rootCauseClass) {
    case 'safety_or_authority_boundary':
      return {
        decision:
          'Safety Boundary / Authority に触れる変更である。AI に実行させてよいかは CEO だけが決められる。',
        options: [
          '対象ファイルに触れない代替設計へ切り替える',
          'CEO 承認のうえ外部セッション（Tier B）で最小差分だけ実装する',
          'この Task を park する（`abort_task`）',
        ],
      }
    case 'workspace_quarantined':
      return {
        decision: '隔離された workspace を検証して再受け入れしてよいか。',
        options: [
          'workspace を観測・検証したうえで quarantine を解除する',
          'この Task を park して workspace を作り直す',
        ],
      }
    case 'approval_waiting':
      return {
        decision: '待っている承認そのもの。',
        options: ['Mobile から承認する', '却下して別の設計へ回す'],
      }
    // `independent_remediation` レーンは上で早期 return するので、ここへ来る CONFLICT は
    // **Remediation が構造的に届かないもの**（blocked かつ Job 0 件）だけである。
    // したがって「もう一度 Remediation へ」は選択肢にならない。まず再投入が要る。
    case 'design_review_conflict':
      return {
        decision:
          'CONFLICT で止まった Task が、自動復旧経路から外れた状態にある。どう戻すか。',
        options: [
          'Human Recovery（`POST /api/tasks/:id/recover`）で既存ループへ戻し、'
          + 'Independent Remediation に fresh Design Review を起こさせる',
          // **順序を書かないと実行できない選択肢になる。** `syncRoadmapTasks()` は
          // `status === 'pending'` の Task しか可変として扱わないので、blocked のまま
          // 採用し直すと `SYNC_FAILED` で弾かれる（独立レビュー round 2 指摘）。
          'まず Human Recovery で `pending` へ戻し、**そのうえで**訂正した '
          + 'implementationScope / allowedPaths で Roadmap 項目を採用し直す'
          + '（CONFLICT の原因が ledger 本文の陳腐化なら、先に本文を訂正する）。'
          + '**blocked のまま採用し直すと `SYNC_FAILED` になる**',
          'この Task を park する（`abort_task`）',
        ],
      }
    case 'design_review_exhausted':
      return {
        decision: 'bounded retry を使い切った Design Review をどう扱うか。',
        options: [
          'Review 基盤側の障害を直してから新しい run を作る',
          '設計を訂正して Independent Remediation から fresh Review を起こす',
          'この Task を park する（`abort_task`）',
        ],
      }
    case 'provider_failure_workspace_dirty':
      return {
        decision: 'workspace が未確定のまま残った Job をどう扱うか。',
        options: [
          'workspace を観測・検証してから Job を終端させる',
          'この Task を park して作り直す',
        ],
      }
    case 'task_ready_without_job':
      return {
        decision: 'ALIGNED なのに Job が作られない原因の調査をどう進めるか。',
        options: [
          '実装 Job を作る既存経路（採用のやり直し）を CEO 承認のうえ実行する',
          'この Task を park して別項目へ進む',
        ],
      }
    default:
      return {
        decision: '原因を機械的事実から特定できなかった。次にどこへ進めるか。',
        options: [
          '追加の read-only 調査を指示する',
          '独立した診断者へ回す',
          'この Task を park して別項目へ進む',
        ],
      }
  }
}

export interface TriageEscalationInput {
  diagnosis: BlockedDiagnosis
  item: AttentionItem
  /** これまでにこの対象へ試したこと。`audit_log` の実記録から作る。 */
  attemptHistory: readonly string[]
  /** なぜ今 AI 側で解決できないか。lane の実装状況を含めて書く。 */
  blockedReason: string
}

/**
 * CEO へ渡す本文。**「Blocked です」で終わらせない。**
 *
 * 載せるのは7項目（何が止まったか / 原因 / 証拠 / AI が試したこと / なぜ自己解決できないか /
 * 何の CEO 判断が必要か / 安全な選択肢）で、**選択肢は必ず複数**にする。
 * PL が CEO の選択肢を1つに決めてはならない。
 */
export function buildTriageEscalationBody(input: TriageEscalationInput): string {
  const { diagnosis, item } = input
  const { decision, options } = ceoDecisionAndOptions(diagnosis)

  const lines: string[] = [
    `何が止まったか: ${item.kind} — ${item.detail}`,
    `対象: Project ${item.projectName}`
      + `${item.taskId !== undefined ? ` / Task ${item.taskId}` : ''}`
      + `${item.jobId !== undefined ? ` / Job ${item.jobId}` : ''}`,
    `原因: ${diagnosis.rootCauseClass}（${diagnosis.blockingLayer} 層, confidence=${diagnosis.confidence}）`,
    `原因の説明: ${diagnosis.summary}`,
    '証拠:',
    ...(diagnosis.evidence.length > 0
      ? diagnosis.evidence.map(
        (fact) => `  - ${fact.fact}${fact.id !== undefined ? ` [${fact.id}]` : ''} = ${fact.value}`,
      )
      : ['  - （機械的事実からは証拠を取れなかった）']),
    'AI が試したこと:',
    ...(input.attemptHistory.length > 0
      ? input.attemptHistory.map((line) => `  - ${line}`)
      : ['  - （この対象に対する実行は無い）']),
    `なぜ AI だけで解決できないか: ${input.blockedReason}`,
    `選ばれたレーン: ${diagnosis.recommendedLane}`,
    `必要な CEO 判断: ${decision}`,
    '安全な選択肢:',
    ...options.map((option, index) => `  ${index + 1}. ${option}`),
    'PL は BLOCK を覆せません。上の選択肢はいずれも既存の Gate をそのまま通ります。',
  ]

  if (diagnosis.observation !== undefined) {
    lines.push(
      `観測条件: ${diagnosis.observation.watch} を ${diagnosis.observation.reevaluateOn} ごとに再評価し、`
      + `${Math.round(diagnosis.observation.thresholdMs / 1000)}s を超えたら `
      + `${diagnosis.observation.nextLane} へ進める。`,
    )
  }

  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────
// 観測（既存 audit_log に相乗りする）
// ────────────────────────────────────────────────────────────

/** `audit_log.detail` の先頭に置く構造化欄。後ろの散文とは役割が違う。 */
export function formatTriageAuditDetail(diagnosis: BlockedDiagnosis): string {
  return (
    `lane=${diagnosis.recommendedLane} cause=${diagnosis.rootCauseClass} `
    + `layer=${diagnosis.blockingLayer} conf=${diagnosis.confidence}`
  )
}

export interface ParsedTriageDetail {
  lane: BlockedLane
  cause: BlockedRootCauseClass
  confidence: 'high' | 'low'
}

/**
 * `audit_log.detail` から構造化欄だけを読む。**散文は読まない。**
 * 既知の語彙に一致しない値は捨てる（集計へ未知の値を混ぜない）。
 */
export function parseTriageAuditDetail(detail: string | undefined): ParsedTriageDetail | undefined {
  if (detail === undefined) return undefined
  const lane = /\blane=([a-z_]+)/.exec(detail)?.[1]
  const cause = /\bcause=([a-z_]+)/.exec(detail)?.[1]
  const confidence = /\bconf=(high|low)/.exec(detail)?.[1]
  if (lane === undefined || cause === undefined || confidence === undefined) return undefined
  if (!(BLOCKED_LANES as readonly string[]).includes(lane)) return undefined
  if (!(BLOCKED_ROOT_CAUSE_CLASSES as readonly string[]).includes(cause)) return undefined
  return {
    lane: lane as BlockedLane,
    cause: cause as BlockedRootCauseClass,
    confidence: confidence as 'high' | 'low',
  }
}

export interface BlockedTriageSummary {
  /** Triage を通した Blocked の総数。 */
  total: number
  byRootCause: Record<string, number>
  byLane: Record<string, number>
  /** `auto_recovery` を選んだ試行のうち `acted` として記録された割合（0〜1）。 */
  autoRecoverySuccessRate: number
  /** CEO Escalation で終端した割合（0〜1）。 */
  ceoEscalationRate: number
  /** 原因を特定できなかった割合（0〜1）。 */
  unknownRate: number
  /** 同じ (対象, rootCause) が2回以上出た件数。再発の目安。 */
  recurringRootCauses: number
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

/**
 * 既存 `audit_log` の行から Triage の実績を導く。**新しい metrics backend は作らない。**
 *
 * 「CEO へ上げた Blocked のうち、実は AI だけで解決できたものが何％だったか」を後から
 * 分析するための最小の分母・分子をここで固定する。
 */
export function summarizeBlockedTriage(entries: readonly AuditLogEntry[]): BlockedTriageSummary {
  const byRootCause: Record<string, number> = {}
  const byLane: Record<string, number> = {}
  const seen = new Map<string, number>()
  let total = 0
  let autoRecoveryAttempts = 0
  let autoRecoveryActed = 0
  let escalated = 0
  let unknown = 0
  let recurringRootCauses = 0

  for (const entry of entries) {
    const parsed = parseTriageAuditDetail(entry.detail)
    if (parsed === undefined) continue

    total += 1
    byRootCause[parsed.cause] = (byRootCause[parsed.cause] ?? 0) + 1
    byLane[parsed.lane] = (byLane[parsed.lane] ?? 0) + 1
    if (parsed.cause === 'unknown') unknown += 1
    if (entry.result === 'escalated') escalated += 1
    if (parsed.lane === 'auto_recovery') {
      autoRecoveryAttempts += 1
      if (entry.result === 'acted') autoRecoveryActed += 1
    }

    const key = `${entry.entityId}|${parsed.cause}`
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count === 2) recurringRootCauses += 1
  }

  return {
    total,
    byRootCause,
    byLane,
    autoRecoverySuccessRate: rate(autoRecoveryActed, autoRecoveryAttempts),
    ceoEscalationRate: rate(escalated, total),
    unknownRate: rate(unknown, total),
    recurringRootCauses,
  }
}
