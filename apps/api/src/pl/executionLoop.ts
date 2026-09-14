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
import { requestText } from '../aiExplain/cheapAiClient'
import { buildSystemState, type AttentionItem, type SystemStateSnapshot } from '../state/systemState'
import type { IStorage } from '../storage/interface'
import { authorizePlAction, PlActionBlockedError, type PlActionTarget } from './actionGate'

/** 1つの対象に対して PL が試せる回数。超えたら再試行せず Escalation へ倒す。 */
export const PL_MAX_ATTEMPTS_PER_TARGET = 2

/** 診断に使える時間。既存 cheap client の timeout と同じ桁に収める。 */
export const PL_DIAGNOSIS_MAX_TOKENS = 700

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
  'design_review_idle',
  'design_review_failed',
]

/**
 * 対応順。**先に来たものから 1 tick につき 1 件だけ**扱う。
 * 一度に全部やろうとすると、失敗が連鎖したときに何が原因か分からなくなる。
 */
const ATTENTION_PRIORITY: readonly AttentionItem['kind'][] = [
  'design_review_idle',
  'design_review_failed',
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
  coordinatorDeps?: CoordinatorDeps
  now?: () => string
}

/**
 * 同時実行を 1 本に絞る。API は単一プロセス・単一スレッドなのでこれで足りる。
 * 重ねて走らせると、同じ run に対して 2 回 claim を試みて attempt を無駄に消費する。
 */
let inFlight = false

function targetKeyOf(item: AttentionItem): string {
  // 対象の同一性は「どの attention がどの実体に出ているか」で決まる。
  // Job > Task > Project の順で最も具体的な id を使う。
  const subject = item.jobId ?? item.taskId ?? item.projectId
  return `${item.kind}:${subject}`
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
export function countPriorAttempts(storage: IStorage, targetKey: string): number {
  return storage.auditLog
    .findByEntity(AUDIT_ENTITY_TYPE, targetKey)
    .filter((entry) =>
      ['acted', 'blocked', 'diagnosis_unusable', 'diagnosis_failed'].includes(entry.result),
    ).length
}

function hasEscalated(storage: IStorage, targetKey: string): boolean {
  return storage.auditLog
    .findByEntity(AUDIT_ENTITY_TYPE, targetKey)
    .some((entry) => entry.result === 'escalated')
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

/** 対象の周辺状態だけを抜く。全 Project の状態を PL へ丸ごと渡さない（Context 重視）。 */
function buildContext(state: SystemStateSnapshot, item: AttentionItem): unknown {
  const project = state.projects.find((p) => p.id === item.projectId)
  return {
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
  'Answer with a single JSON object and nothing else:',
  '{"actionKind": "<one of the allowed kinds>", "rationale": "<one sentence>",',
  ' "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL"}',
].join('\n')

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
        ACTIONABLE_ATTENTION_KINDS.includes(item.kind) && !hasEscalated(storage, targetKeyOf(item)),
    )
    const item = selectTarget(actionable)
    if (!item) {
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
        context: buildContext(before, item),
        allowedActionKinds: ['rekick_design_review', 'escalate_to_ceo'],
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
    const plActionTarget: PlActionTarget =
      item.taskId !== undefined
        ? { kind: 'task', taskId: item.taskId }
        : { kind: 'project', projectId: item.projectId }

    try {
      authorizePlAction(storage, {
        proposal: {
          kind: proposal.kind,
          ...(proposal.riskLevel !== undefined && proposal.rationale !== undefined
            ? { plRiskOpinion: { level: proposal.riskLevel, rationale: proposal.rationale } }
            : {}),
        },
        target: plActionTarget,
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
    if (verification !== 'normalized' && attempt >= PL_MAX_ATTEMPTS_PER_TARGET && !hasEscalated(storage, key)) {
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

async function escalateTo(
  storage: IStorage,
  deps: PlLoopDeps,
  key: string,
  item: AttentionItem,
  reason: string,
): Promise<void> {
  const escalate = deps.escalate ?? defaultEscalate
  const body = [
    `何が起きているか: ${item.detail}`,
    `対象: Project ${item.projectName}${item.taskId ? ` / Task ${item.taskId}` : ''}`,
    `PL の判断: ${reason}`,
    'PL ができること: 修正 / 再レビュー / 代替案の提示 / このエスカレーション（BLOCK の無視はできません）。',
  ].join('\n')

  await escalate({ title: `[PL] ${item.kind} が解消していません`, body })
  record(storage, key, 'escalated', reason)
}

/** テスト用。モジュールスコープの単一実行ガードを戻す。 */
export function resetPlLoopInFlightForTest(): void {
  inFlight = false
}
