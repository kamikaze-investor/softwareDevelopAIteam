import { describe, expect, it, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage, GateEvaluationEvidence } from '../storage/interface'
import { computeChangeManifestHash } from '../approvalExplain/changeManifestIdentity'
import { buildWorktreeChangeManifest, readHeadCommit } from '../approvalExplain/changeManifestReader'
import { bindResultingCommitForJob } from './resultingCommitBinding'

/**
 * resulting_commit binding の不変条件。
 *
 * 1. immutable: 一度bindしたら別commitへbindし直さない（CAS）
 * 2. eligibility: ALLOW / authoritative / hash有り / jobId一致 のevidenceだけ
 * 3. WorkerのcommitHashはtrust sourceにしない（偽値でも必ずauthoritativeで拒否される）
 */

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' })
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bindtest-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'p@example.com'])
  git(dir, ['config', 'user.name', 'p'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(dir, 'tracked.txt'), 'line1\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  return dir
}

function commitAll(dir: string, message: string): string {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', message])
  return readHeadCommit(dir)
}

function seedStorage(): { storage: IStorage; taskId: string; jobId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'in_progress',
    assignee: 'developer_ai', dependencies: [],
  })
  const job = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai',
    status: 'running', safeCommand: { kind: 'git_commit' },
  } as never)
  return { storage, taskId: task.id, jobId: job.id }
}

function createEvidence(
  storage: IStorage,
  base: { taskId: string; jobId: string; targetCommit: string },
  overrides: Partial<Omit<GateEvaluationEvidence, 'id' | 'createdAt'>> = {},
): GateEvaluationEvidence {
  return storage.gateEvaluations.create({
    taskId: base.taskId,
    jobId: base.jobId,
    targetBranch: 'ai/task-001',
    targetCommit: base.targetCommit,
    targetDiffHash: 'diff-hash',
    decision: 'ALLOW',
    riskLevel: 'LOW',
    triggeredRules: [],
    policyVersion: 'gate-policy-v1',
    bindingVerification: 'authoritative',
    ...overrides,
  })
}

describe('resulting_commit binding', () => {
  let dir: string
  let commitA: string
  let approvedHash: string
  let ctx: { storage: IStorage; taskId: string; jobId: string }

  beforeEach(() => {
    dir = initRepo()
    commitA = readHeadCommit(dir)
    appendFileSync(join(dir, 'tracked.txt'), 'line2\n')
    writeFileSync(join(dir, 'added.txt'), 'new\n')
    approvedHash = computeChangeManifestHash(buildWorktreeChangeManifest(dir))
    ctx = seedStorage()
  })

  it('approved A+D → commit B なら resulting_commit=B が bind される', () => {
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    const commitB = commitAll(dir, 'work')

    const outcome = bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir })

    expect(outcome).toEqual({ bound: true, resultingCommit: commitB })
    expect(ctx.storage.gateEvaluations.findByResultingCommit(commitB)).toHaveLength(1)
  })

  it('WorkerのcommitHashは受け取らず、authoritative HEADだけがbindされる', () => {
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    const commitB = commitAll(dir, 'work')

    // binding APIはcommitHashを受け取らない（trust sourceにしないため引数自体が無い）
    const outcome = bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir })

    expect(outcome).toEqual({ bound: true, resultingCommit: commitB })
    // Workerが偽値を主張しても、その値がbindされる経路は存在しない
    expect(ctx.storage.gateEvaluations.findByResultingCommit('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'))
      .toHaveLength(0)
  })

  it('同一Jobに適格なALLOWが複数あるとbindを拒否する（1 ALLOW = 1 commit）', () => {
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    commitAll(dir, 'work')

    expect(bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir }))
      .toEqual({ bound: false, reason: 'ambiguous_evidence' })
  })

  it('parentがAと違うとbindしない', () => {
    // 先に別commitを作ってHEADを進め、parentがAでなくなる状態にする
    commitAll(dir, 'first')
    appendFileSync(join(dir, 'tracked.txt'), 'line3\n')
    commitAll(dir, 'second')

    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    const outcome = bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir })

    expect(outcome).toEqual({ bound: false, reason: 'parent_mismatch' })
  })

  it('approved後に内容を書き換えてcommitするとbindしない', () => {
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    writeFileSync(join(dir, 'tracked.txt'), 'line1\nTAMPERED\n')
    commitAll(dir, 'tampered')

    expect(bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir }))
      .toEqual({ bound: false, reason: 'content_mismatch' })
  })

  it('approved後に余計なfileを追加してcommitするとbindしない', () => {
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    writeFileSync(join(dir, 'sneaky.txt'), 'not approved\n')
    commitAll(dir, 'with extra')

    expect(bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir }))
      .toEqual({ bound: false, reason: 'content_mismatch' })
  })

  it('一度bindしたら別commitへbindし直さない（immutable / CAS）', () => {
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    const commitB = commitAll(dir, 'work')

    expect(bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir }).bound).toBe(true)

    // 遅延・重複PATCH相当で再度呼ぶ
    const again = bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir })
    expect(again).toEqual({ bound: false, reason: 'already_bound' })

    const stored = ctx.storage.gateEvaluations.findByJobId(ctx.jobId)[0]
    expect(stored.resultingCommit).toBe(commitB)
  })

  it('CASは直接呼んでも2回目が失敗する', () => {
    const evidence = createEvidence(
      ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash },
    )
    const first = ctx.storage.gateEvaluations.bindResultingCommit({
      evidenceId: evidence.id, jobId: ctx.jobId, resultingCommit: 'commit-1',
    })
    const second = ctx.storage.gateEvaluations.bindResultingCommit({
      evidenceId: evidence.id, jobId: ctx.jobId, resultingCommit: 'commit-2',
    })

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(ctx.storage.gateEvaluations.findByJobId(ctx.jobId)[0].resultingCommit).toBe('commit-1')
  })
})

