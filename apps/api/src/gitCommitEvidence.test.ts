import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRiskReview, type Job, type Task } from '@ai-team/shared'
import { createSQLiteStorage } from './storage/sqlite'
import type { IStorage } from './storage/interface'
import { readCurrentWorktreeDiff } from './approvalExplain/diffReader'
import { buildWorktreeChangeManifest } from './approvalExplain/changeManifestReader'
import { computeDesignTextHash } from './designReviewEvidencePolicy'
import { evaluateGitCommitEvidence, type GitCommitEvidenceInput } from './gitCommitEvidence'

/**
 * git_commit Safety Evidence（Stage 1）の不変条件。
 *
 * - 全 Evidence が成立した LOW / MEDIUM だけが通る
 * - provenance は exact（review Job 自身の gate 評価・review result・implement Job を 1 本で結ぶ）
 * - 同一 diff の REJECTED だけが止める（diff が変われば Task を永久に汚染しない）
 * - 不成立は `insufficient_safety_evidence`（Stage 1 は human_decision_authority を出さない）
 */

const PROMPT = 'implement the feature'

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' })
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'commit-evidence-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'p@example.com'])
  git(dir, ['config', 'user.name', 'p'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const a = 1\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  return dir
}

interface Chain {
  storage: IStorage
  dir: string
  task: Task
  implementJob: Job
  reviewJob: Job
  gitCommitJob: Job
  input: GitCommitEvidenceInput
}

interface ChainOptions {
  /** worktree に加える変更（path → 内容）。既定は allowedPaths 内の通常変更。 */
  changes?: Record<string, string>
  allowedPaths?: string[]
  reviewStatus?: 'approved' | 'changes_requested'
  /** false で review result を作らない。 */
  reviewResult?: boolean
  reviewFindingSeverity?: 'low' | 'high' | 'critical'
  implementExitCode?: number
  designReview?: 'aligned' | 'none' | 'conflict'
  /** review Job の gate 評価を、commit 対象と別の diff hash で記録する。 */
  reviewEvidenceDiffHash?: string
}

function seedChain(options: ChainOptions = {}): Chain {
  const dir = initRepo()
  for (const [path, content] of Object.entries(options.changes ?? { 'src/feature.ts': 'export const a = 2\n' })) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const current = readCurrentWorktreeDiff(dir)
  const manifest = buildWorktreeChangeManifest(dir)

  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'in_progress',
    assignee: 'developer_ai', dependencies: [],
    allowedPaths: options.allowedPaths ?? ['src/'],
  } as Parameters<IStorage['tasks']['create']>[0])

  const implementCreated = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'queued',
    safeCommand: { kind: 'test' }, aiCliMode: 'implement', aiCliProvider: 'claude_code',
    aiCliPrompt: PROMPT, workflowStepKey: `task:${task.id}:initial-implement`,
  } as never)
  const implementExitCode = options.implementExitCode ?? 0
  const implementJob = storage.jobs.update(implementCreated.id, {
    status: implementExitCode === 0 ? 'success' : 'failed', exitCode: implementExitCode,
  } as never)!

  const reviewCreated = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'qa_ai', status: 'queued',
    safeCommand: { kind: 'git_status' }, aiCliMode: 'review', aiCliProvider: 'claude_code',
    workflowStepKey: `implement:${implementJob.id}:review`,
  } as never)
  const reviewJob = storage.jobs.update(reviewCreated.id, { status: 'success', exitCode: 0 } as never)!

  storage.gateEvaluations.create({
    taskId: task.id, jobId: reviewJob.id, targetBranch: 'main',
    targetCommit: current.headCommit,
    targetDiffHash: options.reviewEvidenceDiffHash ?? current.diffHash,
    decision: 'ALLOW', riskLevel: 'LOW', triggeredRules: [], policyVersion: 'gate-policy-v2',
    bindingVerification: 'authoritative',
  })
  if (options.reviewResult !== false) {
    storage.reviewResults.create({
      taskId: task.id, jobId: reviewJob.id, reviewer: 'qa_ai',
      status: options.reviewStatus ?? 'approved', summary: 'ok',
      findings: options.reviewFindingSeverity
        ? [{ severity: options.reviewFindingSeverity, message: 'finding' }]
        : [],
    })
  }

  const designReview = options.designReview ?? 'aligned'
  if (designReview !== 'none') {
    storage.designReviewEvidence.create({
      taskId: task.id,
      designTextHash: computeDesignTextHash(PROMPT),
      reviewLoad: 'low',
      decision: designReview === 'aligned' ? 'ALIGNED' : 'CONFLICT',
      independentReviewRequired: false,
    } as Parameters<IStorage['designReviewEvidence']['create']>[0])
  }

  const gitCommitJob = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'running',
    safeCommand: { kind: 'git_commit', workingDir: dir },
    workflowStepKey: `review:${reviewJob.id}:git-commit`,
  } as never)

  const changedFiles = manifest.map((entry) => entry.path)
  return {
    storage, dir, task, implementJob, reviewJob, gitCommitJob,
    input: {
      gitCommitJob,
      task,
      targetCommit: current.headCommit,
      targetDiffHash: current.diffHash,
      declaredChangedFiles: changedFiles,
      riskReview: runRiskReview(changedFiles),
      authoritativeDiffText: current.diffText,
      manifest,
      secretScanHitCount: 0,
      workingDir: dir,
      taskApprovalRequests: [],
    },
  }
}

