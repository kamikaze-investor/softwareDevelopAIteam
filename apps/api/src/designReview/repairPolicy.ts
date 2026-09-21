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

export interface RepairFailureFacts {
  exitCode?: number
  stderr?: string
  failureKind?: string
  reviewFindingRules?: string[]
}

export interface PriorRepairJob {
  /**
   * Job id。**lineage を辿るために必要**である。`repair:<sourceJobId>:1` の
   * sourceJobId から親 Job を引くので、id 無しでは chain を再構成できない。
   */
  id: string
  workflowStepKey?: string
  status: string
  facts: RepairFailureFacts
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
    }
  | {
      action: 'escalate'
      reason: string
      signature: string
      /**
       * escalate の理由を**構造化して**持つ。呼び出し側が reason 文字列を
       * 部分一致で判定すると、文言を変えた瞬間に黙って壊れるためである。
       *
       * - `attempt_limit`: この chain の repair 段数が上限に達した
       * - `lineage_undeterminable`: chain を辿れなかった（fail-closed）
       * - `no_actionable_information`: 同じ失敗の繰り返しで手がかりが無い
       */
      code: 'attempt_limit' | 'lineage_undeterminable' | 'no_actionable_information'
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

/** `repair:<sourceJobId>:1`。末尾は常に `:1`（`decideRepairAction` が付ける規約）。 */
const REPAIR_EDGE = /^repair:([^:]+):1$/
/** `resume:<sourceJobId>:<n>`（`resumeBlockedTask()` の規約）。 */
const RESUME_EDGE = /^resume:([^:]+):\d+$/

/**
 * lineage を辿る上限。実データの chain は高々 `MAX_REPAIR_ATTEMPTS` 段だが、
 * 壊れたデータで無限に歩かないための保険であり、**上限に達したら fail-closed** にする。
 */
const MAX_LINEAGE_WALK = 64

export type RepairLineage =
  | { ok: true, depth: number, chainJobIds: readonly string[] }
  | { ok: false, reason: string }

/**
 * **repair budget を「Task 全体の repair 数」ではなく「この chain の repair 段数」で数える。**
 *
 * ## なぜ変えるか（production 実測・2026-09-21）
 *
 * Task `c3849205` は初回 implement からの chain で repair を3回使い切ったあと、
 * 別の implementation が成功した。その成果へのレビュー指摘を repair へ渡そうとすると、
 * **すでに使い切った Task 全体のカウント**に当たって必ず escalate していた。
 * 数えるべきは「いま直そうとしている実装が、何段目の repair か」である。
 *
 * ## chain の境界
 *
 * 境界は **recovery epoch だけ**である。`resume:` は境界にしない ——
 * `resume_task` は PL が in-process で実行できる（`executionLoop.ts`）ので、
 * `resume:` を境界にすると **PL が repair budget を自力で更新できてしまう**
 * （repair 上限 → blocked → resume → budget reset の無限ループ）。
 * よって `resume:` は**跨いで辿り、repair 段数には数えない**。
 *
 * epoch は `epochCoveredJobIds` として呼び出し側が渡す。その実体は
 * **consume 済みの ApprovalRequest**（`repairRecoveryEpoch.ts`）であり、
 * PL の in-process 経路からは作れない。
 *
 * ## 確定できないときは escalate
 *
 * source Job が見つからない / 別 Task / stepKey が壊れている / 循環している /
 * 深すぎる、のいずれでも**段数を推測しない**。`ok: false` を返し、呼び出し側は escalate する。
 */
export function computeRepairLineage(
  startJobId: string,
  priorJobs: readonly PriorRepairJob[],
  epochCoveredJobIds: ReadonlySet<string>,
): RepairLineage {
  const byId = new Map(priorJobs.map((job) => [job.id, job]))
  const chainJobIds: string[] = []
  const seen = new Set<string>()
  let currentId = startJobId

  for (let hop = 0; hop < MAX_LINEAGE_WALK; hop++) {
    // **epoch は先に見る。** epoch に覆われた Job はそこが chain の根である。
    if (epochCoveredJobIds.has(currentId)) {
      return { ok: true, depth: chainJobIds.filter((id) => isRepairEdge(byId.get(id))).length, chainJobIds }
    }
    if (seen.has(currentId)) {
      return { ok: false, reason: `cyclic repair lineage at ${currentId}` }
    }
    seen.add(currentId)

    const job = byId.get(currentId)
    if (!job) {
      // priorJobs はこの Task の Job 全件なので、居ない = 存在しないか別 Task。
      return { ok: false, reason: `lineage source job ${currentId} is not a job of this task` }
    }
    chainJobIds.push(currentId)

    const key = job.workflowStepKey
    if (key === undefined || key.length === 0) {
      return { ok: true, depth: countRepairEdges(chainJobIds, byId), chainJobIds }
    }

    const parentId = REPAIR_EDGE.exec(key)?.[1] ?? RESUME_EDGE.exec(key)?.[1]
    if (parentId === undefined) {
      // `repair:` / `resume:` を名乗りながら規約に合わない形は、辿れないので推測しない。
      if (key.startsWith('repair:') || key.startsWith('resume:')) {
        return { ok: false, reason: `malformed lineage step key: ${key}` }
      }
      // それ以外（`task:<id>:initial-implement` 等）は chain の根。
      return { ok: true, depth: countRepairEdges(chainJobIds, byId), chainJobIds }
    }
    currentId = parentId
  }

  return { ok: false, reason: `repair lineage is deeper than ${MAX_LINEAGE_WALK}` }
}

function isRepairEdge(job: PriorRepairJob | undefined): boolean {
  return REPAIR_EDGE.test(job?.workflowStepKey ?? '')
}

function countRepairEdges(
  chainJobIds: readonly string[],
  byId: ReadonlyMap<string, PriorRepairJob>,
): number {
  return chainJobIds.filter((id) => isRepairEdge(byId.get(id))).length
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
  /**
   * recovery epoch に覆われた Job id。ここが chain の根になる。
   * 既定は空集合で、**渡さなければ従来どおり chain の実体だけで数える**。
   */
  epochCoveredJobIds: ReadonlySet<string> = new Set<string>(),
): RepairDecision {
  const signature = computeFailureSignature(newFacts)

  // **budget は Task 全体ではなく、この chain の段数で数える。**
  // 辿れなければ段数を推測せず escalate する（fail-closed）。
  const lineage = computeRepairLineage(sourceJobId, priorJobs, epochCoveredJobIds)
  if (!lineage.ok) {
    return {
      action: 'escalate',
      reason: `repair lineage could not be determined: ${lineage.reason}`,
      signature,
      code: 'lineage_undeterminable',
    }
  }

  if (lineage.depth >= MAX_REPAIR_ATTEMPTS) {
    return {
      action: 'escalate',
      reason: `repair attempts reached the limit (${MAX_REPAIR_ATTEMPTS})`,
      signature,
      code: 'attempt_limit',
    }
  }

  // 「同じ失敗の繰り返し」も **同じ chain の中**で見る。別 chain の失敗は別の話である。
  const chainIds = new Set(lineage.chainJobIds)
  const repairJobs = priorJobs.filter((job) => isRepairJob(job) && chainIds.has(job.id))

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
      code: 'no_actionable_information',
    }
  }

  const attempt = lineage.depth + 1
  return {
    action: 'repair',
    attempt,
    // 末尾は常に :1 で固定する。attempt番号を入れると同一failureの再送で別keyになり、
    // chainが二重化する。一意性はsourceJobId側が担保する（Stage 1の retry:<jobId>:1 と同じ）。
    stepKey: `${REPAIR_STEP_PREFIX}${sourceJobId}:1`,
    signature,
    requireDifferentApproach: sameFailureRepeated,
  }
}
