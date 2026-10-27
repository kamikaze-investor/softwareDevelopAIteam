import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import {
  checkApprovalEvidenceBinding,
  externalCompletionApprovalDiffHash,
  externalCompletionEvidenceDigest,
  findBlockedJobsPreventingReconcile,
  previewExternalCompletion,
  verifyExternalCompletion,
  type ExternalCompletionEvidence,
} from './externalCompletion'
import { recordApprovalActor, recordResumeActor } from '../designReview/resumeActor'

/**
 * 外部完了の根拠検証。**呼び出し側の自己申告では通らない**ことを固定する。
 *
 * 実 git リポジトリを作って「Stable の HEAD の祖先か」を本当に判定させる
 * （ここをモックにすると、検証していることの証明にならない）。
 */

const temporaryDirectories: string[] = []

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', shell: false }).trim()
}

function createStableRepo(): { repo: string; mergedSha: string; unmergedSha: string } {
  const repo = mkdtempSync(path.join(tmpdir(), 'reconcile-stable-'))
  temporaryDirectories.push(repo)
  git(repo, ['init', '--object-format=sha1'])
  git(repo, ['config', 'user.email', 'reconcile@example.test'])
  git(repo, ['config', 'user.name', 'Reconcile Test'])

  writeFileSync(path.join(repo, 'base.txt'), 'base\n', 'utf-8')
  git(repo, ['add', 'base.txt'])
  git(repo, ['commit', '-m', 'base'])

  writeFileSync(path.join(repo, 'apps/worker-src-jobRunner.ts'.replace(/\//g, '-')), 'impl\n', 'utf-8')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'tier b implementation'])
  const mergedSha = git(repo, ['rev-parse', 'HEAD'])

  // deploy されていない（Stable の HEAD の子孫）commit を作ってから HEAD を戻す
  writeFileSync(path.join(repo, 'later.txt'), 'later\n', 'utf-8')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'not deployed yet'])
  const unmergedSha = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['reset', '--hard', mergedSha])

  return { repo, mergedSha, unmergedSha }
}

function seedTask(): { storage: IStorage; taskId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapTaskKey: 'guard-block-message-omits-allowed-paths',
  } as Parameters<IStorage['tasks']['create']>[0])
  return { storage, taskId: task.id }
}

function evidenceFor(commitSha: string, over: Partial<ExternalCompletionEvidence> = {}): ExternalCompletionEvidence {
  return {
    roadmapItemId: 'guard-block-message-omits-allowed-paths',
    commitSha,
    pullRequestUrl: 'https://github.com/o/r/pull/216',
    independentReviewVerdict: 'approved',
    ciResult: 'Typecheck & Test pass / Meta Reviewer pass',
    acceptanceEvidence: 'block message now lists allowedPaths',
    approvedScope: 'Tier B: minimal protected-file change for this task only',
    ...over,
  }
}

/** 人（ADMIN）が承認した reconcile_external_completion の承認依頼を作る。 */
function humanApprovedReconcile(
  storage: IStorage,
  taskId: string,
  over: { targetCommit?: string; targetDiffHash?: string; expiresAt?: string; actor?: 'admin' | 'worker' } = {},
): string {
  const request = storage.approvalRequests.create({
    taskId, targetBranch: 'external-completion', targetCommit: over.targetCommit ?? 'n/a',
    targetDiffHash: over.targetDiffHash ?? 'n/a', riskLevel: 'HIGH', requestedAction: 'reconcile_external_completion',
    status: 'APPROVED', expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(), invalidIf: [],
  })
  recordApprovalActor(storage, request.id, over.actor ?? 'admin')
  return request.id
}

