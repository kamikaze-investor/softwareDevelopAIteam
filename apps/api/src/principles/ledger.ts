import {
  PRINCIPLE_REVIEW_STAGES,
  PRINCIPLE_SELECTION_SOURCES,
} from '@ai-team/shared'
import type {
  AppliedPrinciple,
  PrincipleAggregateQuery,
  PrincipleAggregateRow,
  PrincipleApplicationInput,
  PrincipleDisagreementRow,
  PrincipleReviewStage,
  PrincipleSensorFinding,
  StrategicDecision,
} from '@ai-team/shared'
import { corePrincipleSlugs, loadEngineeringPrinciples } from '@ai-team/shared/src/engineeringPrinciples.js'
import type { IStorage } from '../storage/interface'

/**
 * Principle 適用・判定の記録と、そこから原則自体の再Review候補を起こすセンサー。
 *
 * **ここは計測であって Gate ではない。** 記録に失敗しても Review を止めない
 * （観測を足したこと自体が新しい停止要因になってはならない）。失敗は warn で可視化する。
 */

const AUDIT_OPERATION = 'principle_sensor_fired'
const AUDIT_ENTITY_TYPE = 'principle_sensor'
const AUDIT_RESULT = 'fired'

/**
 * センサー閾値。**すべて暫定値である**（2026-09-17 時点で実データが 0 件のため）。
 *
 * - `CORE_DEMOTION_MIN_APPLICATIONS = 50`: CEO が 2026-09-17 に指定した値。
 *   根拠は「1つの原則について demote を議論するに足る回数」であり、分布からの導出ではない。
 * - `MECHANISM_REVIEW_MIN_APPLICATIONS = 200`: 上の 4 倍。核となる原則が 4 件あるため、
 *   「core 全件がそれぞれ demotion 閾値に達した規模」を機構全体の評価開始点にした。
 *   これも分布からの導出ではない。
 *
 * **変更するときは、変更後の値だけでなく「どの実測を見てそう決めたか」を併記すること。**
 * 実データが貯まる前に閾値を精密化しない（`specs/21` standard-design-frame）。
 */
export const PRINCIPLE_SENSOR_THRESHOLDS = {
  CORE_DEMOTION_MIN_APPLICATIONS: 50,
  MECHANISM_REVIEW_MIN_APPLICATIONS: 200,
} as const

export interface PrincipleLedgerSubject {
  projectId: string
  taskId?: string
  roadmapItemId?: string
  reviewRunId?: string
}

/** Review 結果のうち、この層が必要とする部分だけ。runner の完全な型には依存しない。 */
export interface PrincipleLedgerReviewResult {
  focusedReviewResults?: ReadonlyArray<{ appliedPrinciples?: AppliedPrinciple[] } | undefined>
  independentReviewResult?: { appliedPrinciples?: AppliedPrinciple[] } | undefined
}

export interface RecordPrincipleApplicationsResult {
  recorded: number
  sensorFindings: PrincipleSensorFinding[]
  /** 記録できなかった場合の理由。Review は止めずにここで可視化する。 */
  error?: string
}

/**
 * 判定の強さ。**同じ原則を複数 focus が判定したときは強い方を残す。**
 *
 * 1 review = 1 原則 = 1 行にしたいが、単純に先勝ちにすると
 * 「focus A は ALIGNED、focus B は CONFLICT」のときに CONFLICT を捨ててしまう。
 * 捨てる方向が「衝突を見逃す」側になるので、強い方を残す。
 */
const VERDICT_STRENGTH: Record<StrategicDecision, number> = {
  ALIGNED: 0,
  UNCERTAIN: 1,
  CONFLICT: 2,
}

/**
 * 1 回の Review から原則適用を記録し、続けてセンサーを評価する。
 *
 * **センサー評価をここで行うのは、「後で誰かが見る」に依存しないため。**
 * 新しいデータが入った瞬間だけが評価が必要なタイミングであり、
 * 新しい scheduler も cron も増やさずに閉ループになる（`observation-closes-loop`）。
 */
