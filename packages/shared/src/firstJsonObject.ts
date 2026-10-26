/**
 * model 応答から**最初の完全な JSON object** を取り出して parse する。
 *
 * 以前の各 parser は `raw.match(/(\{[\s\S]+\})/)`（最初の `{` から**最後の** `}` まで）を JSON.parse していた。
 * これだと、完全な object の後ろに1文字でも `}` や補足文の括弧が付くと全体が parse 不能になり、
 * 中身の正しい設計成果物が捨てられる（2026-10-26 Production `#2cae0d07`: PL revision の応答が
 * 6223 文字の正しい spec の後ろに `}` を1つ余計に付けていただけで `unparsable_revision` になった）。
 *
 * ここでは文字列リテラルと escape を考慮して括弧の対応を取り、**閉じた最初の object** だけを parse する。
 * ```json fence があれば fence の中を優先する（従来と同じ優先順位）。
 *
 * **中身の検証はしない。** 各 parser が従来どおり必須項目・型を検証し、その後も Gate と formal
 * Design Review を通る。ここが緩めるのは「object の外側の余計な文字」だけである。
 */
export function parseFirstJsonObject(raw: string): unknown {
  const fenced = /```json\s*([\s\S]+?)\s*```/.exec(raw)?.[1]
  const source = fenced ?? raw

  // 先頭の `{` が object の開始とは限らない（前置きの文に括弧が含まれうる）。
  // 閉じた object が JSON として parse できた最初のものを返す。
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    const end = findMatchingBrace(source, start)
    // 閉じない `{`（前置きの文の括弧など）は object ではない。次の候補から探し直す。
    if (end === undefined) continue
    try {
      return JSON.parse(source.slice(start, end + 1)) as unknown
    } catch {
      // この位置の `{` は JSON object ではなかった。次の候補へ。
    }
  }
  return undefined
}

/** `source[start]` の `{` に対応する `}` の位置。文字列リテラル内の括弧は数えない。閉じなければ undefined。 */
function findMatchingBrace(source: string, start: number): number | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return undefined
}
