/**
 * Independent Remediation の**純粋な判定部分**。
 *
 * Design Review が CONFLICT を返して止まった変更案について、元の提案者へ差し戻さず、
 * **独立した高性能 AI** が Finding と Source of Truth を読んで安全な修正版を作る経路の、
 * model 選択・提案検証・Finding 抽出だけをここに置く。実行（CLI spawn）と権限（Gate）は
 * ここには無い。
 *
 * ## ここが持たないもの
 *
 * Review engine / 新しい Gate / 新しい state / provider stack は持たない。
 * 判定の正本は既存の `recomputeDecision()`（API 側再計算）であり、
 * **Remediation AI は Review 結果を解除・承認する権限を持たない。提案を作るだけである。**
 *
 * ## 暫定である部分
 *
 * `FLAGSHIP_REMEDIATION_CANDIDATES` は `role-model-registry`（roadmap: planned）が
 * 完成したら**そこへ引き上げて消す**。そのときこのモジュールが Router へ渡す要求は
 *
 *   role = independent_remediation / minimum capability = flagship / vendor independence = required
 *
 * である。**候補表を他の場所へ二重に持たないため、暫定表もここ1箇所だけに置く。**
 */

import { resolveReviewVendor, type ReviewVendor } from './reviewSeparation'

/** Remediation に使ってよい model。**flagship のみを載せる。** */
export interface RemediationCandidate {
  /** 既存 `AiCliProvider` の識別子。新しい provider 種別は追加しない。 */
  provider: 'codex' | 'claude_code'
  model: string
  reasoningEffort?: string
}

/**
 * Remediation の model 候補（優先順）。
 *
 * **軽量モデルを1つも載せない。** 載っていない model へ fallback する経路も作らない
 * （`selectRemediationModel()` はこの配列の外から候補を作らない）。したがって
 * 「品質未満のモデルで解決案を作ってしまう」状態は構造的に起こらない。
 *
 * model id は 2026-09-07 に production VPS で実動確認済みのものを使う
 * （`gpt-5.6-sol` + `xhigh` / `claude-opus-5`）。値が変わりうることは承知のうえで、
 * **判断ロジックへ埋め込まず、この表の要素として持つ**。
 */
