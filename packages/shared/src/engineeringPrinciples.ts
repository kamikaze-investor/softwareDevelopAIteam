import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { isStrategicDecision } from './strategicDecision.js'
import type { MetaReviewFocus, MetaRiskLevel, StrategicDecision } from './types/meta_review.js'
import type { AppliedPrinciple, PrincipleSelectionSource } from './types/principle.js'

const PRINCIPLE_SPEC_FILENAME = '21_outcome_oriented_generalization_principle.md'

const ENGINEERING_PRINCIPLE_PATHS = [
  `/workspace/control/specs/${PRINCIPLE_SPEC_FILENAME}`,
  path.resolve(process.cwd(), `../../specs/${PRINCIPLE_SPEC_FILENAME}`),
  path.resolve(process.cwd(), `specs/${PRINCIPLE_SPEC_FILENAME}`),
] as const

export type PrincipleSlug =
  | 'evidence-not-spec'
  | 'standard-design-frame'
  | 'stable-contract-first'
  | 'deterministic-vs-heuristic'
  | 'honest-unverifiable'
  | 'boundary-strictness'
  | 'observable-behavior'
  | 'review-integration'
  | 'scale-to-risk'
  | 'existing-code-grandfather'
  | 'observation-closes-loop'

/** core = signal によらず毎回適用される。contextual = signal から選ばれたときだけ適用される。 */
export type PrincipleTier = 'core' | 'contextual'

/**
 * Registry 上の 1 原則。
 *
 * **本文（`fullText` / `oneLiner`）と metadata は同じ marker block から読む。**
 * metadata 専用の第二のファイル・テーブルを作らないので、二重正本が発生しない。
 */
export type EngineeringPrinciple = {
  slug: PrincipleSlug
  oneLiner: string
  fullText: string
  /**
   * 本文（one-liner + 全文）から算出した**原則の版**。手書きの版番号は持たせない
   * （手書きは必ず本文と乖離するため）。改行コード差（CRLF / LF）では変わらない。
   *
   * **これは「reviewer に見せた bytes の hash」ではない。** prompt に載るのは one-liner だけで、
   * 全文は載らない。したがって全文だけを書き換えても版は変わる。
   * これは意図した挙動である: 原則の意味が変われば、**one-liner が同じでも**過去の判定を
   * 新しい版の実績として数え直させたい。センサーは現在の版の行だけを数えるので、
   * 版が動いた原則は実績ゼロからやり直しになる（安全側）。
   */
  versionHash: string
  /** 分類。集計の切り口。未指定なら 'uncategorized'。 */
  category: string
  /** 適用範囲。'universal'（AIteamOS 固有でない）/ 'aiteamos' 等。未指定なら 'unspecified'。 */
  scope: string
  tier: PrincipleTier
  tags: string[]
}

export type EngineeringPrinciplesResult =
  | { ok: true; bySlug: Map<PrincipleSlug, EngineeringPrinciple> }
  | { ok: false; reason: string; triedPaths: readonly string[] }

/** 選択器の出力。`selectionSource` / `selectionReason` を後から創作しないための構造。 */
export interface PrincipleSelection {
  slug: PrincipleSlug
  versionHash: string
  oneLiner: string
  source: PrincipleSelectionSource
  reason: string
}

const ALL_PRINCIPLE_SLUGS: readonly PrincipleSlug[] = [
  'evidence-not-spec',
  'standard-design-frame',
  'stable-contract-first',
  'deterministic-vs-heuristic',
  'honest-unverifiable',
  'boundary-strictness',
  'observable-behavior',
  'review-integration',
  'scale-to-risk',
  'existing-code-grandfather',
  'observation-closes-loop',
] as const

const SLUG_SET = new Set<string>(ALL_PRINCIPLE_SLUGS)

const FOCUS_PRINCIPLE_SLUGS: Partial<Record<MetaReviewFocus, readonly PrincipleSlug[]>> = {
  safety_recovery: [
    'stable-contract-first',
    'deterministic-vs-heuristic',
    'honest-unverifiable',
    'boundary-strictness',
  ],
  operations: [
    'stable-contract-first',
    'deterministic-vs-heuristic',
    'honest-unverifiable',
    'boundary-strictness',
  ],
  data_state_integrity: [
    'honest-unverifiable',
    'boundary-strictness',
  ],
  architecture_responsibility: [
    'stable-contract-first',
    'scale-to-risk',
  ],
  scope_simplicity: [
    'scale-to-risk',
    'existing-code-grandfather',
  ],
} as const

