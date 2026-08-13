import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_TABLES, createVerifiedBackup, rotateBackups, verifyDatabaseFile } from './backup'
import { CREATE_TABLES } from './schema'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ai-team-backup-'))
}

function createWalDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(CREATE_TABLES)
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO projects (id, name, goal, design_philosophy, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('project-1', 'Project', 'goal', '[]', 'draft', now, now)
  return db
}

function createCoreDatabase(dbPath: string): void {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  try {
    db.exec(CREATE_TABLES)
  } finally {
    db.close()
  }
}

function createIncompleteDatabase(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)')
  } finally {
    db.close()
  }
}

function formalBackups(backupDir: string): string[] {
  return readdirSync(backupDir).filter((name) => /^backup-.*\.db$/.test(name)).sort()
}

function temporaryBackups(backupDir: string): string[] {
  return readdirSync(backupDir).filter((name) => name.startsWith('.tmp-')).sort()
}

describe('storage backups', () => {
  it('creates and verifies a self-contained backup from a WAL mode database', async () => {
    const workingDir = makeTempDir()
    const sourcePath = path.join(workingDir, 'source.db')
    const backupDir = path.join(workingDir, 'backups')
    const sourceDb = createWalDatabase(sourcePath)

    try {
      expect(existsSync(`${sourcePath}-wal`)).toBe(true)

      const result = await createVerifiedBackup(sourcePath, backupDir)

      expect(path.basename(result.path)).toMatch(/^backup-.*\.db$/)
      expect(existsSync(result.path)).toBe(true)
      expect(temporaryBackups(backupDir)).toEqual([])
      expect(existsSync(`${result.path}-wal`)).toBe(false)
      expect(existsSync(`${result.path}-shm`)).toBe(false)
      expect(verifyDatabaseFile(result.path)).toEqual({ ok: true })

      const backupDb = new Database(result.path, { readonly: true, fileMustExist: true })
      try {
        const rows = backupDb.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name IN (${CORE_TABLES.map(() => '?').join(', ')})
        `).all(...CORE_TABLES) as Array<{ name: string }>

        expect(new Set(rows.map((row) => row.name))).toEqual(new Set(CORE_TABLES))
      } finally {
        backupDb.close()
      }
    } finally {
      sourceDb.close()
    }
  })

  it('removes only the temporary file when verification fails', async () => {
    const workingDir = makeTempDir()
    const backupDir = path.join(workingDir, 'backups')
    const sourcePath = path.join(workingDir, 'incomplete.db')
    const existingBackupPath = path.join(backupDir, 'backup-2026-01-01T00-00-00.000Z.db')
    createIncompleteDatabase(sourcePath)
    createCoreDatabase(existingBackupPath)

    await expect(createVerifiedBackup(sourcePath, backupDir)).rejects.toThrow('Backup verification failed')

    expect(existsSync(existingBackupPath)).toBe(true)
    expect(formalBackups(backupDir)).toEqual([path.basename(existingBackupPath)])
    expect(temporaryBackups(backupDir)).toEqual([])
  })

  it('does not rotate when there are 28 or fewer formal backups', () => {
    const backupDir = makeTempDir()
    for (let index = 1; index <= 28; index += 1) {
      writeFileSync(path.join(backupDir, `backup-2026-01-${String(index).padStart(2, '0')}T00-00-00.000Z.db`), '')
    }

    const result = rotateBackups(backupDir, 28)

    expect(result.deleted).toEqual([])
    expect(formalBackups(backupDir)).toHaveLength(28)
  })

  it('rotates only the oldest formal backup when more than 28 exist', () => {
    const backupDir = makeTempDir()
    const oldest = 'backup-2026-01-01T00-00-00.000Z.db'
    for (let index = 1; index <= 29; index += 1) {
      writeFileSync(path.join(backupDir, `backup-2026-01-${String(index).padStart(2, '0')}T00-00-00.000Z.db`), '')
    }
    writeFileSync(path.join(backupDir, '.tmp-2025-01-01T00-00-00.000Z.db'), '')

    const result = rotateBackups(backupDir, 28)

    expect(result.deleted.map((filePath) => path.basename(filePath))).toEqual([oldest])
    expect(existsSync(path.join(backupDir, oldest))).toBe(false)
    expect(existsSync(path.join(backupDir, '.tmp-2025-01-01T00-00-00.000Z.db'))).toBe(true)
    expect(formalBackups(backupDir)).toHaveLength(28)
  })

  it('does not count temporary files during rotation', () => {
    const backupDir = makeTempDir()
    for (let index = 1; index <= 28; index += 1) {
      writeFileSync(path.join(backupDir, `backup-2026-02-${String(index).padStart(2, '0')}T00-00-00.000Z.db`), '')
    }
    writeFileSync(path.join(backupDir, '.tmp-2026-03-01T00-00-00.000Z.db'), '')

    const result = rotateBackups(backupDir, 28)

    expect(result.deleted).toEqual([])
    expect(existsSync(path.join(backupDir, '.tmp-2026-03-01T00-00-00.000Z.db'))).toBe(true)
    expect(formalBackups(backupDir)).toHaveLength(28)
  })
})
