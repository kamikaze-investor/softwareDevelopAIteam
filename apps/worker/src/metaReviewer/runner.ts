/**
 * Meta Review Runner
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * Developer AIのPRマージ前に必ず実行される。
 * AI Development Team OS 自身の変更を監査する。
 *
 * フロー:
 * 1. gitDiffを取得
 * 2. changedFilesを分類（どのエリアの変更か）
 * 3. Meta Reviewer AI（Gemini）にプロンプト + diff を渡す
 * 4. MetaReviewResultを受け取る
 * 5. blocked → Jobを停止・CEOへ通知
 *    changes_requested → 修正Jobを作成
 *    approved → 次のJobへ
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type {
  MetaFindingCategory,
  MetaRiskLevel,
  MetaReviewRequest,
  MetaReviewResult,
  MetaReviewStatus,
  MetaReviewTargetArea,
} from '@ai-team/shared'

const CONTROL_ROOT = '/workspace/control'
const META_REVIEWER_PROMPT_PATH = path.join(
  CONTROL_ROOT,
  'docs/meta_reviewer/prompt.md'
)
const META_REVIEWER_CHECKLIST_PATH = path.join(
  CONTROL_ROOT,
  'docs/meta_reviewer/checklist.md'
)
const CHECKLISTS_DIR = path.join(CONTROL_ROOT, 'docs/meta_reviewer/checklists')

/**
 * 変更ファイルに対応するファイル別チェックリストを全て返す
 * 複数のエリアにまたがる変更（例: api + worker）には複数のチェックリストを返す
 */
function getFileChecklists(changedFiles: string[]): string[] {
  const results: string[] = []

  const add = (filename: string) => {
    try {
      const content = readFileSync(path.join(CHECKLISTS_DIR, filename), 'utf-8')
      results.push(content)
    } catch {
      // チェックリストファイルが存在しない場合はスキップ
    }
  }

  if (changedFiles.some(f => f.includes('guards/'))) {
    add('guards.md')
  }
  if (changedFiles.some(f => f.startsWith('sandbox/'))) {
    add('sandbox.md')
  }
  if (changedFiles.some(f => f.startsWith('apps/api/src/routes/') || f === 'apps/api/src/index.ts')) {
    add('api_routes.md')
  }
  if (changedFiles.some(f => f.startsWith('apps/api/src/storage/'))) {
    add('storage.md')
  }
  if (changedFiles.some(f => f.startsWith('apps/worker/src/') && !f.includes('guards/'))) {
    add('worker.md')
  }
  if (changedFiles.some(f => f.startsWith('packages/shared/src/types/'))) {
    add('shared_types.md')
  }
  if (changedFiles.some(f => f.startsWith('.github/workflows/') || f === '.github/CODEOWNERS')) {
    add('workflows.md')
  }

  return results
}

/**
 * changedFilesからTargetAreaを分類する
 */
export function classifyTargetArea(changedFiles: string[]): MetaReviewTargetArea {
  const hasGuard = changedFiles.some((f) => f.includes('guards/'))
  const hasSandbox = changedFiles.some((f) => f.startsWith('sandbox/'))
  const hasWorker = changedFiles.some((f) => f.startsWith('apps/worker/'))
  const hasApi = changedFiles.some((f) => f.startsWith('apps/api/'))
  const hasMobile = changedFiles.some((f) => f.startsWith('apps/mobile/'))
  const hasShared = changedFiles.some((f) => f.startsWith('packages/shared/'))
  const hasSpec = changedFiles.some(
    (f) => f.startsWith('specs/') || f === 'CLAUDE.md'
  )
  const hasMemory = changedFiles.some((f) => f.startsWith('docs/project_memory/'))
  const hasTasks = changedFiles.some((f) => f.startsWith('tasks/'))

  // 優先度順に判定（最も重要なエリアを返す）
  if (hasGuard) return 'guard'
  if (hasSandbox) return 'sandbox'
  if (hasWorker) return 'worker'
  if (hasSpec) return 'spec'
  if (hasShared) return 'shared_types'
  if (hasApi) return 'api'
  if (hasMobile) return 'mobile'
  if (hasMemory) return 'project_memory'
  if (hasTasks) return 'tasks'
  return 'target_project'
}

