// Cross-Task Drift Audit — deterministic layer (Layer 1 machine facts only).
//
// Per-Task / per-PR reviews answer "may this change merge?" on one diff. This module answers a
// different question: which facts about a WINDOW of already-merged changes (first-parent master,
// last audited head .. now) deserve a falsification pass by the Design Challenger.
//
// It never judges. It selects the window, ranks churn, finds fix-of-fix chains and the
// authority surface, decides whether an audit is due, and routes Decision Authority candidates
// mechanically (upgrade-only). Judgment stays with the Challenger (System Two) and the PL.
// Nothing here is a Gate: no exit code of this module blocks a merge, a Job or a deploy.
//
// Owners this module deliberately does NOT duplicate:
// - syntax idioms (startsWith / split / latest row): docs/meta_reviewer/checklists/semantic_integrity.md
//   (it calls them "clues, not evidence"); the Challenger is pointed there instead.
// - removed / introduced contract members per diff: PR #406 design materiality detector.
// - the authority surface: .github/CODEOWNERS (the 2026-10-08 canonical DA surface), read, not copied.

export const AUDIT_RECORD_PATH_PATTERN = /^docs\/project_memory\/decisions\/cross_task_audit_[^/]+\.md$/

// Ledger and lockfile churn is bookkeeping, not structure; every change touches them.
const NON_STRUCTURAL_PATHS = new Set(['tasks/roadmap.md', 'docs/PROJECT_CURRENT_STATE.md', 'pnpm-lock.yaml'])

const LAYERS = ['apps/api', 'apps/worker', 'apps/mobile', 'packages/shared'] as const
export type Layer = (typeof LAYERS)[number]

export interface WindowCommit {
  sha: string
  subject: string
  body: string
  files: string[]
}

export interface AuditMarker {
  base: string
  head: string
}

export interface AuditRecord {
  path: string
  marker: AuditMarker
}

// ---------------------------------------------------------------------------
// Audit pointer: the latest record's head is the next window's base (no new storage).
// ---------------------------------------------------------------------------

const MARKER_PATTERN = /<!--\s*cross-task-audit\s+base=([0-9a-f]{40})\s+head=([0-9a-f]{40})\s*-->/g

export function parseAuditMarkers(markdown: string): AuditMarker[] {
  return [...markdown.matchAll(MARKER_PATTERN)].map((m) => ({ base: m[1]!, head: m[2]! }))
}

export interface AuditChainResult {
  latestHead: string | null
  issues: string[]
}

/**
 * Validates the record chain and returns the head to audit from.
 *
 * A broken chain is reported, never repaired by guessing: a fork (two records claiming the same
 * base), a head that is not on first-parent master (squash / branch SHA), or a record whose base
 * is not the previous head all make the pointer untrustworthy, so latestHead is null and the
 * caller must pass --base explicitly.
 */
