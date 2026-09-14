/**
 * PL Action Gate — PL の操作案を必ず既存 Gate へルーティングするための enforcement seam。
 *
 * `resolvePlActionPolicy()`（`@ai-team/shared`）が「どの Gate が必要か」を決める純粋関数で、
 * ここはその結果を **記録し、必要 Gate が実データで揃うまで実行を許さない**境界である。
 *
 * ## 設計の中心: 呼び出し側から渡されたものを信じない
 *
 * 独立レビュー（OpenAI / Codex）の2回のラウンドで、この層が境界として成立するために
 * 必要な条件が確定した。いずれも「PL ループは外部プロセスであり、渡す値は全て PL が作れる」
 * という前提から来ている。
 *
 * 1. **判定は必ず再計算する。** 判定結果オブジェクトを引数で受け取らない
 *    （`recomputeDecision()` が runner の `finalDecision` を採用しないのと同じ理由・同じ形）。
 * 2. **充足の根拠は DB の実レコードで検証する。** Gate 名の文字列を渡せば通る経路を作らない。
 * 3. **根拠は操作対象へ束縛する。** Task A の ALIGNED evidence で Task B の resume を
 *    通せてはならない。**通るかどうかの判断に、対象と無関係なレコードを使わせない。**
 * 4. **判定と充足検証を分けない。** 「認可した提案」と「検証した提案」がズレる隙間を作らない。
 *    許可を得る手段は `authorizePlAction()` **一つだけ**で、そこへ渡した提案そのものに対してしか
 *    許可は出ない。
 * 5. **時刻は呼び出し側から受け取らない。** 期限判定を呼び出し側の時計に依存させない。
 *
 * ## この層が保証しないこと（`vps-pl-execution-loop` の受入条件へ回した）
 *
 * - 許可を得た提案と、**実際に実行される操作**が一致すること。ここは「この提案は通る」までしか
 *   言えない。executor を提案から構造的に dispatch するのは配線側の責務である。
 * - `changedFiles` / `providerChange` を実差分・実構成へ束縛すること。
 * - 対象 Job の risk / production 影響の継承、実行者の Role・Production 操作権限。
 * - CEO Approval の Project スコープ束縛。`approvals.findById()` が `projectId` を返さないため、
 *   現状は Approval の `type` による束縛までしかできない（`findById` の additive 拡張が要る）。
 * - `deploy_production` は `system` 対象なので Task/Project スコープの Review 根拠を
 *   結び付けられず、**この層では充足不能**である（`unbindableGates()` が明示する）。
 *   deploy スコープの Review 根拠を用意するのは配線側の責務。
 *
 * ## 新しい Gate は作っていない
 *
 * `requiredGates` は既存工程への参照でしかなく、ここが行うのは判定の再計算・対象束縛付きの
 * 充足検証・記録だけである。記録は既存 `audit_log` を使い、テーブルは足さない。
 */

import { randomUUID } from 'node:crypto'
import {
  resolvePlActionPolicy,
  type PlActionKind,
  type PlActionPolicyDecision,
  type PlActionProposal,
  type RequiredGate,
} from '@ai-team/shared'
import type { ApprovalType } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'

/** 監査記録で使う語彙。`audit_log` の既存スキーマをそのまま使う。 */
const AUDIT_OPERATION = 'pl_action_authorize'
const AUDIT_ENTITY_TYPE = 'pl_action'

// ────────────────────────────────────────────────────────────
// 操作対象
// ────────────────────────────────────────────────────────────

/**
 * 操作の対象。**根拠レコードはこの対象に属していなければ充足として数えない。**
 *
 * `job` が `taskId` も持つのは、Job 経由の操作で Task 単位の根拠（Design Review evidence /
 * Approval Request）を引くときに、申告された taskId が本当にその Job のものかを
 * DB 側で照合するためである。
 */
export type PlActionTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'job'; jobId: string; taskId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'system' }

