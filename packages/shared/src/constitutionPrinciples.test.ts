import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  buildConstitutionPrinciplesPrompt,
  formatDecisionAuthorityPrinciplesWarning,
  formatConstitutionPrinciplesWarning,
  loadConstitutionPrinciples,
  loadDecisionAuthorityPrinciples,
  loadNamedMarkdownSections,
} from './constitutionPrinciples.js'

const repoRoot = path.resolve(__dirname, '../../..')
const constitutionPath = path.join(repoRoot, 'specs/00_constitution.md')
const missingPath = path.join(repoRoot, '__missing__', '00_constitution.md')
const decisionAuthorityPath = path.join(repoRoot, 'specs/22_safety_approval_design_principle.md')

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

describe('loadDecisionAuthorityPrinciples', () => {
  it('returns exactly specs/22 sections 1-2, 1-3, and 14-3', () => {
    const result = loadDecisionAuthorityPrinciples([decisionAuthorityPath])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain('## 1-2. Human Decision Authority')
    expect(result.text).toContain('## 1-3. 技術判断は CEO へ上げない')
    expect(result.text).toContain('## 14-3. Priority 2 境界表')
    expect(result.text).not.toContain('## 1-1.')
    expect(result.text).not.toContain('## 1-4.')
    expect(result.text).not.toContain('## 14-2.')
  })

  it('reports a visible warning when any requested section is missing', () => {
    const result = loadNamedMarkdownSections([decisionAuthorityPath], ['1-2', 'missing-section'])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('section missing-section not found')
    expect(formatDecisionAuthorityPrinciplesWarning(result)).toContain('[decision-authority]')
    expect(formatDecisionAuthorityPrinciplesWarning(result)).toContain('missing-section')
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
