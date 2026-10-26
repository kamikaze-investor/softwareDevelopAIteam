import { describe, expect, it } from 'vitest'
import { parseFirstJsonObject } from './firstJsonObject'

describe('parseFirstJsonObject', () => {
  it('完全な object の後ろに余計な `}` があっても object を取り出す（2026-10-26 #2cae0d07 の実例の形）', () => {
    expect(parseFirstJsonObject('{"implementationScope":"x","respondsTo":"y"}}')).toEqual({
      implementationScope: 'x',
      respondsTo: 'y',
    })
  })

  it('object の後ろの補足文に括弧があっても object を取り出す', () => {
    expect(parseFirstJsonObject('{"a":1}\n\nNote: scope is {narrow}.')).toEqual({ a: 1 })
  })

  it('前置きの文に括弧があっても、JSON として parse できる最初の object を返す', () => {
    expect(parseFirstJsonObject('Answer (see {below}):\n{"a":{"b":[1,2]}}')).toEqual({ a: { b: [1, 2] } })
  })

  it('閉じない `{` が前にあっても、後ろの完全な object を取り出す', () => {
    expect(parseFirstJsonObject('Prefix { unfinished\n{"a":1}')).toEqual({ a: 1 })
  })

  it('文字列リテラル内の括弧と escape は数えない', () => {
    expect(parseFirstJsonObject('{"text":"brace } and \\" quote {","n":1} trailing }')).toEqual({
      text: 'brace } and " quote {',
      n: 1,
    })
  })

  it('```json fence があれば fence の中を優先する', () => {
    expect(parseFirstJsonObject('{"outside":true}\n```json\n{"inside":true}\n```')).toEqual({ inside: true })
  })

  it('閉じていない object・object が無い応答・tool_call 本文は undefined', () => {
    expect(parseFirstJsonObject('{"a":1')).toBeUndefined()
    expect(parseFirstJsonObject('no json here')).toBeUndefined()
    expect(parseFirstJsonObject('<tool_call><function=bash><parameter=command>ls</parameter></function></tool_call>'))
      .toBeUndefined()
  })
})
