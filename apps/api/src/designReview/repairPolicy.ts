/**
 * Bounded autonomous repair の判定（pure / deterministic）。
 *
 * 同一Taskでrepair Jobを無限生成しないための境界を、**既存データだけ**から導出する。
 * 新しいtable / column / statusは追加しない。判定材料は既存のJob（`workflowStepKey`・
 * `exitCode`・`stderr`・`failureMetadata`）とReviewResultのみ。
 *
 * 方針:
 *   - 合理的に「異なる修正」を試せる間はAI側で継続する
 *   - 同じ失敗が残っていること自体はescalate条件にしない。別アプローチを要求して継続する
 *   - hard boundである MAX_REPAIR_ATTEMPTS を使い切った場合、または別アプローチを
 *     合理的に構成する手がかりが無い場合のみ、既存のHuman escalationへ渡す
 *
 * escalate時は新しいHuman workflowを作らない。repair Jobを作らずに失敗を確定させ、
 * 既存のblocked → `POST /api/tasks/:id/resume` の人手経路に委ねる。
 *
 * Stage 1（provider timeoutの同一入力retry）とは別物である。Stage 1は入力を変えずに
 * 再実行するもので、こちらは失敗事実に基づいて**内容の異なる**修正を作る。
 */

import { createHash } from 'node:crypto'

/** 同一Taskで自動生成を許すrepair Jobの上限（hard bound）。 */
export const MAX_REPAIR_ATTEMPTS = 3

/**
 * repair Jobであることを示す`workflowStepKey`の接頭辞。既存の冪等キー機構を再利用する。
 * 実際のkeyは `repair:<sourceJobId>:1` とする。`ux_jobs_workflow_step_key` は
 * 全体一意なので、Stage 1の `retry:<jobId>:1` と同様にID を含めないとTask間で衝突する。
 */
export const REPAIR_STEP_PREFIX = 'repair:'

/**
 * resume Job であることを示す `workflowStepKey` の接頭辞。
 * 実際のkeyは `resume:<sourceJobId>:<n>`（`resumeBlockedTask()` だけが付ける規約）。
 */
export const RESUME_STEP_PREFIX = 'resume:'

export interface RepairFailureFacts {
  exitCode?: number
  stderr?: string
  failureKind?: string
  reviewFindingRules?: string[]
}

/**
 * resume Job を作った主体の種別。**lineage ではなく authority の事実である。**
 *
 * `resume:` という stepKey は「どこから再開したか」しか言わない（lineage fact）。
 * 「誰が再開してよいと判断したか」は別の事実（authority fact）であり、
 * server 側で credential から導く。caller の自己申告は入力にしない。
 *
 * `unknown` は「human かもしれない」ではなく「human と証明できていない」である。
 * したがって `ai` と同じ扱い（generation を跨がない）にする。
 */
export type ResumeActorClass = 'human' | 'ai' | 'unknown'

export interface PriorRepairJob {
  /**
   * Job の id。**ancestry を辿るために要る。**
   * `repair:<sourceJobId>:1` の `sourceJobId` はこの id を指すので、
   * id が無いと chain を復元できず、Task 全体の件数で数えるしかなくなる。
   */
  id: string
  workflowStepKey?: string
  status: string
  facts: RepairFailureFacts
  /**
   * `resume:` Job のときだけ意味を持つ。**省略時は `unknown` として扱う。**
   * 記録が無いことを「human だった」と解釈しない（fail-safe）。
   */
  resumeActorClass?: ResumeActorClass
  /**
   * この Job を根として **human recovery generation** が始まっているか。
   *
   * 根拠は consume 済み ApprovalRequest であり、読み取りは flow 層が行う
   * （`repairRecoveryEpoch.ts`。`resumeActorClass` と同じ境界の置き方）。
   * **省略時は false**。記録が無いことを authority と解釈しない（fail-safe）。
   */
  humanRecoveryEpoch?: boolean
}

