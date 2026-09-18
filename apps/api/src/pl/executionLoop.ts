/**
 * VPS PL Execution Loop — PL 判断を VPS 上で 1 tick 進める。
 *
 * ローカル PC や外部セッションが無くても、PL が
 * `Observe → Diagnose → Decide → Mandatory Gate → Execute existing action → Verify →
 * Continue / Escalate` を回せる状態にするための最小実装である。
 *
 * ## 何を「作っていない」か（重要）
 *
 * - **新しい state store を作っていない。** Observe は `buildSystemState()`（`GET /api/state` の
 *   実体）をそのまま使う。PL 専用の状態収集経路は存在しない
 * - **新しい Gate / Review を作っていない。** 操作の可否は `authorizePlAction()` だけが決める
 * - **新しい Recovery subsystem を作っていない。** 実行するのは既存の正式操作だけで、
 *   ここには復旧ロジックそのものが無い（`executeDesignReviewRun()` を呼ぶだけ）
 * - **新しいテーブルを作っていない。** tick の履歴と attempt 数は既存 `audit_log` に載せる
 * - **新しい常駐プロセスを作っていない。** 1 tick は 1 回の関数呼び出しで、
 *   起動元（`POST /api/pl/tick` / API の任意 interval）は呼ぶだけである
 *
 * ## PL に許していないこと
 *
 * PL の出力は**外部プロセス（provider CLI）由来の文字列**であり、実行コマンドとして信用しない。
 * ここが受け取るのは「既知 action kind の名前」だけで、それ以外は
 * `resolvePlActionPolicy()` が未知値として `forbidden` に倒す。Gate の要否・CEO Approval の要否・
 * BLOCK 結果は PL 側から一切変更できない（`authorizePlAction()` が提案から判定を作り直す）。
 *
 * ## 無限自己修復ループを作らない
 *
 * 同じ対象に対する PL の試行回数は `audit_log` から数えて `PL_MAX_ATTEMPTS_PER_TARGET` で
 * 打ち切る。打ち切った先は CEO Escalation であり、再試行ではない。個々の操作の retry 上限
 * （`DESIGN_REVIEW_MAX_ATTEMPTS` 等）は既存機構が持っており、ここでは緩めない。
 */

import {
  DESIGN_REVIEW_MAX_ATTEMPTS,
  buildDefaultCoordinatorDeps,
  executeDesignReviewRun,
  type CoordinatorDeps,
  type ExecuteDesignReviewResult,
} from '../designReview/designReviewCoordinator'
import { ALWAYS_FORBIDDEN_PATTERNS } from '@ai-team/worker/src/guards/fileChangeGuard.js'
import { requestText } from '../aiExplain/cheapAiClient'
import {
  buildSystemState,
  DEFAULT_STALL_HINT_MS,
  type AttentionItem,
  type SystemStateSnapshot,
} from '../state/systemState'
import {
  PL_MAX_ADOPTION_ATTEMPTS,
  runAdoptionStep,
  type PlAdoptionDeps,
  type PlAdoptionResult,
} from './adoptionStep'
import {
  countConflictAttempts,
  countRemediationAttempts,
  findRemediationSubject,
  PL_MAX_REMEDIATION_ATTEMPTS,
  recordRemediationFailure,
  runRemediationStep,
  type PlRemediationDeps,
} from './remediationStep'
import {
  runConflictResolutionRound,
  selectConflictStage,
  type ConflictResolutionDeps,
} from './conflictResolutionStep'
import type { AuditLogEntry } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'
import {
  authorizePlAction,
  PlActionBlockedError,
  requiredTargetKindFor,
  type GateEvidenceRef,
  type PlActionTarget,
} from './actionGate'

/** 1つの対象に対して PL が試せる回数。超えたら再試行せず Escalation へ倒す。 */
export const PL_MAX_ATTEMPTS_PER_TARGET = 2

/** 診断に使える時間。既存 cheap client の timeout と同じ桁に収める。 */
export const PL_DIAGNOSIS_MAX_TOKENS = 700

/** 採用提案は scope と受入条件を書くぶん少し長い。 */
export const PL_ADOPTION_MAX_TOKENS = 900

/** `audit_log` 上の語彙。新しいテーブルを足さないための相乗り先。 */
const AUDIT_OPERATION = 'pl_loop'
const AUDIT_ENTITY_TYPE = 'pl_loop_target'

/**
 * v1 で PL が実際に実行できる attention の種類。
 *
 * **ここに無い attention を PL は「放置」する（勝手に Escalation もしない）。**
 * それらは既に `GET /api/state` の `attention` に出ており、Mobile / CEO から見えている。
 * 見えているものを PL が二重に通知すると、通知が信用されなくなる
 * （ledger: `outbox-blocked-critical-false-alarm` と同じ失敗）。
 */
const ACTIONABLE_ATTENTION_KINDS: readonly AttentionItem['kind'][] = [
  'approval_waiting',
  // 採用した Task に Job が作られないまま止まる状態。**通知だけ**する（下の NOTIFY_ONLY 参照）。
  // PL に新しい権限は与えない。2026-09-15 production 実測で、ここに無かったために
  // 自律採用の直後にチェーンが**誰にも気付かれず停止**した。
  'task_ready_without_job',
  // blocked は notify-only にしない。blocked reason を読んで sanctioned な復旧を選ばせる
  // （CEO 指示・2026-09-15）。executor が無い・判断不能なら fail-closed で Escalation へ倒れる。
  'job_blocked',
  'design_review_idle',
  'design_review_failed',
  // executor はまだ無い。PL は Diagnose して操作を提案するが、復旧操作（resume / retry）は
  // workspace を書き換えるため Gate の根拠が要り、そこで止まる。試行上限に達すると CEO へ Escalation
  // される。**それが今の正しい振る舞い**である（止まったことを人へ確実に伝える）。
  // 「PL に何を実行させてよいか」は権限の問題であり、`pl-autonomous-roadmap-adoption` と同じく
  // 別途 CEO 判断で決める。ここで黙って実行可能にしない。
  'job_failed',
]

/**
 * 対応順。**先に来たものから 1 tick につき 1 件だけ**扱う。
 * 一度に全部やろうとすると、失敗が連鎖したときに何が原因か分からなくなる。
 */
const ATTENTION_PRIORITY: readonly AttentionItem['kind'][] = [
  // CEO の判断待ちが最優先。人を待たせている時間が一番長くなりやすい。
  'approval_waiting',
  // 採用したのに動き出さない Task も、人を待たせている点では同じ。
  'task_ready_without_job',
  // blocked は workflow を止めているので早く見る。
  // **`ACTIONABLE_ATTENTION_KINDS` に入れてもここに無ければ永久に選ばれない**（selectTarget が
  // この順序を走査するため）。両方に入れること。
  'job_blocked',
  'design_review_idle',
  'design_review_failed',
  // executor はまだ無い。PL は Diagnose して操作を提案するが、復旧操作（resume / retry）は
  // workspace を書き換えるため Gate の根拠が要り、そこで止まる。試行上限に達すると CEO へ Escalation
  // される。**それが今の正しい振る舞い**である（止まったことを人へ確実に伝える）。
  // 「PL に何を実行させてよいか」は権限の問題であり、`pl-autonomous-roadmap-adoption` と同じく
  // 別途 CEO 判断で決める。ここで黙って実行可能にしない。
  'job_failed',
]

export type PlTickStatus =
  /** 対象が無い、または v1 の executor が無い種類しか無い。 */
  | 'idle'
  /** 前の tick がまだ走っている。 */
  | 'skipped_in_flight'
  /** Gate を通り、既存操作を実行した。 */
  | 'acted'
  /** Gate に止められた（forbidden / 根拠不足）。実行していない。 */
  | 'blocked'
  /** 診断が構造化された既知 action にならなかった。実行していない。 */
  | 'diagnosis_unusable'
  /** 試行上限に達した、または検証で正常化しなかったため CEO へ上げた。 */
  | 'escalated'
  /** 診断そのものが失敗した（provider 障害等）。実行していない。 */
  | 'diagnosis_failed'

