import { describe, expect, it, beforeEach } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { buildSystemState, type AttentionItem } from '../state/systemState'
import {
  buildTriageEscalationBody,
  formatTriageAuditDetail,
  needsProviderDiagnosis,
  parseTriageAuditDetail,
  readLatestDesignReview,
  summarizeBlockedTriage,
  triageAllowedActions,
  triageBlocked,
  type BlockedDiagnosis,
} from './blockedTriage'
import {
  PL_MAX_ATTEMPTS_PER_TARGET,
  resetPlLoopInFlightForTest,
  runPlTick,
  type PlLoopDeps,
} from './executionLoop'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildInitialImplementAiCliPrompt } from '../ctoAi/initialImplementWorkflow'

/**
 * ここで固定しているのは次の2つである。
 *
 * 1. **原因分類とレーン選択が機械的事実だけで決まる**こと（PL の自由文・自己申告が入らない）
 * 2. **Triage が権限を作らない**こと —— Gate を弱めず、証拠不足で状態を変えず、
 *    上限を超えて retry せず、BLOCK を override しない
 *
 * 分類の「賢さ」は対象外。分類は実レコードの関数であり、ここではその関数を固定する。
 */

const NOW = '2026-09-18T10:00:00.000Z'

function seed(): { storage: IStorage; projectId: string; taskId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS',
    goal: 'g',
    designPhilosophy: [],
    status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: true,
    phase: 1,
  } as Parameters<IStorage['tasks']['create']>[0])
  return { storage, projectId: project.id, taskId: task.id }
}

/** guard で止まった blocked Job。`fileViolations` が分類の材料になる。 */
function blockedByGuard(
  storage: IStorage,
  taskId: string,
  projectId: string,
  fileViolations: string[],
): string {
  const job = storage.jobs.create({
    taskId,
    projectId,
    agentRole: 'developer_ai',
    status: 'blocked',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    dryRun: false,
  } as Parameters<IStorage['jobs']['create']>[0])
  storage.jobs.update(job.id, {
    guardResult: { permissionAllowed: true, fileChangeAllowed: false, fileViolations },
  } as Parameters<IStorage['jobs']['update']>[1])
  storage.tasks.update(taskId, { status: 'blocked' })
  return job.id
}

/** provider timeout で failed になった implement Job。 */
function providerTimeoutJob(
  storage: IStorage,
  taskId: string,
  projectId: string,
  workspaceState: 'unchanged' | 'changed',
): string {
  const job = storage.jobs.create({
    taskId,
    projectId,
    agentRole: 'developer_ai',
    status: 'failed',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    dryRun: false,
    aiCliProvider: 'claude_code',
    aiCliMode: 'implement',
    aiCliPrompt: 'do the thing',
  } as Parameters<IStorage['jobs']['create']>[0])
  storage.jobs.update(job.id, {
    failureMetadata: { kind: 'provider_timeout', workspaceState },
  } as Parameters<IStorage['jobs']['update']>[1])
  storage.tasks.update(taskId, { status: 'blocked' })
  return job.id
}

/** 終端した task-kind Design Review。`decision` がそのまま `finalDecision` になる。 */
function completedReview(storage: IStorage, taskId: string, decision: string): void {
  const run = storage.designReviewRuns.create({
    taskId,
    taskTitle: 'adopted',
    designText: 'design text',
    designTextHash: `hash-${decision}`,
    changedFiles: [],
  })
  const claim = storage.designReviewRuns.claim(run.id, 3)
  storage.designReviewRuns.complete(
    run.id,
    claim.claimToken as string,
    'succeeded',
    JSON.stringify({
      finalDecision: decision,
      integrationReviewResult: { decision, summary: 'scope 要約が3つの訂正のうち2つを誤記している' },
    }),
    undefined,
  )
}

/**
 * `findRemediationSubject()` の条件をすべて満たす CONFLICT。**配線済みの解決経路の対象**である。
 * （`roadmapTaskKey` があり、pending・Job 0件、task-kind run が succeeded で CONFLICT）
 */
function seedRemediableConflict(): { storage: IStorage; taskId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'CONFLICT した項目',
    description: 'body',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: ['apps/api/src'],
    acceptanceCriteria: ['c'],
    roadmapTaskKey: 'conflicted-item',
    phase: 1,
    roadmapActive: true,
  } as Parameters<IStorage['tasks']['create']>[0])

  const designText = buildInitialImplementAiCliPrompt(task)
  const run = storage.designReviewRuns.create({
    taskId: task.id,
    taskTitle: task.title,
    designText,
    designTextHash: computeDesignTextHash(designText),
    changedFiles: [],
  })
  const claimed = storage.designReviewRuns.claim(run.id, 3)
  storage.designReviewRuns.complete(
    run.id,
    claimed.claimToken as string,
    'succeeded',
    JSON.stringify({ focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }] }),
  )
  return { storage, taskId: task.id }
}

/** その Project の attention から、指定 kind の1件を取る。**手で AttentionItem を作らない。** */
function attentionOf(storage: IStorage, kind: AttentionItem['kind'], now = NOW): AttentionItem {
  const state = buildSystemState(storage, { now: () => now })
  const found = state.attention.find((item) => item.kind === kind)
  if (!found) {
    throw new Error(
      `no ${kind} attention; got [${state.attention.map((i) => i.kind).join(', ')}]`,
    )
  }
  return found
}

