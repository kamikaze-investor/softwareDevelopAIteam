import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  buildFocusedOutputContract,
  buildFocusedReviewPrompt,
  parseFocusedReviewResponse,
  selectFocusPrinciples,
} from './strategicReview'

const REPO_ROOT = resolve(__dirname, '../../../..')

/**
 * Focused Review へ Principle Compliance を統合した部分の検証。
 *
 * **新しい Review 工程は無い。** 既存 focused review の prompt と出力契約を拡張しただけなので、
 * ここで見るのは「提示できているか」と「返答が壊れていても review を落とさないか」である。
 */

describe('focused review prompt carries the applicable principles', () => {
  it('focus ごとに違う原則集合を提示する（固定3件ではない）', () => {
    const safety = selectFocusPrinciples('safety_recovery').map((item) => item.slug)
    const scope = selectFocusPrinciples('scope_simplicity').map((item) => item.slug)

    expect(safety).toContain('boundary-strictness')
    expect(scope).not.toContain('boundary-strictness')
    expect(scope).toContain('existing-code-grandfather')

    // core はどちらにも入る。
    expect(safety).toContain('observation-closes-loop')
    expect(scope).toContain('observation-closes-loop')
  })

  it('出力契約に原則単位の判定フィールドと、提示した id が載る', () => {
    const selection = selectFocusPrinciples('data_state_integrity')
    const contract = buildFocusedOutputContract(selection)

    expect(contract).toContain('## Applicable Principles')
    expect(contract).toContain('"appliedPrinciples"')
    expect(contract).toContain('- honest-unverifiable:')
    expect(contract).toContain('Do not invent principle ids')
    // 原則の全文は載せない（原則数に対して prompt が線形に太らないことが完了条件）。
    expect(contract).not.toContain('an unfalsifiable TODO')
  })

  it('delivers Decision Authority only to safety_recovery and auth_permission focuses', async () => {
    const input = {
      subjectId: 'task-authority',
      taskTitle: 'authority review',
      changedFiles: ['apps/api/src/pl/recovery.ts'],
      gitDiff: '+ change',
      workingDir: REPO_ROOT,
      controlContextDir: REPO_ROOT,
    }
    const safety = await buildFocusedReviewPrompt(
      input,
      'safety_recovery',
      selectFocusPrinciples('safety_recovery'),
    )
    const auth = await buildFocusedReviewPrompt(
      input,
      'auth_permission',
      selectFocusPrinciples('auth_permission'),
    )
    const architecture = await buildFocusedReviewPrompt(
      input,
      'architecture_responsibility',
      selectFocusPrinciples('architecture_responsibility'),
    )

    expect(safety.prompt).toContain('## 1-2. Human Decision Authority')
    expect(auth.prompt).toContain('## 14-3. Priority 2 境界表')
    expect(architecture.prompt).not.toContain('## 1-2. Human Decision Authority')
  })
})

describe('parseFocusedReviewResponse with principle verdicts', () => {
  const selection = selectFocusPrinciples('data_state_integrity')

  it('原則単位の判定を読み取り、選択時の版と理由を保持する', () => {
    const outcome = parseFocusedReviewResponse(
      JSON.stringify({
        decision: 'CONFLICT',
        summary: 's',
        findings: [],
        appliedPrinciples: [
          { principleId: 'honest-unverifiable', verdict: 'CONFLICT', reason: 'guesses turned into PASS' },
        ],
      }),
      'data_state_integrity',
      selection,
    )

    expect(outcome.unavailable).toBe(false)
    const applied = outcome.result.appliedPrinciples ?? []
    const honest = applied.find((item) => item.principleId === 'honest-unverifiable')
    expect(honest?.verdict).toBe('CONFLICT')
    expect(honest?.reason).toBe('guesses turned into PASS')
    expect(honest?.principleVersionHash).toBe(
      selection.find((item) => item.slug === 'honest-unverifiable')?.versionHash,
    )
    expect(honest?.selectionReason).toBe('focus=data_state_integrity')
  })

  it('appliedPrinciples が無くても review は成立する（false BLOCKED を作らない）', () => {
    const outcome = parseFocusedReviewResponse(
      JSON.stringify({ decision: 'ALIGNED', summary: 's', findings: [] }),
      'data_state_integrity',
      selection,
    )

    expect(outcome.unavailable).toBe(false)
    expect(outcome.result.decision).toBe('ALIGNED')
    // 聞いたのに答えなかった原則は UNCERTAIN として残る。黙って消さない。
    expect(outcome.result.appliedPrinciples?.every((item) => item.verdict === 'UNCERTAIN')).toBe(true)
  })

  it('appliedPrinciples が壊れていても review は成立する', () => {
    const outcome = parseFocusedReviewResponse(
      JSON.stringify({ decision: 'ALIGNED', summary: 's', appliedPrinciples: 'not-an-array' }),
      'data_state_integrity',
      selection,
    )

    expect(outcome.unavailable).toBe(false)
    expect(outcome.result.decision).toBe('ALIGNED')
    expect(outcome.result.appliedPrinciples).toHaveLength(selection.length)
  })

  it('選択していない原則 id は捨てる', () => {
    const outcome = parseFocusedReviewResponse(
      JSON.stringify({
        decision: 'ALIGNED',
        summary: 's',
        appliedPrinciples: [{ principleId: 'made-up-principle', verdict: 'CONFLICT', reason: 'x' }],
      }),
      'data_state_integrity',
      selection,
    )

    expect(outcome.result.appliedPrinciples?.some((item) => item.principleId === 'made-up-principle')).toBe(false)
  })

  it('accepts principle_conflict only when the finding names a provided principle', () => {
    const safetySelection = selectFocusPrinciples('safety_recovery')
    const review = (message: string) => JSON.stringify({
      decision: 'CONFLICT',
      summary: 's',
      findings: [{ severity: 'high', category: 'principle_conflict', message }],
    })

    const accepted = parseFocusedReviewResponse(
      review('specs/22 §14-3 conflicts with the Constitution'),
      'safety_recovery',
      safetySelection,
    )
    const normalized = parseFocusedReviewResponse(
      review('unprovided-principle conflicts with the Constitution'),
      'safety_recovery',
      safetySelection,
    )

    expect(accepted.result.findings[0].category).toBe('principle_conflict')
    expect(normalized.result.findings[0].category).toBe('spec_violation')
  })

  it('decision が壊れている場合の fail-closed は従来どおり', () => {
    const outcome = parseFocusedReviewResponse('not json at all', 'data_state_integrity', selection)

    expect(outcome.unavailable).toBe(true)
    expect(outcome.result.decision).toBe('UNCERTAIN')
  })
})