/** 操作後の状態再確認の結果。**「API が 200 を返した」は成功扱いにしない。** */
export type PlVerificationVerdict =
  | 'normalized'
  | 'unchanged'
  | 'different_anomaly'
  | 'needs_gate_or_ceo'

/**
 * その verdict は「復旧対象が解消した」と言えるか。
 *
 * **`normalized` だけを成功とすると、直した結果として次の工程が現れたケースを失敗と誤判定する。**
 * 実測（2026-09-14 production）: 停止していた Design Review を PL が再kickして ALIGNED・evidence 登録まで
 * 到達したのに、同じ Task に後続状態 `task_ready_without_job` が現れたため verdict は `different_anomaly` に
 * なった。**復旧操作そのものは成功している。** pipeline では「1つ解けると次が見える」のが正常であり、
 * これを Recovery 失敗として扱うと、成功するたびに CEO へ Escalation が飛ぶ。
 *
 * - `normalized` … 対象が消え、同じ subject に他の attention も無い
 * - `different_anomaly` … **対象は消えた**。同じ subject に後続の別状態が現れただけで、
 *   それは次の tick で独立した attention として扱われる
 * - `needs_gate_or_ceo` … 対象は消えたが、後続が approval 待ち / quarantine である。
 *   **PL には executor が無く人の判断が要る**ので、ここは成功扱いにしない（Escalation の対象）
 * - `unchanged` … 対象がそのまま残っている＝復旧できていない
 *
 * **新しい状態モデルは作らない。** verdict の語彙は4つのままで、判定の読み方だけをここに集約する。
 */
export function isRecoveryTargetResolved(verdict: PlVerificationVerdict): boolean {
  return verdict === 'normalized' || verdict === 'different_anomaly'
}

export interface PlTickResult {
  status: PlTickStatus
  /** 扱った attention（あれば）。 */
  target?: {
    key: string
    kind: AttentionItem['kind']
    projectId: string
    taskId?: string
    jobId?: string
  }
  /** PL が提案した action kind の生値（未知でもそのまま記録する）。 */
  proposedKind?: string
  /** 実行した既存操作の結果の要約。 */
  executionSummary?: string
  verification?: PlVerificationVerdict
  /** 人間向けの短い理由。 */
  reason?: string
  attempt?: number
}

export interface PlDiagnosisInput {
  attention: AttentionItem
  /** 対象に関係する部分だけを抜いた状態。全状態を丸ごと渡さない。 */
  context: unknown
  /** PL が選べる action kind。ここに無い値を出した場合は Policy が forbidden にする。 */
  allowedActionKinds: readonly string[]
}

export interface PlLoopDeps {
  /**
   * 原因分析。**既定は既存の provider CLI 経路**（`aiExplain/cheapAiClient` = OpenCode CLI）で、
   * 従量課金 API を新しい標準経路にしない（横断制約・2026-09-14）。
   *
   * role / model の選択は `role-model-registry` の責務であり、**ここに別の選択機構を作らない**。
   * Registry が入ったら既定実装の差し替え先はここ 1 箇所になる。
   */
  diagnose?: (input: PlDiagnosisInput) => Promise<string>
  /** Design Review の再実行。既定は既存 coordinator（attempt 上限も既存側が持つ）。 */
  rekickDesignReview?: (
    storage: IStorage,
    runId: string,
  ) => Promise<ExecuteDesignReviewResult>
  /** CEO Escalation。既定は既存 notifier（`sendAlert`）。新しい通知基盤は作らない。 */
  escalate?: (payload: { title: string; body: string }) => Promise<void>
  /** 次項目の選択と具体化。既定は診断と同じ provider CLI 経路。 */
  proposeAdoption?: PlAdoptionDeps['propose']
  /** ledger の読み取り（テスト差し替え用）。 */
  readLedger?: PlAdoptionDeps['readLedger']
  /** 採用の実行（テスト差し替え用）。既定は既存 adoptRoadmapItem。 */
  adopt?: PlAdoptionDeps['adopt']
  /** resume に添える指示文（テスト差し替え用）。既定は DEFAULT_RESUME_INSTRUCTION。 */
  resumeInstruction?: string
  /** Remediation runner の起動設定（テスト差し替え用）。 */
  remediationDeps?: PlRemediationDeps
  /**
   * CONFLICT 解決の1 Round（テスト差し替え用）。既定は `runConflictResolutionRound()`。
   *
   * **stage を選ぶのはここではない。** どの stage を実行するかは
   * `selectConflictStage()` が既存 review state と audit から決める。
   */
  resolveConflict?: typeof runConflictResolutionRound
  /** Critic / PL revision / Challenge の依存（テスト差し替え用）。 */
  conflictDeps?: ConflictResolutionDeps
  coordinatorDeps?: CoordinatorDeps
  now?: () => string
}

/**
 * 同時実行を 1 本に絞る。API は単一プロセス・単一スレッドなのでこれで足りる。
 * 重ねて走らせると、同じ run に対して 2 回 claim を試みて attempt を無駄に消費する。
 */
let inFlight = false

/**
 * PL が「実行」ではなく「人へ伝える」だけを行う attention。
 *
 * **CEO の判断そのものが進行を止めている**ケースであり、PL にできることは無い。
 * 診断（provider CLI）も回さず、1回だけ通知して終わる。通知チャネルを用意した目的が
 * まさにこれで、**承認待ちに誰も気付かないまま止まる**状態を無くす。
 */
const NOTIFY_ONLY_ATTENTION_KINDS: readonly AttentionItem['kind'][] = [
  'approval_waiting',
  // 採用した Task に Job が作られない。PL には直せない（Job 生成は Design Review evidence が要り、
  // その判定を PL が覆すことは許されない）。**だから通知だけする。**
  'task_ready_without_job',
]

/**
 * 採用直後は Job がまだ無いのが正常なので、すぐには鳴らさない。
 *
 * `createInitialImplementWorkflow()` は Job を作る前に Design Review を回す。実測（2026-09-15）で
 * その1回に **4分29秒** かかった。その間ずっと `task_ready_without_job` が立っているため、
 * 即通知にすると**採用のたびに誤報**になる。
 *
 * 既存の停滞閾値（`DEFAULT_STALL_HINT_MS` = 5分）と同じ値を使う。新しい閾値の概念を増やさない。
 */
const READY_TASK_STALL_THRESHOLD_MS = DEFAULT_STALL_HINT_MS

function targetKeyOf(item: AttentionItem): string {
  // 対象の同一性は「どの attention がどの実体に出ているか」で決まる。
  // `referenceId`（例: approval request id）があればそれを優先する。無いと
  // 「同じ Task の2回目の承認待ち」を1回目と同一視し、通知の重複排除が効きすぎる。
  const subject = item.referenceId ?? item.jobId ?? item.taskId ?? item.projectId
  return `${item.kind}:${subject}`
}

/**
 * まだ待つべき段階か。
 *
 * `task_ready_without_job` は**採用直後に必ず一度立つ**（Job を作る前に Design Review を回すため）。
 * その時点で鳴らすと採用のたびに誤報になるので、既存の停滞閾値を過ぎたものだけを対象にする。
 * 他の種類は従来どおり即座に対象とする（停滞の定義がすでに種類側に入っているため）。
 */
function hasStalledLongEnough(item: AttentionItem): boolean {
  if (item.kind !== 'task_ready_without_job') return true
  return (item.stuckForMs ?? 0) >= READY_TASK_STALL_THRESHOLD_MS
}

