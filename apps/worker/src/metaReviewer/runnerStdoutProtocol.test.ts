import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * `designReviewRunner.ts` は **stdout を JSON プロトコル channel として使う**
 * （`process.stdout.write(JSON.stringify(result))`）。coordinator 側は
 * `JSON.parse(execution.stdout)` するので、runner が読み込むモジュールが
 * stdout へ 1 行でも書くと **run 全体が "runner returned unparsable output" で失敗する**。
 *
 * 2026-09-17 production 実測: `[metaReview] attempt {...}` を `console.log` で出していたため
 * 本番の Design Review が実際にこの形で失敗した（#241 で混入、production E2E で検出）。
 * 診断は stderr へ出す。stderr は coordinator が別途捕捉し、CI ログにも出る。
 */

const RUNNER_LOADED_MODULES = [
  'geminiRouter.ts',
  'metaReviewFallbackRouter.ts',
  'copilotRouter.ts',
  'strategicReview.ts',
  'runner.ts',
]

describe('design review runner stdout protocol', () => {
  it('runner が読み込むモジュールは stdout へ書かない（console.log を使わない）', () => {
    const offenders: string[] = []

    for (const file of RUNNER_LOADED_MODULES) {
      const src = readFileSync(path.join(__dirname, file), 'utf-8')
      src.split(/\r?\n/).forEach((line, index) => {
        if (/(^|[^.\w])console\.log\s*\(/.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`)
        }
      })
    }

    expect(offenders).toEqual([])
  })

  it('runner 本体は stdout を JSON 専用に使っている', () => {
    const runner = readFileSync(
      path.resolve(__dirname, '../../scripts/designReviewRunner.ts'),
      'utf-8',
    )
    expect(runner).toContain('process.stdout.write(JSON.stringify(result))')
  })
})
