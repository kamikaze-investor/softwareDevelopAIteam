import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  DesignReviewKind,
  FocusedReviewResult,
  IndependentReviewOutcome,
  IntegrationReviewResult,
  MetaFindingCategory,
  MetaReviewFinding,
  MetaReviewFocus,
  MetaRiskLevel,
  ReviewLoad,
  ReviewLoadClassification,
  StrategicDecision,
  StrategicMetaReviewResult,
} from '@ai-team/shared'
import { resolveDefaultControlContextDir } from '@ai-team/shared/src/constitutionPrinciples.js'
import {
  buildEngineeringPrincipleReviewGuidance,
  loadEngineeringPrinciples,
} from '@ai-team/shared/src/engineeringPrinciples.js'
// 判定ロジックはAPI（Control Plane）側でも再計算する必要があるため @ai-team/shared を正本とし、
// ここでは再exportして既存の呼び出し元との互換を保つ。定義を二重化しないこと。
import { applyIndependentReviewOverride, resolveFinalDecision } from '@ai-team/shared'
export { applyIndependentReviewOverride, resolveFinalDecision }
import { classifyReviewLoad, ROADMAP_REVIEW_LOAD_CLASSIFICATION } from '../approvalLevel/reviewLoadClassifier.js'
import { selectFocuses, selectRoadmapReviewFocuses } from '../approvalLevel/focusSelector.js'
import {
  buildMetaReviewPrompt,
  buildMetaReviewRequest,
  parseMetaReviewResult,
} from './runner.js'
import { AGY_REVIEW_MODEL } from './geminiRouter.js'
import { reviewWithProviderFallback } from './metaReviewFallbackRouter.js'
import { createReviewerAdapter } from '../approvalLevel/reviewerAdapter.js'

/**
 * Reviewer used for the CRITICAL-only Independent Review.
 * Deliberately different from the Gemini-based primary Focused/Integration review
 * (different provider, different model — see reviewerAdapter.ts's CODEX_REVIEWER_MODEL),
 * so it is a genuinely independent second opinion, not a re-run of the same call.
 */
const INDEPENDENT_REVIEWER_PROVIDER = 'codex'

export interface StrategicReviewInput {
  reviewKind?: DesignReviewKind
  /** task: taskId value. roadmap: projectId value. Never a synthetic taskId. */
  subjectId: string
  taskTitle: string
  changedFiles: string[]
  gitDiff: string
  workingDir: string
  controlContextDir?: string
  materialKind?: 'diff' | 'design'
}

interface ReviewOutcome<T> {
  result: T
  unavailable: boolean
}

interface StrategicContext {
  text: string
  missingRequiredPaths: string[]
}

interface RoadmapParserModule {
  parseRoadmapMarkdown: (markdown: string) => {
    items: Array<{ title: string }>
  }
}

const STRATEGIC_DECISIONS: readonly StrategicDecision[] = [
  'ALIGNED',
  'CONFLICT',
  'UNCERTAIN',
]

const META_RISK_LEVELS: readonly MetaRiskLevel[] = [
  'low',
  'medium',
  'high',
  'critical',
]

const META_FINDING_CATEGORIES: readonly MetaFindingCategory[] = [
  'cage_violation',
  'authority_change',
  'repository_boundary',
  'security_regression',
  'architecture_drift',
  'scope_creep',
  'mvp_mismatch',
  'spec_violation',
  'implementation_coupling',
  'over_constraint',
  'unverifiable_assumption',
]

const REQUIRED_TARGET_STRATEGIC_DOCS = [
  'docs/project_memory/goal.md',
  'docs/project_memory/design_philosophy.md',
]

const REQUIRED_CONTROL_STRATEGIC_DOCS = [
  'specs/00_constitution.md',
]

const FOCUS_DESCRIPTIONS: Record<MetaReviewFocus, string> = {
  strategic_alignment: 'Check whether the change aligns with Goal, Design Philosophy, Constitution, decisions, and roadmap direction.',
  safety_recovery: 'Check safety, recovery, guard strength, and failure containment without expanding unnecessary gates.',
  architecture_responsibility: 'Check ownership boundaries, module responsibility, and whether logic is placed in the right layer.',
  data_state_integrity: 'Check schema, storage, migration, persistence, state transition, and data integrity risks.',
  auth_permission: 'Check authentication, authorization, permission boundaries, token handling, and approval bypass risk.',
  operations: 'Check CI, workflows, runtime, deployment, backup, recovery, observability, and operational burden.',
  product_ceo_experience: 'Check CEO-facing workflow quality, product clarity, and whether human effort increases unnecessarily.',
  scope_simplicity: 'Check scope discipline, unnecessary abstraction, accidental platform creation, and MVP simplicity.',
}

