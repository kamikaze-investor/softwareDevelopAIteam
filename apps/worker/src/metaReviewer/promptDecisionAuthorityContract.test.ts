import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Meta Reviewer の判定契約（docs/meta_reviewer/prompt.md / checklist.md）のうち、
 * Human Decision lifecycle（2026-10-08 CEO 決定）が依存する意味を固定する。
 *
 * 逆戻りさせたくない意味:
 *   canonical spec で承認済みの authority boundary を、その scope どおりに実装する変更は、
 *   人の承認を外す方向であっても technical `blocked`（Cage 弱体化）ではなく Human Decision Authority である。
 *   `blocked` は、承認済み scope の逸脱・無断の authority 拡大・意図しない bypass / fail-open・実装欠陥だけ。
 *
 * これが崩れると、CEO が spec で承認した変更自体が Meta Review で止まり、
 * Human Decision（CODEOWNERS review）へ到達できなくなる（実測: Stage 1 git_commit 実装の PR）。
 * 特定の PR / SHA には依存させず、prompt / checklist の本文の意味だけを見る。
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const prompt = readFileSync(path.join(REPO_ROOT, 'docs/meta_reviewer/prompt.md'), 'utf-8')
const checklist = readFileSync(path.join(REPO_ROOT, 'docs/meta_reviewer/checklist.md'), 'utf-8')

/** 見出し `heading` から次の `### ` / `## ` 見出しまでの本文。 */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  expect(start, `heading not found: ${heading}`).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start + heading.length)
  const next = rest.search(/\n#{2,3} /)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('Meta Reviewer 判定契約 — 承認済み authority boundary の扱い', () => {
  const blockedSection = section(prompt, '### `blocked`')
  const humanDecisionSection = section(prompt, '### Human Decision Authority のみ')

  it('承認済み boundary を scope どおりに実装する変更は Human Decision 側に置かれ、blocked にしない', () => {
    expect(humanDecisionSection).toContain('canonical spec で承認済みの authority boundary を、その scope どおりに変更・実装する差分は')
    expect(humanDecisionSection).toContain('Cage 弱体化 / Safety weakening として `blocked` にしない')
  })

  it('authority を広げること自体は blocked の理由にならない', () => {
    expect(humanDecisionSection).toContain('authority を広げる変更であること自体は `blocked` の理由にならない')
  })

  it('blocked 側の Human Gate 弱体化は「承認されていない（無断・意図外）」場合に限られる', () => {
    expect(blockedSection).toContain('canonical spec で承認されていないのに保護が弱まる方向へ変えている')
    // 無条件の「Human Gate を弱めたら blocked」に戻っていないこと
    expect(blockedSection).not.toMatch(/Human Gate そのもの[^\n]*を、保護が弱まる方向へ変えている/)
  })

  it('承認済み scope を超えた authority 拡大と実装欠陥は引き続き blocked', () => {
    expect(blockedSection).toContain('CEO が承認した scope（canonical spec）を超えて authority を広げている')
    expect(blockedSection).toContain('意図しない bypass・fail-open・判定漏れ')
  })

  it('PR 自身による canonical spec の変更で自分の scope を正当化しない', () => {
    expect(humanDecisionSection).toContain('その変更を根拠に自分の scope を正当化しない')
  })

  it('CEO 承認は technical blocked を解除しない（欠陥と Human Decision の両方なら blocked）', () => {
    expect(humanDecisionSection).toContain('CEO 承認は技術的な `blocked` を解除しない')
  })

  it('checklist も同じ意味: 承認済み boundary の scope 内実装を Cage 弱体化に数えない', () => {
    expect(checklist).toContain('scope どおりに実装する変更は、人の承認を外す方向でも「Cage弱体化」に数えない')
  })
})
