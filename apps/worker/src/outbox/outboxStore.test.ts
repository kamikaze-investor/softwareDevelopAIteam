import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobUpdate } from '../index.js'

interface PendingOutboxRow {
  job_id: string
  event_id: string
  payload_hash: string
  payload_json: string
  created_at: string
}

let tempRoot: string
let cwdSpy: { mockRestore: () => void }

async function loadStore(): Promise<typeof import('./outboxStore.js')> {
  vi.resetModules()
  return await import('./outboxStore.js')
}

function readRows(): PendingOutboxRow[] {
  const db = new Database(path.join(tempRoot, 'data', 'outbox.db'))
  try {
    return db.prepare(
      'SELECT * FROM pending_outbox_events ORDER BY created_at ASC',
    ).all() as PendingOutboxRow[]
  } finally {
    db.close()
  }
}

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'worker-outbox-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempRoot)
})

afterEach(() => {
  cwdSpy.mockRestore()
  vi.resetModules()
})

describe('outboxStore', () => {
  it('records a pending event', async () => {
    const store = await loadStore()
    const payload: JobUpdate = { status: 'success', exitCode: 0 }

    const result = store.recordPending('job-record', payload)

    expect(result.eventId).toBeTruthy()
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/)
    expect(store.hasPending()).toBe(true)
    const rows = readRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      job_id: 'job-record',
      event_id: result.eventId,
      payload_hash: result.payloadHash,
      payload_json: JSON.stringify(payload),
    })
  })

  it('reuses the same event for the same jobId and same payload', async () => {
    const store = await loadStore()
    const payload: JobUpdate = { status: 'failed', stderr: 'failed' }

    const first = store.recordPending('job-reuse', payload)
    const second = store.recordPending('job-reuse', { stderr: 'failed', status: 'failed' })

    expect(second).toEqual(first)
    expect(readRows()).toHaveLength(1)
  })

  it('throws for the same jobId with a different payload', async () => {
    const store = await loadStore()

    store.recordPending('job-conflict', { status: 'success' })

    expect(() => store.recordPending('job-conflict', { status: 'failed' }))
      .toThrow(/hash mismatch/)
    expect(readRows()).toHaveLength(1)
  })

  it('deletes a pending event', async () => {
    const store = await loadStore()

    store.recordPending('job-delete', { status: 'success' })
    store.deletePending('job-delete')

    expect(store.hasPending()).toBe(false)
    expect(readRows()).toHaveLength(0)
  })

  it('resends saved payload with the stored event metadata and deletes on ACK', async () => {
    const store = await loadStore()
    const payload: JobUpdate = {
      status: 'success',
      changedFiles: ['src/feature.ts'],
      guardResult: { permissionAllowed: true, fileChangeAllowed: true },
    }
    const event = store.recordPending('job-resend', payload)
    const patchFn = vi.fn().mockResolvedValue(true)

    await store.resendPending(patchFn)

    expect(patchFn).toHaveBeenCalledWith('job-resend', {
      ...payload,
      eventId: event.eventId,
      payloadHash: event.payloadHash,
    })
    expect(store.hasPending()).toBe(false)
  })

  it('keeps pending events when resend is not acknowledged', async () => {
    const store = await loadStore()
    store.recordPending('job-still-pending', { status: 'success' })

    await store.resendPending(vi.fn().mockResolvedValue(false))

    expect(store.hasPending()).toBe(true)
    expect(readRows()).toHaveLength(1)
  })
})
