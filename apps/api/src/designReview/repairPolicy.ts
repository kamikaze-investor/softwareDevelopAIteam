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
  | { action: 'escalate'; reason: string; signature: string }

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

function isRepairJob(job: PriorRepairJob): boolean {
  return job.workflowStepKey?.startsWith(REPAIR_STEP_PREFIX) === true
}

/**
 * ancestry を辿る歩数の上限。
 *
 * 壊れた lineage（自己参照でない長い環・作為的に積まれた鎖）で無限に歩かないための bound。
 * `MAX_REPAIR_ATTEMPTS` とは別の意味なので、その値を流用しない。
 * 超えたら「数え切れなかった」ので **fail-closed**（depth 0 ではない）。
 */
const MAX_ANCESTRY_STEPS = 64

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
 * `human_resume` は **human と証明された resume**。後者だけが予算の再発行を意味する。
 */
export type GenerationRootKind = 'origin' | 'human_resume'

export type GenerationWalk =
  | {
      ok: true
      depth: number
      rootJobId: string
      rootKind: GenerationRootKind
      /** `rootKind === 'human_resume'` のときだけ入る。前 generation 側の Job id。 */
      previousGenerationRoot?: string
      crossedAiResume: boolean
    }
  | { ok: false; reason: string }

/**
 * いまの **repair generation** における repair の深さを、lineage から復元する。
 *
 * generation の根は次のいずれか:
 *   - repair でも resume でもない Job（通常の implement 等）
 *   - **human と証明された resume Job**（人の判断そのものが新しい generation の境界）
 *
 * AI / unknown の resume は **根にしない**。`resume:` の source へ walk を続け、
 * 前の generation の深さを引き継ぐ。これをしないと
 * 「repair 使い切り → AI resume → 予算復活」を AI 自身が繰り返せる。
 *
 * **数えられなかったときは必ず `ok: false`。** depth 0（＝予算満額）へ倒さない。
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
  let cursor = sourceJobId
  let depth = 0
  let crossedAiResume = false

  for (let step = 0; step <= MAX_ANCESTRY_STEPS; step += 1) {
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
    if (stepKey === undefined || stepKey.trim() === '') {
      return { ok: true, depth, rootJobId: cursor, rootKind: 'origin', crossedAiResume }
    }

    if (stepKey.startsWith(REPAIR_STEP_PREFIX)) {
      const parent = parseRepairSource(stepKey)
      if (parent === undefined) {
        return { ok: false, reason: `malformed repair step key on job ${cursor}` }
      }
      depth += 1
      cursor = parent
      continue
    }

    if (stepKey.startsWith(RESUME_STEP_PREFIX)) {
      const parent = parseResumeSource(stepKey)
      if (parent === undefined) {
        return { ok: false, reason: `malformed resume step key on job ${cursor}` }
      }
      // **human と証明された resume だけが新しい generation の根になる。**
      if (job.resumeActorClass === 'human') {
        // 根より**上**の壊れた lineage は跨いでよい —— 人はまさにそれを跨ぐために再開する。
        // ただし「この resume が本当にこの Task の Job から作られたか」は確かめる。
        // `resumeBlockedTask()` は必ず同一 Task の latestJob を親にするので、親が引けない
        // ／自分自身や既に辿った Job を指す形は lineage の矛盾であり、
        // **数え直せていない**側（fail-closed）である。human の記録があっても通さない。
        if (parent === cursor || seen.has(parent) || !byId.has(parent)) {
          return {
            ok: false,
            reason: `human resume ${cursor} points at ${parent}, which is not a usable parent job of this task`,
          }
        }
        return {
          ok: true,
          depth,
          rootJobId: cursor,
          rootKind: 'human_resume',
          previousGenerationRoot: parent,
          crossedAiResume,
        }
      }
      crossedAiResume = true
      cursor = parent
      continue
    }

    // repair でも resume でもない Job（implement / retry 等）が generation の根。
    return { ok: true, depth, rootJobId: cursor, rootKind: 'origin', crossedAiResume }
  }

  return { ok: false, reason: `lineage is longer than the bounded walk (${MAX_ANCESTRY_STEPS} steps)` }
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
  const repairJobs = priorJobs.filter(isRepairJob)

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
    }
  }

  if (walk.depth >= MAX_REPAIR_ATTEMPTS) {
    return {
      action: 'escalate',
      reason: `repair attempts reached the limit (${MAX_REPAIR_ATTEMPTS})`,
      signature,
    }
  }

  // 同じ失敗が残っていること自体は「別の合理的な修正アプローチが無い」ことを意味しない。
  // よって即escalateはせず、別アプローチを要求したうえで継続する。
  const sameFailureRepeated = repairJobs.some(
    (job) => job.status === 'failed' && computeFailureSignature(job.facts) === signature,
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
      budgetReset: walk.rootKind === 'human_resume',
      resetReason:
        walk.rootKind === 'human_resume'
          ? 'human_resume_started_new_generation'
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
