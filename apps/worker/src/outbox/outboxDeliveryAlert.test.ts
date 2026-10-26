import { describe, expect, it } from 'vitest'
import {
  initialOutboxAlertState,
  isContinuationPendingResponse,
  nextOutboxAlertState,
  OUTBOX_BLOCKED_ALERT_CYCLES,
  OUTBOX_CONTINUATION_PENDING_ALERT_CYCLES,
  type OutboxAlertState,
  type OutboxResendCycle,
} from './outboxDeliveryAlert'

function run(cycles: readonly OutboxResendCycle[]): { alerts: number; state: OutboxAlertState } {
  let state = initialOutboxAlertState()
  let alerts = 0
  for (const cycle of cycles) {
    const result = nextOutboxAlertState(state, cycle)
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

  it('continuation pending だけでも、詰まったとみなせる長さを超えたら CRITICAL（通知を消さない）', () => {
    expect(run(Array(OUTBOX_CONTINUATION_PENDING_ALERT_CYCLES - 1).fill(continuation)).alerts).toBe(0)
    expect(run(Array(OUTBOX_CONTINUATION_PENDING_ALERT_CYCLES).fill(continuation)).alerts).toBe(1)
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
