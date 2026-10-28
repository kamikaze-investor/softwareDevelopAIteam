import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApprovalLevelResult, ReviewPolicy } from '@ai-team/shared'
import {
  checkApprovalGateWeakening,
  checkMechanicalGateFiles,
  checkMetaReviewCodeUntouched,
  checkOutsideRepoFiles,
  checkPermissionGuardWeakening,
  checkPostTestHookUntouched,
  checkPurposeDiffAlignment,
  checkSecretScanWeakening,
  checkUnexpectedFiles,
  runSafetyVerification,
} from './safetyVerifier.js'
import type {
  SafetyCheckId,
  SafetyVerificationInput,
} from './safetyVerifier.js'

const REPO_ROOT = path.resolve('repo-root')

function makeApprovalLevelResult(
  mechanicalGateTriggered = false,
  reviewPolicy: ReviewPolicy = 'full_pre_post_review',
): ApprovalLevelResult {
  const level = mechanicalGateTriggered ? 3 : 2

  return {
    jobId: 'job-1',
    taskId: 'task-1',
    level,
    confidence: 0.9,
    mechanicalGate: {
      triggered: mechanicalGateTriggered,
      hits: mechanicalGateTriggered
        ? [{
            patternId: 'MG-F01',
            label: 'pre-implementation hit',
            reason: 'pre-implementation hit',
            matched: 'apps/worker/scripts/postTestHook.ps1',
          }]
        : [],
    },
    classifierResult: {
      level,
      confidence: 0.9,
      reasons: [],
      needsEscalation: false,
      reviewPolicy,
    },
    finalReason: 'test fixture',
    decidedAt: '2026-07-01T00:00:00.000Z',
    requiresChatGptReview: false,
    reviewPolicy,
  }
}

function expectFailure(result: { passed: boolean, blocking: boolean }): void {
  expect(result.passed).toBe(false)
  expect(result.blocking).toBe(true)
}

function makePassingVerificationInput(overrides: Partial<SafetyVerificationInput> = {}): SafetyVerificationInput {
  return {
    jobId: 'job-1',
    taskId: 'task-1',
    allowedPaths: ['apps/worker/src/approvalLevel'],
    changedFiles: ['apps/worker/src/approvalLevel/safetyVerifier.ts'],
    diffText: '+export const value = 1',
    approvalLevelResult: makeApprovalLevelResult(false),
    repoRoot: REPO_ROOT,
    postReviewAlignmentVerdict: 'aligned',
    ...overrides,
  }
}

describe('checkUnexpectedFiles', () => {
  it('allowedPaths未指定ならスキップ扱いでpassed:true', () => {
    const result = checkUnexpectedFiles(['apps/worker/src/approvalLevel/safetyVerifier.ts'])

    expect(result.passed).toBe(true)
    expect(result.blocking).toBe(true)
  })

  it('allowedPaths内のみならpassed:true', () => {
    const result = checkUnexpectedFiles(
      ['apps\\worker\\src\\approvalLevel\\safetyVerifier.ts'],
      ['apps/worker/src/approvalLevel'],
    )

    expect(result.passed).toBe(true)
  })

  it('allowedPaths外のファイルをevidenceに入れてfailedにする', () => {
    const result = checkUnexpectedFiles(
      [
        'apps/worker/src/approvalLevel/safetyVerifier.ts',
        'apps/api/src/routes/jobs.ts',
      ],
      ['apps/worker/src/approvalLevel'],
    )

    expectFailure(result)
    expect(result.evidence).toContain('apps/api/src/routes/jobs.ts')
  })
})

describe('checkMechanicalGateFiles', () => {
  it('実装前後でtriggeredがfalseのままならpassed:true', () => {
    const result = checkMechanicalGateFiles(
      makeApprovalLevelResult(false),
      ['apps/worker/src/approvalLevel/safetyVerifier.ts'],
      '+export const value = 1',
    )

    expect(result.passed).toBe(true)
  })

  it('実装後にMechanical Gateがtriggered:trueへ変化したらfailedにする', () => {
    const result = checkMechanicalGateFiles(
      makeApprovalLevelResult(false),
      ['apps/worker/scripts/postTestHook.ps1'],
      '+Write-Host ok',
    )

    expectFailure(result)
    expect(result.evidence?.length).toBeGreaterThan(0)
  })
})