/**
 * 通知だけで終える attention に添える理由。
 *
 * `task_ready_without_job` は「Job が作られない」という**結果**しか持たない。原因はたいてい
 * Design Review の判定であり、それを添えないと CEO は何を判断すればよいか分からない。
 * 判定は**システムが記録した実レコード**から引く（PL の推測は載せない）。
 */
function notifyOnlyReason(storage: IStorage, item: AttentionItem): string {
  if (item.kind !== 'task_ready_without_job' || item.taskId === undefined) {
    return 'CEO の判断待ちで進行が止まっています。'
  }

  // 終端した run も返す既存の導出を使う（`findActiveByTaskId()` では failed / succeeded が見えない）。
  const latest = storage.designReviewRuns.findLatestByTaskId(item.taskId)
  if (!latest?.resultJson) {
    return '採用した Task に実装 Job が作られないまま止まっています。'
  }

  let decision: unknown
  let summary: unknown
  try {
    const parsed = JSON.parse(latest.resultJson) as Record<string, unknown>
    decision = parsed.finalDecision
    summary = (parsed.integrationReviewResult as Record<string, unknown> | undefined)?.summary
  } catch {
    return '採用した Task に実装 Job が作られないまま止まっています（Design Review の結果を読めませんでした）。'
  }

  return [
    '採用した Task に実装 Job が作られないまま止まっています。',
    `直近の Design Review の判定: ${String(decision ?? 'unknown')}`,
    summary ? `理由: ${String(summary)}` : undefined,
    'この判定は Binding Review です。PL は妥当性を評価できますが、BLOCK を覆せません。',
  ].filter((line) => line !== undefined).join('\n')
}

/**
 * その attention が Independent Remediation の対象か。
 *
 * 判定は `findRemediationSubject()`（永続レコードだけを見る read-only の導出）へ一本化する。
 * ここに条件を書き足さない —— **2箇所に書くと必ずずれる**。
 */
function isRemediableConflict(storage: IStorage, item: AttentionItem): boolean {
  if (item.kind !== 'task_ready_without_job' || item.taskId === undefined) return false
  if (findRemediationSubject(storage, item.taskId) === undefined) return false
  return countRemediationAttempts(storage, item.taskId) < PL_MAX_REMEDIATION_ATTEMPTS
}

/**
 * CONFLICT で止まった採用を1回 Remediation する。
 *
 * 成功（implement Job ができた）なら `acted` を返す。それ以外は `undefined` を返し、
 * **呼び出し側の既存 Escalation 経路へ落とす** —— ただし Remediation の診断を通知本文へ添える。
 * CEO には「止まっている」だけでなく「独立した AI がどう読んだか」まで届く。
 */