function reconcileWithHumanApproval(storage: IStorage, taskId: string, sourceJobId: string) {
  return storage.jobs.reconcileExternalCompletion({
    taskId, sourceJobId, approvalRequestId: humanApprovedReconcile(storage, taskId), auditDetail: '{}',
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('verifyExternalCompletion — 自己申告では通らない', () => {
  it('merge 済みかつ deploy 済みの commit なら通る', () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(storage, taskId, evidenceFor(mergedSha), repo)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.verified.changedFiles.length).toBeGreaterThan(0)
  })

  it('Stable へ deploy されていない commit は通らない（merge 済みと deploy 済みを同時に見る）', () => {
    const { repo, unmergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(storage, taskId, evidenceFor(unmergedSha), repo)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not merged to canonical master, or not deployed yet')
  })

  it('Roadmap item が Task のものと違えば通らない（別成果で別 Task を閉じさせない）', () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(
      storage, taskId, evidenceFor(mergedSha, { roadmapItemId: 'some-other-item' }), repo,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('does not match')
  })

  it('Independent Review が approved でなければ通らない', () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(
      storage, taskId, evidenceFor(mergedSha, { independentReviewVerdict: 'changes_requested' }), repo,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('must be "approved"')
  })

  it('根拠が1つでも空なら通らない（記録を形骸化させない）', () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(
      storage, taskId, evidenceFor(mergedSha, { approvedScope: '   ' }), repo,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('approvedScope')
  })

  it('commitSha が hex でなければ git へ渡さない', () => {
    const { repo } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(storage, taskId, evidenceFor('HEAD; rm -rf /'), repo)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('hex git object name')
  })

  it('既に done な Task は通らない（二重反映しない）', () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()
    storage.tasks.update(taskId, { status: 'done' })

    const result = verifyExternalCompletion(storage, taskId, evidenceFor(mergedSha), repo)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('already done')
  })
})

/**
 * lifecycle repair C2: 取り込みは Task を done にするだけで Job に触れない。blocked 行を残したまま
 * done にすると、出口の無い「done Task の blocked 行」ができる（resume / abort とも done Task を拒否）。
 * 取り込みには clean worktree の証拠も無いので、終端化ではなく拒否する。
 */
describe('reconcileExternalCompletion — blocked Job が残る Task は done にしない', () => {
  function seedWithJob(status: 'blocked' | 'failed' | 'success'): { storage: IStorage; taskId: string; jobId: string } {
    const { storage, taskId } = seedTask()
    const task = storage.tasks.findById(taskId)!
    const job = storage.jobs.create({
      taskId, projectId: task.projectId, agentRole: 'developer_ai', status,
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    } as Parameters<IStorage['jobs']['create']>[0])
    return { storage, taskId, jobId: job.id }
  }

  it('refuses with TASK_HAS_BLOCKED_JOBS while an un-superseded blocked Job remains; nothing changes', () => {
    const { storage, taskId, jobId } = seedWithJob('blocked')

    const result = reconcileWithHumanApproval(storage, taskId, jobId)

    expect(result).toMatchObject({ ok: false, code: 'TASK_HAS_BLOCKED_JOBS' })
    if (result.ok) return
    expect(result.reason).toContain(jobId)
    expect(result.reason).toMatch(/resume .* or abort/)
    expect(storage.tasks.findById(taskId)?.status).toBe('pending')
    expect(storage.jobs.findById(jobId)?.status).toBe('blocked')
    expect(storage.taskContinuations.findByCompletedTaskId(taskId)).toBeUndefined()
  })

  it('a quarantined blocked Job also refuses (no clean evidence either way)', () => {
    const { storage, taskId, jobId } = seedWithJob('blocked')
    storage.jobs.update(jobId, { failureMetadata: { quarantined: true, quarantineReason: 'unverified' } })

    expect(reconcileWithHumanApproval(storage, taskId, jobId))
      .toMatchObject({ ok: false, code: 'TASK_HAS_BLOCKED_JOBS' })
  })

  it('a blocked source superseded by a human resume does not refuse', () => {
    const { storage, taskId, jobId } = seedWithJob('blocked')
    const task = storage.tasks.findById(taskId)!
    const successor = storage.jobs.create({
      taskId, projectId: task.projectId, agentRole: 'developer_ai', status: 'success',
      workflowStepKey: `resume:${jobId}:1`,
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    } as Parameters<IStorage['jobs']['create']>[0])
    recordResumeActor(storage, { jobId: successor.id, taskId, actorClass: 'human', evidence: 'admin_credential' })

    expect(findBlockedJobsPreventingReconcile(storage, taskId)).toEqual([])
    const result = reconcileWithHumanApproval(storage, taskId, successor.id)
    expect(result.ok).toBe(true)
    expect(storage.tasks.findById(taskId)?.status).toBe('done')
  })

  it('a legacy (non-quarantined) blocked row on a parked Task does not refuse: it no longer holds the workspace', () => {
    const { storage, taskId, jobId } = seedWithJob('blocked')
    storage.tasks.update(taskId, { roadmapActive: false })
    storage.auditLog.record({ actor: 'api', operation: 'task_aborted', entityType: 'task', entityId: taskId, result: 'success' })

    expect(findBlockedJobsPreventingReconcile(storage, taskId)).toEqual([])
    expect(reconcileWithHumanApproval(storage, taskId, jobId).ok).toBe(true)
    expect(storage.tasks.findById(taskId)?.status).toBe('done')
  })

  it('a quarantined blocked row on a parked Task still refuses', () => {
    const { storage, taskId, jobId } = seedWithJob('blocked')
    storage.jobs.update(jobId, { failureMetadata: { quarantined: true, quarantineReason: 'unverified' } })
    storage.auditLog.record({ actor: 'api', operation: 'task_aborted', entityType: 'task', entityId: taskId, result: 'success' })

    expect(reconcileWithHumanApproval(storage, taskId, jobId))
      .toMatchObject({ ok: false, code: 'TASK_HAS_BLOCKED_JOBS' })
  })

  it('a quarantined blocked source superseded by a human resume still refuses (quarantine wins)', () => {
    const { storage, taskId, jobId } = seedWithJob('blocked')
    storage.jobs.update(jobId, { failureMetadata: { quarantined: true, quarantineReason: 'unverified' } })
    const task = storage.tasks.findById(taskId)!
    const successor = storage.jobs.create({
      taskId, projectId: task.projectId, agentRole: 'developer_ai', status: 'success',
      workflowStepKey: `resume:${jobId}:1`,
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    } as Parameters<IStorage['jobs']['create']>[0])
    recordResumeActor(storage, { jobId: successor.id, taskId, actorClass: 'human', evidence: 'admin_credential' })

    expect(reconcileWithHumanApproval(storage, taskId, successor.id))
      .toMatchObject({ ok: false, code: 'TASK_HAS_BLOCKED_JOBS' })
  })

  it.each(['failed', 'success'] as const)('a Task whose Jobs are all terminal (%s) is reconciled as before', (status) => {
    const { storage, taskId, jobId } = seedWithJob(status)

    const result = reconcileWithHumanApproval(storage, taskId, jobId)

    expect(result.ok).toBe(true)
    expect(storage.tasks.findById(taskId)?.status).toBe('done')
  })
})

describe('previewExternalCompletion — 取り込みと同じ検査を、状態を変えずに行う', () => {
  function seedWithJob(): { storage: IStorage; taskId: string; jobId: string } {
    const { storage, taskId } = seedTask()
    const task = storage.tasks.findById(taskId)!
    const job = storage.jobs.create({
      taskId, projectId: task.projectId, agentRole: 'developer_ai', status: 'failed',
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    } as Parameters<IStorage['jobs']['create']>[0])
    return { storage, taskId, jobId: job.id }
  }

  it('returns the server-verified files, the Stable HEAD and the approval binding digest', async () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId, jobId } = seedWithJob()

    const preview = await previewExternalCompletion(storage, taskId, jobId, evidenceFor(mergedSha), repo)

    expect(preview?.eligible).toBe(true)
    expect(preview?.problems).toEqual([])
    expect(preview?.verification).toMatchObject({ ok: true, changedFiles: ['apps-worker-src-jobRunner.ts'], stableHead: mergedSha })
    expect(preview?.approvalTargetDiffHash)
      .toBe(externalCompletionApprovalDiffHash(externalCompletionEvidenceDigest(taskId, jobId, evidenceFor(mergedSha))))
  })

  it('writes nothing: Task, Jobs, approvals and audit are unchanged', async () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId, jobId } = seedWithJob()
    const before = JSON.stringify([
      storage.tasks.findById(taskId), storage.jobs.findByTaskId(taskId),
      storage.approvalRequests.findByTaskId(taskId), storage.auditLog.findByEntity('task', taskId),
    ])

    await previewExternalCompletion(storage, taskId, jobId, evidenceFor(mergedSha), repo)

    expect(JSON.stringify([
      storage.tasks.findById(taskId), storage.jobs.findByTaskId(taskId),
      storage.approvalRequests.findByTaskId(taskId), storage.auditLog.findByEntity('task', taskId),
    ])).toBe(before)
  })

  it('reports missing or invalid evidence, an undeployed commit and a foreign source Job as problems', async () => {
    const { repo, unmergedSha, mergedSha } = createStableRepo()
    const { storage, taskId } = seedWithJob()

    const undeployed = await previewExternalCompletion(storage, taskId, 'no-such-job', evidenceFor(unmergedSha), repo)
    expect(undeployed?.eligible).toBe(false)
    expect(undeployed?.verification.ok).toBe(false)
    expect(undeployed?.problems.join('\n')).toContain('not deployed yet')
    expect(undeployed?.problems).toContain('Source Job not found for this Task')

    const rejected = await previewExternalCompletion(
      storage, taskId, 'no-such-job', evidenceFor(mergedSha, { independentReviewVerdict: 'changes_requested' }), repo,
    )
    expect(rejected?.eligible).toBe(false)
  })

  it('returns undefined for an unknown Task', async () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage } = seedTask()
    expect(await previewExternalCompletion(storage, 'missing', 'job', evidenceFor(mergedSha), repo)).toBeUndefined()
  })

  it('marks files owned in .github/CODEOWNERS at Stable HEAD (display only)', async () => {
    const { repo } = createStableRepo()
    execFileSync('git', ['checkout', '-q', '-b', 'with-owners'], { cwd: repo })
    mkdirSync(path.join(repo, '.github'), { recursive: true })
    mkdirSync(path.join(repo, 'apps/worker/src/guards'), { recursive: true })
    writeFileSync(path.join(repo, '.github/CODEOWNERS'), '# owners\napps/worker/src/guards/ @ceo\nCLAUDE.md @ceo\n', 'utf-8')
    writeFileSync(path.join(repo, 'apps/worker/src/guards/g.ts'), 'g\n', 'utf-8')
    writeFileSync(path.join(repo, 'CLAUDE.md'), 'c\n', 'utf-8')
    writeFileSync(path.join(repo, 'free.ts'), 'f\n', 'utf-8')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'owned change'])
    const sha = git(repo, ['rev-parse', 'HEAD'])
    const { storage, taskId, jobId } = seedWithJob()

    const preview = await previewExternalCompletion(storage, taskId, jobId, evidenceFor(sha), repo)

    expect(preview?.verification).toMatchObject({ ok: true, codeOwnedFiles: ['CLAUDE.md', 'apps/worker/src/guards/g.ts'] })
  })
})

