import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalRequest, Job } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'
import { readCurrentWorktreeDiff } from '../approvalExplain/diffReader'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'

/**
 * `/gate/check` の git_commit が Safety Evidence（Stage 1）で人間承認を外す経路の結合テスト。
 *
 * - 全 Evidence 成立 → ALLOW / proceed / ApprovalRequest を作らない / policy v2 + 理由ラベル / audit
 * - 1 つでも欠ける → 従来どおり Job に結び付いた ApprovalRequest（人間承認）+ 理由ラベル / audit
 */

const PROMPT = 'implement the feature'

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' })
}

function initRepoWithChange(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-evidence-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'p@example.com'])
  git(dir, ['config', 'user.name', 'p'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const a = 1\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const a = 2\n')
  return dir
}

async function buildApp(dir: string): Promise<{ app: FastifyInstance; storage: IStorage }> {
  process.env.DB_PATH = ':memory:'
  const [{ approvalGateRoutes }, { resetStorage, getStorage }] = await Promise.all([
    import('./approvalGate.js'),
    import('../storage/index.js'),
  ])
  resetStorage()
  const app = Fastify()
  app.register(approvalGateRoutes, { prefix: '/api', targetWorkingDir: dir })
  await app.ready()
  return { app, storage: getStorage() }
}

function seedChain(storage: IStorage, dir: string, options: { designReview: boolean }): {
  gitCommitJob: Job
  taskId: string
  targetCommit: string
  targetDiffHash: string
} {
  const current = readCurrentWorktreeDiff(dir)
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'in_progress',
    assignee: 'developer_ai', dependencies: [], allowedPaths: ['src/'],
  } as Parameters<IStorage['tasks']['create']>[0])
  const implement = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'queued',
    safeCommand: { kind: 'test' }, aiCliMode: 'implement', aiCliProvider: 'claude_code', aiCliPrompt: PROMPT,
  } as never)
  storage.jobs.update(implement.id, { status: 'success', exitCode: 0 } as never)
  const review = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'qa_ai', status: 'queued',
    safeCommand: { kind: 'git_status' }, aiCliMode: 'review', aiCliProvider: 'claude_code',
    workflowStepKey: `implement:${implement.id}:review`,
  } as never)
  storage.gateEvaluations.create({
    taskId: task.id, jobId: review.id, targetBranch: 'main',
    targetCommit: current.headCommit, targetDiffHash: current.diffHash,
    decision: 'ALLOW', riskLevel: 'LOW', triggeredRules: [], policyVersion: 'gate-policy-v2',
    bindingVerification: 'authoritative',
  })
  storage.reviewResults.create({
    taskId: task.id, jobId: review.id, reviewer: 'qa_ai', status: 'approved', summary: 'ok', findings: [],
  })
  if (options.designReview) {
    storage.designReviewEvidence.create({
      taskId: task.id, designTextHash: computeDesignTextHash(PROMPT), reviewLoad: 'low',
      decision: 'ALIGNED', independentReviewRequired: false,
    } as Parameters<IStorage['designReviewEvidence']['create']>[0])
  }
  const gitCommitJob = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'running',
    safeCommand: { kind: 'git_commit', workingDir: dir }, workflowStepKey: `review:${review.id}:git-commit`,
  } as never)
  return { gitCommitJob, taskId: task.id, targetCommit: current.headCommit, targetDiffHash: current.diffHash }
}

async function gateCheck(app: FastifyInstance, chain: ReturnType<typeof seedChain>) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/gate/check',
    payload: {
      jobId: chain.gitCommitJob.id,
      taskId: chain.taskId,
      requestedAction: 'git_commit',
      targetBranch: 'main',
      targetCommit: chain.targetCommit,
      targetDiffHash: chain.targetDiffHash,
      changedFiles: ['src/feature.ts'],
    },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body) as {
    outcome: { decision: string }
    continuationPolicy: string
    nextAction: { action: string }
    approvalRequest?: ApprovalRequest
  }
}

