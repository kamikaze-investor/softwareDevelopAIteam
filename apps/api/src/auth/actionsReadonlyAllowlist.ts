/**
 * ACTIONS_READONLY credentialが許可されるroute一覧（Default Deny）。
 *
 * 用途は1つだけ: GitHub Actionsが「このcommitはtrusted resulting_commitか？」を
 * 機械検証すること。それ以外のroute・method・書き込みは一切許可しない。
 *
 * 一般的なevidence一覧APIは含めない（全件列挙する必要が無いため）。
 */

export interface ActionsReadonlyAllowlistEntry {
  method: string
  url: string
}

export const ACTIONS_READONLY_ALLOWLIST: readonly ActionsReadonlyAllowlistEntry[] = [
  { method: 'GET', url: '/api/gate-evaluations/verify-commit' },
]

export function isActionsReadonlyRouteAllowed(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (!method || !url) return false
  return ACTIONS_READONLY_ALLOWLIST.some((entry) => entry.method === method && entry.url === url)
}
