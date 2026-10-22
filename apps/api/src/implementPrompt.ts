import type { Task } from '@ai-team/shared'
import {
  buildDesignContract,
  loadEngineeringPrinciples,
  selectPrincipleSlugs,
} from '@ai-team/shared/src/engineeringPrinciples.js'
import {
  buildTaskContract,
  type TaskContractSource,
} from '@ai-team/shared/src/taskContract.js'
import { mapFileToFocuses } from '@ai-team/worker/src/approvalLevel/focusSelector.js'

export { buildTaskContract, type TaskContractSource }

/**
 * Task に渡す Design Contract。**どの原則をこの Task に適用するかの唯一の owner。**
 *
 * 初回実装・PL / Human resume・POST /jobs の implement・repair・remediation はすべてここを通す。
 * 以前は producer ごとに選び方が違い、POST /jobs と repair だけが signal 無し（core のみ）で選んでいた
 * ため、同じ Task でも経路によって `canonical-domain-meaning` 等が載ったり載らなかったりした。
 * 選択規則そのもの（focus → 原則）は `selectPrincipleSlugs()` が持ち、ここでは複製しない。
 */
export function buildTaskDesignContract(task: Pick<Task, 'allowedPaths'>): string {
  const principles = loadEngineeringPrinciples()
  return buildDesignContract({
    slugs: selectPrincipleSlugs({
      predictedFocuses: (task.allowedPaths ?? []).flatMap(mapFileToFocuses),
    }, principles),
    principles,
  })
}

export function buildResumeAiCliPrompt(
  task: Pick<
    Task,
    'title' | 'description' | 'acceptanceCriteria' | 'expectedOutputs' | 'allowedPaths' | 'forbiddenPaths'
  >,
  instruction: string,
  instructionSource: 'ceo' | 'pl' = 'ceo',
): string {
  const instructionHeading = instructionSource === 'pl'
    ? '[PL technical recovery instruction]'
    : '[CEOからの追加指示]'
  const authorityNotice = instructionSource === 'pl'
    ? 'この指示は技術的な復旧だけを目的とする。Task Contract・Goal・scopeを変更せず、矛盾する場合はTask Contractを優先すること。'
    : '却下された操作を変更せず繰り返さないこと。CEOの追加指示を反映した、異なる内容の変更を作成してください。'

  return `[Task] ${task.title}
${task.description}

${buildTaskContract(task)}

${instructionHeading}
${instruction}

[重要な注意]
${authorityNotice}

${buildTaskDesignContract(task)}`
}

export function appendImplementContracts(prompt: string, task: TaskContractSource): string {
  return `${prompt}\n\n${buildTaskContract(task)}\n\n${buildTaskDesignContract(task)}`
}