export function validateAuditChain(
  records: readonly AuditRecord[],
  isOnFirstParent: (sha: string) => boolean,
): AuditChainResult {
  const issues: string[] = []
  if (records.length === 0) return { latestHead: null, issues }

  for (const r of records) {
    if (!isOnFirstParent(r.marker.head)) issues.push(`${r.path}: head ${r.marker.head} is not on first-parent master`)
    if (!isOnFirstParent(r.marker.base)) issues.push(`${r.path}: base ${r.marker.base} is not on first-parent master`)
  }
  const byBase = new Map<string, AuditRecord[]>()
  for (const r of records) byBase.set(r.marker.base, [...(byBase.get(r.marker.base) ?? []), r])
  for (const [base, rs] of byBase) {
    if (rs.length > 1) issues.push(`fork: ${rs.map((r) => r.path).join(', ')} share base ${base}`)
  }
  const heads = new Set(records.map((r) => r.marker.head))
  const genesis = records.filter((r) => !heads.has(r.marker.base))
  if (genesis.length !== 1) issues.push(`expected exactly one chain start, found ${genesis.length}`)
  const bases = new Set(records.map((r) => r.marker.base))
  const tips = records.filter((r) => !bases.has(r.marker.head))
  if (tips.length !== 1) issues.push(`expected exactly one latest record, found ${tips.length}`)

  return { latestHead: issues.length === 0 ? tips[0]!.marker.head : null, issues }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export function prNumberOf(subject: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(subject) ?? /^Merge pull request #(\d+)/.exec(subject)
  return m ? Number(m[1]) : null
}

/** The audit's own record PR must not open the next window (it is not a Task change). */
export function isAuditRecordOnly(files: readonly string[]): boolean {
  return files.length > 0 && files.every((f) => AUDIT_RECORD_PATH_PATTERN.test(f))
}

export function isStructuralPath(file: string): boolean {
  return !NON_STRUCTURAL_PATHS.has(file) && !AUDIT_RECORD_PATH_PATTERN.test(file)
}

export function layerOf(file: string): Layer | null {
  return LAYERS.find((l) => file.startsWith(`${l}/`)) ?? null
}

export function windowChanges(commits: readonly WindowCommit[]): WindowCommit[] {
  return commits.filter((c) => !isAuditRecordOnly(c.files) && c.files.some(isStructuralPath))
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface FileChurn {
  path: string
  windowTouches: number
  baselineTouches: number
  /** Window touch rate over the file's own long-run touch rate (Laplace-smoothed). */
  lift: number
}

/**
 * Ranks files touched by two or more window changes by how unusual that is FOR THAT FILE.
 *
 * A raw "touched by >= N changes" rule is noise here: hub files (sqlite.ts, interface.ts,
 * executionLoop.ts) are touched by a third of all changes (measured on the 40 first-parent
 * commits before c6be983c: 14, 11 and 10). Lift against the file's own baseline keeps hubs from
 * crowding out a module that suddenly took five fixes in a row. The two-change floor is the
 * definition of cross-task, not a tuning knob. Test files move with their source and would only
 * spend the packet budget twice, so they are not ranked.
 */
export function rankChurn(window: readonly WindowCommit[], baseline: readonly WindowCommit[]): FileChurn[] {
  const count = (cs: readonly WindowCommit[]) => {
    const m = new Map<string, number>()
    for (const c of cs) for (const f of new Set(c.files)) if (isStructuralPath(f) && !isTestFile(f)) m.set(f, (m.get(f) ?? 0) + 1)
    return m
  }
  const w = count(window)
  const b = count(baseline)
  const out: FileChurn[] = []
  for (const [path, windowTouches] of w) {
    if (windowTouches < 2) continue
    const baselineTouches = b.get(path) ?? 0
    const lift = windowTouches / window.length / ((baselineTouches + 1) / (baseline.length + 1))
    out.push({ path, windowTouches, baselineTouches, lift: Math.round(lift * 100) / 100 })
  }
  return out.sort((x, y) => y.lift - x.lift || y.windowTouches - x.windowTouches || x.path.localeCompare(y.path))
}

export interface FixChainLink {
  sha: string
  pr: number | null
  cites: number[]
}

/**
 * A window change that cites another window PR in its subject or body: the earlier change did not
 * close its failure class. This is the "same failure class surviving" signal (e.g. #409 citing
 * #407 and #408 on the CONFLICT-recovery path).
 */
export function findFixChains(window: readonly WindowCommit[]): FixChainLink[] {
  const prs = new Set(window.map((c) => prNumberOf(c.subject)).filter((n): n is number => n !== null))
  const links: FixChainLink[] = []
  for (const c of window) {
    const own = prNumberOf(c.subject)
    const cites = [...new Set([...`${c.subject}\n${c.body}`.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])))]
      .filter((n) => n !== own && prs.has(n))
      .sort((a, b) => a - b)
    if (cites.length > 0) links.push({ sha: c.sha, pr: own, cites })
  }
  return links
}

