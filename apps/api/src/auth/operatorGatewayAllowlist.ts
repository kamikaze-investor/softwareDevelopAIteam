/**
 * OPERATOR_GATEWAY credential が許可される route 一覧（Default Deny）。
 *
 * 外部 Operator（ChatGPT MCP adapter / 将来の Mobile Operator Chat gateway）の権限境界そのもの。
 * 許可するのは次の2種類だけである（CEO 方針・2026-09-28）:
 *
 * 1. **safe read** — `/api/operator/*` の projection 済み GET。既存の GET（`/api/jobs` 等）は
 *    stdout / stderr / prompt をそのまま返すため**載せない**
 * 2. **Operator Request の作成・取得** — 作成は request record の保存だけで、
 *    operational state を変えない
 *
 * Task / Job mutation・resume・approve・ceo_approval・Design Review evidence・quarantine 解除・
 * commit・PL tick・context-pack 等は**1つも載せない**。ここへ entry を足すことは権限境界の変更であり、
 * CEO 判断を要する。
 */

export interface OperatorGatewayAllowlistEntry {
  method: string
  url: string
}

export const OPERATOR_GATEWAY_ALLOWLIST: readonly OperatorGatewayAllowlistEntry[] = [
  // safe read（projection 済み）
  { method: 'GET', url: '/api/operator/state' },
  { method: 'GET', url: '/api/operator/projects/:id' },
  { method: 'GET', url: '/api/operator/tasks' },
  { method: 'GET', url: '/api/operator/tasks/:id' },
  { method: 'GET', url: '/api/operator/pl/triage-summary' },
  // Operator Request（PL への依頼の唯一の入口）
  { method: 'POST', url: '/api/operator-requests' },
  { method: 'GET', url: '/api/operator-requests' },
  { method: 'GET', url: '/api/operator-requests/:id' },
]

export function isOperatorGatewayRouteAllowed(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (!method || !url) return false
  return OPERATOR_GATEWAY_ALLOWLIST.some((entry) => entry.method === method && entry.url === url)
}
