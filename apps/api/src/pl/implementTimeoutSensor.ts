import type { AiCliMode, AiCliProvider, Job } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'

/**
 * `claude_code` の implement に与えた **暫定** timeout を、実データで再評価すべきかを判定する。
 *
 * ## なぜ要るのか
 *
 * 2026-09-18 に implement の AI CLI timeout を 300s から 900s へ広げた。900s は最適値ではなく、
 * **打ち切られていた裾を測り直すための暫定 budget** である（`jobRunner.ts`
 * `CLAUDE_IMPLEMENT_TIMEOUT_MS` のコメントに根拠がある）。
 * 「後でもう一度 SQL を叩く」に頼ると、そのまま恒久値になって忘れられる。
 *
 * ## いま実際に動いている条件は C だけである（CEO 判断・2026-09-21）
 *
 * A（budget に殺されて生成物を失った Job）と B（その率）は **fail-closed で止めてある**。
 * 根拠が `failureMetadata.kind === 'provider_timeout'` なのに、**その印がいま見ている実行の
 * ものだと `jobs` 行から確認できない**（`failureMetadataBoundToCurrentRun()` に調査結果）。
 * 信じると timeout していない失敗で誤発火し、budget ごとの重複排除キーを本物の証拠より
 * 先に使い切って、**センサー自身の再評価能力を壊す**。
 *
 * C（成功 Job の p95 が budget へ接近）は `status` と所要時間だけを見るので影響を受けない。
 * **つまり現時点の再評価能力は「成功が遅くなってきたら気付く」までで、
 * 「広げた budget でもまだ殺されている」は検知できない。** 前者だけでも
 * 暫定値が忘れられるのは防げるが、**A/B の代わりにはならない。**
 *
 * 根本原因は Roadmap `job-failure-metadata-outlives-its-run` で扱う。それが解決したら
 * `failureMetadataBoundToCurrentRun()` を実装して A/B を戻す。
 *
 * ## このセンサーがしないこと
 *
 * - **timeout 値を書き換えない。** 出すのは再 Review 候補までである（CEO 指示・2026-09-18）
 * - **CEO へ即通知しない。** まず AI 側で再評価する
 * - **新しい metrics backend を作らない。** 入力は既存 `jobs` 行、出力は既存 `audit_log` 1 行
 * - **PL の判断を変えない。** `runPlTick()` からは best-effort で呼ばれ、失敗しても tick を壊さない
 *
 * 重複排除の作りは `principles/ledger.ts` の principle sensor と同じ
 * （entity id を鍵にした check-then-insert）。その制約もそのまま共有する:
 * better-sqlite3 は同期なので 1 プロセス内では割り込まれない。複数プロセス化するときに
 * `audit_log` 側でまとめて扱う。
 */

const AUDIT_OPERATION = 'implement_timeout_sensor_fired'
const AUDIT_ENTITY_TYPE = 'implement_timeout_sensor'
const AUDIT_RESULT = 'fired'

const EPOCH_ENTITY_TYPE = 'implement_timeout_policy_epoch'
const EPOCH_ENTITY_ID = 'current'
const EPOCH_OPERATION = 'implement_timeout_policy_epoch_started'
const EPOCH_RESULT = 'started'

const PROVIDER: AiCliProvider = 'claude_code'
const MODE: AiCliMode = 'implement'

/**
 * 閾値（CEO 指示・2026-09-18）。**これらは暫定の policy 値である。**
 *
 * 実測が establish しているのは**変更前の分布だけ**である:
 * implement n=96 / provider_timeout 7 件 = 7.3% / 成功 p95 201s / 成功 max 230s。
 *
 * **下の 5 つの数字は、その分布から導出されたものでも検証されたものでもない。**
 * 「7.3% の半分以下まで下がってほしい」「budget の 6 割まで来たら近い」といった
 * 判断で置いた値であり、正しさの裏付けは無い。この PR 自体が
 * 「打ち切られた裾が見えていない」という前提の上に立っているので、
 * **閾値だけが確かであるかのように書かない**（独立レビュー指摘）。
 *
 * これらが妥当だったかは、900s 運用下のデータが貯まってから同じ集計で見直す。
 */