describe('checkPostTestHookUntouched', () => {
  it('postTestHook.ps1を含まないならpassed:true', () => {
    const result = checkPostTestHookUntouched(['apps/worker/src/index.ts'])

    expect(result.passed).toBe(true)
  })

  it('postTestHook.ps1を含むならfailedにする', () => {
    const result = checkPostTestHookUntouched(['apps/worker/scripts/postTestHook.ps1'])

    expectFailure(result)
    expect(result.evidence).toContain('apps/worker/scripts/postTestHook.ps1')
  })

  it('Windowsパス区切りでもpostTestHook.ps1を検出する', () => {
    const result = checkPostTestHookUntouched(['apps\\worker\\scripts\\postTestHook.ps1'])

    expectFailure(result)
    expect(result.evidence).toContain('apps/worker/scripts/postTestHook.ps1')
  })
})

describe('checkMetaReviewCodeUntouched', () => {
  it('Meta Review関連コードを含まないならpassed:true', () => {
    const result = checkMetaReviewCodeUntouched(['apps/worker/src/index.ts'])

    expect(result.passed).toBe(true)
  })

  it('metaReviewer配下を含むならfailedにする', () => {
    const result = checkMetaReviewCodeUntouched(['apps/worker/src/metaReviewer/runner.ts'])

    expectFailure(result)
    expect(result.evidence).toContain('apps/worker/src/metaReviewer/runner.ts')
  })
})

describe('checkApprovalGateWeakening', () => {
  it('対象ファイル変更なしならdiffに弱体化語があってもpassed:true', () => {
    const result = checkApprovalGateWeakening(
      ['apps/worker/src/approvalLevel/safetyVerifier.ts'],
      '+const block = allow',
    )

    expect(result.passed).toBe(true)
  })

  it('approvalGate.tsの通常変更のみならpassed:true', () => {
    const result = checkApprovalGateWeakening(
      ['apps/worker/src/guards/approvalGate.ts'],
      '+const requestId = input.taskId',
    )

    expect(result.passed).toBe(true)
  })

  it('approvalGate.tsとblock/denyからallowへの弱体化パターンならfailedにする', () => {
    const result = checkApprovalGateWeakening(
      ['apps/worker/src/guards/approvalGate.ts'],
      '+const block = allow',
    )

    expectFailure(result)
    expect(result.evidence?.length).toBeGreaterThan(0)
  })
})

describe('checkPermissionGuardWeakening', () => {
  it('対象ファイル変更なしならbypassパターンがあってもpassed:true', () => {
    const result = checkPermissionGuardWeakening(
      ['apps/worker/src/approvalLevel/safetyVerifier.ts'],
      '+const bypass = true',
    )

    expect(result.passed).toBe(true)
  })

  it('permissionGuard.tsでbypassパターンを検出したらfailedにする', () => {
    const result = checkPermissionGuardWeakening(
      ['apps/worker/src/guards/permissionGuard.ts'],
      '+const bypass = true',
    )

    expectFailure(result)
    expect(result.evidence?.length).toBeGreaterThan(0)
  })
})

describe('checkSecretScanWeakening', () => {
  it('対象ファイル変更なしでAPIキーハードコードもなければpassed:true', () => {
    const result = checkSecretScanWeakening(
      ['apps/worker/src/approvalLevel/safetyVerifier.ts'],
      '+const value = "safe"',
    )

    expect(result.passed).toBe(true)
  })

  it('ANTHROPIC_API_KEYのハードコードを検出したらfailedにする', () => {
    const result = checkSecretScanWeakening(
      ['apps/worker/src/approvalLevel/safetyVerifier.ts'],
      "+ANTHROPIC_API_KEY='xxx'",
    )

    expectFailure(result)
    expect(result.evidence?.length).toBeGreaterThan(0)
  })

  it('pathUtils.tsでisPromptSafe削除相当のdiffを検出したらfailedにする', () => {
    const result = checkSecretScanWeakening(
      ['packages/shared/src/utils/pathUtils.ts'],
      '-export function isPromptSafe(input: string): boolean { return true }',
    )

    expectFailure(result)
    expect(result.evidence).toContain('isPromptSafe/CONTEXT_SECRET_PATTERNS削除')
  })
})

