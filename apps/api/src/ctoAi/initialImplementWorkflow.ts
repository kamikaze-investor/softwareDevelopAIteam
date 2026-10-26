import type { Job, Task } from '@ai-team/shared'
import { TARGET_WORKING_DIR } from '../config/targetWorkingDir'
import {
  buildDefaultCoordinatorDeps,
  createAndExecuteDesignReview,
  type CoordinatorDeps,
} from '../designReview/designReviewCoordinator'
import { checkImplementJobDesignReviewEvidence } from '../designReviewEvidencePolicy'
import { buildTaskContract, buildTaskDesignContract } from '../implementPrompt'
import type { IStorage } from '../storage/interface'

export type InitialImplementWorkflowResult =
  | { taskId: string; status: 'created'; job: Job }
  | { taskId: string; status: 'skipped'; reason: string; retryable?: boolean }

/**
 * 初回 workflow Job が既に在るために作らなかったときの skipped reason。呼び出し側が
 * 「既に在る」を他の skip と区別する唯一の根拠なので、文字列を書き写さずこの定数を使う。
 */
export const INITIAL_WORKFLOW_JOB_EXISTS = 'initial workflow job already exists'

/** 初回 workflow Job の canonical な workflowStepKey。 */
export function initialWorkflowStepKey(taskId: string): string {
  return `task:${taskId}:initial-implement`
}

export function buildInitialImplementAiCliPrompt(task: Pick<
  Task,
  'description' | 'acceptanceCriteria' | 'expectedOutputs' | 'allowedPaths' | 'forbiddenPaths'
>): string {
  return `${task.description}\n\n${buildTaskContract(task)}\n\n${buildTaskDesignContract(task)}`
}

/**
 * DB Task同期とroadmap Markdown保存の成功後にだけ呼ぶ初回workflow producer。
 * promptはTask.descriptionにTask ContractとDesign Contractを付与したcanonical文字列を使用する。
 */
export async function createInitialImplementWorkflow(
  storage: IStorage,
  taskId: string,
  deps: CoordinatorDeps = buildDefaultCoordinatorDeps(),
): Promise<InitialImplementWorkflowResult> {
  const task = storage.tasks.findById(taskId)
  if (!task) return { taskId, status: 'skipped', reason: 'task not found' }

  const project = storage.projects.findById(task.projectId)
  if (!project || project.status === 'archived') {
    return { taskId, status: 'skipped', reason: 'project is unavailable' }
  }
  // paused (or any other non-running, non-archived status) is a temporary state: unlike
  // archived, it should not permanently fail a pending task_continuation. Marking this
  // retryable leaves the continuation 'pending' so the existing Worker Outbox resend
  // (jobs.ts's 503-on-pending-continuation response) naturally retries it once the
  // Project is running again, without a new Gate/Queue/daemon.
  if (project.status !== 'running') {
    return { taskId, status: 'skipped', reason: 'project is not running', retryable: true }
  }
  if (!isInitialWorkflowTarget(task)) {
    return { taskId, status: 'skipped', reason: 'task is not an initial workflow target' }
  }
  // selectNextContinuableTask() と同じdependency判定をproducer側にも適用する。
  // これが無いと、依存未達のTaskにも初回Jobが即座に作られ、依存元Taskの完了前に
  // 同じ共有workspaceへ書き込まれてしまう（既報Issueと同一の根本原因）。
  const siblingsById = new Map(
    storage.tasks.findByProjectId(task.projectId).map((sibling) => [sibling.id, sibling]),
  )
  if (!task.dependencies.every((dependencyId) => siblingsById.get(dependencyId)?.status === 'done')) {
    return { taskId, status: 'skipped', reason: 'task dependencies are not yet done', retryable: true }
  }

  const stepKey = initialWorkflowStepKey(task.id)
  if (storage.jobs.findByTaskId(task.id).some((job) => job.workflowStepKey === stepKey)) {
    return { taskId, status: 'skipped', reason: INITIAL_WORKFLOW_JOB_EXISTS }
  }

  // Job Gateは常に実行する。すでに同一Task・同一prompt hashのALIGNED evidenceがあれば、
  // crash/replay時にReviewを再実行せずそのevidenceを再利用する。
  const aiCliPrompt = buildInitialImplementAiCliPrompt(task)
  const jobInput: Omit<Job, 'id' | 'createdAt'> = {
    taskId: task.id,
    projectId: task.projectId,
    workflowStepKey: stepKey,
    agentRole: 'developer_ai',
    status: 'queued',
    // typecheck → test を Worker に実行させる。repair / retry / resume は safeCommand を
    // そのまま引き継ぐので、この profile は派生 Job にも残る。
    safeCommand: {
      kind: 'test',
      workingDir: TARGET_WORKING_DIR,
      params: { verificationProfile: 'implement' },
    },
    aiCliProvider: task.provider ?? 'claude_code',
    aiCliPrompt,
    aiCliMode: 'implement',
  }
  let gate = checkImplementJobDesignReviewEvidence(jobInput, storage.designReviewEvidence)
  if (!gate.ok) {
    const review = await createAndExecuteDesignReview(storage, {
      taskId: task.id,
      taskTitle: task.title,
      designText: aiCliPrompt,
      changedFiles: [],
    }, deps)
    if (review.status !== 'evidence_registered') {
      return {
        taskId,
        status: 'skipped',
        reason: `design review did not align (${review.status})`,
        retryable: review.status === 'requeued' || review.status === 'contended'
          || review.status === 'not_claimable' || review.status === 'stale',
      }
    }
    gate = checkImplementJobDesignReviewEvidence(jobInput, storage.designReviewEvidence)
  }
  if (!gate.ok) return { taskId, status: 'skipped', reason: gate.reason }

  // **Job を作る直前に、Task と Project を同じ storage transaction の中で確かめ直す**（lifecycle repair C3）。
  //
  // Design Review を await している間に `abort_task` がこの Task を park したり、Project が archive / draft /
  // pause されたりしうる。待つ前の判定のまま queued Job を作ると、Worker は Task の状態を見ずにそれを拾う
  // （park が黙って取り消される）か、archived Project に誰も claim できない queued Job が残る。
  // 読み直しと INSERT を別々に行うと、その間にまた状態が変わりうるので、storage の 1 transaction で行う。
  //
  // 断った場合は **retryable な skip** にする: continuation は pending のまま残り、次の試行の先頭の
  // 判定（project unavailable / not running / not a target / parked）が通常の扱いを決める。
  // ここで非 retryable にすると、待っている間の状態変化だけを理由に次 Task が blocked になる。
  try {
    const created = storage.jobs.createInitialImplementJob(jobInput)
    if (!created.ok) {
      return {
        taskId,
        status: 'skipped',
        reason: `initial implement job was not created after the design review: ${created.reason} (${created.code})`,
        retryable: true,
      }
    }
    return { taskId, status: 'created', job: created.job }
  } catch (error: unknown) {
    // unique index衝突は並行した同一producerによる既存Jobとして扱う。
    if (storage.jobs.findByTaskId(task.id).some((job) => job.workflowStepKey === stepKey)) {
      return { taskId, status: 'skipped', reason: INITIAL_WORKFLOW_JOB_EXISTS }
    }
    throw error
  }
}