// agy（Antigravity CLI経由のGemini/Claudeフォールバック）へ渡す --json-schema。
// 既存パーサー（parseFocusedReviewResponse / parseIntegrationReviewResponse）が
// 期待する contract をそのまま JSON Schema 化したもので、新しい review 形式は
// 作らない（2026-08-24: agy がエージェント的な文章を返し既存パーサーで
// パースできない事象への対処として追加。実測で agy --json-schema がそのまま
// 既存 contract を強制でき、パーサー側の変更は不要だった）。
const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: [...META_RISK_LEVELS] },
    category: { type: 'string', enum: [...META_FINDING_CATEGORIES] },
    message: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'number' },
    suggestion: { type: 'string' },
  },
  required: ['message'],
} as const

const FOCUSED_REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: [...STRATEGIC_DECISIONS] },
    summary: { type: 'string' },
    findings: { type: 'array', items: FINDING_SCHEMA },
  },
  required: ['decision', 'summary'],
} as const

const INTEGRATION_REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: [...STRATEGIC_DECISIONS] },
    summary: { type: 'string' },
    conflictingFocuses: {
      type: 'array',
      items: { type: 'string', enum: Object.keys(FOCUS_DESCRIPTIONS) },
    },
    unresolvedAssumptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['decision', 'summary'],
} as const

const CHECKLIST_FILES_BY_FOCUS: Record<Exclude<MetaReviewFocus, 'strategic_alignment'>, string[]> = {
  safety_recovery: ['guards.md', 'sandbox.md'],
  architecture_responsibility: ['worker.md', 'api_routes.md', 'shared_types.md'],
  data_state_integrity: ['storage.md'],
  auth_permission: ['guards.md', 'api_routes.md'],
  operations: ['workflows.md', 'sandbox.md', 'worker.md'],
  product_ceo_experience: ['api_routes.md', 'shared_types.md'],
  scope_simplicity: [],
}

const STOPWORDS = new Set([
  'apps',
  'src',
  'docs',
  'task',
  'tasks',
  'worker',
  'api',
  'routes',
  'types',
  'test',
  'tests',
  'meta',
  'review',
  'project',
])

export async function runStrategicMetaReview(
  input: StrategicReviewInput,
): Promise<StrategicMetaReviewResult> {
  const reviewKind = input.reviewKind ?? 'task'

  const classification = reviewKind === 'roadmap'
    ? ROADMAP_REVIEW_LOAD_CLASSIFICATION
    : classifyReviewLoad({ changedFiles: input.changedFiles })

  const selectedFocuses = reviewKind === 'roadmap'
    ? selectRoadmapReviewFocuses()
    : selectFocuses(classification.reviewLoad, input.changedFiles)

  if (classification.reviewLoad === 'low') {
    // unreachable for roadmap kind (always critical) — fine, no branch needed here.
    return runLowLoadLegacyReview(input, classification)
  }

  const focusedReviewResults: FocusedReviewResult[] = []
  let reviewUnavailable = false

  for (const focus of selectedFocuses) {
    const outcome = await runFocusedReview(input, focus)
    focusedReviewResults.push(outcome.result)
    reviewUnavailable = reviewUnavailable || outcome.unavailable
  }

  let integrationReviewResult: IntegrationReviewResult | undefined
  if (!reviewUnavailable) {
    const integrationOutcome = await runIntegrationReview(input, focusedReviewResults)
    integrationReviewResult = integrationOutcome.result
    reviewUnavailable = integrationOutcome.unavailable
  }

  let finalDecision: StrategicDecision | 'REVIEW_UNAVAILABLE' = reviewUnavailable
    ? 'REVIEW_UNAVAILABLE'
    : resolveFinalDecision(focusedReviewResults, integrationReviewResult)

  let independentReviewResult: IndependentReviewOutcome | undefined
  if (classification.reviewLoad === 'critical' && finalDecision !== 'REVIEW_UNAVAILABLE') {
    independentReviewResult = await runIndependentReview(input)
    finalDecision = applyIndependentReviewOverride(finalDecision, independentReviewResult)
  }

  return buildStrategicResult({
    reviewKind,
    subjectId: input.subjectId,
    classification,
    selectedFocuses,
    focusedReviewResults,
    integrationReviewResult,
    independentReviewResult,
    finalDecision,
  })
}

