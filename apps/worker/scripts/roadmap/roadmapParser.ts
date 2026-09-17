export const ALLOWED_ROADMAP_STATES = [
  'planned',
  'in_progress',
  'blocked',
  'deferred',
  'done',
] as const

export type RoadmapState = (typeof ALLOWED_ROADMAP_STATES)[number]

export type CheckboxState = 'checked' | 'unchecked'

export type RoadmapIssueCode =
  | 'duplicate_id'
  | 'follow_up_shaped_id'
  | 'invalid_metadata'
  | 'invalid_state'
  | 'missing_checkbox'
  | 'checkbox_state_mismatch'

export interface RoadmapIssue {
  code: RoadmapIssueCode
  message: string
  id?: string
  line?: number
}

export interface ParsedRoadmapItem {
  id: string
  state: string
  checkbox: CheckboxState | null
  title: string
  metadataLineIndex: number
  checkboxLineIndex: number | null
}

export interface RoadmapItem extends ParsedRoadmapItem {
  state: RoadmapState
  checkbox: CheckboxState
  checkboxLineIndex: number
}

export interface RoadmapParseResult {
  items: ParsedRoadmapItem[]
  issues: RoadmapIssue[]
}

export interface RoadmapUpdateResult {
  markdown: string
  changed: boolean
  item: RoadmapItem
}

export class RoadmapValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: RoadmapIssue[],
  ) {
    super(message)
    this.name = 'RoadmapValidationError'
  }
}

/**
 * `id` と `state` の後ろに、追加の `key=value` 属性を任意個許す。
 *
 * ledger では `priority=high` のような補足属性が実際に使われているが、以前は2属性しか
 * 受け付けず `invalid_metadata` として弾いていた。弾かれた項目は `getValidRoadmapItems()`
 * から見えなくなり、さらに `roadmap:check` が落ちるため `roadmap:sync` も実行できず、
 * `docs/PROJECT_CURRENT_STATE.md` の自動生成ブロックが stale のまま放置されていた。
 *
 * 追加属性は**解釈せず素通しする**（本 parser の関心は id / state / checkbox だけ）。
 * 新しい属性を足すたびに parser を改修せずに済むようにするためで、属性を意味づける
 * 新しいモデルは追加しない。
 */
const ROADMAP_METADATA_REGEX =
  /^\s*<!--\s+roadmap:id=([^\s]+)\s+state=([^\s]+)((?:\s+[A-Za-z_][\w-]*=[^\s]+)*)\s+-->\s*$/
const ROADMAP_METADATA_PREFIX_REGEX = /^\s*<!--\s*roadmap:/

/**
 * checkbox マーカーは `x`（完了）/ ` `（未完了）に加えて `~` も受け付ける。
 *
 * ledger では進行中を `[~]` と書く箇所があるが、以前は受け付けず `missing_checkbox`
 * として扱われていた。`~` は**完了ではない**マーカーなので、既存の
 * `CheckboxState`（`checked` | `unchecked`）のうち `unchecked` へ写す。
 * 新しい CheckboxState は追加しない（`expectedCheckboxForState()` の
 * 「done 以外は unchecked」という既存判定がそのまま成立する）。
 */
const CHECKBOX_LINE_REGEX = /^(\s*\d+\.\s+\[)( |x|~)(\]\s+)(.*)$/
const STATE_SET: ReadonlySet<string> = new Set(ALLOWED_ROADMAP_STATES)

export function isRoadmapState(value: string): value is RoadmapState {
  return STATE_SET.has(value)
}

/**
 * follow-up の Task identity（`<id>#<sequence>`）と衝突する形の `roadmap:id` を禁じる。
 *
 * ledger が `foo` と `foo#2` を同時に持てると、`foo` の follow-up が `foo#2` を名乗り、
 * 実在の別項目になりすます。provenance も sequence も上限計算も壊れる（独立レビュー 3巡目）。
 * **曖昧さは解決するのではなく、成立させないのが正しい。** 現行 ledger に該当 id は無いので、
 * これは将来そういう id が書かれるのを止める validation である。
 */
export function isFollowUpShapedRoadmapId(id: string): boolean {
  return /#\d+$/.test(id)
}

/**
 * 自律採用（PL の `adopt_roadmap_item`）の対象にしてよい state。
 *
 * **allowlist である。** 除外リスト（「done 以外は採用可」）にすると、新しい state を足したときの
 * 既定が「採用可能」になり、意味が決まる前に PL が拾ってしまう。既定は採用不可でなければならない。
 *
 * - `planned` … 現在着手してよい。**唯一の採用対象**
 * - `in_progress` … 着手済み。**採用しない**（CEO 決定 2026-09-15 / PR #211）。
 *   既に始まっている作業を重ねて採用する意味が無い。残作業の継続は adoption の責務ではなく、
 *   既存の Task / resume / continuation 経路が扱う
 * - `deferred` … 「現在は着手しない」という ledger 上の意思表示。**採用しない**
 * - `blocked` … 前提が解消していない。**採用しない**
 * - `done` … 完了済み（履歴）。**採用しない**
 *
 * この判定をここに置くのは、`ALLOWED_ROADMAP_STATES` / `RoadmapState` /
 * `expectedCheckboxForState()` という **state の意味づけが既にこのファイルに集約されている**ためである。
 * 採用経路3箇所（`readAdoptionCandidates` / `adoptRoadmapItem` / `checkRoadmapItemAlignment`）は
 * いずれも既にこの parser を import しており、判定を重複実装せず共有できる。
 */
