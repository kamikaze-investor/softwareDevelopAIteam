/**
 * PL Action Gate — PL の操作案を必ず既存 Gate へルーティングするための enforcement seam。
 *
 * `resolvePlActionPolicy()`（`@ai-team/shared`）が「どの Gate が必要か」を決める純粋関数で、
 * ここはその結果を **記録し、必要 Gate が実データで揃うまで実行を許さない**境界である。
 *
 * ## 設計の中心: 呼び出し側から渡されたものを信じない
 *
 * 独立レビュー（OpenAI / Codex, 2026-09-14）の指摘で最も重いのはここだった。
 * 当初の実装は「判定結果オブジェクト」と「充足済み Gate の文字列配列」を引数で受け取っていた。
 * PL ループは外部プロセス（LLM + provider CLI）であり、どちらも PL が作れる。
 * つまり **Policy Engine を置いても、seam が PL の作った値を信じるなら境界は存在しない**。
 *
 * そこで本 seam は:
 *
 * 1. **判定を必ず再計算する**（`recomputeDecision()` が runner の `finalDecision` を採用せず
 *    API 側で再計算するのと同じ理由・同じ形）。呼び出し側の判定結果は受け取らない。
 * 2. **充足の根拠を DB の実レコードで検証する**。文字列 `'ceo_approval'` を渡せば通る、
 *    という経路を作らない。渡せるのは「どのレコードか」だけで、状態の解釈は seam が行う。
 * 3. **検証手段の無い Gate は充足できない**（fail-closed）。Strategic/Alignment Review と
 *    Safety Review は現時点で参照できる永続レコードが無いため、それを要求する操作は
 *    PL からは実行できない。配線が入るまで実行できないのが正しい。
 *
 * ## 新しい Gate は作っていない
 *
 * `requiredGates` は既存工程（Strategic/Alignment Review・Design Review・Safety Review・
 * Independent Review・Approval Gate・CEO Approval）への参照でしかなく、ここが行うのは
 * 判定の再計算・記録・充足検証だけである。記録は既存 `audit_log` を使い、テーブルは足さない。
 */

import { randomUUID } from 'node:crypto'
import {
  resolvePlActionPolicy,
  type PlActionPolicyDecision,
  type PlActionProposal,
  type RequiredGate,
} from '@ai-team/shared'
import type { IStorage } from '../storage/interface'

/** 監査記録で使う語彙。`audit_log` の既存スキーマをそのまま使う。 */
const AUDIT_OPERATION = 'pl_action_policy'
const AUDIT_EXECUTE_OPERATION = 'pl_action_execute'
const AUDIT_ENTITY_TYPE = 'pl_action'

/**
 * 充足の根拠として渡せるもの。**Gate 名そのものは渡せない。**
 * 渡せるのは「どのレコードを根拠にするか」だけで、そのレコードが充足を意味するかどうかは
 * seam が DB を読んで判断する。
 */
export type GateEvidenceRef =
  | { gate: 'design_review'; designReviewEvidenceId: string }
  | { gate: 'independent_review'; designReviewEvidenceId: string }
  | { gate: 'approval_gate'; approvalRequestId: string }
  | { gate: 'ceo_approval'; approvalId: string }

/**
 * 現時点で永続レコードから検証できない Gate。
 *
 * **これらを要求する操作は PL から実行できない。** 「検証手段が無い＝充足しているとみなす」は
 * Gate を無くすのと同じなので、fail-closed のままにする。
 * 配線は `vps-pl-execution-loop` の受入条件として扱う。
 */
export const UNVERIFIABLE_GATES: readonly RequiredGate[] = Object.freeze([
  'strategic_alignment_review',
  'safety_review',
])