/**
 * CRITICAL-only Independent Review. Uses a provider/model genuinely separate from the
 * primary Gemini-based Focused/Integration review, called fresh against the same
 * design/diff material (never fed the primary review's prompt or output).
 */
export async function runIndependentReview(
  input: StrategicReviewInput,
): Promise<IndependentReviewOutcome> {
  const adapter = createReviewerAdapter(INDEPENDENT_REVIEWER_PROVIDER)
  const materialKind = input.materialKind ?? 'diff'

  try {
    const reviewKind = input.reviewKind ?? 'task'
    const result = await adapter.review({
      jobId: input.subjectId,
      reviewKind,
      subjectId: input.subjectId,
      taskId: reviewKind === 'task' ? input.subjectId : undefined,
      implementerProvider: 'claude_code',
      reviewerProvider: INDEPENDENT_REVIEWER_PROVIDER,
      phase: materialKind === 'design' ? 'pre' : 'post',
      planText: materialKind === 'design' ? input.gitDiff : undefined,
      diffText: materialKind === 'design' ? undefined : input.gitDiff,
      purposeSummary: input.taskTitle,
      targetFiles: input.changedFiles,
    })

    return {
      provider: result.provider,
      verdict: result.verdict === 'blocking' ? 'blocking' : result.verdict,
      summary: result.summary,
      unavailable: result.confidence === 0 && result.verdict === 'blocking' && result.issues.length === 0,
    }
  } catch (err) {
    return {
      provider: INDEPENDENT_REVIEWER_PROVIDER,
      verdict: 'blocking',
      summary: `Independent review failed: ${formatError(err)}`,
      unavailable: true,
    }
  }
}

export function mapMetaReviewStatusToStrategicDecision(status: 'approved' | 'changes_requested' | 'blocked'): StrategicDecision {
  if (status === 'approved') {
    return 'ALIGNED'
  }

  return 'CONFLICT'
}

export function parseFocusedReviewResponse(
  rawResponse: string,
  focus: MetaReviewFocus,
): ReviewOutcome<FocusedReviewResult> {
  const parsed = parseJsonObject(rawResponse)

  if (!parsed || !isStrategicDecision(parsed.decision)) {
    return {
      result: unavailableFocusedResult(
        focus,
        `Focused review response could not be parsed as a valid ${focus} decision.`,
        rawResponse,
      ),
      unavailable: true,
    }
  }

  return {
    result: {
      focus,
      decision: parsed.decision,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '(summary not provided)',
      findings: normalizeFindings(parsed.findings, parsed.decision),
    },
    unavailable: false,
  }
}

export function parseIntegrationReviewResponse(
  rawResponse: string,
): ReviewOutcome<IntegrationReviewResult> {
  const parsed = parseJsonObject(rawResponse)

  if (!parsed || !isStrategicDecision(parsed.decision)) {
    return {
      result: {
        decision: 'UNCERTAIN',
        summary: `Integration review response could not be parsed: ${rawResponse.slice(0, 300)}`,
      },
      unavailable: true,
    }
  }

  return {
    result: {
      decision: parsed.decision,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '(summary not provided)',
      conflictingFocuses: normalizeFocusArray(parsed.conflictingFocuses),
      unresolvedAssumptions: normalizeStringArray(parsed.unresolvedAssumptions),
    },
    unavailable: false,
  }
}

