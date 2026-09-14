/**
 * PL Action Gate — PL の操作案を必ず既存 Gate へルーティングするための enforcement seam。
 *
 * `resolvePlActionPolicy()`（`@ai-team/shared`）が「どの Gate が必要か」を決める純粋関数で、
 * ここはその結果を **記録し、必要 Gate が揃うまで実行を許さない**境界である。
 *
 * ## なぜ seam を分けるか
 *
 * PL 実行ループ（`vps-pl-execution-loop`）はまだ存在しない。ループを作ってから境界を足すと、
 * 「とりあえず動かす」経路が先に生まれて後から塞ぐことになる。CEO 指示の順序（強制境界 →
 * PL 判断）に従い、**ループが通る唯一の入口を先に置く**。
 *
 * ## 新しい Gate は作っていない
 *
 * `requiredGates` は既存工程（Strategic/Alignment Review・Design Review・Safety Review・
 * Independent Review・Approval Gate・CEO Approval）への参照でしかない。ここが行うのは
 * 判定結果の記録と、充足チェックだけである。
 *
 * ## satisfiedGates は PL の自己申告であってはならない
 *
 * `assertPlActionExecutable()` に渡す充足済み Gate は、**システム側が観測した根拠**
 * （design review evidence・approval request の status・gate evaluation 等）から組み立てること。
 * PL の出力をそのまま渡すと、Policy Engine を置いた意味が消える。
 */

import { randomUUID } from 'node:crypto'
import {
  resolvePlActionPolicy,
  type PlActionPolicyDecision,
  type PlActionProposal,
  type RequiredGate,
} from '@ai-team/shared'
import type { IStorage } from '../storage/interface'

/** 監査記録で使う語彙。`audit_log` の既存スキーマをそのまま使い、テーブルは足さない。 */
const AUDIT_OPERATION = 'pl_action_policy'
const AUDIT_ENTITY_TYPE = 'pl_action'

export interface PlActionAuthorization {
  /** 政策判定の結果。PL はこれを書き換えられない。 */
  decision: PlActionPolicyDecision
  /** 監査記録の entityId。後続の Gate 充足記録と突き合わせるための識別子。 */
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
  ) {
    super(
      decision.disposition === 'forbidden'
        ? `[plActionGate] action '${decision.kind}' is not available to PL: ${decision.reasons[0] ?? ''}`
        : `[plActionGate] action '${decision.kind}' still needs: ${missingGates.join(', ')}`,
    )
    this.name = 'PlActionBlockedError'
  }
}

/**
 * PL の操作案を判定し、結果を `audit_log` へ記録する。
 *
 * **判定の成否によらず必ず記録する。** forbidden だけを記録すると「何回 Gate を通ったか」が
 * 分からず、この境界が効いているのかを後から検証できない（Design Philosophy 8: 効果検証可能性）。
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

/**
 * 必要 Gate が全て揃っているときだけ通す。揃っていなければ投げる。
 *
 * @param satisfiedGates **システムが観測した**充足済み Gate。PL の申告を渡さないこと。
 */
export function assertPlActionExecutable(
  decision: PlActionPolicyDecision,
  satisfiedGates: readonly string[],
): void {
  if (decision.disposition === 'forbidden') {
    throw new PlActionBlockedError(decision, [])
  }

  const satisfied = new Set(satisfiedGates)
  const missing = decision.requiredGates.filter((gate) => !satisfied.has(gate))

  if (missing.length > 0) {
    throw new PlActionBlockedError(decision, missing)
  }
}