export const ADOPTABLE_ROADMAP_STATES: readonly RoadmapState[] = ['planned']

const ADOPTABLE_STATE_SET: ReadonlySet<string> = new Set(ADOPTABLE_ROADMAP_STATES)

/**
 * その state の Roadmap 項目を自律採用してよいか。
 *
 * 未知の文字列は `false`（fail-closed）。state 文字列をそのまま受けるのは、
 * 呼び出し側が `RoadmapItem.state` をそのまま渡せるようにするためである。
 */
export function isRoadmapItemAdoptable(state: string): boolean {
  return ADOPTABLE_STATE_SET.has(state)
}

export function parseRoadmapMarkdown(markdown: string): RoadmapParseResult {
  const lines = splitMarkdown(markdown).lines
  const items: ParsedRoadmapItem[] = []
  const issues: RoadmapIssue[] = []

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const metadataMatch = line.match(ROADMAP_METADATA_REGEX)

    if (!metadataMatch) {
      if (ROADMAP_METADATA_PREFIX_REGEX.test(line)) {
        issues.push({
          code: 'invalid_metadata',
          message: `Invalid roadmap metadata comment at line ${lineIndex + 1}`,
          line: lineIndex + 1,
        })
      }
      continue
    }

    const [, id, state] = metadataMatch
    if (id !== undefined && isFollowUpShapedRoadmapId(id)) {
      issues.push({
        code: 'follow_up_shaped_id',
        id,
        message:
          `Roadmap id "${id}" ends with "#<number>", which collides with follow-up task identities`,
        line: lineIndex + 1,
      })
    }
    const checkboxLineIndex = findNextNonEmptyLine(lines, lineIndex + 1)
    const checkboxLine = checkboxLineIndex === null ? null : lines[checkboxLineIndex]
    const checkboxMatch = checkboxLine?.match(CHECKBOX_LINE_REGEX) ?? null
    const checkbox = checkboxMatch ? parseCheckboxState(checkboxMatch[2]) : null
    const title = checkboxMatch ? extractTitle(checkboxMatch[4]) : ''

    const item: ParsedRoadmapItem = {
      id,
      state,
      checkbox,
      title,
      metadataLineIndex: lineIndex,
      checkboxLineIndex,
    }
    items.push(item)

    if (!isRoadmapState(state)) {
      issues.push({
        code: 'invalid_state',
        id,
        line: lineIndex + 1,
        message: `Roadmap item "${id}" has invalid state "${state}"`,
      })
    }

    if (!checkboxMatch || checkboxLineIndex === null) {
      issues.push({
        code: 'missing_checkbox',
        id,
        line: lineIndex + 1,
        message: `Roadmap metadata "${id}" is not followed by a checkbox line`,
      })
      continue
    }

    if (isRoadmapState(state)) {
      const expectedCheckbox = expectedCheckboxForState(state)
      if (checkbox !== expectedCheckbox) {
        issues.push({
          code: 'checkbox_state_mismatch',
          id,
          line: checkboxLineIndex + 1,
          message: `Roadmap item "${id}" has state "${state}" but checkbox is ${formatCheckboxState(checkbox)}`,
        })
      }
    }
  }

  issues.push(...findDuplicateIdIssues(items))

  return { items, issues }
}

export function getValidRoadmapItems(markdown: string): RoadmapItem[] {
  const parseResult = parseRoadmapMarkdown(markdown)
  if (parseResult.issues.length > 0) {
    throw new RoadmapValidationError('Roadmap validation failed', parseResult.issues)
  }

  return parseResult.items.map((item) => {
    if (!isRoadmapState(item.state) || item.checkbox === null || item.checkboxLineIndex === null) {
      throw new RoadmapValidationError('Roadmap validation failed', [
        {
          code: 'invalid_metadata',
          id: item.id,
          line: item.metadataLineIndex + 1,
          message: `Roadmap item "${item.id}" is not valid`,
        },
      ])
    }

    return {
      ...item,
      state: item.state,
      checkbox: item.checkbox,
      checkboxLineIndex: item.checkboxLineIndex,
    }
  })
}

