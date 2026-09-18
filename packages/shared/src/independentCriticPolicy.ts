/**
 * Independent Critic の**純粋な判定部分**。
 *
 * Critic は Design Review が CONFLICT を返した設計について、**PL の設計と Review Finding の
 * 双方を独立した第三者として批判する** read-only の分析役である。
 *
 * ## Critic が持たない権限（ここが役割の定義そのもの）
 *
 * - **Task Spec mutation authority を持たない。** 修正案を書いてよいが、適用はしない。
 *   Task Design の Owner は PL のままである
 * - **formal verdict authority を持たない。** PASS / CONFLICT を決めない。最終判定は
 *   既存 Review Pipeline（`recomputeDecision()`）だけが行う
 *
 * この2つを持たないからこそ、Critic の model diversity は Safety Constraint ではなく
 * 品質向上の Preference として扱える（`selectCriticModel()` を参照）。
 *
 * ## Critic の目的は「Review を PASS させること」ではない
 *
 * 目的は根本原因・隠れた問題・改善方向を PL へ提示することである。
 * したがって Critic は **Review Finding を正しい前提として扱わない**。Finding 自体の妥当性も
 * 評価対象に含める（`FindingAssessment`）。
 */

/**
 * Review Finding に対する Critic の評価。
 *
 * **`disputed` と `insufficient_evidence` を区別することが重要である。**
 * 前者は「Finding は成立しない」という積極的な主張で、後者は単なる不確実性である。
 * 後者で Review validity challenge を起こしてはならない（CEO 指示 2026-09-18）。
 */
export const FINDING_ASSESSMENT_STATUSES = [
  /** Finding は事実・コード・既存仕様に照らして妥当である。 */
  'supported',
  /** 一部は妥当だが、範囲・原因の特定に誤りがある。 */
  'partially_supported',
  /** **Finding は成立しない。** 具体的根拠が必要（`DISPUTE_GROUNDS`）。 */
  'disputed',
  /** 判断材料が足りない。**これは疑義ではない。** */
  'insufficient_evidence',
] as const

Object.freeze(FINDING_ASSESSMENT_STATUSES)

export type FindingAssessmentStatus = (typeof FINDING_ASSESSMENT_STATUSES)[number]

/**
 * `disputed` を主張するとき、**どの種類の根拠に基づくのかを明示させる**。
 *
 * 自由記述だけを許すと「別の考え方もある」「そうとも言い切れない」といった
 * **単なる異論で Review validity challenge が発火する**。challenge は frozen spec に対する
 * 追加の formal review を1回消費するので、発火条件は列挙値で縛る（CEO 指示 2026-09-18）。
 */
export const DISPUTE_GROUNDS = [
  /** Finding がコード・仕様・contract・既存 Decision と矛盾している。 */
  'contradicts_code_or_spec',
  /** Finding が誤った前提に依存している。 */
  'wrong_premise',
  /** Finding が症状を根本原因と誤認している。 */
  'symptom_mistaken_for_root_cause',
  /** Finding どおり修正すると Goal / Design constraint 等を破壊する。 */
  'following_it_breaks_goal_or_constraint',
] as const

Object.freeze(DISPUTE_GROUNDS)

export type DisputeGround = (typeof DISPUTE_GROUNDS)[number]

export interface FindingAssessment {
  /** どの Finding についての評価か（`DesignReviewFinding.source` と対応させる）。 */
  source: string
  status: FindingAssessmentStatus
  /** 評価の理由。 */
  rationale: string
  /**
   * `disputed` のときに要求する根拠の種類。
   * **`disputed` 以外では無視する**（付いていても challenge の根拠にしない）。
   */
  grounds?: DisputeGround
  /**
   * 疑義の具体的な裏付け（該当ファイル・仕様箇所・既存 Decision 等）。
   * **`disputed` のときは必須**。散文の主張だけで challenge させない。
   */
  evidence?: string
}

/**
 * Critic の出力。
 *
 * **Task Spec の欄（implementationScope / allowedPaths / acceptanceCriteria）を持たない。**
 * 具体的な改善案は `improvementDirections` に散文として書けるが、
 * **適用するのは PL であって Critic ではない**。ここに Task Spec の形を持たせると、
 * 「Critic が書いたものがそのまま Spec になる」経路が生まれ、mutation authority を
 * 持たないという役割定義が崩れる。
 */