export interface PlActionAuthorization {
  /** seam が再計算した判定。呼び出し側はこれを書き換えても意味を持たない（実行時に再計算する）。 */
  decision: PlActionPolicyDecision
  /** 監査記録の entityId。 */
  actionId: string
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
 * PL の操作案を判定し、結果を `audit_log` へ記録する。
 *
 * **判定の成否によらず必ず記録する。** forbidden だけを記録すると「何回この境界を通ったか」が
 * 分からず、境界が効いているのかを後から検証できない（Design Philosophy 8: 効果検証可能性）。
 *
 * この関数は**実行を許可しない**。実行可否は `assertPlActionExecutable()` が
 * 提案から判定を作り直したうえで決める。
 */
export function authorizePlAction(
  storage: IStorage,
  proposal: PlActionProposal,
  options: { targetId?: string } = {},
): PlActionAuthorization {
  const decision = resolvePlActionPolicy(proposal)
  const actionId = options.targetId ?? randomUUID()

  storage.auditLog.record({
    actor: 'api',
    operation: AUDIT_OPERATION,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: actionId,
    result: decision.disposition,
    // 秘密情報・長大な payload を載せない。kind と Gate 名と policy 版だけで足りる。
    detail: `kind=${decision.kind} gates=${decision.requiredGates.join('|') || 'none'} policy=${decision.policyVersion}`,
  })

  return { decision, actionId }
}

// ────────────────────────────────────────────────────────────
// 充足検証
// ────────────────────────────────────────────────────────────

interface EvidenceCheck {
  satisfied: boolean
  rejection?: string
}

function checkDesignReview(storage: IStorage, evidenceId: string): EvidenceCheck {
  const evidence = storage.designReviewEvidence.findById(evidenceId)
  if (!evidence) {
    return { satisfied: false, rejection: `design_review evidence ${evidenceId} does not exist` }
  }
  // ALIGNED 以外（CONFLICT / UNCERTAIN / REVIEW_UNAVAILABLE）は通過ではない。
  if (evidence.decision !== 'ALIGNED') {
    return {
      satisfied: false,
      rejection: `design_review evidence ${evidenceId} decided ${evidence.decision}`,
    }
  }
  return { satisfied: true }
}

function checkIndependentReview(storage: IStorage, evidenceId: string): EvidenceCheck {
  const evidence = storage.designReviewEvidence.findById(evidenceId)
  if (!evidence) {
    return { satisfied: false, rejection: `independent_review evidence ${evidenceId} does not exist` }
  }
  // 「独立レビューが不要だった」evidence は独立レビューの充足根拠にならない。
  if (!evidence.independentReviewRequired) {
    return {
      satisfied: false,
      rejection: `evidence ${evidenceId} did not run an independent review`,
    }
  }
  if (evidence.independentReviewVerdict !== 'approved') {
    return {
      satisfied: false,
      rejection: `independent review verdict is ${evidence.independentReviewVerdict ?? 'absent'}`,
    }
  }
  return { satisfied: true }
}

function checkApprovalGate(storage: IStorage, approvalRequestId: string, nowMs: number): EvidenceCheck {
  const request = storage.approvalRequests.findById(approvalRequestId)
  if (!request) {
    return { satisfied: false, rejection: `approval request ${approvalRequestId} does not exist` }
  }
  if (request.status !== 'APPROVED') {
    return {
      satisfied: false,
      rejection: `approval request ${approvalRequestId} is ${request.status}`,
    }
  }
  if (new Date(request.expiresAt).getTime() <= nowMs) {
    return { satisfied: false, rejection: `approval request ${approvalRequestId} has expired` }
  }
  return { satisfied: true }
}

function checkCeoApproval(storage: IStorage, approvalId: string): EvidenceCheck {
  const approval = storage.approvals.findById(approvalId)
  if (!approval) {
    return { satisfied: false, rejection: `approval ${approvalId} does not exist` }
  }
  if (approval.status !== 'approved') {
    return { satisfied: false, rejection: `approval ${approvalId} is ${approval.status}` }
  }
  return { satisfied: true }
}

function verifyEvidence(storage: IStorage, ref: GateEvidenceRef, nowMs: number): EvidenceCheck {
  switch (ref.gate) {
    case 'design_review':
      return checkDesignReview(storage, ref.designReviewEvidenceId)
    case 'independent_review':
      return checkIndependentReview(storage, ref.designReviewEvidenceId)
    case 'approval_gate':
      return checkApprovalGate(storage, ref.approvalRequestId, nowMs)
    case 'ceo_approval':
      return checkCeoApproval(storage, ref.approvalId)
    default: {
      // 未知の gate 名は素通しにしない。
      const unknown = ref as { gate?: unknown }
      return { satisfied: false, rejection: `unknown gate evidence kind: ${String(unknown.gate)}` }
    }
  }
}

/**
 * 実行してよいかを決める。**提案から判定を作り直す**ため、呼び出し側は判定を偽装できない。
 *
 * @param proposal PL の操作案。判定はここから再計算する。
 * @param evidence 充足の根拠レコードへの参照。**Gate 名の羅列ではない。**
 * @returns 再計算した判定（呼び出し側はこれを記録・説明に使える）
 * @throws PlActionBlockedError forbidden な操作、または必要 Gate が実データで揃っていないとき
 */
export function assertPlActionExecutable(
  storage: IStorage,
  proposal: PlActionProposal,
  evidence: readonly GateEvidenceRef[] = [],
  options: { nowMs?: number; actionId?: string } = {},
): PlActionPolicyDecision {
  // 呼び出し側が持ってきた判定は受け取らない。必ず作り直す。
  const decision = resolvePlActionPolicy(proposal)
  const nowMs = options.nowMs ?? Date.now()

  const recordAttempt = (result: string, detail: string): void => {
    if (options.actionId === undefined) return
    storage.auditLog.record({
      actor: 'api',
      operation: AUDIT_EXECUTE_OPERATION,
      entityType: AUDIT_ENTITY_TYPE,
      entityId: options.actionId,
      result,
      detail,
    })
  }

  if (decision.disposition === 'forbidden') {
    recordAttempt('forbidden', `kind=${decision.kind}`)
    throw new PlActionBlockedError(decision, [])
  }

  const satisfied = new Set<RequiredGate>()
  const rejections: string[] = []

  for (const ref of evidence) {
    const check = verifyEvidence(storage, ref, nowMs)
    if (check.satisfied) {
      satisfied.add(ref.gate)
    } else if (check.rejection) {
      rejections.push(check.rejection)
    }
  }

  const missing = decision.requiredGates.filter((gate) => !satisfied.has(gate))

  if (missing.length > 0) {
    recordAttempt('blocked', `kind=${decision.kind} missing=${missing.join('|')}`)
    throw new PlActionBlockedError(decision, missing, rejections)
  }

  recordAttempt('executable', `kind=${decision.kind} gates=${decision.requiredGates.join('|') || 'none'}`)
  return decision
}
