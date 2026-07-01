import {
  classifyApprovalLevel,
  determineApprovalLevel,
  shouldEscalateToAiReview,
} from './approvalLevelClassifier'
import type { ClassifierInput, ClassifierResult } from './types/approvalLevel'

interface Expectation {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toContain(expected: unknown): void
  toBeGreaterThanOrEqual(expected: number): void
}

declare const describe: (name: string, fn: () => void) => void
declare const it: (name: string, fn: () => void) => void
declare const expect: (actual: unknown) => Expectation

const DEFAULT_FLAGS = {
  jobRunnerTouched: false,
  aiCliPathTouched: false,
  contextFilesTouched: false,
} satisfies Pick<ClassifierInput, 'jobRunnerTouched' | 'aiCliPathTouched' | 'contextFilesTouched'>

function classify(
  changedFiles: string[],
  diffText: string,
  overrides: Partial<ClassifierInput> = {},
): ClassifierResult {
  return classifyApprovalLevel({
    changedFiles,
    diffText,
    ...DEFAULT_FLAGS,
    ...overrides,
  })
}

function determine(changedFiles: string[], diffText = '', taskKind?: string) {
  return determineApprovalLevel('job-1', 'task-1', changedFiles, diffText, taskKind)
}

describe('approvalLevelClassifier Level 0', () => {
  it('docs更新のみはLevel0', () => {
    const result = determine(['docs/guide.md'], '+本文を更新')

    expect(result.level).toBe(0)
    expect(result.confidence).toBe(0.95)
    expect(result.requiresChatGptReview).toBe(false)
  })

  it('.gitignoreのみはLevel0', () => {
    const result = determine(['.gitignore'], '+tmp/')

    expect(result.level).toBe(0)
    expect(result.requiresChatGptReview).toBe(false)
  })

  it('新規テスト追加のみはLevel0', () => {
    const diffText = [
      'diff --git a/apps/api/src/example.test.ts b/apps/api/src/example.test.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/apps/api/src/example.test.ts',
      '@@',
      "+it('works', () => {})",
    ].join('\n')
    const result = determine(['apps/api/src/example.test.ts'], diffText)

    expect(result.level).toBe(0)
    expect(result.requiresChatGptReview).toBe(false)
  })
})

describe('approvalLevelClassifier Level 1', () => {
  it('型定義追加のみはLevel1', () => {
    const result = determine(
      ['packages/shared/src/types/example.ts'],
      '+export interface Example { name: string }',
    )

    expect(result.level).toBe(1)
    expect(result.requiresChatGptReview).toBe(false)
  })

  it('Zodスキーマ拡張のみはLevel1', () => {
    const diffText = [
      '+const ProjectSchema = z.object({',
      '+  name: z.string(),',
      '+})',
    ].join('\n')
    const result = determine(['apps/api/src/routes/projects.ts'], diffText)

    expect(result.level).toBe(1)
    expect(result.requiresChatGptReview).toBe(false)
  })
})

describe('approvalLevelClassifier Level 2', () => {
  it('jobRunner.tsを含む変更はLevel2', () => {
    const result = determine(['apps/worker/src/jobRunner.ts'], '+const retryLimit = 1')

    expect(result.level).toBe(2)
    expect(result.confidence).toBe(0.93)
    expect(result.requiresChatGptReview).toBe(false)
  })

  it('aiCli/factory.tsを含む変更はLevel2', () => {
    const result = determine(['apps/worker/src/aiCli/factory.ts'], '+export const provider = "codex"')

    expect(result.level).toBe(2)
    expect(result.confidence).toBe(0.88)
    expect(result.requiresChatGptReview).toBe(false)
  })

  it('contextFilesTouched=trueはLevel2', () => {
    const result = classify(
      ['docs/project_memory/notes.md'],
      '+context更新',
      { contextFilesTouched: true },
    )

    expect(result.level).toBe(2)
    expect(result.confidence).toBe(0.85)
  })

  it('task-023相当のjob.ts + jobs.ts + jobRunner.tsはLevel2', () => {
    const result = determine(
      [
        'packages/shared/src/types/job.ts',
        'apps/api/src/routes/jobs.ts',
        'apps/worker/src/jobRunner.ts',
      ],
      '+const approvalLevel = 2',
    )

    expect(result.level).toBe(2)
    expect(result.requiresChatGptReview).toBe(false)
  })
})

