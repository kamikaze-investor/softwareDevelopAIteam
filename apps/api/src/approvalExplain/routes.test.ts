import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  ApprovalExplanationResponse,
  ApprovalQuestionResponse,
  ApprovalRequest,
} from '@ai-team/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { IStorage } from '../storage/interface'
import { readCurrentWorktreeDiff } from './diffReader'

const temporaryDirectories: string[] = []

const validExplanationJson = JSON.stringify({
  whatWasDone: '承認対象の変更をコミットします。',
  whyNeeded: '変更を履歴として確定するためです。',
  scope: '表示された対象ファイルだけです。',
  notChanged: 'Approval Gateの判定は変えません。',
  productionImpact: 'この承認だけでは本番公開されません。',
  riskSummary: '高リスクとして人間の確認が必要です。',
  failureImpact: 'コミット処理が停止し、変更は本番公開されません。',
  verificationSummary: '登録済みのQA結果を確認してください。',
  reviewSummary: '登録済みのレビュー結果を確認してください。',
  nextMinimalAction: '対象ファイルと差分を確認してください。',
})

function runGit(workingDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: workingDir,
    encoding: 'utf-8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function createFixtureRepository(): string {
  const workingDir = mkdtempSync(path.join(tmpdir(), 'approval-explain-route-'))
  temporaryDirectories.push(workingDir)

  runGit(workingDir, ['init', '--object-format=sha1'])
  runGit(workingDir, ['config', 'user.email', 'approval-route@example.test'])
  runGit(workingDir, ['config', 'user.name', 'Approval Route Test'])
  runGit(workingDir, ['config', 'core.autocrlf', 'false'])
  writeFileSync(path.join(workingDir, 'tracked.txt'), 'before\n', 'utf-8')
  runGit(workingDir, ['add', 'tracked.txt'])
  runGit(workingDir, ['commit', '-m', 'fixture base'])
  writeFileSync(path.join(workingDir, 'tracked.txt'), 'after\n', 'utf-8')
  writeFileSync(path.join(workingDir, 'new.txt'), 'new\n', 'utf-8')
  return workingDir
}

async function buildApp(
  workingDir: string,
  explanationMockResponse = validExplanationJson,
): Promise<{ app: FastifyInstance; storage: IStorage }> {
  process.env.DB_PATH = ':memory:'
  const [{ approvalGateRoutes }, { getStorage, resetStorage }] = await Promise.all([
    import('../routes/approvalGate.js'),
    import('../storage/index.js'),
  ])
  resetStorage()

  const app = Fastify()
  app.register(approvalGateRoutes, {
    prefix: '/api',
    targetWorkingDir: workingDir,
    explanationAiOptions: { mockResponse: explanationMockResponse },
    questionAiOptions: { mockResponse: '承認に失敗した場合は処理が停止します。' },
  })
  await app.ready()
  return { app, storage: getStorage() }
}

function createApproval(storage: IStorage, workingDir: string): ApprovalRequest {
  const project = storage.projects.create({
    name: 'Approval Explain',
    goal: 'CEOが理解して承認する',
    designPhilosophy: [],
    status: 'draft',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'Approval説明',
    description: '承認内容を説明する',
    status: 'review',
    assignee: 'developer_ai',
    dependencies: [],
    acceptanceCriteria: ['説明が表示される'],
  })
  const current = readCurrentWorktreeDiff(workingDir)

  return storage.approvalRequests.create({
    taskId: task.id,
    targetBranch: 'ai/task-approval-explain',
    targetCommit: current.headCommit,
    targetDiffHash: current.diffHash,
    riskLevel: 'HIGH',
    requestedAction: 'merge feature branch',
    changedFiles: ['tracked.txt', 'new.txt'],
    triggeredRules: ['auth / permission guard'],
    status: 'WAITING_FOR_USER',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    invalidIf: ['commit changes', 'diff changes'],
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('Approval explanation routes', () => {
  it('returns exact diff only when current HEAD and diff hash both match', async () => {
    const workingDir = createFixtureRepository()
    const { app, storage } = await buildApp(workingDir)
    try {
      const approval = createApproval(storage, workingDir)
      const current = readCurrentWorktreeDiff(workingDir)
      const response = await app.inject({
        method: 'POST',
        url: `/api/approval-requests/${approval.id}/explanation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<ApprovalExplanationResponse>()
      expect(body.ok).toBe(true)
      expect(body.diffStatus).toBe('exact')
      if (body.ok) expect(body.exactDiff).toBe(current.diffText)
    } finally {
      await app.close()
    }
  })

  it('marks changed worktree state stale and never returns its diff', async () => {
    const workingDir = createFixtureRepository()
    const { app, storage } = await buildApp(workingDir)
    try {
      const approval = createApproval(storage, workingDir)
      writeFileSync(path.join(workingDir, 'tracked.txt'), 'changed again\n', 'utf-8')
      const response = await app.inject({
        method: 'POST',
        url: `/api/approval-requests/${approval.id}/explanation`,
      })

      const body = response.json<ApprovalExplanationResponse>()
      expect(body.ok).toBe(true)
      expect(body.diffStatus).toBe('stale')
      expect(body).not.toHaveProperty('exactDiff')
    } finally {
      await app.close()
    }
  })

  it('returns an AI failure result without mutating or blocking the existing decision endpoint', async () => {
    const workingDir = createFixtureRepository()
    const { app, storage } = await buildApp(workingDir, 'not-json')
    try {
      const approval = createApproval(storage, workingDir)
      const before = storage.approvalRequests.findById(approval.id)
      const explanationResponse = await app.inject({
        method: 'POST',
        url: `/api/approval-requests/${approval.id}/explanation`,
      })

      expect(explanationResponse.statusCode).toBe(200)
      expect(explanationResponse.json<ApprovalExplanationResponse>()).toMatchObject({
        ok: false,
        error: 'AIによる説明を生成できませんでした',
      })
      expect(storage.approvalRequests.findById(approval.id)).toEqual(before)

      const decisionResponse = await app.inject({
        method: 'PATCH',
        url: `/api/approval-requests/${approval.id}/status`,
        payload: { status: 'APPROVED' },
      })
      expect(decisionResponse.statusCode).toBe(200)
      expect(decisionResponse.json<ApprovalRequest>().status).toBe('APPROVED')
    } finally {
      await app.close()
    }
  })

  it('answers questions using client-supplied session history without persisting it', async () => {
    const workingDir = createFixtureRepository()
    const { app, storage } = await buildApp(workingDir)
    try {
      const approval = createApproval(storage, workingDir)
      const response = await app.inject({
        method: 'POST',
        url: `/api/approval-requests/${approval.id}/ask`,
        payload: {
          question: '失敗した場合はどうなりますか？',
          history: [
            { role: 'user', content: '本番影響はありますか？' },
            { role: 'assistant', content: 'この承認だけでは公開されません。' },
          ],
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json<ApprovalQuestionResponse>()).toEqual({
        ok: true,
        answer: '承認に失敗した場合は処理が停止します。',
        diffStatus: 'exact',
      })
    } finally {
      await app.close()
    }
  })

  it('rejects an empty question before calling AI', async () => {
    const workingDir = createFixtureRepository()
    const { app, storage } = await buildApp(workingDir)
    try {
      const approval = createApproval(storage, workingDir)
      const response = await app.inject({
        method: 'POST',
        url: `/api/approval-requests/${approval.id}/ask`,
        payload: { question: '   ' },
      })

      expect(response.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
