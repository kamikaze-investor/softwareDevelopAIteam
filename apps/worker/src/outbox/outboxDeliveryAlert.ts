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
 *   continuation 自体が詰まったとみなせる `OUTBOX_CONTINUATION_PENDING_ALERT_CYCLES` cycle まで待つ
 *   （詰まった continuation は本当の障害なので、通知を消しはしない）
 *
 * **event は捨てない。** この判定は通知だけを決め、Outbox の保持・再送・Job intake の停止は変えない。
 */

/** 本当の配送失敗を含む滞留で CRITICAL を上げるまでの poll cycle 数（従来値）。 */
export const OUTBOX_BLOCKED_ALERT_CYCLES = 3

/**
 * continuation pending の 503 だけが続く滞留で CRITICAL を上げるまでの poll cycle 数。
 * poll 間隔 5 秒で 10 分。continuation の Design Review runner 期限（300 秒）と再試行を十分に超える。
 */
export const OUTBOX_CONTINUATION_PENDING_ALERT_CYCLES = 120

export interface OutboxAlertState {
  /** pending が連続して残った poll cycle 数。 */
  streak: number
  /** この滞留の中で、continuation pending 以外の失敗が1回でもあったか。 */
  sawGenuineFailure: boolean
  /** この滞留で既に通知したか（1回の滞留につき1回だけ通知する）。 */
  alertSent: boolean
}

export function initialOutboxAlertState(): OutboxAlertState {
  return { streak: 0, sawGenuineFailure: false, alertSent: false }
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

export function nextOutboxAlertState(
  state: OutboxAlertState,
  cycle: OutboxResendCycle,
): { state: OutboxAlertState; shouldAlert: boolean } {
  if (!cycle.pendingRemains) return { state: initialOutboxAlertState(), shouldAlert: false }

  const next: OutboxAlertState = {
    streak: state.streak + 1,
    sawGenuineFailure: state.sawGenuineFailure || !cycle.onlyContinuationPending,
    alertSent: state.alertSent,
  }
  const threshold = next.sawGenuineFailure
    ? OUTBOX_BLOCKED_ALERT_CYCLES
    : OUTBOX_CONTINUATION_PENDING_ALERT_CYCLES
  if (next.alertSent || next.streak < threshold) return { state: next, shouldAlert: false }
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
