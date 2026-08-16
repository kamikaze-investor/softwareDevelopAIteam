import { describe, expect, it } from 'vitest'
import { computeTaskDisplayStatus } from './task'

describe('computeTaskDisplayStatus', () => {
  it('returns pending for a pending Task without a Job', () => {
    expect(computeTaskDisplayStatus({ taskStatus: 'pending' })).toBe('pending')
  })
})
