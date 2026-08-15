/**
 * WORKER credentialが許可されるroute一覧（Default Deny）。
 *
 * Worker↔API authority separation（2026-08-15設計）: WorkerはこのallowlistにあるMethod+Route
 * pattern以外は403で拒否される。一覧は実装済みWorker呼び出し経路を読み取り調査した結果のみで
 * 構成し、将来使うかもしれない経路は含めない。
 *
 * pattern（`url`）はFastifyのroute登録パターン（`req.routeOptions.url`。例: `/api/jobs/:id`）と
 * 完全一致で照合する。実URL（パラメータ値・クエリ文字列を含む）とは照合しない。
 */

export interface WorkerAllowlistEntry {
  method: string
  url: string
}

export const WORKER_ALLOWLIST: readonly WorkerAllowlistEntry[] = [
  { method: 'GET', url: '/api/projects' },
  { method: 'GET', url: '/api/tasks' },
  { method: 'GET', url: '/api/jobs' },
  { method: 'PATCH', url: '/api/jobs/:id' },
  { method: 'PATCH', url: '/api/jobs/:id/fail-if-running' },
  { method: 'GET', url: '/api/permission-grants' },
  { method: 'PATCH', url: '/api/permission-grants/:id/use' },
  { method: 'POST', url: '/api/gate/check' },
  { method: 'POST', url: '/api/approval-requests/:id/consume' },
  { method: 'POST', url: '/api/watchdog-events' },
  { method: 'PATCH', url: '/api/watchdog-events/:id' },
]

export function isWorkerRouteAllowed(method: string | undefined, url: string | undefined): boolean {
  if (!method || !url) return false
  return WORKER_ALLOWLIST.some((entry) => entry.method === method && entry.url === url)
}
