import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  GATE_TECHNICAL_STOP_CODES,
  findGateTechnicalStopCode,
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
/**
 * GATE_CHANGE_EXACT_FILES（production の正本）の全 path。テスト側に allowlist を複製しない。
 * ここが LOW だと、これらを編集してよい Task が CEO 依頼なしに Safety Evidence で auto-commit できる。
 */
describe('RISK_RULES — alignment / gate change（GATE_CHANGE_EXACT_FILES の全 path）', () => {
  const productionFiles = GATE_CHANGE_EXACT_FILES.map((file) => `${file}.ts`)
  const repoRoot = path.resolve(__dirname, '../../..')

  it.each(productionFiles)('%s → HIGH / alignment / gate change', (file) => {
    const result = runRiskReview([file])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain(GATE)
  })

  it.each(productionFiles)('%s は実在する production file（綴り違いで素通りしない）', (file) => {
    expect(existsSync(path.join(repoRoot, file))).toBe(true)
  })

  it.each(productionFiles.map((file) => file.replace(/.ts$/, '.test.ts')))(
    '%s（隣のテスト）は alignment / gate change に一致しない',
    (file) => {
      expect(runRiskReview([file]).triggeredRules).not.toContain(GATE)
    },
  )

  it('一覧に重複が無い', () => {
    expect(new Set(GATE_CHANGE_EXACT_FILES).size).toBe(GATE_CHANGE_EXACT_FILES.length)
  })

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
    'apps/worker/src/guards/index.ts',
    'apps/worker/src/indexHelpers.ts',
    'apps/api/src/pl/blockedTriageSummary.ts',
    'apps/worker/src/jobStateManager.js',
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

/**
 * 2026-10-17 最終監査: 一覧から導出したテストとは独立に、明示 path で固定する
 * （一覧から行が消えると導出テストも一緒に消え、退行に気付けないため）。
 */
describe('RISK_RULES — alignment / gate change（2026-10-17 最終監査の明示固定）', () => {
  it.each([
    'apps/api/src/state/strandedTask.ts',
    'apps/api/src/ctoAi/taskContinuation.ts',
    'apps/api/src/designReview/retryCooldown.ts',
  ])('%s → HIGH / alignment / gate change', (file) => {
    const result = runRiskReview([file])
    expect(result.riskLevel).toBe('HIGH')
    expect(result.triggeredRules).toContain(GATE)
  })

  it.each([
    'apps/api/src/state/strandedTask.test.ts',
    'apps/api/src/ctoAi/taskContinuation.test.ts',
    'apps/api/src/designReview/retryCooldownTestClock.ts',
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

describe('findGateTechnicalStopCode (D2)', () => {
  it.each([
    ['risk_rule_skew: local CRITICAL > API HIGH (worker/api rule skew); technical Gate inconsistency, not an approval decision', 'risk_rule_skew'],
    ['approval_contract_violation: decision=BLOCKED continuationPolicy=continue nextAction=wait_for_approval', 'approval_contract_violation'],
  ])('matches a reason that starts with the code at offset 0: %s', (text, code) => {
    expect(findGateTechnicalStopCode(text)).toBe(code)
  })

  it.each([
    ['a later line', 'test output\nrisk_rule_skew: local CRITICAL > API HIGH'],
    ['leading whitespace', '  risk_rule_skew: local CRITICAL > API HIGH'],
    ['a prefix', '[gate] approval_contract_violation: x'],
    ['no space after the colon', 'risk_rule_skew:local CRITICAL'],
    ['an unknown code', 'risk_rule: x'],
    ['empty', ''],
    ['undefined', undefined],
  ])('does not match %s (command output cannot spoof a technical stop)', (_label, text) => {
    expect(findGateTechnicalStopCode(text)).toBeUndefined()
  })

  it('exposes exactly the two D2 codes', () => {
    expect([...GATE_TECHNICAL_STOP_CODES]).toEqual(['risk_rule_skew', 'approval_contract_violation'])
  })
})
