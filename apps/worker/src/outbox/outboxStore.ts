import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { canonicalizeJobUpdate } from '@ai-team/shared'
import type { JobUpdate } from '../index.js'

interface PendingOutboxRow {
  job_id: string
  event_id: string
  payload_hash: string
  payload_json: string
  created_at: string
}

let db: Database.Database | undefined

function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.resolve(process.cwd(), 'data', 'outbox.db')
    mkdirSync(path.dirname(dbPath), { recursive: true })
    db = new Database(dbPath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_outbox_events (
        job_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
  }

  return db
}

function calculatePayloadHash(payload: JobUpdate): string {
  return createHash('sha256')
    .update(canonicalizeJobUpdate(payload as Record<string, unknown>))
    .digest('hex')
}

export function recordPending(jobId: string, payload: JobUpdate): { eventId: string; payloadHash: string } {
  const payloadHash = calculatePayloadHash(payload)
  const existing = getDb().prepare(
    'SELECT * FROM pending_outbox_events WHERE job_id = ?',
  ).get(jobId) as PendingOutboxRow | undefined

  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw new Error(`Pending outbox event hash mismatch for Job ${jobId}`)
    }
    return { eventId: existing.event_id, payloadHash: existing.payload_hash }
  }

  const eventId = randomUUID()
  getDb().prepare(`
    INSERT INTO pending_outbox_events (job_id, event_id, payload_hash, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(jobId, eventId, payloadHash, JSON.stringify(payload), new Date().toISOString())

  return { eventId, payloadHash }
}

export function deletePending(jobId: string): void {
  getDb().prepare('DELETE FROM pending_outbox_events WHERE job_id = ?').run(jobId)
}

export async function resendPending(
  patchFn: (jobId: string, payload: JobUpdate & { eventId: string; payloadHash: string }) => Promise<boolean>,
): Promise<void> {
  const rows = getDb().prepare(
    'SELECT * FROM pending_outbox_events ORDER BY created_at ASC',
  ).all() as PendingOutboxRow[]

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as JobUpdate
    const persisted = await patchFn(row.job_id, {
      ...payload,
      eventId: row.event_id,
      payloadHash: row.payload_hash,
    })
    if (persisted) {
      deletePending(row.job_id)
    }
  }
}

/** 最古の pending event を記録した時刻（ms）。無い・読めない形なら undefined。 */
export function oldestPendingCreatedAtMs(): number | undefined {
  const row = getDb().prepare('SELECT MIN(created_at) AS oldest FROM pending_outbox_events').get() as { oldest: string | null } | undefined
  if (row?.oldest == null) return undefined
  const ms = Date.parse(row.oldest)
  return Number.isFinite(ms) ? ms : undefined
}

export function hasPending(): boolean {
  const row = getDb().prepare('SELECT 1 FROM pending_outbox_events LIMIT 1').get()
  return row !== undefined
}

/**
 * この Job の terminal update が未配送のまま Outbox に残っているか。
 *
 * startup recovery はこれが true の Job に競合する terminal 遷移（fail-if-running）を作らない。
 * 作ると、後から届く replay（write-once の workspaceEndFingerprint を含む）が API で 409 になり、
 * event が pending のまま残って queued Job intake が止まり続ける（lifecycle repair C2 / H-01）。
 */
export function hasPendingFor(jobId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM pending_outbox_events WHERE job_id = ? LIMIT 1').get(jobId)
  return row !== undefined
}