async function remediateConflict(
  storage: IStorage,
  deps: PlLoopDeps,
  key: string,
  item: AttentionItem,
): Promise<Omit<PlTickResult, 'target'> | undefined> {
  if (item.taskId === undefined) return undefined

  // **Remediation を直接は呼ばない。** CONFLICT の一次対応は Critic-assisted な PL revision で、
  // Independent Remediation はそれで解決しなかった場合の最後の救済である。
  // どの stage を実行するかは `selectConflictStage()`（既存 review state と audit の observer）が
  // 決める。ここは stage を選ばない。
  const run = deps.resolveConflict ?? runConflictResolutionRound
  // 呼び出し前の試行数。例外時に**二重計上しない**ための基準にする。
  const attemptsBefore = countConflictAttempts(storage, item.taskId)
  let round: Awaited<ReturnType<typeof runConflictResolutionRound>>
  try {
    round = await run(storage, item.taskId, {
      ...(deps.remediationDeps !== undefined ? { remediationDeps: deps.remediationDeps } : {}),
      ...(deps.conflictDeps !== undefined ? deps.conflictDeps : {}),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    // **例外も Remediation の試行として数える。** PL target 側だけに記録すると
    // `countRemediationAttempts()` が 0 のままで対象から外れず、再現する例外
    // （runner の spawn 失敗等）を毎 tick 繰り返す。
    //
    // ただし **step 側が既にこの試行を計上していたら足さない。** step は採用を await する前に
    // `outcome=adopting` を記録するので、採用が throw すると1回の論理試行で2行になり、
    // **上限2に対して transient な例外1回で予算が尽きる**（独立レビュー指摘）。
    if (countConflictAttempts(storage, item.taskId) === attemptsBefore) {
      // **どの stage の例外かを明示する。** `stage=` を省くと remediation として分類され、
      // Critic 段階の例外が Remediation の予算を食う（独立レビュー指摘）。
      // 状態は変わっていないので selector は落ちた stage をそのまま返す。
      const failedStage = selectConflictStage(storage, item.taskId).stage
      recordRemediationFailure(storage, item.taskId, `stage=${failedStage} outcome=exception`)
    }
    record(storage, key, 'diagnosis_failed', `conflict_resolution=error ${message}`)
    return { status: 'diagnosis_failed', reason: message, attempt: 1 }
  }

  // Stage 3 に入った場合は、その中身（Remediation の結果）を展開して扱う。
  const result = round.remediation
  const status = result?.status ?? round.status
  const failureCode = result?.failureCode ?? round.failureCode
  const reason = result?.reason ?? round.reason
  const provider = result?.provider ?? round.criticProvider
  const model = result?.model ?? round.criticModel

  /** 設計が既存 Review Pipeline を通って実装へ進める状態になったか。 */
  const resolved = status === 'remediated'
    || status === 'revised_and_aligned'
    || status === 'challenge_aligned'

  const provenance = provider !== undefined ? ` provider=${provider} model=${model}` : ''
  record(
    storage,
    key,
    resolved ? 'acted' : 'blocked',
    `stage=${round.stage} outcome=${status} code=${failureCode ?? '-'}${provenance} ${reason ?? ''}`,
  )

  if (resolved) {
    return {
      status: 'acted',
      proposedKind: 'adopt_roadmap_item',
      reason: `${round.stage} produced a design that passed the existing review pipeline`
        + ` (task ${result?.taskId ?? round.taskId})`,
      attempt: 1,
    }
  }

  // 解決しなかった。**既存の Escalation で人へ渡す。** Remediation の診断を添える。
  //
  // **通知は1つの停止につき1回だけ。** 予算が尽きるまで毎 tick 鳴らすと、
  // 2026-09-17 に実測された「63分で同一内容の LINE が18通」と同じ状態になる。
  // ここを Remediation 側の記録に依存させない —— 記録し忘れた経路が1つあれば
  // そのまま通知ループになるため、**ループ防止はこの分岐自身が持つ**。
  // `notify: false` でも `escalated` の記録は残り、Mobile からは進行中の失敗として見え続ける。
  const alreadyTold = hasEscalated(storage, key)
  const exhausted = status === 'attempts_exhausted' || status === 'terminal'
  if (alreadyTold && exhausted) {
    return { status: 'idle', reason: 'conflict resolution exhausted and already escalated', attempt: 1 }
  }

  await escalateTo(
    storage,
    deps,
    key,
    item,
    [
      notifyOnlyReason(storage, item),
      '',
      `解決の試み: stage=${round.stage} / 結果=${status}`,
      reason !== undefined ? `理由: ${reason}` : undefined,
      round.critique !== undefined
        ? `Critic が挙げた根本原因: ${round.critique.coreProblems.join(' / ')}`
        : undefined,
      round.critique !== undefined
        ? `Critic の改善方向: ${round.critique.improvementDirections.join(' / ')}`
        : undefined,
      // **Binding Safety の争点は Challenge では解除されない。** 人へ明示して渡す
      // （既存方針: Second Independent Review → Meta Review → 未解決なら CEO）。
      round.bindingDisputes !== undefined && round.bindingDisputes.length > 0
        ? 'Critic は Binding Safety / Authority の Finding にも疑義を述べています'
          + `（${round.bindingDisputes.map((d) => d.source).join(', ')}）。`
          + 'これは Challenge では解除されません。Second Independent Review / Meta Review の対象です。'
        : undefined,
      result?.proposal !== undefined ? `Remediation の診断: ${result.proposal.diagnosis}` : undefined,
      result?.proposal !== undefined ? `提案された解決: ${result.proposal.resolution}` : undefined,
    ].filter((line) => line !== undefined).join('\n'),
    { subject: 'Design Review CONFLICT', notify: !alreadyTold },
  )
  return { status: 'escalated', reason: `conflict not resolved (stage=${round.stage}, ${status})`, attempt: 1 }
}

function selectTarget(attention: readonly AttentionItem[]): AttentionItem | undefined {
  for (const kind of ATTENTION_PRIORITY) {
    const found = attention.find((item) => item.kind === kind)
    if (found) return found
  }
  return undefined
}

/**
 * この対象に対して PL が既に何回試したかを数える。
 *
 * **新しいテーブルを作らずに attempt を有界にするための唯一の情報源**である。
 * 数えるのは「実際に何かをした / 止められた試行」だけで、`idle` や in-flight skip は数えない。
 */
/** 「試行した」と数える結果。`idle` と in-flight skip は数えない。 */
import {
  ATTEMPT_RESULTS,
  adoptionFailureFingerprint,
  entriesSinceLastAdoption,
} from './adoptionFailure'

export function countPriorAttempts(storage: IStorage, targetKey: string): number {
  return storage.auditLog
    .findByEntity(AUDIT_ENTITY_TYPE, targetKey)
    .filter((entry) => ATTEMPT_RESULTS.includes(entry.result)).length
}

function hasEscalated(storage: IStorage, targetKey: string): boolean {
  return storage.auditLog
    .findByEntity(AUDIT_ENTITY_TYPE, targetKey)
    .some((entry) => entry.result === 'escalated')
}

/**
 * 直近の成功（`acted`）より後の記録だけを返す。**採用サイクル専用**。
 *
 * 復旧対象のキーは `job_blocked:<jobId>` のように実体ごとに変わるので、生涯カウントでも
 * 問題にならない。しかし**採用のキーは `adopt:<projectId>` で Project が続く限り変わらない**。
 * そのまま `countPriorAttempts()` を使うと過去のサイクルの試行が累積し続け、
 * **2件目を採用した時点で予算を使い切って以後ずっと Escalation** になる。
 *
 * 実測（2026-09-15 production）: 1件目の採用に2回（`proposal_unusable` → `adopted`）使った結果、
 * 次のサイクルは 1 tick 目で「PL は 2 回試しましたが採用できませんでした」になり、
 * **連続自律開発がそこで止まった**（`currentTask=UNDEFINED` / `attention=0` で、
 * 採用できる状態だったにもかかわらず）。
 *
 * 予算が縛るべきは「**連続した失敗**」であって生涯試行回数ではない。
 * **新しいテーブルは作らない。** 既存 `audit_log` を直近の成功で区切るだけである。
 */
function adoptionEntriesInCurrentWindow(storage: IStorage, targetKey: string): AuditLogEntry[] {
  // `findByEntity()` は新しい順に返す。
  const entries = storage.auditLog.findByEntity(AUDIT_ENTITY_TYPE, targetKey)
  // **Escalation も区切りにする。**
  //
  // 成功だけを区切りにすると、採用が一度 Escalation で終わった時点で予算が永久に尽きたままになり、
  // **原因を直しても採用が再開しない**（成功するには採用が要り、採用するには予算が要る、という循環）。
  // 実測（2026-09-15 production）: Candidate の ledger が master に遅れていたため PL が完了済み
  // 項目を選び、`ALREADY_EXECUTED` 却下を2回出して Escalation。ledger を直した後も再開しなかった。
  //
  // Escalation で区切れば、CEO へ知らせたうえで次の窓から再試行できる。通知は窓ごとに1回のままで、
  // 鳴り続けることはない。**新しい state は持たない** — 既存 `audit_log` の区切り方だけを変える。
  const boundary = entries.findIndex(
    (entry) => entry.result === 'acted' || entry.result === 'escalated',
  )
  return boundary === -1 ? entries : entries.slice(0, boundary)
}

/**
 * 採用エスカレーションを **CEO へ通知したこと** の記録。
 *
 * **retry window とは別の概念である。** 窓は「また試してよいか」を決め、
 * こちらは「もう知らせたか」を決める。両者を同じ記録で兼ねていたため、
 * escalation が窓の境界（＝窓から除外される行）になり、
 * 「窓の中に escalation があるか」という重複判定が**原理的に成立しなかった**
 * （2026-09-17 production 実測: 63分で同一内容の LINE が18通）。
 *
 * entity_id は採用サイクルのキーと**別にする**。`rotationOffset`（adoptionStep）が
 * `adopt:<projectId>` の**行数**を読んでいるため、ここへ足すと記録しただけで
 * PL に提示される候補が変わってしまう。
 */
const AUDIT_ADOPTION_NOTIFIED = 'pl_adoption_escalation_notified'

function adoptionNotificationKey(projectId: string): string {
  return `adopt-notified:${projectId}`
}

/**
 * いまの失敗の指紋を、この Project の audit 行から作る。
 *
 * 採用成功の回数を先頭に含めるので、**時刻の比較をしない**。
 * audit の並びは `created_at DESC, rowid DESC` で、同一ミリ秒の行は時刻では
 * 正しく順序づけられない（独立レビュー指摘）。成功するたび指紋が変わり、
 * 再発は自動的に新しい incident になる。
 */
function currentAdoptionFingerprint(storage: IStorage, projectId: string): string {
  const entries = storage.auditLog.findByEntity(AUDIT_ENTITY_TYPE, `adopt:${projectId}`)
  const successes = entries.filter((entry) => entry.result === 'acted').length
  return adoptionFailureFingerprint(successes, entriesSinceLastAdoption(entries))
}

/** この指紋の失敗をまだ CEO へ知らせていないか。 */
function shouldNotifyAdoptionEscalation(
  storage: IStorage,
  projectId: string,
  fingerprint: string,
): boolean {
  return !storage.auditLog
    .findByEntity(AUDIT_ENTITY_TYPE, adoptionNotificationKey(projectId))
    .some((entry) => entry.operation === AUDIT_ADOPTION_NOTIFIED && entry.detail === fingerprint)
}

function recordAdoptionNotification(
  storage: IStorage,
  projectId: string,
  fingerprint: string,
): void {
  storage.auditLog.record({
    actor: 'api',
    operation: AUDIT_ADOPTION_NOTIFIED,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: adoptionNotificationKey(projectId),
    result: 'success',
    detail: fingerprint,
  })
}

function record(
  storage: IStorage,
  targetKey: string,
  result: PlTickStatus,
  detail: string,
): void {
  storage.auditLog.record({
    actor: 'api',
    operation: AUDIT_OPERATION,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: targetKey,
    result,
    // 秘密情報・長大な payload を載せない。診断本文はここへ入れない。
    detail: detail.slice(0, 500),
  })
}

/**
 * PL の resume に添える指示文。
 *
 * `git_commit` の resume では `resumeBlockedTask()` がこの文字列を使わない（新 Job は同じ
 * SafeCommand を引き継ぐ）。AI CLI の resume では prompt になるが、その経路は Design Review
 * evidence を fail-closed で要求するため、**この文字列だけで実装内容が変わることはない**。
 */
export const DEFAULT_RESUME_INSTRUCTION =
  '前回の実行は完了前に停止した。作業中の変更は保持したまま、同じ受入条件・同じ allowedPaths の範囲で続きを行うこと。'

/**
 * Gate へ渡す根拠を**システム側の観測**から組み立てる。
 *
 * **PL の申告は一切混ぜない。** ここで積めるのは DB に実在するレコードの id だけで、
 * それが充足を意味するかどうかは seam が改めて検証する（対象への帰属も含む）。
 * 該当レコードが無ければ何も積まず、Gate が missing として止める（fail-closed）。
 */
function collectSystemEvidence(
  storage: IStorage,
  item: AttentionItem,
): GateEvidenceRef[] {
  if (item.taskId === undefined) return []

  const evidence: GateEvidenceRef[] = []

  // Design Review: **Gate が見るのと同じ「最新の evidence」だけ**を積む。
  //
  // Gate は `findLatestByTaskId()` と id が一致しない根拠を
  // 「is not the latest for the target」で弾く（古い ALIGNED を持ち出して新しい判定を
  // 上書きさせないための性質であり、緩めない）。
  //
  // 以前はここで `findByTaskId().filter(ALIGNED).pop()` を使っていたが、
  // `findByTaskId()` は**新しい順**に返すため `.pop()` は**最も古い** evidence を取っていた。
  // evidence が1件の Task では偶然一致して通り、**2件目ができた瞬間から必ず落ちる**。
  // 実測（2026-09-15 production）: Task `7bd4a65a` で resume が2回とも
  // `design_review evidence ... is not the latest for the target` で止まり、Escalation した。
  //
  // 最新が ALIGNED でない / task-kind でない場合は**何も積まない**（古いものへ遡らない）。
  const latest = storage.designReviewEvidence.findLatestByTaskId(item.taskId)
  if (latest?.decision === 'ALIGNED' && latest.reviewKind === 'task') {
    evidence.push({ gate: 'design_review', designReviewEvidenceId: latest.id })
  }

  // Approval Gate: **承認済み**の approval request だけを積む。
  // WAITING / STALE / EXPIRED は充足ではないので積まない（seam 側でも弾かれる）。
  const approval = storage.approvalRequests.findActiveByTaskId(item.taskId)
  if (approval?.status === 'APPROVED') {
    evidence.push({ gate: 'approval_gate', approvalRequestId: approval.id })
  }

  return evidence
}

/**
 * 違反ファイルのうち、**allowedPaths を直しても絶対に書けない**もの。
 *
 * 2026-09-16 production 実測: PL は `fileChangeGuard.ts` を変更しようとして止まった Job を
 * 「mismatched allowed paths … this configuration issue」と診断した。**正しく Escalate したが
 * 分類を外した** — allowedPaths を広げれば通る、と読める表現になっている。実際には
 * `ALWAYS_FORBIDDEN_PATTERNS` に載っているため**どんな allowedPaths でも通らない**。
 *
 * 判定は Guard 本体の export をそのまま使う。**一覧を複製しない**（複製すると必ずずれる）。
 */
function protectedViolations(fileViolations: readonly string[] | undefined): string[] {
  return (fileViolations ?? []).filter(
    (file: string) => ALWAYS_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file)),
  )
}

