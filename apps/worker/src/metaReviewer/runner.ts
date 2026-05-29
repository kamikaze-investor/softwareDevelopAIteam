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
 * 3. Meta Reviewer AI（Claude）にプロンプト + diff を渡す
 * 4. MetaReviewResultを受け取る
 * 5. blocked → Jobを停止・CEOへ通知
 *    changes_requested → 修正Jobを作成
 *    approved → 次のJobへ
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type {
  MetaReviewRequest,
  MetaReviewResult,
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
  workingDir: string
): MetaReviewRequest {
  return {
    taskId,
    taskTitle,
    targetArea: classifyTargetArea(changedFiles),
    changedFiles,
    gitDiff: getGitDiff(workingDir),
    relatedSpecs: inferRelatedSpecs(changedFiles),
  }
}

/**
 * Meta Reviewer AIに渡すプロンプトを構築する
 */
export function buildMetaReviewPrompt(request: MetaReviewRequest): string {
  const systemPrompt = readFileSync(META_REVIEWER_PROMPT_PATH, 'utf-8')
  const checklist = readFileSync(META_REVIEWER_CHECKLIST_PATH, 'utf-8')

  return `${systemPrompt}

---

## チェックリスト（参考）

${checklist}

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
  try {
    // JSONブロックを抽出
    const jsonMatch = rawResponse.match(/```json\n([\s\S]+?)\n```/) ||
                      rawResponse.match(/\{[\s\S]+\}/)
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : rawResponse
    const parsed = JSON.parse(jsonStr)

    // 必須フィールドの検証
    if (!['approved', 'changes_requested', 'blocked'].includes(parsed.status)) {
      throw new Error('Invalid status')
    }

    return {
      id: `meta-review-${taskId}-${Date.now()}`,
      taskId,
      status: parsed.status,
      riskLevel: parsed.riskLevel ?? 'high',
      summary: parsed.summary ?? 'Parse error - treated as high risk',
      findings: parsed.findings ?? [],
      requiresCeoApproval: parsed.requiresCeoApproval ?? false,
      createdAt: new Date().toISOString(),
    }
  } catch {
    // パース失敗は最も安全な方向（blocked）に倒す
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
        suggestion: 'Meta Reviewer AIの応答を確認してください',
      }],
      requiresCeoApproval: true,
      createdAt: new Date().toISOString(),
    }
  }
}

// --- ヘルパー ---

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
