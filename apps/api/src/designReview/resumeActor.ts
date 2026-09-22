/**
 * resume を行った主体の種別を、**server 側で検証できる事実だけ**から決めて残す。
 *
 * ## なぜ要るのか
 *
 * repair budget の generation 境界は「human が再開したか」で決まる（`repairPolicy.ts`）。
 * ところが resume Job の `workflowStepKey`（`resume:<元Job>:<n>`）は
 * **どこから再開したか**しか言わない。誰が再開したかは Job 行にも残っていない。
 * その事実をここで既存 `audit_log` へ bounded に記録し、後から読み直す。
 *
 * ## 決め方（caller の自己申告は使わない）
 *
 * 入力は2つだけである:
 *   - HTTP 経路: `apiTokenAuth()` が認証時に決めた credential 種別（`../auth/credentialClass`）
 *   - PL 経路: HTTP を通らない in-process 呼び出しであるという事実そのもの
 *
 * body / header / query は**一切見ない**。`{"human": true}` や
 * `{"resetRepairBudget": true}` のような申告は、仮に送られても
 * この module へ届かないし、届いても読まない。
 *
 * ## `admin` だけが human
 *
 * split credential mode では WORKER token は `WORKER_ALLOWLIST` に載る route しか
 * 通れず、`POST /api/tasks/:id/resume` はそこに**載っていない**。
 * つまり「ADMIN credential = 人間の操作系」は `HUMAN_ONLY_ROUTES`
 * （`/api/tasks/:id/recover`）が既に依拠している境界であり、ここで新しい authority を
 * 作ってはいない。**既にある境界を読んでいるだけ**である。
 *
 * legacy 単一 `API_TOKEN` mode では人も Worker も同じ token を使うため、
 * この境界が存在しない。よって legacy は human にしない（`unknown`）。
 * 「human かもしれない」を human 扱いすると、AI が自分の repair budget を
 * 再発行できてしまう。
 */

import type { FastifyRequest } from 'fastify'
import type { AuditLogEntry, Job } from '@ai-team/shared'
import { getCredentialClass, type CredentialClass } from '../auth/credentialClass'
import type { IStorage } from '../storage/interface'
import { RESUME_STEP_PREFIX, type ResumeActorClass } from './repairPolicy'

/** resume actor を記録する audit operation 名。新 table は作らない。 */
export const RESUME_ACTOR_OPERATION = 'resume_actor'

/** repair generation の確定を記録する audit operation 名。 */
export const REPAIR_GENERATION_OPERATION = 'repair_generation'

/**
 * 何を根拠に actor class を決めたかの種別。**値そのものは絶対に残さない**
 * （token も hash も長さも書かない。種別名だけ）。
 */
export type ResumeAuthorizationEvidence =
  | 'admin_credential'
  | 'worker_credential'
  | 'actions_readonly_credential'
  | 'legacy_shared_credential'
  | 'no_credential'
  | 'in_process_pl'

/**
 * credential 種別 → resume actor class。
 *
 * **`admin` だけが `human`。** それ以外は `ai` か `unknown` であり、
 * どちらも generation を跨がない（budget は再発行されない）。
 */
export function resumeActorClassForCredential(
  credentialClass: CredentialClass | undefined,
): ResumeActorClass {
  switch (credentialClass) {
    case 'admin':
      return 'human'
    case 'worker':
    case 'actions_readonly':
      return 'ai'
    // legacy は人と Worker が同じ token を使う構成。区別できないので human にしない。
    // undefined は認証 hook を通っていない（= 主体不明）。こちらも human にしない。
    default:
      return 'unknown'
  }
}

/** credential 種別 → 根拠の種別名。 */
export function resumeEvidenceForCredential(
  credentialClass: CredentialClass | undefined,
): ResumeAuthorizationEvidence {
  switch (credentialClass) {
    case 'admin':
      return 'admin_credential'
    case 'worker':
      return 'worker_credential'
    case 'actions_readonly':
      return 'actions_readonly_credential'
    case 'legacy':
      return 'legacy_shared_credential'
    default:
      return 'no_credential'
  }
}

