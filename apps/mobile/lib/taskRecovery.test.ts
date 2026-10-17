import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RECOVER_ERROR_MESSAGE_FALLBACK } from './resumeErrorMessage'
import { MOBILE_RECOVER_REASON, submitTaskRecovery } from './taskRecovery'

vi.mock('./api', () => ({ apiFetch: vi.fn() }))
const { apiFetch } = await import('./api')
const apiFetchMock = vi.mocked(apiFetch)

function jsonResponse(status: number, body: unknown): Response {
  return { json: async () => body, ok: status >= 200 && status < 300, status } as unknown as Response
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('submitTaskRecovery', () => {
  it('既存の POST /api/tasks/:id/recover を reason だけの body で呼び、200 を成功とする', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, nextDriver: 'attention_only' }))

    await expect(submitTaskRecovery('task 1')).resolves.toEqual({ ok: true })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = apiFetchMock.mock.calls[0] ?? []
    expect(path).toBe('/api/tasks/task%201/recover')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ reason: MOBILE_RECOVER_REASON })
    expect(MOBILE_RECOVER_REASON.length).toBeLessThanOrEqual(400)
  })

  it('409 は code の文言にする', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'x', code: 'TASK_PARKED' }))
    await expect(submitTaskRecovery('t')).resolves.toEqual({
      message: 'このTaskは中止（保留）されているため、復旧できません。',
      ok: false,
    })
  })

  it('JSON でない応答・通信失敗は fallback', async () => {
    apiFetchMock.mockResolvedValueOnce({ json: async () => { throw new Error('no json') }, ok: false, status: 500 } as unknown as Response)
    await expect(submitTaskRecovery('t')).resolves.toEqual({ message: RECOVER_ERROR_MESSAGE_FALLBACK, ok: false })

    apiFetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(submitTaskRecovery('t')).resolves.toEqual({ message: RECOVER_ERROR_MESSAGE_FALLBACK, ok: false })
  })
})