const RISK_PRINCIPLE_SLUGS: Partial<Record<MetaRiskLevel, readonly PrincipleSlug[]>> = {
  medium: ['scale-to-risk'],
  high: ['scale-to-risk', 'boundary-strictness'],
  critical: ['scale-to-risk', 'boundary-strictness', 'honest-unverifiable'],
} as const

/**
 * 読み込み結果のキャッシュ。**ファイルの状態が変わったら捨てる。**
 *
 * 以前は成功結果を無期限に保持していた。原則本文を書き換えても、プロセスを再起動するまで
 * 古い tier と古い版 hash が使われ続ける（独立レビュー指摘 2026-09-17）。
 * tier は prompt に載る原則を決め、版 hash はセンサーの数え直しを決めるので、
 * これは「古い文章で判定して新しい版として記録する」ことになり得た。
 *
 * mtime とサイズだけを見る安価な検証にする。内容 hash まで取ると読み込みと同じコストになり、
 * キャッシュの意味が無くなる。
 */
const resultCache = new Map<string, { stamp: string; result: EngineeringPrinciplesResult }>()

/** 候補パス群の現在の状態。読めないパスは 'missing' として stamp に含める。 */
function cacheStamp(candidatePaths: readonly string[]): string {
  return candidatePaths
    .map((candidatePath) => {
      try {
        const stats = statSync(candidatePath)
        return `${candidatePath}:${stats.mtimeMs}:${stats.size}`
      } catch {
        return `${candidatePath}:missing`
      }
    })
    .join('\0')
}