export const IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS = {
  /** 直近何件の implement Job を母集団にするか。 */
  WINDOW: 50,
  /**
   * B: **現在の budget に殺された** Job の率がこれ以上なら再評価。
   *
   * `provider_timeout` 全体の率ではない。epoch より前に開始した timeout は分子に入らない。
   * 変更前の実測 7.3% は provider_timeout 全体の率なので、**同じ量ではない**。
   */
  TIMEOUT_RATE: 0.03,
  /** C: 成功 Job の p95 が timeout 値のこの割合へ達したら再評価。 */
  P95_RATIO_OF_TIMEOUT: 0.6,
  /** C: p95 を口にするために最低限必要な成功サンプル数。 */
  P95_MIN_SAMPLES: 20,
} as const

export interface ImplementTimeoutFinding {
  sensorId: 'implement-timeout-discards-produced-work'
    | 'implement-timeout-rate-too-high'
    | 'implement-p95-approaching-timeout'
  /** 重複排除の鍵に混ぜる識別子（job id か、判定時点の timeout 値）。 */
  scope: string
  summary: string
  evidence: Record<string, unknown>
  thresholdNote: string
}

function durationSeconds(job: Job): number | undefined {
  const started = job.startedAt ?? job.createdAt
  if (!started || !job.completedAt) return undefined
  const seconds = (new Date(job.completedAt).getTime() - new Date(started).getTime()) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/**
 * **この `failureMetadata` が「いま見ている実行」で書かれたものだと確認できるか。**
 *
 * ## 今日は確認できない。だから常に false を返す（CEO 指示・2026-09-21）
 *
 * `jobs` 行を調べた結果、**実行を identify できる列が 1 つも無い**:
 * 試行回数も run id も無く、`failure_metadata` 自体に時刻も付いていない。
 *
 * **訂正（2026-09-21・独立レビュー指摘）**: 以前ここに「消す経路は 1 つも存在しない」と
 * 書いたが**誤り**だった。`failAndPrepareRepair()` は `failure_metadata = ?` へ `null` を
 * 渡して消す（`sqlite.ts`）。当時の grep が `failure_metadata = NULL` という**字面**しか
 * 探しておらず、placeholder 経由の null を見落としていた。
 * **絶対的な主張を狭い grep から書いていた**。
 *
 * 正しくは: **消す経路は存在するが、一般の terminal update / requeue 経路は消さない。**
 * したがって「印が今回の実行のものだ」と言えない状態は依然として起こりうる。
 *
 * 一方で Worker の terminal update は、provider 由来でない失敗のとき
 * `failureMetadata: undefined` を送る。`JSON.stringify` が `undefined` を落とし、
 * `jobs.update()` は `{ ...existing, ...data }` で重ねるので、**前の実行の印が残る**。
 * つまり「timeout した → requeue → 別の理由で失敗」した行は、
 * `status=failed` かつ `provider_timeout` に見える（独立レビュー指摘）。
 *
 * これを信じると、**non-timeout の失敗で A/B が誤発火し、budget ごとの重複排除キーを
 * 本物の証拠より先に使い切って、以後の再評価を黙らせる**。センサーが自分の目的を壊す。
 *
 * ## 何が揃えば true にできるか
 *
 * terminal update が失敗のたびに `failureMetadata` を**明示的に書く（無いなら消す）**
 * ようになれば、`status=failed` と印の組は同じ実行のものだと言える。
 * それは `blockedTriage` / `repairFlow` も読む共有 semantics の変更なので、
 * **Roadmap `job-failure-metadata-outlives-its-run` で別途扱う**（CEO 判断・2026-09-21）。
 * ここを埋めるのはその後で、**推測（caller の意図 / 最新値だから / 経過時間）で
 * fresh と見なしてはいけない**。
 */
function failureMetadataBoundToCurrentRun(_job: Job): boolean {
  return false
}

/**
 * **その Job の現在の状態が「budget に殺された失敗」であるか。**
 *
 * `failureMetadata` だけでは足りない。requeue の UPDATE は `status` / `started_at` /
 * `completed_at` などを戻すが **`failure_metadata` は消さない**（`sqlite.ts`）。
 * `PATCH /api/jobs/:id` も部分更新で、`JSON.stringify` が `undefined` を落とすため、
 * 明示的に上書きしない限り古い値が残る。つまり **timeout した Job を再実行して成功しても、
 * 行には `provider_timeout` が残りうる**（独立レビュー指摘）。
 *
 * そのまま数えると、**成功した Job で A が発火し**、B の率を押し上げて
 * budget ごとの重複排除キーを本物の証拠が出る前に使い切ってしまう。
 * `status === 'failed'` を併せて要求すれば、再実行して成功した行は外れる。
 */
function killedByBudget(job: Job): boolean {
  if (job.status !== 'failed') return false
  if (job.failureMetadata?.kind !== 'provider_timeout') return false
  // **印が今回の実行のものだと言えないなら数えない（fail-closed）。**
  return failureMetadataBoundToCurrentRun(job)
}

function hasChangedFiles(job: Job): boolean {
  return Array.isArray(job.changedFiles) && job.changedFiles.length > 0
}

/**
 * **現在の budget がいつから有効かを返す。** 必要なら epoch 行を 1 行追記する。
 *
 * ## なぜ経過時間では駄目だったか
 *
 * 以前は「所要時間が budget の 90% 以上なら現在の budget 下の kill」と見なしていた。
 * 300s -> 900s では 90% = 810s が旧 kill の ~304s を上回るので**たまたま**通っていたが、
 * 隣接する値では破綻する: 900s -> 1000s にすると、旧 900s policy で落ちた Job は
 * 900 秒走っているので新 budget の 90%（900s）を満たし、**旧 policy の Job が新 policy の
 * 証拠として数えられ、`...:1000000` の重複排除キーまで使い切ってしまう**
 * （CEO 指示・2026-09-18 の境界ケース。テストで固定した）。
 *
 * `completed_at` が後から別経路で書かれる場合もある（実際に abort cleanup が 22 時間後に
 * 書いた行が production にある）ので、経過時間は regime の根拠として二重に弱い。
 *
 * ## 代わりに何を根拠にするか
 *
 * **「その budget が有効になった時刻」を記録し、それ以降に開始した Job だけを見る。**
 * 新しい表は作らず、既存 `audit_log` に 1 行だけ置く。値が変わったときにだけ追記するので、
 * 900 -> 1000 -> 900 と戻した場合も 3 行目が入り、最後の行が現在の epoch になる。
 *
 * **限界 1**: 初回はこの関数が呼ばれた瞬間が epoch になるので、**それ以前の Job は
 * どの budget で走ったか分からないまま除外される**。過去を遡って regime を復元はしない
 * （Job 行に budget が残っていない以上、復元する根拠が無い）。
 *
 * **限界 2**: 「どれが最新の epoch 行か」は `audit_log` の `created_at` 順に依存する。
 * **システム時計が巻き戻ると壊れる**: 新しい行が古い行より前に並び、毎 tick 新しい
 * epoch 行を追記し続けて `effectiveFrom` が前へ動き、時計が追いつくまで A/B の証拠を
 * 取りこぼす（独立レビュー指摘）。**時計の単調性は前提であって、ここで保証はしていない。**
 * 巻き戻りを検知・補正する仕組みは作っていない（それ自体が別の機構になるため）。
 * 症状は「epoch 行が毎 tick 増える」ことなので、audit を見れば気付ける。
 */
/**
 * 記録済みの epoch を使ってよいか。使えないなら undefined。
 *
 * 弾くのは 2 つだけで、**内容の良し悪しは判断しない**:
 * - `Date` として解釈できない文字列
 * - **未来の時刻**。未来の epoch は「どの Job も対象外」を意味し、センサーを無言で止める
 */
function usableEpoch(candidate: string, now: () => string): string | undefined {
  const parsed = Date.parse(candidate)
  if (Number.isNaN(parsed)) return undefined
  if (parsed > Date.parse(now())) return undefined
  // **正規化して返す。** `Date.parse()` は `2026-09-18T09:00:00+09:00` のような
  // 別表記も受け付けるので、そのまま持ち回ると文字列比較が壊れる（独立レビュー指摘）。
  return new Date(parsed).toISOString()
}

export function ensureImplementTimeoutPolicyEpoch(
  storage: IStorage,
  timeoutMs: number,
  now: () => string = () => new Date().toISOString(),
): string {
  // findByEntity は created_at DESC 順なので先頭が最新。
  const latest = storage.auditLog.findByEntity(EPOCH_ENTITY_TYPE, EPOCH_ENTITY_ID)[0]

  let previousTimeoutMs: number | undefined
  let previousEffectiveFrom: string | undefined
  if (latest !== undefined) {
    try {
      const parsed = JSON.parse(latest.detail ?? '{}') as {
        timeoutMs?: unknown,
        effectiveFrom?: unknown,
      } | null
      if (typeof parsed?.timeoutMs === 'number') previousTimeoutMs = parsed.timeoutMs
      if (typeof parsed?.effectiveFrom === 'string') previousEffectiveFrom = parsed.effectiveFrom
    } catch {
      // 壊れた行は「前の値が読めない」として扱い、新しい epoch を開く。
    }
    if (previousTimeoutMs === timeoutMs) {
      // **起点は detail の `effectiveFrom` を正とする。** 監査行の `createdAt` は
      // 行が書かれた時刻であって「その budget がいつから有効か」ではない。
      //
      // ただし**壊れた値を黙って信じない**。未来日付や解釈できない文字列をそのまま返すと、
      // `startedAt >= epoch` がどの Job に対しても偽になり、**A/B が無言で止まる**
      // （独立レビュー指摘）。センサーが黙ることは、異常が無いことと区別が付かない。
      // 読めない・信じられないときは epoch を張り直して、以後の証拠を拾えるようにする。
      const usable = usableEpoch(previousEffectiveFrom ?? latest.createdAt, now)
      if (usable !== undefined) return usable
    }
  }

  const effectiveFrom = now()
  storage.auditLog.record({
    actor: 'api',
    operation: EPOCH_OPERATION,
    entityType: EPOCH_ENTITY_TYPE,
    entityId: EPOCH_ENTITY_ID,
    result: EPOCH_RESULT,
    detail: JSON.stringify({
      timeoutMs,
      effectiveFrom,
      ...(previousTimeoutMs === undefined ? {} : { previousTimeoutMs }),
    }),
  })
  return effectiveFrom
}

/**
 * `a` が `b` と同時か、それより後か。**文字列ではなく時刻として比べる。**
 *
 * ISO 表記は 1 つではない（`2026-09-18T09:00:00+09:00` と `2026-09-18T00:00:00.000Z` は
 * 同じ瞬間）。辞書順で比べると同じ瞬間でも前後を取り違える（独立レビュー指摘）。
 * どちらかが解釈できなければ false（fail-closed）。
 */
export function isAtOrAfter(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false
  const left = Date.parse(a)
  const right = Date.parse(b)
  if (Number.isNaN(left) || Number.isNaN(right)) return false
  return left >= right
}

/** 昇順ソートした配列の分位点。サンプルが無ければ undefined。 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
}

/**
 * 判定本体（純関数）。`jobs` は完了が新しい順で渡す。
 *
 * `policyEpochStart` 以降に**開始した** Job だけが、現在の budget 下で走ったと確定できる。
 * `undefined` を渡した場合は epoch で絞らない（テスト用）。
 */
export function evaluateImplementTimeoutSensors(
  jobs: readonly Job[],
  timeoutMs: number,
  policyEpochStart?: string,
): ImplementTimeoutFinding[] {
  const t = IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS
  const window = jobs.slice(0, t.WINDOW)
  const findings: ImplementTimeoutFinding[] = []
  if (window.length === 0) return findings

  const timeoutSeconds = timeoutMs / 1000

  /**
   * **現在の budget の下で、その budget に殺されたか。** A と B の両方がこれを通る。
   *
   * 2 つの条件の積であり、**どちらも経過時間ではない**:
   * 1. `status === 'failed'` かつ `provider_timeout` —— 後者は「こちらが渡した `timeoutMs` の
   *    タイマーが発火して kill した」ことだけを意味する。設定箇所は `adapter.ts` の 1 箇所で、
   *    その元になる `contained.timedOut` も `setTimeout(..., options.timeoutMs)` の
   *    コールバック 1 箇所だけ。`status` も見るのは、requeue が `failure_metadata` を
   *    消さないため、**再実行して成功した行に古い印が残る**から（`killedByBudget()` 参照）
   * 2. `startedAt >= policyEpochStart` —— その budget が有効になった後に**開始**した
   *
   * ## なぜ `completedAt` ではなく `startedAt` か
   *
   * **`completedAt` は後から別経路に書き換えられる。** `releaseBlockedJobAndParkTask()` は
   * blocked のまま残っていた兄弟 Job を `failed` にするとき `completedAt` を**その時刻で
   * 上書きする**（`sqlite.ts`）。つまり旧 budget 下で timeout した Job が、後日 park された
   * だけで「今日終わった」ことになり、新しい epoch の証拠として数えられてしまう
   * （独立レビュー指摘。production には実際に 22 時間後に `completed_at` が書かれた行がある）。
   *
   * `startedAt` は Worker が Job を claim して `running` にする瞬間に書かれる
   * （`apps/worker/src/index.ts`）。**不変ではない**: 承認待ちからの resume / requeue で
   * `started_at = NULL` に戻され（`sqlite.ts`）、次に claim されたときに書き直される。
   * つまりこれは「この Job 行が最後に**走り出した**時刻」である（独立レビュー指摘）。
   *
   * **その意味でちょうど良い。** 殺したのは最後の実行で、その実行に適用された budget は
   * 走り出した時点のものだからである。park や abort が書き換える `completedAt` と違い、
   * 書き換わるのは「実際にもう一度走ったとき」だけで、そのときは regime も本当に変わる。
   *
   * 経過時間は使わない（`ensureImplementTimeoutPolicyEpoch()` の説明を参照）。
   */
  const killedByCurrentBudget = (job: Job): boolean => {
    if (!killedByBudget(job)) return false
    if (policyEpochStart === undefined) return true
    return isAtOrAfter(job.startedAt, policyEpochStart)
  }

  // ── A. 現在の budget を使い切って落ち、生成済みの変更を失った Job ──────
  // 「1 件でも再発したら再評価」なので Job ごとに 1 度だけ出す。
  for (const job of window) {
    if (!killedByCurrentBudget(job) || !hasChangedFiles(job)) continue
    const seconds = durationSeconds(job)!
    findings.push({
      sensorId: 'implement-timeout-discards-produced-work',
      scope: job.id,
      // **言えることだけを書く。** `changedFiles` は「変更を作っていた」ことを示すが、
      // 打ち切られた瞬間も進んでいたかどうかは、この行からは分からない（独立レビュー指摘）。
      summary: '現在の timeout でも、変更を生成済みの implement Job が打ち切られた（生成分は失われた）',
      evidence: {
        jobId: job.id,
        taskId: job.taskId,
        durationSeconds: Math.round(seconds),
        timeoutSeconds,
        changedFileCount: job.changedFiles?.length ?? 0,
      },
      thresholdNote:
        `provider_timeout（= 渡した timeoutMs のタイマーが発火して kill された）かつ`
        + ` changedFiles あり、かつ現在の budget が有効になった後に**開始**した Job。`
        + ` 1 件でも再評価対象（CEO 指示・2026-09-18）。`
        + ' なお 2026-09-21 時点でこの条件は fail-closed で止まっており、この行は出ない。',
    })
  }

  // ── B. timeout 率 ────────────────────────────────────────────────
  //
  // **分子は「現在の budget が有効になった後に、その budget で殺された Job」だけである。**
  // ここを素の `killedByBudget` にしていると、deploy 直後の窓に残っている旧 policy の
  // timeout だけで閾値を超えてしまう。しかも B の重複排除キーは budget 値なので、
  // **一度そうやって発火すると同じ budget では二度と出ない** —— つまり後から本物の
  // 証拠が揃っても黙る。古い証拠が、拾うべき将来の証拠を潰す形だった（独立レビュー指摘）。
  //
  // 分母は窓全体（直近に完了した implement Job すべて）のままにする。移行期は分母に
  // 旧 policy の Job が混じるぶん率が薄まるが、**薄まる方向＝発火しにくい方向**なので
  // 安全側であり、新しい閾値を増やさずに済む。
  const timedOut = window.filter(killedByCurrentBudget)
  const rate = timedOut.length / window.length
  if (rate >= t.TIMEOUT_RATE) {
    findings.push({
      sensorId: 'implement-timeout-rate-too-high',
      // 値ごとに 1 度だけ。timeout を変えたらもう一度だけ出る。
      scope: String(timeoutMs),
      // **数えているものの名前で書く。** 分子は「現在の budget を使い切った timeout」であって
      // provider_timeout 全体ではない。`provider_timeout 率` と書くと、この行を読んだ人が
      // 同じ名前で DB を数え直したときに**違う数字が出る**（独立レビュー指摘）。
      summary: `直近 ${window.length} 件の完了 implement で、budget を使い切った timeout の率が閾値を超えた`,
      evidence: {
        windowSize: window.length,
        budgetExhaustedTimeoutCount: timedOut.length,
        rate: Number(rate.toFixed(4)),
        timeoutSeconds,
      },
      thresholdNote:
        `rate >= ${t.TIMEOUT_RATE}。`
        // 7.3% は**旧 budget 下の provider_timeout 全体**の率で、ここの分子とは母数の取り方が違う。
        // 直接比較できる数字ではないので、参考値としてだけ置く。
        + ' 参考: 変更前の実測は provider_timeout 全体で 7/96 = 7.3% だった'
        + '（分子の定義が異なるため直接比較はできない）。',
    })
  }

  // ── C. 成功 Job の p95 が timeout へ接近 ──────────────────────────
  //
  // **C だけは epoch で絞らない。これは意図的である（CEO 判断・2026-09-18）。**
  //
  // - 旧 policy 下の成功 Job も**そのまま残して数える**。成功した Job の所要時間は
  //   budget に打ち切られていない実測値なので、どの policy 下でも有効な標本である
  // - **旧成功を混ぜても p95 が上がらない、とは言えない。** 分位点は順序統計量なので、
  //   下位に標本が増えると選ばれる位置がずれて**上がることがある**:
  //   現在の成功 25 件が 100s、旧成功 25 件が 230s なら、p95 は 100s から 230s へ上がる
  //   （独立レビュー指摘。この例は実際に計算して確かめた）。
  //   ここまでに「必ず下がる」「非増加」と 2 度書いたが、**どちらも誤り**である
  // - 言えるのは**もっと狭いこと**だけである: **発火閾値（budget の 60%）を下回る標本を
  //   足しても、p95 が閾値を跨いで上へ抜けることはない。**
  //   下に k 件足すと分位点の添字は約 0.95k しか進まないのに、閾値以上の塊はちょうど k だけ
  //   後ろへ押し出されるので、選択位置は塊から**さらに離れる**。
  //   旧 budget 300s 下の成功はすべて 300s 未満 = 540s 未満なので、この条件に当てはまる
  // - **これは「経過時間から policy regime を特定できる」という主張ではない。**
  //   上の議論は「閾値より下の標本を足す」という**今回の拡大に固有の条件**に依存している。
  //   budget を縮める変更では旧成功が閾値を上回りうるので、前提ごと崩れる。
  //   **そのときは C にも epoch を掛けるかどうかを測り直すこと**
  // **ここで測っているのは Job 全体の所要時間であって、budget の対象ではない。**
  //
  // `timeoutMs` が掛かるのは **AI CLI の子プロセスだけ**である。`jobRunner` は CLI のあと
  // 検査を行い、SafeCommand（`git_commit` 等）を実行してから `completedAt` を書く。
  // したがって `startedAt` → `completedAt` は **CLI 実行時間の上界**でしかない:
  // CLI が 895s で正常終了し、SafeCommand に 20s かかれば、Job は 915s の成功になる
  // （独立レビュー指摘）。
  //
  // **この差は発火を早める方向にだけ働く。** 上界で測っている以上、C は
  // 「CLI が budget へ近づいている」より早く鳴る。再評価の合図としては安全側だが、
  // **p95 の数値そのものを CLI の所要時間として読んではいけない。**
  //
  // ## budget 超えの標本を落とす実装は取り下げた（2026-09-21）
  //
  // 「成功が budget より長いのはあり得ない」として除外していたが**誤り**だった。
  // 上のとおり Job 全体は budget を超えうるし、しかも落ちるのは
  // **C が拾うべき「budget へ最も近い成功」そのもの**である。
  // 25 件の near-budget 成功が全部消えて C が黙る —— 目的を裏返していた。
  //
  // 書き換えられた `completedAt` による汚染（`PATCH /api/jobs/:id` は stale な `status` だけ
  // 落として残りを永続化する）は**ここでは塞がない**。塞げるだけ狭い上限は、
  // 同時に本物の near-budget 標本を捨てる。根本は Roadmap
  // `job-failure-metadata-outlives-its-run` で扱う。
  const successSeconds = window
    .filter((job) => job.status === 'success')
    .map(durationSeconds)
    .filter((seconds): seconds is number => seconds !== undefined)
  if (successSeconds.length >= t.P95_MIN_SAMPLES) {
    const p95 = percentile(successSeconds, 0.95)
    if (p95 !== undefined && p95 >= timeoutSeconds * t.P95_RATIO_OF_TIMEOUT) {
      findings.push({
        sensorId: 'implement-p95-approaching-timeout',
        scope: String(timeoutMs),
        summary: '成功した implement Job の p95 が現在の timeout へ接近した',
        evidence: {
          successSamples: successSeconds.length,
          p95Seconds: Math.round(p95),
          timeoutSeconds,
          ratio: Number((p95 / timeoutSeconds).toFixed(3)),
        },
        thresholdNote:
          `p95 >= timeout の ${t.P95_RATIO_OF_TIMEOUT * 100}%、かつ成功サンプル`
          + ` ${t.P95_MIN_SAMPLES} 件以上。サンプル不足のときは判定しない。`,
      })
    }
  }

  return findings
}

/** 発火記録の entity id。**これが重複発火防止の唯一の鍵である。** */
export function implementTimeoutSensorEntityId(
  finding: Pick<ImplementTimeoutFinding, 'sensorId' | 'scope'>,
): string {
  return `${finding.sensorId}:${finding.scope}`
}

/**
 * 判定して、まだ記録が無いものだけ `audit_log` へ残す。返り値は**今回新しく発火した分**。
 *
 * `runPlTick()` から best-effort で呼ぶ。**投げても PL の判断を変えない**
 * （記録の失敗が PL の結論を書き換えた事故が 2026-09-18 に別経路で起きている）。
 */
export function evaluateAndPersistImplementTimeoutSensors(
  storage: IStorage,
  timeoutMs: number,
  now: () => string = () => new Date().toISOString(),
): ImplementTimeoutFinding[] {
  // **判定より先に epoch を確定させる。** 初回はここが epoch の起点になるので、
  // それ以前の Job（どの budget で走ったか分からない）は最初から対象外になる。
  const policyEpochStart = ensureImplementTimeoutPolicyEpoch(storage, timeoutMs, now)

  const jobs = storage.jobs.findRecentAiCliJobs({
    provider: PROVIDER,
    mode: MODE,
    limit: IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS.WINDOW,
  })
  const findings = evaluateImplementTimeoutSensors(jobs, timeoutMs, policyEpochStart)

  const newlyFired: ImplementTimeoutFinding[] = []
  for (const finding of findings) {
    const entityId = implementTimeoutSensorEntityId(finding)
    if (storage.auditLog.findByEntity(AUDIT_ENTITY_TYPE, entityId).length > 0) continue

    storage.auditLog.record({
      actor: 'api',
      operation: AUDIT_OPERATION,
      entityType: AUDIT_ENTITY_TYPE,
      entityId,
      result: AUDIT_RESULT,
      // 発火根拠をこの 1 行へ全部入れる。読む側が集計し直すと条件がずれて再現できない。
      detail: JSON.stringify({
        summary: finding.summary,
        evidence: finding.evidence,
        thresholdNote: finding.thresholdNote,
      }),
    })
    newlyFired.push(finding)
  }
  return newlyFired
}
