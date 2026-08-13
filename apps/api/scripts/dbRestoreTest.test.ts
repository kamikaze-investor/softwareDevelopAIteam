import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVerifiedBackup, verifyDatabaseFile } from '../src/storage/backup'
import { CREATE_TABLES } from '../src/storage/schema'
import { findLatestBackup, performIsolatedRestoreTest, runDbRestoreTest } from './dbRestoreTest'

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_DB_PATH = process.env.DB_PATH
const ORIGINAL_DB_BACKUP_DIR = process.env.DB_BACKUP_DIR

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ai-team-restore-'))
}

function restoreEnv(): void {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
  }

  if (ORIGINAL_DB_PATH === undefined) {
    delete process.env.DB_PATH
  } else {
    process.env.DB_PATH = ORIGINAL_DB_PATH
  }

  if (ORIGINAL_DB_BACKUP_DIR === undefined) {
    delete process.env.DB_BACKUP_DIR
  } else {
    process.env.DB_BACKUP_DIR = ORIGINAL_DB_BACKUP_DIR
  }
}

function createCoreDatabase(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    db.exec(CREATE_TABLES)
  } finally {
    db.close()
  }
}

async function createBackupFixture(workingDir: string): Promise<{ path: string }> {
  const sourcePath = path.join(workingDir, `source-${randomUUID()}.db`)
  const backupDir = path.join(workingDir, 'backups')
  createCoreDatabase(sourcePath)
  return createVerifiedBackup(sourcePath, backupDir)
}

describe('isolated DB restore test', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    delete process.env.NODE_ENV
    delete process.env.DB_PATH
    delete process.env.DB_BACKUP_DIR
  })

  afterEach(() => {
    vi.restoreAllMocks()
    restoreEnv()
  })

  it('runs an isolated restore test from a verified backup', async () => {
    const workingDir = makeTempDir()
    const backup = await createBackupFixture(workingDir)

    expect(verifyDatabaseFile(backup.path)).toEqual({ ok: true })
    expect(() => performIsolatedRestoreTest(backup.path)).not.toThrow()
  })

  it('selects the latest formal backup and ignores temporary files', () => {
    const backupDir = makeTempDir()
    const older = path.join(backupDir, 'backup-2026-01-01T00-00-00.000Z.db')
    const newer = path.join(backupDir, 'backup-2026-01-02T00-00-00.000Z.db')
    const temporary = path.join(backupDir, '.tmp-2026-01-03T00-00-00.000Z.db')
    writeFileSync(older, '')
    writeFileSync(newer, '')
    writeFileSync(temporary, '')

    expect(findLatestBackup(backupDir)).toBe(newer)
  })

  it('does not write to production DB_PATH or change that environment value', async () => {
    const workingDir = makeTempDir()
    const backup = await createBackupFixture(workingDir)
    const productionDbPath = path.join(workingDir, 'production.db')
    createCoreDatabase(productionDbPath)
    const beforeProductionBytes = readFileSync(productionDbPath)

    process.env.NODE_ENV = 'production'
    process.env.DB_PATH = productionDbPath

    const exitCode = await runDbRestoreTest([backup.path], process.env)

    expect(exitCode).toBe(0)
    expect(process.env.DB_PATH).toBe(productionDbPath)
    expect(readFileSync(productionDbPath)).toEqual(beforeProductionBytes)
    expect(existsSync(productionDbPath)).toBe(true)
  })
})
