import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  buildConstitutionPrinciplesPrompt,
  formatConstitutionPrinciplesWarning,
  loadConstitutionPrinciples,
} from './constitutionPrinciples.js'

const constitutionPath = path.resolve(process.cwd(), '../../specs/00_constitution.md')
const missingPath = path.resolve(process.cwd(), '__missing__', '00_constitution.md')

describe('loadConstitutionPrinciples', () => {
  it('specs/00_constitution.md から 3.14〜3.15 だけを抽出する', () => {
    const result = loadConstitutionPrinciples([constitutionPath])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain('## 3.14 Minimum Sufficient Validation')
    expect(result.text).toContain('## 3.15 Autonomous Judgment')
    expect(result.text).toContain('必要最小限の独立した反証レビュー')
    expect(result.text).toContain('CEO確認は、原則として次の場合に限る')
    expect(result.text).not.toContain('# 4. 実装方針')
  })

  it('ファイルが存在しない場合は例外を投げず、失敗として区別できる', () => {
    expect(() => loadConstitutionPrinciples([missingPath])).not.toThrow()

    const result = loadConstitutionPrinciples([missingPath])
    expect(result.ok).toBe(false)
    if (result.ok) return
    // 失敗理由に試行パスが残り、観測できること
    expect(result.reason).toContain('00_constitution.md')
    expect(result.triedPaths).toEqual([missingPath])
  })
})

describe('buildConstitutionPrinciplesPrompt', () => {
  it('取得できた場合は本文をそのまま返す', () => {
    const result = loadConstitutionPrinciples([constitutionPath])
    const prompt = buildConstitutionPrinciplesPrompt(result)

    expect(prompt).toContain('## 3.14 Minimum Sufficient Validation')
    expect(prompt).toContain('## 3.15 Autonomous Judgment')
  })

  it('取得できなかった場合は「未取得」と分かる非空の文面を返す（黙って省略しない）', () => {
    const prompt = buildConstitutionPrinciplesPrompt(loadConstitutionPrinciples([missingPath]))

    expect(prompt.trim()).not.toBe('')
    expect(prompt).toContain('取得できませんでした')
    expect(prompt).toContain('適用済みとして扱えません')
    // 本文が入っていないことを、適用済みと誤認できない形で示す
    expect(prompt).not.toContain('## 3.14 Minimum Sufficient Validation')
  })
})

describe('formatConstitutionPrinciplesWarning', () => {
  it('成功時は警告を出さない', () => {
    expect(formatConstitutionPrinciplesWarning(loadConstitutionPrinciples([constitutionPath])))
      .toBeUndefined()
  })

  it('失敗時は既存ログへ出せる警告文を返す', () => {
    const warning = formatConstitutionPrinciplesWarning(loadConstitutionPrinciples([missingPath]))

    expect(warning).toBeDefined()
    expect(warning).toContain('[constitution]')
    expect(warning).toContain('取得できませんでした')
  })
})