export interface Critique {
  /** 根本原因。症状の列挙ではなく、なぜそうなっているかを書く。 */
  coreProblems: string[]
  /** Review Finding そのものの妥当性評価。**Finding を正しい前提にしない。** */
  findingAssessments: FindingAssessment[]
  /** Review が見落としている別の問題。 */
  hiddenRisks: string[]
  /** 変更してはならない制約（既存 contract / Goal / Design Philosophy 等）。 */
  constraintsToPreserve: string[]
  /** 改善の方向。具体案を含めてよい。 */
  improvementDirections: string[]
  /** 変えるべきでないもの。 */
  thingsNotToChange: string[]
  /** 判断材料が足りていない点。**空配列でよいが省略は許さない。** */
  uncertainties: string[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function nonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return items.length === value.length ? items.map((item) => item.trim()) : undefined
}

function isFindingAssessmentStatus(value: unknown): value is FindingAssessmentStatus {
  return typeof value === 'string'
    && (FINDING_ASSESSMENT_STATUSES as readonly string[]).includes(value)
}

function isDisputeGround(value: unknown): value is DisputeGround {
  return typeof value === 'string' && (DISPUTE_GROUNDS as readonly string[]).includes(value)
}

function parseFindingAssessment(value: unknown): FindingAssessment | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  const source = nonEmptyString(record, 'source')
  const rationale = nonEmptyString(record, 'rationale')
  if (source === undefined || rationale === undefined) return undefined
  if (!isFindingAssessmentStatus(record.status)) return undefined

  const grounds = isDisputeGround(record.grounds) ? record.grounds : undefined
  const evidence = nonEmptyString(record, 'evidence')

  // **`disputed` は根拠の種類と具体的な裏付けの両方を要求する。**
  // 欠けていれば `disputed` として受理せず、`insufficient_evidence` へ落とす
  // —— 却下せずに落とすのは、Critique 全体（根本原因・隠れたリスク等）は
  // それでも PL にとって有用だからである。**落とす先が challenge を起こさない
  // status であることが要点**で、これにより根拠の無い疑義は追加 review を消費しない。
  if (record.status === 'disputed' && (grounds === undefined || evidence === undefined)) {
    return { source, status: 'insufficient_evidence', rationale }
  }

  return {
    source,
    status: record.status,
    rationale,
    ...(grounds !== undefined ? { grounds } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  }
}

/**
 * Critic の応答を検証する。
 *
 * **欠けている項目を既定値で埋めない。** `constraintsToPreserve` を空のまま通すと
 * 「守るべきものを検討していない批判」を検討済みとして PL へ渡すことになる。
 * `uncertainties` だけは空配列を許す（「無い」という主張は成立する）。
 */
export function parseCritique(raw: string): Critique | undefined {
  const match = raw.match(/```json\s*([\s\S]+?)\s*```/) ?? raw.match(/(\{[\s\S]+\})/)
  if (!match) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1] ?? match[0])
  } catch {
    return undefined
  }

  const obj = asRecord(parsed)
  if (!obj) return undefined

  const coreProblems = stringArray(obj.coreProblems)
  const hiddenRisks = stringArray(obj.hiddenRisks)
  const constraintsToPreserve = stringArray(obj.constraintsToPreserve)
  const improvementDirections = stringArray(obj.improvementDirections)
  const thingsNotToChange = stringArray(obj.thingsNotToChange)
  const uncertainties = stringArray(obj.uncertainties)

  if (
    coreProblems === undefined || coreProblems.length === 0
    || hiddenRisks === undefined
    || constraintsToPreserve === undefined
    || improvementDirections === undefined || improvementDirections.length === 0
    || thingsNotToChange === undefined
    || uncertainties === undefined
  ) {
    return undefined
  }

  if (!Array.isArray(obj.findingAssessments)) return undefined
  const findingAssessments = obj.findingAssessments.map(parseFindingAssessment)
  // **1件でも壊れていれば受理しない。** 一部だけ落とすと、Critic が評価しなかった
  // Finding を「評価済み」と誤認する。
  if (findingAssessments.some((assessment) => assessment === undefined)) return undefined
  if (findingAssessments.length === 0) return undefined

  return {
    coreProblems,
    findingAssessments: findingAssessments as FindingAssessment[],
    hiddenRisks,
    constraintsToPreserve,
    improvementDirections,
    thingsNotToChange,
    uncertainties,
  }
}

/**
 * この Critique は **Review validity challenge を起こすか**。
 *
 * challenge は固定 Stage ではなく**条件分岐**である（CEO 指示 2026-09-18）。
 * 通常は `CONFLICT → Critic → PL revision → formal Review` を繰り返し、
 * **Critic が Finding 自体を具体的根拠付きで dispute した場合だけ** frozen spec に対する
 * fresh formal review へ分岐する。
 *
 * 発火条件は3つすべて:
 *   1. `status === 'disputed'`（`insufficient_evidence` では起こさない = 単なる不確実性）
 *   2. `grounds` が列挙値のいずれか（「別の考え方もある」では起こさない）
 *   3. `evidence` がある（散文の主張だけでは起こさない）
 *
 * 1〜3 は `parseFindingAssessment()` が既に保証しているので、ここでは status と
 * grounds の存在だけを見る。**判定を2箇所に分散させないための構造**である。
 */
export function disputedFindings(critique: Critique): FindingAssessment[] {
  return critique.findingAssessments.filter(
    (assessment) => assessment.status === 'disputed' && assessment.grounds !== undefined,
  )
}

/** Review validity challenge を起こすべきか。 */
export function shouldChallengeFinding(critique: Critique): boolean {
  return disputedFindings(critique).length > 0
}
