import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const watchdogTestScript = fileURLToPath(
  new URL('../../../scripts/delegate-watchdog.test.sh', import.meta.url),
)

describe('delegation watchdog shell flow', () => {
  it('fails closed, bounds retries, preserves logs, and protects unrelated PIDs', () => {
    const output = execFileSync('bash', [watchdogTestScript], {
      encoding: 'utf8',
      timeout: 90_000,
    })

    expect(output).toContain('delegate-watchdog deterministic tests: PASS')
  })
})
