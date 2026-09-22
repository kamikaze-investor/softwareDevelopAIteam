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
 * 記録の失敗で**呼び出し側の操作を失敗させない**ための薄い包み。
 *
 * resume Job / repair Job は既に作られている。ここで例外を投げ返すと、
 * 「Job は在るのに caller は失敗を受け取る」状態になり、人が retry しても
 * 「queued/running が既にある」で断られて詰む（独立レビュー指摘）。
 *
 * 落ちた場合の意味は決めてある: 読み側が `unknown` を返し、generation は跨がらない。
 * **記録の失敗は budget を増やす方向へは倒れない。**
 */
function recordWithoutFailingCaller(operation: string, write: () => void): void {
  try {
    write()
  } catch (error: unknown) {
    console.warn(`[resumeActor] failed to record ${operation}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * resume actor を既存 audit へ記録する。
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
  recordWithoutFailingCaller(RESUME_ACTOR_OPERATION, () => {
    storage.auditLog.record({
      actor: 'api',
      operation: RESUME_ACTOR_OPERATION,
      entityType: 'job',
      entityId: input.jobId,
      result: input.actorClass,
      detail: `task_id=${input.taskId} resume_actor=${input.actorClass} authorization_evidence=${input.evidence}`,
    })
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
  recordWithoutFailingCaller(REPAIR_GENERATION_OPERATION, () => {
    storage.auditLog.record({
      actor: 'api',
      operation: REPAIR_GENERATION_OPERATION,
      entityType: 'job',
      entityId: input.jobId,
      result: input.budgetReset ? 'reset' : 'continued',
      detail: parts.join(' '),
    })
  })
}

/**
 * `human` を認める唯一の根拠。行の `result` だけでなく、**同じ行に書かれた根拠の種別**も見る。
 * 前後を境界で縛るのは `admin_credential_x` のような別の値に引っかからないため。
 */
const ADMIN_EVIDENCE_PATTERN = /(^| )authorization_evidence=admin_credential( |$)/

/**
 * audit 行から actor class を読む。
 *
 * **0 件なら `unknown`**（記録が無いことを human と解釈しない）。
 * **矛盾する記録が複数あっても `unknown`**（human は「単一の明示的な記録」でしか成立しない）。
 * **`human` と書いてあるだけでは足りない** —— 同じ行が
 * `authorization_evidence=admin_credential` を持たなければ `unknown` にする。
 * 「誰が」と「何を根拠に」が食い違う行は、根拠の無い主張と同じだからである（独立レビュー指摘）。
 */
export function resumeActorClassFromAudit(entries: readonly AuditLogEntry[]): ResumeActorClass {
  const rows = entries.filter((entry) => entry.operation === RESUME_ACTOR_OPERATION)
  const seen = new Set(rows.map((row) => row.result))
  if (seen.size !== 1) return 'unknown'

  const only = [...seen][0]
  if (only === 'ai') return 'ai'
  if (only !== 'human') return 'unknown'
  return rows.every((row) => ADMIN_EVIDENCE_PATTERN.test(row.detail ?? '')) ? 'human' : 'unknown'
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
    classes.set(job.id, readOneResumeActorClass(storage, job.id))
  }
  return classes
}

/**
 * 1 件分の読み取り。**読めなかったら `unknown`。**
 *
 * 読み取りの失敗で repair 判定そのものを落とさない。落とすと、監査 storage の不調が
 * そのまま「Job は在るのに caller は失敗を受け取る」状態になる（独立レビュー指摘）。
 * 読めなかった場合の意味は「human と**証明できていない**」であり、予算は再発行されない。
 * つまり**読み取りの失敗も予算を増やす方向へは倒れない**。
 */
function readOneResumeActorClass(storage: IStorage, jobId: string): ResumeActorClass {
  try {
    return resumeActorClassFromAudit(storage.auditLog.findByEntity('job', jobId))
  } catch (error: unknown) {
    console.warn(
      `[resumeActor] failed to read the resume actor of job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 'unknown'
  }
}
