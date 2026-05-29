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

import type { SafeCommand, AgentRole } from '@ai-team/shared'
import { AGENT_POLICIES } from '@ai-team/shared'
import { isInsideTargetRoot } from '../utils/pathUtils'

export interface GuardResult {
  allowed: boolean
  reason?: string
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
