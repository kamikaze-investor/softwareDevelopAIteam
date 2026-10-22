import { describe, expect, it } from 'vitest'

import { approvalIdLabel, approvalTargetDescription, copyApprovalId } from './approvalIdentity'

describe('approvalIdentity — 操作対象の Approval request を識別する', () => {
  it('Approval ID を省略・加工せずそのまま表示する', () => {
    expect(approvalIdLabel('approval-20261015-fdce47e9')).toBe('承認ID: approval-20261015-fdce47e9')
  })

  it('確認時の説明に Approval ID と Task ID の両方を出す', () => {
    expect(approvalTargetDescription({ id: 'approval-20261015-fdce47e9', taskId: 'b6d4097a' }))
      .toBe('承認ID: approval-20261015-fdce47e9\nTask ID: b6d4097a')
  })

  it('同じ Task の複数の Approval request も ID で区別できる', () => {
    const first = approvalTargetDescription({ id: 'approval-20261014-b8522685', taskId: 'b6d4097a' })
    const second = approvalTargetDescription({ id: 'approval-20261015-fdce47e9', taskId: 'b6d4097a' })
    expect(first).not.toBe(second)
  })

  it('コピーは Approval ID だけを書き込み、完了メッセージを返す', () => {
    const written: string[] = []
    const message = copyApprovalId('approval-20261015-fdce47e9', (text) => written.push(text))
    expect(written).toEqual(['approval-20261015-fdce47e9'])
    expect(message).toBe('承認ID: approval-20261015-fdce47e9 をコピーしました')
  })
})
