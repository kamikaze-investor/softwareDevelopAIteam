import { describe, expect, it } from 'vitest'
import {
  initialOutboxAlertState,
  isContinuationPendingResponse,
  nextOutboxAlertState,
  OUTBOX_BLOCKED_ALERT_CYCLES,
  OUTBOX_CONTINUATION_PENDING_ALERT_MS,
  type OutboxAlertState,
  type OutboxResendCycle,
} from './outboxDeliveryAlert'

/** 各 cycle を `stepMs` 間隔で進める（既定は poll 間隔 5 秒）。 */
function run(cycles: readonly OutboxResendCycle[], stepMs = 5_000): { alerts: number; state: OutboxAlertState } {
  let state = initialOutboxAlertState()
  let alerts = 0
  let nowMs = 1_000_000
  for (const cycle of cycles) {
    nowMs += stepMs
    const result = nextOutboxAlertState(state, cycle, nowMs)
    state = result.state
    if (result.shouldAlert) alerts += 1
  }
  return { alerts, state }
}

const genuine: OutboxResendCycle = { pendingRemains: true, onlyContinuationPending: false }
const continuation: OutboxResendCycle = { pendingRemains: true, onlyContinuationPending: true }
const drained: OutboxResendCycle = { pendingRemains: false, onlyContinuationPending: false }

describe('nextOutboxAlertState', () => {
  it('本当の配送失敗は従来どおり 3 cycle で1回だけ CRITICAL', () => {
    expect(run(Array(OUTBOX_BLOCKED_ALERT_CYCLES - 1).fill(genuine)).alerts).toBe(0)
    expect(run(Array(OUTBOX_BLOCKED_ALERT_CYCLES).fill(genuine)).alerts).toBe(1)
    expect(run(Array(OUTBOX_BLOCKED_ALERT_CYCLES + 5).fill(genuine)).alerts).toBe(1)
  })

  it('continuation pending の 503 だけなら、正常な continuation の長さ（2026-09-11 実測 7 cycle）では鳴らない', () => {
    expect(run(Array(7).fill(continuation)).alerts).toBe(0)
  })

  it('continuation pending だけでも、滞留開始から 10 分を超えたら1回だけ CRITICAL（通知を消さない）', () => {
    const cyclesFor = (ms: number, stepMs: number): number => Math.floor(ms / stepMs)
    // 最初の cycle が滞留開始。そこから 10 分未満なら鳴らない。
    expect(run(Array(cyclesFor(OUTBOX_CONTINUATION_PENDING_ALERT_MS, 5_000)).fill(continuation)).alerts).toBe(0)
    expect(run(Array(cyclesFor(OUTBOX_CONTINUATION_PENDING_ALERT_MS, 5_000) + 1).fill(continuation)).alerts).toBe(1)
    expect(run(Array(cyclesFor(OUTBOX_CONTINUATION_PENDING_ALERT_MS, 5_000) + 50).fill(continuation)).alerts).toBe(1)
  })

  it('cycle が長くなっても（retry・backoff・pending 行の増加）上限は壁時計で決まる', () => {
    // 1 cycle 20 秒なら 10 分は 30 cycle。cycle 数の閾値だと 40 分かかっていた形。
    expect(run(Array(30).fill(continuation), 20_000).alerts).toBe(0)
    expect(run(Array(31).fill(continuation), 20_000).alerts).toBe(1)
  })

  it('滞留の途中で本当の失敗が1回でも混じれば、従来の閾値に戻る', () => {
    expect(run([continuation, continuation, genuine]).alerts).toBe(1)
  })

  it('解消したら状態を戻し、次の滞留でまた1回通知できる', () => {
    const { alerts } = run([genuine, genuine, genuine, drained, genuine, genuine, genuine])
    expect(alerts).toBe(2)
  })
})

describe('isContinuationPendingResponse', () => {
  it('送った eventId を返す 503 だけが continuation pending', () => {
    expect(isContinuationPendingResponse(503, { id: 'j', outbox: { eventId: 'e1', deduplicated: false } }, 'e1')).toBe(true)
  })

  it('別の eventId・eventId なし・503 以外・本文なし・送信 eventId なしは continuation pending ではない', () => {
    expect(isContinuationPendingResponse(503, { outbox: { eventId: 'other' } }, 'e1')).toBe(false)
    expect(isContinuationPendingResponse(503, { error: 'Service Unavailable' }, 'e1')).toBe(false)
    expect(isContinuationPendingResponse(500, { outbox: { eventId: 'e1' } }, 'e1')).toBe(false)
    expect(isContinuationPendingResponse(503, undefined, 'e1')).toBe(false)
    expect(isContinuationPendingResponse(503, { outbox: { eventId: 'e1' } }, undefined)).toBe(false)
  })
})
