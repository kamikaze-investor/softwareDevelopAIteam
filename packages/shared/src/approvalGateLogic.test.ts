import { describe, it, expect } from 'vitest'
import {
  GATE_CHANGE_EXACT_FILES,
  runRiskReview,
  SAFE_WORK_COMMAND_KINDS,
  isSafeWorkCommandKind,
} from './approvalGateLogic'

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

/**
 * 2026-10-17 監査（RC6 / DA trigger 2）: authority・admission・recovery の定義ファイル。
 * ここが LOW だと、これらを編集してよい Task が CEO 依頼なしに Safety Evidence で auto-commit できる。
 */
describe('RISK_RULES — alignment / gate change（2026-10-17 authority / admission / recovery 定義）', () => {
  const authorityFiles = [
    'apps/api/src/designReview/resumeActor.ts',
    'apps/api/src/designReview/repairRecoveryEpoch.ts',
    'apps/api/src/designReview/repairFromStoredReview.ts',
    'apps/api/src/designReview/resumeBlockedTask.ts',
    'apps/api/src/designReview/terminalRepairSuccessorRecovery.ts',
    'apps/api/src/designReview/terminalRepairEscalationRecovery.ts',
    'apps/api/src/designReview/designReviewCoordinator.ts',
    'apps/api/src/designReview/resultingCommitBinding.ts',
    'apps/api/src/humanRecovery/recoverBlockedTask.ts',
    'apps/api/src/humanRecovery/recoveryAudit.ts',
    'apps/api/src/storage/interface.ts',
    'packages/shared/src/resumeAdmission.ts',
    'packages/shared/src/recoverAdmission.ts',
    'packages/shared/src/taskOccupancy.ts',
    'packages/shared/src/reviewSeparation.ts',
    'apps/api/src/approvedRunBlock.ts',
    'apps/api/src/state/blockedRowOwnership.ts',
    'apps/api/src/reconcile/externalCompletion.ts',
    'apps/api/src/pl/technicalResumePolicy.ts',
    'apps/api/src/pl/technicalAbortEvidence.ts',
    'apps/api/src/ctoAi/roadmapAdoption.ts',
  ]

  it.each(authorityFiles)('%s → HIGH / alignment / gate change', (file) => {
    const result = runRiskReview([file])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain(GATE)
  })

  it('一覧は GATE_CHANGE_EXACT_FILES の正本と一致する（追加漏れ・テスト漏れを相互に検出する）', () => {
    const expected = authorityFiles.map((file) => file.replace(/\.ts$/, ''))
    for (const file of expected) {
      expect(GATE_CHANGE_EXACT_FILES).toContain(file)
    }
  })

  it.each(authorityFiles.map((file) => file.replace(/\.ts$/, '.test.ts')))(
    '%s（隣のテスト）は alignment / gate change に一致しない',
    (file) => {
      expect(runRiskReview([file]).triggeredRules).not.toContain(GATE)
    },
  )

  it.each([
    // 似た名前の別ファイル・別ディレクトリ・前方一致は対象外
    'apps/api/src/designReview/resumeActorView.ts',
    'apps/web/src/designReview/resumeActor.ts',
    'apps/api/src/storage/interfaceHelpers.ts',
    'apps/api/src/storage/interface.tsx',
    'packages/shared/src/taskOccupancyView.ts',
    'packages/shared/src/resumeAdmission.md',
    'apps/api/src/reconcile/externalCompletionReport.ts',
    'apps/api/src/ctoAi/roadmapAdoptionPrompt.ts',
    'xapps/api/src/approvedRunBlock.ts',
  ])('%s does not match alignment / gate change', (file) => {
    expect(runRiskReview([file]).triggeredRules).not.toContain(GATE)
  })

  it('humanOnlyRoutes.ts は auth rule で既に HIGH（重複して足さない）', () => {
    const result = runRiskReview(['apps/api/src/auth/humanOnlyRoutes.ts'])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain('auth / permission guard')
  })

  it('一覧の各 path は英数字と / だけ（RegExp へ埋め込んでも意味が変わらない）', () => {
    for (const file of GATE_CHANGE_EXACT_FILES) {
      expect(file).toMatch(/^[A-Za-z0-9/]+$/)
    }
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
