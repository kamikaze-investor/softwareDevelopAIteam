import type { CommandKind } from '@ai-team/shared'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SAFE_COMMAND_TIMEOUT_MS, safeCommandTimeoutMs } from './safeCommandTimeout'
import { getStallThreshold } from '../watchdog/stallDetector'

// 2026-10-23 implement stall: `pnpm test` は全件 pass するが 147s かかり、一律 120s で kill されていた。
describe('safeCommandTimeoutMs — kind 別の SafeCommand 実行予算', () => {
  it.each<[CommandKind, number]>([
    ['test', 600_000],
    ['build', 600_000],
    ['typecheck', 300_000],
    ['lint', 120_000],
    ['git_status', 120_000],
    ['git_diff', 120_000],
    ['git_log', 120_000],
    ['git_branch_create', 120_000],
    ['git_checkout', 120_000],
    ['git_commit', 120_000],
    ['git_revert', 120_000],
  ])('%s → %i ms', (kind, expected) => {
    expect(safeCommandTimeoutMs(kind)).toBe(expected)
  })

  it('the default floor is the previous single budget (120s)', () => {
    expect(DEFAULT_SAFE_COMMAND_TIMEOUT_MS).toBe(120_000)
  })

  it('long kinds equal the watchdog expectation, so the runner and the watchdog cannot drift', () => {
    for (const kind of ['test', 'build', 'typecheck'] as const) {
      expect(safeCommandTimeoutMs(kind)).toBe(getStallThreshold(kind))
    }
  })
})