describe('approvalLevelClassifier Level 3 Mechanical Gate', () => {
  it('postTestHook.ps1変更はLevel3かつChatGPTレビュー対象', () => {
    const result = determine(['apps/worker/scripts/postTestHook.ps1'], '+Write-Host ok')

    expect(result.level).toBe(3)
    expect(result.requiresChatGptReview).toBe(true)
  })

  it('metaReviewer配下変更はLevel3かつChatGPTレビュー対象', () => {
    const result = determine(['apps/worker/src/metaReviewer/runner.ts'], '+const timeout = 1')

    expect(result.level).toBe(3)
    expect(result.requiresChatGptReview).toBe(true)
  })

  it('.env変更はLevel3かつChatGPTレビュー対象', () => {
    const result = determine(['.env'], '+SECRET=value')

    expect(result.level).toBe(3)
    expect(result.requiresChatGptReview).toBe(true)
  })

  it('.github/workflows変更はLevel3かつChatGPTレビュー対象', () => {
    const result = determine(['.github/workflows/ci.yml'], '+name: ci')

    expect(result.level).toBe(3)
    expect(result.requiresChatGptReview).toBe(true)
  })

  it('test.skip追加はLevel3かつChatGPTレビュー対象', () => {
    const result = determine(['apps/api/src/routes/jobs.test.ts'], "+it.skip('skips', () => {})")

    expect(result.level).toBe(3)
    expect(result.requiresChatGptReview).toBe(true)
  })

  it('空catch追加はLevel3かつChatGPTレビュー対象', () => {
    const result = determine(['apps/api/src/routes/jobs.ts'], '+try { run() } catch (error) {}')

    expect(result.level).toBe(3)
    expect(result.requiresChatGptReview).toBe(true)
  })

  it('blockからallowへの反転はLevel3かつChatGPTレビュー対象', () => {
    const result = determine(['apps/worker/src/guards/newGuard.ts'], '+const block = allow')

    expect(result.level).toBe(3)
    expect(result.requiresChatGptReview).toBe(true)
  })
})

describe('approvalLevelClassifier CLAUDE.md / AGENTS.md special cases', () => {
  it('安全ルール弱体化を含む変更はLevel3かつChatGPTレビュー対象', () => {
    const result = determine(
      ['CLAUDE.md'],
      ['-禁止ルールを削除', '+自動承認でチェック不要'].join('\n'),
    )

    expect(result.level).toBe(3)
    expect(result.requiresChatGptReview).toBe(true)
  })

  it('軽微な文言修正のみはLevel2', () => {
    const result = determine(
      ['AGENTS.md'],
      ['-古い説明文', '+新しい説明文'].join('\n'),
    )

    expect(result.level).toBe(2)
    expect(result.requiresChatGptReview).toBe(false)
  })
})

describe('approvalLevelClassifier required to optional special cases', () => {
  it('permission関連ファイルのoptional化はLevel3かつChatGPTレビュー対象', () => {
    const result = determine(
      ['packages/shared/src/types/permission_grant.ts'],
      '+const PermissionSchema = z.object({ token: z.string().optional() })',
    )

    expect(result.level).toBe(3)
    expect(result.requiresChatGptReview).toBe(true)
  })

  it('通常APIフィールド追加のoptional化はLevel2かつneedsEscalation=true', () => {
    const result = determine(
      ['apps/api/src/routes/projects.ts'],
      '+const ProjectSchema = z.object({ nickname: z.string().optional() })',
    )

    expect(result.level).toBe(2)
    expect(result.classifierResult.needsEscalation).toBe(true)
    expect(result.requiresChatGptReview).toBe(false)
  })
})

describe('approvalLevelClassifier fallback cases', () => {
  it('空入力はLevel3かつChatGPTレビュー対象', () => {
    const result = determine([])

    expect(result.level).toBe(3)
    expect(result.requiresChatGptReview).toBe(true)
  })

  it('未知パターンのみはLevel3', () => {
    const result = determine(['src/random.ts'], '+export const value = 1')

    expect(result.level).toBe(3)
    expect(result.classifierResult.reasons[0]?.rule).toBe('UNMATCHED_FALLBACK')
  })

  it('31ファイル変更はLevel3', () => {
    const changedFiles = Array.from({ length: 31 }, (_, index) => `docs/file-${index}.md`)
    const result = determine(changedFiles, '+docs update')

    expect(result.level).toBe(3)
    expect(result.requiresChatGptReview).toBe(true)
  })
})

