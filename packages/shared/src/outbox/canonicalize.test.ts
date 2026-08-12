import { describe, expect, it } from 'vitest'
import { canonicalizeJobUpdate } from './canonicalize'

describe('canonicalizeJobUpdate', () => {
  it('returns the same string for objects with the same content in different key orders', () => {
    const first = canonicalizeJobUpdate({
      status: 'success',
      completedAt: '2026-08-08T00:00:00.000Z',
      exitCode: 0,
    })
    const second = canonicalizeJobUpdate({
      exitCode: 0,
      status: 'success',
      completedAt: '2026-08-08T00:00:00.000Z',
    })

    expect(first).toBe(second)
  })

  it('sorts nested object keys while preserving array order', () => {
    const first = canonicalizeJobUpdate({
      guardResult: {
        fileViolations: ['b.ts', 'a.ts'],
        fileChangeAllowed: false,
        permissionAllowed: true,
      },
      changedFiles: [
        { path: 'b.ts', status: 'modified' },
        { status: 'added', path: 'a.ts' },
      ],
    })
    const second = canonicalizeJobUpdate({
      changedFiles: [
        { status: 'modified', path: 'b.ts' },
        { path: 'a.ts', status: 'added' },
      ],
      guardResult: {
        permissionAllowed: true,
        fileChangeAllowed: false,
        fileViolations: ['b.ts', 'a.ts'],
      },
    })

    expect(first).toBe(second)
    expect(first).toContain('"fileViolations":["b.ts","a.ts"]')
  })
})
