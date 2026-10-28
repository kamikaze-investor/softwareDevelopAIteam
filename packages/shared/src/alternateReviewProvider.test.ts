import { describe, expect, it } from 'vitest'
import {
  ALTERNATE_PROVIDER_REVIEW_MAX_RUNS,
  DEFAULT_DESIGN_REVIEW_PROVIDER_CHAIN,
  selectAlternateReviewProvider,
} from './alternateReviewProvider'
import { parseRoleModelRegistry } from './roleModelRegistry'

const registry = parseRoleModelRegistry({
  entries: [
    { role: 'implementer', provider: 'claude_code', model: 'claude-opus-5-5', enabled: true },
    { role: 'meta_reviewer', provider: 'gemini', model: 'gemini-model-a', enabled: true },
    { role: 'meta_reviewer', provider: 'copilot', model: 'mai-code-1.1-flash', enabled: true },
    { role: 'meta_reviewer', provider: 'claude_code', model: 'claude-sonnet-5-5', enabled: true },
    { role: 'meta_reviewer', provider: 'codex', model: 'codex-model-a', enabled: true },
  ],
})

describe('selectAlternateReviewProvider', () => {
  it('既定連鎖を試した後は、試していない・implementer と vendor 分離できる Registry 候補を選ぶ', () => {
    expect(selectAlternateReviewProvider({
      registry,
      triedProviders: DEFAULT_DESIGN_REVIEW_PROVIDER_CHAIN,
      alternateRunsSoFar: 0,
    })).toEqual({ ok: true, provider: 'codex', model: 'codex-model-a' })
  })

  it('implementer と同じ vendor・vendor を特定できない copilot は選ばない', () => {
    const result = selectAlternateReviewProvider({
      registry,
      triedProviders: ['gemini', 'codex'],
      alternateRunsSoFar: 1,
    })
    expect(result.ok).toBe(false)
  })

  it('回数上限に達したら Registry に候補があっても選ばない', () => {
    const result = selectAlternateReviewProvider({
      registry,
      triedProviders: [],
      alternateRunsSoFar: ALTERNATE_PROVIDER_REVIEW_MAX_RUNS,
    })
    expect(result.ok).toBe(false)
  })

  it('Registry が無い・implementer が無いと選ばない（fail-closed）', () => {
    expect(selectAlternateReviewProvider({ registry: undefined, triedProviders: [], alternateRunsSoFar: 0 }).ok)
      .toBe(false)
    const noImplementer = parseRoleModelRegistry({
      entries: [{ role: 'meta_reviewer', provider: 'codex', model: 'codex-model-a', enabled: true }],
    })
    expect(selectAlternateReviewProvider({ registry: noImplementer, triedProviders: [], alternateRunsSoFar: 0 }).ok)
      .toBe(false)
  })

  it('disabled な meta_reviewer は選ばない', () => {
    const disabled = parseRoleModelRegistry({
      entries: [
        { role: 'implementer', provider: 'claude_code', model: 'claude-opus-5-5', enabled: true },
        { role: 'meta_reviewer', provider: 'codex', model: 'codex-model-a', enabled: false },
      ],
    })
    expect(selectAlternateReviewProvider({
      registry: disabled,
      triedProviders: DEFAULT_DESIGN_REVIEW_PROVIDER_CHAIN,
      alternateRunsSoFar: 0,
    }).ok).toBe(false)
  })
})
