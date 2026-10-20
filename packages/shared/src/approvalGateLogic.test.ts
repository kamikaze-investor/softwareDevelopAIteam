import { describe, it, expect } from 'vitest'
import { runRiskReview, SAFE_WORK_COMMAND_KINDS, isSafeWorkCommandKind } from './approvalGateLogic'

const GATE = 'alignment / gate change'
const DA_DOC = 'decision authority / safety policy doc'

/**
 * 2026-10-16 監査（RC4/RC6）で RISK_RULES に足した path の固定。
 * production の実ファイルだけを HIGH にし、隣のテストファイルは対象外にする（テスト追加だけの変更まで
 * Evidence 対象外にしないため）。各 path を単独で渡し、label と level の両方を確かめる。
 */
describe('RISK_RULES — alignment / gate change（2026-10-16 追加分）', () => {
  const productionFiles = [
    'apps/api/src/storage/sqlite.ts',
    'apps/api/src/pl/abortTask.ts',
    'apps/api/src/pl/executionLoop.ts',
    'apps/api/src/state/systemState.ts',
    'apps/api/src/gitCommitResumeLineage.ts',
    'apps/api/src/linkedGitCommitRejection.ts',
    'apps/worker/src/approvalLevel/commitGate.ts',
    'packages/shared/src/approvalLiveness.ts',
  ]

  it.each(productionFiles)('%s → HIGH / alignment / gate change', (file) => {
    const result = runRiskReview([file])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain(GATE)
  })

  it.each([
    'apps/api/src/storage/sqlite.test.ts',
    'apps/api/src/pl/abortTask.test.ts',
    'apps/api/src/pl/executionLoop.test.ts',
    'apps/api/src/state/systemState.test.ts',
    'apps/api/src/gitCommitResumeLineage.test.ts',
    'apps/api/src/linkedGitCommitRejection.test.ts',
    'apps/worker/src/approvalLevel/commitGate.test.ts',
    'packages/shared/src/approvalLiveness.test.ts',
    // 似た名前の別ファイル・別ディレクトリは対象外
    'apps/api/src/storage/sqliteHelpers.ts',
    'apps/web/src/pl/executionLoop.ts',
    'apps/api/src/state/systemStateView.ts',
  ])('%s does not match alignment / gate change', (file) => {
    expect(runRiskReview([file]).triggeredRules).not.toContain(GATE)
  })
})

describe('RISK_RULES — decision authority / safety policy doc（2026-10-16 追加分）', () => {
  it.each([
    'docs/project_memory/rules/approval_rules.md',
    'docs/project_memory/rules/development_rules.md',
    'docs/project_memory/rules/nested/anything.yaml',
  ])('%s → HIGH / decision authority / safety policy doc', (file) => {
    const result = runRiskReview([file])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain(DA_DOC)
  })

  it('docs/ 配下の rules/ は SAFE_ONLY の早期リターンで LOW に落ちない（他の docs と混在しても）', () => {
    const result = runRiskReview(['docs/notes.md', 'docs/project_memory/rules/development_rules.md'])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain(DA_DOC)
  })

  it.each([
    'docs/project_memory/decisions/some_decision.md',
    'docs/project_memory/rules',
    'docs/notes/rules/x.md',
    // 依存定義は技術判断（Decision Authority）なので HIGH にしない（PL 判断 2026-10-16）
    'package.json',
    'apps/api/package.json',
    'pnpm-lock.yaml',
  ])('%s does not match decision authority / safety policy doc', (file) => {
    expect(runRiskReview([file]).triggeredRules).not.toContain(DA_DOC)
  })

  it('対象外の docs だけなら従来どおり LOW', () => {
    expect(runRiskReview(['docs/project_memory/decisions/some_decision.md']).riskLevel).toBe('LOW')
  })

  it('依存定義だけの変更は LOW のまま（Evidence 判定の対象に残る）', () => {
    const result = runRiskReview(['package.json', 'pnpm-lock.yaml', 'apps/api/package.json'])
    expect(result.riskLevel).toBe('LOW')
    expect(result.triggeredRules).toEqual([])
  })
})

describe('SAFE_WORK_COMMAND_KINDS', () => {
  it('読み取り・テスト・品質チェックだけを含む（変更・commit を含まない）', () => {
    expect([...SAFE_WORK_COMMAND_KINDS].sort()).toEqual(
      ['git_diff', 'git_log', 'git_status', 'lint', 'test', 'typecheck'],
    )
    for (const kind of ['git_commit', 'git_checkout', 'git_branch_create', 'git_revert', 'build']) {
      expect(isSafeWorkCommandKind(kind)).toBe(false)
    }
    expect(isSafeWorkCommandKind('git_status')).toBe(true)
  })
})