async function runLowLoadLegacyReview(
  input: StrategicReviewInput,
  classification: ReviewLoadClassification,
): Promise<StrategicMetaReviewResult> {
  const reviewKind = input.reviewKind ?? 'task'

  try {
    const request = buildMetaReviewRequest(
      input.subjectId,
      input.taskTitle,
      input.changedFiles,
      input.workingDir,
      input.gitDiff,
    )
    const prompt = buildMetaReviewPrompt(request)
    const { raw: rawResponse } = await reviewWithProviderFallback(prompt, {
      preferCli: true,
      // agy CLI は model と effort を分離して受け取る（AGY_REVIEW_MODEL の定義コメント参照）。
      // apiModel は Gemini REST API 側の名前空間なので agy の命名へ寄せない。
      ...AGY_REVIEW_MODEL,
      apiModel: 'gemini-3.5-flash',
      featureName: 'meta_review',
    })
    const legacyResult = parseMetaReviewResult(rawResponse, input.subjectId)
    const finalDecision = mapMetaReviewStatusToStrategicDecision(legacyResult.status)

    const independentReviewRequired = classification.reviewLoad === 'critical'
    const requiresCeoApprovalOverride = legacyResult.requiresCeoApproval
      || requiresCeoApprovalForDecision(finalDecision, independentReviewRequired)

    return buildStrategicResult({
      reviewKind,
      subjectId: input.subjectId,
      classification,
      selectedFocuses: [],
      focusedReviewResults: [],
      finalDecision,
      requiresCeoApprovalOverride,
    })
  } catch (err) {
    return buildUnavailableStrategicResult(
      reviewKind,
      input.subjectId,
      classification,
      [],
      [],
      undefined,
      `Low-load legacy Meta Review could not complete: ${formatError(err)}`,
    )
  }
}

async function runFocusedReview(
  input: StrategicReviewInput,
  focus: MetaReviewFocus,
): Promise<ReviewOutcome<FocusedReviewResult>> {
  const promptContext = await buildFocusedReviewPrompt(input, focus)

  if (promptContext.unavailableReason) {
    return {
      result: unavailableFocusedResult(focus, promptContext.unavailableReason, ''),
      unavailable: true,
    }
  }

  try {
    const { raw: rawResponse } = await reviewWithProviderFallback(promptContext.prompt, {
      preferCli: true,
      // agy CLI は model と effort を分離して受け取る（AGY_REVIEW_MODEL の定義コメント参照）。
      // apiModel は Gemini REST API 側の名前空間なので agy の命名へ寄せない。
      ...AGY_REVIEW_MODEL,
      apiModel: 'gemini-3.5-flash',
      featureName: `strategic-meta-review-${focus}`,
      cliJsonSchema: FOCUSED_REVIEW_JSON_SCHEMA,
    })
    return parseFocusedReviewResponse(rawResponse, focus)
  } catch (err) {
    return {
      result: unavailableFocusedResult(
        focus,
        `Focused review failed: ${formatError(err)}`,
        '',
      ),
      unavailable: true,
    }
  }
}

async function runIntegrationReview(
  input: StrategicReviewInput,
  focusedReviewResults: readonly FocusedReviewResult[],
): Promise<ReviewOutcome<IntegrationReviewResult>> {
  const prompt = buildIntegrationReviewPrompt(input, focusedReviewResults)

  try {
    const { raw: rawResponse } = await reviewWithProviderFallback(prompt, {
      preferCli: true,
      // agy CLI は model と effort を分離して受け取る（AGY_REVIEW_MODEL の定義コメント参照）。
      // apiModel は Gemini REST API 側の名前空間なので agy の命名へ寄せない。
      ...AGY_REVIEW_MODEL,
      apiModel: 'gemini-3.5-flash',
      featureName: 'strategic-meta-review-integration',
      cliJsonSchema: INTEGRATION_REVIEW_JSON_SCHEMA,
    })
    return parseIntegrationReviewResponse(rawResponse)
  } catch (err) {
    return {
      result: {
        decision: 'UNCERTAIN',
        summary: `Integration review failed: ${formatError(err)}`,
      },
      unavailable: true,
    }
  }
}

async function buildFocusedReviewPrompt(
  input: StrategicReviewInput,
  focus: MetaReviewFocus,
): Promise<{ prompt: string; unavailableReason?: string }> {
  if (focus === 'strategic_alignment') {
    const context = await buildStrategicAlignmentContext(input)
    if (context.missingRequiredPaths.length > 0) {
      return {
        prompt: '',
        unavailableReason: `Required strategic context is missing: ${context.missingRequiredPaths.join(', ')}`,
      }
    }

    return {
      prompt: [
        'You are running one Focused Meta Review call.',
        'Focus only on strategic_alignment. Do not re-review unrelated technical details.',
        '',
        `Focus description: ${FOCUS_DESCRIPTIONS[focus]}`,
        '',
        context.text,
        '',
        buildReviewMaterialSection(input.gitDiff, input.materialKind ?? 'diff'),
        '',
        buildFocusedOutputContract(),
      ].join('\n'),
    }
  }

  const checklistContext = await buildChecklistContext(resolveControlContextDir(input), focus, input.changedFiles)
  if (checklistContext.unavailableReason) {
    return {
      prompt: '',
      unavailableReason: checklistContext.unavailableReason,
    }
  }

  return {
    prompt: [
      'You are running one Focused Meta Review call.',
      `Focus only on ${focus}. Do not mix in other review responsibilities.`,
      '',
      `Focus description: ${FOCUS_DESCRIPTIONS[focus]}`,
      '',
      checklistContext.text,
      '',
      buildReviewSubjectHeader(input),
      '',
      buildReviewMaterialSection(input.gitDiff, input.materialKind ?? 'diff'),
      '',
      buildFocusedOutputContract(),
    ].join('\n'),
  }
}

