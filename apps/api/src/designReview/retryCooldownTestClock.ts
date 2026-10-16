/**
 * **テスト専用。** 判定の出なかった Design Review attempt の後の retry cooldown
 * （`retryCooldown.ts`）を、壁時計を進めて明けさせる。production code から import しない。
 *
 * cooldown は storage の `claim()` が壁時計（`Date`）で強制するので、テストも時計で進める
 * （assertion は変えない）。`Date` だけを fake にし、`shouldAdvanceTime` で時間は流れ続ける
 * （timestamp の前後関係に依存する判定を壊さない）。setTimeout 等は本物のまま。
 *
 * 使ったテストファイルは `afterEach(() => { vi.useRealTimers() })` で戻すこと。
 */
import { vi } from 'vitest'
import { DESIGN_REVIEW_RETRY_COOLDOWNS_MS } from './retryCooldown'

/** 壁時計を `ms` 進める（初回呼び出しで `Date` を fake にする）。 */
export function advanceWallClock(ms: number): void {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  vi.setSystemTime(Date.now() + ms)
}

/** どの attempt の後でも cooldown が明けるだけ壁時計を進める。 */
export function passDesignReviewRetryCooldown(): void {
  advanceWallClock(Math.max(...DESIGN_REVIEW_RETRY_COOLDOWNS_MS) + 1_000)
}
