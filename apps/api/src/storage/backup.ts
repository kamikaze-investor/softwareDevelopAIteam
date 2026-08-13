import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'

export interface BackupVerificationResult {
  ok: boolean
  reason?: string
}

export const CORE_TABLES = ['projects', 'tasks', 'jobs'] as const

const BACKUP_FILE_RE = /^backup-.*\.db$/

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:]/g, '-')
}

function removeIfExists(filePath: string): void {
  rmSync(filePath, { force: true })
}

function removeSidecars(dbPath: string): void {
  removeIfExists(`${dbPath}-wal`)
  removeIfExists(`${dbPath}-shm`)
}

function removeTemporaryBackup(dbPath: string): void {
  removeIfExists(dbPath)
  removeSidecars(dbPath)
}

export function verifyDatabaseFile(dbPath: string): BackupVerificationResult {
  let db: Database.Database | undefined
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const integrity = db.pragma('integrity_check', { simple: true }) as string
    if (integrity !== 'ok') {
      return { ok: false, reason: 'integrity_check failed' }
    }

    const rows = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN (${CORE_TABLES.map(() => '?').join(', ')})
    `).all(...CORE_TABLES) as Array<{ name: string }>
    const existingTables = new Set(rows.map((row) => row.name))
    const missingTables = CORE_TABLES.filter((table) => !existingTables.has(table))

    if (missingTables.length > 0) {
      return { ok: false, reason: `missing core tables: ${missingTables.join(', ')}` }
    }

    return { ok: true }
  } catch {
    return { ok: false, reason: 'database verification failed' }
  } finally {
    db?.close()
  }
}

export async function createVerifiedBackup(
  sourceDbPath: string,
  backupDir: string,
): Promise<{ path: string }> {
  mkdirSync(backupDir, { recursive: true })

  const timestamp = timestampForFileName()
  const uniqueId = randomUUID()
  const temporaryPath = path.join(backupDir, `.tmp-${timestamp}-${uniqueId}.db`)
  const backupPath = path.join(backupDir, `backup-${timestamp}-${uniqueId}.db`)

  let sourceDb: Database.Database | undefined
  try {
    sourceDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true })
    await sourceDb.backup(temporaryPath)
  } catch (err: unknown) {
    removeTemporaryBackup(temporaryPath)
    throw err
  } finally {
    sourceDb?.close()
  }

  try {
    const temporaryDb = new Database(temporaryPath, { readonly: false, fileMustExist: true })
    try {
      temporaryDb.pragma('journal_mode = DELETE')
    } finally {
      temporaryDb.close()
    }
    removeSidecars(temporaryPath)

    const verification = verifyDatabaseFile(temporaryPath)
    if (!verification.ok) {
      throw new Error(`Backup verification failed: ${verification.reason ?? 'unknown reason'}`)
    }

    renameSync(temporaryPath, backupPath)
    removeSidecars(backupPath)
    return { path: backupPath }
  } catch (err: unknown) {
    removeTemporaryBackup(temporaryPath)
    throw err
  }
}

export function rotateBackups(backupDir: string, keep: number): { deleted: string[] } {
  if (!existsSync(backupDir)) {
    return { deleted: [] }
  }

  const normalizedKeep = Math.max(0, Math.trunc(keep))
  const backupFiles = readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_FILE_RE.test(entry.name))
    .map((entry) => path.join(backupDir, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)))

  const deleted: string[] = []
  for (const backupPath of backupFiles.slice(0, Math.max(0, backupFiles.length - normalizedKeep))) {
    rmSync(backupPath, { force: true })
    deleted.push(backupPath)
  }

  return { deleted }
}