export interface AddedLine {
  sha: string
  file: string
  text: string
}

const BUDGET_CONSTANT = /\b(?:const|let)\s+((?=[A-Z])[A-Z0-9_]*(?:MAX|BUDGET|CAP|TIMEOUT|ATTEMPTS?|LIMIT|RETR(?:Y|IES)|_MS)[A-Z0-9_]*)\b/
const AUDIT_OPERATION = /\boperation:\s*['"]([a-z][a-z0-9_]{2,60})['"]/
const DOMAIN_LITERAL = /['"]([a-z][a-z0-9]*(?:[_:-][a-z0-9]+)+)['"]/g

/** Quoted lower-case literals with a separator (`job_failed`, `implement:review`, `park-request`). */
export function domainLiteralsIn(text: string): string[] {
  return [...text.matchAll(DOMAIN_LITERAL)].map((m) => m[1]!).filter((lit) => lit.length <= 60)
}

export interface AddedFacts {
  budgetConstants: { name: string; file: string; sha: string }[]
  auditOperations: { operation: string; file: string; sha: string }[]
  crossLayerLiterals: { literal: string; layers: Layer[] }[]
}

function isTestFile(file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(file) || file.includes('/__tests__/')
}

/**
 * New budget / cap / timeout constants, new audit operation strings, and new domain-looking
 * literals that appear in two or more layers within the window. `existedAtBase` filters literals
 * the codebase already had, so only window-introduced meaning is reported.
 */
export function collectAddedFacts(lines: readonly AddedLine[], existedAtBase: (literal: string) => boolean): AddedFacts {
  const budgetConstants: AddedFacts['budgetConstants'] = []
  const auditOperations: AddedFacts['auditOperations'] = []
  const literalLayers = new Map<string, Set<Layer>>()
  for (const l of lines) {
    if (isTestFile(l.file) || !isStructuralPath(l.file)) continue
    const budget = BUDGET_CONSTANT.exec(l.text)
    if (budget) budgetConstants.push({ name: budget[1]!, file: l.file, sha: l.sha })
    const op = AUDIT_OPERATION.exec(l.text)
    if (op) auditOperations.push({ operation: op[1]!, file: l.file, sha: l.sha })
    const layer = layerOf(l.file)
    if (!layer) continue
    for (const lit of domainLiteralsIn(l.text)) literalLayers.set(lit, (literalLayers.get(lit) ?? new Set()).add(layer))
  }
  const crossLayerLiterals = [...literalLayers]
    .filter(([lit, layers]) => layers.size >= 2 && !existedAtBase(lit))
    .map(([literal, layers]) => ({ literal, layers: [...layers].sort() }))
    .sort((a, b) => b.layers.length - a.layers.length || a.literal.localeCompare(b.literal))
  return {
    budgetConstants,
    auditOperations: auditOperations.filter((o) => !existedAtBase(o.operation)),
    crossLayerLiterals,
  }
}

// ---------------------------------------------------------------------------
// Authority surface (read from CODEOWNERS, never copied)
// ---------------------------------------------------------------------------

export function parseCodeownersPatterns(codeowners: string): string[] {
  return codeowners
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0]!)
}

export function matchesCodeownersPattern(file: string, pattern: string): boolean {
  const p = pattern.replace(/^\//, '')
  if (p.endsWith('/')) return file.startsWith(p)
  if (!p.includes('*')) return file === p || file.startsWith(`${p}/`)
  const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*')}$`)
  return re.test(file)
}

export function isAuthoritySurface(file: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesCodeownersPattern(file, p))
}

// ---------------------------------------------------------------------------
// Due
// ---------------------------------------------------------------------------

export interface DueInput {
  changes: readonly WindowCommit[]
  /** The SHA just deployed to Production, when this run is the post-deploy Verify step. */
  deployedSha: string | null
  fixChains: readonly FixChainLink[]
  authorityPatterns: readonly string[]
}

