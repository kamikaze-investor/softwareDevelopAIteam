import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createSQLiteStorage } from './sqlite'
import type { IStorage } from './interface'

const DB_PATH = process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'ai-team.db')

let storage: IStorage | null = null

export function getStorage(): IStorage {
  if (!storage) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true })
    storage = createSQLiteStorage(DB_PATH)
  }
  return storage
}

export function resetStorage(): void {
  storage = null
}