export const FLAGSHIP_REMEDIATION_CANDIDATES: readonly RemediationCandidate[] = Object.freeze([
  // OpenAI flagship。Roadmap 生成と Codex independent review が同じ model を使っている。
  Object.freeze({ provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' }),
  // Anthropic flagship。Roadmap の integration review が同じ model を使っている。
  Object.freeze({ provider: 'claude_code', model: 'claude-opus-5' }),
]) as readonly RemediationCandidate[]

export interface RemediationModelInput {
  /**
   * 却下された提案を**書いた側**の provider 識別子。
   *
   * 自分の案を自分で修正させないための除外集合である。解決できない識別子
   * （`opencode-go` 等）は除外に使えないので `unresolvedAuthors` として返し、
   * **「分離済み」と主張しない**。
   */
  authorProviders: readonly string[]
  /**
   * この提案を**判定することになる** Review の provider 識別子。
   *
   * ここを除外しないと、Remediation AI が自分の提案を自分で審査する構成になりうる
   * （例: critical load では Codex independent review が必須なので、Codex が提案すると
   * 自己承認になる）。**vendor 分離の本体はこちら側である。**
   */
  judgeProviders: readonly string[]
  /** 既に実行して失敗した候補の provider。同じものを再試行しないために渡す。 */
  exhaustedProviders?: readonly string[]
}

export type RemediationModelSelection =
  | {
      ok: true
      candidate: RemediationCandidate
      vendor: ReviewVendor
      /** 除外した vendor（記録用）。 */
      excludedVendors: readonly ReviewVendor[]
      /** vendor を解決できなかった author 識別子。**分離を主張できない相手**である。 */
      unresolvedAuthors: readonly string[]
    }
  | {
      ok: false
      reason: string
      excludedVendors: readonly ReviewVendor[]
      unresolvedAuthors: readonly string[]
    }

function resolveVendors(providers: readonly string[]): {
  vendors: ReviewVendor[]
  unresolved: string[]
} {
  const vendors: ReviewVendor[] = []
  const unresolved: string[] = []
  for (const provider of providers) {
    const vendor = resolveReviewVendor(provider)
    if (vendor === undefined) unresolved.push(provider)
    else if (!vendors.includes(vendor)) vendors.push(vendor)
  }
  return { vendors, unresolved }
}

/**
 * Remediation を任せる model を決める。
 *
 * 選び方は「除外して残った先頭」であって、能力の比較はしない
 * （候補表が既に flagship だけなので、順序が優先度そのものになる）。
 * 残らなければ `ok: false` を返す。**弱い候補へ降格しない** —— 呼び出し側は
 * 別 flagship vendor が尽きた時点で既存の CEO Escalation 経路へ進む。
 */
export function selectRemediationModel(input: RemediationModelInput): RemediationModelSelection {
  const authors = resolveVendors(input.authorProviders)
  const judges = resolveVendors(input.judgeProviders)

  const excludedVendors: ReviewVendor[] = [...authors.vendors]
  for (const vendor of judges.vendors) {
    if (!excludedVendors.includes(vendor)) excludedVendors.push(vendor)
  }

  const exhausted = new Set(input.exhaustedProviders ?? [])

  for (const candidate of FLAGSHIP_REMEDIATION_CANDIDATES) {
    if (exhausted.has(candidate.provider)) continue
    const vendor = resolveReviewVendor(candidate.provider)
    // 候補表の provider は `PROVIDER_VENDOR` に載っているものだけにしてあるが、
    // 解決できない値が紛れ込んだ場合は採用しない（fail-closed）。
    if (vendor === undefined) continue
    if (excludedVendors.includes(vendor)) continue
    return {
      ok: true,
      candidate,
      vendor,
      excludedVendors,
      unresolvedAuthors: authors.unresolved,
    }
  }

  return {
    ok: false,
    reason:
      'no flagship model is independent of the parties involved'
      + ` (excluded vendors: ${excludedVendors.join(', ') || 'none'};`
      + ` already tried: ${[...exhausted].join(', ') || 'none'})`,
    excludedVendors,
    unresolvedAuthors: authors.unresolved,
  }
}

// ────────────────────────────────────────────────────────────
// Review Finding の抽出
// ────────────────────────────────────────────────────────────

/** Remediation AI へ渡す Finding 1件。`design_review_runs.result_json` から読む。 */
export interface DesignReviewFinding {
  /** どの工程の指摘か（focus 名 / `integration` / `independent`）。 */
  source: string
  /** その工程の判定（focused/integration は decision、independent は verdict）。 */
  decision: string
  summary?: string
  messages: readonly string[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function nonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function findingMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const record = asRecord(item)
    if (!record) return []
    const message = nonEmptyString(record, 'message')
    return message ? [message] : []
  })
}

/**
 * CONFLICT の根拠を、`design_review_runs.result_json` から構造化して取り出す。
 *
 * **ALIGNED の工程は落とす。** Remediation に要るのは「何が通らなかったか」であり、
 * 通った工程まで渡すと prompt が膨らむだけである（Design Philosophy: Context 重視）。
 *
 * `recomputeDecision()` の `buildRoadmapRejectedReason()` は同じ材料から**1行の散文**を作るが、
 * それは roadmap kind 専用で、かつ人が読む用である。ここでは task kind の Finding を
 * 工程単位で残す（Remediation AI がどの指摘へ答えたかを書けるようにするため）。
 * **判定そのものはここでは一切行わない。**
 */
export function extractDesignReviewFindings(resultJson: string | undefined): DesignReviewFinding[] {
  if (resultJson === undefined) return []

  let raw: Record<string, unknown> | undefined
  try {
    raw = asRecord(JSON.parse(resultJson))
  } catch {
    return []
  }
  if (!raw) return []

  const findings: DesignReviewFinding[] = []

  if (Array.isArray(raw.focusedReviewResults)) {
    for (const item of raw.focusedReviewResults) {
      const record = asRecord(item)
      if (!record) continue
      const decision = nonEmptyString(record, 'decision')
      if (!decision || decision === 'ALIGNED') continue
      findings.push({
        source: nonEmptyString(record, 'focus') ?? 'focused_review',
        decision,
        ...(nonEmptyString(record, 'summary') !== undefined
          ? { summary: nonEmptyString(record, 'summary') as string }
          : {}),
        messages: findingMessages(record.findings),
      })
    }
  }

  const integration = asRecord(raw.integrationReviewResult)
  if (integration) {
    const decision = nonEmptyString(integration, 'decision')
    if (decision && decision !== 'ALIGNED') {
      findings.push({
        source: 'integration',
        decision,
        ...(nonEmptyString(integration, 'summary') !== undefined
          ? { summary: nonEmptyString(integration, 'summary') as string }
          : {}),
        messages: findingMessages(integration.findings),
      })
    }
  }

  const independent = asRecord(raw.independentReviewResult)
  if (independent) {
    const verdict = nonEmptyString(independent, 'verdict')
    const unavailable = independent.unavailable === true
    if (unavailable || (verdict !== undefined && verdict !== 'approved')) {
      findings.push({
        source: 'independent',
        decision: unavailable ? 'unavailable' : (verdict as string),
        ...(nonEmptyString(independent, 'summary') !== undefined
          ? { summary: nonEmptyString(independent, 'summary') as string }
          : {}),
        messages: findingMessages(independent.issues ?? independent.findings),
      })
    }
  }

  return findings
}

// ────────────────────────────────────────────────────────────
// Remediation Proposal
// ────────────────────────────────────────────────────────────

/**
 * Remediation AI の出力。
 *
 * `implementationScope` / `allowedPaths` / `acceptanceCriteria` は**既存 `adoptRoadmapItem()` の
 * 入力そのもの**である（新しい Task schema field を作らないため）。残りは判断の記録であり、
 * `implementationScope` へ折り込まれて Task description に残る。
 */
export interface RemediationProposal {
  /** 何が原因で CONFLICT になったのかの診断。 */
  diagnosis: string
  /** どう解決するか。「元案を捨てる」を選んだ場合もここに書く。 */
  resolution: string
  implementationScope: string
  allowedPaths: string[]
  acceptanceCriteria: string[]
  /** なぜこれで Review Finding が解消するのか。 */
  whyResolved: string
  /** Safety / Authority への影響。「無い」と言う場合もその判断を書く。 */
  safetyImpact: string
  /** 未解決の懸念。空配列でよいが、**項目そのものを省略させない**。 */
  unresolvedConcerns: string[]
  /**
   * この Roadmap 項目は現状のままでは実装すべきでない、という結論。
   *
   * `true` のとき呼び出し側は**採用し直さず**、既存の CEO Escalation へ渡す。
   * ledger（CEO が確定する Source of Truth）を AI が書き換えることはしない。
   * 「実装しないで閉じる」state はこのシステムに存在しない
   * （roadmap: `no-status-for-closing-a-task-without-implementing`）。
   */
  abandon: boolean
}

/** 実装 spec の同一性。Task に保存される3つの欄だけで決まる。 */
export interface RemediationSpec {
  implementationScope: string
  allowedPaths: readonly string[]
  acceptanceCriteria: readonly string[]
}

/** 空白の揺れ・大小・順序だけの違いを「別の作業」と誤認しないための正規化。 */
function canonicalizeSpec(spec: RemediationSpec): string {
  const text = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()
  return JSON.stringify({
    scope: text(spec.implementationScope),
    // 宣言の順序は意味を持たない（File Change Guard は集合として使う）。
    paths: [...spec.allowedPaths].map(text).sort(),
    criteria: [...spec.acceptanceCriteria].map(text).sort(),
  })
}

/**
 * 提案が却下された spec と**実質的に違う**か。
 *
 * **prompt の hash では判定できない。** 採用時の `implementationScope` には Remediation の
 * 判断記録が追記されるため、中身が同一でも prompt テキストは必ず変わる。つまり
 * 「submit されるテキストの hash が違う」ことは材料的な違いを1つも保証しない
 * （独立レビュー指摘）。判定材料は Task に保存される3欄そのものにする。
 *
 * これは `repairPolicy` の `requireDifferentApproach` と同じ趣旨だが、あちらは
 * 「同じ失敗が繰り返されたか」を見る。こちらは「提案が変わっていないか」を見る。
 */
export function isMateriallyDifferentSpec(
  rejected: RemediationSpec,
  proposed: RemediationSpec,
): boolean {
  return canonicalizeSpec(rejected) !== canonicalizeSpec(proposed)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return items.length === value.length ? items.map((item) => item.trim()) : undefined
}

/**
 * Remediation AI の応答を検証する。
 *
 * **欠けている項目を既定値で埋めない。** `safetyImpact` を空のまま通すと
 * 「影響を検討していない提案」を検討済みとして扱うことになる。
 * `unresolvedConcerns` だけは空配列を許す（「無い」という主張は成立する）が、
 * 型が違えば拒否する。
 */
export function parseRemediationProposal(raw: string): RemediationProposal | undefined {
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

  const diagnosis = nonEmptyString(obj, 'diagnosis')
  const resolution = nonEmptyString(obj, 'resolution')
  const whyResolved = nonEmptyString(obj, 'whyResolved')
  const safetyImpact = nonEmptyString(obj, 'safetyImpact')
  const abandon = obj.abandon === true

  if (!diagnosis || !resolution || !whyResolved || !safetyImpact) return undefined

  const unresolvedConcerns = stringArray(obj.unresolvedConcerns)
  if (unresolvedConcerns === undefined) return undefined

  // 元案を捨てる結論のときは、次の実装 spec を要求しない（作らせても使わないため）。
  if (abandon) {
    return {
      diagnosis,
      resolution,
      implementationScope: '',
      allowedPaths: [],
      acceptanceCriteria: [],
      whyResolved,
      safetyImpact,
      unresolvedConcerns,
      abandon: true,
    }
  }

  const implementationScope = nonEmptyString(obj, 'implementationScope')
  const allowedPaths = stringArray(obj.allowedPaths)
  const acceptanceCriteria = stringArray(obj.acceptanceCriteria)

  if (!implementationScope || !allowedPaths || !acceptanceCriteria) return undefined
  if (allowedPaths.length === 0 || acceptanceCriteria.length === 0) return undefined

  return {
    diagnosis,
    resolution,
    implementationScope,
    allowedPaths,
    acceptanceCriteria,
    whyResolved,
    safetyImpact,
    unresolvedConcerns,
    abandon: false,
  }
}
