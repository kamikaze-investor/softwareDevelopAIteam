import type { Task } from '@ai-team/shared'
import {
  buildDesignContract,
  loadEngineeringPrinciples,
  selectPrincipleSlugs,
} from '@ai-team/shared/src/engineeringPrinciples.js'
import { mapFileToFocuses } from '@ai-team/worker/src/approvalLevel/focusSelector.js'

export type TaskContractSource = Pick<
  Task,
  'acceptanceCriteria' | 'expectedOutputs' | 'allowedPaths' | 'forbiddenPaths'
>

/**
 * Reviewer が受け取る既存の Task 要求と同じ4フィールドを、implement prompt 用に直列化する。
 * legacy Task の未設定値は空配列として明示し、追加指示から独立した固定契約として扱う。
 */
export function buildTaskContract(task: TaskContractSource): string {
  return `[Task Contract]
${JSON.stringify({
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    expectedOutputs: task.expectedOutputs ?? [],
    allowedPaths: task.allowedPaths ?? [],
    forbiddenPaths: task.forbiddenPaths ?? [],
  }, null, 2)}

allowedPaths は Task 固有の変更許可範囲であり、他の Guard 規則も引き続き適用される。
forbiddenPaths は allowedPaths より優先される。
空配列は Task 固有の値が宣言されていないことを表す。値を推測して補ってはならない。`
}

function buildFocusedDesignContract(task: Pick<Task, 'allowedPaths'>): string {
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

${buildFocusedDesignContract(task)}`
}

export function appendImplementContracts(prompt: string, task: TaskContractSource): string {
  const principles = loadEngineeringPrinciples()
  const designContract = buildDesignContract({
    slugs: selectPrincipleSlugs(undefined, principles),
    principles,
  })
  return `${prompt}\n\n${buildTaskContract(task)}\n\n${designContract}`
}