export function recordPrincipleApplications(
  storage: IStorage,
  subject: PrincipleLedgerSubject,
  review: PrincipleLedgerReviewResult,
): RecordPrincipleApplicationsResult {
  try {
    // **runner の出力をそのまま信用しない。** ここは worker が出した JSON が API 側の
    // 永続化へ入る信頼境界である。registry に存在しない principleId は捨てる
    // （独立レビュー指摘 2026-09-17: 捏造 id が統計へ入る経路があった）。
    //
    // versionHash は「reviewer に実際に見せた版」を表すので、現在の registry と違っても
    // そのまま記録する。spec が実行中に更新された場合に古い版を記録するのが正しい。
    // **run に紐づかない記録は書かない。**
    //
    // 重複排除の unique index は `review_run_id IS NOT NULL` の行にしか効かない。
    // run id 無しで書けてしまうと、同じ Review 結果を2回処理しただけで適用数が増え、
    // センサーが実態より早く発火する（独立レビュー指摘 2026-09-17 第4回）。
    // 現在の呼び出し元は必ず run id を渡すので、これは将来の呼び出し元に対する fail-closed である。
    if (subject.reviewRunId === undefined || subject.reviewRunId.length === 0) {
      console.warn('[principleLedger] refusing to record principle applications without a reviewRunId')
      return { recorded: 0, sensorFindings: [], error: 'reviewRunId is required' }
    }

    const known = knownPrincipleIds()
    const entries: PrincipleApplicationInput[] = [
      ...buildStageEntries(subject, 'design', collectFocusPrinciples(review), known),
      ...buildStageEntries(subject, 'independent', review.independentReviewResult?.appliedPrinciples ?? [], known),
    ]

    if (entries.length === 0) {
      return { recorded: 0, sensorFindings: [] }
    }

    const recorded = storage.principleApplications.recordMany(entries)
    const sensorFindings = evaluateAndPersistSensors(storage)

    return { recorded, sensorFindings }
  } catch (err) {
    // **Review を失敗させない。** 計測が壊れても判定は判定として成立する。
    const error = err instanceof Error ? err.message : String(err)
    console.warn(`[principleLedger] failed to record principle applications: ${error}`)
    return { recorded: 0, sensorFindings: [], error }
  }
}

/**
 * 複数 focus の判定を原則ごとに 1 件へ畳む。CONFLICT > UNCERTAIN > ALIGNED。
 * 採用した判定の理由をそのまま残すので、なぜその verdict になったかが後から読める。
 */
function collectFocusPrinciples(review: PrincipleLedgerReviewResult): AppliedPrinciple[] {
  const strongest = new Map<string, AppliedPrinciple>()

  for (const focusResult of review.focusedReviewResults ?? []) {
    for (const applied of focusResult?.appliedPrinciples ?? []) {
      const existing = strongest.get(applied.principleId)
      if (existing === undefined || VERDICT_STRENGTH[applied.verdict] > VERDICT_STRENGTH[existing.verdict]) {
        strongest.set(applied.principleId, applied)
      }
    }
  }

  return [...strongest.values()]
}

const RECORDABLE_VERDICTS: readonly StrategicDecision[] = ['ALIGNED', 'CONFLICT', 'UNCERTAIN']

/**
 * registry が出す版 hash の形（`principleVersionHash()` は sha256 の先頭 16 桁）。
 *
 * 「空でない文字列」だけだと `"x"` のような値が通り、**実在しない版**の行ができる。
 * そうなると現在版との突き合わせが外れ、集計もセンサーも誤る（独立レビュー指摘 2026-09-17 第4回）。
 */
const PRINCIPLE_VERSION_HASH_PATTERN = /^[0-9a-f]{16}$/u

/** 記録してよい判定か。id・verdict・selectionSource・reviewStage の語彙をすべて閉じた集合で検査する。 */
function isRecordableVerdict(item: AppliedPrinciple, known: ReadonlySet<string>): boolean {
  return known.has(item.principleId)
    && RECORDABLE_VERDICTS.includes(item.verdict)
    && PRINCIPLE_SELECTION_SOURCES.includes(item.selectionSource)
    && typeof item.principleVersionHash === 'string'
    && PRINCIPLE_VERSION_HASH_PATTERN.test(item.principleVersionHash)
}

/** registry に載っている原則 id。読めないときは空集合を返し、何も記録しない（fail-closed）。 */
function knownPrincipleIds(): Set<string> {
  const principles = loadEngineeringPrinciples()
  return principles.ok ? new Set(principles.bySlug.keys()) : new Set<string>()
}

