import { readFileSync } from 'node:fs'
import path from 'node:path'

const CONSTITUTION_PATHS = [
  '/workspace/control/specs/00_constitution.md',
  path.resolve(process.cwd(), '../../specs/00_constitution.md'),
  path.resolve(process.cwd(), 'specs/00_constitution.md'),
]

/**
 * Constitution 3.14〜3.15（AI Team OS共通行動原則）の読み込み結果。
 *
 * `ok: false`を空文字と同一視して黙って無視すると、「参照だけがpromptに入り
 * 本文がLLMへ届いていない」未伝播状態を正常扱いしてしまう。呼び出し側は必ず
 * `ok`を見て、失敗を観測可能にし、promptにも未取得であることを示すこと。
 */
export type ConstitutionPrinciplesResult =
  | { ok: true; text: string }
  | { ok: false; reason: string; triedPaths: readonly string[] }

const resultCache = new Map<string, ConstitutionPrinciplesResult>()

/** Constitution 3.14〜3.15 の本文を読み込む。成否を区別して返す。 */
export function loadConstitutionPrinciples(
  candidatePaths: readonly string[] = CONSTITUTION_PATHS,
): ConstitutionPrinciplesResult {
  const cacheKey = candidatePaths.join('\0')
  const cached = resultCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const failures: string[] = []

  for (const candidatePath of candidatePaths) {
    let content: string
    try {
      content = readFileSync(candidatePath, 'utf-8')
    } catch (err: unknown) {
      failures.push(`${candidatePath}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    const start = content.search(/^##\s+3\.14\b/mu)
    if (start < 0) {
      failures.push(`${candidatePath}: section 3.14 not found`)
      continue
    }

    const remaining = content.slice(start)
    const end = remaining.search(/^#{1,2}\s+4\./mu)
    const section = (end >= 0 ? remaining.slice(0, end) : remaining).trim()
    if (!section) {
      failures.push(`${candidatePath}: section 3.14-3.15 is empty`)
      continue
    }

    const result: ConstitutionPrinciplesResult = { ok: true, text: section }
    resultCache.set(cacheKey, result)
    return result
  }

  const result: ConstitutionPrinciplesResult = {
    ok: false,
    reason: failures.join(' / ') || 'no candidate path was tried',
    triedPaths: candidatePaths,
  }
  resultCache.set(cacheKey, result)
  return result
}

/** 未取得であることをpromptへ明示する文面（適用済みと見分けるために必須）。 */
const PRINCIPLES_UNAVAILABLE_NOTICE = [
  '【注意】AI Team OS共通行動原則（`specs/00_constitution.md` 3.14〜3.15）の本文を取得できませんでした。',
  'この応答では共通行動原則は適用済みとして扱えません。判断に迷う場合は保守的に振る舞い、',
  '明示的なSafety Ruleを常に優先してください。',
].join('\n')

/**
 * promptへ埋め込むブロックを組み立てる。
 * 取得できた場合は本文、できなかった場合は「未取得」であることを明示する。
 * どちらの場合も文字列は非空なので、黙って省略されることはない。
 */
export function buildConstitutionPrinciplesPrompt(
  result: ConstitutionPrinciplesResult,
): string {
  return result.ok ? result.text : PRINCIPLES_UNAVAILABLE_NOTICE
}

/** 取得に失敗したときの警告文（既存のログ経路へ出す）。 */
export function formatConstitutionPrinciplesWarning(
  result: ConstitutionPrinciplesResult,
): string | undefined {
  if (result.ok) return undefined
  return `[constitution] AI Team OS共通行動原則（3.14〜3.15）の本文を取得できませんでした: ${result.reason}`
}