describe('externalCompletionEvidenceDigest — 根拠のどの項目が変わっても digest が変わる', () => {
  it.each([
    'roadmapItemId', 'commitSha', 'pullRequestUrl', 'independentReviewVerdict', 'ciResult', 'acceptanceEvidence', 'approvedScope',
  ] as const)('%s', (key) => {
    const base = evidenceFor('a'.repeat(40))
    expect(externalCompletionEvidenceDigest('t', 'j', { ...base, [key]: `${base[key]}x` }))
      .not.toBe(externalCompletionEvidenceDigest('t', 'j', base))
  })

  it('binds the Task and the source Job too, and ignores surrounding whitespace', () => {
    const base = evidenceFor('a'.repeat(40))
    expect(externalCompletionEvidenceDigest('t2', 'j', base)).not.toBe(externalCompletionEvidenceDigest('t', 'j', base))
    expect(externalCompletionEvidenceDigest('t', 'j2', base)).not.toBe(externalCompletionEvidenceDigest('t', 'j', base))
    expect(externalCompletionEvidenceDigest('t', 'j', { ...base, ciResult: ` ${base.ciResult} ` }))
      .toBe(externalCompletionEvidenceDigest('t', 'j', base))
  })
})

describe('reconcileExternalCompletion — 承認の使用・完了・audit は 1 transaction', () => {
  function seedTerminal(): { storage: IStorage; taskId: string; jobId: string } {
    const { storage, taskId } = seedTask()
    const task = storage.tasks.findById(taskId)!
    const job = storage.jobs.create({
      taskId, projectId: task.projectId, agentRole: 'developer_ai', status: 'failed',
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    } as Parameters<IStorage['jobs']['create']>[0])
    return { storage, taskId, jobId: job.id }
  }

  it('consumes the approval and writes the evidence audit together with the completion', () => {
    const { storage, taskId, jobId } = seedTerminal()
    const approvalRequestId = humanApprovedReconcile(storage, taskId)

    const result = storage.jobs.reconcileExternalCompletion({ taskId, sourceJobId: jobId, approvalRequestId, auditDetail: '{"pr":"x"}' })

    expect(result.ok).toBe(true)
    expect(storage.tasks.findById(taskId)?.status).toBe('done')
    expect(storage.approvalRequests.findById(approvalRequestId)?.status).toBe('CONSUMED')
    expect(storage.auditLog.findByEntity('task', taskId).filter((row) => row.operation === 'reconcile_external_completion'))
      .toEqual([expect.objectContaining({ detail: '{"pr":"x"}', result: 'done' })])
  })

  it('an expired approval changes nothing (APPROVAL_NOT_USABLE)', () => {
    const { storage, taskId, jobId } = seedTerminal()
    const approvalRequestId = humanApprovedReconcile(storage, taskId, { expiresAt: new Date(Date.now() - 1000).toISOString() })

    const result = storage.jobs.reconcileExternalCompletion({ taskId, sourceJobId: jobId, approvalRequestId, auditDetail: '{}' })

    expect(result).toMatchObject({ ok: false, code: 'APPROVAL_NOT_USABLE' })
    expect(storage.tasks.findById(taskId)?.status).toBe('pending')
    expect(storage.taskContinuations.findByCompletedTaskId(taskId)).toBeUndefined()
    expect(storage.auditLog.findByEntity('task', taskId).some((row) => row.operation === 'reconcile_external_completion')).toBe(false)
  })

  it('an approval decided by the Worker / AI credential is not usable and is superseded', () => {
    const { storage, taskId, jobId } = seedTerminal()
    const approvalRequestId = humanApprovedReconcile(storage, taskId, { actor: 'worker' })

    const result = storage.jobs.reconcileExternalCompletion({ taskId, sourceJobId: jobId, approvalRequestId, auditDetail: '{}' })

    expect(result).toMatchObject({ ok: false, code: 'APPROVAL_NOT_USABLE' })
    expect(storage.tasks.findById(taskId)?.status).toBe('pending')
    expect(storage.approvalRequests.findById(approvalRequestId)?.status).toBe('SUPERSEDED')
  })

  it('a used approval cannot complete again, and a second completion is refused (no duplicate effect)', () => {
    const { storage, taskId, jobId } = seedTerminal()
    const approvalRequestId = humanApprovedReconcile(storage, taskId)
    expect(storage.jobs.reconcileExternalCompletion({ taskId, sourceJobId: jobId, approvalRequestId, auditDetail: '{}' }).ok).toBe(true)

    expect(storage.jobs.reconcileExternalCompletion({ taskId, sourceJobId: jobId, approvalRequestId, auditDetail: '{}' }))
      .toMatchObject({ ok: false, code: 'ALREADY_DONE' })
    expect(storage.auditLog.findByEntity('task', taskId).filter((row) => row.operation === 'reconcile_external_completion')).toHaveLength(1)
  })

  it('an approval of another action is not usable and is left as it was', () => {
    const { storage, taskId, jobId } = seedTerminal()
    const abort = storage.approvalRequests.create({
      taskId, targetBranch: 'manual-abort', targetCommit: taskId, targetDiffHash: 'x', riskLevel: 'HIGH',
      requestedAction: 'abort_task', status: 'APPROVED', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), invalidIf: [],
    })
    recordApprovalActor(storage, abort.id, 'admin')

    expect(storage.jobs.reconcileExternalCompletion({ taskId, sourceJobId: jobId, approvalRequestId: abort.id, auditDetail: '{}' }))
      .toMatchObject({ ok: false, code: 'APPROVAL_NOT_USABLE' })
    expect(storage.approvalRequests.findById(abort.id)?.status).toBe('APPROVED')
    expect(storage.tasks.findById(taskId)?.status).toBe('pending')
  })
})