/** 操作種別ごとに要求する対象の種類。ズレていれば通さない。 */
const REQUIRED_TARGET_KIND: Record<PlActionKind, PlActionTarget['kind'] | 'any'> = {
  observe_state: 'any',
  read_logs: 'any',
  read_roadmap: 'any',

  retry_job: 'job',
  resume_task: 'task',
  clear_workspace_quarantine: 'job',
  abort_task: 'task',
  rollback_commit: 'job',

  adopt_roadmap_item: 'project',
  delegate_implementation: 'task',
  propose_code_change: 'task',

  restart_service: 'system',
  deploy_production: 'system',
  switch_provider: 'system',

  // forbidden な種別は対象の検査まで到達しない。
  change_safety_boundary: 'any',
  change_own_permission: 'any',
  override_gate_block: 'any',
  skip_required_review: 'any',
}

/**
 * CEO Approval の scope 束縛。**その操作のために出された承認であることを型で照合する。**
 * Project スコープの照合は `approvals.findById()` が `projectId` を返さないため未実施
 * （モジュール冒頭の「保証しないこと」を参照）。
 */
const REQUIRED_CEO_APPROVAL_TYPE: Partial<Record<PlActionKind, ApprovalType>> = {
  rollback_commit: 'deployment',
  restart_service: 'deployment',
  deploy_production: 'deployment',
  switch_provider: 'external_service',
}

/**
 * 現時点で永続レコードから検証できない Gate。
 *
 * **これらを要求する操作は PL から実行できない。** 「検証手段が無い＝充足しているとみなす」は
 * Gate を無くすのと同じなので fail-closed のままにする。配線は `vps-pl-execution-loop` で行う。
 */
export const UNVERIFIABLE_GATES: readonly RequiredGate[] = Object.freeze([
  'strategic_alignment_review',
  'safety_review',
])

/**
 * 充足の根拠として渡せるもの。**Gate 名そのものは渡せない。**
 * 渡せるのは「どのレコードか」だけで、そのレコードが充足を意味するかどうか、
 * そして**対象に属しているかどうか**は seam が DB を読んで判断する。
 */
export type GateEvidenceRef =
  | { gate: 'design_review'; designReviewEvidenceId: string }
  | { gate: 'independent_review'; designReviewEvidenceId: string }
  | { gate: 'approval_gate'; approvalRequestId: string }
  | { gate: 'ceo_approval'; approvalId: string }

export interface PlActionRequest {
  proposal: PlActionProposal
  target: PlActionTarget
  evidence?: readonly GateEvidenceRef[]
}

/**
 * 必要 Gate が揃っていない状態で実行しようとしたときに投げる。
 *
 * **override 経路は用意しない。** PL が取れるのは fix / re-review / 代替案 / CEO Escalation の
 * 4つだけで、それは `decision.allowedResponsesWhenBlocked` に載っている。
 */
export class PlActionBlockedError extends Error {
  constructor(
    readonly decision: PlActionPolicyDecision,
    readonly missingGates: readonly RequiredGate[],
    readonly rejectedEvidence: readonly string[] = [],
  ) {
    super(
      decision.disposition === 'forbidden'
        ? `[plActionGate] action '${decision.kind}' is not available to PL: ${decision.reasons[0] ?? ''}`
        : `[plActionGate] action '${decision.kind}' still needs: ${missingGates.join(', ')}` +
          (rejectedEvidence.length > 0 ? ` (rejected evidence: ${rejectedEvidence.join('; ')})` : ''),
    )
    this.name = 'PlActionBlockedError'
  }
}

/**
 * 必要 Gate を「見るだけ」。**許可ではない。**
 *
 * CEO への説明や PL の計画立案に使う read-only の導出で、記録もしないし実行権も与えない。
 * 許可を得る手段は `authorizePlAction()` だけである。
 */