export type RepairDecision =
  | {
      action: 'repair'
      attempt: number
      stepKey: string
      signature: string
      /**
       * 前回と同じ失敗が残っている場合にtrue。repair promptへ「前回と実質的に異なる
       * アプローチを取ること」を明示するために使う。これによりcanonical promptが変わるため、
       * 同じpromptをそのまま再実行することにはならない。
       */
      requireDifferentApproach: boolean
      /**
       * この repair がどの generation に属するかの確定事実。**判定の入力ではなく出力**で、
       * 呼び出し側が既存 audit へそのまま載せるためにある（新しい table は作らない）。
       */
      generation: RepairGeneration
    }
  | {
      action: 'escalate'
      reason: string
      signature: string
      /**
       * escalate の理由を**構造化して**持つ。呼び出し側が reason 文字列を部分一致で
       * 判定すると、文言を変えた瞬間に黙って壊れる。
       *
       * - `attempt_limit`: この generation の repair 段数が上限に達した
       * - `lineage_unreconstructable`: chain を辿れなかった（fail-closed）
       * - `no_actionable_information`: 同じ失敗の繰り返しで手がかりが無い
       */
      code: 'attempt_limit' | 'lineage_unreconstructable' | 'no_actionable_information'
    }

/** repair 1 件が属する generation の確定事実。 */
export interface RepairGeneration {
  /** この generation の根になった Job id。 */
  rootJobId: string
  rootKind: GenerationRootKind
  /** 根から数えた repair の深さ（この repair を作る**前**の値）。 */
  depth: number
  /** `rootKind === 'human_resume'` のときだけ入る。 */
  previousGenerationRoot?: string
  /** 途中で AI / unknown の resume を跨いだか。跨いでも予算は再発行されない。 */
  crossedAiResume: boolean
  /** 予算が再発行されたか（= 新しい generation が始まったか）。 */
  budgetReset: boolean
  /** なぜ再発行された / されなかったのか。audit に残す短い理由。 */
  resetReason: string
}

/**
 * 失敗の同一性を判定するための署名。
 *
 * path / line / column / メモリアドレス / タイムスタンプ / 実行時間のような
 * 「毎回変わるノイズ」だけを正規化する。
 * HTTP status・exit code・expected/actual値のような**意味のある数値は保持する**。
 * 潰しすぎると別の失敗を同一視して不当に早くescalateしてしまうため。
 */
export function computeFailureSignature(facts: RepairFailureFacts): string {
  const normalizedStderr = (facts.stderr ?? '')
    .replace(/\r\n/g, '\n')
    // 絶対パス（Windows / POSIX）
    .replace(/[A-Za-z]:\[^\s:]+/g, '<path>')
    .replace(/\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>')
    // file:line:col / file:line（パス直後の位置情報のみ）
    .replace(/(<path>|[\w.-]+\.[A-Za-z]{1,5}):\d+:\d+/g, '$1:<line>:<col>')
    .replace(/(<path>|[\w.-]+\.[A-Za-z]{1,5}):\d+/g, '$1:<line>')
    // メモリアドレス
    .replace(/\b0x[0-9a-fA-F]+\b/g, '<hex>')
    // ISO8601タイムスタンプ
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<timestamp>')
    // 実行時間表記
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds)\b/g, '<duration>')
    .trim()
    .slice(0, 2_000)

  const parts = [
    `exitCode=${facts.exitCode ?? ''}`,
    `kind=${facts.failureKind ?? ''}`,
    `rules=${[...(facts.reviewFindingRules ?? [])].sort().join(',')}`,
    `stderr=${normalizedStderr}`,
  ]

  return createHash('sha256').update(parts.join('\n'), 'utf-8').digest('hex')
}

/**
 * `repair:<sourceJobId>:1` から source Job id を取り出す。
 * 形が違えば `undefined`。**呼び出し側は必ず fail-closed 側へ倒すこと。**
 */
export function parseRepairSource(stepKey: string): string | undefined {
  const match = /^repair:(.+):1$/.exec(stepKey)
  const source = match?.[1]
  return source !== undefined && source.length > 0 ? source : undefined
}

/** `resume:<sourceJobId>:<n>` から source Job id を取り出す。 */
function parseResumeSource(stepKey: string): string | undefined {
  const match = /^resume:(.+):\d+$/.exec(stepKey)
  const source = match?.[1]
  return source !== undefined && source.length > 0 ? source : undefined
}