/** 止まっている Job の「なぜ止まったか」。PL はこれを読んで判断する。 */
function describeStuckJob(storage: IStorage, jobId: string): unknown {
  const job = storage.jobs.findById(jobId)
  if (!job) return { jobId, note: 'job not found' }
  return {
    id: job.id,
    status: job.status,
    workflowStepKey: job.workflowStepKey,
    commandKind: job.safeCommand.kind,
    exitCode: job.exitCode,
    changedFiles: job.changedFiles,
    // blocked の理由はここに出る（File Change Guard 違反・approval 待ち等）。
    guardResult: job.guardResult,
    // **allowedPaths では解決できない違反**。空なら scope の問題、非空なら protected の問題。
    protectedViolations: protectedViolations(job.guardResult?.fileViolations),
    failureMetadata: job.failureMetadata,
    stderrTail: tailText(job.stderr, 300),
  }
}

/** その Task の最新 approval。STALE / EXPIRED も含めて見せる（「なぜ承認が効いていないか」の材料）。 */
function describeLatestApproval(storage: IStorage, taskId: string): unknown {
  const approval = storage.approvalRequests.findActiveByTaskId(taskId)
  if (!approval) return { note: 'no approval request for this task' }
  return {
    id: approval.id,
    status: approval.status,
    requestedAction: approval.requestedAction,
    riskLevel: approval.riskLevel,
    targetCommit: approval.targetCommit,
    expiresAt: approval.expiresAt,
  }
}

function tailText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}

/**
 * attention の種類ごとに PL が選べる action。
 *
 * **ここに載せることは「実行してよい」を意味しない。** 可否は必ず `authorizePlAction()` が決める。
 * 載せるのは「PL に考えさせる選択肢」であり、Gate に落ちれば実行されない。
 * 一覧に無い値を PL が出した場合は Policy が未知値として forbidden にする。
 */
function allowedActionsFor(kind: AttentionItem['kind']): readonly string[] {
  switch (kind) {
    case 'design_review_idle':
    case 'design_review_failed':
      return ['rekick_design_review', 'escalate_to_ceo']
    case 'job_blocked':
      // CEO 指示（2026-09-15）: blocked reason と周辺状態を読んで、
      // sanctioned retry / resume / quarantine recovery / 新しい approval cycle / wait /
      // CEO escalation から選べるようにする。**新しい Recovery 機構は作らない**ので、
      // ここに並ぶのはすべて既存の正式操作である。
      // `observe_state` は「待つ」（既存の復旧が進行中なので今回は何もしない）を表す。
      return [
        'resume_task',
        'retry_job',
        'clear_workspace_quarantine',
        'observe_state',
        'escalate_to_ceo',
      ]
    case 'job_failed':
      return ['resume_task', 'retry_job', 'observe_state', 'escalate_to_ceo']
    default:
      return ['escalate_to_ceo']
  }
}

/**
 * Gate へ渡す対象を、**その操作が要求する種類**で組み立てる。
 *
 * 以前は attention に taskId があれば常に Task 対象を渡していた。そのため `retry_job` /
 * `clear_workspace_quarantine` のような **Job 単位の操作は必ず `target_mismatch` で落ちた** —
 * 2026-09-15 の production で実測（`kind=retry_job target_mismatch=task`）。PL から見ると
 * 候補に並んでいるのに構造的に一度も通らない操作があったことになる。
 *
 * ここで直すのは**宛先だけ**で、必要な Gate は一つも変えない。要求種別を組み立てられない場合は
 * Gate を呼ばずに fail-closed で止める（当たりそうな別種別を代わりに渡さない）。
 */
function resolvePlActionTarget(kind: string, item: AttentionItem): PlActionTarget | undefined {
  const required = requiredTargetKindFor(kind)
  if (required === undefined) return undefined

  const job: PlActionTarget | undefined =
    item.jobId !== undefined && item.taskId !== undefined
      ? { kind: 'job', jobId: item.jobId, taskId: item.taskId }
      : undefined
  const task: PlActionTarget | undefined =
    item.taskId !== undefined ? { kind: 'task', taskId: item.taskId } : undefined
  const project: PlActionTarget = { kind: 'project', projectId: item.projectId }

  switch (required) {
    case 'job':
      return job
    case 'task':
      return task
    case 'project':
      return project
    // system 対象（restart_service / deploy_production / switch_provider）は PL ループの
    // 候補に無い。届いたら提案が壊れているので通さない。
    case 'system':
      return undefined
    case 'any':
      return job ?? task ?? project
  }
}

