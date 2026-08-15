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
})