/**
 * generation の根がどちら側の事実で決まったか。
 *
 * `origin` は lineage の端（通常の implement 等）。
 * `human_resume` は **human と証明された resume**。
 * `human_recovery` は **その実装に対する human recovery epoch**（consume 済みの
 * ApprovalRequest）。後ろ2つだけが予算の再発行を意味する。
 *
 * **この2つを混同しない。** `human_resume` は「再開した時点で human と証明された」
 * という *resume の provenance* であり、`human_recovery` は「いまここから新しい
 * repair generation を始めてよい」という *現時点の authority* である。
 * 後者は過去の resume を human だったことにはしない。
 */
export type GenerationRootKind = 'origin' | 'human_resume' | 'human_recovery'

export type GenerationWalk =
  | {
      ok: true
      depth: number
      rootJobId: string
      rootKind: GenerationRootKind
      /** `rootKind === 'human_resume'` のときだけ入る。前 generation 側の Job id。 */
      previousGenerationRoot?: string
      crossedAiResume: boolean
      /**
       * **この generation に属する repair Job の id**（根から辿った経路上のものだけ）。
       * 「同じ失敗が繰り返されているか」を前の generation まで含めて数えないための境界である。
       */
      generationRepairJobIds: string[]
    }
  | { ok: false; reason: string }

/**
 * いまの **repair generation** における repair の深さを、lineage から復元する。
 *
 * 規則は 2 つに分かれている。混ぜると必ずどちらかが壊れる:
 *
 *   1. **lineage は全体が well-formed でなければならない。** 根より上も含めて、
 *      この Task の中で有限・非環の 1 本道であること。どこかが壊れていたら
 *      「復元できていない」ので **`ok: false`**（depth 0 ＝ 予算満額へは倒さない）。
 *   2. **深さを数える範囲だけが generation で切れる。** 数え終わりは
 *      repair でも resume でもない Job か、**human と証明された resume Job** である。
 *
 * AI / unknown の resume は数え終わりにしない。前の generation の深さを引き継ぐ。
 * これをしないと「repair 使い切り → AI resume → 予算復活」を AI 自身が繰り返せる。
 *
 * 1 と 2 を分けているのは、human resume の意味が「**上流の履歴を跨いで**やり直す」だから
 * である。深さは 0 に戻るが、だからといって上流が環でも別 Task でもよいことにはならない
 * —— それは「この resume 自身がどこから来たのか判らない」ことを意味する（独立レビュー指摘）。
 */
