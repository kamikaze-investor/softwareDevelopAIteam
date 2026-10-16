import { describe, it, expect } from 'vitest'
import { SAFE_WORK_COMMAND_KINDS } from '@ai-team/shared'
import { SAFE_WORK_ALLOWED_COMMAND_KINDS } from './guards/gatePolicy.js'

/**
 * safe work の集合は2箇所にある: Worker の実行可否（`guards/gatePolicy.ts`。AI 編集禁止の Control
 * ファイルなので shared から import させられない）と、API の /gate/check が「誰も待たない承認依頼を
 * 作らない」判定に使う shared の `SAFE_WORK_COMMAND_KINDS`。
 * 食い違うと、API は Worker が実際には止まる kind の依頼を作らない（または逆）ことになる
 * （2026-10-16 b8d0fc5d）。片方だけ変えたらここで落とす。
 */
describe('SAFE_WORK kinds drift', () => {
  it('gatePolicy の SAFE_WORK_ALLOWED_COMMAND_KINDS と shared の SAFE_WORK_COMMAND_KINDS は同じ集合', () => {
    expect([...SAFE_WORK_ALLOWED_COMMAND_KINDS].sort()).toEqual([...SAFE_WORK_COMMAND_KINDS].sort())
    expect(new Set(SAFE_WORK_ALLOWED_COMMAND_KINDS).size).toBe(SAFE_WORK_ALLOWED_COMMAND_KINDS.length)
  })
})
