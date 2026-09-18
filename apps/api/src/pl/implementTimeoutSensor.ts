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
  /** B: provider_timeout 率がこれ以上なら再評価（変更前は 7.3%）。 */
  TIMEOUT_RATE: 0.03,
  /** C: 成功 Job の p95 が timeout 値のこの割合へ達したら再評価。 */
  P95_RATIO_OF_TIMEOUT: 0.6,
  /** C: p95 を口にするために最低限必要な成功サンプル数。 */
  P95_MIN_SAMPLES: 20,
  /**
   * A: 「現在の budget を使い切った」とみなす下限（timeout 値に対する割合）。
   *
   * **これが古い 300s 時代の timeout を巻き込まないための鍵である。** 900s 運用下では
   * 810s 以上走った Job だけが A の対象になり、過去の ~300s の記録は入ってこない。
   * Job 行に「そのとき何秒の budget だったか」は残っていないので、所要時間から判定する。
   */
  CURRENT_BUDGET_RATIO: 0.9,
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

function isProviderTimeout(job: Job): boolean {
  return job.failureMetadata?.kind === 'provider_timeout'
}

function hasChangedFiles(job: Job): boolean {
  return Array.isArray(job.changedFiles) && job.changedFiles.length > 0
}

/** 昇順ソートした配列の分位点。サンプルが無ければ undefined。 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
}

/**
 * 判定本体（純関数）。`jobs` は新しい順で渡す。
 *
 * `timeoutMs` は**判定時点で implement に与えている値**で、A と C の基準に使う。
 */
export function evaluateImplementTimeoutSensors(
  jobs: readonly Job[],
  timeoutMs: number,
): ImplementTimeoutFinding[] {
  const t = IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS
  const window = jobs.slice(0, t.WINDOW)
  const findings: ImplementTimeoutFinding[] = []
  if (window.length === 0) return findings

  const timeoutSeconds = timeoutMs / 1000

  /**
   * **現在の budget を使い切って落ちたか。** A と B の両方がこれを通る。
   *
   * Job 行には「そのとき何秒の budget だったか」が残っていないので、所要時間で近似する。
   * これを B にも掛けないと、旧 300s 時代の timeout が新しい budget の証拠として
   * 数えられてしまう（独立レビュー指摘）。
   */
  const killedInsideCurrentBudget = (job: Job): boolean => {
    if (!isProviderTimeout(job)) return false
    const seconds = durationSeconds(job)
    return seconds !== undefined && seconds >= timeoutSeconds * t.CURRENT_BUDGET_RATIO
  }

  // ── A. 現在の budget を使い切ってなお作業中だった Job ──────────────────
  // 「1 件でも再発したら再評価」なので Job ごとに 1 度だけ出す。
  for (const job of window) {
    if (!killedInsideCurrentBudget(job) || !hasChangedFiles(job)) continue
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
        `provider_timeout かつ changedFiles ありで、所要時間が現在の budget の`
        + ` ${t.CURRENT_BUDGET_RATIO * 100}% 以上。1 件でも再評価対象（CEO 指示・2026-09-18）。`,
    })
  }

  // ── B. timeout 率 ────────────────────────────────────────────────
  //
  // **分子は「現在の budget を使い切った timeout」だけである。**
  // ここを素の `isProviderTimeout` にしていると、deploy 直後の窓に残っている
  // 旧 300s 時代の timeout だけで閾値を超えてしまう。しかも B の重複排除キーは
  // budget 値なので、**一度そうやって発火すると同じ budget では二度と出ない** ——
  // つまり後から本物の 900s 時代の証拠が揃っても黙る。
  // 古い証拠で先に発火して、拾うべき将来の証拠を潰す形だった（独立レビュー指摘）。
  //
  // 分母は窓全体（直近の implement Job すべて）のままにする。移行期は分母に旧 Job が
  // 混じるぶん率が薄まるが、**薄まる方向＝発火しにくい方向**なので安全側である。
  const timedOut = window.filter(killedInsideCurrentBudget)
  const rate = timedOut.length / window.length
  if (rate >= t.TIMEOUT_RATE) {
    findings.push({
      sensorId: 'implement-timeout-rate-too-high',
      // 値ごとに 1 度だけ。timeout を変えたらもう一度だけ出る。
      scope: String(timeoutMs),
      summary: `直近 ${window.length} 件の implement で provider_timeout 率が閾値を超えた`,
      evidence: {
        windowSize: window.length,
        timeoutCount: timedOut.length,
        rate: Number(rate.toFixed(4)),
        timeoutSeconds,
      },
      thresholdNote:
        `rate >= ${t.TIMEOUT_RATE}。変更前の実測は 7/96 = 7.3% だった。`
        + ' これを下回らないなら、広げた値がまだ足りていない。',
    })
  }

  // ── C. 成功 Job の p95 が timeout へ接近 ──────────────────────────
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
): ImplementTimeoutFinding[] {
  const jobs = storage.jobs.findRecentAiCliJobs({
    provider: PROVIDER,
    mode: MODE,
    limit: IMPLEMENT_TIMEOUT_SENSOR_THRESHOLDS.WINDOW,
  })
  const findings = evaluateImplementTimeoutSensors(jobs, timeoutMs)

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