async function buildStrategicAlignmentContext(input: StrategicReviewInput): Promise<StrategicContext> {
  const sections: string[] = []
  const missingRequiredPaths: string[] = []

  for (const relPath of REQUIRED_TARGET_STRATEGIC_DOCS) {
    const content = await readOptionalFile(input.workingDir, relPath)
    if (content === null) {
      missingRequiredPaths.push(relPath)
      continue
    }
    sections.push(`## ${relPath}\n\n${content}`)
  }

  const controlContextDir = resolveControlContextDir(input)
  for (const relPath of REQUIRED_CONTROL_STRATEGIC_DOCS) {
    const content = await readOptionalFile(controlContextDir, relPath)
    if (content === null) {
      missingRequiredPaths.push(relPath)
      continue
    }
    sections.push(`## ${relPath}\n\n${content}`)
  }

  const keywords = buildKeywords(input)
  const decisionsContext = await buildDecisionContext(input.workingDir, keywords)
  if (decisionsContext) {
    sections.push(decisionsContext)
  }

  const roadmapTitles = await findRelatedRoadmapTitles(input.workingDir, keywords)
  if (roadmapTitles.length > 0) {
    sections.push([
      '## Related roadmap item titles',
      '',
      formatBulletList(roadmapTitles),
    ].join('\n'))
  }

  sections.push(buildReviewSubjectHeader(input))

  return {
    text: sections.join('\n\n---\n\n'),
    missingRequiredPaths,
  }
}

async function buildChecklistContext(
  controlContextDir: string,
  focus: Exclude<MetaReviewFocus, 'strategic_alignment'>,
  changedFiles: readonly string[],
): Promise<{ text: string; unavailableReason?: string }> {
  const checklistFiles = selectChecklistFilesForFocus(focus, changedFiles)
  const sections: string[] = []

  for (const checklistFile of checklistFiles) {
    const relPath = `docs/meta_reviewer/checklists/${checklistFile}`
    const content = await readOptionalFile(controlContextDir, relPath)
    if (content !== null) {
      sections.push(`## ${relPath}\n\n${content}`)
    }
  }

  if (sections.length === 0) {
    const generalChecklist = await readOptionalFile(controlContextDir, 'docs/meta_reviewer/checklist.md')
    if (generalChecklist !== null) {
      sections.push(`## docs/meta_reviewer/checklist.md\n\n${generalChecklist}`)
    }
  }

  if (sections.length === 0) {
    const expectedPaths = [
      ...checklistFiles.map((file) => `docs/meta_reviewer/checklists/${file}`),
      'docs/meta_reviewer/checklist.md',
    ]

    return {
      text: '',
      unavailableReason: `Checklist context is missing for ${focus}. Expected ${expectedPaths.join(' or ')}.`,
    }
  }

  return { text: sections.join('\n\n---\n\n') }
}

function resolveControlContextDir(input: StrategicReviewInput): string {
  return input.controlContextDir ?? resolveDefaultControlContextDir()
}

function selectChecklistFilesForFocus(
  focus: Exclude<MetaReviewFocus, 'strategic_alignment'>,
  changedFiles: readonly string[],
): string[] {
  const candidates = CHECKLIST_FILES_BY_FOCUS[focus]
  if (candidates.length === 0) {
    return []
  }

  const normalizedFiles = changedFiles.map((file) => file.replace(/\\/g, '/').toLowerCase())
  const matched = candidates.filter((checklistFile) => {
    return normalizedFiles.some((file) => checklistMatchesFile(checklistFile, file))
  })

  return matched.length > 0 ? matched : [candidates[0]]
}