export function previewPlActionPolicy(proposal: PlActionProposal): PlActionPolicyDecision {
  return resolvePlActionPolicy(proposal)
}

// ────────────────────────────────────────────────────────────
// 充足検証（対象束縛つき）
// ────────────────────────────────────────────────────────────

interface EvidenceCheck {
  satisfied: boolean
  rejection?: string
}

/**
 * 対象から、根拠を束縛できる範囲を引き出す。
 *
 * `job` では**申告された `taskId` が本当にその Job のものか**を DB で照合する。
 * `system` は束縛できる範囲を持たない（= Task/Project スコープの根拠を受け付けない）。
 */
function resolveEvidenceScope(
  storage: IStorage,
  target: PlActionTarget,
): { taskId?: string; projectId?: string } {
  if (target.kind === 'task') return { taskId: target.taskId }
  if (target.kind === 'project') return { projectId: target.projectId }
  if (target.kind === 'job') {
    const job = storage.jobs.findById(target.jobId)
    if (!job || job.taskId !== target.taskId) return {}
    return { taskId: job.taskId, projectId: job.projectId }
  }
  return {}
}

type EvidenceScope = ReturnType<typeof resolveEvidenceScope>

function checkDesignReview(
  storage: IStorage,
  evidenceId: string,
  scope: EvidenceScope,
  requireIndependent: boolean,
): EvidenceCheck {
  const label = requireIndependent ? 'independent_review' : 'design_review'

  const evidence = storage.designReviewEvidence.findById(evidenceId)
  if (!evidence) {
    return { satisfied: false, rejection: `${label} evidence ${evidenceId} does not exist` }
  }

  // 古い ALIGNED を持ち出して新しい判定を上書きできないよう、その対象の最新 evidence に限る。
  // Task 対象は task-kind、Project 対象は roadmap-kind（`subjectId` が projectId）を見る。
  let latest
  if (scope.taskId !== undefined) {
    // `taskId` 一致だけに頼らない。roadmap-kind の record が `taskId` を持っていた場合に
    // Task 単位の Gate を満たしてしまうため、kind も明示的に照合する。
    if (evidence.reviewKind !== 'task' || evidence.taskId !== scope.taskId) {
      return { satisfied: false, rejection: `${label} evidence ${evidenceId} belongs to another task` }
    }
    latest = storage.designReviewEvidence.findLatestByTaskId(scope.taskId)
  } else if (scope.projectId !== undefined) {
    if (evidence.reviewKind !== 'roadmap' || evidence.subjectId !== scope.projectId) {
      return { satisfied: false, rejection: `${label} evidence ${evidenceId} belongs to another project` }
    }
    latest = storage.designReviewEvidence.findLatestBySubjectId('roadmap', scope.projectId)
  } else {
    // system 対象には Task/Project スコープの Review 根拠を結び付けられない。
    // 「束縛できない＝充足しているとみなす」にはしない（fail-closed）。
    return { satisfied: false, rejection: `${label} evidence cannot be bound to a system-scoped action` }
  }

  if (!latest || latest.id !== evidence.id) {
    return { satisfied: false, rejection: `${label} evidence ${evidenceId} is not the latest for the target` }
  }

  if (requireIndependent) {
    if (!evidence.independentReviewRequired) {
      return { satisfied: false, rejection: `evidence ${evidenceId} did not run an independent review` }
    }
    if (evidence.independentReviewVerdict !== 'approved') {
      return {
        satisfied: false,
        rejection: `independent review verdict is ${evidence.independentReviewVerdict ?? 'absent'}`,
      }
    }
    return { satisfied: true }
  }

  // ALIGNED 以外（CONFLICT / UNCERTAIN / REVIEW_UNAVAILABLE）は通過ではない。
  if (evidence.decision !== 'ALIGNED') {
    return { satisfied: false, rejection: `design_review evidence ${evidenceId} decided ${evidence.decision}` }
  }
  return { satisfied: true }
}