export interface DueResult {
  due: boolean
  reasons: string[]
  authorityChanges: string[]
}

/**
 * Due on an existing boundary, not on a count:
 * - deploy: the window that reached Production together (specs/22 §9 Deploy → Observe → Verify);
 * - fix chain: a later change in the window cites an earlier one (the failure class survived);
 * - authority: two or more window changes touched the CODEOWNERS surface (each was code-owner
 *   reviewed alone; their combination never was).
 * Fewer than two changes is never due: there is nothing cross-task to look at.
 */
export function evaluateDue(input: DueInput): DueResult {
  const authorityChanges = input.changes
    .filter((c) => c.files.some((f) => isAuthoritySurface(f, input.authorityPatterns)))
    .map((c) => c.sha)
  if (input.changes.length < 2) {
    return { due: false, reasons: [`window has ${input.changes.length} change(s); cross-task needs two`], authorityChanges }
  }
  const reasons: string[] = []
  if (input.deployedSha) reasons.push(`deploy boundary ${input.deployedSha.slice(0, 8)}`)
  if (input.fixChains.length > 0) {
    reasons.push(`fix chain: ${input.fixChains.map((l) => `${l.pr ? `#${l.pr}` : l.sha.slice(0, 8)} cites ${l.cites.map((n) => `#${n}`).join(',')}`).join('; ')}`)
  }
  if (authorityChanges.length >= 2) reasons.push(`${authorityChanges.length} changes touched the CODEOWNERS authority surface`)
  return { due: reasons.length > 0, reasons, authorityChanges }
}

// ---------------------------------------------------------------------------
// Challenger findings: strict parse + mechanical, upgrade-only Decision Authority routing
// ---------------------------------------------------------------------------

export const QUESTION_IDS = [
  'duplicate_owner',
  'cross_layer_reinterpretation',
  'incidental_representation',
  'unnecessary_mechanism',
  'principle_contradiction',
  'authority_tuple_drift',
  'production_divergence',
  'surviving_failure_class',
  'complexity_growth',
] as const
export type QuestionId = (typeof QUESTION_IDS)[number]

export type Routing = 'technical' | 'decision_authority'

export interface ChallengerFinding {
  questionId: QuestionId
  claim: string
  evidence: string[]
  falsifiableCheck: string
  severity: 'high' | 'medium' | 'low'
  routing: Routing
  daTrigger?: string
  relatedRoadmapId?: string
}

export interface RoutedFinding extends ChallengerFinding {
  id: string
  /** Why routing is decision_authority. Empty when technical. The model can add a reason, never remove one. */
  daReasons: string[]
}

export interface ParsedChallengerResponse {
  findings: ChallengerFinding[]
  /** Questions the Challenger states it checked and found nothing for. */
  checkedClean: QuestionId[]
  uncertainQuestions: QuestionId[]
}

export class ChallengerResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChallengerResponseError'
  }
}

function isQuestionId(v: unknown): v is QuestionId {
  return typeof v === 'string' && (QUESTION_IDS as readonly string[]).includes(v)
}

function requireString(o: Record<string, unknown>, key: string, at: string): string {
  const v = o[key]
  if (typeof v !== 'string' || v.trim() === '') throw new ChallengerResponseError(`${at}.${key} must be a non-empty string`)
  return v
}

/**
 * Strict parse. A question with no finding counts as clean only when the Challenger lists it in
 * checkedClean; otherwise it is uncertain. Silence is never read as "no drift" (specs/23 §5).
 */