function checklistMatchesFile(checklistFile: string, file: string): boolean {
  switch (checklistFile) {
    case 'guards.md':
      return file.includes('guards/')
    case 'sandbox.md':
      return file.startsWith('sandbox/')
    case 'api_routes.md':
      return file.startsWith('apps/api/src/routes/') || file.includes('/auth/')
    case 'storage.md':
      return file.startsWith('apps/api/src/storage/')
    case 'worker.md':
      return file.startsWith('apps/worker/src/')
    case 'shared_types.md':
      return file.startsWith('packages/shared/src/types/')
    case 'workflows.md':
      return file.startsWith('.github/workflows/') || file === '.github/codeowners'
    default:
      return false
  }
}

async function buildDecisionContext(workingDir: string, keywords: readonly string[]): Promise<string> {
  const decisionsDir = join(workingDir, 'docs/project_memory/decisions')
  let entries: string[]

  try {
    entries = (await readdir(decisionsDir))
      .filter((entry) => entry.toLowerCase().endsWith('.md'))
      .sort()
  } catch {
    return ''
  }

  const titleLines: string[] = []
  const bodySections: string[] = []

  for (const entry of entries) {
    const relPath = `docs/project_memory/decisions/${entry}`
    const content = await readOptionalFile(workingDir, relPath)
    if (content === null) {
      continue
    }

    const title = extractMarkdownTitle(content) ?? basename(entry, '.md')
    titleLines.push(`- ${relPath}: ${title}`)

    if (isRelatedText(`${relPath} ${title}`, keywords)) {
      bodySections.push(`### ${relPath}\n\n${content}`)
    }
  }

  if (titleLines.length === 0) {
    return ''
  }

  return [
    '## Decision records',
    '',
    '### Decision title list',
    ...titleLines,
    bodySections.length > 0
      ? ['', '### Related decision bodies', ...bodySections].join('\n')
      : '',
  ].filter(Boolean).join('\n')
}

async function findRelatedRoadmapTitles(
  workingDir: string,
  keywords: readonly string[],
): Promise<string[]> {
  const markdown = await readOptionalFile(workingDir, 'tasks/roadmap.md')
  if (markdown === null) {
    return []
  }

  try {
    const parser = await importRoadmapParser(workingDir)
    return parser.parseRoadmapMarkdown(markdown).items
      .map((item) => item.title)
      .filter((title) => title.length > 0 && isRelatedText(title, keywords))
  } catch {
    return []
  }
}

async function importRoadmapParser(workingDir: string): Promise<RoadmapParserModule> {
  const parserPath = join(workingDir, 'apps/worker/scripts/roadmap/roadmapParser.ts')
  const parserUrl = pathToFileURL(parserPath).href
  return await import(parserUrl) as RoadmapParserModule
}

function buildIntegrationReviewPrompt(
  input: StrategicReviewInput,
  focusedReviewResults: readonly FocusedReviewResult[],
): string {
  return [
    'You are running the Integration Review for Strategic Meta Review.',
    'Do not re-review the full diff or implementation details. Review only the combination of focused review outcomes.',
    '',
    'Check for contradictions between Focused Reviews, local optimum combinations that break the whole system, final alignment with higher-level purpose, unresolved assumptions, unnecessary gates/workflows, and safety changes that damage autonomy or CEO effort.',
    '',
    buildReviewSubjectHeader(input),
    '',
    '## Focused Review outcomes',
    ...focusedReviewResults.map(formatFocusedReviewSummary),
    '',
    'Return JSON only:',
    '```json',
    '{',
    '  "decision": "ALIGNED" | "CONFLICT" | "UNCERTAIN",',
    '  "summary": "short summary",',
    '  "conflictingFocuses": ["strategic_alignment"],',
    '  "unresolvedAssumptions": ["assumption"]',
    '}',
    '```',
  ].join('\n')
}

function formatFocusedReviewSummary(result: FocusedReviewResult): string {
  const findingLines = result.findings.length > 0
    ? result.findings.map((finding) => {
      const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : ''
      return `  - [${finding.severity}] ${finding.category}${location}: ${finding.message}`
    }).join('\n')
    : '  - No findings'

  return [
    `### ${result.focus}`,
    `Decision: ${result.decision}`,
    `Summary: ${result.summary}`,
    'Findings:',
    findingLines,
  ].join('\n')
}