function checkApprovalGate(
  storage: IStorage,
  approvalRequestId: string,
  scope: EvidenceScope,
): EvidenceCheck {
  const targetTaskId = scope.taskId
  if (targetTaskId === undefined) {
    return { satisfied: false, rejection: 'approval_gate evidence cannot be bound to the action target' }
  }

  const request = storage.approvalRequests.findById(approvalRequestId)
  if (!request) {
    return { satisfied: false, rejection: `approval request ${approvalRequestId} does not exist` }
  }
  if (request.taskId !== targetTaskId) {
    return { satisfied: false, rejection: `approval request ${approvalRequestId} belongs to another task` }
  }
  if (request.status !== 'APPROVED') {
    return { satisfied: false, rejection: `approval request ${approvalRequestId} is ${request.status}` }
  }

  // 壊れた期限値を「未失効」として通さない（NaN <= now は false になるため明示的に弾く）。
  const expiresAtMs = new Date(request.expiresAt).getTime()
  if (!Number.isFinite(expiresAtMs)) {
    return { satisfied: false, rejection: `approval request ${approvalRequestId} has an unreadable expiry` }
  }
  if (expiresAtMs <= Date.now()) {
    return { satisfied: false, rejection: `approval request ${approvalRequestId} has expired` }
  }
  return { satisfied: true }
}

function checkCeoApproval(storage: IStorage, approvalId: string, kind: PlActionKind): EvidenceCheck {
  const approval = storage.approvals.findById(approvalId)
  if (!approval) {
    return { satisfied: false, rejection: `approval ${approvalId} does not exist` }
  }
  if (approval.status !== 'approved') {
    return { satisfied: false, rejection: `approval ${approvalId} is ${approval.status}` }
  }

  const requiredType = REQUIRED_CEO_APPROVAL_TYPE[kind]
  if (requiredType === undefined) {
    // scope を照合できない操作で CEO 承認を要求していたら、それは表の穴である。fail-closed。
    return { satisfied: false, rejection: `no CEO approval scope is defined for ${kind}` }
  }
  if (approval.type !== requiredType) {
    return {
      satisfied: false,
      rejection: `approval ${approvalId} is a '${approval.type}' approval, not '${requiredType}'`,
    }
  }
  return { satisfied: true }
}

function verifyEvidence(
  storage: IStorage,
  ref: GateEvidenceRef,
  kind: PlActionKind,
  scope: EvidenceScope,
): EvidenceCheck {
  switch (ref.gate) {
    case 'design_review':
      return checkDesignReview(storage, ref.designReviewEvidenceId, scope, false)
    case 'independent_review':
      return checkDesignReview(storage, ref.designReviewEvidenceId, scope, true)
    case 'approval_gate':
      return checkApprovalGate(storage, ref.approvalRequestId, scope)
    case 'ceo_approval':
      return checkCeoApproval(storage, ref.approvalId, kind)
    default: {
      const unknown = ref as { gate?: unknown }
      return { satisfied: false, rejection: `unknown gate evidence kind: ${String(unknown.gate)}` }
    }
  }
}

/**
 * その対象に対して**そもそも根拠を結び付けられない** Gate を返す。
 *
 * 独立レビュー3巡目（2026-09-14）の指摘: 対象種別を固定したことで、`deploy_production` が
 * `system` 対象なのに Task スコープの `independent_review` を要求し、**永久に充足不能**に
 * なっていた。fail-closed なので危険ではないが、「根拠を積めば通るはず」という誤解を招く。
 *
 * 通らない理由を黙って missing に紛れ込ませず、**構造的に結び付けられない**と明示する。
 * 解消は `vps-pl-execution-loop` の配線側で deploy スコープの Review 根拠を用意することによる。
 */
