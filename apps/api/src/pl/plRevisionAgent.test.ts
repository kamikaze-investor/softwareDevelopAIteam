import { describe, expect, it, vi } from 'vitest'
import { PL_ADOPTION_PROPOSAL_AGENT } from '../aiExplain/cheapAiClient'
import { defaultPlRevise, PL_REVISION_SYSTEM_PROMPT } from './conflictResolutionStep'

const { requestText } = vi.hoisted(() => ({ requestText: vi.fn(async () => '{}') }))
vi.mock('../aiExplain/cheapAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiExplain/cheapAiClient')>()),
  requestText,
}))

describe('defaultPlRevise', () => {
  // 既定 agent は `<tool_call>` を本文で返し、revision が毎回 unparsable になる（2026-10-23 #2cae0d07）。
  it('selects the JSON-only agent and keeps the transient retry and token cap', async () => {
    await defaultPlRevise(PL_REVISION_SYSTEM_PROMPT, 'user')
    expect(requestText).toHaveBeenCalledWith(
      PL_REVISION_SYSTEM_PROMPT,
      'user',
      { retryTransientOnce: true, agent: PL_ADOPTION_PROPOSAL_AGENT },
      900,
    )
  })
})
