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
   * （`opencode-go` 等）は vendor 単位の除外には使えないので `unresolvedAuthors` として返す。
   * **その場合、vendor 分離は「確認済み」と主張しない。**
   */
  authorProviders: readonly string[]
  /**
   * 却下された提案を書いた側の **model 識別子**。
   *
   * **vendor が解決できなくても、これは常に照合できる。** 「元の設計者へ解決案生成を戻さない」
   * という要求の核はモデル同一性の否定であり（同一 weight が自分の推論を弁護するのが避けたい事象）、
   * それはここで機械的に強制できる。
   *
   * vendor 単位の除外（相関した盲点の回避）は、vendor が解決できる相手に対してだけ成立する。
   * **解決できない相手について「分離した」と言わない代わりに、model 単位では必ず分離する。**
   * 未知の識別子を vendor 表へ登録して分離を主張するのは `reviewSeparation.ts` が
   * 明示的に禁じている（識別子ではなく実際の underlying model/vendor を渡せる設計にしてから、
   * という条件付き）。
   */
  authorModels?: readonly string[]
  /**
   * この提案を**判定することになる** Review の provider 識別子。
   *
   * ここを除外しないと、Remediation AI が自分の提案を自分で審査する構成になりうる
   * （例: critical load では Codex independent review が必須なので、Codex が提案すると
   * 自己承認になる）。**vendor 分離の本体はこちら側である。**
   */
  judgeProviders: readonly string[]
  /**
   * 既にこの repair chain で使った provider。**Preference であって Safety Constraint ではない。**
   *
   * 優先度を下げるだけで、除外はしない。以前はここを hard skip にしていたが、それは
   * 「候補が尽きたから BLOCKED」を作る —— **model diversity の不足で PL loop を止めない**
   * （CEO 指示 2026-09-18）。Safety に効くのは author / judge 側の分離であって、
   * chain の新しさではない。
   */
  usedProviders?: readonly string[]
  /**
   * Critic として使った provider。**Preference。最下位に置くが除外はしない。**
   *
   * Critic は formal verdict authority も Task Spec mutation authority も持たないため、
   * **Critic が書いたものは Task Design ではない**。よって Critic 経験は
   * 「Task Design author との独立性」を侵さない。同一 model が Critic と Remediator を
   * 兼ねること自体は許可される（CEO 指示 2026-09-18）。
   */
  criticProviders?: readonly string[]
}

