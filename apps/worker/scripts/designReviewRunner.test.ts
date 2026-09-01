import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAllowlistedEnv, parseRunnerInput } from './designReviewRunner'

/**
 * review-only runner が .env から allowlist 以外のキーを process.env へ載せないことの検証。
 *
 * reviewer child は runner の env を継承するため、ここで載せないことが
 * そのまま reviewer child への非伝播になる。
 */

function writeEnvFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'drr-env-'))
  const envPath = join(dir, '.env')
  writeFileSync(envPath, contents, 'utf-8')
  return envPath
}

const FULL_ENV = [
  'PORT=3000',
  'CLAUDE_API_KEY=claude-secret',
  'GEMINI_API_KEY=gemini-secret',
  'GEMINI_MODEL=gemini-2.0',
  'OPENAI_API_KEY=openai-secret',
  'GITHUB_TOKEN=git-operation-secret',
  'COPILOT_GITHUB_TOKEN=copilot-secret',
  'API_TOKEN=api-secret',
  'OPENCODE_GO_API_KEY=opencode-secret',
  'ADMIN_TOKEN_SHA256=admin-hash',
  'WORKER_TOKEN_SHA256=worker-hash',
].join('\n')

describe('loadAllowlistedEnv', () => {
  it('allowlistのキーだけを載せる', () => {
    const target: NodeJS.ProcessEnv = {}
    loadAllowlistedEnv(writeEnvFile(FULL_ENV), target)

    expect(Object.keys(target).sort()).toEqual(['GEMINI_API_KEY', 'GEMINI_MODEL'])
    expect(target.GEMINI_API_KEY).toBe('gemini-secret')
  })

  it('evidence登録token・API_TOKEN・不要provider keyを載せない', () => {
    const target: NodeJS.ProcessEnv = {}
    loadAllowlistedEnv(writeEnvFile(FULL_ENV), target)

    for (const forbidden of [
      'API_TOKEN',
      'ADMIN_TOKEN_SHA256',
      'WORKER_TOKEN_SHA256',
      'OPENCODE_GO_API_KEY',
      'CLAUDE_API_KEY',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
      'COPILOT_GITHUB_TOKEN',
    ]) {
      expect(target).not.toHaveProperty(forbidden)
    }
    expect(Object.values(target)).not.toContain('api-secret')
    expect(Object.values(target)).not.toContain('copilot-secret')
  })

  it('COPILOT_GITHUB_TOKENはCopilot CLIがOAuth credentialで認証するため読み込まない（2026-08-28: PAT配線撤去）', () => {
    const target: NodeJS.ProcessEnv = {}
    loadAllowlistedEnv(writeEnvFile('COPILOT_GITHUB_TOKEN=copilot-test\nGITHUB_TOKEN=git-token-must-not-load\nCLAUDE_API_KEY=should-not-load'), target)

    expect(target).not.toHaveProperty('COPILOT_GITHUB_TOKEN')
    expect(target).not.toHaveProperty('GITHUB_TOKEN')
    expect(target).not.toHaveProperty('CLAUDE_API_KEY')
  })

  it('.envが存在しなくても例外にならない', () => {
    const target: NodeJS.ProcessEnv = {}
    expect(() => loadAllowlistedEnv('/nonexistent/.env', target)).not.toThrow()
    expect(Object.keys(target)).toHaveLength(0)
  })

  it('既に設定済みのキーを上書きしない', () => {
    const target: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'already-set' }
    loadAllowlistedEnv(writeEnvFile(FULL_ENV), target)
    expect(target.GEMINI_API_KEY).toBe('already-set')
  })
})

describe('parseRunnerInput', () => {
  it('必須項目が揃っていればparseできる', () => {
    const input = parseRunnerInput(
      JSON.stringify({
        subjectId: 't1', taskTitle: 'title', designText: 'text',
        changedFiles: ['a.ts'], workingDir: '/w',
      }),
    )
    expect(input.subjectId).toBe('t1')
    expect(input.changedFiles).toEqual(['a.ts'])
  })

  it('欠落があれば例外になる', () => {
    expect(() => parseRunnerInput(JSON.stringify({ subjectId: 't1' }))).toThrow('invalid runner input')
  })

  it('reviewKind roadmap を受け入れ、subjectId を保持する', () => {
    const input = parseRunnerInput(
      JSON.stringify({
        reviewKind: 'roadmap', subjectId: 'project-1', taskTitle: 'title',
        designText: 'text', changedFiles: [], workingDir: '/w',
      }),
    )
    expect(input.reviewKind).toBe('roadmap')
    expect(input.subjectId).toBe('project-1')
  })

  it('未知の reviewKind は拒否する', () => {
    expect(() => parseRunnerInput(
      JSON.stringify({
        reviewKind: 'bogus', subjectId: 'project-1', taskTitle: 'title',
        designText: 'text', changedFiles: [], workingDir: '/w',
      }),
    )).toThrow('invalid runner input')
  })
})