describe('reviewPolicy', () => {
  it('Level0（docs更新のみ）→ reviewPolicy: mechanical_only', () => {
    const result = determine(['docs/guide.md'], '+updated docs')

    expect(result.reviewPolicy).toBe('mechanical_only')
    expect(result.classifierResult.reviewPolicy).toBe('mechanical_only')
  })

  it('Level0（.gitignoreのみ）→ reviewPolicy: mechanical_only', () => {
    const result = determine(['.gitignore'], '+tmp/')

    expect(result.reviewPolicy).toBe('mechanical_only')
    expect(result.classifierResult.reviewPolicy).toBe('mechanical_only')
  })

  it('Level0（新規テストファイルのみ）→ reviewPolicy: mechanical_only', () => {
    const diffText = [
      'diff --git a/apps/api/src/example.test.ts b/apps/api/src/example.test.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/apps/api/src/example.test.ts',
      '@@',
      "+it('works', () => {})",
    ].join('\n')
    const result = determine(['apps/api/src/example.test.ts'], diffText)

    expect(result.reviewPolicy).toBe('mechanical_only')
    expect(result.classifierResult.reviewPolicy).toBe('mechanical_only')
  })

  it('Level1（type-definitionのみ・削除なし・1ファイル）→ reviewPolicy: mechanical_only', () => {
    const result = determine(
      ['packages/shared/src/types/example.ts'],
      '+export interface Example { name: string }',
    )

    expect(result.reviewPolicy).toBe('mechanical_only')
    expect(result.classifierResult.reviewPolicy).toBe('mechanical_only')
  })

  it('Level1（type-definitionのみ・削除なし・3ファイル）→ reviewPolicy: mechanical_only', () => {
    const result = determine(
      [
        'packages/shared/src/types/exampleA.ts',
        'packages/shared/src/types/exampleB.ts',
        'packages/shared/src/types/exampleC.ts',
      ],
      '+export interface Example { name: string }',
    )

    expect(result.reviewPolicy).toBe('mechanical_only')
    expect(result.classifierResult.reviewPolicy).toBe('mechanical_only')
  })

  it('Level1（type-definitionのみだが4ファイル以上）→ reviewPolicy: light_ai_post_review', () => {
    const result = determine(
      [
        'packages/shared/src/types/exampleA.ts',
        'packages/shared/src/types/exampleB.ts',
        'packages/shared/src/types/exampleC.ts',
        'packages/shared/src/types/exampleD.ts',
      ],
      '+export interface Example { name: string }',
    )

    expect(result.reviewPolicy).toBe('light_ai_post_review')
    expect(result.classifierResult.reviewPolicy).toBe('light_ai_post_review')
  })

  it('Level1（zod-schema拡張を含む）→ reviewPolicy: light_ai_post_review', () => {
    const result = determine(
      ['apps/api/src/routes/projects.ts'],
      ['+const ProjectSchema = z.object({', '+  name: z.string(),', '+})'].join('\n'),
    )

    expect(result.reviewPolicy).toBe('light_ai_post_review')
    expect(result.classifierResult.reviewPolicy).toBe('light_ai_post_review')
  })

  it('Level1（non-breaking-extensionを含む）→ reviewPolicy: light_ai_post_review', () => {
    const result = determine(
      ['packages/shared/src/utils/example.ts'],
      '+export function helper(): string { return "ok" }',
    )

    expect(result.reviewPolicy).toBe('light_ai_post_review')
    expect(result.classifierResult.reviewPolicy).toBe('light_ai_post_review')
  })

  it('Level2（jobRunner.ts変更）→ reviewPolicy: full_pre_post_review', () => {
    const result = determine(['apps/worker/src/jobRunner.ts'], '+const retryLimit = 1')

    expect(result.reviewPolicy).toBe('full_pre_post_review')
    expect(result.classifierResult.reviewPolicy).toBe('full_pre_post_review')
  })

  it('Level2（aiCliPathTouched）→ reviewPolicy: full_pre_post_review', () => {
    const result = determine(['apps/worker/src/aiCli/factory.ts'], '+export const provider = "codex"')

    expect(result.reviewPolicy).toBe('full_pre_post_review')
    expect(result.classifierResult.reviewPolicy).toBe('full_pre_post_review')
  })

  it('Level2（CLAUDE.md/AGENTS.md軽微変更）→ reviewPolicy: full_pre_post_review', () => {
    const result = determine(['AGENTS.md'], ['-old text', '+new text'].join('\n'))

    expect(result.reviewPolicy).toBe('full_pre_post_review')
    expect(result.classifierResult.reviewPolicy).toBe('full_pre_post_review')
  })

  it('Level2（required→optional、安全非関係）→ reviewPolicy: full_pre_post_review', () => {
    const result = determine(
      ['apps/api/src/routes/projects.ts'],
      '+const ProjectSchema = z.object({ nickname: z.string().optional() })',
    )

    expect(result.reviewPolicy).toBe('full_pre_post_review')
    expect(result.classifierResult.reviewPolicy).toBe('full_pre_post_review')
  })

  it('Level3（Mechanical Gate: postTestHook.ps1）→ reviewPolicy: ceo_required', () => {
    const result = determine(['apps/worker/scripts/postTestHook.ps1'], '+Write-Host ok')

    expect(result.reviewPolicy).toBe('ceo_required')
    expect(result.classifierResult.reviewPolicy).toBe('ceo_required')
  })

  it('Level3（判定不能・空入力）→ reviewPolicy: ceo_required', () => {
    const result = determine([])

    expect(result.reviewPolicy).toBe('ceo_required')
    expect(result.classifierResult.reviewPolicy).toBe('ceo_required')
  })

  it('Level3（required→optional、安全関係あり）→ reviewPolicy: ceo_required', () => {
    const result = determine(
      ['packages/shared/src/types/permission_grant.ts'],
      '+const PermissionSchema = z.object({ token: z.string().optional() })',
    )

    expect(result.reviewPolicy).toBe('ceo_required')
    expect(result.classifierResult.reviewPolicy).toBe('ceo_required')
  })

  it('Level3（大量ファイル変更）→ reviewPolicy: ceo_required', () => {
    const changedFiles = Array.from({ length: 31 }, (_, index) => `docs/file-${index}.md`)
    const result = determine(changedFiles, '+docs update')

    expect(result.reviewPolicy).toBe('ceo_required')
    expect(result.classifierResult.reviewPolicy).toBe('ceo_required')
  })

  it('determineApprovalLevel()の戻り値でApprovalLevelResult.reviewPolicyが' +
     'classifierResult.reviewPolicyと一致する（task-023相当の入力で確認）', () => {
    const result = determine(
      [
        'packages/shared/src/types/job.ts',
        'apps/api/src/routes/jobs.ts',
        'apps/worker/src/jobRunner.ts',
      ],
      '+const approvalLevel = 2',
    )

    expect(result.reviewPolicy).toBe(result.classifierResult.reviewPolicy)
    expect(result.reviewPolicy).toBe('full_pre_post_review')
  })
})