describe('checkOutsideRepoFiles', () => {
  it('repoRoot配下のみならpassed:true', () => {
    const result = checkOutsideRepoFiles(['apps/worker/src/index.ts'], REPO_ROOT)

    expect(result.passed).toBe(true)
  })

  it('repoRoot外のパスを検出したらfailedにする', () => {
    const result = checkOutsideRepoFiles(['../outside-repo/file.ts'], REPO_ROOT)

    expectFailure(result)
    expect(result.evidence).toContain('../outside-repo/file.ts')
  })
})

describe('checkPurposeDiffAlignment', () => {
  it('alignedならpassed:trueかつblocking:true', () => {
    const result = checkPurposeDiffAlignment('aligned')

    expect(result.passed).toBe(true)
    expect(result.blocking).toBe(true)
  })

  it('misalignedならfailedかつblocking:true', () => {
    const result = checkPurposeDiffAlignment('misaligned')

    expectFailure(result)
  })

  it('unknownならfailedかつblocking:true', () => {
    const result = checkPurposeDiffAlignment('unknown')

    expectFailure(result)
  })

  it('undefinedならfailedかつblocking:true', () => {
    const result = checkPurposeDiffAlignment()

    expectFailure(result)
  })
})

describe('runSafetyVerification', () => {
  it('全項目passedならoverallPassed:trueにする', () => {
    const result = runSafetyVerification(makePassingVerificationInput())
    const expectedOrder: SafetyCheckId[] = [
      'UNEXPECTED_FILES',
      'MECHANICAL_GATE_FILES',
      'POST_TEST_HOOK',
      'META_REVIEW_CODE',
      'APPROVAL_GATE_WEAKENING',
      'PERMISSION_GUARD_WEAKENING',
      'SECRET_SCAN_WEAKENING',
      'OUTSIDE_REPO_FILES',
      'PURPOSE_DIFF_ALIGNMENT',
    ]

    expect(result.overallPassed).toBe(true)
    expect(result.blockingFailures).toEqual([])
    expect(result.checks.map(check => check.id)).toEqual(expectedOrder)
    expect(result.checks).toHaveLength(9)
  })

  it('Post-Review未実装の標準ケースではfail closedでPURPOSE_DIFF_ALIGNMENTを失敗にする', () => {
    const result = runSafetyVerification(makePassingVerificationInput({
      postReviewAlignmentVerdict: undefined,
    }))

    expect(result.overallPassed).toBe(false)
    expect(result.blockingFailures).toContain('PURPOSE_DIFF_ALIGNMENT')
  })

  it('typecheck / test の結果を渡さない通常の呼び出し（jobRunner と同じ形）でも、それを理由に失敗しない', () => {
    // jobRunner は SafeCommand より前に呼ぶため typecheck / test の結果を持たない。
    // 以前はそれだけで TYPECHECK / RELATED_TESTS / FULL_TESTS が失敗になり overallPassed が常に false だった。
    const result = runSafetyVerification(makePassingVerificationInput())

    expect(result.overallPassed).toBe(true)
    expect(result.blockingFailures).toEqual([])
    const ids: string[] = result.checks.map(check => check.id)
    expect(ids).not.toContain('TYPECHECK')
    expect(ids).not.toContain('RELATED_TESTS')
    expect(ids).not.toContain('FULL_TESTS')
  })

  it('残りの項目は従来どおり失敗を検出する（項目を外しても他の検出は弱まらない）', () => {
    const result = runSafetyVerification(makePassingVerificationInput({
      allowedPaths: ['apps/worker/src/approvalLevel'],
      changedFiles: ['apps/worker/src/approvalLevel/safetyVerifier.ts', 'apps/worker/scripts/postTestHook.ps1', '../outside-repo/file.ts'],
      approvalLevelResult: makeApprovalLevelResult(false),
      postReviewAlignmentVerdict: 'misaligned',
    }))

    expect(result.overallPassed).toBe(false)
    expect(result.blockingFailures).toEqual(expect.arrayContaining([
      'UNEXPECTED_FILES', 'MECHANICAL_GATE_FILES', 'POST_TEST_HOOK', 'OUTSIDE_REPO_FILES', 'PURPOSE_DIFF_ALIGNMENT',
    ]))
  })

  it('postTestHook.ps1を含む場合はPOST_TEST_HOOKを失敗にする', () => {
    const result = runSafetyVerification(makePassingVerificationInput({
      allowedPaths: ['apps/worker/scripts'],
      changedFiles: ['apps/worker/scripts/postTestHook.ps1'],
      approvalLevelResult: makeApprovalLevelResult(true),
    }))

    expect(result.overallPassed).toBe(false)
    expect(result.blockingFailures).toContain('POST_TEST_HOOK')
    expect(result.blockingFailures).not.toContain('MECHANICAL_GATE_FILES')
  })

  it('task-023相当の入力ならoverallPassed:trueにする', () => {
    const result = runSafetyVerification(makePassingVerificationInput({
      allowedPaths: undefined,
      changedFiles: [
        'packages/shared/src/types/job.ts',
        'apps/api/src/routes/jobs.ts',
        'apps/worker/src/jobRunner.ts',
      ],
      diffText: '+const approvalLevel = 2',
      approvalLevelResult: makeApprovalLevelResult(false),
    }))

    expect(result.overallPassed).toBe(true)
    expect(result.blockingFailures).toEqual([])
  })
})

