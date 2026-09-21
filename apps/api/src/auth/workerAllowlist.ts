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
  { method: 'PATCH', url: '/api/jobs/:id/clear-quarantine' },
  // abort_task の cleanup は Worker の観測報告が唯一の起動契機である。
  // これが無いと credential split 有効な production では 403 になり、
  // 段階操作が第2段へ進めないまま Task が永久に park されない。
  { method: 'POST', url: '/api/jobs/:id/abort-cleanup-result' },
  { method: 'GET', url: '/api/permission-grants' },
  { method: 'PATCH', url: '/api/permission-grants/:id/use' },
  { method: 'POST', url: '/api/gate/check' },
  { method: 'POST', url: '/api/approval-requests/:id/consume' },
  { method: 'POST', url: '/api/watchdog-events' },
  { method: 'PATCH', url: '/api/watchdog-events/:id' },
  // Task continuation の回収は Worker の poll cycle が唯一の起動契機であり、
  // これが無いと production（credential split 有効）では 403 になり、
  // continuation が Mobile の GET 副作用でしか進まない状態へ戻る。
  { method: 'POST', url: '/api/task-continuations/reconcile' },
  // supervised run の reconcile も起動契機は Worker の既存 poll cycle だけである。
  // これが無いと credential split 有効時に 403 になり、**呼び出し側は warn して poll を
  // 続けるので Worker は健康に見えたまま** reconcile だけが止まる
  // （runDir → durable state 反映 / 死んだ supervisor の検出 / terminal 後の
  // continuation 起動が進まなくなる）。
  { method: 'POST', url: '/api/supervised-runs/reconcile' },
]

export function isWorkerRouteAllowed(method: string | undefined, url: string | undefined): boolean {
  if (!method || !url) return false
  return WORKER_ALLOWLIST.some((entry) => entry.method === method && entry.url === url)
}
