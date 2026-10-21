/**
 * **判定の出なかった task Design Review を、いつ再試行してよいか。**
 *
 * ## なぜ要るか（lifecycle repair C3-c / Task `b8d0fc5d`）
 *
 * REVIEW_UNAVAILABLE・runner timeout・crash など「判定が無い」attempt は `finalizeFailure()` が
 * requeue し、PL の `design_review_idle` → rekick が次の tick（60s）で拾う。backoff が無いので
 * `DESIGN_REVIEW_MAX_ATTEMPTS` 回が 3〜8 分で尽き、run は failed になって CEO へ escalation される。
 * provider の停止（Codex logout と再ログイン、503 / capacity、Gemini quota）はそれより長いのが普通で、
 * 最も頻度の高い実障害が「一時的な欠落」ではなく「恒久的な CEO 案件」に変わっていた。
 *
 * ## 何をするか
 *
 * **attempt 数は変えず、attempt の間隔だけを広げる。** requeue された task run は、直前の attempt の
 * 終了時刻（requeue 時に `completed_at` へ記録する）から attempt 番号に応じた cooldown が過ぎるまで
 * claim できない。判定（ALIGNED / CONFLICT / UNCERTAIN）は run を終端させるので、ここを通らない。
 *
 * - 強制は **storage の `claim()` 1箇所だけ**（全実行経路 = PL rekick・startup recovery・resume /
 *   initial workflow / conflict 再評価の `createAndExecute` は必ずそこを通る）。
 * - `systemState` は同じ関数で「cooldown 中は idle ではない」と判定し、PL に空振りの rekick を
 *   させない（attention kind は増やさない）。
 *
 * ## 定数の根拠
 *
 * attempt 1 の失敗後 5 分、attempt 2 の失敗後 30 分。attempt 3 の失敗は従来どおり failed 終端なので、
 * 3つ目の値は使われない（配列は使われる分だけ持つ）。
 * - 5 分: 503 / capacity と Gemini の per-minute quota は数分で戻る。PL の停滞閾値
 *   （`DEFAULT_STALL_HINT_MS` = 5 分）と同じ桁で、従来の最短間隔より短くはしない。
 * - 30 分: Codex の logout は人が device-auth で再ログインするまで戻らない。気付いて操作できる
 *   時間幅を与え、それでも戻らなければ「一時的ではない」ので従来どおり CEO へ escalation する。
 * 合計の吸収幅は約 35 分 + runner 実行時間。これ以上延ばすと、本当の停止の通知が遅れる。
 *
 * **roadmap kind には適用しない。** roadmap review は `executeRoadmapReviewToTerminal()` が
 * 同期ループで attempt を drain する設計で、cooldown を入れるとそのループの意味が変わる。
 *
 * **startup recovery の requeue には適用しない**（`completed_at` を書かない）。API の再起動は
 * provider 障害ではないので、即時の再実行が正しい。
 */
import type { DesignReviewRun } from '../storage/interface'


/**
 * index = 直前までに消費した attempt 数 - 1。長さは `DESIGN_REVIEW_MAX_ATTEMPTS - 1`
 * （attempt と attempt の間の数）で、テストがこの対応を固定している。
 */
export const DESIGN_REVIEW_RETRY_COOLDOWNS_MS: readonly number[] = [5 * 60_000, 30 * 60_000]

/**
 * cooldown が明ける時刻（epoch ms）。cooldown の対象でなければ undefined。
 *
 * - attempt を使い切った run（配列の範囲外）は対象外。次の claim が従来どおり failed にするだけで、
 *   待たせても再試行は起きないため、attention（exhausted → escalation）を遅らせない。
 * - 時刻が読めない行は undefined（= 従来どおり即時に再試行できる）。attempt 上限で bounded なので、
 *   読めない時刻で run を永久に止める方へは倒さない。
 */
export function designReviewRetryNotBeforeMs(
  run: Pick<DesignReviewRun, 'reviewKind' | 'status' | 'attemptCount' | 'completedAt'>,
): number | undefined {
  if (run.reviewKind !== 'task' || run.status !== 'queued') return undefined
  if (run.completedAt === undefined) return undefined
  const cooldownMs = DESIGN_REVIEW_RETRY_COOLDOWNS_MS[run.attemptCount - 1]
  if (cooldownMs === undefined) return undefined
  const lastAttemptEndedAt = Date.parse(run.completedAt)
  return Number.isFinite(lastAttemptEndedAt) ? lastAttemptEndedAt + cooldownMs : undefined
}
