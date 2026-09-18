import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  corePrincipleSlugs,
  loadEngineeringPrinciples,
  normalizeAppliedPrinciples,
  selectPrinciples,
} from '@ai-team/shared/src/engineeringPrinciples.js'
import type { StrategicDecision } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import {
  PRINCIPLE_SENSOR_THRESHOLDS,
  buildPrincipleStats,
  evaluateAndPersistSensors,
  recordPrincipleApplications,
  sensorEntityId,
  thresholdPolicyVersion,
} from './ledger'

/**
 * 100 件到達で「暫定閾値を実データで再評価する」候補を起こすセンサーの回帰テスト
 * （CEO 指示 2026-09-18）。
 *
 * ここで固定したいのは 4 点である。
 * 1. 100 件で発火し、それ未満では発火しない
 * 2. 101 件目・102 件目で**同じ Review を出さない**
 * 3. 閾値 policy を変えたら**もう一度だけ**発火する（新しい persistent state を使わずに）
 * 4. センサーは閾値も原則も**書き換えない**
 */

function createStorage(): IStorage {
  return createSQLiteStorage(':memory:')
}

function seedProject(storage: IStorage): string {
  const project = storage.projects.create({
    name: 'Threshold sensor', goal: 'g', designPhilosophy: [], status: 'draft',
  })
  return project.id
}

const THRESHOLD_SENSOR_ID = 'threshold-policy-needs-real-data-review'

/**
 * 1 run につき 1 原則だけ記録する。
 *
 * 選択結果をまとめて記録すると 1 run で複数件入り、「ちょうど N 件」の境界を作れない。
 * 境界そのものを検証したいので、記録の粒度を 1 件に落としている。
 */
function recordOne(
  storage: IStorage,
  projectId: string,
  index: number,
  options?: { verdict?: StrategicDecision; independentVerdict?: StrategicDecision },
): ReturnType<typeof recordPrincipleApplications> {
  const principles = loadEngineeringPrinciples()
  const selection = selectPrinciples(undefined, principles).slice(0, 1)
  const applied = (verdict: StrategicDecision) => normalizeAppliedPrinciples(
    selection.map((item) => ({ principleId: item.slug, verdict, reason: 'fine' })),
    selection,
  )

  return recordPrincipleApplications(
    storage,
    { projectId, taskId: `task-${index}`, reviewRunId: `run-${index}` },
    {
      focusedReviewResults: [{ appliedPrinciples: applied(options?.verdict ?? 'ALIGNED') }],
      independentReviewResult: options?.independentVerdict === undefined
        ? undefined
        : { appliedPrinciples: applied(options.independentVerdict) },
    },
  )
}

function fillTo(storage: IStorage, projectId: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    recordOne(storage, projectId, index)
  }
}

function thresholdSensors(storage: IStorage) {
  return buildPrincipleStats(storage).sensors.filter((finding) => finding.sensorId === THRESHOLD_SENSOR_ID)
}

function thresholdAuditRows(storage: IStorage, policyVersion = thresholdPolicyVersion()) {
  return storage.auditLog.findByEntity(
    'principle_sensor',
    sensorEntityId({ sensorId: THRESHOLD_SENSOR_ID, policyVersion }),
  )
}

