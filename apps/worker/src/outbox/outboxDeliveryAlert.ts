/**
 * Outbox 再送が滞留したときに CRITICAL を上げるかの判定（純粋関数）。
 *
 * **commit 成功時に continuation が pending だと、API は `PATCH /api/jobs/:id` に意図的に 503 を返す。**
 * Worker は event を保持して poll cycle ごとに再送し、continuation が完了すると 200 で解消する
 * （設計どおりの正常系）。continuation は Design Review を伴うので 30 秒前後かかり、poll 間隔 5 秒では
 * 正常系でも容易に 3 cycle を超える。以前は 3 cycle で一律に CRITICAL を上げていたため、正常な
 * continuation のたびに誤報していた（roadmap `outbox-blocked-critical-false-alarm`、2026-09-11 実測）。
 *
 * ここでは滞留を2種類に分ける:
 * - **本当の配送失敗**（API 不達・認証失敗・continuation と無関係な非 2xx・再送の例外）が1回でも
 *   あった滞留 → 従来どおり `OUTBOX_BLOCKED_ALERT_CYCLES` cycle で CRITICAL
 * - **すべての再送が「受理済み・continuation pending」の 503 だった滞留** → 想定内として扱い、
 *   continuation 自体が詰まったとみなせる `OUTBOX_CONTINUATION_PENDING_ALERT_MS`（滞留開始からの壁時計）まで待つ
 *   （詰まった continuation は本当の障害なので、通知を消しはしない）
 *
 * **event は捨てない。** この判定は通知だけを決め、Outbox の保持・再送・Job intake の停止は変えない。
 *
 * **continuation 待ちの一次の担い手は API / PL である**（CEO 決定 2026-10-27）。API は次 Task の
 * Design Review / Job の実際の遷移から前進を検証し、前進が無いまま 5 分を超えた continuation を
 * `continuation_pending` として診断・通知する（既存の復旧が先に動く）。ここの壁時計の CRITICAL は、
 * API / PL の監視や復旧そのものが働かなかった場合に備える**独立した backstop**であり、本当の停滞を
 * 永久に無音にしないための保険である。重複通知は許容する（CEO 決定）。PL の健全性監視が入っても
 * 自動では外さない。外すには、同等以上の検知が稼働し独立に検証された証拠が要る。
 */

/** 本当の配送失敗を含む滞留で CRITICAL を上げるまでの poll cycle 数（従来値）。 */
export const OUTBOX_BLOCKED_ALERT_CYCLES = 3

/**
 * continuation pending の 503 だけが続く滞留で CRITICAL を上げるまでの**経過時間**（滞留開始から）。
 *
 * **cycle 数ではなく壁時計で数える。** 1 cycle には PATCH の retry と backoff（計 1.5 秒）と poll 間隔が
 * 入り、pending 行が増えるほど長くなるので、cycle 数では上限時間を保証できない（独立レビュー指摘）。
 * 一致する eventId は「Job の結果は永続化された」ことの証明であって「continuation が進んでいる」ことの
 * 証明ではない。continuation が恒久的に壊れていても、この時間で必ず CRITICAL になる。
 * 正常な continuation（2026-09-11 実測 36 秒）の十数倍で、Design Review runner の期限（300 秒）を超える。
 *
 * **数え方**（独立レビュー round 2 指摘）:
 * - 起点は滞留した最初の cycle の**開始**時刻（再送 batch の前）。batch が長くても起点はずれない
 * - 経過時間は、評価ごとの差分のうち**正の分だけ**を積み上げる。壁時計が巻き戻っても、失うのは
 *   その1回の差分だけで、以後は普通に進む（巻き戻し幅だけ通知が遅れることはない）。進む方向の
 *   跳びは通知を早めるだけ（安全側）
 * - 判定は再送 batch の後にしかできないので、上限は「この時間 + 最後の batch 1回分」である
 *   （1行あたり最大 PATCH 3回 × 5 秒 + backoff 1.5 秒）。従来の 3 cycle 判定と同じ性質
 */
export const OUTBOX_CONTINUATION_PENDING_ALERT_MS = 10 * 60 * 1000

export interface OutboxAlertState {
  /** pending が連続して残った poll cycle 数。 */
  streak: number
  /** この滞留で積み上げた経過時間（ms。正の差分だけの合計）。 */
  elapsedMs: number
  /** 最後に評価した時刻（ms）。滞留していなければ undefined。 */
  lastEvaluatedAtMs: number | undefined
  /** この滞留の中で、continuation pending 以外の失敗が1回でもあったか。 */
  sawGenuineFailure: boolean
  /** この滞留で既に通知したか（1回の滞留につき1回だけ通知する）。 */
  alertSent: boolean
}

export function initialOutboxAlertState(): OutboxAlertState {
  return { streak: 0, elapsedMs: 0, lastEvaluatedAtMs: undefined, sawGenuineFailure: false, alertSent: false }
}

export interface OutboxResendCycle {
  /** 再送の後も pending が残っているか。 */
  pendingRemains: boolean
  /**
   * この cycle の再送が **1件以上行われ、すべてが** 受理済み・continuation pending の 503 だったか。
   * 再送が1件も行われなかった・例外になった・別の失敗が混じった場合は false（本当の失敗として扱う）。
   */
  onlyContinuationPending: boolean
}

/** この cycle の時刻。`cycleStartedAtMs` は再送 batch の前、`nowMs` は判定の時点。 */
export interface OutboxCycleTiming {
  cycleStartedAtMs: number
  nowMs: number
}

export function nextOutboxAlertState(
  state: OutboxAlertState,
  cycle: OutboxResendCycle,
  timing: OutboxCycleTiming,
): { state: OutboxAlertState; shouldAlert: boolean } {
  if (!cycle.pendingRemains) return { state: initialOutboxAlertState(), shouldAlert: false }

  // 滞留の最初の cycle は batch の開始から数える。以後は前回の判定時刻から。
  const previousMs = state.lastEvaluatedAtMs ?? timing.cycleStartedAtMs
  const next: OutboxAlertState = {
    streak: state.streak + 1,
    elapsedMs: state.elapsedMs + Math.max(0, timing.nowMs - previousMs),
    lastEvaluatedAtMs: timing.nowMs,
    sawGenuineFailure: state.sawGenuineFailure || !cycle.onlyContinuationPending,
    alertSent: state.alertSent,
  }
  const due = next.sawGenuineFailure
    ? next.streak >= OUTBOX_BLOCKED_ALERT_CYCLES
    : next.elapsedMs >= OUTBOX_CONTINUATION_PENDING_ALERT_MS
  if (next.alertSent || !due) return { state: next, shouldAlert: false }
  return { state: { ...next, alertSent: true }, shouldAlert: true }
}

/**
 * `PATCH /api/jobs/:id` の 503 が「受理済み・continuation pending」か。
 *
 * API はこの場合だけ、永続化した Job に `outbox: { eventId }` を付けて 503 を返す
 * （`apps/api/src/routes/jobs.ts` の continuation pending 分岐）。**送った eventId と一致する**ことを
 * 要求するので、proxy や障害が返す 503 は該当しない（本当の失敗として扱われる）。
 */
export function isContinuationPendingResponse(status: number, body: unknown, sentEventId: string | undefined): boolean {
  if (status !== 503 || sentEventId === undefined) return false
  const outbox = (body as { outbox?: { eventId?: unknown } } | null | undefined)?.outbox
  return typeof outbox?.eventId === 'string' && outbox.eventId === sentEventId
}