function buildStageEntries(
  subject: PrincipleLedgerSubject,
  reviewStage: PrincipleReviewStage,
  applied: readonly AppliedPrinciple[],
  known: ReadonlySet<string>,
): PrincipleApplicationInput[] {
  if (!PRINCIPLE_REVIEW_STAGES.includes(reviewStage)) {
    return []
  }

  // runner が出した値が閉じた集合の外なら落とす。**DB の CHECK 制約に任せない** —
  // `INSERT OR IGNORE` は制約違反も黙って捨てるので、ここで弾かないと
  // 「記録したつもりで 0 件」が静かに起きる（独立レビュー指摘 2026-09-17）。
  const rejected = applied.filter((item) => !isRecordableVerdict(item, known))
  if (rejected.length > 0) {
    console.warn(
      '[principleLedger] dropping ' + rejected.length + ' unusable verdict(s): '
      + rejected.map((item) => item.principleId + '/' + item.verdict + '/' + item.selectionSource).join(', '),
    )
  }

  return applied.filter((item) => isRecordableVerdict(item, known)).map((item) => ({
    projectId: subject.projectId,
    roadmapItemId: subject.roadmapItemId,
    taskId: subject.taskId,
    principleId: item.principleId,
    principleVersionHash: item.principleVersionHash,
    selectionSource: item.selectionSource,
    selectionReason: item.selectionReason,
    reviewStage,
    verdict: item.verdict,
    reviewRunId: subject.reviewRunId,
  }))
}

/**
 * センサーを評価し、**まだ発火記録の無いものだけ**を永続化する。
 *
 * 発火記録は `audit_log` に置く。ここは高頻度の多次元集計ではなく
 * 「このセンサーは発火済みか」という 1 entity の問い合わせなので、
 * `ix_audit_log_entity` にそのまま載る（適用記録を専用 table にした理由と矛盾しない）。
 */
