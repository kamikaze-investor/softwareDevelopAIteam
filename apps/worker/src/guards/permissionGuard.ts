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
import { buildApiAuthHeaders } from '../utils/apiAuth.js'

/** 権限 API 呼び出しの上限時間。無期限待機で Job がハングするのを防ぐ */
const FETCH_TIMEOUT_MS = 10_000

// AgentRole の有効値は既存 AGENT_POLICIES（@ai-team/shared）のキー集合をそのまま使う。
// 値一覧を新たに定義・重複させない。
const VALID_AGENT_ROLES: ReadonlySet<string> = new Set(Object.keys(AGENT_POLICIES))

// GrantScope（@ai-team/shared の型 'once' | 'task' | 'permanent'）はランタイム定数が
// 存在しないため、ここで唯一の定義として持つ（他ファイルへ複製しない）。
const VALID_GRANT_SCOPES: ReadonlySet<string> = new Set(['once', 'task', 'permanent'])

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
  /**
   * 権限を判定できなかった**技術障害**（API疎通不可・認証失敗・タイムアウト・
   * 不正レスポンス）であることを示す。「権限が無い」という判定結果とは別物。
   *
   * 呼び出し元（jobRunner）はこれを承認・手動 resume 待ちの `blocked` へ流さず、
   * `failed` で停止する。技術障害を CEO 承認待ちと混同しないため。
   */
  technicalFailure?: boolean
}

/** 権限を判定できなかった技術障害。権限の拒否ではない */
function technicalFailure(reason: string): GuardResult {
  return { allowed: false, technicalFailure: true, reason }
}

/**
 * fetch/parse エラーを固定分類へ変換する。
 *
 * 【2026-08-01 追加】`err.message` をそのまま reason へ入れると、JSON parse
 * 例外のメッセージに応答本文の断片が含まれる場合がある（V8 は SyntaxError に
 * 入力の先頭を含める）。API 応答本文・Authorization header・token を
 * reason/ログ/通知へ一切含めないため、固定文字列だけを使う。
 */
function classifyFetchError(err: unknown): 'timeout' | 'network_error' | 'invalid_json' {
  if (err instanceof Error && err.name === 'AbortError') return 'timeout'
  if (err instanceof SyntaxError) return 'invalid_json'
  return 'network_error'
}

/**
 * PermissionGrant として最小限有効かを局所的に検証する。
 *
 * `res.json()` が成功しただけで型 cast すると、API が別形式（エラー object 等）を
 * 200 で返した場合に「グラント無し」として素通りしてしまう。
 * 判定に実際に使うフィールドだけを検査する（共通 schema 基盤は作らない）。
 *
 * 【2026-08-01 強化】`agentRole`/`scope` は「文字列であること」だけでなく
 * 既知の有効値であることまで確認する。そうしないと、壊れた・想定外の
 * レスポンス（例: `scope:"invalid-scope"`）でもグラントとして受理され、
 * 「200 だがレスポンス形式が不正」の fail-open が残ってしまう。
 */
function isPermissionGrant(value: unknown): value is PermissionGrant {
  if (typeof value !== 'object' || value === null) return false
  const g = value as Record<string, unknown>
  return typeof g.id === 'string'
    && typeof g.agentRole === 'string' && VALID_AGENT_ROLES.has(g.agentRole)
    && typeof g.scope === 'string' && VALID_GRANT_SCOPES.has(g.scope)
    && typeof g.used === 'boolean'
}

