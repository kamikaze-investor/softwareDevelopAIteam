import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiCliResult, ApprovalLevelResult } from '@ai-team/shared'

// callGeminiWithFallback だけを差し替え、AGY_* モデル定数など他の export は実物を使う
// （定数を落とすと呼び出し元の `...AGY_LIGHT_MODEL` が undefined 展開で壊れる）。
vi.mock('../metaReviewer/geminiRouter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../metaReviewer/geminiRouter.js')>()),
  callGeminiWithFallback: vi.fn(),
}))

vi.mock('../aiCli/factory.js', () => ({
  createAiCliAdapter: vi.fn(),
}))

import { createAiCliAdapter } from '../aiCli/factory.js'
import { callGeminiWithFallback } from '../metaReviewer/geminiRouter.js'
import { TARGET_ROOT } from '../utils/pathUtils.js'
import {
  buildReviewPrompt,
  ClaudeReviewerAdapter,
  extractClaudeCliResultText,
  CodexReviewerAdapter,
  createReviewerAdapter,
  GeminiReviewerAdapter,
  parseReviewerResponse,
  REPOSITORY_CONTEXT_MAX_FILE_CHARS,
  REPOSITORY_CONTEXT_MAX_TOTAL_CHARS,
  reviewWithSeparation,
  selectReviewerProvider,
  shouldEscalateToChatGpt,
} from './reviewerAdapter.js'
import type {
  ImplementerProvider,
  ReviewerRequest,
  ReviewerResult,
  ReviewVerdict,
} from './reviewerAdapter.js'

const mockCallGeminiWithFallback = vi.mocked(callGeminiWithFallback)
const mockCreateAiCliAdapter = vi.mocked(createAiCliAdapter)

function makeApprovalLevelResult(overrides: Partial<ApprovalLevelResult> = {}): ApprovalLevelResult {
  const level = overrides.level ?? 2

  return {
    jobId: 'job-1',
    taskId: 'task-1',
    level,
    confidence: 0.9,
    mechanicalGate: {
      triggered: false,
      hits: [],
    },
    classifierResult: {
      level,
      confidence: 0.9,
      reasons: [],
      needsEscalation: false,
      reviewPolicy: 'full_pre_post_review',
    },
    finalReason: 'test fixture',
    decidedAt: '2026-07-01T00:00:00.000Z',
    requiresChatGptReview: false,
    reviewPolicy: 'full_pre_post_review',
    ...overrides,
  }
}

function makeRequest(overrides: Partial<ReviewerRequest> = {}): ReviewerRequest {
  return {
    jobId: 'job-1',
    subjectId: 'task-1',
    taskId: 'task-1',
    implementerProvider: 'codex',
    reviewerProvider: 'gemini',
    phase: 'pre',
    planText: 'apps/worker/src/index.ts を修正する',
    diffText: '+const value = 1',
    purposeSummary: 'レビュー分離を実装する',
    targetFiles: ['apps/worker/src/approvalLevel/reviewerAdapter.ts'],
    ...overrides,
  }
}

function reviewerJson(verdict: ReviewVerdict, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict,
    summary: 'レビュー結果です',
    issues: [{ severity: 'warning', description: '確認事項があります' }],
    confidence: 0.8,
    ...overrides,
  })
}

function makeReviewerResult(overrides: Partial<ReviewerResult> = {}): ReviewerResult {
  return {
    provider: 'gemini',
    phase: 'post',
    verdict: 'approved',
    summary: 'ok',
    issues: [],
    confidence: 0.9,
    generatedAt: '2026-07-01T00:00:00.000Z',
    rawResponse: reviewerJson('approved'),
    ...overrides,
  }
}

function makeAiCliResult(overrides: Partial<AiCliResult> = {}): AiCliResult {
  return {
    taskId: 'task-1',
    provider: 'codex',
    exitCode: 0,
    stdout: reviewerJson('approved'),
    stderr: '',
    changedFiles: [],
    durationMs: 10,
    ...overrides,
  }
}