/**
 * request から actor class と根拠を導く。**`apiTokenAuth()` が載せた事実だけを読む。**
 */
export function classifyResumeActorFromRequest(req: FastifyRequest): {
  actorClass: ResumeActorClass
  evidence: ResumeAuthorizationEvidence
} {
  const credentialClass = getCredentialClass(req)
  return {
    actorClass: resumeActorClassForCredential(credentialClass),
    evidence: resumeEvidenceForCredential(credentialClass),
  }
}

/**
 * resume actor を既存 audit へ記録する。**best-effort ではなく resume の一部**として呼ぶ。
 *
 * 記録が落ちた場合に何が起きるかは決めてある: 読み側が `unknown` を返し、
 * generation は跨がらない。つまり**記録の失敗は budget を増やす方向へ倒れない**。
 */
export function recordResumeActor(
  storage: IStorage,
  input: {
    jobId: string
    taskId: string
    actorClass: ResumeActorClass
    evidence: ResumeAuthorizationEvidence
  },
): void {
  storage.auditLog.record({
    actor: 'api',
    operation: RESUME_ACTOR_OPERATION,
    entityType: 'job',
    entityId: input.jobId,
    result: input.actorClass,
    detail: `task_id=${input.taskId} resume_actor=${input.actorClass} authorization_evidence=${input.evidence}`,
  })
}

/**
 * repair generation の確定事実を記録する（CEO 指示 18 章の項目）。
 * 判定に使われる側ではなく、**後から検証するための記録**である。
 */
export function recordRepairGeneration(
  storage: IStorage,
  input: {
    jobId: string
    taskId: string
    generationRoot: string
    ancestryDepth: number
    previousGenerationRoot?: string
    budgetReset: boolean
    resetReason: string
  },
): void {
  const parts = [
    `task_id=${input.taskId}`,
    `generation_root=${input.generationRoot}`,
    `ancestry_depth=${input.ancestryDepth}`,
    `previous_generation_root=${input.previousGenerationRoot ?? 'none'}`,
    `budget_reset=${input.budgetReset ? 'yes' : 'no'}`,
    `reset_reason=${input.resetReason}`,
  ]
  storage.auditLog.record({
    actor: 'api',
    operation: REPAIR_GENERATION_OPERATION,
    entityType: 'job',
    entityId: input.jobId,
    result: input.budgetReset ? 'reset' : 'continued',
    detail: parts.join(' '),
  })
}

/**
 * audit 行から actor class を読む。
 *
 * **0 件なら `unknown`**（記録が無いことを human と解釈しない）。
 * **矛盾する記録が複数あっても `unknown`**（human は「単一の明示的な記録」でしか成立しない）。
 */
export function resumeActorClassFromAudit(entries: readonly AuditLogEntry[]): ResumeActorClass {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.operation !== RESUME_ACTOR_OPERATION) continue
    seen.add(entry.result)
  }
  if (seen.size !== 1) return 'unknown'
  const only = [...seen][0]
  if (only === 'human' || only === 'ai') return only
  return 'unknown'
}

/**
 * Task の Job 群について、resume Job の actor class を引く。
 *
 * **policy 側へ storage を渡さないための境界がここである。**
 * `decideRepairAction()` は Map ではなく素の値だけを受け取る。
 */
export function readResumeActorClasses(
  storage: IStorage,
  jobs: readonly Job[],
): Map<string, ResumeActorClass> {
  const classes = new Map<string, ResumeActorClass>()
  for (const job of jobs) {
    if (!job.workflowStepKey?.startsWith(RESUME_STEP_PREFIX)) continue
    classes.set(job.id, resumeActorClassFromAudit(storage.auditLog.findByEntity('job', job.id)))
  }
  return classes
}