function deps(over: Partial<PlLoopDeps> = {}): PlLoopDeps {
  return {
    now: () => NOW,
    diagnose: async () => JSON.stringify({ actionKind: 'observe_state', rationale: 'w', riskLevel: 'LOW' }),
    rekickDesignReview: async () => ({ status: 'evidence_registered' }),
    escalate: async () => {},
    readLedger: () => '',
    ...over,
  }
}

beforeEach(() => {
  resetPlLoopInFlightForTest()
})

// ────────────────────────────────────────────────────────────
// 1〜8: 原因 → レーン
// ────────────────────────────────────────────────────────────

describe('triageBlocked — 原因分類とレーン選択', () => {
  it('1. 一時的な provider 障害（workspace 未変更）は AUTO_RECOVERY', () => {
    const { storage, taskId, projectId } = seed()
    providerTimeoutJob(storage, taskId, projectId, 'unchanged')

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_failed'))

    expect(diagnosis.rootCauseClass).toBe('provider_transient')
    expect(diagnosis.recommendedLane).toBe('auto_recovery')
    expect(diagnosis.existingRecoveryAvailable).toBe(true)
    expect(diagnosis.confidence).toBe('high')
  })

  it('1b. 同じ provider 障害でも workspace が未確定なら AUTO_RECOVERY にしない', () => {
    // 既存の自動 retry は `workspaceState=unchanged` のときだけ許されている。
    // 「provider の障害だから retry してよい」と一般化すると、汚れた worktree の上で
    // もう一度実装を走らせることになる。
    const { storage, taskId, projectId } = seed()
    providerTimeoutJob(storage, taskId, projectId, 'changed')

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_failed'))

    expect(diagnosis.rootCauseClass).toBe('provider_failure_workspace_dirty')
    expect(diagnosis.recommendedLane).toBe('ceo_escalation')
    expect(diagnosis.existingRecoveryAvailable).toBe(false)
  })

  it('2. task-kind Design Review の CONFLICT は INDEPENDENT_REMEDIATION', () => {
    const { storage, taskId } = seed()
    completedReview(storage, taskId, 'CONFLICT')

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'task_ready_without_job'))

    expect(diagnosis.rootCauseClass).toBe('design_review_conflict')
    expect(diagnosis.recommendedLane).toBe('independent_remediation')
    // 具体的な設計上の問題が証拠として残る（「CONFLICT だった」だけにしない）
    expect(diagnosis.summary).toContain('scope 要約が3つの訂正のうち2つを誤記している')
    expect(diagnosis.evidence[0]?.fact).toBe('design_review_run.finalDecision')
  })

  it('3. allowedPaths と実装対象の不一致は INDEPENDENT_REMEDIATION', () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['docs/approval-roles/index.md'])

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    expect(diagnosis.rootCauseClass).toBe('allowed_paths_mismatch')
    expect(diagnosis.recommendedLane).toBe('independent_remediation')
    // 同じ設計のまま retry しても同じ違反になる＝配線済みの復旧は無い
    expect(diagnosis.existingRecoveryAvailable).toBe(false)
  })

  it('4. protected だが runtime / infrastructure なら MAINTENANCE_LANE', () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['apps/worker/src/jobRunner.ts'])

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    expect(diagnosis.rootCauseClass).toBe('protected_path')
    expect(diagnosis.recommendedLane).toBe('maintenance_lane')
    expect(diagnosis.requiresSafetyBoundaryChange).toBe(false)
  })

  it('5. 同じ protected でも Safety Boundary 中核なら CEO_ESCALATION（Maintenance へ降ろさない）', () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['apps/worker/src/guards/fileChangeGuard.ts'])

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    expect(diagnosis.rootCauseClass).toBe('safety_or_authority_boundary')
    expect(diagnosis.recommendedLane).toBe('ceo_escalation')
    expect(diagnosis.requiresSafetyBoundaryChange).toBe(true)
  })

  it('5b. Maintenance 対象と Safety 中核が混ざったら、安全側（CEO）へ倒す', () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, [
      'apps/worker/src/jobRunner.ts',
      'apps/worker/src/guards/gatePolicy.ts',
    ])

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    expect(diagnosis.recommendedLane).toBe('ceo_escalation')
  })

  it('5c. allowlist に無い未知の protected path は既定で CEO へ倒れる（fail-closed）', () => {
    // `ALWAYS_FORBIDDEN_PATTERNS` が今後増えても、Maintenance allowlist へ足さない限り
    // 新しい protected path が黙って Maintenance レーンへ流れることはない。
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['packages/shared/src/types/safety_guard.ts'])

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    expect(diagnosis.recommendedLane).toBe('ceo_escalation')
    expect(diagnosis.rootCauseClass).toBe('safety_or_authority_boundary')
  })

  it('5d. Maintenance allowlist に一致しても、secret なら Maintenance へ流さない', () => {
    // 独立レビュー（2026-09-18）の指摘への回帰テスト。allowlist の pattern は語単位
    // （`/jobRunner/i`）なので、`jobRunner.key` は maintenance にも secret にも一致する。
    // secret を先に落とさないと、**秘密ファイルが Maintenance Lane へ流れる**。
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['apps/worker/src/jobRunner.key'])

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    expect(diagnosis.recommendedLane).toBe('ceo_escalation')
    expect(diagnosis.rootCauseClass).toBe('safety_or_authority_boundary')
    expect(diagnosis.irreversible).toBe(true)
  })

  it('6. Authority（権限・認証）に触れる変更は CEO_ESCALATION', () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['apps/worker/src/utils/apiAuth.ts'])

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    expect(diagnosis.requiresAuthorityChange).toBe(true)
    expect(diagnosis.recommendedLane).toBe('ceo_escalation')
  })

  it('7. secret に触れる変更は irreversible として CEO_ESCALATION', () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['apps/api/.env'])

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    expect(diagnosis.irreversible).toBe(true)
    expect(diagnosis.recommendedLane).toBe('ceo_escalation')
    expect(diagnosis.recoverable).toBe(false)
  })

  it('8. 証拠不足なら UNKNOWN になり、AUTO_RECOVERY へは倒れない', () => {
    // 原因を示す機械的事実が1つも無い failed Job。
    const { storage, taskId, projectId } = seed()
    const job = storage.jobs.create({
      taskId,
      projectId,
      agentRole: 'developer_ai',
      status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    expect(job.id).toBeDefined()
    storage.tasks.update(taskId, { status: 'blocked' })

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_failed'))

    expect(diagnosis.rootCauseClass).toBe('unknown')
    expect(diagnosis.confidence).toBe('low')
    expect(diagnosis.recommendedLane).not.toBe('auto_recovery')
  })

  it('quarantine された workspace は PL では解除できないので CEO_ESCALATION', () => {
    const { storage, taskId, projectId } = seed()
    const job = storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    storage.jobs.update(job.id, {
      failureMetadata: { quarantined: true, quarantineReason: 'uncommitted changes remain' },
    } as Parameters<IStorage['jobs']['update']>[1])
    storage.tasks.update(taskId, { status: 'blocked' })

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'workspace_quarantined'))

    expect(diagnosis.rootCauseClass).toBe('workspace_quarantined')
    expect(diagnosis.recommendedLane).toBe('ceo_escalation')
  })

  it('承認待ちそのものは AI 側に手が無いので CEO_ESCALATION', () => {
    const { storage, taskId } = seed()
    storage.approvalRequests.create({
      taskId,
      targetBranch: 'ai/task',
      targetCommit: 'abc123',
      targetDiffHash: 'deadbeef',
      requestedAction: 'git_commit',
      riskLevel: 'HIGH',
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString(),
      invalidIf: [],
    } as Parameters<IStorage['approvalRequests']['create']>[0])

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'approval_waiting'))

    expect(diagnosis.rootCauseClass).toBe('approval_waiting')
    expect(diagnosis.recommendedLane).toBe('ceo_escalation')
  })

  it('承認が効いていない blocked Job は、既存 resume が使えるので AUTO_RECOVERY', () => {
    const { storage, taskId, projectId } = seed()
    const job = storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', message: 'm' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    storage.jobs.update(job.id, { stderr: 'blocked: approval required' } as Parameters<IStorage['jobs']['update']>[1])
    storage.tasks.update(taskId, { status: 'blocked' })

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    expect(diagnosis.rootCauseClass).toBe('approval_not_actionable')
    expect(diagnosis.recommendedLane).toBe('auto_recovery')
    expect(diagnosis.existingRecoveryAvailable).toBe(true)
  })

  // G. CEO が明示的に却下したものは、AI の自動復旧レーンから外す。
  //
  // STALE / EXPIRED / 未発行 は「人の判断が一度も下っていない」ので同じ diff で
  // 新しい承認サイクルを始めてよい。`REJECTED` は**人が拒否した**のだから、
  // PL が `DEFAULT_RESUME_INSTRUCTION` で自動再開してはならない
  // （2026-09-23 production: 人の REJECT が同一 diff の承認待ちへ戻った）。
  const seedBlockedGitCommitWithApproval = (status: 'REJECTED' | 'EXPIRED'): IStorage => {
    const { storage, taskId, projectId } = seed()
    const job = storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', message: 'm' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    storage.jobs.update(job.id, { stderr: 'blocked: approval required' } as Parameters<IStorage['jobs']['update']>[1])
    const created = storage.approvalRequests.createForJob({
      taskId,
      targetBranch: 'master',
      targetCommit: 'c',
      targetDiffHash: 'd',
      riskLevel: 'LOW',
      requestedAction: 'git_commit',
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() + 1800_000).toISOString(),
      invalidIf: [],
    } as never, job.id)
    if (!created.ok) throw new Error('failed to seed approval')
    storage.approvalRequests.updateStatus(created.approvalRequest.id, status, undefined, true)
    // **linked Approval 基準**なので、Task 最新行に別 action を足しても判定は揺れない。
    // 旧実装（Task 最新行を見る）はここで誤判定していた。
    storage.approvalRequests.create({
      taskId,
      targetBranch: 'master',
      targetCommit: 'other',
      targetDiffHash: 'other',
      riskLevel: 'HIGH',
      requestedAction: 'test',
      status: 'APPROVED',
      expiresAt: new Date(Date.now() + 1800_000).toISOString(),
      changedFiles: [],
      triggeredRules: [],
      invalidIf: [],
    } as never)
    storage.tasks.update(taskId, { status: 'blocked' })
    return storage
  }

  it('G. CEO が REJECT した blocked Job は CEO_ESCALATION（自動 resume の対象にしない）', () => {
    const storage = seedBlockedGitCommitWithApproval('REJECTED')

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    // rootCauseClass は増やさず、既存 schema の値だけで意味を表す。
    expect(diagnosis.rootCauseClass).toBe('approval_not_actionable')
    expect(diagnosis.recommendedLane).toBe('ceo_escalation')
    expect(diagnosis.recoverable).toBe(false)
    // 経路自体は存在する（人が指示を添えれば resume できる）。
    expect(diagnosis.existingRecoveryAvailable).toBe(true)
    expect(diagnosis.summary).toContain('却下')

    // **PL は resume_task を提案できない。** 既存 `triageAllowedActions()` が
    // auto_recovery 以外を escalate_to_ceo だけに絞るので、新しい Gate は要らない。
    const allowed = triageAllowedActions(diagnosis, ['resume_task', 'retry_job', 'escalate_to_ceo'])
    expect(allowed).not.toContain('resume_task')
    expect(allowed).not.toContain('retry_job')
    expect(allowed).toEqual(['escalate_to_ceo'])
  })

  // H6. Gate が既存 REJECTED を再利用して弾いた **再生成 Job** は `approvalId` を持たない。
  //     （`ux_jobs_approval_id` が UNIQUE なので既存の却下行を結び直すこともできない。）
  //     ここを見落とすと triage が `auto_recovery` を返し、PL が却下済みの内容を
  //     自動 resume し続ける。`resume:` を1ホップだけ辿って元 Job の link を見る。
  it('H6. a regenerated git_commit job with no linked approval is still CEO_ESCALATION', () => {
    const storage = seedBlockedGitCommitWithApproval('REJECTED')
    const rejectedJob = storage.jobs.findByTaskId(
      storage.tasks.findByProjectId(storage.projects.findAll()[0].id)[0].id,
    ).find((j) => j.safeCommand.kind === 'git_commit')!
    // resume が作る再生成 Job（link 無し・`resume:<元Job>:1`）。
    const regenerated = storage.jobs.create({
      taskId: rejectedJob.taskId,
      projectId: rejectedJob.projectId,
      agentRole: 'developer_ai',
      status: 'blocked',
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', message: 'm' },
      dryRun: false,
      workflowStepKey: `resume:${rejectedJob.id}:1`,
    } as Parameters<IStorage['jobs']['create']>[0])
    expect(regenerated.approvalId).toBeUndefined()

    const diagnosis = triageBlocked(storage, {
      kind: 'job_blocked',
      projectId: regenerated.projectId,
      taskId: regenerated.taskId,
      jobId: regenerated.id,
      detail: 'blocked',
      stuckForMs: 0,
    } as AttentionItem)

    expect(diagnosis.recommendedLane).toBe('ceo_escalation')
    expect(diagnosis.recoverable).toBe(false)
    const allowed = triageAllowedActions(diagnosis, ['resume_task', 'retry_job', 'escalate_to_ceo'])
    expect(allowed).toEqual(['escalate_to_ceo'])
  })

  it('G. EXPIRED は従来どおり AUTO_RECOVERY のまま（resume_task を残す）', () => {
    const storage = seedBlockedGitCommitWithApproval('EXPIRED')

    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    expect(diagnosis.rootCauseClass).toBe('approval_not_actionable')
    expect(diagnosis.recommendedLane).toBe('auto_recovery')
    expect(diagnosis.recoverable).toBe(true)
    const allowed = triageAllowedActions(diagnosis, ['resume_task', 'retry_job', 'escalate_to_ceo'])
    expect(allowed).toContain('resume_task')
  })
})