export function parseChallengerResponse(raw: unknown): ParsedChallengerResponse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ChallengerResponseError('response must be a JSON object')
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.findings)) throw new ChallengerResponseError('findings must be an array')
  const findings = o.findings.map((f, i): ChallengerFinding => {
    const at = `findings[${i}]`
    if (typeof f !== 'object' || f === null) throw new ChallengerResponseError(`${at} must be an object`)
    const r = f as Record<string, unknown>
    if (!isQuestionId(r.questionId)) throw new ChallengerResponseError(`${at}.questionId must be one of ${QUESTION_IDS.join(', ')}`)
    if (!Array.isArray(r.evidence) || r.evidence.length === 0 || !r.evidence.every((e) => typeof e === 'string' && e.trim() !== '')) {
      throw new ChallengerResponseError(`${at}.evidence must be a non-empty array of file:line strings`)
    }
    if (r.severity !== 'high' && r.severity !== 'medium' && r.severity !== 'low') throw new ChallengerResponseError(`${at}.severity must be high|medium|low`)
    if (r.routing !== 'technical' && r.routing !== 'decision_authority') throw new ChallengerResponseError(`${at}.routing must be technical|decision_authority`)
    const optional = (key: string) => (typeof r[key] === 'string' && (r[key] as string).trim() !== '' ? (r[key] as string) : undefined)
    return {
      questionId: r.questionId,
      claim: requireString(r, 'claim', at),
      evidence: r.evidence as string[],
      falsifiableCheck: requireString(r, 'falsifiableCheck', at),
      severity: r.severity,
      routing: r.routing,
      ...(optional('daTrigger') ? { daTrigger: optional('daTrigger') } : {}),
      ...(optional('relatedRoadmapId') ? { relatedRoadmapId: optional('relatedRoadmapId') } : {}),
    }
  })
  const listed = Array.isArray(o.uncertainQuestions) ? o.uncertainQuestions.filter(isQuestionId) : []
  const clean = Array.isArray(o.checkedClean) ? o.checkedClean.filter(isQuestionId) : []
  const answered = new Set(findings.map((f) => f.questionId))
  return {
    findings,
    checkedClean: QUESTION_IDS.filter((q) => clean.includes(q) && !answered.has(q) && !listed.includes(q)),
    uncertainQuestions: QUESTION_IDS.filter((q) => listed.includes(q) || (!answered.has(q) && !clean.includes(q))),
  }
}

const AUTHORITY_TERMS = /\b(approval|approve[sd]?|authority|authori[sz]ation|permission|CODEOWNERS|tuple|human[- ]?(gate|decision)|self-approv\w*|gate[- ]?bypass)\b|承認|権限|人間/i

function evidencePath(evidence: string): string {
  return evidence.trim().replace(/^`|`$/g, '').replace(/:\d+(?:[-–]\d+)?$/, '')
}

/**
 * Routing is decided by the Challenger only upward. A finding becomes a decision_authority
 * candidate when its evidence touches the CODEOWNERS authority surface, when it is an
 * authority-tuple question, or when its claim speaks about approval / authority — whatever the
 * model labelled it. A diff can contain AI-written text that asks for "technical"; that label
 * cannot suppress a candidate. Candidates are listed in the record and the final report as
 * information, never as an approval request; the PL disposes each one against specs/22 1-2 in
 * writing.
 */
export function routeFindings(findings: readonly ChallengerFinding[], authorityPatterns: readonly string[], idPrefix: string): RoutedFinding[] {
  return findings.map((f, i) => {
    const daReasons: string[] = []
    if (f.routing === 'decision_authority') daReasons.push(f.daTrigger ? `challenger: ${f.daTrigger}` : 'challenger')
    const surface = f.evidence.map(evidencePath).filter((p) => isAuthoritySurface(p, authorityPatterns))
    if (surface.length > 0) daReasons.push(`authority surface: ${[...new Set(surface)].join(', ')}`)
    if (f.questionId === 'authority_tuple_drift') daReasons.push('question: authority_tuple_drift')
    if (AUTHORITY_TERMS.test(f.claim)) daReasons.push('claim names approval / authority')
    return {
      ...f,
      id: `${idPrefix}-${String(i + 1).padStart(2, '0')}`,
      routing: daReasons.length > 0 ? 'decision_authority' : 'technical',
      daReasons,
    }
  })
}

