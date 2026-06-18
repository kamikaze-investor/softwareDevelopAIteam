/**
 * Permission Guard
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * SafeCommandを受け取り、実行可否を判定する。
 * AIは CommandKind を選ぶだけ。
 * コマンド文字列への変換は commandResolver.ts が行う。
 *
 * レビュー指摘(2026-05-28):
 * - command: string はコマンドインジェクションのリスクがある
 * - SafeCommand(CommandKind)方式に完全移行
 * - workingDirはrealpath正規化で traversal を防ぐ
 */

import type { SafeCommand, AgentRole, PermissionGrant, PermissionBlockEvent } from '@ai-team/shared'
import { AGENT_POLICIES } from '@ai-team/shared'
import { isInsideTargetRoot } from '../utils/pathUtils'

export interface GrantCheckResult {
  grantId?: string
  grantScope?: string
  expiresAt?: string
}

export interface GuardResult {
  allowed: boolean
  reason?: string
  grant?: GrantCheckResult
  blockEvent?: PermissionBlockEvent
}

export function permissionGuard(
  safeCommand: SafeCommand,
  agentRole: AgentRole
): GuardResult {
  // 1. エージェント権限チェック
  const policy = AGENT_POLICIES[agentRole]
  if (!policy.canExecuteCommands) {
    return {
      allowed: false,
      reason: `Agent ${agentRole} does not have canExecuteCommands permission`,
    }
  }

  // 2. workingDirがTARGET_ROOT配下かをrealpath正規化して検証
  if (!isInsideTargetRoot(safeCommand.workingDir)) {
    return {
      allowed: false,
      reason: `workingDir is outside TARGET_ROOT: "${safeCommand.workingDir}"`,
    }
  }

  // 3. reviewer_ai / qa_aiは実装変更コマンドを実行できない
  if (agentRole === 'reviewer_ai') {
    return {
      allowed: false,
      reason: 'reviewer_ai cannot execute commands (review only)',
    }
  }

  // qa_aiはtest/typecheck/buildのみ許可
  if (agentRole === 'qa_ai') {
    const qaAllowed: SafeCommand['kind'][] = ['typecheck', 'test', 'build', 'lint', 'git_status', 'git_diff']
    if (!qaAllowed.includes(safeCommand.kind)) {
      return {
        allowed: false,
        reason: `qa_ai can only run: ${qaAllowed.join(', ')}. Got: ${safeCommand.kind}`,
      }
    }
  }

  return { allowed: true }
}

/**
 * 動的グラントチェック付き Permission Guard（非同期）
 * 既存の静的ポリシーチェックを先に実行し、その後 API からグラントを取得して追加チェック。
 */
export async function permissionGuardWithGrants(
  safeCommand: SafeCommand,
  agentRole: AgentRole,
  taskId: string,
  jobId: string,
  apiBaseUrl: string,
): Promise<GuardResult> {
  // 1. 既存の静的ポリシーチェックを先に実行
  const staticResult = permissionGuard(safeCommand, agentRole)
  if (!staticResult.allowed) {
    return staticResult
  }

  // 2. API からアクティブなグラントを取得
  let grants: PermissionGrant[] = []
  try {
    const response = await fetch(`${apiBaseUrl}/api/permission-grants?taskId=${encodeURIComponent(taskId)}`)
    if (response.ok) {
      grants = (await response.json()) as PermissionGrant[]
    }
  } catch {
    // ネットワークエラー時は静的ポリシーのデフォルト判定に従う
    return { allowed: true }
  }

  // 3. commandKind と agentRole が一致するグラントを探す
  const matchingGrant = grants.find((g) => {
    if (g.agentRole !== agentRole) return false
    if (g.allowedCommandKinds && g.allowedCommandKinds.length > 0) {
      return g.allowedCommandKinds.includes(safeCommand.kind)
    }
    return true // allowedCommandKinds が空 = 全コマンド許可
  })

  // 4. グラントがない → 静的ポリシーのデフォルト判定（現状維持）
  if (!matchingGrant) {
    return { allowed: true }
  }

  // 5. グラントあり → 有効期限チェック
  if (matchingGrant.expiresAt && new Date(matchingGrant.expiresAt) <= new Date()) {
    const blockEvent: PermissionBlockEvent = {
      type: 'grant_expired',
      jobId,
      taskId,
      agentRole,
      commandKind: safeCommand.kind,
      message: `Grant ${matchingGrant.id} has expired at ${matchingGrant.expiresAt}`,
      occurredAt: new Date().toISOString(),
    }
    return { allowed: false, reason: blockEvent.message, blockEvent }
  }

  // scope='once' かつ used=true → ブロック
  if (matchingGrant.scope === 'once' && matchingGrant.used) {
    const blockEvent: PermissionBlockEvent = {
      type: 'grant_used',
      jobId,
      taskId,
      agentRole,
      commandKind: safeCommand.kind,
      message: `Grant ${matchingGrant.id} has already been used`,
      occurredAt: new Date().toISOString(),
    }
    return { allowed: false, reason: blockEvent.message, blockEvent }
  }

  // 6. scope='once' の場合は markUsed を呼ぶ
  if (matchingGrant.scope === 'once') {
    try {
      await fetch(`${apiBaseUrl}/api/permission-grants/${matchingGrant.id}/use`, {
        method: 'PATCH',
      })
    } catch {
      // markUsed 失敗は無視して実行を許可
    }
  }

  return {
    allowed: true,
    grant: {
      grantId: matchingGrant.id,
      grantScope: matchingGrant.scope,
      expiresAt: matchingGrant.expiresAt,
    },
  }
}