function isInitialWorkflowTarget(task: Task): boolean {
  return task.roadmapActive && task.status === 'pending' && task.assignee === 'developer_ai'
}

/**
 * **その Task は Design Review を再実行せずに初回 Job を作れるか（U7 recovery の admission）。**
 *
 * adoption は Task 行を同期 transaction で commit したあと、初回 Job の生成を
 * `await` で HTTP request のプロセス内に持つ。その間に API が落ちると
 * 「この Task はまだ Job を要する」という事実がどこにも durable に残らない
 * （`task_ready_without_job` は立つが、PL には直せないので通知だけで終わる）。
 *
 * **ここが守る唯一の本質は「Design Review を再実行しないこと」である。**
 * evidence が無い Task（Design Review が CONFLICT で終わった等）まで拾うと、
 * poll のたびに Review を起動する loop になり、`independent-remediation-design-review-conflict`
 * が持つ CONFLICT 復旧の責務とも衝突する。よって **Job Gate が既に成立していること**を
 * 入場条件にする。
 *
 * 判定は `createInitialImplementWorkflow()` が内部で使うのと**同一の**
 * `checkImplementJobDesignReviewEvidence()` をそのまま通す。prompt hash 不一致・
 * 非 ALIGNED・critical の independent verdict 未承認は、すべてその関数が既に見ている。
 * **同じ Gate semantics をここで書き直さない。**
 */
export function canRecoverInitialImplementJobWithoutReview(storage: IStorage, task: Task): boolean {
  if (!isInitialWorkflowTarget(task)) return false
  // `isReadyTaskWithoutJob()`（systemState）と同じ「Job が1件も無い」を条件にする。
  // Job がある Task は、たとえ initial stepKey が無くても recovery の対象ではない。
  if (storage.jobs.findByTaskId(task.id).length > 0) return false

  return checkImplementJobDesignReviewEvidence(
    {
      taskId: task.id,
      aiCliMode: 'implement',
      aiCliPrompt: buildInitialImplementAiCliPrompt(task),
    },
    storage.designReviewEvidence,
  ).ok
}