// ---------------------------------------------------------------------------
// Packet (input to the Challenger). Truncation is explicit, never silent.
// ---------------------------------------------------------------------------

export interface PacketInput {
  base: string
  head: string
  due: DueResult
  changes: readonly WindowCommit[]
  churn: readonly FileChurn[]
  fixChains: readonly FixChainLink[]
  facts: AddedFacts
  /** Combined base..head diff per hotspot file, in churn order. */
  fileDiffs: readonly { path: string; diff: string }[]
  production: string | null
  budgetChars: number
}

export interface Packet {
  text: string
  includedFiles: string[]
  omittedFiles: string[]
}

export function buildPacket(input: PacketInput): Packet {
  const head: string[] = []
  head.push(`# Cross-Task Audit packet`, '')
  head.push(`window: ${input.base}..${input.head} (${input.changes.length} changes, first-parent master)`)
  head.push(`due: ${input.due.due} — ${input.due.reasons.join('; ') || 'not due'}`, '')
  head.push('## Changes in the window', '')
  for (const c of input.changes) {
    head.push(`- ${c.sha.slice(0, 8)} ${c.subject}`)
    head.push(`  files: ${c.files.filter(isStructuralPath).join(', ')}`)
  }
  head.push('', '## Churn ranked by lift over each file\'s own baseline (touched by >= 2 window changes)', '')
  for (const f of input.churn) head.push(`- ${f.path}: ${f.windowTouches} window / ${f.baselineTouches} baseline, lift ${f.lift}`)
  head.push('', '## Fix chains (a window change citing an earlier window PR)', '')
  for (const l of input.fixChains) head.push(`- ${l.pr ? `#${l.pr}` : l.sha.slice(0, 8)} cites ${l.cites.map((n) => `#${n}`).join(', ')}`)
  if (input.fixChains.length === 0) head.push('- none')
  head.push('', '## Authority surface changes (CODEOWNERS)', '')
  head.push(input.due.authorityChanges.length ? input.due.authorityChanges.map((s) => `- ${s.slice(0, 8)}`).join('\n') : '- none')
  head.push('', '## Window-introduced facts', '')
  head.push(`budget/cap/timeout constants: ${input.facts.budgetConstants.map((b) => `${b.name} (${b.file})`).join(', ') || 'none'}`)
  head.push(`audit operations: ${input.facts.auditOperations.map((o) => `${o.operation} (${o.file})`).join(', ') || 'none'}`)
  head.push(`literals new in >= 2 layers: ${input.facts.crossLayerLiterals.slice(0, 40).map((l) => `${l.literal} [${l.layers.join(', ')}]`).join(', ') || 'none'}`)
  head.push('', '## Production observation', '')
  head.push(input.production ?? 'NOT PROVIDED. Answer production_divergence as uncertain; do not infer Production behaviour from code.')

  let text = head.join('\n')
  const includedFiles: string[] = []
  const omittedFiles: string[] = []
  const diffs: string[] = []
  for (const d of input.fileDiffs) {
    const block = `\n\n### diff ${d.path}\n\n\`\`\`diff\n${d.diff}\n\`\`\``
    if (text.length + diffs.join('').length + block.length > input.budgetChars) {
      omittedFiles.push(d.path)
      continue
    }
    diffs.push(block)
    includedFiles.push(d.path)
  }
  text += '\n\n## Combined window diff of hotspot files\n'
  text += diffs.join('')
  text += '\n\n## Truncation\n\n'
  text += omittedFiles.length
    ? `OMITTED for budget (${input.budgetChars} chars): ${omittedFiles.join(', ')}. Any question whose evidence would need these files must be listed in uncertainQuestions, not answered as clean.`
    : 'nothing omitted'
  return { text, includedFiles, omittedFiles }
}