export type RemediationModelSelection =
  | {
      ok: true
      candidate: RemediationCandidate
      vendor: ReviewVendor
      /** 除外した vendor（記録用）。 */
      excludedVendors: readonly ReviewVendor[]
      /**
       * vendor を解決できなかった author 識別子。
       *
       * **これは provenance であって、保証の一部ではない。** この相手について主張できるのは
       * 「model が同一でないこと」だけで、vendor 分離は確認していない。呼び出し側は
       * この値を記録し、**分離済みと書かない**。
       */
      unresolvedAuthors: readonly string[]
      /**
       * Preference を満たせず、chain / Critic で使用済みの provider を再利用したか。
       *
       * **記録のためだけの値で、可否には一切影響しない。** diversity は Preference なので、
       * 満たせなかったことは停止理由にならない（CEO 指示 2026-09-18）。
       */
      reusedProvider: boolean
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
 * ## Safety Constraint と Preference を混ぜない（CEO 指示 2026-09-18）
 *
 * **Safety Constraint（満たせなければ選ばない）**:
 *   - Task Design author と同一 model でない（`authorModels`）
 *   - Task Design author と同一 vendor でない（解決できる範囲。`authorProviders`）
 *   - この提案を判定する reviewer と同一 vendor でない（`judgeProviders`）
 *
 * **Preference（順位付けだけ。除外しない）**:
 *   1. この repair chain でまだ使っていない flagship
 *   2. その他の利用可能な flagship
 *   3. Critic として使用済みの flagship
 *
 * **model diversity が足りないことを理由に BLOCKED を作らない。** 以前は chain 使用済みを
 * hard skip していたため、候補不足がそのまま PL loop の停止になっていた。止めてよいのは
 * Safety Constraint を満たす候補が1つも無いときだけである。
 *
 * どの tier でも**弱い候補へは降格しない**（候補表が flagship だけなので構造的に不可能）。
 */
export function selectRemediationModel(input: RemediationModelInput): RemediationModelSelection {
  const authors = resolveVendors(input.authorProviders)
  const judges = resolveVendors(input.judgeProviders)

  const excludedVendors: ReviewVendor[] = [...authors.vendors]
  for (const vendor of judges.vendors) {
    if (!excludedVendors.includes(vendor)) excludedVendors.push(vendor)
  }

  // **model 単位の除外は vendor が解決できるかに依存しない。** ここが round 1 の
  // （vendor 未解決な）著者に対して実際に強制できる唯一の独立性である。
  const authorModels = new Set(input.authorModels ?? [])
  const used = new Set(input.usedProviders ?? [])
  const criticUsed = new Set(input.criticProviders ?? [])

  // ── Safety Constraint を満たす候補だけを残す（ここだけが hard）──────
  const eligible = FLAGSHIP_REMEDIATION_CANDIDATES.filter((candidate) => {
    // 元の設計者と同一 model には絶対に戻さない（vendor 解決の成否に関わらず）。
    if (authorModels.has(candidate.model)) return false
    const vendor = resolveReviewVendor(candidate.provider)
    // 候補表の provider は `PROVIDER_VENDOR` に載っているものだけにしてあるが、
    // 解決できない値が紛れ込んだ場合は採用しない（fail-closed）。
    if (vendor === undefined) return false
    return !excludedVendors.includes(vendor)
  })

  if (eligible.length > 0) {
    // ── Preference で並べる。**同点なら候補表の順序**（安定選択）────────
    // Critic 経験を chain 使用より重く見るのは CEO 指示の優先順（1→2→3）に合わせるため。
    const rank = (candidate: RemediationCandidate): number =>
      (criticUsed.has(candidate.provider) ? 2 : 0) + (used.has(candidate.provider) ? 1 : 0)
    const best = eligible.reduce((left, right) => (rank(right) < rank(left) ? right : left))
    const vendor = resolveReviewVendor(best.provider) as ReviewVendor

    return {
      ok: true,
      candidate: best,
      vendor,
      excludedVendors,
      unresolvedAuthors: authors.unresolved,
      /** Preference を満たせなかった場合の記録。BLOCKED の理由にはしない。 */
      reusedProvider: used.has(best.provider) || criticUsed.has(best.provider),
    }
  }

  return {
    ok: false,
    reason:
      'no flagship model satisfies the authority-separation constraints'
      + ` (excluded vendors: ${excludedVendors.join(', ') || 'none'};`
      + ` excluded models: ${[...authorModels].join(', ') || 'none'})`,
    excludedVendors,
    unresolvedAuthors: authors.unresolved,
  }
}

// ────────────────────────────────────────────────────────────
// Independent Critic の model 選択
// ────────────────────────────────────────────────────────────

export interface CriticModelSelection {
  candidate: RemediationCandidate
  vendor: ReviewVendor
  /** 前回と同じ model を再利用したか（Preference を満たせなかった記録）。 */
  reusedModel: boolean
  /** 前回と同じ vendor になったか（Preference を満たせなかった記録）。 */
  reusedVendor: boolean
}

/**
 * Independent Critic に使う model を決める。
 *
 * ## **これは Preference だけで構成され、失敗しない**（CEO 指示 2026-09-18）
 *
 * Critic は
 *   - Task Spec mutation authority を持たない（提案は書くが適用しない）
 *   - formal verdict authority を持たない（PASS / CONFLICT を決めない）
 * ため、**model diversity の不足を fail-closed 条件にしない**。
 *
 * 優先順:
 *   1. 前回と別 model かつ別 vendor
 *   2. 前回と別 model（vendor は同じでもよい）
 *   3. **前回と同じ model**（fallback。これを許可することが本関数の要点）
 *
 * 「前回と同じ Critic model であること」だけを理由に BLOCKED にしてはならない。
 * 次 Round には新しい Task Spec・最新 Finding・過去 Critique・PL の変更が渡るので、
 * 同一 model でも入力が違えば別の批判になりうる。
 *
 * `selectRemediationModel()` とは**意図的に別関数**である。あちらは Safety Constraint を
 * 持つので `ok: false` を返しうるが、こちらは返さない。同じ関数へ flag で押し込むと
 * 「どちらが hard か」が呼び出し側から見えなくなる。
 */
export function selectCriticModel(input: {
  /** 直前の Round で Critic に使った provider（あれば）。 */
  previousProviders?: readonly string[]
  /** 直前の Round で Critic に使った model（あれば）。 */
  previousModels?: readonly string[]
}): CriticModelSelection {
  const previousProviders = new Set(input.previousProviders ?? [])
  const previousModels = new Set(input.previousModels ?? [])
  const previousVendors = new Set(
    [...previousProviders]
      .map((provider) => resolveReviewVendor(provider))
      .filter((vendor): vendor is ReviewVendor => vendor !== undefined),
  )

  // 候補表は flagship のみ。**Critic も軽量 model へは落とさない**
  // （根本原因の分析と Finding の妥当性評価は推論能力を要する作業である）。
  const rank = (candidate: RemediationCandidate): number => {
    const sameModel = previousModels.has(candidate.model)
    const vendor = resolveReviewVendor(candidate.provider)
    const sameVendor = vendor !== undefined && previousVendors.has(vendor)
    // 同一 model は最も避けたい。次に同一 vendor。
    return (sameModel ? 2 : 0) + (sameVendor ? 1 : 0)
  }

  const best = FLAGSHIP_REMEDIATION_CANDIDATES.reduce(
    (left, right) => (rank(right) < rank(left) ? right : left),
  )
  const vendor = resolveReviewVendor(best.provider)

  return {
    candidate: best,
    // 候補表の provider は必ず解決できる（`FLAGSHIP_REMEDIATION_CANDIDATES` の不変条件）。
    vendor: vendor as ReviewVendor,
    reusedModel: previousModels.has(best.model),
    reusedVendor: vendor !== undefined && previousVendors.has(vendor),
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

/**
 * **Review が実際に見る部分だけ**から作る正規化キー。
 *
 * 判定の基準は「Review の入力が変わったか」であって「Task の行が変わったか」ではない。
 * `buildInitialImplementAiCliPrompt()` が組むレビュー対象は
 * `task.description`（= ledger 本文 + `implementationScope`）と `allowedPaths` 由来の
 * Design Contract だけで、**`acceptanceCriteria` は1文字も入らない**。
 *
 * したがって AC だけを書き換えた提案は、**レビュー対象テキストが byte 単位で同一**になる。
 * それを「実質的に違う」と扱うと、AC を1行いじるだけで却下済みテキストへの再抽選を
 * 引けることになる（独立レビュー指摘。この repo では同一入力への判定が実行ごとに
 * 反転する実測がある → ledger: `independent-review-verdict-instability`）。
 * **だから AC はキーに含めない。** AC の改善自体は禁止しないが、それだけでは
 * 「作り直した」ことにならない。
 *
 * 空白・大小・宣言順の揺れは正規化する（`allowedPaths` は File Change Guard が集合として
 * 使うので順序に意味が無い）。
 */
export function reviewVisibleSpecKey(
  spec: Pick<RemediationSpec, 'implementationScope' | 'allowedPaths'>,
): string {
  const text = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()
  // path の**書き方の揺れ**を潰してから比較する。`apps/api/src` と `./apps/api/src/` と
  // `apps/api//src` は同じ許可範囲なので、これらを別物として扱うと
  // **末尾に `/` を足すだけで再審査を引ける**（独立レビュー指摘・2026-09-18）。
  //
  // **best-effort である。** File Change Guard は allowedPaths 用の正規化関数を export して
  // おらず、「実効的な許可範囲」を1箇所で定義する術が今は無い。ここで潰せるのは
  // 書き方の揺れだけで、この鍵を最後の防壁にしてはならない（本質的な対処は
  // `design-review-rejections-are-not-durably-recorded` を参照）。
  const pathText = (value: string): string =>
    text(value).replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return JSON.stringify({
    scope: text(spec.implementationScope),
    // **正規化した「後」に重複を畳む。** 順序を揃えるだけでは足りない ——
    // `['a']` と `['a', ' A ']` は正規化後どちらも同じ1件なのに、畳まないと配列長が違って
    // 別の鍵になる。**同じ内容を重複付きで出し直すだけで「実質的に違う提案」を
    // 名乗れてしまう**（独立レビュー指摘・2026-09-18）。
    //
    // 大小を潰す既存の扱いはそのまま維持する（本関数の契約であり、テストで固定されている）。
    // その結果、`['src/API','src/api']` → `['src/api']` という**絞り込みだけの訂正**は
    // 「同じ提案」と判定される。case だけが違う allowedPaths を両方並べていた場合に限る
    // 非常に狭い範囲で、`design-review-rejections-are-not-durably-recorded` に記録してある。
    paths: [...new Set([...spec.allowedPaths].map(pathText))].sort(),
  })
}

/**
 * 提案が、**これまでに却下されたどの案とも**レビュー対象として違うか。
 *
 * **prompt の hash では判定できない。** 採用時の `implementationScope` には Remediation の
 * 判断記録が追記されるため、中身が同一でも submit されるテキストの hash は必ず変わる。つまり
 * 「hash が違う」ことは材料的な違いを1つも保証しない（独立レビュー指摘）。
 *
 * **1世代前だけと比べても足りない。** 却下済み集合の全件と比べないと
 * A → B → A の巡回で A を再提出でき、同じ再抽選になる（同指摘）。
 *
 * これは `repairPolicy` の `requireDifferentApproach` と同じ趣旨だが、あちらは
 * 「同じ失敗が繰り返されたか」を見る。こちらは「提案が変わっていないか」を見る。
 *
 * 引数は `reviewVisibleSpecKey()` から導いたキーで受ける。呼び出し側は長さの都合で
 * その hash を使ってよいが、**キーの作り方（何を見て何を見ないか）は上の関数が正本**である。
 */
export function isMateriallyDifferentSpec(
  rejectedKeys: readonly string[],
  proposedKey: string,
): boolean {
  return !rejectedKeys.includes(proposedKey)
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
