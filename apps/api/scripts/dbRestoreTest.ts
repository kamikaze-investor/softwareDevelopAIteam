import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyDatabaseFile } from '../src/storage/backup'

const BACKUP_FILE_RE = /^backup-.*\.db$/

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:]/g, '-')
}

export function findLatestBackup(backupDir: string): string | undefined {
  if (!existsSync(backupDir)) return undefined

  const backupFiles = readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  const latest = backupFiles.at(-1)
  return latest ? path.join(backupDir, latest) : undefined
}

export function resolveRestoreBackupPath(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitBackupPath = argv[0]
  if (explicitBackupPath !== undefined && explicitBackupPath !== '') {
    return explicitBackupPath
  }

  const backupDir = env.DB_BACKUP_DIR
  if (backupDir === undefined || backupDir === '') {
    throw new Error('DB_BACKUP_DIR must be configured when no backup file is provided')
  }

  const latestBackup = findLatestBackup(backupDir)
  if (!latestBackup) {
    throw new Error('No formal backup files found')
  }

  return latestBackup
}

export function performIsolatedRestoreTest(backupPath: string): void {
  const temporaryPath = path.join(
    os.tmpdir(),
    `.ai-team-restore-test-${timestampForFileName()}-${randomUUID()}.db`,
  )

  copyFileSync(backupPath, temporaryPath)

  try {
    const verification = verifyDatabaseFile(temporaryPath)
    if (!verification.ok) {
      throw new Error(`Restore verification failed: ${verification.reason ?? 'unknown reason'}`)
    }

    const db = new Database(temporaryPath, { readonly: false, fileMustExist: true })
    try {
      db.prepare('SELECT COUNT(*) AS count FROM projects').get()
    } finally {
      db.close()
    }
  } finally {
    rmSync(temporaryPath, { force: true })
    rmSync(`${temporaryPath}-wal`, { force: true })
    rmSync(`${temporaryPath}-shm`, { force: true })
  }
}

export async function runDbRestoreTest(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const backupPath = resolveRestoreBackupPath(argv, env)
    performIsolatedRestoreTest(backupPath)
    console.info('[db-restore-test] restore test completed')
    return 0
  } catch {
    console.error('[db-restore-test] restore test failed')
    return 1
  }
}

if (require.main === module) {
  void runDbRestoreTest().then((exitCode) => {
    process.exitCode = exitCode
  })
}
