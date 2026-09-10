import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const watchdogTestScript = fileURLToPath(
  new URL('../../../scripts/delegate-watchdog.test.sh', import.meta.url),
)

/**
 * DELEG-001: この shell test は非決定的に失敗していた
 * （Linux CI 実測: `expected recovery_attempt_count '1', got '2'`。
 * 同一コードの再実行では pass）。
 *
 * したがって **1回 pass しても非決定性が消えた証拠にはならない**。
 * 修正の完了条件として、繰り返し実行して毎回通ることを要求する。
 * 回数は `DELEGATE_WATCHDOG_TEST_RUNS` で上書きできる（既定 3）。
 */
const RUNS = Number(process.env.DELEGATE_WATCHDOG_TEST_RUNS ?? 3)

describe('delegation watchdog shell flow', () => {
  it(`fails closed, bounds retries, preserves logs, and protects unrelated PIDs (x${RUNS}, DELEG-001 非決定性の回帰)`, () => {
    for (let run = 1; run <= RUNS; run++) {
      let output: string
      try {
        output = execFileSync('bash', [watchdogTestScript], {
          encoding: 'utf8',
          timeout: 90_000,
        })
      } catch (err) {
        // 何回目で落ちたかが分からないと、非決定性の切り分けができない。
        const detail = err instanceof Error ? err.message : String(err)
        const stderr = (err as { stderr?: string }).stderr ?? ''
        throw new Error(`delegate-watchdog shell test failed on run ${run}/${RUNS}: ${detail}\n${stderr}`)
      }

      expect(output, `run ${run}/${RUNS}`).toContain('delegate-watchdog deterministic tests: PASS')
    }
  }, 300_000)
})
