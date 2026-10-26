import { describe, expect, it, vi } from 'vitest'
import { PL_ADOPTION_PROPOSAL_AGENT } from '../aiExplain/cheapAiClient'
import { defaultPlRevise, parsePlRevision, PL_REVISION_SYSTEM_PROMPT } from './conflictResolutionStep'

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

describe('parsePlRevision — 余計な文字で正しい spec を捨てない', () => {
  // 2026-10-26 Production #2cae0d07: JSON-only agent の応答は完全な spec の後ろに `}` を1つ余計に付けていた。
  // 以前の「最初の { から最後の } まで」の抽出では JSON.parse が失敗し、unparsable_revision になっていた。
  it('完全な spec の後ろに余計な `}` があっても spec として読む', () => {
    const spec = {
      implementationScope: 'IN SCOPE: x. OUT OF SCOPE: y.',
      allowedPaths: ['apps/api/src/aiExplain'],
      acceptanceCriteria: ['c1'],
      rationale: 'r',
      respondsTo: 'f',
    }

    expect(parsePlRevision(`${JSON.stringify(spec)}}`)).toEqual(spec)
  })

  it('必須項目が欠けていれば従来どおり拒否する（中身の検証は緩めない）', () => {
    expect(parsePlRevision('{"implementationScope":"x","allowedPaths":["a/b"]}}')).toBeUndefined()
  })
})