function buildReviewSubjectHeader(input: StrategicReviewInput): string {
  if ((input.reviewKind ?? 'task') === 'roadmap') {
    return [
      '## Roadmap Under Review',
      '',
      `Project ID: ${input.subjectId}`,
      'Review subject: whole-roadmap (all planned tasks for this project, reviewed together — not an individual task\'s diff)',
    ].join('\n')
  }

  return [
    '## Task',
    '',
    `Task ID: ${input.subjectId}`,
    `Task title: ${input.taskTitle}`,
    '',
    'Changed files:',
    formatBulletList(input.changedFiles),
  ].join('\n')
}

function buildReviewMaterialSection(
  reviewMaterial: string,
  materialKind: 'diff' | 'design',
): string {
  if (materialKind === 'design') {
    return [
      '## Proposed Design (pre-implementation, not yet a diff)',
      '',
      '```text',
      reviewMaterial,
      '```',
    ].join('\n')
  }

  return [
    '## Git Diff or Design Text',
    '',
    '```diff',
    reviewMaterial,
    '```',
  ].join('\n')
}

function buildFocusedOutputContract(): string {
  const engineeringPrinciples = loadEngineeringPrinciples()
  const principleReviewGuidance = buildEngineeringPrincipleReviewGuidance(engineeringPrinciples)

  return [
    principleReviewGuidance,
    '',
    'Return JSON only:',
    '```json',
    '{',
    '  "decision": "ALIGNED" | "CONFLICT" | "UNCERTAIN",',
    '  "summary": "short summary",',
    '  "findings": [',
    '    {',
    '      "severity": "low" | "medium" | "high" | "critical",',
    `      "category": ${formatCategoryUnion(META_FINDING_CATEGORIES)},`,
    '      "message": "finding",',
    '      "file": "optional path",',
    '      "line": 1,',
    '      "suggestion": "optional suggestion"',
    '    }',
    '  ]',
    '}',
    '```',
  ].join('\n')
}

function formatCategoryUnion(categories: readonly MetaFindingCategory[]): string {
  return categories.map((category) => `"${category}"`).join(' | ')
}

function buildStrategicResult(input: {
  reviewKind: DesignReviewKind
  subjectId: string
  classification: ReviewLoadClassification
  selectedFocuses: MetaReviewFocus[]
  focusedReviewResults: FocusedReviewResult[]
  integrationReviewResult?: IntegrationReviewResult
  independentReviewResult?: IndependentReviewOutcome
  finalDecision: StrategicDecision | 'REVIEW_UNAVAILABLE'
  requiresCeoApprovalOverride?: boolean
}): StrategicMetaReviewResult {
  const independentReviewRequired = input.classification.reviewLoad === 'critical'
  const strategicAlignmentResult = input.focusedReviewResults.find((result) => {
    return result.focus === 'strategic_alignment'
  })
  const requiresCeoApproval = input.requiresCeoApprovalOverride
    ?? requiresCeoApprovalForDecision(input.finalDecision, independentReviewRequired)

  return {
    reviewKind: input.reviewKind,
    subjectId: input.subjectId,
    taskId: input.reviewKind === 'task' ? input.subjectId : undefined,
    reviewLoad: input.classification.reviewLoad,
    reviewLoadReasons: input.classification.reasons,
    selectedFocuses: input.selectedFocuses,
    strategicAlignmentResult,
    focusedReviewResults: input.focusedReviewResults,
    integrationReviewResult: input.integrationReviewResult,
    independentReviewResult: input.independentReviewResult,
    finalDecision: input.finalDecision,
    independentReviewRequired,
    requiresCeoApproval,
    createdAt: new Date().toISOString(),
  }
}

function requiresCeoApprovalForDecision(
  finalDecision: StrategicDecision | 'REVIEW_UNAVAILABLE',
  independentReviewRequired: boolean,
): boolean {
  switch (finalDecision) {
    case 'ALIGNED':
    case 'CONFLICT':
      return independentReviewRequired
    case 'UNCERTAIN':
    case 'REVIEW_UNAVAILABLE':
      return true
  }
}

function buildUnavailableStrategicResult(
  reviewKind: DesignReviewKind,
  subjectId: string,
  classification: ReviewLoadClassification,
  selectedFocuses: MetaReviewFocus[],
  focusedReviewResults: FocusedReviewResult[],
  integrationReviewResult: IntegrationReviewResult | undefined,
  reason: string,
): StrategicMetaReviewResult {
  const nextFocusedReviewResults = focusedReviewResults.length > 0
    ? focusedReviewResults
    : [unavailableFocusedResult('strategic_alignment', reason, '')]

  return buildStrategicResult({
    reviewKind,
    subjectId,
    classification,
    selectedFocuses,
    focusedReviewResults: nextFocusedReviewResults,
    integrationReviewResult,
    finalDecision: 'REVIEW_UNAVAILABLE',
    requiresCeoApprovalOverride: true,
  })
}