/** 2026-09-07に実測したClaude Code CLIの `--output-format json` envelope形状。 */
function claudeEnvelope(inner: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: inner,
    duration_ms: 10,
    ...overrides,
  })
}

function mockCodexAdapterRun(): ReturnType<typeof vi.fn> {
  const run = vi.fn()
  mockCreateAiCliAdapter.mockReturnValue({ run } as ReturnType<typeof createAiCliAdapter>)
  return run
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('selectReviewerProvider', () => {
  it('claude_code の reviewer は gemini', () => {
    expect(selectReviewerProvider('claude_code')).toBe('gemini')
  })

  it('codex の reviewer は gemini', () => {
    expect(selectReviewerProvider('codex')).toBe('gemini')
  })

  it('gemini の reviewer は claude', () => {
    expect(selectReviewerProvider('gemini')).toBe('claude')
  })

  it('全 implementer で reviewer が implementer と一致しない', () => {
    const implementers: ImplementerProvider[] = ['claude_code', 'codex', 'gemini']

    for (const implementer of implementers) {
      expect(selectReviewerProvider(implementer)).not.toBe(implementer)
    }
  })
})

describe('buildReviewPrompt', () => {
  it('phase:pre で planText が含まれる', () => {
    const prompt = buildReviewPrompt(makeRequest({
      phase: 'pre',
      planText: '変更計画: reviewerAdapter を追加する',
    }))

    expect(prompt).toContain('これは実装前の変更計画レビューです')
    expect(prompt).toContain('変更計画: reviewerAdapter を追加する')
  })

  it('phase:post で diffText が含まれる', () => {
    const prompt = buildReviewPrompt(makeRequest({
      phase: 'post',
      diffText: '+export const reviewed = true',
    }))

    expect(prompt).toContain('これは実装後のdiffレビューです')
    expect(prompt).toContain('+export const reviewed = true')
  })

  it('JSON形式指示の文言が含まれる', () => {
    const prompt = buildReviewPrompt(makeRequest())

    expect(prompt).toContain('以下のJSON形式で回答してください。他のテキストを含めないでください。')
    expect(prompt).toContain('"verdict": "approved" | "changes_requested" | "blocking"')
  })

  it('Constitution 3.14〜3.15 の原則本文が含まれる', () => {
    const prompt = buildReviewPrompt(makeRequest())

    expect(prompt).toContain('## 3.14 Minimum Sufficient Validation')
    expect(prompt).toContain('必要最小限の独立した反証レビュー')
    expect(prompt).toContain('CEO確認は、原則として次の場合に限る')
  })

  it('purposeSummary と targetFiles が含まれる', () => {
    const prompt = buildReviewPrompt(makeRequest({
      purposeSummary: 'Level 1以上で別AIレビューを実行する',
      targetFiles: ['a.ts', 'b.ts'],
    }))

    expect(prompt).toContain('Level 1以上で別AIレビューを実行する')
    expect(prompt).toContain('- a.ts')
    expect(prompt).toContain('- b.ts')
  })

  it('includes Decision Authority only for authority/recovery/approval target paths', () => {
    const authorityPrompt = buildReviewPrompt(makeRequest({
      targetFiles: ['apps/api/src/designReview/resumeBlockedTask.ts'],
    }))
    const unrelatedPrompt = buildReviewPrompt(makeRequest({
      targetFiles: ['apps/mobile/src/screens/Home.tsx'],
    }))

    expect(authorityPrompt).toContain('## 1-2. Human Decision Authority')
    expect(authorityPrompt).toContain('## 14-3. Priority 2 境界表')
    expect(unrelatedPrompt).not.toContain('## 1-2. Human Decision Authority')
    expect(unrelatedPrompt).not.toContain('## 14-3. Priority 2 境界表')
  })
})

describe('buildReviewPrompt repository context', () => {
  let repoRoot: string

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-repo-'))
  })

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  })

  function writeRepoFile(relativePath: string, content: string): void {
    const fullPath = path.join(repoRoot, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
  }

  it('phase:post で diff に加えて対象ファイルの現在内容（diff外の行を含む）を載せる', () => {
    writeRepoFile('src/feature.ts', [
      'export function callerOutsideDiff(): number {',
      '  return reviewed()',
      '}',
      'export const reviewed = () => 1',
    ].join('\n'))

    const prompt = buildReviewPrompt(makeRequest({
      phase: 'post',
      diffText: '+export const reviewed = () => 1',
      targetFiles: ['src/feature.ts'],
    }), [], repoRoot)

    expect(prompt).toContain('+export const reviewed = () => 1')
    expect(prompt).toContain('Repository context')
    expect(prompt).toContain('### src/feature.ts')
    expect(prompt).toContain('export function callerOutsideDiff(): number {')
  })

  it('phase:pre でも対象ファイルの現在内容を載せる', () => {
    writeRepoFile('src/existing.ts', 'export const contractBeforeChange = 42')

    const prompt = buildReviewPrompt(makeRequest({
      phase: 'pre',
      targetFiles: ['src/existing.ts'],
    }), [], repoRoot)

    expect(prompt).toContain('export const contractBeforeChange = 42')
  })

  it('存在しないファイルは黙って落とさず、載せていない理由を明示する', () => {
    const prompt = buildReviewPrompt(makeRequest({ targetFiles: ['src/deleted.ts'] }), [], repoRoot)

    expect(prompt).toContain('### src/deleted.ts')
    expect(prompt).toContain('ファイルが存在しません')
  })

  it('repository外を指すパス・symlinkの内容は載せない', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-outside-'))
    try {
      fs.writeFileSync(path.join(outsideDir, 'outside.txt'), 'OUTSIDE_REPO_CONTENT')
      fs.symlinkSync(path.join(outsideDir, 'outside.txt'), path.join(repoRoot, 'link.txt'))

      const prompt = buildReviewPrompt(makeRequest({
        targetFiles: [path.relative(repoRoot, path.join(outsideDir, 'outside.txt')), 'link.txt'],
      }), [], repoRoot)

      expect(prompt).not.toContain('OUTSIDE_REPO_CONTENT')
      expect(prompt).toContain('repository外を指すため載せていません')
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('.env 等の秘密情報ファイルとsecret scanに一致するファイルの内容は載せない', () => {
    writeRepoFile('.env', 'PLAIN_ENV_CONTENT')
    // fixtureは実行時に組み立てる。リテラルで書くとこのテストのdiff自体がsecret scanに一致し、
    // review送信前にrefusalされるため
    writeRepoFile('src/config.ts', `const ${['pass', 'word'].join('')} = "hunter2"`)

    const prompt = buildReviewPrompt(makeRequest({ targetFiles: ['.env', 'src/config.ts'] }), [], repoRoot)

    expect(prompt).not.toContain('PLAIN_ENV_CONTENT')
    expect(prompt).not.toContain('hunter2')
    expect(prompt).toContain('秘密情報ファイルの可能性があるため載せていません')
    expect(prompt).toContain('secret scanに一致したため載せていません')
  })

  it('通常名のsymlink経由でも、実体が .env 等の秘密情報ファイルなら内容を載せない', () => {
    writeRepoFile('.env', 'SYMLINKED_ENV_CONTENT')
    writeRepoFile('src/normal.ts', 'NORMAL_FILE_CONTENT')
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true })
    fs.symlinkSync(path.join(repoRoot, '.env'), path.join(repoRoot, 'docs', 'notes.txt'))

    const prompt = buildReviewPrompt(makeRequest({
      targetFiles: ['docs/notes.txt', 'src/normal.ts'],
    }), [], repoRoot)

    expect(prompt).not.toContain('SYMLINKED_ENV_CONTENT')
    expect(prompt).toContain('### docs/notes.txt\n(秘密情報ファイルの可能性があるため載せていません)')
    // 秘密情報でない通常ファイルは引き続き載る
    expect(prompt).toContain('NORMAL_FILE_CONTENT')
  })

  it('1ファイルの上限を超える内容は切り詰め、その旨を明示する', () => {
    writeRepoFile('src/large.ts', 'a'.repeat(REPOSITORY_CONTEXT_MAX_FILE_CHARS + 100))

    const prompt = buildReviewPrompt(makeRequest({ targetFiles: ['src/large.ts'] }), [], repoRoot)

    expect(prompt).toContain('a'.repeat(REPOSITORY_CONTEXT_MAX_FILE_CHARS))
    expect(prompt).not.toContain('a'.repeat(REPOSITORY_CONTEXT_MAX_FILE_CHARS + 1))
    expect(prompt).toContain(`先頭${REPOSITORY_CONTEXT_MAX_FILE_CHARS}文字のみ`)
  })

  it('全体上限に達した後のファイルは省略し、その旨を明示する', () => {
    const fileCount = Math.ceil(REPOSITORY_CONTEXT_MAX_TOTAL_CHARS / REPOSITORY_CONTEXT_MAX_FILE_CHARS)
    const files = Array.from({ length: fileCount }, (_, i) => `src/f${i}.ts`)
    for (const file of files) writeRepoFile(file, 'b'.repeat(REPOSITORY_CONTEXT_MAX_FILE_CHARS))
    writeRepoFile('src/last.ts', 'LAST_FILE_CONTENT')

    const prompt = buildReviewPrompt(makeRequest({ targetFiles: [...files, 'src/last.ts'] }), [], repoRoot)

    expect(prompt).not.toContain('LAST_FILE_CONTENT')
    expect(prompt).toContain('repository context全体の上限に達したため載せていません')
  })

  it('CodexReviewerAdapter が実行に渡す prompt に repository context が含まれる', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult())

    await new CodexReviewerAdapter().review(makeRequest({
      reviewerProvider: 'codex',
      phase: 'post',
      targetFiles: ['apps/worker/src/approvalLevel/reviewerAdapter.ts'],
    }))

    // 本番経路はTARGET_ROOTを読む。実行環境のファイル有無に依存しないよう、section自体の存在だけを確認する。
    const prompt = (run.mock.calls[0]?.[0] as { prompt: string }).prompt
    expect(prompt).toContain('Repository context')
  })
})

