import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getStorage, resetStorage, resolveStorageDbPath } from './index'

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_DB_PATH = process.env.DB_PATH

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
}

describe('storage DB path resolution', () => {
  beforeEach(() => {
    resetStorage()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    delete process.env.NODE_ENV
    delete process.env.DB_PATH
  })

  afterEach(() => {
    resetStorage()
    vi.restoreAllMocks()
    restoreEnv()
  })

  it('rejects startup in production when DB_PATH is not configured', () => {
    process.env.NODE_ENV = 'production'

    expect(() => getStorage()).toThrow('DB_PATH must be configured in production')
  })

  it('rejects startup in production when DB_PATH points to a missing file', () => {
    process.env.NODE_ENV = 'production'
    process.env.DB_PATH = path.join(os.tmpdir(), `ai-team-missing-${randomUUID()}.db`)

    expect(() => getStorage()).toThrow('Configured production DB file does not exist')
  })

  it('rejects startup in production when DB_PATH is :memory:', () => {
    process.env.NODE_ENV = 'production'
    process.env.DB_PATH = ':memory:'

    expect(() => getStorage()).toThrow('Configured production DB file does not exist')
  })

  it('opens an existing production DB file', () => {
    const dbPath = path.join(os.tmpdir(), `ai-team-existing-${randomUUID()}.db`)
    writeFileSync(dbPath, '')
    process.env.NODE_ENV = 'production'
    process.env.DB_PATH = dbPath

    const storage = getStorage()

    expect(storage.projects.findAll()).toEqual([])
  })

  it.each(['development', 'test', undefined] as const)(
    'keeps the fallback DB path when NODE_ENV is %s',
    (nodeEnv) => {
      if (nodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = nodeEnv
      }
      delete process.env.DB_PATH

      expect(resolveStorageDbPath()).toBe(path.resolve(process.cwd(), 'data', 'ai-team.db'))
    },
  )

  it.each(['development', 'test', undefined] as const)(
    'allows :memory: when NODE_ENV is %s',
    (nodeEnv) => {
      resetStorage()
      if (nodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = nodeEnv
      }
      process.env.DB_PATH = ':memory:'

      const storage = getStorage()

      expect(storage.projects.findAll()).toEqual([])
    },
  )
})