function unavailableFocusedResult(
  focus: MetaReviewFocus,
  summary: string,
  rawEvidence: string,
): FocusedReviewResult {
  return {
    focus,
    decision: 'UNCERTAIN',
    summary,
    findings: [{
      severity: 'critical',
      category: 'security_regression',
      message: summary,
      suggestion: rawEvidence ? rawEvidence.slice(0, 500) : undefined,
    }],
  }
}

function parseJsonObject(rawResponse: string): Record<string, unknown> | null {
  for (const candidate of extractJsonCandidates(rawResponse)) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (isRecord(parsed)) {
        return parsed
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null
}

function extractJsonCandidates(rawResponse: string): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (candidate: string): void => {
    const trimmed = candidate.trim()
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed)
      candidates.push(trimmed)
    }
  }

  for (const match of rawResponse.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)) {
    addCandidate(match[1])
  }

  addCandidate(rawResponse)

  for (const candidate of findBalancedJsonObjects(rawResponse)) {
    addCandidate(candidate)
  }

  return candidates
}

function findBalancedJsonObjects(text: string): string[] {
  const objects: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
        inString = false
        escaped = false
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        objects.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }

  return objects
}

function normalizeFindings(value: unknown, decision: StrategicDecision): MetaReviewFinding[] {
  if (!Array.isArray(value)) {
    return []
  }

  const fallbackSeverity = fallbackSeverityForDecision(decision)

  return value
    .filter(isRecord)
    .map((finding) => ({
      severity: isMetaRiskLevel(finding.severity) ? finding.severity : fallbackSeverity,
      category: isMetaFindingCategory(finding.category) ? finding.category : 'architecture_drift',
      message: typeof finding.message === 'string' ? finding.message : 'No message',
      file: typeof finding.file === 'string' ? finding.file : undefined,
      line: typeof finding.line === 'number' ? finding.line : undefined,
      suggestion: typeof finding.suggestion === 'string' ? finding.suggestion : undefined,
    }))
}

function fallbackSeverityForDecision(decision: StrategicDecision): MetaRiskLevel {
  switch (decision) {
    case 'ALIGNED':
      return 'low'
    case 'CONFLICT':
      return 'high'
    case 'UNCERTAIN':
      return 'medium'
  }
}

function normalizeFocusArray(value: unknown): MetaReviewFocus[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const focuses = value.filter(isMetaReviewFocus)
  return focuses.length > 0 ? focuses : undefined
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length > 0 ? strings : undefined
}

function isStrategicDecision(value: unknown): value is StrategicDecision {
  return typeof value === 'string' && STRATEGIC_DECISIONS.includes(value as StrategicDecision)
}

function isMetaReviewFocus(value: unknown): value is MetaReviewFocus {
  return typeof value === 'string' && value in FOCUS_DESCRIPTIONS
}

function isMetaRiskLevel(value: unknown): value is MetaRiskLevel {
  return typeof value === 'string' && META_RISK_LEVELS.includes(value as MetaRiskLevel)
}

function isMetaFindingCategory(value: unknown): value is MetaFindingCategory {
  return typeof value === 'string' && META_FINDING_CATEGORIES.includes(value as MetaFindingCategory)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readOptionalFile(workingDir: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(join(workingDir, relPath), 'utf-8')
  } catch {
    return null
  }
}

function extractMarkdownTitle(markdown: string): string | null {
  const titleLine = markdown.split(/\r?\n/).find((line) => /^#\s+/.test(line))
  return titleLine ? titleLine.replace(/^#\s+/, '').trim() : null
}

function buildKeywords(input: StrategicReviewInput): string[] {
  const source = [
    input.subjectId,
    input.taskTitle,
    ...input.changedFiles,
  ].join(' ')

  return uniqueStrings(
    source
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  ).slice(0, 30)
}

function isRelatedText(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return keywords.some((keyword) => lower.includes(keyword))
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function formatBulletList(values: readonly string[]): string {
  return values.length > 0
    ? values.map((value) => `- ${value}`).join('\n')
    : '- (none)'
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
