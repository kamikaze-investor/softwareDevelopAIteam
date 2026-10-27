import { createHash } from 'node:crypto'

/**
 * Design materiality（設計判断の重大性）の **observe-only** 検出。
 *
 * 目的: author / PL の自己分類（「Class B」「enforcement-only」等）に依らず、既存の責務・承認済み機構・
 * Authority 境界・状態遷移・設計契約を変える diff を、実 diff から独立に候補として挙げる。
 * 回帰ケースは PR #404 の e405c7c7（CEO 指示の Challenge stage 削除が予算会計 PR に紛れた）。
 *
 * **このモジュールは判定に一切影響しない。** autoReview.ts / workflow から呼ばれず、
 * offline 評価（apps/worker/scripts/designMaterialityEval.ts）だけが使う。CI への配線は
 * quota 結合の扱いを CEO が決めてから別 PR で行う（2026-10-23 CEO 判断 Q1/Q3、M4 blocking は未承認）。
 *
 * 責務分離（CEO 条件）:
 * - detection（`buildDetectionPrompt` / `parseDetection`）は候補を挙げるだけで、変更の良し悪しも
 *   「振る舞いが保たれているか」も判断しない。
 * - correctness（`buildEvaluationPrompt` / `parseEvaluation`）だけが、責務が preserved / moved / lost
 *   のどれかと、設計記録との整合を判断する。detection の推論文は渡さない（候補一覧だけ渡す）。
 */

export const DESIGN_MATERIALITY_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// 決定的 signal（S1–S4）
// ---------------------------------------------------------------------------

export type MaterialitySignalKind =
  /** S1: non-test source から契約メンバー（union literal / enum member / case arm / const map key）が消えた */
  | 'contract_member_removed'
  /** S2: non-test source から設計の出自（CEO 指示・ADR・decision 等）を示すコメント行が消えた */
  | 'provenance_comment_removed'
  /** S3: non-test source file が削除された */
  | 'source_file_deleted'
  /** S4: test title が消えた（どの test file にも残っていない） */
  | 'behavior_test_removed'

export interface MaterialitySignal {
  /** `sha256(file|kind|token)` の先頭12桁。repeat 間・detection と correctness の突き合わせに使う */
  id: string
  kind: MaterialitySignalKind
  file: string
  /** 消えたもの（literal / 正規化したコメント行 / file path / test title） */
  token: string
}

const MAX_TOKEN_CHARS = 200

export function isTestFile(file: string): boolean {
  return /\.(test|spec)\.[cm]?[tj]sx?$/.test(file) || /(^|\/)__tests__\//.test(file)
}

function isCodeFile(file: string): boolean {
  return /\.[cm]?[tj]sx?$/.test(file)
}

const PROVENANCE_MARKER = /CEO|ＣＥＯ|\bADR\b|decision record|project_memory\/decisions|承認|指示/
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/

export function signalId(file: string, kind: MaterialitySignalKind, token: string): string {
  return createHash('sha256').update(`${file}|${kind}|${token}`).digest('hex').slice(0, 12)
}

function clip(text: string): string {
  return text.length > MAX_TOKEN_CHARS ? `${text.slice(0, MAX_TOKEN_CHARS)}…` : text
}

interface FileDiff {
  path: string
  deleted: boolean
  /** hunk 内の行（先頭の ' ' / '-' / '+' を含む）。hunk 境界は null */
  lines: Array<string | null>
}

/** `git diff` の unified diff を file 単位に分ける。rename / mode 行は無視する。 */
export function splitUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = []
  let current: FileDiff | undefined
  let inHunk = false
  for (const raw of diff.split(/\r?\n/)) {
    // 特殊文字を含む path は git が `"a/…" "b/…"` と quote する
    const header = raw.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/)
    if (header) {
      current = { path: header[2], deleted: false, lines: [] }
      files.push(current)
      inHunk = false
      continue
    }
    if (!current) continue
    if (!inHunk) {
      if (raw.startsWith('deleted file mode')) current.deleted = true
      if (raw.startsWith('--- a/') && current.deleted) current.path = raw.slice(6)
      if (raw.startsWith('--- "a/') && current.deleted) current.path = raw.slice(7).replace(/"$/, '')
      if (raw.startsWith('@@')) { inHunk = true; current.lines.push(null) }
      continue
    }
    if (raw.startsWith('@@')) { current.lines.push(null); continue }
    if (raw.startsWith('\\')) continue
    if (raw.startsWith(' ') || raw.startsWith('-') || raw.startsWith('+')) current.lines.push(raw)
  }
  return files
}