export function evaluateAndPersistSensors(storage: IStorage): PrincipleSensorFinding[] {
  const findings = evaluatePrincipleSensors(currentVersionSensorInput(storage))

  const newlyFired: PrincipleSensorFinding[] = []

  for (const finding of findings) {
    const entityId = sensorEntityId(finding)
    if (storage.auditLog.findByEntity(AUDIT_ENTITY_TYPE, entityId).length > 0) {
      continue
    }

    storage.auditLog.record({
      actor: 'api',
      operation: AUDIT_OPERATION,
      entityType: AUDIT_ENTITY_TYPE,
      entityId,
      result: AUDIT_RESULT,
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

export function sensorEntityId(finding: Pick<PrincipleSensorFinding, 'sensorId' | 'principleId'>): string {
  return `${finding.sensorId}:${finding.principleId ?? 'all'}`
}

/**
 * センサー判定（純関数）。
 *
 * **原則を書き換えない。** 出力は「再Reviewすべき候補」であり、そこまでが責務である（CEO 指示）。
 */
/**
 * センサーの入力は**現在の registry 版で下した判定だけ**に限る。
 *
 * 原則本文を書き換えると版 hash が変わる。旧版に対する判定を混ぜたまま
 * 「50 件一度も CONFLICT していない」と言うと、**今は存在しない文章についての実績**で
 * 降格を提案してしまう（独立レビュー指摘 2026-09-17）。版を跨いだら数え直す。
 */
function currentVersionSensorInput(storage: IStorage): {
  aggregates: PrincipleAggregateRow[]
  coreIds: string[]
} {
  const principles = loadEngineeringPrinciples()
  if (!principles.ok) {
    return { aggregates: [], coreIds: [] }
  }

  const byVersion = storage.principleApplications.aggregateByVersion()
  const aggregates = byVersion.filter((row) => {
    return principles.bySlug.get(row.principleId as never)?.versionHash === row.principleVersionHash
  })

  return { aggregates, coreIds: corePrincipleSlugs(principles) }
}

export function evaluatePrincipleSensors(input: {
  aggregates: readonly PrincipleAggregateRow[]
  coreIds: readonly string[]
}): PrincipleSensorFinding[] {
  const findings: PrincipleSensorFinding[] = []
  const byPrincipleId = new Map(input.aggregates.map((row) => [row.principleId, row]))

  // センサー1: core であり続ける必要があるかを再評価する。
  // 「毎回 prompt に載せているのに一度も判断を動かしていない」原則は、contextual で足りる可能性がある。
  for (const coreId of input.coreIds) {
    const row = byPrincipleId.get(coreId)
    if (row === undefined) {
      continue
    }
    if (
      row.applications >= PRINCIPLE_SENSOR_THRESHOLDS.CORE_DEMOTION_MIN_APPLICATIONS
      && row.conflict === 0
      && row.uncertain === 0
    ) {
      findings.push({
        sensorId: 'core-principle-never-conflicts',
        principleId: coreId,
        summary: `Re-review whether '${coreId}' still needs to be a core principle, or whether contextual selection would be enough.`,
        evidence: `applications=${row.applications}, conflict=0, uncertain=0 (every recorded review judged it ALIGNED)`,
        thresholdNote: `provisional threshold: applications >= ${PRINCIPLE_SENSOR_THRESHOLDS.CORE_DEMOTION_MIN_APPLICATIONS} with zero CONFLICT and zero UNCERTAIN. Set by CEO on 2026-09-17; not derived from an observed distribution.`,
      })
    }
  }

  // センサー2: 機構そのものを再評価する。
  // 全体で一度も CONFLICT / UNCERTAIN が出ないなら、原則判定が実質的に飾りになっている疑いがある。
  // 「原則が完璧だから」と「Reviewer が原則を見ていないから」は、この数字だけでは区別できない。
  // だからこそ自動で何かを変えず、人間・AI の再Review候補として出す。
  const totalApplications = input.aggregates.reduce((sum, row) => sum + row.applications, 0)
  const totalNonAligned = input.aggregates.reduce((sum, row) => sum + row.conflict + row.uncertain, 0)

  if (
    totalApplications >= PRINCIPLE_SENSOR_THRESHOLDS.MECHANISM_REVIEW_MIN_APPLICATIONS
    && totalNonAligned === 0
  ) {
    findings.push({
      sensorId: 'principle-review-not-discriminating',
      summary: 'Re-review the principle-compliance mechanism itself: it has never produced a CONFLICT or UNCERTAIN verdict.',
      evidence: `applications=${totalApplications} across ${input.aggregates.length} principles, conflict+uncertain=0`,
      thresholdNote: `provisional threshold: total applications >= ${PRINCIPLE_SENSOR_THRESHOLDS.MECHANISM_REVIEW_MIN_APPLICATIONS} with zero CONFLICT and zero UNCERTAIN. Chosen as 4x the per-principle threshold because there are 4 core principles; not derived from an observed distribution.`,
    })
  }

  return findings
}

export interface PrincipleStats {
  aggregates: PrincipleAggregateRow[]
  byReviewStage: Array<{ reviewStage: PrincipleReviewStage; aggregates: PrincipleAggregateRow[] }>
  disagreements: PrincipleDisagreementRow[]
  /** registry にあるのに一度も適用されていない原則。`aggregate()` からは行として出てこない。 */
  unusedPrincipleIds: string[]
  /** 現在発火しているセンサー（発火済み記録の有無に関わらず、いまの数字で評価した結果）。 */
  sensors: PrincipleSensorFinding[]
}

/**
 * 集計 API のための読み取り。**新しい metrics backend を作らない**（CEO 指示）。
 * 既存 SQLite への SQL と registry の読み込みだけで組み立てる。
 */
export function buildPrincipleStats(storage: IStorage, query?: PrincipleAggregateQuery): PrincipleStats {
  const aggregates = storage.principleApplications.aggregate(query)
  const principles = loadEngineeringPrinciples()
  const seen = new Set(aggregates.map((row) => row.principleId))

  const allPrincipleIds = principles.ok ? [...principles.bySlug.keys()] : []

  return {
    aggregates,
    byReviewStage: (['design', 'independent', 'meta'] as const).map((reviewStage) => ({
      reviewStage,
      aggregates: storage.principleApplications.aggregate({ ...query, reviewStage }),
    })),
    disagreements: storage.principleApplications.findDisagreements(query),
    unusedPrincipleIds: allPrincipleIds.filter((id) => !seen.has(id)),
    // センサーは表示用の絞り込み（query）に引きずられない。**機構全体の状態**を見るものなので、
    // project で絞った画面からでも同じ判定が出る。
    sensors: evaluatePrincipleSensors(currentVersionSensorInput(storage)),
  }
}