/**
 * git diffを取得する
 * Workerはシェルなし・固定argvで実行（インジェクション防止）
 */
export function getGitDiff(workingDir: string): string {
  try {
    return execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,  // シェルを経由しない
    })
  } catch {
    return ''
  }
}

/**
 * Meta Review Requestを構築する
 */
export function buildMetaReviewRequest(
  taskId: string,
  taskTitle: string,
  changedFiles: string[],
  workingDir: string,
  gitDiff?: string,  // GitHub Actions等から正確なdiffを渡す場合に使用
): MetaReviewRequest {
  return {
    taskId,
    taskTitle,
    targetArea: classifyTargetArea(changedFiles),
    changedFiles,
    gitDiff: gitDiff ?? getGitDiff(workingDir),
    relatedSpecs: inferRelatedSpecs(changedFiles),
  }
}

/**
 * Meta Reviewer AIに渡すプロンプトを構築する
 */
export function buildMetaReviewPrompt(request: MetaReviewRequest): string {
  const systemPrompt = readFileSync(META_REVIEWER_PROMPT_PATH, 'utf-8')
  const generalChecklist = readFileSync(META_REVIEWER_CHECKLIST_PATH, 'utf-8')
  const fileChecklists = getFileChecklists(request.changedFiles)

  const fileChecklistSection = fileChecklists.length > 0
    ? [
        '## ファイル別チェックリスト（フェーズ1で使用）',
        '',
        '以下は変更されたファイルに対応する専用チェックリストである。',
        'フェーズ1では各項目を1つずつ確認すること。',
        '',
        ...fileChecklists.flatMap(c => [c, '']),
      ].join('\n')
    : '## ファイル別チェックリスト\n\n（このPRに対応する専用チェックリストなし。汎用チェックリストと判定基準で評価すること）'

  return `${systemPrompt}

---

## 汎用チェックリスト（フェーズ1・フェーズ2で参照）

${generalChecklist}

---

${fileChecklistSection}

---

## レビュー依頼

**Task ID**: ${request.taskId}
**Task**: ${request.taskTitle}
**対象エリア**: ${request.targetArea}

**変更ファイル**:
${request.changedFiles.map((f) => `- ${f}`).join('\n')}

**関連仕様書**:
${request.relatedSpecs.map((s) => `- ${s}`).join('\n')}

**Git Diff**:
\`\`\`diff
${request.gitDiff}
\`\`\`

上記のdiffを確認し、MetaReviewResultのJSON形式で回答してください。
`
}

/**
 * Meta Review Resultのvalidation
 * AIが不正なJSONを返した場合は blocked として扱う
 */
export function parseMetaReviewResult(
  rawResponse: string,
  taskId: string
): MetaReviewResult {
  for (const jsonStr of extractJsonCandidates(rawResponse)) {
    try {
      const parsed: unknown = JSON.parse(jsonStr)
      if (!isRecord(parsed)) {
        throw new Error('Parsed value is not an object')
      }
      return buildMetaReviewResult(parsed, taskId)
    } catch {
      // 別候補を試す。全候補が失敗した場合だけ blocked に倒す。
    }
  }

  // パース失敗は最も安全な方向（blocked）に倒す
  // デバッグ用: 実際の応答内容を出力する（次回の修正に役立てる）
  console.error('=== Meta Review パース失敗 ===')
  console.error('応答の先頭200文字:', rawResponse.slice(0, 200))
  console.error('応答の末尾200文字:', rawResponse.slice(-200))
  console.error('応答の全文字数:', rawResponse.length)
  console.error('==============================')

  return {
    id: `meta-review-${taskId}-${Date.now()}`,
    taskId,
    status: 'blocked',
    riskLevel: 'critical',
    summary: 'Meta Review AIの応答をパースできませんでした。安全のためblockedとします。',
    findings: [{
      severity: 'critical',
      category: 'security_regression',
      message: 'Meta Review AIの応答が不正なフォーマットです',
      suggestion: 'GitHub Actions のログで「=== Meta Review パース失敗 ===」を検索して応答内容を確認してください',
    }],
    requiresCeoApproval: true,
    createdAt: new Date().toISOString(),
  }
}