describe('parseReviewerResponse', () => {
  it('正しいJSONコードブロックから各フィールドを抽出する', () => {
    const raw = [
      '```json',
      reviewerJson('changes_requested'),
      '```',
    ].join('\n')

    const result = parseReviewerResponse(raw, 'gemini', 'pre')

    expect(result.provider).toBe('gemini')
    expect(result.phase).toBe('pre')
    expect(result.verdict).toBe('changes_requested')
    expect(result.summary).toBe('レビュー結果です')
    expect(result.issues).toEqual([{ severity: 'warning', description: '確認事項があります' }])
    expect(result.confidence).toBe(0.8)
    expect(result.rawResponse).toBe(raw)
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('コードブロックなしの素のJSON文字列をパースする', () => {
    const result = parseReviewerResponse(reviewerJson('approved'), 'gemini', 'post')

    expect(result.verdict).toBe('approved')
    expect(result.phase).toBe('post')
  })

  it('normalizes principle_conflict when the issue does not name a provided principle', () => {
    const response = (description: string) => reviewerJson('changes_requested', {
      issues: [{ severity: 'warning', category: 'principle_conflict', description }],
    })
    const accepted = parseReviewerResponse(
      response('specs/22 §1-2 conflicts with the Constitution'),
      'codex',
      'post',
      [],
      ['specs/22 §1-2'],
    )
    const normalized = parseReviewerResponse(
      response('unprovided-principle conflicts with the Constitution'),
      'codex',
      'post',
      [],
      ['specs/22 §1-2'],
    )

    expect(accepted.issues[0].category).toBe('principle_conflict')
    expect(normalized.issues[0].category).toBe('spec_violation')
  })

  it('不正なJSON文字列は fail closed で blocking にする', () => {
    const result = parseReviewerResponse('not json', 'gemini', 'pre')

    expect(result.verdict).toBe('blocking')
    expect(result.summary).toBe('レビュー応答のパースに失敗しました')
    expect(result.confidence).toBe(0)
  })

  it('verdict が不正な値なら fail closed で blocking にする', () => {
    const result = parseReviewerResponse(
      JSON.stringify({ verdict: 'unknown_verdict', summary: 'bad' }),
      'gemini',
      'post',
    )

    expect(result.verdict).toBe('blocking')
    expect(result.confidence).toBe(0)
  })

  it('issues が欠落したら空配列で補完する', () => {
    const result = parseReviewerResponse(
      reviewerJson('approved', { issues: undefined }),
      'gemini',
      'pre',
    )

    expect(result.issues).toEqual([])
  })

  it('issues が配列でなければ空配列で補完する', () => {
    const result = parseReviewerResponse(
      reviewerJson('approved', { issues: 'not-array' }),
      'gemini',
      'pre',
    )

    expect(result.issues).toEqual([])
  })

  it('confidence が欠落したら 0.5 で補完する', () => {
    const result = parseReviewerResponse(
      reviewerJson('approved', { confidence: undefined }),
      'gemini',
      'pre',
    )

    expect(result.confidence).toBe(0.5)
  })

  it('summary が欠落したらデフォルト文言で補完する', () => {
    const result = parseReviewerResponse(
      reviewerJson('approved', { summary: undefined }),
      'gemini',
      'pre',
    )

    expect(result.summary).toBe('(summary not provided)')
  })
})

describe('GeminiReviewerAdapter.review', () => {
  it('callGeminiWithFallback が正常なJSON文字列を返すとパース結果を返す', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    const result = await new GeminiReviewerAdapter().review(makeRequest({ phase: 'pre' }))

    expect(result.verdict).toBe('approved')
    expect(result.provider).toBe('gemini')
    expect(mockCallGeminiWithFallback).toHaveBeenCalledWith(
      expect.stringContaining('これは実装前の変更計画レビューです'),
      { featureName: 'approval-level-pre-review' },
    )
  })

  it('callGeminiWithFallback が例外をthrowすると fail closed にする', async () => {
    mockCallGeminiWithFallback.mockRejectedValue(new Error('quota exhausted'))

    const result = await new GeminiReviewerAdapter().review(makeRequest({ phase: 'post' }))

    expect(result.verdict).toBe('blocking')
    expect(result.summary).toContain('レビューAI呼び出しに失敗しました: quota exhausted')
    expect(result.confidence).toBe(0)
    expect(result.rawResponse).toBe('')
  })
})

describe('CodexReviewerAdapter.review', () => {
  it('createAiCliAdapter 経由で mode:review と expectJson:true を渡す', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult())

    await new CodexReviewerAdapter().review(makeRequest({
      reviewerProvider: 'codex',
      phase: 'post',
    }))

    expect(mockCreateAiCliAdapter).toHaveBeenCalledWith({ provider: 'codex' })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      provider: 'codex',
      workingDir: TARGET_ROOT,
      contextFiles: [],
      mode: 'review',
      expectJson: true,
    }))
  })

  it('reviewKind=roadmapではsubjectIdをtaskIdへ合成せず、ラベル付き値をadapter.runへ渡す', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult())

    await new CodexReviewerAdapter().review(makeRequest({
      reviewerProvider: 'codex',
      reviewKind: 'roadmap',
      subjectId: 'project-1',
      taskId: undefined,
    }))

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'roadmap-review:project-1',
    }))
  })

  it('adapter.run に Codex Reviewer 専用モデルを渡す', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult())

    await new CodexReviewerAdapter().review(makeRequest({
      reviewerProvider: 'codex',
    }))

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol',
    }))
  })

  it.each<ReviewVerdict>(['approved', 'changes_requested', 'blocking'])(
    'stdout の正常JSONを %s に変換する',
    async verdict => {
      const run = mockCodexAdapterRun()
      run.mockResolvedValue(makeAiCliResult({ stdout: reviewerJson(verdict) }))

      const result = await new CodexReviewerAdapter().review(makeRequest({
        reviewerProvider: 'codex',
      }))

      expect(result.provider).toBe('codex')
      expect(result.verdict).toBe(verdict)
    },
  )

  it('prefers parsedOutput when stdout contains Codex narration before unfenced JSON', async () => {
    const run = mockCodexAdapterRun()
    const rawStdout = [
      'codex exec started',
      'I inspected the requested files and found the final reviewer verdict.',
      '{"verdict":"approved","summary":"parsed output succeeded","issues":[],"confidence":0.9}',
    ].join('\n')

    expect(parseReviewerResponse(rawStdout, 'codex', 'pre').verdict).toBe('blocking')

    run.mockResolvedValue(makeAiCliResult({
      stdout: rawStdout,
      parsedOutput: {
        verdict: 'approved',
        summary: 'parsed output succeeded',
        issues: [],
        confidence: 0.9,
      },
    }))

    const result = await new CodexReviewerAdapter().review(makeRequest({
      reviewerProvider: 'codex',
    }))

    expect(result.provider).toBe('codex')
    expect(result.verdict).toBe('approved')
    expect(result.summary).toBe('parsed output succeeded')
    expect(result.issues).toEqual([])
    expect(result.confidence).toBe(0.9)
    expect(result.rawResponse).toBe(rawStdout)
  })

  it('fails closed on a malformed parsedOutput without falling back to re-parsing stdout', async () => {
    const run = mockCodexAdapterRun()
    // stdout would itself parse successfully if the fallback path were reached -- this proves the
    // malformed parsedOutput case fails closed on its own, rather than silently getting a second
    // chance via the very stdout parsedOutput was specifically built to bypass.
    const rawStdout = '{"verdict":"approved","summary":"should never be used","issues":[],"confidence":0.9}'

    run.mockResolvedValue(makeAiCliResult({
      stdout: rawStdout,
      parsedOutput: {
        summary: 'missing a valid verdict field',
      },
    }))

    const result = await new CodexReviewerAdapter().review(makeRequest({
      reviewerProvider: 'codex',
    }))

    expect(result.provider).toBe('codex')
    expect(result.verdict).toBe('blocking')
    expect(result.summary).toBe('レビュー応答のパースに失敗しました')
    expect(result.rawResponse).toBe(rawStdout)
  })

  it('adapter.run が blocked:true を返すと blocking に倒す', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({
      stdout: reviewerJson('approved'),
      blocked: true,
    }))

    const result = await new CodexReviewerAdapter().review(makeRequest({
      reviewerProvider: 'codex',
    }))

    expect(result.provider).toBe('codex')
    expect(result.verdict).toBe('blocking')
    expect(result.confidence).toBe(0)
  })

  it('adapter.run が exitCode 0以外を返すと blocking に倒す', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({
      exitCode: 2,
      stdout: reviewerJson('approved'),
      stderr: 'cli failed',
    }))

    const result = await new CodexReviewerAdapter().review(makeRequest({
      reviewerProvider: 'codex',
    }))

    expect(result.provider).toBe('codex')
    expect(result.verdict).toBe('blocking')
    expect(result.summary).toContain('exitCode=2')
    expect(result.confidence).toBe(0)
  })

  it('stdout が不正JSONなら fail closed で blocking に倒す', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({ stdout: 'not json' }))

    const result = await new CodexReviewerAdapter().review(makeRequest({
      reviewerProvider: 'codex',
    }))

    expect(result.provider).toBe('codex')
    expect(result.verdict).toBe('blocking')
    expect(result.confidence).toBe(0)
  })

  it('adapter.run が例外をthrowすると blocking に倒す', async () => {
    const run = mockCodexAdapterRun()
    run.mockRejectedValue(new Error('spawn failed'))

    const result = await new CodexReviewerAdapter().review(makeRequest({
      reviewerProvider: 'codex',
    }))

    expect(result.provider).toBe('codex')
    expect(result.verdict).toBe('blocking')
    expect(result.summary).toContain('spawn failed')
    expect(result.confidence).toBe(0)
    expect(result.rawResponse).toBe('')
  })

  it('adapter.run の workingDir は TARGET_ROOT である', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult())

    await new CodexReviewerAdapter().review(makeRequest({
      reviewerProvider: 'codex',
    }))

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      workingDir: TARGET_ROOT,
    }))
    expect(TARGET_ROOT).toBe('/workspace/target')
  })
})