describe('reviewPolicy による PURPOSE_DIFF_ALIGNMENT の分岐', () => {
  it('reviewPolicy: mechanical_only + postReviewAlignmentVerdict未指定 → PURPOSE_DIFF_ALIGNMENT passed:true', () => {
    const result = runSafetyVerification(makePassingVerificationInput({
      approvalLevelResult: makeApprovalLevelResult(false, 'mechanical_only'),
      postReviewAlignmentVerdict: undefined,
    }))
    const purposeCheck = result.checks.find(check => check.id === 'PURPOSE_DIFF_ALIGNMENT')

    expect(result.overallPassed).toBe(true)
    expect(purposeCheck).toMatchObject({
      passed: true,
      blocking: true,
    })
    expect(result.blockingFailures).not.toContain('PURPOSE_DIFF_ALIGNMENT')
  })

  it('reviewPolicy: light_ai_post_review + postReviewAlignmentVerdict未指定 → PURPOSE_DIFF_ALIGNMENT passed:false', () => {
    const result = runSafetyVerification(makePassingVerificationInput({
      approvalLevelResult: makeApprovalLevelResult(false, 'light_ai_post_review'),
      postReviewAlignmentVerdict: undefined,
    }))
    const purposeCheck = result.checks.find(check => check.id === 'PURPOSE_DIFF_ALIGNMENT')

    expect(result.overallPassed).toBe(false)
    expect(purposeCheck).toMatchObject({
      passed: false,
      blocking: true,
    })
    expect(result.blockingFailures).toContain('PURPOSE_DIFF_ALIGNMENT')
  })

  it('reviewPolicy: full_pre_post_review + postReviewAlignmentVerdict:aligned → PURPOSE_DIFF_ALIGNMENT passed:true', () => {
    const result = runSafetyVerification(makePassingVerificationInput({
      approvalLevelResult: makeApprovalLevelResult(false, 'full_pre_post_review'),
      postReviewAlignmentVerdict: 'aligned',
    }))
    const purposeCheck = result.checks.find(check => check.id === 'PURPOSE_DIFF_ALIGNMENT')

    expect(result.overallPassed).toBe(true)
    expect(purposeCheck).toMatchObject({
      passed: true,
      blocking: true,
    })
    expect(result.blockingFailures).not.toContain('PURPOSE_DIFF_ALIGNMENT')
  })

  it('reviewPolicy: mechanical_only でも他の11項目は通常通り評価される', () => {
    const result = runSafetyVerification(makePassingVerificationInput({
      allowedPaths: ['apps/worker/scripts'],
      changedFiles: ['apps/worker/scripts/postTestHook.ps1'],
      approvalLevelResult: makeApprovalLevelResult(true, 'mechanical_only'),
      postReviewAlignmentVerdict: undefined,
    }))

    expect(result.overallPassed).toBe(false)
    expect(result.blockingFailures).toContain('POST_TEST_HOOK')
    expect(result.blockingFailures).not.toContain('PURPOSE_DIFF_ALIGNMENT')
    expect(result.blockingFailures).not.toContain('MECHANICAL_GATE_FILES')
  })
})