// ────────────────────────────────────────────────────────────
// 9・11: Triage は権限を作らない
// ────────────────────────────────────────────────────────────

describe('triageBlocked — Triage は権限を作らない', () => {
  it('9. PL が LOW と自己申告しても分類は変わらない（申告は入力に存在しない）', async () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['apps/worker/src/guards/fileChangeGuard.ts'])

    // PL が「LOW リスクの retry で済む」と主張しても、
    const result = await runPlTick(storage, deps({
      diagnose: async () =>
        JSON.stringify({ actionKind: 'retry_job', rationale: 'trivial config fix', riskLevel: 'LOW' }),
    }))

    // 分類も到達先も変わらない
    expect(result.triage?.rootCauseClass).toBe('safety_or_authority_boundary')
    expect(result.status).toBe('escalated')
    expect(storage.jobs.findByTaskId(taskId).some((j) => j.status === 'queued')).toBe(false)
  })

  it('9b. 分類関数の引数に PL の申告が入る余地が無い（同じ状態なら常に同じ判定）', () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['apps/worker/src/guards/fileChangeGuard.ts'])
    const item = attentionOf(storage, 'job_blocked')

    expect(triageBlocked(storage, item)).toEqual(triageBlocked(storage, item))
  })

  it('11. Gate が BLOCK した提案を Triage は override できない', async () => {
    // lane は auto_recovery（＝候補を絞らない）。それでも resume は
    // ALIGNED evidence が無ければ Gate に止められる。
    const { storage, taskId, projectId } = seed()
    const job = storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', message: 'm' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    expect(job.id).toBeDefined()
    storage.tasks.update(taskId, { status: 'blocked' })

    const result = await runPlTick(storage, deps({
      diagnose: async () =>
        JSON.stringify({ actionKind: 'resume_task', rationale: 'fresh approval cycle', riskLevel: 'LOW' }),
    }))

    expect(result.triage?.lane).toBe('auto_recovery')
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('design_review')
    expect(storage.jobs.findByTaskId(taskId).some((j) => j.status === 'queued')).toBe(false)
  })

  it('8b. 証拠不足のとき、PL が復旧操作を出しても実行されない', async () => {
    const { storage, taskId, projectId } = seed()
    const job = storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    expect(job.id).toBeDefined()
    storage.tasks.update(taskId, { status: 'blocked' })
    // resume が Gate を通ってしまわないよう、あえて ALIGNED evidence を置いておく。
    // **Gate が通せる状態でも Triage 側で止まる**ことがここの主張である。
    storage.designReviewEvidence.create({
      taskId, reviewKind: 'task', subjectId: taskId, designTextHash: 'h',
      reviewLoad: 'low', decision: 'ALIGNED', independentReviewRequired: false,
    } as Parameters<IStorage['designReviewEvidence']['create']>[0])

    const result = await runPlTick(storage, deps({
      diagnose: async () =>
        JSON.stringify({ actionKind: 'resume_task', rationale: 'probably fine', riskLevel: 'LOW' }),
    }))

    expect(result.triage?.rootCauseClass).toBe('unknown')
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('outside the actions this triage allows')
    expect(storage.jobs.findByTaskId(taskId).some((j) => j.status === 'queued')).toBe(false)
  })
})