describe('checkApprovalEvidenceBinding — 承認はこの commit・この根拠に対するものだけ', () => {
  function bound(repo: string, sha: string, over: { targetCommit?: string; targetDiffHash?: string } = {}) {
    const { storage, taskId } = seedTask()
    const evidence = evidenceFor(sha)
    const approvalRequestId = humanApprovedReconcile(storage, taskId, {
      targetCommit: over.targetCommit ?? sha,
      targetDiffHash: over.targetDiffHash ?? externalCompletionApprovalDiffHash(externalCompletionEvidenceDigest(taskId, 'job-1', evidence)),
    })
    const verified = verifyExternalCompletion(storage, taskId, evidence, repo)
    if (!verified.ok) throw new Error(verified.reason)
    return { storage, taskId, evidence, approvalRequestId, commit: verified.verified.commit }
  }

  it('accepts an approval issued for this commit and this evidence digest (short SHA resolves to the same commit)', () => {
    const { repo, mergedSha } = createStableRepo()
    const full = bound(repo, mergedSha)
    expect(checkApprovalEvidenceBinding(full.storage, { ...full, sourceJobId: 'job-1' }, repo)).toEqual({ ok: true })
    const short = bound(repo, mergedSha, { targetCommit: mergedSha.slice(0, 10) })
    expect(checkApprovalEvidenceBinding(short.storage, { ...short, sourceJobId: 'job-1' }, repo)).toEqual({ ok: true })
  })

  it('refuses when any evidence field or the source Job differs from what was approved', () => {
    const { repo, mergedSha } = createStableRepo()
    const fx = bound(repo, mergedSha)
    expect(checkApprovalEvidenceBinding(fx.storage, { ...fx, sourceJobId: 'job-2' }, repo).ok).toBe(false)
    expect(checkApprovalEvidenceBinding(
      fx.storage, { ...fx, sourceJobId: 'job-1', evidence: { ...fx.evidence, approvedScope: 'wider' } }, repo,
    ).ok).toBe(false)
  })

  it('refuses an approval issued for another commit', () => {
    const { repo, mergedSha } = createStableRepo()
    const base = git(repo, ['rev-parse', 'HEAD~1'])
    const fx = bound(repo, mergedSha, { targetCommit: base })
    expect(checkApprovalEvidenceBinding(fx.storage, { ...fx, sourceJobId: 'job-1' }, repo))
      .toMatchObject({ ok: false, reason: expect.stringContaining('was issued for commit') })
  })

  it('refuses a legacy approval without the evidence digest (a fresh bound approval is required)', () => {
    const { repo, mergedSha } = createStableRepo()
    const fx = bound(repo, mergedSha, { targetDiffHash: 'external-tier-b' })
    expect(checkApprovalEvidenceBinding(fx.storage, { ...fx, sourceJobId: 'job-1' }, repo))
      .toMatchObject({ ok: false, reason: expect.stringContaining('not issued for this evidence') })
  })

  it('leaves a missing approval to the Gate (it is refused there)', () => {
    const { repo, mergedSha } = createStableRepo()
    const fx = bound(repo, mergedSha)
    expect(checkApprovalEvidenceBinding(fx.storage, { ...fx, approvalRequestId: 'missing', sourceJobId: 'job-1' }, repo))
      .toEqual({ ok: true })
  })
})