/** 対象の周辺状態だけを抜く。全 Project の状態を PL へ丸ごと渡さない（Context 重視）。 */
function buildContext(storage: IStorage, state: SystemStateSnapshot, item: AttentionItem): unknown {
  const project = state.projects.find((p) => p.id === item.projectId)
  return {
    // blocked / failed は「なぜ止まったか」を読まないと判断できない。該当時だけ載せる。
    ...(item.jobId !== undefined ? { blockedJob: describeStuckJob(storage, item.jobId) } : {}),
    ...(item.taskId !== undefined ? { latestApproval: describeLatestApproval(storage, item.taskId) } : {}),
    generatedAt: state.generatedAt,
    attention: item,
    project: project
      ? {
          id: project.id,
          name: project.name,
          status: project.status,
          currentTask: project.currentTask,
          jobs: project.jobs,
          designReview: project.designReview,
        }
      : undefined,
    totals: state.totals,
  }
}

const DIAGNOSIS_SYSTEM = [
  'You are the Project Lead (PL) of an autonomous software team.',
  'You receive one observed anomaly and the surrounding system state.',
  'Decide which single existing recovery action should be proposed next.',
  '',
  'Rules you cannot change:',
  '- You do not decide whether a gate, review or CEO approval is required.',
  '- You cannot override a BLOCK. Your options are fix / re-review / alternative / escalate.',
  '- If no listed action is clearly safe and appropriate, propose "escalate_to_ceo".',
  '',
  // 何が起きるかを知らないまま選ばせない。**どれを選んでよいかは決めていない** —
  // 可否は Gate が判定する。ここは各操作の意味を揃えるだけである。
  'What the listed actions actually do (all of them are existing operations):',
  '- retry_job: the job failed for a transient reason and running the same job again can work.',
  '- resume_task: the task stalled and needs a fresh run. A blocked commit whose approval is',
  '  STALE, EXPIRED or missing can only move this way: it starts a NEW approval cycle, and the',
  '  CEO still has to approve it. Re-approving the old request does nothing.',
  '- clear_workspace_quarantine: the workspace is quarantined and that quarantine is the blocker.',
  '- observe_state: a recovery is already in flight, or the blocker is outside this system; wait.',
  '',
  'If context.blockedJob.protectedViolations is NOT empty, those files are permanently forbidden.',
  'No allowedPaths value can ever permit them, so retry and resume cannot help. Propose',
  '"escalate_to_ceo" and say plainly that the task needs a protected file and must be handled',
  'outside this workspace - do not describe it as an allowedPaths or configuration problem.',
  '',
  'Answer with a single JSON object and nothing else:',
  '{"actionKind": "<one of the allowed kinds>", "rationale": "<one sentence>",',
  ' "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL"}',
].join('\n')

/** 診断 prompt の文言をテストから固定するための再公開。実体は同一。 */
export const DIAGNOSIS_SYSTEM_FOR_TEST = DIAGNOSIS_SYSTEM

async function defaultDiagnose(input: PlDiagnosisInput): Promise<string> {
  const user = [
    `Allowed action kinds: ${input.allowedActionKinds.join(', ')}`,
    '',
    'Observed anomaly and state:',
    JSON.stringify(input.context, null, 2),
  ].join('\n')

  return await requestText(DIAGNOSIS_SYSTEM, user, {}, PL_DIAGNOSIS_MAX_TOKENS)
}

async function defaultEscalate(payload: { title: string; body: string }): Promise<void> {
  // 既存 notifier をそのまま使う。通知チャネル未設定時はコンソールへ落ちる（notifier 側の既存挙動）。
  const { sendAlert } = await import('@ai-team/worker/src/notifier/notifier.js')
  await sendAlert({ severity: 'warning', title: payload.title, body: payload.body })
}

/**
 * PL の出力から action kind を取り出す。
 *
 * **ここで既知 kind への変換や補正をしない。** 取り出すのは文字列だけで、その値が
 * 実行してよいものかは `authorizePlAction()`（= Policy）だけが決める。
 * 補正すると「PL が書いた文字列」と「実行された操作」がズレる隙間ができる。
 */
export function extractProposedKind(raw: string): { kind?: string; rationale?: string; riskLevel?: string } {
  const match = raw.match(/```json\s*([\s\S]+?)\s*```/) ?? raw.match(/(\{[\s\S]+?\})/)
  if (!match) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1] ?? match[0])
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}

  const obj = parsed as Record<string, unknown>
  return {
    kind: typeof obj.actionKind === 'string' ? obj.actionKind : undefined,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : undefined,
    riskLevel: typeof obj.riskLevel === 'string' ? obj.riskLevel : undefined,
  }
}

/**
 * 操作後の状態を再取得して結果を分類する。
 *
 * **実行側の戻り値だけで成功と判断しない。** 同じ attention が消えたかどうかを
 * `buildSystemState()` から読み直して確かめる。
 */
export function verifyOutcome(
  before: AttentionItem,
  after: SystemStateSnapshot,
): PlVerificationVerdict {
  const key = targetKeyOf(before)
  const subject = before.jobId ?? before.taskId ?? before.projectId

  const same = after.attention.find((item) => targetKeyOf(item) === key)
  if (same) return 'unchanged'

  const otherOnSameSubject = after.attention.find(
    (item) => (item.jobId ?? item.taskId ?? item.projectId) === subject,
  )
  if (otherOnSameSubject) {
    // 承認待ち・quarantine は「PL では進められない別の異常」なので区別する。
    return otherOnSameSubject.kind === 'approval_waiting' ||
      otherOnSameSubject.kind === 'workspace_quarantined'
      ? 'needs_gate_or_ceo'
      : 'different_anomaly'
  }

  return 'normalized'
}

async function executeAction(
  storage: IStorage,
  kind: string,
  item: AttentionItem,
  deps: Required<Pick<PlLoopDeps, 'rekickDesignReview'>> & PlLoopDeps,
): Promise<{ ok: boolean; summary: string }> {
  if (kind === 'escalate_to_ceo') {
    // Escalation は「実行」ではなく報告である。ここでは成功扱いにせず、呼び出し側が escalated を返す。
    return { ok: true, summary: 'escalation requested by PL' }
  }

  if (kind === 'rekick_design_review') {
    if (item.taskId === undefined) {
      return { ok: false, summary: 'attention has no taskId; cannot locate the design review run' }
    }
    const run = storage.designReviewRuns.findLatestByTaskId(item.taskId)
    if (!run) {
      return { ok: false, summary: `no design review run for task ${item.taskId}` }
    }
    // **盲目的な re-kick をしない**（CEO 指示）。attempt を使い切った run は再実行しても
    // `not_claimable` になるだけなので、Escalation 側へ倒す。
    if (run.attemptCount >= DESIGN_REVIEW_MAX_ATTEMPTS) {
      return {
        ok: false,
        summary: `design review run ${run.id} already used ${run.attemptCount}/${DESIGN_REVIEW_MAX_ATTEMPTS} attempts`,
      }
    }

    const result = await deps.rekickDesignReview(storage, run.id)
    return { ok: result.status !== 'stale', summary: `design review rekick: ${result.status}` }
  }

  if (kind === 'observe_state') {
    // 「待つ」。既存の復旧が進行中だと PL が判断した場合。何も実行しない。
    // 状態が変わらなければ verification が `unchanged` になり、試行上限で Escalation へ倒れる
    // ので、待ち続けて放置されることはない。
    return { ok: true, summary: 'waiting: PL judged that an existing recovery is already in progress' }
  }

  if (kind === 'resume_task') {
    if (item.taskId === undefined) {
      return { ok: false, summary: 'attention has no taskId; cannot resume' }
    }
    // **既存の正式操作をそのまま呼ぶ。** 新しい Recovery 機構は作らない。
    // `resumeBlockedTask()` 自身が fail-closed の門を持つ（quarantine / 有効な承認待ち /
    // queued・running の重複 / AI CLI の Design Review evidence）。ここで緩めない。
    // git_commit の resume なら、新 Job が `/gate/check` で**現在の diff に対する新しい
    // Approval Request** を発行する（STALE な旧 approval は再利用されない）。
    const resumed = storage.jobs.resumeBlockedTask({
      taskId: item.taskId,
      instructionPrompt: deps.resumeInstruction ?? DEFAULT_RESUME_INSTRUCTION,
    })
    if (!resumed.ok) {
      return { ok: false, summary: `resume refused: ${resumed.reason}` }
    }
    return { ok: true, summary: `resume queued job ${resumed.job.id}` }
  }

  // Gate は通ったが v1 に executor が無い操作。**勝手に別の操作で代替しない。**
  return { ok: false, summary: `no executor wired for '${kind}' in this loop version` }
}