describe('triageAllowedActions — 絞ることしかできない', () => {
  function withLane(over: Partial<BlockedDiagnosis>): BlockedDiagnosis {
    return {
      rootCauseClass: 'unknown',
      blockingLayer: 'unknown',
      evidence: [],
      recoverable: false,
      recommendedLane: 'ceo_escalation',
      requiresAuthorityChange: false,
      requiresSafetyBoundaryChange: false,
      irreversible: false,
      existingRecoveryAvailable: false,
      confidence: 'high',
      summary: 's',
      ...over,
    }
  }

  it('auto_recovery は既存候補をそのまま返す', () => {
    const baseline = ['resume_task', 'retry_job', 'observe_state', 'escalate_to_ceo']
    expect(triageAllowedActions(withLane({ recommendedLane: 'auto_recovery' }), baseline))
      .toEqual(baseline)
  })

  it('足されうるのは escalate_to_ceo だけ（それ以外の action は決して増えない）', () => {
    // 独立レビュー（2026-09-18）の指摘: 「必ず baseline の部分集合」は不正確だった。
    // 正確な不変条件は「baseline の部分集合 + 高々 escalate_to_ceo 1つ」であり、
    // `escalate_to_ceo` は Policy 上 Gate を持たないので権限は増えない。
    const baselines = [
      ['observe_state', 'escalate_to_ceo'],
      ['resume_task', 'retry_job', 'clear_workspace_quarantine', 'observe_state', 'escalate_to_ceo'],
      ['resume_task'],
      [],
    ]
    const lanes = ['auto_recovery', 'independent_remediation', 'maintenance_lane', 'ceo_escalation'] as const

    for (const baseline of baselines) {
      for (const lane of lanes) {
        for (const confidence of ['high', 'low'] as const) {
          const allowed = triageAllowedActions(withLane({ recommendedLane: lane, confidence }), baseline)
          const added = allowed.filter((kind) => !baseline.includes(kind))
          expect(added.every((kind) => kind === 'escalate_to_ceo')).toBe(true)
        }
      }
    }
  })

  it('証拠不足のときは read-only の応答だけが残る', () => {
    const allowed = triageAllowedActions(
      withLane({ confidence: 'low' }),
      ['resume_task', 'retry_job', 'clear_workspace_quarantine', 'observe_state', 'escalate_to_ceo'],
    )
    expect([...allowed].sort()).toEqual(['escalate_to_ceo', 'observe_state'])
  })

  it('escalate_to_ceo は候補から落ちない（BLOCK 時に PL へ保証された応答のため）', () => {
    // baseline に escalate_to_ceo が無くても補われる。
    const allowed = triageAllowedActions(withLane({}), ['resume_task'])
    expect(allowed).toContain('escalate_to_ceo')
  })

  it('escalate しか残らないなら provider 診断は回さない', () => {
    expect(needsProviderDiagnosis(['escalate_to_ceo'])).toBe(false)
    expect(needsProviderDiagnosis(['observe_state', 'escalate_to_ceo'])).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────
// 10・15: 無限ループを作らない / 観測待ちを放置にしない
// ────────────────────────────────────────────────────────────

describe('runPlTick — 同じ blocker を延々と retry しない', () => {
  it('10. 同じ blocker は上限回数までしか試されず、その後は retry も診断もしない', async () => {
    const { storage, taskId, projectId } = seed()
    providerTimeoutJob(storage, taskId, projectId, 'unchanged')
    let diagnosed = 0
    const statuses: string[] = []
    const d = deps({
      diagnose: async () => {
        diagnosed += 1
        return JSON.stringify({ actionKind: 'observe_state', rationale: 'wait', riskLevel: 'LOW' })
      },
    })

    // 上限ぶん回した時点で、Triage が auto_recovery と言っていても Escalation で終端する。
    for (let i = 0; i < PL_MAX_ATTEMPTS_PER_TARGET; i += 1) {
      resetPlLoopInFlightForTest()
      const tick = await runPlTick(storage, d)
      statuses.push(tick.status)
      expect(tick.triage?.lane).toBe('auto_recovery')
    }
    expect(statuses).toContain('escalated')
    // 試行は上限ちょうどで止まる（それ以上 provider を呼ばない）
    expect(diagnosed).toBe(PL_MAX_ATTEMPTS_PER_TARGET)

    // 以後は何度 tick しても、診断も新しい Job も増えない。
    for (let i = 0; i < 3; i += 1) {
      resetPlLoopInFlightForTest()
      const after = await runPlTick(storage, d)
      expect(after.status).not.toBe('acted')
    }
    expect(diagnosed).toBe(PL_MAX_ATTEMPTS_PER_TARGET)
    expect(storage.jobs.findByTaskId(taskId).some((j) => j.status === 'queued')).toBe(false)
  })

  it('15. 既に自動 retry が走っている対象は「待つ」になり、再評価条件が明示される', async () => {
    const { storage, taskId, projectId } = seed()
    const failedId = providerTimeoutJob(storage, taskId, projectId, 'unchanged')
    // API の既存経路が作る1回限りの retry Job（`persistProviderTimeoutFailure()` と同じ形）
    storage.jobs.create({
      taskId,
      projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      workflowStepKey: `retry:${failedId}:1`,
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])

    // queued Job があるので `job_failed` は立たない。分類関数そのものを直接確かめる。
    const diagnosis = triageBlocked(storage, {
      kind: 'job_failed',
      projectId,
      projectName: 'AIteamOS',
      taskId,
      jobId: failedId,
      detail: 'provider timeout',
    })

    expect(diagnosis.recommendedLane).toBe('auto_recovery')
    // **「様子を見る」で終わらせない。** 何を・いつ・どこまで待ち、次にどこへ行くかが埋まる
    expect(diagnosis.observation).toBeDefined()
    expect(diagnosis.observation?.watch).toContain(failedId)
    expect(diagnosis.observation?.reevaluateOn).toBe('pl_tick')
    expect(diagnosis.observation?.thresholdMs).toBeGreaterThan(0)
    expect(diagnosis.observation?.nextLane).toBe('ceo_escalation')
  })
})

// ────────────────────────────────────────────────────────────
// 12: Independent Remediation との接続
// ────────────────────────────────────────────────────────────

describe('Independent Remediation への引き渡し', () => {
  it('12. remediation レーンへ振り分けても Design Review evidence は作られない（訂正版は fresh Review を通る）', async () => {
    const { storage, taskId } = seed()
    completedReview(storage, taskId, 'CONFLICT')
    const later = new Date(Date.parse(storage.tasks.findById(taskId)?.createdAt as string) + 10 * 60_000).toISOString()

    const result = await runPlTick(storage, deps({ now: () => later }))

    expect(result.triage?.lane).toBe('independent_remediation')
    // **Triage は Review を通過させない。** evidence は1件も増えず、
    // 訂正後の設計は改めて Design Review を通らなければ Job を得られない。
    expect(storage.designReviewEvidence.findByTaskId(taskId)).toHaveLength(0)
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(0)
    // CONFLICT を返した run の判定もそのまま（Triage は書き換えない）
    const run = storage.designReviewRuns.findLatestByTaskId(taskId)
    expect(JSON.parse(run?.resultJson as string).finalDecision).toBe('CONFLICT')
  })

  it('12b. **配線済みの Remediation を Triage が握り潰さない**（実行が分類より先に来る）', async () => {
    // #255 が Design Review CONFLICT に実際の解決経路を配線した。Triage は同じケースを
    // `lane=independent_remediation` と分類するが、**分類は実行ではない**。
    // ここが逆順になると、実装済みの復旧が Triage の Escalation に置き換わって静かに失われる。
    const { storage, taskId } = seedRemediableConflict()
    let resolved: string | undefined

    const result = await runPlTick(storage, deps({
      now: () => new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      // Triage 経路へ落ちたらここが呼ばれないので、呼ばれたこと自体が順序の証明になる。
      resolveConflict: async (_s, id) => {
        resolved = id
        return { status: 'revised_and_aligned', stage: 'pl_revision', taskId: id }
      },
      diagnose: async () => { throw new Error('diagnose must not run for a remediable CONFLICT') },
    }))

    expect(resolved).toBe(taskId)
    expect(result.status).toBe('acted')
    expect(result.proposedKind).toBe('adopt_roadmap_item')
    // Triage は分類すらしていない（この対象は Triage の担当ではない）
    expect(result.triage).toBeUndefined()
  })

  it('12c. `finalDecision` を持たない CONFLICT 記録でも Binding Review の警告を落とさない', async () => {
    // 独立レビュー round 3 の指摘への回帰テスト。#255 が実際に書く CONFLICT は
    // `{"focusedReviewResults":[...]}` で **top-level `finalDecision` を持たない**。
    // 「結果が無い」と「判定欄が読めない」を同一視すると、その形の CONFLICT すべてで
    // Binding Review の警告文が CEO 本文から静かに消える。
    const { storage, taskId } = seedRemediableConflict()
    const escalations: string[] = []

    // 解決に失敗させ、#255 の Escalation 本文（`notifyOnlyReason()` が土台）を観測する。
    await runPlTick(storage, deps({
      now: () => new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      escalate: async (p) => { escalations.push(p.body) },
      resolveConflict: async (_s, id) => ({
        status: 'terminal', stage: 'pl_revision', taskId: id,
      }),
    }))

    const run = storage.designReviewRuns.findLatestByTaskId(taskId)
    // 前提の確認: この記録に top-level finalDecision は無い
    expect(JSON.parse(run?.resultJson as string).finalDecision).toBeUndefined()
    // それでも「結果はあった」ので、判定行と Binding Review の警告は本文に残る
    expect(readLatestDesignReview(storage, taskId)?.hasResult).toBe(true)
    expect(escalations[0]).toContain('Binding Review')
    expect(escalations[0]).toContain('直近の Design Review の判定')
  })

  it('remediation を起動する無 Gate の受け口を持たない（配線は Gate を通る操作でしかできない）', () => {
    // 独立レビュー（2026-09-18）の指摘への回帰テスト。Triage 側に注入可能な dispatch callback を
    // 置くと、配線した瞬間に `authorizePlAction()` の外側で状態が変わる。
    // #255 の `resolveConflict` は Triage の受け口ではなく、既存 Remediation 経路のテスト差し替え点である。
    const depKeys = Object.keys(deps()) as (keyof PlLoopDeps)[]
    expect(depKeys.some((k) => String(k).toLowerCase().includes('dispatch'))).toBe(false)
  })

  it('Remediation の対象外な CONFLICT は CEO Escalation へ倒れる', async () => {
    // roadmapTaskKey を持たない Task は `findRemediationSubject()` の対象外。
    // 解決経路が無いので、構造化報告を添えて人へ渡すのが正しい。
    const { storage, taskId } = seed()
    completedReview(storage, taskId, 'CONFLICT')
    const later = new Date(Date.parse(storage.tasks.findById(taskId)?.createdAt as string) + 10 * 60_000).toISOString()
    const escalations: string[] = []

    const result = await runPlTick(storage, deps({
      now: () => later,
      escalate: async (p) => { escalations.push(p.body) },
    }))

    expect(result.status).toBe('escalated')
    expect(result.triage?.lane).toBe('independent_remediation')
    expect(result.triage?.rootCauseClass).toBe('design_review_conflict')
    // 「試したが解決しなかった」と読める本文にする（「配線されていない」と書かない）
    expect(escalations[0]).toContain('Independent Remediation')
    expect(escalations[0]).not.toContain('まだ配線されていません')
  })
})

// ────────────────────────────────────────────────────────────
// 9・13・14: CEO 報告
// ────────────────────────────────────────────────────────────

describe('CEO への構造化報告', () => {
  it('7項目すべてが載り、選択肢は複数提示される', () => {
    const diagnosis = triageBlocked(
      (() => {
        const { storage, taskId, projectId } = seed()
        blockedByGuard(storage, taskId, projectId, ['apps/worker/src/guards/fileChangeGuard.ts'])
        return storage
      })(),
      {
        kind: 'job_blocked',
        projectId: 'p',
        projectName: 'AIteamOS',
        detail: 'job is blocked',
      },
    )
    const body = buildTriageEscalationBody({
      diagnosis,
      item: { kind: 'job_blocked', projectId: 'p', projectName: 'AIteamOS', detail: 'job is blocked' },
      attemptHistory: ['2026-09-18 blocked: kind=retry_job ...'],
      blockedReason: 'PL には権限がありません',
    })

    expect(body).toContain('何が止まったか:')
    expect(body).toContain('原因:')
    expect(body).toContain('証拠:')
    expect(body).toContain('AI が試したこと:')
    expect(body).toContain('なぜ AI だけで解決できないか:')
    expect(body).toContain('必要な CEO 判断:')
    expect(body).toContain('安全な選択肢:')
    // **PL が選択肢を1つに決めない。**
    expect(body).toContain('  1. ')
    expect(body).toContain('  2. ')
  })

  it('13. 同じ incident では通知を繰り返さない', async () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['apps/worker/src/guards/fileChangeGuard.ts'])
    const escalations: string[] = []
    const d = deps({ escalate: async (p) => { escalations.push(p.body) } })

    for (let i = 0; i < 4; i += 1) {
      resetPlLoopInFlightForTest()
      await runPlTick(storage, d)
    }

    expect(escalations).toHaveLength(1)
  })

  it('14. 別 incident は別に通知される', async () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['apps/worker/src/guards/fileChangeGuard.ts'])
    const escalations: string[] = []
    const d = deps({ escalate: async (p) => { escalations.push(p.body) } })

    await runPlTick(storage, d)
    expect(escalations).toHaveLength(1)

    // 別 Task の別 Job で、別の原因が起きる
    const other = storage.tasks.create({
      projectId, title: 'T2', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1,
    } as Parameters<IStorage['tasks']['create']>[0])
    blockedByGuard(storage, other.id, projectId, ['docs/a.md'])

    resetPlLoopInFlightForTest()
    await runPlTick(storage, d)

    expect(escalations).toHaveLength(2)
  })
})