function isPermissionGrantArray(value: unknown): value is PermissionGrant[] {
  return Array.isArray(value) && value.every(isPermissionGrant)
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

  // 2. API からアクティブなグラントを取得する。
  //
  // 【fail-closed（2026-08-01）】以前はネットワークエラーで `{allowed:true}` を返し、
  // さらに `!response.ok`（401 等）でも grants=[] のまま「グラント無し」の
  // デフォルト許可へ合流していた。認証エラー・API 停止がそのまま実行許可に
  // なっていたため、**明確な成功（HTTP 200 + JSON parse 成功 + 期待形式）**の
  // ときだけ grant 照合へ進み、それ以外は全て技術障害として停止する。
  const grantsResult = await fetchActiveGrants(apiBaseUrl, taskId)
  if ('failure' in grantsResult) return grantsResult.failure
  const grants = grantsResult.grants

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

  // 6. scope='once' の場合は markUsed を呼ぶ。
  //
  // 【fail-closed（2026-08-01）】以前は markUsed の失敗を握りつぶして実行を許可していた。
  // 使用済み記録が残らないまま Job を進めると、同じ once グラントが後続 Job でも
  // 有効なまま再利用できてしまい「1回限り」の保証が壊れる。
  // 記録の成功を確認できない場合は技術障害として停止する。
  if (matchingGrant.scope === 'once') {
    const markFailure = await markGrantUsed(apiBaseUrl, matchingGrant.id)
    if (markFailure) return markFailure
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

// ────────────────────────────────────────────────────────────
// 権限 API 呼び出し（明確な成功だけを成功として扱う）
// ────────────────────────────────────────────────────────────

/**
 * GET /api/permission-grants?taskId=... を呼び、有効なグラント配列を取得する。
 *
 * 実 route 契約（`apps/api/src/routes/permissionGrants.ts`）: 200（配列。空配列も正常）
 * / 400（taskId 欠落）。404・409 は定義されていない。
 * よって 200 以外は全て技術障害として扱う（将来 403 / 429 が追加されても
 * 自動的に安全側へ倒れる）。
 *
 * 【2026-08-01】timeout は HTTP header 受信だけでなく、本文読み取り・JSON parse・
 * schema 検証が終わるまで有効にする（`finally` で確実に解除する）。
 * 以前は header 受信直後に `clearTimeout` していたため、本文の読み取りが
 * ハングしても 10 秒 timeout が効かなかった。
 */
async function fetchActiveGrants(
  apiBaseUrl: string,
  taskId: string,
): Promise<{ grants: PermissionGrant[] } | { failure: GuardResult }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    let response: Response
    try {
      response = await fetch(
        `${apiBaseUrl}/api/permission-grants?taskId=${encodeURIComponent(taskId)}`,
        { headers: buildApiAuthHeaders(), signal: controller.signal },
      )
    } catch (err) {
      return { failure: technicalFailure(`permission-grants: ${classifyFetchError(err)}`) }
    }

    if (response.status !== 200) {
      return { failure: technicalFailure(`permission-grants: HTTP ${response.status}`) }
    }

    let body: unknown
    try {
      body = await response.json()
    } catch (err) {
      // header 受信後、本文読み取り中に abort した場合も含めて timeout と区別する
      return { failure: technicalFailure(`permission-grants: ${classifyFetchError(err)}`) }
    }

    if (!isPermissionGrantArray(body)) {
      return { failure: technicalFailure('permission-grants: invalid response (unexpected shape)') }
    }

    return { grants: body }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * PATCH /api/permission-grants/:id/use を呼び、使用済み記録の成功を確認する。
 *
 * 実 route 契約: 200（更新後の grant）/ 404（grant 不存在）。
 * 404 も含め、記録できなかった場合は全て技術障害として扱う
 * （once グラントを消費できていない状態で Job を進めない）。
 *
 * 【2026-08-01】200 が返っても「本当にこの grant が使用済みになったか」まで
 * 確認する（`response.id === grantId && response.used === true`）。
 * 単に `isPermissionGrant()` を満たすだけでは、別の grant や `used:false` の
 * ままの応答でも成功扱いになってしまう（once グラントの使い切り保証が壊れる）。
 * timeout は本文検証まで含めて finally で解除する（GET と同じ理由）。
 *
 * @returns 失敗時のみ GuardResult を返す。成功時は undefined。
 */
async function markGrantUsed(apiBaseUrl: string, grantId: string): Promise<GuardResult | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    let response: Response
    try {
      response = await fetch(
        `${apiBaseUrl}/api/permission-grants/${encodeURIComponent(grantId)}/use`,
        { method: 'PATCH', headers: buildApiAuthHeaders(), signal: controller.signal },
      )
    } catch (err) {
      return technicalFailure(`permission-grants/use: ${classifyFetchError(err)}`)
    }

    if (response.status !== 200) {
      return technicalFailure(`permission-grants/use: HTTP ${response.status}`)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch (err) {
      return technicalFailure(`permission-grants/use: ${classifyFetchError(err)}`)
    }

    if (!isPermissionGrant(body) || body.id !== grantId || body.used !== true) {
      return technicalFailure('permission-grants/use: invalid response (mark-used not confirmed)')
    }

    return undefined
  } finally {
    clearTimeout(timer)
  }
}