export function walkRepairGeneration(
  sourceJobId: string,
  priorJobs: readonly PriorRepairJob[],
): GenerationWalk {
  const byId = new Map<string, PriorRepairJob>()
  for (const job of priorJobs) {
    if (byId.has(job.id)) {
      // 同じ id が 2 件ある入力は lineage の前提（id は一意）が崩れている。
      return { ok: false, reason: `ambiguous lineage: duplicate job id ${job.id}` }
    }
    byId.set(job.id, job)
  }

  const seen = new Set<string>()
  const generationRepairJobIds: string[] = []
  let cursor = sourceJobId
  let depth = 0
  let crossedAiResume = false

  /**
   * 数え終わりが決まったら確定する。**以降も walk は続く**（上流の健全性を確かめるため）。
   * ここに値が入った後は depth も crossedAiResume も動かさない。
   */
  let countedRoot: {
    rootJobId: string
    previousGenerationRoot?: string
    kind: 'human_resume' | 'human_recovery'
  } | undefined

  const finish = (originJobId: string): GenerationWalk => (
    countedRoot === undefined
      ? { ok: true, depth, rootJobId: originJobId, rootKind: 'origin', crossedAiResume, generationRepairJobIds }
      : {
          ok: true,
          depth,
          rootJobId: countedRoot.rootJobId,
          rootKind: countedRoot.kind,
          previousGenerationRoot: countedRoot.previousGenerationRoot,
          crossedAiResume,
          generationRepairJobIds,
        }
  )

  /** `repair:` / `resume:` いずれの規約でも親を返す。それ以外は端なので undefined。 */
  const lineageParentOf = (stepKey: string | undefined): string | undefined => {
    if (stepKey === undefined) return undefined
    if (stepKey.startsWith(REPAIR_STEP_PREFIX)) return parseRepairSource(stepKey)
    if (stepKey.startsWith(RESUME_STEP_PREFIX)) return parseResumeSource(stepKey)
    return undefined
  }

  // **停止保証と cycle 検出は別の責務である。両方持つ。**
  //
  //   - `seen`（下）は**意味側**のガード: 同じ Job を 2 度訪れたら lineage は環である。
  //     何が起きたかを名前で報告できるのはこちらだけ。
  //   - 歩数の上限（ここ）は**停止側**のガード: 意味側が将来壊れても、process を
  //     無限ループさせない。実際に壊した状態で計測したら worker が 1 コアを
  //     82 分専有して止まらなかったので、後から足した。
  //
  // 上限は**固定値ではなく、この Task の Job 件数**である。整形式の lineage は
  // 同じ Job を 2 度訪れないので `byId.size` 歩を超えることはあり得ない。
  // よって正当な lineage を誤って弾かず、かつ必ず有限時間で終わる。
  // 固定の歩数（以前の `MAX_ANCESTRY_STEPS = 64`）は、それ自体が**新しい閾値**になり、
  // 長く生き延びた Task の正当な lineage を「数え切れなかった」と誤判定していた。
  for (let step = 0; step <= byId.size; step += 1) {
    if (seen.has(cursor)) {
      return { ok: false, reason: `lineage forms a cycle at job ${cursor}` }
    }
    seen.add(cursor)

    const job = byId.get(cursor)
    if (!job) {
      // 同一 Task の Job しか渡されないので、見つからない＝存在しないか別 Task。
      // どちらも「この chain を数え切れていない」ので安全側で止める。
      return { ok: false, reason: `lineage references job ${cursor}, which is not a job of this task` }
    }

    const stepKey = job.workflowStepKey

    // **human recovery epoch は、その Job の stepKey 種別に依らず数え終わりになる。**
    //
    // epoch が張られるのは「レビューされた実装 Job」であり、それ自体が `resume:` の
    // こともある（production `c3849205` の `eec46736` がまさにそれ）。よって
    // stepKey 分岐より**手前**で見る。
    //
    // **最も近い authority が勝つ。** `countedRoot === undefined` のときだけ確定するので、
    // 上流にさらに `human_resume` があっても現在の根を上書きしない。
    // そして `human_resume` と同じく **ここで walk を止めない** —— 止めると、この Job
    // 自身が環の一部でも別 Task から来ていても素通りしてしまう。
    if (countedRoot === undefined && job.humanRecoveryEpoch === true) {
      countedRoot = {
        rootJobId: cursor,
        previousGenerationRoot: lineageParentOf(stepKey),
        kind: 'human_recovery',
      }
    }

    if (stepKey === undefined || stepKey.trim() === '') {
      return finish(cursor)
    }

    if (stepKey.startsWith(REPAIR_STEP_PREFIX)) {
      const parent = parseRepairSource(stepKey)
      if (parent === undefined) {
        return { ok: false, reason: `malformed repair step key on job ${cursor}` }
      }
      if (countedRoot === undefined) {
        depth += 1
        generationRepairJobIds.push(cursor)
      }
      cursor = parent
      continue
    }

    if (stepKey.startsWith(RESUME_STEP_PREFIX)) {
      const parent = parseResumeSource(stepKey)
      if (parent === undefined) {
        return { ok: false, reason: `malformed resume step key on job ${cursor}` }
      }
      // **human と証明された resume が数え終わり。** ただしここで walk は止めない。
      // 止めると、この resume 自身が環の一部でも別 Task から来ていても素通りしてしまう。
      if (countedRoot === undefined && job.resumeActorClass === 'human') {
        countedRoot = { rootJobId: cursor, previousGenerationRoot: parent, kind: 'human_resume' }
      } else if (countedRoot === undefined) {
        crossedAiResume = true
      }
      cursor = parent
      continue
    }

    // repair でも resume でもない Job（implement / retry 等）が lineage の端。
    return finish(cursor)
  }

  // **整形式の lineage ではここへ来ない。** 来たのは意味側のガードが働いていない
  // ということなので、「数え切れていない」として fail-closed にする。
  // depth 0（＝予算満額）へも success へも倒さない。
  return {
    ok: false,
    reason: `lineage walk did not terminate within the ${byId.size} jobs of this task`,
  }
}

/**
 * 次に取るべき行動を決める。
 *
 * @param sourceJobId 失敗した元Job。stepKeyのanchorにする。attempt番号をanchorにすると
 *                    生成済みrepair Jobが試行数を進めてしまい、同一failure eventから
 *                    別keyのchainが二重に作られる（Stage 1の `retry:<jobId>:1` と同じ規約）
 * @param priorJobs 同一Taskの既存Job（順序は問わない）
 * @param newFacts  今回の失敗事実
 */
