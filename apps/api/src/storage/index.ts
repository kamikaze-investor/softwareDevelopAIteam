import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createSQLiteStorage } from './sqlite'
import type { IStorage } from './interface'

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'ai-team.db')

let storage: IStorage | null = null

export function resolveStorageDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NODE_ENV !== 'production') {
    return env.DB_PATH ?? DEFAULT_DB_PATH
  }

  const configuredDbPath = env.DB_PATH
  if (configuredDbPath === undefined || configuredDbPath === '') {
    throw new Error('DB_PATH must be configured in production')
  }

  if (!existsSync(configuredDbPath)) {
    throw new Error('Configured production DB file does not exist')
  }

  return configuredDbPath
}

function logProductionDbPathState(dbPath: string): void {
  console.info('[storage] production DB path explicitly configured')
  if (dbPath !== ':memory:') {
    console.info('[storage] production DB file exists')
  }
}

export function getStorage(): IStorage {
  if (!storage) {
    const dbPath = resolveStorageDbPath()
    if (process.env.NODE_ENV === 'production') {
      logProductionDbPathState(dbPath)
    }
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true })
    }
    storage = createSQLiteStorage(dbPath)
    if (process.env.NODE_ENV === 'production') {
      console.info('[storage] storage initialized')
    }
  }
  return storage
}

export function resetStorage(): void {
  storage = null
}