// ────────────────────────────────────────────────────────────
// 観測（既存 audit_log で後から集計できること）
// ────────────────────────────────────────────────────────────

describe('観測 — 既存 audit_log から集計できる', () => {
  it('tick の記録に lane / cause が構造化されて載る', async () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['docs/a.md'])

    await runPlTick(storage, deps())

    const detail = storage.auditLog.findAll().find((e) => e.operation === 'pl_loop')?.detail
    const parsed = parseTriageAuditDetail(detail)
    expect(parsed?.lane).toBe('independent_remediation')
    expect(parsed?.cause).toBe('allowed_paths_mismatch')
    expect(parsed?.confidence).toBe('high')
  })

  it('既知の語彙に無い値は集計へ混ぜない', () => {
    expect(parseTriageAuditDetail('lane=made_up cause=unknown conf=high')).toBeUndefined()
    expect(parseTriageAuditDetail('lane=auto_recovery cause=made_up conf=high')).toBeUndefined()
    expect(parseTriageAuditDetail('kind=retry_job exec_ok=true')).toBeUndefined()
    expect(parseTriageAuditDetail(undefined)).toBeUndefined()
  })

  it('総数 / 原因別 / route 別 / 成功率 / CEO 率 / UNKNOWN 率 / 再発数を出せる', () => {
    const now = NOW
    const entries = [
      { id: '1', actor: 'api' as const, operation: 'pl_loop', entityType: 't', entityId: 'job_blocked:a', result: 'acted', detail: 'lane=auto_recovery cause=provider_transient layer=provider conf=high x', createdAt: now },
      { id: '2', actor: 'api' as const, operation: 'pl_loop', entityType: 't', entityId: 'job_blocked:b', result: 'blocked', detail: 'lane=auto_recovery cause=provider_transient layer=provider conf=high x', createdAt: now },
      { id: '3', actor: 'api' as const, operation: 'pl_loop', entityType: 't', entityId: 'job_blocked:a', result: 'escalated', detail: 'lane=ceo_escalation cause=provider_transient layer=provider conf=high x', createdAt: now },
      { id: '4', actor: 'api' as const, operation: 'pl_loop', entityType: 't', entityId: 'job_failed:c', result: 'escalated', detail: 'lane=ceo_escalation cause=unknown layer=unknown conf=low x', createdAt: now },
      // 構造化欄を持たない既存の行は無視される（採用サイクル等）
      { id: '5', actor: 'api' as const, operation: 'pl_loop', entityType: 't', entityId: 'adopt:p', result: 'acted', detail: 'adoption=adopted code=- target=x', createdAt: now },
    ]

    const summary = summarizeBlockedTriage(entries)

    expect(summary.total).toBe(4)
    expect(summary.byRootCause.provider_transient).toBe(3)
    expect(summary.byLane.auto_recovery).toBe(2)
    expect(summary.byLane.ceo_escalation).toBe(2)
    // auto_recovery を選んだ2件のうち acted は1件
    expect(summary.autoRecoverySuccessRate).toBeCloseTo(0.5)
    expect(summary.ceoEscalationRate).toBeCloseTo(0.5)
    expect(summary.unknownRate).toBeCloseTo(0.25)
    // 同じ対象（job_blocked:a）で同じ原因が2回出ている
    expect(summary.recurringRootCauses).toBe(1)
  })

  it('記録が無ければ率は 0 になり、0 除算にならない', () => {
    expect(summarizeBlockedTriage([])).toEqual({
      total: 0,
      byRootCause: {},
      byLane: {},
      autoRecoverySuccessRate: 0,
      ceoEscalationRate: 0,
      unknownRate: 0,
      recurringRootCauses: 0,
    })
  })

  it('formatTriageAuditDetail と parseTriageAuditDetail が往復する', () => {
    const { storage, taskId, projectId } = seed()
    blockedByGuard(storage, taskId, projectId, ['apps/worker/src/jobRunner.ts'])
    const diagnosis = triageBlocked(storage, attentionOf(storage, 'job_blocked'))

    const parsed = parseTriageAuditDetail(formatTriageAuditDetail(diagnosis))

    expect(parsed).toEqual({
      lane: diagnosis.recommendedLane,
      cause: diagnosis.rootCauseClass,
      confidence: diagnosis.confidence,
    })
  })
})
