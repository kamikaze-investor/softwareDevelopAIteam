import { createVerifiedBackup, rotateBackups } from '../src/storage/backup'
import { resolveStorageDbPath } from '../src/storage'

const BACKUP_KEEP_COUNT = 28

export async function runDbBackup(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const backupDir = env.DB_BACKUP_DIR
  if (backupDir === undefined || backupDir === '') {
    console.error('[db-backup] DB_BACKUP_DIR must be configured')
    return 1
  }

  try {
    const sourceDbPath = resolveStorageDbPath(env)
    await createVerifiedBackup(sourceDbPath, backupDir)
    const rotation = rotateBackups(backupDir, BACKUP_KEEP_COUNT)
    console.info(`[db-backup] backup completed; rotated ${rotation.deleted.length} old backups`)
    return 0
  } catch {
    console.error('[db-backup] backup failed')
    return 1
  }
}

if (require.main === module) {
  void runDbBackup().then((exitCode) => {
    process.exitCode = exitCode
  })
}