export function loadEngineeringPrinciples(
  candidatePaths: readonly string[] = ENGINEERING_PRINCIPLE_PATHS,
): EngineeringPrinciplesResult {
  const cacheKey = candidatePaths.join('\0')
  const stamp = cacheStamp(candidatePaths)
  const cached = resultCache.get(cacheKey)
  if (cached !== undefined && cached.stamp === stamp) {
    return cached.result
  }

  const failures: string[] = []

  for (const candidatePath of candidatePaths) {
    let content: string
    try {
      content = readFileSync(candidatePath, 'utf-8')
    } catch (err: unknown) {
      failures.push(`${candidatePath}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    const parsed = extractEngineeringPrinciples(content)
    if (!parsed.ok) {
      failures.push(`${candidatePath}: ${parsed.reason}`)
      continue
    }

    const result: EngineeringPrinciplesResult = { ok: true, bySlug: parsed.bySlug }
    resultCache.set(cacheKey, { stamp, result })
    return result
  }

  const result: EngineeringPrinciplesResult = {
    ok: false,
    reason: failures.join(' / ') || 'no candidate path was tried',
    triedPaths: candidatePaths,
  }
  resultCache.set(cacheKey, { stamp, result })
  return result
}

/**
 * core 原則の一覧。**code 側のハードコード配列ではなく registry の `principle-tier` marker から導出する。**
 *
 * 以前は `BASE_PRINCIPLE_SLUGS` という TypeScript の定数で、spec 本文と code が
 * 別々に core を主張していた（= 二重正本）。tier を marker 化したことで正本は 1 つになった。
 */
export function corePrincipleSlugs(principles: EngineeringPrinciplesResult): PrincipleSlug[] {
  if (!principles.ok) {
    return []
  }

  return ALL_PRINCIPLE_SLUGS.filter((slug) => principles.bySlug.get(slug)?.tier === 'core')
}

/**
 * 適用する原則を選ぶ。**選択理由も一緒に返す**ので、記録側が理由を後から作文しなくて済む。
 *
 * registry が読めない場合は空配列を返す。`buildDesignContract()` 側が
 * 「principles unavailable」を明示するので、ここで黙って core だけ返すと嘘になる。
 */
export function selectPrinciples(
  signals: {
    predictedFocuses?: MetaReviewFocus[]
    riskLevel?: MetaRiskLevel
    explicitSlugs?: readonly PrincipleSlug[]
  } | undefined,
  principles: EngineeringPrinciplesResult,
): PrincipleSelection[] {
  if (!principles.ok) {
    return []
  }

  const selected: PrincipleSelection[] = []
  const seen = new Set<PrincipleSlug>()

  const push = (slug: PrincipleSlug, source: PrincipleSelectionSource, reason: string): void => {
    if (seen.has(slug)) {
      return
    }
    const principle = principles.bySlug.get(slug)
    if (!principle) {
      return
    }
    seen.add(slug)
    selected.push({
      slug,
      versionHash: principle.versionHash,
      oneLiner: principle.oneLiner,
      source,
      reason,
    })
  }

  for (const slug of corePrincipleSlugs(principles)) {
    push(slug, 'core', 'core principle: applied to every task regardless of signal')
  }

  for (const slug of signals?.explicitSlugs ?? []) {
    push(slug, 'explicit', 'explicitly requested by the caller')
  }

  for (const focus of signals?.predictedFocuses ?? []) {
    for (const slug of FOCUS_PRINCIPLE_SLUGS[focus] ?? []) {
      push(slug, 'contextual', `focus=${focus}`)
    }
  }

  if (signals?.riskLevel !== undefined) {
    for (const slug of RISK_PRINCIPLE_SLUGS[signals.riskLevel] ?? []) {
      push(slug, 'risk', `riskLevel=${signals.riskLevel}`)
    }
  }

  return selected
}

export function selectPrincipleSlugs(
  signals: {
    predictedFocuses?: MetaReviewFocus[]
    riskLevel?: MetaRiskLevel
    explicitSlugs?: readonly PrincipleSlug[]
  } | undefined,
  principles: EngineeringPrinciplesResult,
): PrincipleSlug[] {
  return selectPrinciples(signals, principles).map((selection) => selection.slug)
}

export function buildDesignContract(input: {
  slugs: readonly PrincipleSlug[]
  principles: EngineeringPrinciplesResult
  extra?: {
    invariants?: string[]
    freedom?: string
    risks?: string[]
    riskTreatment?: string
    avoidedOverConstraints?: string[]
  }
}): string {
  const lines: string[] = ['## Design Contract']

  if (!input.principles.ok) {
    lines.push(`- Engineering principles unavailable; do not treat them as applied. Reason: ${input.principles.reason}`)
  } else {
    for (const slug of uniqueSlugs(input.slugs)) {
      const principle = input.principles.bySlug.get(slug)
      lines.push(`- ${principle?.oneLiner ?? `Principle ${slug} was not available; do not treat it as applied.`}`)
    }
  }

  const extra = input.extra
  appendListSection(lines, 'Non-Negotiable Invariants', extra?.invariants)
  appendTextSection(lines, 'Implementation Freedom / Change Tolerance', extra?.freedom)
  appendListSection(lines, 'Relaxation Risks', extra?.risks)
  appendTextSection(lines, 'Risk Treatment', extra?.riskTreatment)
  appendListSection(lines, 'Avoided Over-Constraints', extra?.avoidedOverConstraints)

  return lines.join('\n')
}

export function buildEngineeringPrincipleReviewGuidance(principles: EngineeringPrinciplesResult): string {
  if (!principles.ok) {
    return [
      '## Engineering Principle Review Guidance',
      `- Engineering principles unavailable; do not treat them as applied. Reason: ${principles.reason}`,
    ].join('\n')
  }

  const stableContract = principles.bySlug.get('stable-contract-first')
  const standardDesignFrame = principles.bySlug.get('standard-design-frame')
  const honestUnverifiable = principles.bySlug.get('honest-unverifiable')

  return [
    '## Engineering Principle Review Guidance',
    `- implementation_coupling: ${stableContract?.oneLiner ?? 'Principle stable-contract-first was not available; do not treat it as applied.'}`,
    `- over_constraint: ${standardDesignFrame?.oneLiner ?? 'Principle standard-design-frame was not available; do not treat it as applied.'}`,
    `- unverifiable_assumption: ${honestUnverifiable?.oneLiner ?? 'Principle honest-unverifiable was not available; do not treat it as applied.'}`,
  ].join('\n')
}

/**
 * Reviewer へ「この Task に適用される原則はこれだけ」と提示するブロック。
 *
 * **全文ではなく one-liner だけを載せる。** 原則数が増えても prompt が線形に太らないことが、
 * `specs/21` の `home-and-criteria` が宣言している完了条件である。
 */
export function buildApplicablePrinciplesSection(selection: readonly PrincipleSelection[]): string {
  if (selection.length === 0) {
    return [
      '## Applicable Principles',
      '- (none available) Engineering principles could not be selected; do not report principle verdicts.',
    ].join('\n')
  }

  return [
    '## Applicable Principles',
    'Judge each principle below separately against this change and report one verdict per principle id.',
    'ALIGNED = the change respects it. CONFLICT = the change violates it. UNCERTAIN = you cannot tell from the material given.',
    'Do not invent principle ids that are not in this list.',
    ...selection.map((item) => `- ${item.slug}: ${item.oneLiner}`),
  ].join('\n')
}

/**
 * Reviewer が返した原則判定を、**実際に prompt へ載せた選択**へ突き合わせて正規化する。
 *
 * 不変条件:
 * - 載せていない原則 id は捨てる（reviewer が創作した id で統計を汚さない）
 * - 載せた原則が返ってこなかった場合は UNCERTAIN として残す。**黙って消さない。**
 *   「聞いたのに答えなかった」を「適用しなかった」と同一視すると適用数が実態より少なくなり、
 *   「一度も CONFLICT しない原則」という判断が甘く出る。安全側は UNCERTAIN を残すこと
 * - version hash と選択理由は**選択した側**の値を使う。reviewer の自己申告で上書きしない
 * - 何も選べていない（registry 不在）ときは `undefined` を返す。空配列だと
 *   「0件判定した」と「判定していない」が区別できなくなる
 */
export function normalizeAppliedPrinciples(
  value: unknown,
  selection: readonly PrincipleSelection[],
): AppliedPrinciple[] | undefined {
  if (selection.length === 0) {
    return undefined
  }

  const reported = new Map<string, { verdict: StrategicDecision; reason: string }>()

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'object' || item === null) {
        continue
      }
      const record = item as Record<string, unknown>
      const principleId = typeof record.principleId === 'string' ? record.principleId : undefined
      if (principleId === undefined || !isStrategicDecision(record.verdict)) {
        continue
      }
      // 同じ id が2回返ってきたら最初の1つを採る（黙って上書きしない）。
      if (reported.has(principleId)) {
        continue
      }
      reported.set(principleId, {
        verdict: record.verdict,
        reason: typeof record.reason === 'string' ? record.reason : '(reason not provided)',
      })
    }
  }

  return selection.map((selected) => {
    const answer = reported.get(selected.slug)
    return {
      principleId: selected.slug,
      principleVersionHash: selected.versionHash,
      selectionSource: selected.source,
      selectionReason: selected.reason,
      verdict: answer?.verdict ?? 'UNCERTAIN',
      reason: answer?.reason ?? 'reviewer did not return a verdict for this principle',
    }
  })
}

function extractEngineeringPrinciples(
  content: string,
): { ok: true; bySlug: Map<PrincipleSlug, EngineeringPrinciple> } | { ok: false; reason: string } {
  const markerMatches = [...content.matchAll(/^<!--[ \t]*principle-id:[ \t]*([a-z0-9-]+)[ \t]*-->[ \t]*$/gmu)]
  if (markerMatches.length === 0) {
    return { ok: false, reason: 'no principle-id markers found' }
  }

  const bySlug = new Map<PrincipleSlug, EngineeringPrinciple>()

  for (let index = 0; index < markerMatches.length; index += 1) {
    const match = markerMatches[index]
    const rawSlug = match[1]
    if (!isPrincipleSlug(rawSlug)) {
      continue
    }

    if (bySlug.has(rawSlug)) {
      return { ok: false, reason: `duplicate principle-id marker: ${rawSlug}` }
    }

    const textStart = (match.index ?? 0) + match[0].length
    const textEnd = markerMatches[index + 1]?.index ?? content.length
    const blockText = content.slice(textStart, textEnd).replace(/^\r?\n/, '')

    const metadata = extractPrincipleMetadata(blockText)

    const oneLiner = metadata.values.get('oneliner')?.trim() ?? ''
    if (!metadata.values.has('oneliner')) {
      return { ok: false, reason: `principle ${rawSlug} is missing principle-oneliner marker` }
    }
    if (oneLiner.length === 0) {
      return { ok: false, reason: `principle ${rawSlug} one-liner is empty` }
    }

    // tier は prompt に何が載るかを決めるため、欠けていたら黙って contextual へ倒さず失敗させる。
    // 黙って倒すと core 原則が全 prompt から消えたことに誰も気づけない。
    const rawTier = metadata.values.get('tier')?.trim()
    if (rawTier === undefined) {
      return { ok: false, reason: `principle ${rawSlug} is missing principle-tier marker (core|contextual)` }
    }
    if (rawTier !== 'core' && rawTier !== 'contextual') {
      return { ok: false, reason: `principle ${rawSlug} has an unknown principle-tier: ${rawTier}` }
    }

    const fullText = blockText.slice(metadata.consumedLength).trim()
    if (fullText.length === 0) {
      return { ok: false, reason: `principle ${rawSlug} is empty` }
    }

    bySlug.set(rawSlug, {
      slug: rawSlug,
      oneLiner,
      fullText,
      versionHash: principleVersionHash(oneLiner, fullText, rawTier),
      category: metadata.values.get('category')?.trim() || 'uncategorized',
      scope: metadata.values.get('scope')?.trim() || 'unspecified',
      tier: rawTier,
      tags: parseTags(metadata.values.get('tags')),
    })
  }

  const missing = ALL_PRINCIPLE_SLUGS.filter((slug) => !bySlug.has(slug))
  if (missing.length > 0) {
    return { ok: false, reason: `missing principle-id markers: ${missing.join(', ')}` }
  }

  return { ok: true, bySlug }
}

const PRINCIPLE_METADATA_KEYS = ['oneliner', 'category', 'scope', 'tier', 'tags'] as const

/**
 * `principle-id` 直後に連続する metadata marker を読む。**順序は問わない。**
 * 最初の非 marker 行から後ろが原則本文になる。
 */
function extractPrincipleMetadata(
  blockText: string,
): { values: Map<string, string>; consumedLength: number } {
  const values = new Map<string, string>()
  const markerPattern = new RegExp(
    `^<!--[ \\t]*principle-(${PRINCIPLE_METADATA_KEYS.join('|')}):[ \\t]*(.*?)[ \\t]*-->[ \\t]*(?:\\r?\\n|$)`,
    'u',
  )

  let consumedLength = 0
  let rest = blockText

  for (;;) {
    const markerMatch = rest.match(markerPattern)
    if (markerMatch === null) {
      break
    }

    // 同じ key が2回出たら後勝ちにせず、最初の1つを正とする（黙って上書きしない）。
    if (!values.has(markerMatch[1])) {
      values.set(markerMatch[1], markerMatch[2])
    }

    consumedLength += markerMatch[0].length
    rest = rest.slice(markerMatch[0].length)
  }

  return { values, consumedLength }
}

/**
 * 原則の版。改行コードと行末空白を正規化してから hash するので、
 * CRLF / LF のチェックアウト差だけで版が変わることはない。
 *
 * **tier も入力に含める。** 文言を変えずに contextual → core へ上げた場合、
 * contextual として集めた実績がそのまま core 降格センサーの根拠になってしまう
 * （独立レビュー指摘 2026-09-17）。tier が動いたら実績も数え直す。
 */
function principleVersionHash(oneLiner: string, fullText: string, tier: PrincipleTier): string {
  const canonical = `${tier}\n${oneLiner}\n${fullText}`
    .replace(/\r\n/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .trim()

  return createHash('sha256').update(canonical, 'utf-8').digest('hex').slice(0, 16)
}

function parseTags(raw: string | undefined): string[] {
  if (raw === undefined) {
    return []
  }

  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

function isPrincipleSlug(value: string): value is PrincipleSlug {
  return SLUG_SET.has(value)
}

function uniqueSlugs(slugs: readonly PrincipleSlug[]): PrincipleSlug[] {
  return [...new Set(slugs)]
}

function appendTextSection(lines: string[], heading: string, value: string | undefined): void {
  const trimmed = value?.trim()
  if (!trimmed) {
    return
  }

  lines.push('', `### ${heading}`, trimmed)
}

function appendListSection(lines: string[], heading: string, values: readonly string[] | undefined): void {
  const nonEmptyValues = values?.map((value) => value.trim()).filter((value) => value.length > 0) ?? []
  if (nonEmptyValues.length === 0) {
    return
  }

  lines.push('', `### ${heading}`, ...nonEmptyValues.map((value) => `- ${value}`))
}