// --- ヘルパー ---

const META_REVIEW_STATUSES: readonly MetaReviewStatus[] = [
  'approved',
  'changes_requested',
  'blocked',
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
]

function extractJsonCandidates(rawResponse: string): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (candidate: string): void => {
    const trimmed = candidate.trim()
    if (trimmed && !seen.has(trimmed)) {
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

function buildMetaReviewResult(
  parsed: Record<string, unknown>,
  taskId: string
): MetaReviewResult {
  if (!isMetaReviewStatus(parsed.status)) {
    throw new Error('Invalid status')
  }

  const riskLevel = isMetaRiskLevel(parsed.riskLevel) ? parsed.riskLevel : 'high'

  return {
    id: `meta-review-${taskId}-${Date.now()}`,
    taskId,
    status: parsed.status,
    riskLevel,
    summary: typeof parsed.summary === 'string'
      ? parsed.summary
      : 'Parse warning - summary was missing',
    findings: normalizeFindings(parsed.findings, riskLevel),
    requiresCeoApproval: typeof parsed.requiresCeoApproval === 'boolean'
      ? parsed.requiresCeoApproval
      : false,
    createdAt: new Date().toISOString(),
  }
}

function normalizeFindings(value: unknown, fallbackSeverity: MetaRiskLevel): MetaReviewResult['findings'] {
  if (!Array.isArray(value)) return []

  return value
    .filter(isRecord)
    .map((finding) => ({
      severity: isMetaRiskLevel(finding.severity) ? finding.severity : fallbackSeverity,
      category: isMetaFindingCategory(finding.category)
        ? finding.category
        : 'security_regression',
      message: typeof finding.message === 'string' ? finding.message : 'No message',
      file: typeof finding.file === 'string' ? finding.file : undefined,
      line: typeof finding.line === 'number' ? finding.line : undefined,
      suggestion: typeof finding.suggestion === 'string' ? finding.suggestion : undefined,
    }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMetaReviewStatus(value: unknown): value is MetaReviewStatus {
  return typeof value === 'string' && META_REVIEW_STATUSES.includes(value as MetaReviewStatus)
}

function isMetaRiskLevel(value: unknown): value is MetaRiskLevel {
  return typeof value === 'string' && META_RISK_LEVELS.includes(value as MetaRiskLevel)
}

function isMetaFindingCategory(value: unknown): value is MetaFindingCategory {
  return typeof value === 'string' && META_FINDING_CATEGORIES.includes(value as MetaFindingCategory)
}

function inferRelatedSpecs(changedFiles: string[]): string[] {
  const specs: string[] = []
  if (changedFiles.some((f) => f.includes('guard') || f.includes('sandbox'))) {
    specs.push('specs/11_runtime_environment.md')
    specs.push('specs/08_permissions.md')
  }
  if (changedFiles.some((f) => f.includes('worker'))) {
    specs.push('specs/04_ai_organization.md')
  }
  if (changedFiles.some((f) => f.includes('shared'))) {
    specs.push('specs/03_system_architecture.md')
  }
  if (changedFiles.some((f) => f === 'CLAUDE.md')) {
    specs.push('specs/08_permissions.md')
    specs.push('specs/01_vision.md')
  }
  return [...new Set(specs)]
}
