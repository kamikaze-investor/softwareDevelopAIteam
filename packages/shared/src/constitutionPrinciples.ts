import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const CONTROL_CONTEXT_DIR_CANDIDATES = [
  '/workspace/control',
  path.resolve(process.cwd(), '../..'),
  path.resolve(process.cwd()),
] as const

const CONSTITUTION_PATHS = [
  '/workspace/control/specs/00_constitution.md',
  path.resolve(process.cwd(), '../../specs/00_constitution.md'),
  path.resolve(process.cwd(), 'specs/00_constitution.md'),
]

const DECISION_AUTHORITY_PATHS = [
  '/workspace/control/specs/22_safety_approval_design_principle.md',
  path.resolve(process.cwd(), '../../specs/22_safety_approval_design_principle.md'),
  path.resolve(process.cwd(), 'specs/22_safety_approval_design_principle.md'),
]

const MAX_PRINCIPLE_SECTION_CHARS = 16_000
const MAX_PRINCIPLE_EXCERPT_CHARS = 40_000

export const CONSTITUTION_PRINCIPLE_SECTION_LABELS = [
  '3.14',
  '3.15',
  '3.16',
  '3.17',
  '3.18',
] as const

export const DECISION_AUTHORITY_SECTION_LABELS = ['1-2', '1-3', '14-3'] as const

export const DECISION_AUTHORITY_PRINCIPLE_IDS = DECISION_AUTHORITY_SECTION_LABELS.map(
  (label) => `specs/22 §${label}`,
)

function constitutionPathForControlContextDir(controlContextDir: string): string {
  return controlContextDir === '/workspace/control'
    ? '/workspace/control/specs/00_constitution.md'
    : path.resolve(controlContextDir, 'specs/00_constitution.md')
}

export function resolveDefaultControlContextDir(
  candidateDirs: readonly string[] = CONTROL_CONTEXT_DIR_CANDIDATES,
): string {
  for (const candidateDir of candidateDirs) {
    if (existsSync(constitutionPathForControlContextDir(candidateDir))) {
      return candidateDir
    }
  }

  return candidateDirs[0] ?? process.cwd()
}

/**
 * Constitution 3.14〜3.18（AI Team OS共通行動原則）の読み込み結果。
 *
 * `ok: false`を空文字と同一視して黙って無視すると、「参照だけがpromptに入り
 * 本文がLLMへ届いていない」未伝播状態を正常扱いしてしまう。呼び出し側は必ず
 * `ok`を見て、失敗を観測可能にし、promptにも未取得であることを示すこと。
 */
export type ConstitutionPrinciplesResult =
  | { ok: true; text: string }
  | { ok: false; reason: string; triedPaths: readonly string[] }

const resultCache = new Map<string, ConstitutionPrinciplesResult>()

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractNamedMarkdownSection(content: string, label: string): string | undefined {
  const headingPattern = new RegExp(
    `^(#{1,6})\\s+${escapeRegExp(label)}(?:[.\\s]|$).*?$`,
    'mu',
  )
  const match = headingPattern.exec(content)
  if (!match || match.index === undefined) return undefined

  const headingLevel = match[1].length
  const remaining = content.slice(match.index)
  const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s+`, 'mu')
  const afterHeading = remaining.slice(match[0].length)
  const nextHeading = nextHeadingPattern.exec(afterHeading)
  const end = nextHeading?.index === undefined
    ? remaining.length
    : match[0].length + nextHeading.index
  const section = remaining.slice(0, end).trim()
  return section.length > 0 ? section : undefined
}

/**
 * Existing markdown principle extraction, generalized to an explicit bounded list of sections.
 * Every requested section must be present; partial excerpts are rejected so callers can warn.
 */
export function loadNamedMarkdownSections(
  candidatePaths: readonly string[],
  sectionLabels: readonly string[],
): ConstitutionPrinciplesResult {
  const cacheKey = ['named-sections', ...candidatePaths, '--', ...sectionLabels].join('\0')
  const cached = resultCache.get(cacheKey)
  if (cached !== undefined) return cached

  const failures: string[] = []
  for (const candidatePath of candidatePaths) {
    let content: string
    try {
      content = readFileSync(candidatePath, 'utf-8')
    } catch (err: unknown) {
      failures.push(`${candidatePath}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    const sections: string[] = []
    let invalidReason: string | undefined
    for (const label of sectionLabels) {
      const section = extractNamedMarkdownSection(content, label)
      if (section === undefined) {
        invalidReason = `section ${label} not found`
        break
      }
      if (section.length > MAX_PRINCIPLE_SECTION_CHARS) {
        invalidReason = `section ${label} exceeds ${MAX_PRINCIPLE_SECTION_CHARS} characters`
        break
      }
      sections.push(section)
    }

    if (invalidReason !== undefined) {
      failures.push(`${candidatePath}: ${invalidReason}`)
      continue
    }

    const text = sections.join('\n\n').trim()
    if (text.length === 0 || text.length > MAX_PRINCIPLE_EXCERPT_CHARS) {
      failures.push(`${candidatePath}: requested excerpt is empty or exceeds ${MAX_PRINCIPLE_EXCERPT_CHARS} characters`)
      continue
    }

    const result: ConstitutionPrinciplesResult = { ok: true, text }
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

/** Constitution 3.14〜3.18 の本文を読み込む。成否を区別して返す。 */
export function loadConstitutionPrinciples(
  candidatePaths: readonly string[] = CONSTITUTION_PATHS,
): ConstitutionPrinciplesResult {
  return loadNamedMarkdownSections(candidatePaths, CONSTITUTION_PRINCIPLE_SECTION_LABELS)
}

export function loadDecisionAuthorityPrinciples(
  candidatePaths: readonly string[] = DECISION_AUTHORITY_PATHS,
): ConstitutionPrinciplesResult {
  return loadNamedMarkdownSections(candidatePaths, DECISION_AUTHORITY_SECTION_LABELS)
}

export function decisionAuthorityPathForControlContextDir(controlContextDir: string): string {
  return controlContextDir === '/workspace/control'
    ? '/workspace/control/specs/22_safety_approval_design_principle.md'
    : path.resolve(controlContextDir, 'specs/22_safety_approval_design_principle.md')
}

/** 未取得であることをpromptへ明示する文面（適用済みと見分けるために必須）。 */
const PRINCIPLES_UNAVAILABLE_NOTICE = [
  '【注意】AI Team OS共通行動原則（`specs/00_constitution.md` 3.14〜3.18）の本文を取得できませんでした。',
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
  return `[constitution] AI Team OS共通行動原則（3.14〜3.18）の本文を取得できませんでした: ${result.reason}`
}

const DECISION_AUTHORITY_UNAVAILABLE_NOTICE = [
  '【注意】Decision Authority Principle（`specs/22_safety_approval_design_principle.md` §1-2 / §1-3 / §14-3）を取得できませんでした。',
  'この応答では該当原則を適用済みとして扱わず、権限境界の判定を正常扱いしないでください。',
].join('\n')

export function buildDecisionAuthorityPrinciplesPrompt(
  result: ConstitutionPrinciplesResult,
): string {
  return result.ok ? result.text : DECISION_AUTHORITY_UNAVAILABLE_NOTICE
}

export function formatDecisionAuthorityPrinciplesWarning(
  result: ConstitutionPrinciplesResult,
): string | undefined {
  if (result.ok) return undefined
  return `[decision-authority] specs/22 §1-2 / §1-3 / §14-3 の本文を取得できませんでした: ${result.reason}`
}