export function updateRoadmapState(
  markdown: string,
  id: string,
  nextState: string,
): RoadmapUpdateResult {
  if (!isRoadmapState(nextState)) {
    throw new RoadmapValidationError(`Invalid roadmap state "${nextState}"`, [
      {
        code: 'invalid_state',
        id,
        message: `Invalid roadmap state "${nextState}". Allowed states: ${ALLOWED_ROADMAP_STATES.join(', ')}`,
      },
    ])
  }

  const parseResult = parseRoadmapMarkdown(markdown)
  const targetItems = parseResult.items.filter((item) => item.id === id)

  if (targetItems.length === 0) {
    throw new RoadmapValidationError(`Roadmap item "${id}" was not found`, [
      {
        code: 'invalid_metadata',
        id,
        message: `Roadmap item "${id}" was not found`,
      },
    ])
  }

  const blockingIssues = parseResult.issues.filter((issue) => {
    return !(issue.code === 'checkbox_state_mismatch' && issue.id === id)
  })

  if (blockingIssues.length > 0) {
    throw new RoadmapValidationError('Roadmap validation failed', blockingIssues)
  }

  if (targetItems.length > 1) {
    throw new RoadmapValidationError(`Roadmap item "${id}" is duplicated`, [
      {
        code: 'duplicate_id',
        id,
        message: `Roadmap item "${id}" is duplicated`,
      },
    ])
  }

  const targetItem = targetItems[0]
  if (targetItem.checkboxLineIndex === null || targetItem.checkbox === null) {
    throw new RoadmapValidationError(`Roadmap item "${id}" is not followed by a checkbox line`, [
      {
        code: 'missing_checkbox',
        id,
        line: targetItem.metadataLineIndex + 1,
        message: `Roadmap metadata "${id}" is not followed by a checkbox line`,
      },
    ])
  }

  const { lines, lineEnding } = splitMarkdown(markdown)
  lines[targetItem.metadataLineIndex] = lines[targetItem.metadataLineIndex].replace(
    /state=[^\s]+/,
    `state=${nextState}`,
  )
  lines[targetItem.checkboxLineIndex] = syncCheckboxLine(lines[targetItem.checkboxLineIndex], nextState)

  const nextMarkdown = joinMarkdown(lines, lineEnding)
  const nextItems = getValidRoadmapItems(nextMarkdown)
  const nextItem = nextItems.find((item) => item.id === id)

  if (!nextItem) {
    throw new RoadmapValidationError(`Roadmap item "${id}" was not found after update`, [
      {
        code: 'invalid_metadata',
        id,
        message: `Roadmap item "${id}" was not found after update`,
      },
    ])
  }

  return {
    markdown: nextMarkdown,
    changed: nextMarkdown !== markdown,
    item: nextItem,
  }
}

export function formatRoadmapIssues(issues: readonly RoadmapIssue[]): string {
  return issues.map(formatRoadmapIssue).join('\n')
}

function splitMarkdown(markdown: string): { lines: string[]; lineEnding: string } {
  return {
    lines: markdown.split(/\r\n|\n/),
    lineEnding: markdown.includes('\r\n') ? '\r\n' : '\n',
  }
}

function joinMarkdown(lines: readonly string[], lineEnding: string): string {
  return lines.join(lineEnding)
}

function findNextNonEmptyLine(lines: readonly string[], startIndex: number): number | null {
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    if (lines[lineIndex].trim().length > 0) {
      return lineIndex
    }
  }

  return null
}

function parseCheckboxState(value: string): CheckboxState {
  return value === 'x' ? 'checked' : 'unchecked'
}

function expectedCheckboxForState(state: RoadmapState): CheckboxState {
  return state === 'done' ? 'checked' : 'unchecked'
}

function syncCheckboxLine(line: string, state: RoadmapState): string {
  // done は必ず `x` へ寄せる。非 done のときは**既存のマーカーを保持する**:
  // `[~]`（進行中）を `[ ]` へ書き換えると、著者が明示した進行中の情報を
  // state 更新の副作用で失う。`~` も `[ ]` も等しく「未完了」なので、
  // `expectedCheckboxForState()` の判定はどちらでも成立する。
  const current = line.match(CHECKBOX_LINE_REGEX)?.[2]
  const checkboxValue = state === 'done' ? 'x' : current === '~' ? '~' : ' '
  return line.replace(CHECKBOX_LINE_REGEX, `$1${checkboxValue}$3$4`)
}

function extractTitle(checkboxText: string): string {
  const separatorIndex = checkboxText.indexOf('—')
  if (separatorIndex === -1) {
    return checkboxText.trim()
  }

  return checkboxText.slice(0, separatorIndex).trim()
}

function findDuplicateIdIssues(items: readonly ParsedRoadmapItem[]): RoadmapIssue[] {
  const firstLineById = new Map<string, number>()
  const issues: RoadmapIssue[] = []

  for (const item of items) {
    const firstLine = firstLineById.get(item.id)
    if (firstLine === undefined) {
      firstLineById.set(item.id, item.metadataLineIndex + 1)
      continue
    }

    issues.push({
      code: 'duplicate_id',
      id: item.id,
      line: item.metadataLineIndex + 1,
      message: `Roadmap item "${item.id}" is duplicated (first seen at line ${firstLine})`,
    })
  }

  return issues
}

function formatRoadmapIssue(issue: RoadmapIssue): string {
  const location = issue.line === undefined ? '' : `line ${issue.line}: `
  return `${location}${issue.message}`
}

function formatCheckboxState(state: CheckboxState | null): string {
  if (state === 'checked') {
    return '[x]'
  }

  if (state === 'unchecked') {
    return '[ ]'
  }

  return 'missing'
}
