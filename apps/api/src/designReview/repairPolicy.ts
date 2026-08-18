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
  | { action: 'escalate'; reason: string; signature: string }

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

  if (repairJobs.length >= MAX_REPAIR_ATTEMPTS) {
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

  const attempt = repairJobs.length + 1
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