describe('threshold policy review sensor', () => {
  it('100 件未満では発火せず、ちょうど 100 件で 1 度だけ発火する', () => {
    const storage = createStorage()
    const projectId = seedProject(storage)
    const limit = PRINCIPLE_SENSOR_THRESHOLDS.THRESHOLD_REVIEW_MIN_APPLICATIONS

    fillTo(storage, projectId, limit - 1)
    expect(thresholdSensors(storage)).toHaveLength(0)
    expect(thresholdAuditRows(storage)).toHaveLength(0)

    const fired = recordOne(storage, projectId, limit - 1)
    const finding = fired.sensorFindings.find((item) => item.sensorId === THRESHOLD_SENSOR_ID)

    expect(finding).toBeDefined()
    expect(finding?.evidence).toContain(`applications=${limit}`)
    expect(finding?.thresholdNote).toContain('never a new value')
    expect(thresholdAuditRows(storage)).toHaveLength(1)
  })

  it('101 件目・102 件目・103 件目で同じ Review を出さない', () => {
    const storage = createStorage()
    const projectId = seedProject(storage)
    const limit = PRINCIPLE_SENSOR_THRESHOLDS.THRESHOLD_REVIEW_MIN_APPLICATIONS

    fillTo(storage, projectId, limit)
    expect(thresholdAuditRows(storage)).toHaveLength(1)

    for (let index = limit; index < limit + 3; index += 1) {
      const result = recordOne(storage, projectId, index)
      // **新しく発火した候補としては返らない。** 返ってしまうと、呼び出し元が
      // 「今また発火した」として毎回下流へ流してしまう。
      expect(result.sensorFindings.filter((item) => item.sensorId === THRESHOLD_SENSOR_ID)).toHaveLength(0)
    }

    // audit 行は増えない = Improvement Planner が同じ候補を 4 回受け取らない。
    expect(thresholdAuditRows(storage)).toHaveLength(1)

    // **条件としては成立し続けている。** 「発火条件が消えた」のではなく
    // 「発火済みだから出さない」であることを確かめる（後者でなければ、
    // 一度しきい値を割ったら二度と出せなくなる）。
    expect(thresholdSensors(storage)).toHaveLength(1)
  })

  it('閾値 policy を変えると別の entity id になり、もう一度だけ発火できる', () => {
    const storage = createStorage()
    const projectId = seedProject(storage)

    fillTo(storage, projectId, PRINCIPLE_SENSOR_THRESHOLDS.THRESHOLD_REVIEW_MIN_APPLICATIONS)
    expect(thresholdAuditRows(storage)).toHaveLength(1)

    // 閾値を 1 つ変えた policy は別の版になる。
    const changed = thresholdPolicyVersion({ ...PRINCIPLE_SENSOR_THRESHOLDS, CORE_DEMOTION_MIN_APPLICATIONS: 80 })
    expect(changed).not.toBe(thresholdPolicyVersion())
    expect(changed).toMatch(/^[0-9a-f]{16}$/u)

    // その版については「発火済み」の記録が無いので、また 1 回だけ出せる。
    expect(thresholdAuditRows(storage, changed)).toHaveLength(0)

    // 版は値からの導出なので、同じ値なら何度呼んでも同じ。手書きの版番号は無い。
    expect(thresholdPolicyVersion()).toBe(thresholdPolicyVersion())
    expect(thresholdPolicyVersion({})).toBe(thresholdPolicyVersion())

    // **`PRINCIPLE_SENSOR_THRESHOLDS` の全 key が版の入力に入っている。**
    // key を列挙して回すので、閾値を 1 つ足して slot 表へ入れ忘れたらここが落ちる
    // （表から漏れた閾値は、あとで値を変えても版が回らず再評価が永久に起きない。
    //  独立レビュー指摘 2026-09-18 round2-critical-1）。
    const keys = Object.keys(PRINCIPLE_SENSOR_THRESHOLDS) as Array<keyof typeof PRINCIPLE_SENSOR_THRESHOLDS>
    expect(keys.length).toBeGreaterThan(0)
    const versions = new Set([
      thresholdPolicyVersion(),
      ...keys.map((key) => thresholdPolicyVersion({ [key]: PRINCIPLE_SENSOR_THRESHOLDS[key] + 7 })),
    ])
    expect(versions.size).toBe(keys.length + 1)
  })

  it('閾値を変えない限り policy 版は動かない（無関係な変更で episode を作り直さない）', () => {
    // **この値が変わったら、それは閾値を変えたということである。**
    //
    // 版が動くと `audit_log` 上は別 entity になり、既に 100 件を超えている環境では
    // 再評価 Review が**もう一度**発火する。閾値以外のリファクタで版が動くと、
    // 誰も値を変えていないのに Improvement Planner へ同じ候補が積まれる。
    // ここを固定しておけば、版が動く変更は必ずこのテストの失敗として見える。
    //
    // 意図して閾値を変えたときは、この期待値も更新し、
    // **どの実測を見てそう決めたか**を `PRINCIPLE_SENSOR_THRESHOLDS` の doc comment へ書くこと。
    expect(thresholdPolicyVersion()).toBe('14ed9fe6c13a805e')

    // 版の入力は閾値の**値**だけである。原則本文・registry・記録件数には依存しない。
    expect(thresholdPolicyVersion({ ...PRINCIPLE_SENSOR_THRESHOLDS })).toBe(thresholdPolicyVersion())

    // **定数名を変えても版は動かない。** 版へ入るのは `THRESHOLD_POLICY_SLOTS` の
    // 固定 slot 名であって、TypeScript の property 名ではない
    // （独立レビュー指摘 2026-09-18 critical-1）。この期待値は slot 名から算出されている。
    const canonical = [
      'core_demotion_min_applications=50',
      'mechanism_review_min_applications=200',
      'threshold_review_min_applications=100',
    ].join(';')
    expect(createHash('sha256').update(canonical, 'utf-8').digest('hex').slice(0, 16))
      .toBe(thresholdPolicyVersion())
  })

  it('既に記録済みの適用は、別 run で足した分と合算して閾値へ到達する', () => {
    // production に既にある 38 件を「継続して数えられる」ことの回帰。
    // 版が同じなら過去の run の行もそのまま数える（記録し直さない）。
    const storage = createStorage()
    const projectId = seedProject(storage)
    const limit = PRINCIPLE_SENSOR_THRESHOLDS.THRESHOLD_REVIEW_MIN_APPLICATIONS

    fillTo(storage, projectId, 38)
    expect(thresholdSensors(storage)).toHaveLength(0)

    // 以降は「別のセッションで足した分」のつもりで続きから記録する。
    for (let index = 38; index < limit; index += 1) {
      recordOne(storage, projectId, index)
    }

    const finding = thresholdSensors(storage)[0]
    expect(finding).toBeDefined()
    // 38 件を数え直していれば 62 件で止まり、ここは limit にならない。
    expect(finding?.reviewInput?.totalApplications).toBe(limit)
  })

  it('既存センサーの entity id は従来の形のままで、過去の発火記録を無効化しない', () => {
    // policyVersion を持たないセンサーの id に版が混ざると、既に発火済みの候補が
    // 「未発火」に見えてもう一度出てしまう。
    expect(sensorEntityId({ sensorId: 'core-principle-never-conflicts', principleId: 'x' }))
      .toBe('core-principle-never-conflicts:x')
    expect(sensorEntityId({ sensorId: 'principle-review-not-discriminating' }))
      .toBe('principle-review-not-discriminating:all')
    expect(sensorEntityId({ sensorId: THRESHOLD_SENSOR_ID, policyVersion: 'abc123' }))
      .toBe(`${THRESHOLD_SENSOR_ID}:all:abc123`)
  })

  it('再評価 Review の入力に、CEO が指定した観測項目がすべて入っている', () => {
    const storage = createStorage()
    const projectId = seedProject(storage)
    const limit = PRINCIPLE_SENSOR_THRESHOLDS.THRESHOLD_REVIEW_MIN_APPLICATIONS

    // 判定を割らせる: design は ALIGNED、independent は CONFLICT。
    for (let index = 0; index < limit; index += 1) {
      const disagree = index % 10 === 0
      recordOne(storage, projectId, index, {
        verdict: 'ALIGNED',
        independentVerdict: disagree ? 'CONFLICT' : undefined,
      })
    }

    const finding = thresholdSensors(storage)[0]
    const review = finding?.reviewInput
    expect(review).toBeDefined()
    if (review === undefined) return

    expect(review.totalApplications).toBeGreaterThanOrEqual(limit)
    expect(review.alignedRate + review.conflictRate + review.uncertainRate).toBeCloseTo(1, 10)
    expect(review.thresholds.CORE_DEMOTION_MIN_APPLICATIONS).toBe(50)
    expect(review.thresholds.MECHANISM_REVIEW_MIN_APPLICATIONS).toBe(200)
    expect(review.perPrinciple.length).toBeGreaterThan(0)
    expect(review.perPrinciple[0].applications).toBeGreaterThan(0)
    expect(review.skew.maxShare).toBeGreaterThan(0)
    expect(review.skew.principlesApplied).toBe(review.perPrinciple.length)
    expect(review.skew.principlesNeverApplied).toBeGreaterThan(0)
    expect(Array.isArray(review.coreDemotionSensorFiringFor)).toBe(true)
    expect(typeof review.mechanismReviewSensorFiring).toBe('boolean')

    // **disagreement 率の分母は「2 stage 以上が判定した組」である。**
    // 適用総数を分母にすると、片側の stage しか判定していない行まで数えて率が低く出る。
    expect(review.disagreementComparisons).toBe(10)
    expect(review.disagreements).toBe(10)
    expect(review.disagreementRate).toBe(1)
    expect(review.disagreementComparisons).toBeLessThan(review.totalApplications)

    // audit_log にそのまま入って、Improvement Planner が既存経路で読める。
    //
    // **保存されているのは発火時点のスナップショットである。** 発火後も記録は増え続けるので、
    // いま集計し直した値（`review`）とは一致しない。一致させようとすると
    // 「何を見て発火したのか」が後から書き換わってしまう。
    const detail = thresholdAuditRows(storage)[0]?.detail
    expect(detail).toBeDefined()
    const persisted = JSON.parse(detail ?? '{}')
    expect(persisted.policyVersion).toBe(thresholdPolicyVersion())
    expect(persisted.reviewInput?.totalApplications).toBe(limit + 1)
    expect(persisted.reviewInput.totalApplications).toBeLessThan(review.totalApplications)
    expect(Object.keys(persisted.reviewInput).sort()).toEqual([
      'alignedRate',
      'conflictRate',
      'coreDemotionSensorFiringFor',
      'disagreementComparisons',
      'disagreementRate',
      'disagreements',
      'mechanismReviewSensorFiring',
      'perPrinciple',
      'skew',
      'thresholds',
      'totalApplications',
      'uncertainRate',
    ])
  })

  it('旧版の判定は不一致率の母集団に入らない（閾値判定と同じ集合を見る）', () => {
    // 独立レビュー指摘 2026-09-18 major-3 の回帰。
    // 適用数は「現在の版の行」だけを数えるのに、不一致率だけ全版から出していると、
    // 原則本文を書き換えたあとに **別々の集合を指す 2 つの数字**が 1 つの Review 入力へ同居する。
    const storage = createStorage()
    const projectId = seedProject(storage)
    const limit = PRINCIPLE_SENSOR_THRESHOLDS.THRESHOLD_REVIEW_MIN_APPLICATIONS
    const principleId = selectPrinciples(undefined, loadEngineeringPrinciples())[0].slug

    // 現在の版で 1 件だけ割らせる。
    recordOne(storage, projectId, 0, { verdict: 'ALIGNED', independentVerdict: 'CONFLICT' })
    for (let index = 1; index < limit; index += 1) {
      recordOne(storage, projectId, index)
    }

    // **registry に存在しない旧版**の行を、割れた状態で直接入れる。
    // ledger 経由だと版 hash が検証されるので、storage へ直接入れて「過去に記録された旧版」を作る。
    const stale = '0123456789abcdef'
    for (const reviewStage of ['design', 'independent'] as const) {
      storage.principleApplications.recordMany([{
        projectId,
        taskId: 'task-stale',
        principleId,
        principleVersionHash: stale,
        selectionSource: 'core',
        selectionReason: 'stale version row',
        reviewStage,
        verdict: reviewStage === 'design' ? 'ALIGNED' : 'CONFLICT',
        reviewRunId: 'run-stale',
      }])
    }

    // 旧版の組は突き合わせ対象としては存在する。
    expect(storage.principleApplications.countStageComparisons().comparisons).toBe(2)

    // センサーが見るのは現在の版だけなので 1 件。
    const review = thresholdSensors(storage)[0]?.reviewInput
    expect(review).toBeDefined()
    expect(review?.disagreementComparisons).toBe(1)
    expect(review?.disagreements).toBe(1)
    // 適用数にも旧版は入っていない（母集団が一致している）。
    expect(review?.totalApplications).toBe(limit + 1)
  })

  it('発火しても閾値と原則の tier は書き換わらない', () => {
    const storage = createStorage()
    const projectId = seedProject(storage)
    const before = { ...PRINCIPLE_SENSOR_THRESHOLDS }
    const coreBefore = [...corePrincipleSlugs(loadEngineeringPrinciples())]

    fillTo(storage, projectId, PRINCIPLE_SENSOR_THRESHOLDS.THRESHOLD_REVIEW_MIN_APPLICATIONS)
    expect(thresholdAuditRows(storage)).toHaveLength(1)

    // **センサーの責務は候補を起こすところまで。** 値も tier も自動では動かない。
    expect({ ...PRINCIPLE_SENSOR_THRESHOLDS }).toEqual(before)
    expect(corePrincipleSlugs(loadEngineeringPrinciples())).toEqual(coreBefore)

    // 再評価しても閾値は据え置きのまま。
    evaluateAndPersistSensors(storage)
    expect({ ...PRINCIPLE_SENSOR_THRESHOLDS }).toEqual(before)
  })
})