/**
 * PL の 1 tick。**呼ばれたときだけ動く**（常駐しない）。
 */
export async function runPlTick(storage: IStorage, deps: PlLoopDeps = {}): Promise<PlTickResult> {
  if (inFlight) {
    return { status: 'skipped_in_flight', reason: 'a previous tick is still running' }
  }
  inFlight = true

  try {
    // ── Observe ───────────────────────────────────────────────
    const before = buildSystemState(storage, deps.now ? { now: deps.now } : {})
    // **Escalation 済みの対象は選択段階で外す。**
    // production の初回 tick（2026-09-14）で判明: escalation は attempt として数えないため、
    // 選択段階で外さないと、既に CEO へ上げた対象に対して tick ごとに Diagnose（provider CLI 実行、
    // 実測 25 秒）を走らせ、最後に「already escalated」で捨てることになる。
    // CEO の判断待ちの間ずっとモデル枠を焼く挙動であり、
    // 「一時的・既知の異常による不要な PL 起動を減らす」という本項目の目的に反する。
    const actionable = before.attention.filter(
      (item) =>
        ACTIONABLE_ATTENTION_KINDS.includes(item.kind)
        // **Independent Remediation は Escalation 済みでも対象にする。**
        // `hasEscalated()` は Task の生涯にわたる記録で、キー（`task_ready_without_job:<taskId>`）は
        // 変わらない。CONFLICT はまず notify-only で1回 Escalate されるため、ここを素通しに
        // しないと **Remediation が構造的に一度も走れない**（既に止まっている本番 Task も含む）。
        // 予算は `countRemediationAttempts()` が却下テキスト単位で別に持つので、
        // 通知が鳴り続けることはない。
        && (!hasEscalated(storage, targetKeyOf(item)) || isRemediableConflict(storage, item))
        && hasStalledLongEnough(item),
    )
    const item = selectTarget(actionable)
    if (!item) {
      // **手が空いたら次の Roadmap 項目を採用する。**
      // attention が1つでもあるうちは採用しない（止まっているものを放置して新しい仕事を
      // 増やさない）。採用可否そのものは `runAdoptionStep()` 内で Gate が決める。
      const adoption = await maybeAdoptNext(storage, before, deps)
      if (adoption) return adoption

      return {
        status: 'idle',
        reason:
          before.attention.length === 0
            ? 'no attention items'
            : `nothing actionable among the ${before.attention.length} attention item(s) ` +
              '(no wired executor, or already escalated and waiting on the CEO)',
      }
    }

    const key = targetKeyOf(item)
    const target = {
      key,
      kind: item.kind,
      projectId: item.projectId,
      ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
      ...(item.jobId !== undefined ? { jobId: item.jobId } : {}),
    }
    // ── Design Review CONFLICT で止まった採用は Independent Remediation へ回す ─────
    //
    // **PL 自身には直せない。** Job 生成は Design Review evidence を要し、その判定を PL が
    // 覆すことは許されない（それは従来から変わらない）。直すのではなく、**独立した flagship AI に
    // 提案を作り直させ、まっさらな Review へ掛ける**。判定は依然 API 側が再計算する。
    if (item.kind === 'task_ready_without_job' && isRemediableConflict(storage, item)) {
      const outcome = await remediateConflict(storage, deps, key, item)
      if (outcome) return { ...outcome, target }
    }

    // ── 人へ伝えるだけの attention は、診断も Gate も経ずに1回通知して終わる ──────
    // `escalate_to_ceo` 相当の行為であり Gate を要しない（Policy 上も無 Gate）。
    // 既に通知済みの対象は選択段階で外れているので、ここへは来ない
    // （唯一の例外は上の Remediation 経路で、そこで終端していなければここへ落ちる）。
    if (NOTIFY_ONLY_ATTENTION_KINDS.includes(item.kind)) {
      if (hasEscalated(storage, key)) {
        return { status: 'idle', target, reason: 'already escalated; not repeating', attempt: 1 }
      }
      await escalateTo(storage, deps, key, item, notifyOnlyReason(storage, item))
      return { status: 'escalated', target, reason: 'human decision required', attempt: 1 }
    }

    const attempt = countPriorAttempts(storage, key) + 1

    // ── 試行上限。ここを超えたら再試行ではなく Escalation ──────────
    if (attempt > PL_MAX_ATTEMPTS_PER_TARGET) {
      if (hasEscalated(storage, key)) {
        return { status: 'idle', target, reason: 'already escalated; not repeating', attempt }
      }
      await escalateTo(storage, deps, key, item, `PL は ${PL_MAX_ATTEMPTS_PER_TARGET} 回試しましたが解消しませんでした。`)
      return { status: 'escalated', target, reason: 'attempt budget exhausted', attempt }
    }

    // ── Diagnose ─────────────────────────────────────────────
    const diagnose = deps.diagnose ?? defaultDiagnose
    let raw: string
    try {
      raw = await diagnose({
        attention: item,
        context: buildContext(storage, before, item),
        allowedActionKinds: allowedActionsFor(item.kind),
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      record(storage, key, 'diagnosis_failed', message)
      return { status: 'diagnosis_failed', target, reason: message, attempt }
    }

    // ── Decide（PL の自然言語を実行コマンドとして信用しない）──────────
    const proposal = extractProposedKind(raw)
    if (proposal.kind === undefined) {
      record(storage, key, 'diagnosis_unusable', 'diagnosis did not contain a structured actionKind')
      return {
        status: 'diagnosis_unusable',
        target,
        reason: 'diagnosis did not contain a structured actionKind',
        attempt,
      }
    }

    // ── Mandatory Gate（唯一の許可経路）──────────────────────────
    const plActionTarget = resolvePlActionTarget(proposal.kind, item)
    if (plActionTarget === undefined) {
      const reason = `action ${proposal.kind} cannot be addressed at this attention item's scope`
      record(storage, key, 'blocked', `kind=${proposal.kind} ${reason}`)
      return { status: 'blocked', target, proposedKind: proposal.kind, reason, attempt }
    }

    try {
      authorizePlAction(storage, {
        proposal: {
          kind: proposal.kind,
          ...(proposal.riskLevel !== undefined && proposal.rationale !== undefined
            ? { plRiskOpinion: { level: proposal.riskLevel, rationale: proposal.rationale } }
            : {}),
        },
        target: plActionTarget,
        // 根拠は**システムが観測した実レコード**から積む。PL の申告は渡さない。
        // 該当が無ければ空のままで、Gate が missing として止める（fail-closed）。
        evidence: collectSystemEvidence(storage, item),
      })
    } catch (error: unknown) {
      if (error instanceof PlActionBlockedError) {
        record(storage, key, 'blocked', `kind=${proposal.kind} ${error.message}`)
        return {
          status: 'blocked',
          target,
          proposedKind: proposal.kind,
          reason: error.message,
          attempt,
        }
      }
      throw error
    }

    // ── Execute（既存の正式操作だけ）──────────────────────────────
    if (proposal.kind === 'escalate_to_ceo') {
      if (hasEscalated(storage, key)) {
        return { status: 'idle', target, proposedKind: proposal.kind, reason: 'already escalated', attempt }
      }
      await escalateTo(storage, deps, key, item, proposal.rationale ?? 'PL が CEO 判断を求めています。')
      return { status: 'escalated', target, proposedKind: proposal.kind, attempt }
    }

    const execution = await executeAction(storage, proposal.kind, item, {
      ...deps,
      rekickDesignReview:
        deps.rekickDesignReview ??
        (async (s, runId) => {
          const run = s.designReviewRuns.findById(runId)
          if (!run) return { status: 'stale' }
          return await executeDesignReviewRun(s, run, deps.coordinatorDeps ?? buildDefaultCoordinatorDeps())
        }),
    })

    // ── Verify（実行側の戻り値だけで成功としない）────────────────────
    const after = buildSystemState(storage, deps.now ? { now: deps.now } : {})
    const verification = verifyOutcome(item, after)

    record(
      storage,
      key,
      'acted',
      `kind=${proposal.kind} exec_ok=${execution.ok} verify=${verification} ${execution.summary}`,
    )

    // ── Continue / Escalate ────────────────────────────────────
    // **復旧対象が解消していれば Escalation しない。** 直した結果として次の工程が現れるのは
    // pipeline の正常な進み方であり、それは次の tick で独立した attention として扱われる
    // （`isRecoveryTargetResolved()` 参照）。
    if (
      !isRecoveryTargetResolved(verification) &&
      attempt >= PL_MAX_ATTEMPTS_PER_TARGET &&
      !hasEscalated(storage, key)
    ) {
      await escalateTo(
        storage,
        deps,
        key,
        item,
        `PL は ${proposal.kind} を実行しましたが状態は ${verification} でした（${execution.summary}）。`,
      )
      return {
        status: 'escalated',
        target,
        proposedKind: proposal.kind,
        executionSummary: execution.summary,
        verification,
        attempt,
      }
    }

    return {
      status: 'acted',
      target,
      proposedKind: proposal.kind,
      executionSummary: execution.summary,
      verification,
      attempt,
    }
  } finally {
    inFlight = false
  }
}

/**
 * 手が空いた Project に次の Roadmap 項目を採用する。**採用しなかったときは undefined を返す。**
 *
 * 採用してよい状況の判定はここだけに置く:
 *   - attention が1件も無い（止まっているものを放置して新しい仕事を増やさない）
 *   - running な Project である（Worker が実際に進められる）
 *   - 進行中の Task が無い＝手が空いている
 *   - 同じ Project への採用試行が上限未満（`audit_log` から数える。新しい表は持たない）
 */
async function maybeAdoptNext(
  storage: IStorage,
  state: SystemStateSnapshot,
  deps: PlLoopDeps,
): Promise<PlTickResult | undefined> {
  if (state.attention.length > 0) return undefined

  const project = state.projects.find((candidate) => (
    candidate.status === 'running' && candidate.currentTask === undefined
  ))
  if (!project) return undefined

  const key = `adopt:${project.id}`
  // **採用が成功したら予算は仕切り直す。** 縛るのは連続した失敗であって生涯試行回数ではない
  // （そうしないと2件目の採用で打ち止めになる。2026-09-15 production 実測）。
  const currentWindow = adoptionEntriesInCurrentWindow(storage, key)
  const attempt = currentWindow.filter((entry) => ATTEMPT_RESULTS.includes(entry.result)).length + 1
  if (attempt > PL_MAX_ADOPTION_ATTEMPTS) {
    // **再試行の窓と、CEO への通知は別に決める。**
    //
    // 窓は escalation を境界にして切り替わる（原因を直したあと採用を再開できるようにするため。
    // 2026-09-15 の実測でこれが無いと予算が永久に枯れた）。その挙動は変えない。
    // 一方で通知は incident 単位にする —— 同じ対象で同じ失敗が続く限り、窓が何周しても1通だけ。
    const fingerprint = currentAdoptionFingerprint(storage, project.id)
    const notify = shouldNotifyAdoptionEscalation(storage, project.id, fingerprint)

    await escalateTo(
      storage,
      deps,
      key,
      {
        kind: 'task_ready_without_job',
        projectId: project.id,
        projectName: project.name,
        detail: `PL could not adopt the next roadmap item (${fingerprint})`,
      },
      `PL は ${PL_MAX_ADOPTION_ATTEMPTS} 回試しましたが、次の Roadmap 項目を採用できませんでした。`,
      { subject: 'Roadmap adoption failure', notify },
    )
    if (notify) recordAdoptionNotification(storage, project.id, fingerprint)

    return { status: 'escalated', reason: 'adoption attempt budget exhausted', attempt }
  }

  const propose = deps.proposeAdoption
    ?? ((system: string, user: string) => requestText(system, user, {}, PL_ADOPTION_MAX_TOKENS))

  let result: PlAdoptionResult
  try {
    result = await runAdoptionStep(storage, project.id, {
      propose,
      ...(deps.readLedger ? { readLedger: deps.readLedger } : {}),
      ...(deps.adopt ? { adopt: deps.adopt } : {}),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    record(storage, key, 'diagnosis_failed', message)
    return { status: 'diagnosis_failed', reason: message, attempt }
  }

  if (result.status === 'no_candidate') {
    // ledger を全部やり切った状態。異常ではないので記録も Escalation もしない。
    return undefined
  }

  // `code=` は機械判定用の構造化された下位分類で、後ろの散文とは役割が違う。
  // `code=` / `target=` は機械判定用の構造化された欄で、後ろの散文とは役割が違う。
  // 同じ原因コードでも対象の項目が変われば別の障害なので、target も分類に要る。
  record(
    storage,
    key,
    result.status === 'adopted' ? 'acted' : 'blocked',
    `adoption=${result.status} code=${result.failureCode ?? '-'} target=${result.roadmapId ?? '-'} `
    + `${result.reason ?? ''}`,
  )

  return {
    status: result.status === 'adopted' ? 'acted' : 'blocked',
    proposedKind: 'adopt_roadmap_item',
    executionSummary: `adoption ${result.status}${result.roadmapId ? ` (${result.roadmapId})` : ''}`,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    attempt,
  }
}

async function escalateTo(
  storage: IStorage,
  deps: PlLoopDeps,
  key: string,
  item: AttentionItem,
  reason: string,
  options: {
    /**
     * CEO へ見せる件名。省略時は attention の kind をそのまま使う（既存の全経路がこれ）。
     *
     * 採用エスカレーションだけは、`escalateTo()` を再利用するために
     * `task_ready_without_job` の attention を**その場で組み立てている**。
     * 実在しない attention の kind をそのまま件名にすると、CEO には
     * 「着手できる Task が放置されている」と読めてしまう —— 実際には
     * そんな Task は1件も無い（2026-09-17 実測: pending かつ roadmapActive は 0 件）。
     * **内部都合のダミー kind を、人向けの事実として出さない。**
     */
    subject?: string
    /**
     * 通知を送るか。`false` でも `escalated` の記録は残す。
     *
     * 「知らせない」と「無かったことにする」は違う。audit と PL state には残り、
     * Mobile からも現在進行形の失敗として見え続ける。
     */
    notify?: boolean
  } = {},
): Promise<void> {
  if (options.notify !== false) {
    const escalate = deps.escalate ?? defaultEscalate
    const body = [
      `何が起きているか: ${item.detail}`,
      `対象: Project ${item.projectName}${item.taskId ? ` / Task ${item.taskId}` : ''}`,
      `PL の判断: ${reason}`,
      'PL ができること: 修正 / 再レビュー / 代替案の提示 / このエスカレーション（BLOCK の無視はできません）。',
    ].join('\n')

    await escalate({ title: `[PL] ${options.subject ?? item.kind} が解消していません`, body })
  }
  record(storage, key, 'escalated', reason)
}

/** テスト用。モジュールスコープの単一実行ガードを戻す。 */
export function resetPlLoopInFlightForTest(): void {
  inFlight = false
}