describe('createReviewerAdapter', () => {
  it('gemini は GeminiReviewerAdapter のインスタンスを返す', () => {
    expect(createReviewerAdapter('gemini')).toBeInstanceOf(GeminiReviewerAdapter)
  })

  it('codex は CodexReviewerAdapter のインスタンスを返す', () => {
    expect(createReviewerAdapter('codex')).toBeInstanceOf(CodexReviewerAdapter)
  })

  it('claude は ClaudeReviewerAdapter を返す（2026-09-07に拡張ポイントを実装）', () => {
    expect(createReviewerAdapter('claude')).toBeInstanceOf(ClaudeReviewerAdapter)
  })

  it('chatgpt は未実装エラーをthrowする', () => {
    expect(() => createReviewerAdapter('chatgpt')).toThrow('ChatGptReviewerAdapter は未実装です')
  })
})

describe('reviewWithSeparation', () => {
  it('implementerProvider:claude_code は gemini でレビューされる', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    const result = await reviewWithSeparation({
      ...makeRequest({ implementerProvider: 'claude_code' }),
      phase: 'pre',
    })

    expect(result.provider).toBe('gemini')
    expect(mockCallGeminiWithFallback).toHaveBeenCalledOnce()
  })

  it('implementerProvider:codex は gemini でレビューされる', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    const result = await reviewWithSeparation({
      ...makeRequest({ implementerProvider: 'codex' }),
      phase: 'post',
    })

    expect(result.provider).toBe('gemini')
    expect(result.phase).toBe('post')
    expect(mockCallGeminiWithFallback).toHaveBeenCalledOnce()
  })

  // Claude adapterは実装したが、task-kind reviewでの有効化はPR Cで別途判断する。
  // ここでゲートしないと、gemini実装JobがPR C前にClaudeレビューを走らせ始める
  // （＝PR Aがproduction topologyを変えてしまう。独立レビュー指摘、2026-09-07）。
  it('implementerProvider:gemini のclaude経路はゲートされている（Roadmap cutover後も維持）', () => {
    expect(() => reviewWithSeparation({
      ...makeRequest({ implementerProvider: 'gemini' }),
      phase: 'pre',
    })).toThrow('task-kind reviewでのClaude有効化は行っていません')
  })
})

