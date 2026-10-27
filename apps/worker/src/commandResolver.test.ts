import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SafeCommand } from '@ai-team/shared'
import { resolveCommand } from './commandResolver'

const test = (params?: SafeCommand['params']): SafeCommand => ({
  kind: 'test',
  workingDir: '/workspace/target',
  ...(params === undefined ? {} : { params }),
})

describe('resolveCommand — test', () => {
  it('Implement profile は固定 script verify:implement へ解決する', () => {
    expect(resolveCommand(test({ verificationProfile: 'implement' }))).toEqual({
      argv: ['pnpm', 'run', 'verify:implement'],
      description: 'pnpm run verify:implement',
    })
  })

  it('profile が無い通常の test は従来どおり pnpm test', () => {
    expect(resolveCommand(test())).toEqual({ argv: ['pnpm', 'test'], description: 'pnpm test' })
    expect(resolveCommand(test({}))).toEqual({ argv: ['pnpm', 'test'], description: 'pnpm test' })
  })

  it('testPattern の sanitize は変わらない', () => {
    expect(resolveCommand(test({ testPattern: 'apps/api;rm -rf' })).argv).toEqual(['pnpm', 'test', 'apps/apirm-rf'])
  })

  it('未知の profile 値から script 名を組み立てない（通常 test へ倒れる）', () => {
    const resolved = resolveCommand(test({ verificationProfile: 'evil' as never }))
    expect(resolved.argv).toEqual(['pnpm', 'test'])
  })
})

describe('root package.json の verify:implement', () => {
  const rootPackage = JSON.parse(readFileSync(
    path.resolve(__dirname, '../../../package.json'),
    'utf-8',
  )) as { scripts: Record<string, string> }

  // `&&` なので typecheck が失敗すれば test は走らず、終了コードは非 0 になる。
  it('typecheck → test の順に、前段失敗で止まる形で実行する', () => {
    expect(rootPackage.scripts['verify:implement']).toBe('pnpm -r --parallel typecheck && pnpm -r --parallel test')
  })

  it('既存の test / typecheck / verify は変えない', () => {
    expect(rootPackage.scripts.test).toBe("pnpm --parallel --filter './apps/*' test")
    expect(rootPackage.scripts.typecheck).toBe("pnpm --parallel --filter './apps/*' typecheck")
    expect(rootPackage.scripts.verify).toBe('pnpm -r typecheck && pnpm -r test && pnpm roadmap:check')
  })
})
