import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const watchdogTestScript = fileURLToPath(
  new URL('../../../scripts/delegate-watchdog.test.sh', import.meta.url),
)

/**
 * DELEG-001: provider は専用 process group (setsid) で起動する契約になった。
 * setsid が無い platform では supervised delegation 自体を unsupported として
 * fail-closed させる方針なので、この shell test も実行できない。
 *
 * ただし **黙って skip させない**。skip が既定になると
 * 「監視していると宣言しているだけで監視していない」状態を CI が緑で隠してしまう。
 * CI は Linux (ubuntu-latest) なので、Linux で setsid が無い場合は skip ではなく失敗させる。
 */
function hasSetsid(): boolean {
  const probe = spawnSync('bash', ['-lc', 'command -v setsid'], { encoding: 'utf8' })
  return probe.status === 0 && (probe.stdout ?? '').trim().length > 0
}

const SETSID_AVAILABLE = hasSetsid()
if (!SETSID_AVAILABLE && process.platform === 'linux') {
  throw new Error(
    'setsid is missing on a Linux host. The delegate-watchdog shell suite would be skipped, ' +
    'which would hide the DELEG-001 process-group behaviour from CI. Refusing to skip.',
  )
}

/**
 * DELEG-001: この shell test は非決定的に失敗していた
 * （Linux CI 実測: `expected recovery_attempt_count '1', got '2'`。
 * 同一コードの再実行では pass）。
 *
 * したがって **1回 pass しても非決定性が消えた証拠にはならない**。
 * 修正の完了条件として、繰り返し実行して毎回通ることを要求する。
 * 回数は `DELEGATE_WATCHDOG_TEST_RUNS` で上書きできる（既定 3）。
 */
/**
 * 独立レビュー指摘: 上書き値を検証していないと、`0` / 負値 / 非数値を渡したときに
 * ループが一度も回らず、**shell test 全体を素通りさせたまま緑になる**。
 * recurrence detection のための harness が、設定ミスで沈黙するのは本末転倒なので
 * 1以上の整数だけを受け付け、それ以外は明示的に失敗させる。
 */
function resolveRuns(raw: string | undefined): number {
  if (raw === undefined) return 3
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `DELEGATE_WATCHDOG_TEST_RUNS must be an integer >= 1; got ${JSON.stringify(raw)}. ` +
      'Refusing to run, because a bad value would silently skip the shell suite.',
    )
  }
  return parsed
}

const RUNS = resolveRuns(process.env.DELEGATE_WATCHDOG_TEST_RUNS)

describe.skipIf(!SETSID_AVAILABLE)('delegation watchdog shell flow', () => {
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