export function decideRepairAction(
  sourceJobId: string,
  priorJobs: readonly PriorRepairJob[],
  newFacts: RepairFailureFacts,
): RepairDecision {
  const signature = computeFailureSignature(newFacts)

  // **予算は「この repair chain（generation）で何回直したか」で数える。**
  // 以前は Task 全体の repair Job 件数だった。そのため、互いに無関係な 3 つの失敗が
  // 1 回ずつ直されただけで Task 全体の自動修復が尽きていた（実測）。
  // 逆に、chain を無視して「repair でなければ fresh」にすると、AI が resume を挟むだけで
  // 予算を作り直せてしまう。だから generation の根は lineage ではなく **authority** で決める。
  const walk = walkRepairGeneration(sourceJobId, priorJobs)
  if (!walk.ok) {
    // 数え切れなかったので depth 0（予算満額）には倒さない。既存の Human escalation へ渡す。
    return {
      action: 'escalate',
      reason: `repair lineage could not be reconstructed: ${walk.reason}`,
      signature,
      code: 'lineage_unreconstructable',
    }
  }

  if (walk.depth >= MAX_REPAIR_ATTEMPTS) {
    return {
      action: 'escalate',
      reason: `repair attempts reached the limit (${MAX_REPAIR_ATTEMPTS})`,
      signature,
      code: 'attempt_limit',
    }
  }

  // 同じ失敗が残っていること自体は「別の合理的な修正アプローチが無い」ことを意味しない。
  // よって即escalateはせず、別アプローチを要求したうえで継続する。
  //
  // **数える範囲はこの generation の中だけ。** Task 全体で数えると、human が resume して
  // 新しい generation を始めても、**前の generation の失敗**が `sameFailureRepeated` を
  // 立て続ける。手がかりの無い失敗と重なると、人が与えたはずの予算が 1 回も使われないまま
  // escalate に戻る（独立レビュー指摘。人の判断を無効化する向きの誤りなので直した）。
  const generationRepairJobIds = new Set(walk.generationRepairJobIds)
  const sameFailureRepeated = priorJobs.some(
    (job) =>
      generationRepairJobIds.has(job.id) &&
      job.status === 'failed' &&
      computeFailureSignature(job.facts) === signature,
  )

  // ただし失敗事実が何も無い場合は、別アプローチを組み立てる手がかりが無い。
  const hasActionableFacts =
    newFacts.exitCode !== undefined ||
    (newFacts.stderr ?? '').trim().length > 0 ||
    (newFacts.failureKind ?? '').trim().length > 0 ||
    (newFacts.reviewFindingRules ?? []).length > 0

  if (sameFailureRepeated && !hasActionableFacts) {
    return {
      action: 'escalate',
      reason: 'the same failure repeated and there is no actionable information to try a different approach',
      signature,
      code: 'no_actionable_information',
    }
  }

  const attempt = walk.depth + 1
  return {
    action: 'repair',
    attempt,
    generation: {
      rootJobId: walk.rootJobId,
      rootKind: walk.rootKind,
      depth: walk.depth,
      previousGenerationRoot: walk.previousGenerationRoot,
      crossedAiResume: walk.crossedAiResume,
      budgetReset: walk.rootKind === 'human_resume' || walk.rootKind === 'human_recovery',
      // **理由は2つを区別して残す。** 監査上、過去の resume が human だったのか、
      // いま recovery を承認されたのかは別の事実である。
      resetReason:
        walk.rootKind === 'human_resume'
          ? 'human_resume_started_new_generation'
          : walk.rootKind === 'human_recovery'
            ? 'human_recovery_epoch_started_new_generation'
            : walk.crossedAiResume
              ? 'ai_or_unknown_resume_continues_generation'
              : 'same_generation',
    },
    // 末尾は常に :1 で固定する。attempt番号を入れると同一failureの再送で別keyになり、
    // chainが二重化する。一意性はsourceJobId側が担保する（Stage 1の retry:<jobId>:1 と同じ）。
    stepKey: `${REPAIR_STEP_PREFIX}${sourceJobId}:1`,
    signature,
    requireDifferentApproach: sameFailureRepeated,
  }
}