function unbindableGates(
  requiredGates: readonly RequiredGate[],
  scope: EvidenceScope,
): RequiredGate[] {
  const unbindable: RequiredGate[] = []
  for (const gate of requiredGates) {
    if ((gate === 'design_review' || gate === 'independent_review') &&
        scope.taskId === undefined && scope.projectId === undefined) {
      unbindable.push(gate)
    }
    if (gate === 'approval_gate' && scope.taskId === undefined) {
      unbindable.push(gate)
    }
  }
  return unbindable
}

// ────────────────────────────────────────────────────────────
// 唯一の許可経路
// ────────────────────────────────────────────────────────────

export interface PlActionAuthorization {
  /** seam が再計算した判定。 */
  decision: PlActionPolicyDecision
  /** 監査記録の entityId。 */
  actionId: string
}

/**
 * PL の操作案を判定し、対象束縛つきで必要 Gate の充足を検証し、結果を `audit_log` へ記録する。
 *
 * **許可を得る手段はこれ一つだけ**である。判定と充足検証を分けると「認可した提案」と
 * 「検証した提案」がズレる隙間ができるため、意図的に一つの呼び出しに閉じている。
 *
 * **結果によらず必ず記録する。** blocked だけを記録すると「何回この境界を通ったか」が分からず、
 * 境界が効いているのかを後から検証できない（Design Philosophy 8: 効果検証可能性）。
 *
 * @throws PlActionBlockedError forbidden な操作、対象種別が合わない操作、
 *   または必要 Gate が実データで揃っていないとき
 */
export function authorizePlAction(
  storage: IStorage,
  request: PlActionRequest,
): PlActionAuthorization {
  // 呼び出し側が持ってきた判定は受け取らない。必ず提案から作り直す。
  const decision = resolvePlActionPolicy(request.proposal)
  const actionId = randomUUID()

  const record = (result: string, detail: string): void => {
    storage.auditLog.record({
      actor: 'api',
      operation: AUDIT_OPERATION,
      entityType: AUDIT_ENTITY_TYPE,
      entityId: actionId,
      result,
      // 秘密情報・長大な payload を載せない。kind と Gate 名と policy 版だけで足りる。
      detail,
    })
  }

  if (decision.disposition === 'forbidden') {
    record('forbidden', `kind=${decision.kind} policy=${decision.policyVersion}`)
    throw new PlActionBlockedError(decision, [])
  }

  const kind = decision.kind as PlActionKind
  const expectedTargetKind = REQUIRED_TARGET_KIND[kind]
  if (expectedTargetKind !== 'any' && request.target.kind !== expectedTargetKind) {
    record('blocked', `kind=${kind} target_mismatch=${request.target.kind}`)
    throw new PlActionBlockedError(decision, decision.requiredGates, [
      `action ${kind} requires a ${expectedTargetKind} target, got ${request.target.kind}`,
    ])
  }

  const scope = resolveEvidenceScope(storage, request.target)
  const satisfied = new Set<RequiredGate>()
  const rejections: string[] = []

  // 根拠を積む前に、そもそも結び付けられない Gate を名指しする。
  for (const gate of unbindableGates(decision.requiredGates, scope)) {
    rejections.push(`${gate} cannot be bound to a ${request.target.kind} target`)
  }

  for (const ref of request.evidence ?? []) {
    const check = verifyEvidence(storage, ref, kind, scope)
    if (check.satisfied) {
      satisfied.add(ref.gate)
    } else if (check.rejection) {
      rejections.push(check.rejection)
    }
  }

  const missing = decision.requiredGates.filter((gate) => !satisfied.has(gate))
  if (missing.length > 0) {
    record('blocked', `kind=${kind} missing=${missing.join('|')} policy=${decision.policyVersion}`)
    throw new PlActionBlockedError(decision, missing, rejections)
  }

  record(
    'authorized',
    `kind=${kind} gates=${decision.requiredGates.join('|') || 'none'} policy=${decision.policyVersion}`,
  )
  return { decision, actionId }
}