function failuresOf(chain: Chain, override: Partial<GitCommitEvidenceInput> = {}): string[] {
  const result = evaluateGitCommitEvidence(chain.storage, { ...chain.input, ...override })
  if (result.passed) return []
  expect(result.reason).toBe('insufficient_safety_evidence')
  return result.failures
}

describe('evaluateGitCommitEvidence — 全 Evidence 成立', () => {
  it('exact provenance が揃った LOW の git_commit は通る', () => {
    const chain = seedChain()
    expect(evaluateGitCommitEvidence(chain.storage, chain.input)).toEqual({ passed: true })
  })
})

describe('evaluateGitCommitEvidence — commit 対象の diff', () => {
  it('binding が authoritative でなければ通さない', () => {
    expect(failuresOf(seedChain(), { authoritativeDiffText: undefined })).toContain('binding_not_authoritative')
  })

  it('manifest が作れなければ通さない', () => {
    expect(failuresOf(seedChain(), { manifest: undefined })).toContain('manifest_unavailable')
  })

  it('Worker 申告の changedFiles が API の manifest と違えば通さない', () => {
    expect(failuresOf(seedChain(), { declaredChangedFiles: ['src/other.ts'] })).toContain('declared_files_mismatch')
  })

  it('allowedPaths が未設定の Task は通さない', () => {
    const chain = seedChain({ allowedPaths: [] })
    expect(failuresOf(chain)).toContain('no_allowed_paths')
  })

  it('allowedPaths の外の変更は通さない（File Change Guard を正本として使う）', () => {
    const chain = seedChain({ changes: { 'lib/outside.ts': 'x\n' } })
    expect(failuresOf(chain)).toContain('file_policy_violation')
  })

  it('常時禁止パターン（.env）は allowedPaths 内でも通さない', () => {
    const chain = seedChain({ changes: { 'src/.env': 'A=1\n' } })
    expect(failuresOf(chain)).toContain('file_policy_violation')
  })

  it('HIGH の変更は、Safety 方向を判定する Evidence が無いので通さない（HIGH だから人間判断、ではない）', () => {
    const chain = seedChain({ changes: { 'src/auth.ts': 'export const hardened = true\n' } })
    const result = evaluateGitCommitEvidence(chain.storage, chain.input)
    expect(result).toEqual({
      passed: false,
      reason: 'insufficient_safety_evidence',
      failures: ['risk_level_not_low_or_medium'],
    })
  })

  it('Mechanical Gate の diff パターンに該当すれば通さない', () => {
    const chain = seedChain({ changes: { 'src/feature.ts': 'run("git commit --no-verify")\n' } })
    expect(failuresOf(chain)).toContain('mechanical_gate_hit')
  })

  it('API が読んだ diff に secret 疑いがあれば通さない', () => {
    expect(failuresOf(seedChain(), { secretScanHitCount: 1 })).toContain('secret_scan_hit')
    expect(failuresOf(seedChain(), { secretScanHitCount: undefined })).toContain('secret_scan_hit')
  })
})