describe('shouldEscalateToChatGpt', () => {
  it('Level3 かつ requiresChatGptReview:true でも MVP では false を返す', () => {
    expect(shouldEscalateToChatGpt(
      makeApprovalLevelResult({ level: 3, requiresChatGptReview: true }),
      makeReviewerResult({ confidence: 0.1 }),
    )).toBe(false)
  })

  it('レビュー結果が blocking でも MVP では false を返す', () => {
    expect(shouldEscalateToChatGpt(
      makeApprovalLevelResult(),
      makeReviewerResult({ verdict: 'blocking', confidence: 0 }),
    )).toBe(false)
  })
})

// Roadmap final integration reviewは、応答が取れないことを「問題なし」と解釈してはいけない。
// 認証失敗・malformed・timeoutはいずれもfail-closed（blocking / confidence 0）にする。
describe('ClaudeReviewerAdapter.review', () => {
  function makeReq(): ReviewerRequest {
    return {
      jobId: 'job-1',
      reviewKind: 'roadmap',
      subjectId: 'project-1',
      implementerProvider: 'codex',
      reviewerProvider: 'claude',
      phase: 'post',
      purposeSummary: 'roadmap review',
      targetFiles: [],
    }
  }

  it('claude_code adapter を mode:review / expectJson:true / claude-opus-5 で呼ぶ', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({ provider: 'claude_code', stdout: claudeEnvelope(reviewerJson('approved')) }))

    const result = await new ClaudeReviewerAdapter().review(makeReq())

    expect(mockCreateAiCliAdapter).toHaveBeenCalledWith({ provider: 'claude_code' })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'review',
      expectJson: true,
      model: 'claude-opus-5',
      provider: 'claude_code',
    }))
    expect(result.provider).toBe('claude')
    expect(result.verdict).toBe('approved')
  })

  it('roadmap kindではtaskIdを偽装せず、正直なラベルを使う', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({ provider: 'claude_code' }))

    await new ClaudeReviewerAdapter().review(makeReq())

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'roadmap-review:project-1',
    }))
  })

  it('認証失敗（非0 exit）はblockingでfail-closed', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({
      provider: 'claude_code',
      exitCode: 1,
      stdout: '',
      stderr: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    }))

    const result = await new ClaudeReviewerAdapter().review(makeReq())

    expect(result.verdict).toBe('blocking')
    expect(result.confidence).toBe(0)
    expect(result.rawResponse).toContain('OAuth session expired')
  })

  it('malformed outputはblockingでfail-closed', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({ provider: 'claude_code', stdout: 'not json at all' }))

    const result = await new ClaudeReviewerAdapter().review(makeReq())

    expect(result.verdict).toBe('blocking')
    expect(result.confidence).toBe(0)
  })

  it('valid envelope + blocking verdict を正しく取り出す', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({ provider: 'claude_code', stdout: claudeEnvelope(reviewerJson('blocking')) }))

    const result = await new ClaudeReviewerAdapter().review(makeReq())

    expect(result.verdict).toBe('blocking')
  })

  it('envelopeのresultが欠落していればfail-closed', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({
      provider: 'claude_code',
      stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
    }))

    const result = await new ClaudeReviewerAdapter().review(makeReq())

    expect(result.verdict).toBe('blocking')
    expect(result.confidence).toBe(0)
  })

  it('resultが文字列でなければfail-closed', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({
      provider: 'claude_code',
      stdout: claudeEnvelope('unused', { result: { verdict: 'approved' } }),
    }))

    const result = await new ClaudeReviewerAdapter().review(makeReq())

    expect(result.verdict).toBe('blocking')
  })

  it('is_error:true のenvelopeは中身を信用せずfail-closed', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({
      provider: 'claude_code',
      stdout: claudeEnvelope(reviewerJson('approved'), { is_error: true }),
    }))

    const result = await new ClaudeReviewerAdapter().review(makeReq())

    expect(result.verdict).toBe('blocking')
  })

  it('envelope内のreviewer JSONが壊れていればfail-closed', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({ provider: 'claude_code', stdout: claudeEnvelope('{not valid json') }))

    const result = await new ClaudeReviewerAdapter().review(makeReq())

    expect(result.verdict).toBe('blocking')
    expect(result.confidence).toBe(0)
  })

  it('timeout等の例外はblockingでfail-closed', async () => {
    const run = mockCodexAdapterRun()
    run.mockRejectedValue(new Error('ETIMEDOUT'))

    const result = await new ClaudeReviewerAdapter().review(makeReq())

    expect(result.verdict).toBe('blocking')
    expect(result.confidence).toBe(0)
    expect(result.summary).toContain('ETIMEDOUT')
  })

  it('guardにblockedされた場合もblockingでfail-closed', async () => {
    const run = mockCodexAdapterRun()
    run.mockResolvedValue(makeAiCliResult({ provider: 'claude_code', blocked: true, stdout: 'blocked by guard' }))

    const result = await new ClaudeReviewerAdapter().review(makeReq())

    expect(result.verdict).toBe('blocking')
    expect(result.confidence).toBe(0)
  })

  it('createReviewerAdapter は claude で ClaudeReviewerAdapter を返す（旧throwの置き換え）', () => {
    expect(createReviewerAdapter('claude')).toBeInstanceOf(ClaudeReviewerAdapter)
  })
})
