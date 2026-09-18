import { describe, expect, it } from 'vitest'
import type { AuditLogEntry } from '@ai-team/shared'
import {
  adoptionFailureClasses,
  adoptionFailureFingerprint,
  entriesSinceLastAdoption,
  summarizeAdoptionFailure,
} from './adoptionFailure'

/**
 * ここで固定しているのは「同じ障害か、違う障害か」の判定である。
 *
 * CEO への通知は incident 単位で1回に絞られたので、**この判定が粗いと別の障害が黙殺される**。
 * 逆に細かすぎると鳴り続ける。境界を具体的に書き出しておく。
 */

let sequence = 0
function entry(over: Partial<AuditLogEntry> = {}): AuditLogEntry {
  sequence += 1
  return {
    id: `audit-${sequence}`,
    actor: 'api',
    operation: 'pl_loop',
    entityType: 'pl_loop_target',
    entityId: 'adopt:project-1',
    result: 'blocked',
    detail: 'adoption=proposal_unusable code=unparsable_proposal target=- ',
    createdAt: `2026-09-18T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    ...over,
  } as AuditLogEntry
}

describe('adoptionFailureClasses — 何を「同じ障害」と見なすか', () => {
  it('status が同じでも code が違えば別の分類', () => {
    const classes = adoptionFailureClasses([
      entry({ detail: 'adoption=proposal_unusable code=unparsable_proposal target=- ' }),
      entry({ detail: 'adoption=proposal_unusable code=unoffered_candidate target=x ' }),
    ])

    expect(classes).toHaveLength(2)
  })

  it('status も code も同じでも、対象の Roadmap 項目が違えば別の分類', () => {
    const classes = adoptionFailureClasses([
      entry({ detail: 'adoption=adoption_rejected code=ALREADY_EXECUTED target=item-a rest' }),
      entry({ detail: 'adoption=adoption_rejected code=ALREADY_EXECUTED target=item-b rest' }),
    ])

    expect(classes).toEqual([
      'adoption_rejected/ALREADY_EXECUTED/item-a',
      'adoption_rejected/ALREADY_EXECUTED/item-b',
    ])
  })

  it('同じ status・code・target の繰り返しは1つの分類', () => {
    const same = 'adoption=proposal_unusable code=unparsable_proposal target=- prose here'
    expect(adoptionFailureClasses([entry({ detail: same }), entry({ detail: same })])).toHaveLength(1)
  })

  it('散文の部分が違っても分類は変わらない（reason は機械判定に使わない）', () => {
    const classes = adoptionFailureClasses([
      entry({ detail: 'adoption=blocked code=gate_blocked:x target=item-a 理由その1' }),
      entry({ detail: 'adoption=blocked code=gate_blocked:x target=item-a 全然ちがう理由' }),
    ])

    expect(classes).toHaveLength(1)
  })

  it('構造化されていない古い行は audit result へ退避する（壊れない）', () => {
    expect(adoptionFailureClasses([entry({ detail: 'adoption=proposal_unusable something old' })]))
      .toEqual(['proposal_unusable'])
    expect(adoptionFailureClasses([entry({ result: 'diagnosis_failed', detail: 'CLI timed out' })]))
      .toEqual(['diagnosis_failed'])
  })

  it('試行として数えない行は分類に入れない', () => {
    expect(adoptionFailureClasses([entry({ result: 'escalated', detail: '通知しました' })]))
      .toEqual([])
  })
})

describe('adoptionFailureFingerprint — 成功を跨いだら別の incident', () => {
  it('採用成功の回数が変われば、同じ失敗でも指紋が変わる', () => {
    const failures = [entry()]

    expect(adoptionFailureFingerprint(0, failures))
      .not.toBe(adoptionFailureFingerprint(1, failures))
  })

  it('同じ成功回数・同じ失敗なら指紋は同じ（時刻に依存しない）', () => {
    // audit の並びは created_at DESC, rowid DESC。同一ミリ秒の行が混ざっても指紋は変わらない。
    const a = entry({ createdAt: '2026-09-18T00:00:00.000Z' })
    const b = entry({ createdAt: '2026-09-18T00:00:00.000Z' })

    expect(adoptionFailureFingerprint(2, [a])).toBe(adoptionFailureFingerprint(2, [b]))
  })
})

describe('entriesSinceLastAdoption', () => {
  it('直近の成功より後だけを返す', () => {
    const newest = entry({ detail: 'adoption=blocked code=x target=- ' })
    const success = entry({ result: 'acted', detail: 'adoption=adopted code=- target=item ' })
    const older = entry({ detail: 'adoption=blocked code=y target=- ' })

    expect(entriesSinceLastAdoption([newest, success, older])).toEqual([newest])
  })
})

describe('summarizeAdoptionFailure — 画面に出す「いつから / 何回」', () => {
  it('escalation が無ければ障害として出さない', () => {
    expect(summarizeAdoptionFailure([entry()])).toBeUndefined()
  })

  it('いまの分類が始まった時点から数える（終わった別の障害を混ぜない）', () => {
    // 新しい順。いまは diagnosis_failed が続いていて、その前に別の障害があった。
    const entries = [
      entry({ result: 'escalated', detail: '通知', createdAt: '2026-09-18T00:10:00.000Z' }),
      entry({ result: 'diagnosis_failed', detail: 'CLI timed out', createdAt: '2026-09-18T00:09:00.000Z' }),
      entry({ result: 'escalated', detail: '通知', createdAt: '2026-09-18T00:05:00.000Z' }),
      entry({
        result: 'blocked',
        detail: 'adoption=proposal_unusable code=unparsable_proposal target=- ',
        createdAt: '2026-09-18T00:04:00.000Z',
      }),
    ]

    const summary = summarizeAdoptionFailure(entries)

    expect(summary?.failureClass).toBe('diagnosis_failed')
    // **前の障害の escalation を数えない。**
    expect(summary?.escalations).toBe(1)
    expect(summary?.since).toBe('2026-09-18T00:09:00.000Z')
  })

  it('採用に成功していれば障害は出ない', () => {
    expect(summarizeAdoptionFailure([
      entry({ result: 'acted', detail: 'adoption=adopted code=- target=item ' }),
      entry({ result: 'escalated', detail: '通知' }),
    ])).toBeUndefined()
  })
})
