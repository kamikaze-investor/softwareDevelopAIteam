import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const telemetryReportTestScript = fileURLToPath(
  new URL('../../../scripts/delegate-telemetry-report.test.sh', import.meta.url),
)

describe('delegation telemetry report shell flow', () => {
  it('aggregates watchdog telemetry into buckets, reasons, and averages without leaking private data', () => {
    const output = execFileSync('bash', [telemetryReportTestScript], {
      encoding: 'utf8',
      timeout: 90_000,
    })

    expect(output).toContain('delegate-telemetry-report deterministic tests: PASS')
  })
})
