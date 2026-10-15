import type { Task } from './types/task.js'

export type TaskContractSource = Pick<
  Task,
  'acceptanceCriteria' | 'expectedOutputs' | 'allowedPaths' | 'forbiddenPaths'
>

/** Canonical bounded task-purpose block shared by implementers and reviewers. */
export function buildTaskContract(task: Partial<TaskContractSource>): string {
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