type ContractSubtype = 'union' | 'enum' | 'case' | 'map'

/**
 * 1 file の hunk 行から、契約メンバーを side（'-' / '+'）ごとに抜き出す。
 * enum / exported const object の block は、hunk 内に見えている opener（context 行を含む）から追う近似。
 */
function contractMembers(lines: ReadonlyArray<string | null>): { removed: Map<string, ContractCount>; added: Map<string, number> } {
  const removed = new Map<string, ContractCount>()
  const added = new Map<string, number>()
  // side ごとに block 状態を持つ（'-' 側の block と '+' 側の block は別物）
  const block: Record<'-' | '+', ContractSubtype | undefined> = { '-': undefined, '+': undefined }
  for (const line of lines) {
    if (line === null) { block['-'] = undefined; block['+'] = undefined; continue }
    const sign = line[0]
    const body = line.slice(1)
    const sides: Array<'-' | '+'> = sign === ' ' ? ['-', '+'] : sign === '-' ? ['-'] : ['+']
    const found: Array<[ContractSubtype, string]> = []

    const typeAlias = /^\s*(export\s+)?type\s+\w+(<[^>]*>)?\s*=/.test(body)
    // `| 'x'` は union member、`|| status === 'x'` は比較なので除く
    if (typeAlias || /^\s*\|(?!\|)/.test(body)) {
      for (const m of body.matchAll(/(['"])([^'"\n]{1,120})\1/g)) found.push(['union', m[2]])
    }
    const caseArm = body.match(/^\s*case\s+(['"])([^'"\n]{1,120})\1\s*:/)
    if (caseArm) found.push(['case', caseArm[2]])

    // 1行 enum（`enum Stage { Critic, Challenge }`）は opener と member が同じ行にある
    const inlineEnum = body.match(/\benum\s+\w+\s*\{([^}]*)\}/)
    if (inlineEnum) {
      // 初期化子の文字列・コメント内の `,` で切らないよう、両方を1回の走査で取り除いてから切る
      for (const member of stripStringsAndComments(inlineEnum[1]).split(',')) {
        const m = member.match(/^\s*([A-Za-z_]\w*)/)
        if (m) found.push(['enum', m[1]])
      }
    }

    for (const side of sides) {
      if (inlineEnum) break
      const opened = /\benum\s+\w+\s*\{/.test(body)
        ? 'enum'
        : /^\s*export\s+const\s+\w+(\s*:\s*[^=]+)?\s*=\s*\{\s*$/.test(body)
          ? 'map'
          : undefined
      if (opened) { block[side] = opened; continue }
      if (/^\s*\}/.test(body)) { block[side] = undefined; continue }
      const inBlock = block[side]
      if (inBlock === 'enum') {
        const m = body.match(/^\s*([A-Za-z_]\w*)\s*(=|,|$)/)
        if (m) found.push(['enum', m[1]])
      } else if (inBlock === 'map') {
        const m = body.match(/^\s*(['"]?)([A-Za-z_][\w-]*)\1\s*:/)
        if (m) found.push(['map', m[2]])
      }
    }

    if (sign === ' ') continue
    for (const [subtype, token] of found) {
      const key = `${subtype}:${token}`
      if (sign === '-') {
        const entry = removed.get(key)
        if (entry) entry.count++
        else removed.set(key, { token, count: 1 })
      } else {
        added.set(key, (added.get(key) ?? 0) + 1)
      }
    }
  }
  return { removed, added }
}

interface ContractCount { token: string; count: number }

/**
 * 1行のコードから文字列リテラルを `""` に、コメントを空白に置き換える。
 * 文字列とコメントを同じ走査で追うので、文字列内の `/*` もコメント内の `'` も取り違えない。
 */
export function stripStringsAndComments(line: string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      out += ' '
      i = end < 0 ? line.length : end + 2
    } else if (ch === '/' && line[i + 1] === '/') {
      break
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1
      out += '""'
      i = j + 1
    } else {
      out += ch
      i++
    }
  }
  return out
}

/**
 * unified diff から S1–S4 を決定的に計算する。
 *
 * - S1 / S2 は **file ごと・種別ごと** に相殺する（同じ literal を同じ file の別構文へ足しても S1 は消えない）。
 * - S4 の test title は全 file で相殺する（test の file 間移動は振る舞いの削除ではない）。
 * - 削除 file（S3）の中身も S1 / S2 の対象にする。
 */
export function computeMaterialitySignals(diff: string): MaterialitySignal[] {
  const signals: MaterialitySignal[] = []
  const push = (kind: MaterialitySignalKind, file: string, token: string) => {
    const clipped = clip(token)
    signals.push({ id: signalId(file, kind, clipped), kind, file, token: clipped })
  }
  const removedTitles = new Map<string, string>()
  const addedTitles = new Set<string>()

  for (const file of splitUnifiedDiff(diff)) {
    if (!isCodeFile(file.path)) continue
    if (isTestFile(file.path)) {
      for (const line of file.lines) {
        if (line === null || line[0] === ' ') continue
        const m = line.slice(1).match(/\b(?:it|test|describe)(?:\.\w+)*\(\s*(['"`])(.+?)\1/)
        if (!m) continue
        if (line[0] === '-') { if (!removedTitles.has(m[2])) removedTitles.set(m[2], file.path) } else addedTitles.add(m[2])
      }
      continue
    }

    if (file.deleted) push('source_file_deleted', file.path, file.path)

    const { removed, added } = contractMembers(file.lines)
    // 個数で相殺する（同じ case arm を2つ消して1つ足したなら、1つ消えている）
    for (const [key, { token, count }] of removed) if (count > (added.get(key) ?? 0)) push('contract_member_removed', file.path, token)

    const removedComments = new Map<string, string>()
    const addedComments = new Set<string>()
    for (const line of file.lines) {
      if (line === null || line[0] === ' ') continue
      const body = line.slice(1)
      if (!COMMENT_LINE.test(body) || !PROVENANCE_MARKER.test(body)) continue
      const normalized = body.replace(/\s+/g, ' ').trim()
      if (line[0] === '-') removedComments.set(normalized, normalized)
      else addedComments.add(normalized)
    }
    for (const text of removedComments.keys()) if (!addedComments.has(text)) push('provenance_comment_removed', file.path, text)
  }

  for (const [title, file] of removedTitles) if (!addedTitles.has(title)) push('behavior_test_removed', file, title)
  return signals
}

// ---------------------------------------------------------------------------
// base 設計記録の抜粋（決定的）
// ---------------------------------------------------------------------------

/** 設計記録として扱う base 側の場所（これ以外は抜粋しない） */
export const DESIGN_RECORD_ROOTS = ['tasks/roadmap.md', 'docs/project_memory/decisions/', 'specs/', 'AGENTS.md'] as const

export interface BaseRecordReader {
  /** base ref に存在する設計記録 file の一覧（DESIGN_RECORD_ROOTS 配下の .md） */
  listRecordFiles(): string[]
  /** base ref の file 内容。無ければ undefined */
  read(path: string): string | undefined
}

export interface RecordExcerpt {
  file: string
  /** 1 始まり */
  startLine: number
  token: string
  text: string
}

const MAX_EXCERPTS = 8
const EXCERPT_RADIUS = 6
export const MAX_EXCERPT_CHARS = 12_000

/**
 * 記録照合に使う token。S1 の literal と、non-test source の削除行に現れる識別子
 * （10文字以上で `_` か camelCase を含むもの）。短い・一般的な語は照合しない。
 */
export function excerptTokens(diff: string, signals: readonly MaterialitySignal[]): string[] {
  const tokens = new Set<string>()
  for (const s of signals) if (s.kind === 'contract_member_removed') tokens.add(s.token)
  for (const file of splitUnifiedDiff(diff)) {
    if (!isCodeFile(file.path) || isTestFile(file.path)) continue
    for (const line of file.lines) {
      if (line === null || line[0] !== '-') continue
      for (const m of line.slice(1).matchAll(/[A-Za-z_][A-Za-z0-9_]{9,}/g)) {
        if (/_/.test(m[0]) || /[a-z][A-Z]/.test(m[0])) tokens.add(m[0])
      }
    }
  }
  return [...tokens].sort()
}

/** token を含む base 設計記録の段落を、決定的な順序（token 順 → file 順 → 行順）で最大8件抜く。 */
export function extractBaseRecordExcerpts(reader: BaseRecordReader, tokens: readonly string[]): RecordExcerpt[] {
  const files = reader.listRecordFiles().slice().sort()
  const contents = new Map<string, string[]>()
  const linesOf = (file: string) => {
    let lines = contents.get(file)
    if (!lines) { lines = (reader.read(file) ?? '').split(/\r?\n/); contents.set(file, lines) }
    return lines
  }
  const excerpts: RecordExcerpt[] = []
  const covered = new Set<string>()
  let chars = 0
  for (const token of tokens) {
    for (const file of files) {
      const lines = linesOf(file)
      const index = lines.findIndex((l) => l.includes(token))
      if (index < 0) continue
      const start = Math.max(0, index - EXCERPT_RADIUS)
      const key = `${file}:${Math.floor(start / (EXCERPT_RADIUS * 2))}`
      if (covered.has(key)) continue
      const text = lines.slice(start, index + EXCERPT_RADIUS + 1).join('\n')
      if (chars + text.length > MAX_EXCERPT_CHARS) return excerpts
      covered.add(key)
      chars += text.length
      excerpts.push({ file, startLine: start + 1, token, text })
      if (excerpts.length >= MAX_EXCERPTS) return excerpts
    }
  }
  return excerpts
}

// ---------------------------------------------------------------------------
// diff の上限（決定的）
// ---------------------------------------------------------------------------

export const MAX_DETECTION_DIFF_CHARS = 150_000
const MIN_PER_FILE_CHARS = 2_000

export interface CappedDiff {
  text: string
  truncated: boolean
  /** 切り詰めが起きた file */
  truncatedFiles: string[]
}

/**
 * detection prompt に載せる diff を上限内に収める。各 file に最低 2k を割り当て、残りを元の大きさに比例配分する。
 * file 内では削除行 → 追加行 → context 行の順に残す（削除が設計判断の主な証拠のため）。
 */
export function capDiff(diff: string, limit = MAX_DETECTION_DIFF_CHARS): CappedDiff {
  if (diff.length <= limit) return { text: diff, truncated: false, truncatedFiles: [] }
  const files = splitUnifiedDiff(diff)
  const sizes = files.map((f) => f.lines.reduce((n, l) => n + (l === null ? 3 : l.length + 1), 0) + f.path.length + 20)
  const floor = Math.min(MIN_PER_FILE_CHARS, Math.floor(limit / Math.max(1, files.length)))
  const spare = Math.max(0, limit - floor * files.length)
  const total = sizes.reduce((a, b) => a + b, 0)
  const truncatedFiles: string[] = []
  const parts = files.map((file, i) => {
    const budget = floor + Math.floor((spare * sizes[i]) / Math.max(1, total))
    const header = `diff --git a/${file.path} b/${file.path}${file.deleted ? '\ndeleted file mode' : ''}\n`
    const body = file.lines.map((l) => (l === null ? '@@' : l))
    const full = header + body.join('\n')
    if (full.length <= budget) return full
    truncatedFiles.push(file.path)
    const ordered = [
      ...body.filter((l) => l.startsWith('-')),
      ...body.filter((l) => l.startsWith('+')),
      ...body.filter((l) => l.startsWith(' ')),
    ]
    let out = header
    for (const l of ordered) {
      if (out.length + l.length + 1 > budget - 40) break
      out += `${l}\n`
    }
    return `${out}[… truncated: ${file.path} …]`
  })
  // file header だけで上限を超える（file 数が極端に多い）場合の最終 fallback: 先頭から上限で切る
  const joined = parts.join('\n')
  const marker = '\n[… truncated: diff exceeds cap even after per-file allocation …]'
  const text = joined.length <= limit
    ? joined
    : limit > marker.length ? `${joined.slice(0, limit - marker.length)}${marker}` : joined.slice(0, Math.max(0, limit))
  return { text, truncated: true, truncatedFiles }
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

export interface DetectionInput {
  title: string
  diff: string
  signals: readonly MaterialitySignal[]
  excerpts: readonly RecordExcerpt[]
}

function renderSignals(signals: readonly MaterialitySignal[]): string {
  if (signals.length === 0) return '(none)'
  return signals.map((s) => `- [${s.id}] ${s.kind} — ${s.file}: ${JSON.stringify(s.token)}`).join('\n')
}

function renderExcerpts(excerpts: readonly RecordExcerpt[]): string {
  if (excerpts.length === 0) return '(none)'
  return excerpts.map((e) => `### ${e.file}:${e.startLine} (matched ${JSON.stringify(e.token)})\n${e.text}`).join('\n\n')
}

/**
 * detection prompt。**PR body は渡さない**（author の自己分類を検出に入れないため）。
 * `instructions` は docs/meta_reviewer/design_materiality_detection.md の本文。
 */
export function buildDetectionPrompt(instructions: string, input: DetectionInput): string {
  const capped = capDiff(input.diff)
  return [
    instructions.trim(),
    '',
    `## Title (untrusted label; never evidence)\n${input.title}`,
    '',
    `## Deterministic signals\n${renderSignals(input.signals)}`,
    '',
    `## Base design record excerpts\n${renderExcerpts(input.excerpts)}`,
    '',
    `## Diff${capped.truncated ? ` (truncated; files: ${capped.truncatedFiles.join(', ')})` : ''}\n\`\`\`diff\n${capped.text}\n\`\`\``,
  ].join('\n')
}

export interface EvaluationInput {
  diff: string
  candidates: readonly MaterialityCandidate[]
  signals: readonly MaterialitySignal[]
  excerpts: readonly RecordExcerpt[]
}

/** correctness prompt。detection の候補一覧だけを渡し、detection の推論文は渡さない。 */
export function buildEvaluationPrompt(instructions: string, input: EvaluationInput): string {
  const capped = capDiff(input.diff)
  const candidates = input.candidates
    .map((c) => `- [${c.id}] ${c.kind} ${c.subject}: ${c.mechanism} (${c.file})`)
    .join('\n')
  return [
    instructions.trim(),
    '',
    `## Candidates\n${candidates}`,
    '',
    `## Deterministic signals\n${renderSignals(input.signals)}`,
    '',
    `## Base design record excerpts\n${renderExcerpts(input.excerpts)}`,
    '',
    `## Diff${capped.truncated ? ' (truncated)' : ''}\n\`\`\`diff\n${capped.text}\n\`\`\``,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// strict parser
// ---------------------------------------------------------------------------

export const CANDIDATE_KINDS = ['removes', 'replaces', 'redefines', 'introduces'] as const
export const CANDIDATE_SUBJECTS = ['responsibility', 'mechanism', 'authority_boundary', 'state_transition', 'design_contract'] as const
const DISPOSITIONS = ['unrelated', 'test_only', 'formatting_or_comment_wording'] as const

export interface MaterialityCandidate {
  id: string
  kind: (typeof CANDIDATE_KINDS)[number]
  subject: (typeof CANDIDATE_SUBJECTS)[number]
  mechanism: string
  file: string
  evidence: string
}

export interface SignalDisposition {
  signalId: string
  /** `supports_candidate:<candidateId>` または DISPOSITIONS のどれか */
  disposition: string
  reason: string
}

export interface DetectionResult {
  material: boolean
  candidates: MaterialityCandidate[]
  signalDisposition: SignalDisposition[]
}

/** ok でも、採点に使わない副次的な出力の不備は warnings に残す（観測全体は捨てない） */
export type ParseOutcome<T> = { ok: true; value: T; warnings: string[] } | { ok: false; reason: string }

const MAX_WARNINGS = 50

/**
 * warning に値を残すのは、enum 語の形（小文字の英字・_・- だけ、24 文字以内）の string のときだけ。
 * 数字・大文字を含むもの（token・hash・id の形）は残さない。enum の取り違え（`redefined` 等）の診断にはこれで足りる
 */
export function warningToken(v: unknown): string {
  return typeof v === 'string' && /^[a-z][a-z_-]{0,23}$/.test(v) ? v : '<non-token>'
}

function capWarnings(warnings: string[]): string[] {
  return warnings.length <= MAX_WARNINGS ? warnings : [...warnings.slice(0, MAX_WARNINGS), `truncated:${warnings.length - MAX_WARNINGS}`]
}

/** 応答本文から最後の JSON object を1つ取り出す（```json fence 内を優先） */
function extractJsonObject(raw: string): unknown {
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]).reverse()
  for (const candidate of [...fenced, raw]) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try { return JSON.parse(candidate.slice(start, end + 1)) } catch { /* 次の候補 */ }
  }
  return undefined
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v)

/**
 * detection 応答の parse。
 *
 * **厳格（不成立にする）**: JSON・`candidates` / `signalDisposition` の配列・候補の採点に使う欄
 * （id・kind・subject・mechanism・file・evidence）・候補 id の重複（correctness の突き合わせが壊れる）・
 * `material`（llm の予測そのものなので、書き換えも補完もしない。boolean で、候補の有無と一致しなければ不成立）。
 *
 * **warning に残して続ける**（M5 trial で、副次的な出力の不備1つで観測全体を失っていたため）:
 * - 1つの signal に複数の disposition（複数の候補を支える signal は正当） → すべて残す
 * - 未知の signal id・未知の disposition 値・不正な disposition → その disposition だけ捨てる
 * - S1–S3 の signal に disposition が無い → `signal_not_disposed:<id>` を残す
 */
export function parseDetection(raw: string, signals: readonly MaterialitySignal[]): ParseOutcome<DetectionResult> {
  const json = extractJsonObject(raw) as Record<string, unknown> | undefined
  if (!json || typeof json !== 'object') return { ok: false, reason: 'no_json' }
  if (typeof json.material !== 'boolean') return { ok: false, reason: 'material_not_boolean' }
  if (!Array.isArray(json.candidates) || !Array.isArray(json.signalDisposition)) return { ok: false, reason: 'missing_arrays' }
  const warnings: string[] = []

  const candidates: MaterialityCandidate[] = []
  for (const raw of json.candidates as Array<Record<string, unknown>>) {
    // model は subject が mechanism 以外だと説明を subject 名の key（"design_contract": "…" 等）に書くことがある
    // （M5 trial 2026-10-26 で3件とも）。同じ内容なので、mechanism の key が**無いときだけ** mechanism として読む
    const c = raw && !Object.hasOwn(raw, 'mechanism') && oneOf(CANDIDATE_SUBJECTS, raw.subject) && isString(raw[raw.subject])
      ? { ...raw, mechanism: raw[raw.subject] }
      : raw
    // 採点に使う欄（id・kind・subject・mechanism・file・evidence。target 照合は mechanism + evidence を読む）は厳格
    const bad = !c ? 'candidate' : !isString(c.id) ? 'id' : !oneOf(CANDIDATE_KINDS, c.kind) ? 'kind'
      : !oneOf(CANDIDATE_SUBJECTS, c.subject) ? 'subject' : !isString(c.mechanism) ? 'mechanism'
      : !isString(c.file) ? 'file' : !isString(c.evidence) ? 'evidence' : undefined
    if (bad) return { ok: false, reason: `invalid_candidate:${bad}` }
    candidates.push({ id: c.id as string, kind: c.kind as MaterialityCandidate['kind'], subject: c.subject as MaterialityCandidate['subject'], mechanism: c.mechanism as string, file: c.file as string, evidence: c.evidence as string })
  }
  const candidateIds = new Set(candidates.map((c) => c.id))
  if (candidateIds.size !== candidates.length) return { ok: false, reason: 'duplicate_candidate_id' }
  if (json.material !== candidates.length > 0) return { ok: false, reason: 'material_mismatch' }
  const material = json.material

  const known = new Set(signals.map((s) => s.id))
  const dispositions: SignalDisposition[] = []
  for (const d of json.signalDisposition as Array<Record<string, unknown>>) {
    if (!d || !isString(d.signalId) || !isString(d.disposition)) { warnings.push('invalid_disposition'); continue }
    if (!known.has(d.signalId)) { warnings.push(`unknown_signal:${warningToken(d.signalId)}`); continue }
    const supports = d.disposition.match(/^supports_candidate:(.+)$/)
    if (supports ? !candidateIds.has(supports[1]) : !oneOf(DISPOSITIONS, d.disposition)) {
      warnings.push(`unknown_disposition:${warningToken(d.disposition.replace(/^supports_candidate:/, 'supports_candidate_'))}`)
      continue
    }
    dispositions.push({ signalId: d.signalId, disposition: d.disposition, reason: typeof d.reason === 'string' ? d.reason : '' })
  }
  const answered = new Set(dispositions.map((d) => d.signalId))
  for (const sig of signals) {
    if (sig.kind !== 'behavior_test_removed' && !answered.has(sig.id)) warnings.push(`signal_not_disposed:${sig.id}`)
  }

  return { ok: true, value: { material, candidates, signalDisposition: dispositions }, warnings: capWarnings(warnings) }
}

// introduced: 既存のものに触れず新しい責務・機構を足す候補（kind=introduces）。保たれる / 移る / 失われる のどれでもない
// redefined: 同じ場所が持ち続けるが、意味・条件・上限・到達可能性が変わった（kind=redefines の多く）。M5 trial 2026-10-27 で
// authority 境界の再定義と削除の候補が enum 外の値で答えられ、評価なしになった
const RESPONSIBILITY = ['preserved', 'moved', 'redefined', 'lost', 'introduced', 'unclear'] as const
const RECORD_CONSISTENCY = ['consistent', 'contradicts_unupdated_record', 'no_record'] as const
const PROVENANCE = ['yes', 'no', 'unknown'] as const

export interface CandidateEvaluation {
  candidateId: string
  responsibility: (typeof RESPONSIBILITY)[number]
  newOwner: string | null
  recordConsistency: (typeof RECORD_CONSISTENCY)[number]
  ceoDirectedProvenance: (typeof PROVENANCE)[number]
  provenanceEvidence: string
  correctness: string
  simplicity: string
  naturalness: string
}

/**
 * correctness 応答の parse。
 *
 * 判定の欄（candidateId・responsibility・recordConsistency・ceoDirectedProvenance）が不正な評価、
 * 規則に反する評価（introduced を追加以外に使う・moved なのに移り先が無い）、未知の候補への評価は
 * **その評価だけを捨てて warning に残す**。同じ候補への評価が複数あるとき、判定の欄が全部同じなら1つにまとめ、
 * 1つでも違えばその候補の評価を**全部捨てる**（順番で狭い判定が変わらないように）。評価の無い候補は `unevaluated:<id>` を残す（評価が無いので
 * 狭い判定では「未検出」として数えられる）。1件も使える評価が無ければ不成立。
 */
export function parseEvaluation(raw: string, candidates: readonly MaterialityCandidate[]): ParseOutcome<CandidateEvaluation[]> {
  const json = extractJsonObject(raw) as Record<string, unknown> | undefined
  if (!json || !Array.isArray(json.evaluations)) return { ok: false, reason: 'no_evaluations' }
  const warnings: string[] = []
  const out: CandidateEvaluation[] = []
  const byId = new Map(candidates.map((c) => [c.id, c]))
  // newOwner と自由記述の所見は欠けてもよい（newOwner は null、所見は空文字にする）
  const optionalText = (v: unknown) => v === undefined || v === null || typeof v === 'string'
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  for (const e of json.evaluations as Array<Record<string, unknown>>) {
    const bad = !e ? 'evaluation' : !isString(e.candidateId) ? 'candidateId' : !oneOf(RESPONSIBILITY, e.responsibility) ? 'responsibility'
      : !optionalText(e.newOwner) ? 'newOwner' : !oneOf(RECORD_CONSISTENCY, e.recordConsistency) ? 'recordConsistency'
      : !oneOf(PROVENANCE, e.ceoDirectedProvenance) ? 'ceoDirectedProvenance'
      : !['provenanceEvidence', 'correctness', 'simplicity', 'naturalness'].every((k) => optionalText(e[k])) ? 'text_field' : undefined
    // どの値で外れたかを残す（次の調整の根拠）。model の自由文を記録へ写さないよう、短い語の形のときだけ値を残す
    if (bad) { warnings.push(`invalid_evaluation:${bad}=${warningToken(e?.[bad])}`); continue }
    const candidate = byId.get(e.candidateId as string)
    if (!candidate) { warnings.push(`unknown_candidate:${warningToken(e.candidateId)}`); continue }
    // introduced は追加（kind=introduces）の候補にだけ使える。消す・替える・意味を変える候補を introduced と答えた評価は
    // 狭い判定（correctnessFlags）から外れてしまうので使わない
    if (e.responsibility === 'introduced' && candidate.kind !== 'introduces') { warnings.push(`introduced_for_non_addition:${candidate.id}`); continue }
    // moved は移り先を名指しできて初めて moved である
    if (e.responsibility === 'moved' && !isString(e.newOwner)) { warnings.push(`moved_without_owner:${candidate.id}`); continue }
    out.push({
      candidateId: candidate.id,
      responsibility: e.responsibility as CandidateEvaluation['responsibility'],
      newOwner: isString(e.newOwner) ? e.newOwner : null,
      recordConsistency: e.recordConsistency as CandidateEvaluation['recordConsistency'],
      ceoDirectedProvenance: e.ceoDirectedProvenance as CandidateEvaluation['ceoDirectedProvenance'],
      provenanceEvidence: text(e.provenanceEvidence),
      correctness: text(e.correctness),
      simplicity: text(e.simplicity),
      naturalness: text(e.naturalness),
    })
  }
  const verdictKey = (e: CandidateEvaluation) => `${e.responsibility}|${e.recordConsistency}|${e.ceoDirectedProvenance}`
  const kept: CandidateEvaluation[] = []
  for (const c of candidates) {
    const mine = out.filter((o) => o.candidateId === c.id)
    if (mine.length === 0) { warnings.push(`unevaluated:${c.id}`); continue }
    if (new Set(mine.map(verdictKey)).size > 1) {
      warnings.push(`conflicting_evaluations:${c.id}`, `unevaluated:${c.id}`)
      continue
    }
    if (mine.length > 1) warnings.push(`duplicate_evaluation:${c.id}`)
    kept.push(mine[0])
  }
  if (kept.length === 0) return { ok: false, reason: 'no_usable_evaluation' }
  return { ok: true, value: kept, warnings: capWarnings(warnings) }
}

// ---------------------------------------------------------------------------
// observation runner（provider 注入・never throws）
// ---------------------------------------------------------------------------

export type ReviewProvider = (prompt: string) => Promise<string>

export interface ObservationInput {
  title: string
  diff: string
  records: BaseRecordReader
  detectionInstructions: string
  evaluationInstructions: string
}

export interface MaterialityObservation {
  schemaVersion: typeof DESIGN_MATERIALITY_SCHEMA_VERSION
  status: 'ok' | 'unavailable'
  /** unavailable の理由（provider_error / timeout / parse:<reason> / internal_error） */
  reason?: string
  signals: MaterialitySignal[]
  excerpts: Array<Omit<RecordExcerpt, 'text'>>
  detectionPromptHash?: string
  evaluationPromptHash?: string
  detection?: DetectionResult
  evaluations?: CandidateEvaluation[]
  /** 応答を解析できなかったときだけ、その応答の先頭（RAW_EXCERPT_CHARS まで）を残す。原因を後から確かめるため */
  rawResponseExcerpt?: { stage: 'detection' | 'evaluation'; text: string }
  /** 捨てずに続けた副次的な出力の不備（`detection:<warning>` / `evaluation:<warning>`） */
  parseWarnings?: string[]
}

export const RAW_EXCERPT_CHARS = 3_000

export const OBSERVATION_TIMEOUT_MS = 90_000

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 待機に上限を付ける。**provider の処理自体は取り消さない**（REST client に abort が無いため）。
 * 期限後に provider が reject しても unhandled rejection にならないよう catch を付ける。
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  work.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ms) })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const TIMEOUT = Symbol('timeout')

/**
 * detection → （候補があれば）correctness を実行する。**例外を外へ出さない。**
 * 失敗はすべて `status: 'unavailable'` として返し、評価では「未検出」として数える。
 */
export async function observeDesignMateriality(
  input: ObservationInput,
  provider: ReviewProvider,
  timeoutMs = OBSERVATION_TIMEOUT_MS,
): Promise<MaterialityObservation> {
  let signals: MaterialitySignal[] = []
  let excerpts: RecordExcerpt[] = []
  const base = (): MaterialityObservation => ({
    schemaVersion: DESIGN_MATERIALITY_SCHEMA_VERSION,
    status: 'unavailable',
    signals,
    excerpts: excerpts.map(({ text: _text, ...rest }) => rest),
  })
  try {
    signals = computeMaterialitySignals(input.diff)
    excerpts = extractBaseRecordExcerpts(input.records, excerptTokens(input.diff, signals))

    const detectionPrompt = buildDetectionPrompt(input.detectionInstructions, { title: input.title, diff: input.diff, signals, excerpts })
    const detectionRaw = await withTimeout(provider(detectionPrompt).then((r) => r, (e: unknown) => ({ error: e })), timeoutMs)
    const observation: MaterialityObservation = { ...base(), detectionPromptHash: sha256(detectionPrompt) }
    if (detectionRaw === TIMEOUT) return { ...observation, reason: 'timeout' }
    if (typeof detectionRaw !== 'string') return { ...observation, reason: 'provider_error' }
    const detection = parseDetection(detectionRaw, signals)
    if (!detection.ok) return { ...observation, reason: `parse:${detection.reason}`, rawResponseExcerpt: { stage: 'detection', text: detectionRaw.slice(0, RAW_EXCERPT_CHARS) } }
    const detectionWarnings = detection.warnings.map((w) => `detection:${w}`)
    const warned = detectionWarnings.length > 0 ? { parseWarnings: detectionWarnings } : {}
    if (detection.value.candidates.length === 0) return { ...observation, ...warned, status: 'ok', detection: detection.value, evaluations: [] }

    const evaluationPrompt = buildEvaluationPrompt(input.evaluationInstructions, {
      diff: input.diff, candidates: detection.value.candidates, signals, excerpts,
    })
    const withDetection = { ...observation, ...warned, detection: detection.value, evaluationPromptHash: sha256(evaluationPrompt) }
    const evaluationRaw = await withTimeout(provider(evaluationPrompt).then((r) => r, (e: unknown) => ({ error: e })), timeoutMs)
    if (evaluationRaw === TIMEOUT) return { ...withDetection, reason: 'evaluation_timeout' }
    if (typeof evaluationRaw !== 'string') return { ...withDetection, reason: 'evaluation_provider_error' }
    const evaluations = parseEvaluation(evaluationRaw, detection.value.candidates)
    if (!evaluations.ok) return { ...withDetection, reason: `evaluation_parse:${evaluations.reason}`, rawResponseExcerpt: { stage: 'evaluation', text: evaluationRaw.slice(0, RAW_EXCERPT_CHARS) } }
    const allWarnings = [...detectionWarnings, ...evaluations.warnings.map((w) => `evaluation:${w}`)]
    return { ...withDetection, ...(allWarnings.length > 0 ? { parseWarnings: allWarnings } : {}), status: 'ok', evaluations: evaluations.value }
  } catch {
    return { ...base(), reason: 'internal_error' }
  }
}