describe('evaluateGitCommitEvidence — exact provenance', () => {
  it('review 開始時の diff と commit 対象の diff が違えば通さない', () => {
    const chain = seedChain({ reviewEvidenceDiffHash: 'a-different-diff' })
    expect(failuresOf(chain)).toContain('review_gate_evidence_mismatch')
  })

  it('review Job の gate 評価が 1 件に定まらなければ通さない（最新を選ばない）', () => {
    const chain = seedChain()
    chain.storage.gateEvaluations.create({
      taskId: chain.task.id, jobId: chain.reviewJob.id, targetBranch: 'main',
      targetCommit: chain.input.targetCommit, targetDiffHash: chain.input.targetDiffHash,
      decision: 'ALLOW', riskLevel: 'LOW', triggeredRules: [], policyVersion: 'gate-policy-v2',
      bindingVerification: 'authoritative',
    })
    expect(failuresOf(chain)).toContain('review_gate_evidence_not_unique')
  })

  it('review が approved でなければ通さない', () => {
    expect(failuresOf(seedChain({ reviewStatus: 'changes_requested' }))).toContain('review_not_approved')
  })

  it('high / critical の finding が残る review は通さない', () => {
    expect(failuresOf(seedChain({ reviewFindingSeverity: 'high' }))).toContain('review_has_high_or_critical_finding')
    expect(failuresOf(seedChain({ reviewFindingSeverity: 'critical' }))).toContain('review_has_high_or_critical_finding')
    expect(failuresOf(seedChain({ reviewFindingSeverity: 'low' }))).toEqual([])
  })

  it('その review Job 自身の review result が無ければ通さない（job_id は DB 上 unique）', () => {
    expect(failuresOf(seedChain({ reviewResult: false }))).toContain('review_result_not_unique')
  })

  it('別 Job の review result は数えない', () => {
    const chain = seedChain()
    chain.storage.reviewResults.create({
      taskId: chain.task.id, jobId: chain.implementJob.id, reviewer: 'qa_ai',
      status: 'changes_requested', summary: 'other job', findings: [],
    })
    expect(evaluateGitCommitEvidence(chain.storage, chain.input)).toEqual({ passed: true })
  })

  it('git_commit Job の workflowStepKey から review Job を辿れなければ通さない', () => {
    const chain = seedChain()
    const orphan = { ...chain.gitCommitJob, workflowStepKey: undefined }
    expect(failuresOf(chain, { gitCommitJob: orphan })).toEqual(['review_lineage_unresolved'])
  })

  it('implement Job が成功していなければ通さない', () => {
    expect(failuresOf(seedChain({ implementExitCode: 1 }))).toContain('implementation_not_successful')
  })

  it('Design Review evidence が無い / ALIGNED でなければ通さない', () => {
    expect(failuresOf(seedChain({ designReview: 'none' }))).toContain('design_review_not_aligned')
    expect(failuresOf(seedChain({ designReview: 'conflict' }))).toContain('design_review_not_aligned')
  })
})

describe('evaluateGitCommitEvidence — 既存の人間承認との関係', () => {
  function rejected(chain: Chain, diffHash: string) {
    return {
      id: 'r1', taskId: chain.task.id, targetBranch: 'main', targetCommit: chain.input.targetCommit,
      targetDiffHash: diffHash, riskLevel: 'LOW', requestedAction: 'git_commit', status: 'REJECTED',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), invalidIf: [], createdAt: new Date().toISOString(),
    } as never
  }

  it('同じ commit / diff に対する REJECTED があれば通さない', () => {
    const chain = seedChain()
    expect(failuresOf(chain, { taskApprovalRequests: [rejected(chain, chain.input.targetDiffHash)] }))
      .toContain('same_diff_rejected')
  })

  it('別 diff に対する過去の REJECTED は Task を汚染しない', () => {
    const chain = seedChain()
    const result = evaluateGitCommitEvidence(chain.storage, {
      ...chain.input, taskApprovalRequests: [rejected(chain, 'an-earlier-diff')],
    })
    expect(result).toEqual({ passed: true })
  })

  it('既に人間承認の流れに入っている Job は Evidence で横から通さない', () => {
    const chain = seedChain()
    const linked = { ...chain.gitCommitJob, approvalId: 'approval-1' }
    expect(failuresOf(chain, { gitCommitJob: linked })).toContain('human_approval_already_requested')
  })
})

describe('runRiskReview — Safety policy の正本 docs と Gate 実装（既存分類の補強）', () => {
  it.each([
    'docs/project_memory/rules/approval_rules.md',
    'docs/project_memory/design_philosophy.md',
    'docs/project_memory/goal.md',
    'docs/multi_ai_step_review_flow.md',
    'specs/00_constitution.md',
    'specs/22_safety_approval_design_principle.md',
    'specs/08_permissions.md',
  ])('%s は safe-only で LOW に落ちず HIGH になる', (path) => {
    expect(runRiskReview([path]).riskLevel).toBe('HIGH')
  })

  it.each([
    'apps/api/src/gitCommitEvidence.ts',
    'apps/api/src/pl/actionGate.ts',
    'packages/shared/src/plActionPolicy.ts',
    'packages/shared/src/approvalLevelClassifier.ts',
    'apps/api/src/approvalExplain/diffReader.ts',
    'apps/api/src/approvalExplain/changeManifestReader.ts',
  ])('%s は HIGH になる', (path) => {
    expect(runRiskReview([path]).riskLevel).toBe('HIGH')
  })

  it('通常の docs は従来どおり LOW のまま', () => {
    expect(runRiskReview(['docs/project_memory/decisions/some_note.md']).riskLevel).toBe('LOW')
    expect(runRiskReview(['docs/guide.md']).riskLevel).toBe('LOW')
  })
})
