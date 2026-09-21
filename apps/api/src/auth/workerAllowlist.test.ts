import { describe, expect, it } from 'vitest'
import { isWorkerRouteAllowed, WORKER_ALLOWLIST } from './workerAllowlist'

describe('isWorkerRouteAllowed', () => {
  it('allowlist内の全経路を許可する', () => {
    for (const entry of WORKER_ALLOWLIST) {
      expect(isWorkerRouteAllowed(entry.method, entry.url)).toBe(true)
    }
  })

  it('methodが一致しない場合は許可しない', () => {
    expect(isWorkerRouteAllowed('POST', '/api/projects')).toBe(false)
  })

  it('urlが一致しない場合は許可しない', () => {
    expect(isWorkerRouteAllowed('GET', '/api/unknown')).toBe(false)
  })

  it('methodまたはurlがundefinedの場合は許可しない（fail-closed）', () => {
    expect(isWorkerRouteAllowed(undefined, '/api/projects')).toBe(false)
    expect(isWorkerRouteAllowed('GET', undefined)).toBe(false)
    expect(isWorkerRouteAllowed(undefined, undefined)).toBe(false)
  })

  it('allowlist外の代表的なroute（CEO approval decision）は許可しない', () => {
    expect(isWorkerRouteAllowed('PATCH', '/api/approval-requests/:id/status')).toBe(false)
  })

  it('Task continuation reconcile を許可する（Worker poll cycle が唯一の起動契機）', () => {
    expect(isWorkerRouteAllowed('POST', '/api/task-continuations/reconcile')).toBe(true)
  })

  // 無いと credential split 有効な production で 403 になり、abort_task の
  // 段階操作が第2段へ進めない（Worker の観測報告が唯一の起動契機である）。
  it('abort cleanup の観測報告を許可する', () => {
    expect(isWorkerRouteAllowed('POST', '/api/jobs/:id/abort-cleanup-result')).toBe(true)
  })

  // cutover 事前監査（2026-09-21）で見つかった欠落。Worker は poll cycle ごとに
  // 実際にこの route を叩いているが、allowlist にだけ無かった。
  it('supervised run reconcile を許可する（Worker poll cycle が既存の起動契機）', () => {
    expect(isWorkerRouteAllowed('POST', '/api/supervised-runs/reconcile')).toBe(true)
  })

  // **広げたのは1 entry だけ**であることを固定する。method 違いまで通る実装にしない。
  it('同じ path でも POST 以外は許可しない', () => {
    expect(isWorkerRouteAllowed('GET', '/api/supervised-runs/reconcile')).toBe(false)
    expect(isWorkerRouteAllowed('PATCH', '/api/supervised-runs/reconcile')).toBe(false)
  })

  // 前方一致・部分一致で広がっていないこと。
  it('supervised-runs の他の path は許可しない', () => {
    expect(isWorkerRouteAllowed('POST', '/api/supervised-runs')).toBe(false)
    expect(isWorkerRouteAllowed('POST', '/api/supervised-runs/reconcile/extra')).toBe(false)
  })
})
