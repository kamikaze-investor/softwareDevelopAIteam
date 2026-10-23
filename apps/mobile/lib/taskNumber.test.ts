import { describe, expect, it } from 'vitest'
import { formatTaskNumber, taskNumberLabel } from './taskNumber'

describe('formatTaskNumber', () => {
  it('Task id の先頭 8 文字を # 付きで返す（報告で使う呼び名と同じ）', () => {
    expect(formatTaskNumber('b8d0fc5d-e4c1-40c3-bb21-c5e41adb039a')).toBe('#b8d0fc5d')
  })

  it('8 文字未満の id はそのまま使う', () => {
    expect(formatTaskNumber('abc')).toBe('#abc')
  })

  it.each([undefined, null, '', '   '])('id が無い（%s）ときは null', (value) => {
    expect(formatTaskNumber(value)).toBeNull()
  })
})

describe('taskNumberLabel', () => {
  it('画面表記は「タスク番号 #xxxxxxxx」', () => {
    expect(taskNumberLabel('b8d0fc5d-e4c1-40c3-bb21-c5e41adb039a')).toBe('タスク番号 #b8d0fc5d')
  })

  it('id が無いときは null（何も表示しない）', () => {
    expect(taskNumberLabel(undefined)).toBeNull()
  })
})