describe('POST /api/gate/check — git_commit Safety Evidence（Stage 1）', () => {
  it('全 Evidence が成立した LOW の git_commit は人間承認なしで ALLOW になり、根拠が残る', async () => {
    const dir = initRepoWithChange()
    const { app, storage } = await buildApp(dir)
    try {
      const chain = seedChain(storage, dir, { designReview: true })
      const body = await gateCheck(app, chain)

      expect(body.outcome.decision).toBe('ALLOW')
      expect(body.continuationPolicy).toBe('continue')
      expect(body.nextAction.action).toBe('proceed')
      expect(body.approvalRequest).toBeUndefined()
      expect(storage.approvalRequests.findByTaskId(chain.taskId)).toHaveLength(0)
      expect(storage.jobs.findById(chain.gitCommitJob.id)?.approvalId).toBeUndefined()

      const [evaluation] = storage.gateEvaluations.findByJobId(chain.gitCommitJob.id)
      expect(evaluation?.policyVersion).toBe('gate-policy-v2')
      expect(evaluation?.bindingVerification).toBe('authoritative')
      expect(evaluation?.approvedContentHash).toBeDefined()
      expect(evaluation?.triggeredRules).toContain('git_commit: safety evidence verified')

      const audit = storage.auditLog.findByEntity('job', chain.gitCommitJob.id)
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ operation: 'git_commit_safety_evidence', result: 'verified' })
    } finally {
      await app.close()
    }
  })

  it('別 diff に対する過去の REJECTED は Evidence 成立を妨げず、応答にも載らない', async () => {
    const dir = initRepoWithChange()
    const { app, storage } = await buildApp(dir)
    try {
      const chain = seedChain(storage, dir, { designReview: true })
      const earlier = storage.approvalRequests.create({
        taskId: chain.taskId, targetBranch: 'main', targetCommit: chain.targetCommit,
        targetDiffHash: 'an-earlier-diff', riskLevel: 'LOW', requestedAction: 'git_commit', status: 'WAITING_FOR_USER',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), invalidIf: [],
      } as Parameters<IStorage['approvalRequests']['create']>[0])
      storage.approvalRequests.recordDecision(earlier.id, 'REJECTED', 'earlier diff')

      const body = await gateCheck(app, chain)
      expect(body.outcome.decision).toBe('ALLOW')
      expect(body.nextAction.action).toBe('proceed')
      expect(body.approvalRequest).toBeUndefined()
      expect(storage.approvalRequests.findById(earlier.id)?.status).toBe('REJECTED')
    } finally {
      await app.close()
    }
  })

  it('同じ diff に対する REJECTED があれば、Evidence では通さず REJECTED のまま返す', async () => {
    const dir = initRepoWithChange()
    const { app, storage } = await buildApp(dir)
    try {
      const chain = seedChain(storage, dir, { designReview: true })
      const same = storage.approvalRequests.create({
        taskId: chain.taskId, targetBranch: 'main', targetCommit: chain.targetCommit,
        targetDiffHash: chain.targetDiffHash, riskLevel: 'LOW', requestedAction: 'git_commit', status: 'WAITING_FOR_USER',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), invalidIf: [],
      } as Parameters<IStorage['approvalRequests']['create']>[0])
      storage.approvalRequests.recordDecision(same.id, 'REJECTED', 'same diff')

      const body = await gateCheck(app, chain)
      expect(body.outcome.decision).toBe('REJECTED')
      expect(body.approvalRequest?.id).toBe(same.id)
      const audit = storage.auditLog.findByEntity('job', chain.gitCommitJob.id)
      expect(audit.find((a) => a.operation === 'git_commit_safety_evidence')?.detail).toContain('same_diff_rejected')
    } finally {
      await app.close()
    }
  })

  it('Evidence が 1 つでも欠ければ、従来どおり Job に結び付いた人間承認へ fail closed する', async () => {
    const dir = initRepoWithChange()
    const { app, storage } = await buildApp(dir)
    try {
      const chain = seedChain(storage, dir, { designReview: false })
      const body = await gateCheck(app, chain)

      expect(body.outcome.decision).toBe('BLOCKED')
      expect(body.continuationPolicy).toBe('block_until_approved')
      expect(body.approvalRequest?.status).toBe('WAITING_FOR_USER')
      expect(body.approvalRequest?.triggeredRules).toEqual(expect.arrayContaining([
        'git_commit requires CEO approval (policy)',
        'git_commit human gate: insufficient_safety_evidence',
      ]))
      expect(storage.jobs.findById(chain.gitCommitJob.id)?.approvalId).toBe(body.approvalRequest?.id)

      const [evaluation] = storage.gateEvaluations.findByJobId(chain.gitCommitJob.id)
      expect(evaluation?.decision).toBe('BLOCKED')
      expect(evaluation?.triggeredRules).toContain('git_commit human gate: insufficient_safety_evidence')

      const audit = storage.auditLog.findByEntity('job', chain.gitCommitJob.id)
      expect(audit[0]).toMatchObject({ result: 'insufficient_safety_evidence' })
      expect(audit[0]?.detail).toContain('design_review_not_aligned')
    } finally {
      await app.close()
    }
  })
})