describe('shouldEscalateToAiReview', () => {
  it('confidence 0.9かつneedsEscalation=falseならfalse', () => {
    const result = shouldEscalateToAiReview({
      level: 1,
      confidence: 0.9,
      reasons: [],
      needsEscalation: false,
      reviewPolicy: 'mechanical_only',
    })

    expect(result).toBe(false)
  })

  it('confidence 0.7ならtrue', () => {
    const result = shouldEscalateToAiReview({
      level: 1,
      confidence: 0.7,
      reasons: [],
      needsEscalation: false,
      reviewPolicy: 'light_ai_post_review',
    })

    expect(result).toBe(true)
  })

  it('needsEscalation=trueならtrue', () => {
    const result = shouldEscalateToAiReview({
      level: 2,
      confidence: 0.9,
      reasons: [],
      needsEscalation: true,
      reviewPolicy: 'full_pre_post_review',
    })

    expect(result).toBe(true)
  })
})

describe('requiresChatGptReview decisions', () => {
  it('confidence 0.4の判定不能ケースはtrue', () => {
    const result = determine(['src/random.ts'], '+export const value = 1')

    expect(result.confidence).toBe(0.4)
    expect(result.requiresChatGptReview).toBe(true)
  })

  it('confidence 0.9以上のLevel2はfalse', () => {
    const result = determine(
      ['apps/worker/src/jobRunner.ts', 'apps/worker/src/aiCli/factory.ts'],
      '+const approvalLevel = 2',
    )

    expect(result.level).toBe(2)
    expect(result.confidence).toBeGreaterThanOrEqual(0.9)
    expect(result.requiresChatGptReview).toBe(false)
  })
})