describe('binding eligibility', () => {
  let dir: string
  let commitA: string
  let approvedHash: string
  let ctx: { storage: IStorage; taskId: string; jobId: string }

  beforeEach(() => {
    dir = initRepo()
    commitA = readHeadCommit(dir)
    appendFileSync(join(dir, 'tracked.txt'), 'line2\n')
    approvedHash = computeChangeManifestHash(buildWorktreeChangeManifest(dir))
    ctx = seedStorage()
  })

  it('unverified / diff_text_hash のevidenceはcommit後もauthoritativeへ昇格しない', () => {
    for (const level of ['unverified', 'diff_text_hash'] as const) {
      const fresh = seedStorage()
      createEvidence(fresh.storage, { taskId: fresh.taskId, jobId: fresh.jobId, targetCommit: commitA }, {
        bindingVerification: level,
        approvedContentHash: approvedHash,
      })
      expect(bindResultingCommitForJob(fresh.storage, { jobId: fresh.jobId, workingDir: dir }))
        .toEqual({ bound: false, reason: 'no_eligible_evidence' })
    }
  })

  it('BLOCKED / REJECTED にはresulting_commitを付けない', () => {
    for (const decision of ['BLOCKED', 'REJECTED', 'STALE'] as const) {
      const fresh = seedStorage()
      createEvidence(fresh.storage, { taskId: fresh.taskId, jobId: fresh.jobId, targetCommit: commitA }, {
        decision,
        approvedContentHash: approvedHash,
      })
      expect(bindResultingCommitForJob(fresh.storage, { jobId: fresh.jobId, workingDir: dir }))
        .toEqual({ bound: false, reason: 'no_eligible_evidence' })
    }
  })

  it('approved_content_hash が無いevidenceはbindできない', () => {
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA })
    expect(bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir }))
      .toEqual({ bound: false, reason: 'no_eligible_evidence' })
  })

  it('jobIdが一致しないevidenceへはbindしない', () => {
    createEvidence(ctx.storage, { ...ctx, jobId: 'other-job', targetCommit: commitA }, {
      approvedContentHash: approvedHash,
    })
    expect(bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir }))
      .toEqual({ bound: false, reason: 'no_eligible_evidence' })
  })

  it('CAS側でもeligibility条件が強制される', () => {
    const evidence = createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, {
      decision: 'BLOCKED',
      approvedContentHash: approvedHash,
    })
    expect(ctx.storage.gateEvaluations.bindResultingCommit({
      evidenceId: evidence.id, jobId: ctx.jobId, resultingCommit: 'x',
    })).toBe(false)
  })

  it('repositoryが読めない場合はbindせずfail-closed', () => {
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    expect(bindResultingCommitForJob(ctx.storage, {
      jobId: ctx.jobId, workingDir: join(tmpdir(), 'definitely-not-a-repo-xyz'),
    })).toEqual({ bound: false, reason: 'repo_unreadable' })
  })
})

describe('1 ALLOW = 1 git_commit = 1 resulting_commit', () => {
  let dir: string
  let commitA: string
  let approvedHash: string

  beforeEach(() => {
    dir = initRepo()
    commitA = readHeadCommit(dir)
    appendFileSync(join(dir, 'tracked.txt'), 'line2\n')
    approvedHash = computeChangeManifestHash(buildWorktreeChangeManifest(dir))
  })

  it('別のtrusted evidenceが同じresulting_commitへbindできない（一意制約）', () => {
    const ctx = seedStorage()
    const first = createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, {
      approvedContentHash: approvedHash,
    })
    // 別Jobの別evidence（同一commitを主張する）
    const second = createEvidence(ctx.storage, { ...ctx, jobId: 'other-job', targetCommit: commitA }, {
      approvedContentHash: approvedHash,
    })

    expect(ctx.storage.gateEvaluations.bindResultingCommit({
      evidenceId: first.id, jobId: ctx.jobId, resultingCommit: 'commit-shared',
    })).toBe(true)

    expect(ctx.storage.gateEvaluations.bindResultingCommit({
      evidenceId: second.id, jobId: 'other-job', resultingCommit: 'commit-shared',
    })).toBe(false)

    expect(ctx.storage.gateEvaluations.findByResultingCommit('commit-shared')).toHaveLength(1)
  })

  it('Gate再実行でevidenceが増えても、同一Jobのbindは成立しない（曖昧を拒否）', () => {
    const ctx = seedStorage()
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    // 同じJobでGateが再実行された状況
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    commitAll(dir, 'work')

    expect(bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir }))
      .toEqual({ bound: false, reason: 'ambiguous_evidence' })
    expect(ctx.storage.gateEvaluations.findByJobId(ctx.jobId).every((e) => e.resultingCommit === undefined))
      .toBe(true)
  })

  it('duplicate PATCH相当で複数回bindしてもcommitは1つだけ紐づく', () => {
    const ctx = seedStorage()
    createEvidence(ctx.storage, { ...ctx, targetCommit: commitA }, { approvedContentHash: approvedHash })
    const commitB = commitAll(dir, 'work')

    for (let i = 0; i < 5; i += 1) {
      bindResultingCommitForJob(ctx.storage, { jobId: ctx.jobId, workingDir: dir })
    }

    expect(ctx.storage.gateEvaluations.findByResultingCommit(commitB)).toHaveLength(1)
  })
})
